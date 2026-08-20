const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryCache, ModelCache } = require('../public/ocr/model-cache');
const { createOcrController } = require('../public/ocr/engine');
const { normalizeObservations } = require('../public/ocr/normalize');
const { createTesseractAdapter } = require('../public/ocr/tesseract');

function fakeEngine(overrides = {}) {
  return Object.assign({
    id: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng', assetHash: 'fixture-hash',
    async prepare({ onProgress } = {}) { onProgress?.({ loaded: 25, total: 100, percent: 25, message: 'Downloading fixture model…' }); onProgress?.({ loaded: 100, total: 100, percent: 100, message: 'Fixture model ready.' }); return { assetHash: 'fixture-hash', totalBytes: 100 }; },
    async recognize() { return { observations: [{ text: '1200 mm', score: .9, poly: [[1, 2], [31, 2], [31, 12], [1, 12]] }] }; },
    async dispose() {}
  }, overrides);
}

test('browser OCR downloads once, reports progress, then reuses the exact cache offline', async () => {
  const cache = createMemoryCache();
  const progress = [];
  const first = createOcrController({ engine: fakeEngine(), cache });
  first.subscribe((snapshot) => progress.push(snapshot.state));
  await first.prepare();
  assert.deepEqual((await cache.list()).map((entry) => entry.status), ['ready']);
  assert.ok(progress.includes('checking-cache'));
  assert.ok(progress.includes('downloading'));
  assert.equal(progress.at(-1), 'ready');

  let downloaded = 0;
  const reload = createOcrController({ engine: fakeEngine({ async prepare({ cacheHit } = {}) { if (!cacheHit) downloaded += 1; } }), cache, online: () => false });
  await reload.prepare();
  assert.equal(reload.state, 'offline-cache-hit');
  assert.equal(downloaded, 0);
  const observations = await reload.recognize({ image: { width: 32, height: 20 }, cropRect: { x: 10, y: 20, width: 32, height: 20 }, cropWidth: 32, cropHeight: 20, pageWidth: 100, pageHeight: 100, provenance: { sourceDocumentId: 'src_1', sourceDocumentVersion: 1, processingRunId: 'run_1', pageId: 'page_1' } });
  assert.equal(observations[0].status, 'observed');
  assert.deepEqual(observations[0].textPolygon[0], [11, 22]);
});

