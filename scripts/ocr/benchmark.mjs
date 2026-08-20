import { createHash } from 'node:crypto';
import { chdir, cwd, env, memoryUsage } from 'node:process';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('../..', import.meta.url).pathname);
const corpusDir = join(repo, 'test', 'fixtures', 'ocr-corpus');
const manifestPath = join(corpusDir, 'manifest.json');
const groundTruthPath = join(corpusDir, 'ground_truth.json');
const runtimeDir = env.OCR_RUNTIME_DIR || '/private/tmp/boq-ocr-runtime';
const resultsPath = env.OCR_RESULTS_PATH || join(repo, 'docs', 'ocr', 'benchmark-results-2026-08-20.json');
const runStartedAt = new Date().toISOString();
const PINNED_EVIDENCE = Object.freeze({
  packages: Object.freeze({
    tesseract: Object.freeze({ name: 'tesseract.js', version: '7.0.0', tarballBytes: 616435, tarballSha256: '9a93bf51c3387f945d10a24bf8b3a4bf2e45c7c7161b8242aafbaf9d3c4b606a' }),
    paddle: Object.freeze({ name: '@paddleocr/paddleocr-js', version: '0.4.2', tarballBytes: 7346941, tarballSha256: '3b9ae2ce7214b17cb5a4c5dfd3b6c168a51c0ed442642126e71016ea9be9d114' })
  }),
  models: Object.freeze({
    tesseract: Object.freeze({ bytes: 5199098, sha256: '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747' }),
    paddleDetection: Object.freeze({ urlPart: 'PP-OCRv5_mobile_det_onnx_infer.tar', bytes: 4843520, sha256: '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30' }),
    paddleRecognition: Object.freeze({ urlPart: 'PP-OCRv5_mobile_rec_onnx_infer.tar', bytes: 16701440, sha256: 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c' })
  })
});

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const groundTruth = JSON.parse(await readFile(groundTruthPath, 'utf8'));
  const verifiedAssets = await verifyCorpus(manifest);
  const packages = await packageEvidence();
  const result = {
    schemaVersion: 'ocr-benchmark-results-v1',
    benchmarkDate: '2026-08-20',
    runStartedAt,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    corpus: { manifestSha256: await sha256File(manifestPath), groundTruthSha256: await sha256File(groundTruthPath), assets: verifiedAssets },
    packages,
    engines: {}
  };

  result.engines.tesseract = await benchmarkTesseract(manifest, groundTruth);
  result.engines.paddle = await benchmarkPaddle(manifest, groundTruth);
  assertPublishableEngineResults(result.engines);
  await mkdir(dirname(resultsPath), { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ resultsPath, tesseract: result.engines.tesseract.status, paddle: result.engines.paddle.status }, null, 2));
}

async function verifyCorpus(manifest) {
  const output = {};
  for (const [id, asset] of Object.entries(manifest.assets)) {
    const file = join(corpusDir, asset.file);
    const bytes = await readFile(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.sha256) throw new Error(`Corpus hash mismatch: ${id}`);
    output[id] = { sha256: digest, bytes: bytes.length, width: asset.width, height: asset.height };
  }
  return output;
}

async function packageEvidence() {
  const packageSpecs = [
    ['tesseract', '/private/tmp/boq-ocr-deps/tesseract.js-7.0.0.tgz'],
    ['paddle', '/private/tmp/boq-ocr-deps/paddleocr-paddleocr-js-0.4.2.tgz']
  ];
  const output = {};
  for (const [id, tarball] of packageSpecs) {
    const { name, version, tarballBytes, tarballSha256 } = PINNED_EVIDENCE.packages[id];
    const packageJson = join(runtimeDir, 'node_modules', ...name.split('/'), 'package.json');
    const metadata = JSON.parse(await readFile(packageJson, 'utf8'));
    if (metadata.name !== name || metadata.version !== version) throw new Error(`Pinned package metadata mismatch for ${id}: expected ${name}@${version}`);
    const packageTarball = await fileEvidence(tarball);
    assertEvidence(`package tarball ${id}`, packageTarball, { bytes: tarballBytes, sha256: tarballSha256 });
    output[id] = { name, version: metadata.version, packageTarball };
  }
  return output;
}

async function benchmarkTesseract(manifest, groundTruth) {
  const started = Date.now();
  const dataDir = `/private/tmp/boq-v1-ocr-benchmark-data-${process.pid}`;
  const cacheDir = `/private/tmp/boq-v1-ocr-benchmark-cache-${process.pid}`;
  await mkdir(dataDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const originalCwd = cwd();
  try {
    chdir(dataDir); // Tesseract's dataPath is worker-local; this prevents repo writes.
    const mod = await import(pathToFileURL(join(runtimeDir, 'node_modules', 'tesseract.js', 'src', 'index.js')).href);
    const { createWorker } = mod;
    const logger = () => {};
    const options = { cachePath: cacheDir, logger };
    const before = memoryUsage().rss;
    const coldStarted = Date.now();
    const worker = await createWorker('eng', 1, options);
    const coldPrepareMs = Date.now() - coldStarted;
    const afterPrepare = memoryUsage().rss;
    const assets = {};
    for (const [id, asset] of Object.entries(manifest.assets)) {
      const file = join(corpusDir, asset.file);
      const startedAt = Date.now();
      const out = await worker.recognize(file, {}, { text: true, tsv: true });
      const elapsedMs = Date.now() - startedAt;
      assets[id] = scoreResult(id, out.data.text || '', out.data.tsv || '', groundTruth.assets[id], elapsedMs, memoryUsage().rss);
    }
    const largeSheetTiles = await benchmarkTesseractTiles(worker, manifest.assets['large-sheet'], groundTruth.assets['large-sheet']);
    const peakRssBytes = Math.max(afterPrepare, memoryUsage().rss, ...Object.values(assets).map((asset) => asset.rssBytes));
    await worker.terminate();

    const warmStarted = Date.now();
    const warmWorker = await createWorker('eng', 1, options);
    const warmPrepareMs = Date.now() - warmStarted;
    await warmWorker.terminate();
    const modelPath = join(cacheDir, 'eng.traineddata');
    const model = await fileEvidence(modelPath);
    assertEvidence('Tesseract model', model, PINNED_EVIDENCE.models.tesseract);
    return {
      status: 'completed',
      engine: 'tesseract.js', version: JSON.parse(await readFile(join(runtimeDir, 'node_modules', 'tesseract.js', 'package.json'), 'utf8')).version,
      language: 'eng',
      preparation: { coldPrepareMs, warmPrepareMs, cachePath: cacheDir, model },
      memoryProxy: { kind: 'node-process-rss', beforeBytes: before, afterPrepareBytes: afterPrepare, peakBytes: peakRssBytes, note: 'RSS includes the Node process and worker thread; it is not browser per-tab heap.' },
      assets,
      largeSheetTiles,
      wallClockMs: Date.now() - started
    };
  } catch (error) {
    return { status: 'blocked', engine: 'tesseract.js', blocker: String(error.stack || error), wallClockMs: Date.now() - started };
  } finally {
    chdir(originalCwd);
  }
}

async function benchmarkTesseractTiles(worker, asset, truth) {
  const file = join(corpusDir, asset.file);
  const cols = 4; const rows = 3;
  const tileWidth = Math.ceil(asset.width / cols); const tileHeight = Math.ceil(asset.height / rows);
  const started = Date.now(); const tiles = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) {
    const left = col * tileWidth; const top = row * tileHeight;
    const width = Math.min(tileWidth, asset.width - left); const height = Math.min(tileHeight, asset.height - top);
    const tileStarted = Date.now();
    const out = await worker.recognize(file, { rectangle: { left, top, width, height } }, { text: true, tsv: true });
    tiles.push({ row, col, left, top, width, height, elapsedMs: Date.now() - tileStarted, text: normalize(out.data.text || '') });
  }
  const allText = tiles.map((tile) => tile.text).join(' ');
  return { status: 'completed', tileCount: tiles.length, elapsedMs: Date.now() - started, tokenRecall: tokenRecall(truth.records.flatMap((record) => record.tokens), tokenise(allText)), tiles };
}