test('offline cache miss and missing IndexedDB are visible sidecar states', async () => {
  const offline = createOcrController({ engine: fakeEngine(), cache: createMemoryCache(), online: () => false });
  await assert.rejects(() => offline.prepare(), /unavailable offline/);
  assert.equal(offline.state, 'offline-missing');

  const unsupported = createOcrController({ engine: fakeEngine(), cache: new ModelCache({ indexedDB: null }) });
  await assert.rejects(() => unsupported.prepare(), /IndexedDB|storage|unavailable/i);
  assert.equal(unsupported.state, 'unsupported');

  const cache = createMemoryCache();
  const identity = { engine: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng', assetHash: 'fixture-hash' };
  await cache.beginDownload(identity);
  await cache.markEvicted(identity);
  const recoveredStates = [];
  const recovered = createOcrController({ engine: fakeEngine(), cache });
  recovered.subscribe((snapshot) => recoveredStates.push(snapshot.state));
  await recovered.prepare();
  assert.ok(recoveredStates.includes('evicted'));
  assert.equal(recovered.state, 'ready');
});

test('crop coordinates, rotation, confidence, and provenance normalize without geometry authority', () => {
  const observations = normalizeObservations({ observations: [{ text: '  12.5 cm ', score: .8, poly: [[0, 0], [10, 0], [10, 5], [0, 5]] }] }, {
    sourceDocumentId: 'src_1', sourceDocumentVersion: 2, processingRunId: 'run_2', pageId: 'page_4', regionId: 'region_1',
    engine: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng', rotation: 90,
    crop: { x: 20, y: 30, width: 100, height: 50 }, pageWidth: 200, pageHeight: 200, pageTransform: [1, 0, 0, 1, 0, 0]
  });
  assert.deepEqual(observations[0].textPolygon, [[20, 80], [20, 70], [25, 70], [25, 80]]);
  assert.equal(observations[0].confidence.score, .8);
  assert.equal(observations[0].processingRunId, 'run_2');
  assert.equal(observations[0].regionId, 'region_1');
  assert.equal(observations[0].semanticEvidence[0].state, 'needs_review');
  assert.equal(Object.hasOwn(observations[0], 'quantity'), false);
  assert.equal(Object.hasOwn(observations[0], 'calibration'), false);
});

test('OCR failure is terminal for the sidecar only and leaves the drawing workflow untouched', async () => {
  const controller = createOcrController({ engine: fakeEngine({ async recognize() { throw Object.assign(new Error('worker stopped'), { code: 'failed' }); } }), cache: createMemoryCache() });
  await assert.rejects(() => controller.recognize({ image: { width: 10, height: 10 }, cropRect: { x: 0, y: 0, width: 10, height: 10 }, cropWidth: 10, cropHeight: 10, pageWidth: 10, pageHeight: 10, provenance: { sourceDocumentId: 'src', sourceDocumentVersion: 1, processingRunId: 'run', pageId: 'page_1' } }), /worker stopped/);
  assert.equal(controller.state, 'failed');
  assert.equal(Object.hasOwn(controller, 'geometry'), false);
  assert.equal(Object.hasOwn(controller, 'quantity'), false);
});

test('cold cache requires smoke recognition before ready and rejects concurrent crops', async () => {
  const cache = createMemoryCache(); let smoke = 0; let release;
  const engine = fakeEngine({
    async smoke() { smoke += 1; throw Object.assign(new Error('smoke failed'), { code: 'failed' }); },
    async recognize() { await new Promise((resolve) => { release = resolve; }); return { observations: [] }; }
  });
  const controller = createOcrController({ engine, cache });
  await assert.rejects(() => controller.prepare(), /smoke failed/);
  assert.equal(smoke, 1);
  assert.equal((await cache.list())[0].status, 'evicted');

  const runnable = createOcrController({ engine: fakeEngine({ async smoke() {}, async recognize() { await new Promise((resolve) => { release = resolve; }); return { observations: [{ text: 'ok', score: .9, poly: [[0, 0], [2, 0], [2, 2], [0, 2]] }] }; } }), cache: createMemoryCache() });
  const first = runnable.recognize({ image: { width: 2, height: 2 }, cropRect: { x: 0, y: 0, width: 2, height: 2 }, cropWidth: 2, cropHeight: 2, pageWidth: 2, pageHeight: 2, provenance: { sourceDocumentId: 's', sourceDocumentVersion: 1, processingRunId: 'r', pageId: 'p' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(() => runnable.recognize({}), /already running/);
  release();
  await first;
});

test('Tesseract v7 receives namespaced cache options and parses positioned words', async () => {
  let workerOptions;
  let outputOptions;
  const worker = { async recognize(image, inputOptions, requestedOutput) { outputOptions = requestedOutput; return { data: { words: [{ text: 'word', confidence: 87, bbox: { x0: 1, y0: 2, x1: 9, y1: 12 } }] } }; }, async terminate() {} };
  const adapter = createTesseractAdapter({ engineVersion: '7', modelVersion: 'm', assetHash: 'hash', language: 'eng', cachePath: 'cache', createWorker: async (langs, oem, options) => { workerOptions = { langs, oem, options }; return worker; } });
  await adapter.prepare({ cacheHit: true });
  assert.equal(workerOptions.options.cacheMethod, 'readOnly');
  assert.match(workerOptions.options.cachePath, /tesseract-js.*7.*m.*eng.*hash/);
  const result = await adapter.recognize({ image: { width: 2, height: 2 } });
  assert.deepEqual(result.observations[0].bbox, { x0: 1, y0: 2, x1: 9, y1: 12 });
  assert.deepEqual(outputOptions, { text: true, blocks: true, tsv: true });
  await adapter.dispose();
  const cold = createTesseractAdapter({ engineVersion: '7', modelVersion: 'm', assetHash: 'hash', createWorker: async (langs, oem, options) => { workerOptions = { langs, oem, options }; return worker; } });
  await cold.prepare({ cacheHit: false });
  assert.equal(workerOptions.options.cacheMethod, 'refresh');
});

test('cache schema changes evict old manifests and hard deadlines settle hung adapters', async () => {
  const cache = createMemoryCache();
  const identity = { engine: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng', assetHash: 'fixture-hash' };
  await cache.beginDownload(identity); await cache.markReady(identity);
  cache.memory.manifest.get('fake|fake-1|fixture-1|eng|fixture-hash').cacheVersion = 'old-cache-schema';
  assert.equal((await cache.get(identity)).status, 'evicted');

  let disposed = 0; let prepareAttempts = 0;
  const prepareHang = createOcrController({ engine: fakeEngine({ async prepare() { prepareAttempts += 1; return new Promise(() => {}); }, async dispose() { disposed += 1; } }), cache: createMemoryCache(), limits: { maxRunMs: 15, maxRegionMs: 10 } });
  await assert.rejects(() => prepareHang.recognize({ image: { width: 1, height: 1 }, cropWidth: 1, cropHeight: 1 }), /bounded run time/);
  assert.equal(prepareHang.state, 'aborted'); assert.equal(disposed, 1);
  await assert.rejects(() => prepareHang.recognize({ image: { width: 1, height: 1 }, cropWidth: 1, cropHeight: 1 }), /bounded run time/);
  assert.equal(prepareAttempts, 2); assert.equal(disposed, 2);

  const recognizeHang = createOcrController({ engine: fakeEngine({ async smoke() {}, async recognize() { return new Promise(() => {}); }, async dispose() { disposed += 1; } }), cache: createMemoryCache(), limits: { maxRunMs: 100, maxRegionMs: 10 } });
  await assert.rejects(() => recognizeHang.recognize({ image: { width: 1, height: 1 }, cropWidth: 1, cropHeight: 1 }), /bounded region time/);
  assert.equal(recognizeHang.state, 'aborted'); assert.equal(disposed, 3);
});