async function benchmarkPaddle(manifest, groundTruth) {
  const started = Date.now();
  let server;
  try {
    const vitePath = join(runtimeDir, 'node_modules', 'vite', 'dist', 'node', 'index.js');
    const { createServer } = await import(pathToFileURL(vitePath).href);
    const tempRoot = `/private/tmp/boq-v1-paddle-benchmark-${process.pid}`;
    const srcDir = join(tempRoot, 'src'); const publicDir = join(tempRoot, 'public');
    await mkdir(srcDir, { recursive: true }); await mkdir(publicDir, { recursive: true });
    await symlink(join(runtimeDir, 'node_modules'), join(tempRoot, 'node_modules')).catch(() => {});
    await symlink(corpusDir, join(publicDir, 'corpus')).catch(() => {});
    const assets = Object.entries(manifest.assets).map(([id, asset]) => ({ id, file: asset.file }));
    const truthJson = JSON.stringify(groundTruth.assets);
    await writeFile(join(tempRoot, 'index.html'), '<!doctype html><body><script type="module" src="/src/main.js"></script>');
    await writeFile(join(srcDir, 'main.js'), paddlePageScript(assets, truthJson));
    server = await createServer({ root: tempRoot, server: { host: '127.0.0.1', port: 0, fs: { allow: [tempRoot, corpusDir] } } });
    await server.listen();
    const address = server.httpServer.address();
    const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
    const page = await browser.newPage();
    const modelResponses = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (!/model|\.tar(?:\.gz)?$|\.onnx$|paddle/i.test(url)) return;
      const item = { url, status: response.status(), contentLength: response.headers()['content-length'] || null };
      try { const body = await response.body(); item.bytes = body.length; item.sha256 = createHash('sha256').update(body).digest('hex'); } catch (error) { item.bodyError = String(error.message || error); }
      modelResponses.push(item);
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => window.__OCR_BENCHMARK_DONE__ || window.__OCR_BENCHMARK_ERROR__, null, { timeout: 300000 });
    const browserResult = await page.evaluate(() => window.__OCR_BENCHMARK_DONE__ || { error: window.__OCR_BENCHMARK_ERROR__ });
    await browser.close();
    if (!browserResult.error) for (const [id, asset] of Object.entries(browserResult.assets)) {
      const scored = scoreResult(id, asset.items.map((item) => item.text).join('\n'), '', groundTruth.assets[id], Math.round(asset.elapsedMs), null);
      asset.accuracy = scored;
      asset.averageScore = asset.items.length ? asset.items.reduce((sum, item) => sum + item.score, 0) / asset.items.length : null;
    }
    for (const item of modelResponses) if (item.bytes == null && item.status === 200) {
      try { const body = Buffer.from(await (await fetch(item.url)).arrayBuffer()); item.bytes = body.length; item.sha256 = createHash('sha256').update(body).digest('hex'); } catch (error) { item.fetchError = String(error.message || error); }
    }
    assertEvidence('Paddle detection model', findModelResponse(modelResponses, PINNED_EVIDENCE.models.paddleDetection), PINNED_EVIDENCE.models.paddleDetection);
    assertEvidence('Paddle recognition model', findModelResponse(modelResponses, PINNED_EVIDENCE.models.paddleRecognition), PINNED_EVIDENCE.models.paddleRecognition);
    return { status: browserResult.error ? 'blocked' : 'completed', engine: '@paddleocr/paddleocr-js', version: '0.4.2', backend: 'wasm', browser: browserResult, modelResponses, wallClockMs: Date.now() - started };
  } catch (error) {
    return { status: 'blocked', engine: '@paddleocr/paddleocr-js', version: '0.4.2', blocker: String(error.stack || error), wallClockMs: Date.now() - started };
  } finally {
    if (server) await server.close().catch(() => {});
  }
}

function paddlePageScript(assets, truthJson) {
  return `import { PaddleOCR } from '@paddleocr/paddleocr-js';
const assets = ${JSON.stringify(assets)};
const truth = ${truthJson};
try {
  const prepareStarted = performance.now();
  const ocr = await PaddleOCR.create({ lang: 'en', ocrVersion: 'PP-OCRv5', ortOptions: { backend: 'wasm', wasmPaths: '/node_modules/onnxruntime-web/dist/' } });
  const coldPrepareMs = performance.now() - prepareStarted;
  const output = {};
  for (const asset of assets) {
    const image = await (await fetch('/corpus/' + asset.file)).blob();
    const started = performance.now();
    const [result] = await ocr.predict(image);
    output[asset.id] = { elapsedMs: performance.now() - started, metrics: result.metrics, runtime: result.runtime, image: result.image, items: result.items };
  }
  window.__OCR_BENCHMARK_DONE__ = { coldPrepareMs, assets: output, memory: performance.memory ? { usedBytes: performance.memory.usedJSHeapSize, totalBytes: performance.memory.totalJSHeapSize } : null };
} catch (error) { window.__OCR_BENCHMARK_ERROR__ = String(error?.stack || error); }`;
}

function scoreResult(id, text, tsv, truth, elapsedMs, rssBytes) {
  const expected = truth.records.flatMap((record) => record.tokens);
  const actual = tokenise(text);
  return { elapsedMs, rssBytes, text, tokenRecall: tokenRecall(expected, actual), lineExactRate: lineExactRate(truth.records.map((record) => record.text), text), averageConfidence: averageConfidence(tsv) };
}

function tokenise(text) { return normalize(text).match(/[A-Z0-9]+(?:\.[0-9]+)?/g) || []; }
function normalize(text) { return text.toUpperCase().replace(/[^A-Z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function tokenRecall(expected, actual) {
  const remaining = [...actual]; let matched = 0;
  for (const token of expected) { const index = remaining.indexOf(token); if (index >= 0) { matched += 1; remaining.splice(index, 1); } }
  return { matched, expected: expected.length, rate: expected.length ? matched / expected.length : 1 };
}
function lineExactRate(expectedLines, actualText) {
  const normalized = normalize(actualText); const matched = expectedLines.filter((line) => normalized.includes(normalize(line))).length;
  return { matched, expected: expectedLines.length, rate: expectedLines.length ? matched / expectedLines.length : 1 };
}
function averageConfidence(tsv) {
  const values = tsv.split(/\r?\n/).slice(1).map((line) => line.split('\t')).filter((fields) => fields[11] && fields[11] !== '-1' && fields[11].trim()).map((fields) => Number(fields[10])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function findModelResponse(responses, expected) {
  const matches = responses.filter((response) => response.url.includes(expected.urlPart));
  if (matches.length !== 1) throw new Error(`Expected exactly one pinned model response for ${expected.urlPart}; found ${matches.length}`);
  return matches[0];
}
function assertEvidence(label, actual, expected) {
  if (!actual || actual.status && actual.status !== 200 || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`Pinned evidence mismatch for ${label}: expected ${expected.bytes} bytes/${expected.sha256}`);
  }
}
function assertPublishableEngineResults(engines) {
  for (const [id, result] of Object.entries(engines)) {
    if (result.status !== 'completed') throw new Error(`OCR benchmark cannot publish: ${id} status is ${result.status || 'missing'}${result.blocker ? ` (${result.blocker})` : ''}`);
  }
}
async function sha256File(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function fileEvidence(file) { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }

main().catch((error) => { console.error(error); process.exitCode = 1; });
