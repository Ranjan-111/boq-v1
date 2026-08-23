const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
const { startOperatorApp } = require('../test-support/operator-app');
const { show, press } = require('../test-support/operator-page');

let app;
let browser;

before(async () => {
  app = await startOperatorApp();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await app?.close();
});

function browserEngineConfig() {
  return {
    provider: 'tesseract-js', engineVersion: '7.0.0', modelVersion: 'eng-4.0.0_best_int', language: 'eng',
    assetHash: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91', totalBytes: 2952873,
    cachedAssetHash: '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747',
    workerPath: '/ocr/vendor/tesseract.js/dist/worker.min.js', corePath: '/ocr/vendor/tesseract.js-core',
    langPath: '/ocr/vendor/@tesseract.js-data/eng/4.0.0_best_int', gzip: true, workerBlobURL: false
  };
}

test('real browser OCR downloads visibly and reuses the exact cached model', { timeout: 120000 }, async () => {
  const page = await browser.newPage();
  await page.goto(app.baseUrl);
  await page.waitForLoadState('networkidle');
  const fixture = await readFile(join(__dirname, 'fixtures', 'ocr-corpus', 'numeric-units.png'));
  const dataUrl = `data:image/png;base64,${fixture.toString('base64')}`;
  let phase = 'cold';
  const modelRequests = { cold: 0, warm: 0 };
  page.on('request', (request) => {
    if (request.url().endsWith('/eng.traineddata.gz')) modelRequests[phase] += 1;
  });

  const cold = await page.evaluate(async ({ dataUrl, engineConfig }) => {
    const image = new Image(); image.src = dataUrl; await image.decode();
    const states = [];
    const engine = window.BoqOcrEngine.selectEngine(engineConfig);
    const cache = new window.BoqOcrModelCache.ModelCache({ dbName: 'boq-v1-ocr-real-smoke' });
    const controller = window.BoqOcrEngine.createOcrController({ engine, cache });
    controller.subscribe((snapshot) => states.push(snapshot.state));
    const observations = await controller.recognize({ image, cropWidth: image.width, cropHeight: image.height, pageWidth: image.width, pageHeight: image.height, provenance: { sourceDocumentId: 'smoke-source', sourceDocumentVersion: 1, processingRunId: 'smoke-run', pageId: 'page_1', crop: { x: 0, y: 0, width: image.width, height: image.height } } });
    await controller.dispose();
    return { states, observations };
  }, { dataUrl, engineConfig: browserEngineConfig() });
  assert.ok(cold.states.includes('downloading'));
  assert.ok(cold.states.includes('completed'));
  assert.ok(cold.observations.length > 0);
  assert.match(cold.observations.map((item) => item.text).join(' '), /1200|12\.5|mm|cm/i);
  assert.ok(modelRequests.cold >= 1);
  assert.equal(app.requests.filter((url) => url.endsWith('/eng.traineddata.gz')).length, 1);

  phase = 'warm';
  await page.route('**/eng.traineddata.gz', (route) => route.abort('internetdisconnected'));
  const warm = await page.evaluate(async (engineConfig) => {
    const states = [];
    const engine = window.BoqOcrEngine.selectEngine(engineConfig);
    const cache = new window.BoqOcrModelCache.ModelCache({ dbName: 'boq-v1-ocr-real-smoke' });
    const controller = window.BoqOcrEngine.createOcrController({ engine, cache });
    controller.subscribe((snapshot) => states.push(snapshot.state));
    await controller.prepare();
    const snapshot = controller.snapshot();
    await controller.dispose();
    return { states, snapshot };
  }, browserEngineConfig());
  assert.ok(warm.states.includes('checking-cache'));
  assert.equal(warm.snapshot.state, 'ready');
  assert.equal(modelRequests.warm, 0);

  const corrupted = await page.evaluate(async (engineConfig) => {
    const cachePath = `boq-v1-ocr-cache/${['tesseract-js', engineConfig.engineVersion, engineConfig.modelVersion, engineConfig.language, engineConfig.assetHash].join('__')}`;
    await new Promise((resolve, reject) => {
      const opened = indexedDB.open('keyval-store');
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result; const transaction = db.transaction('keyval', 'readwrite');
        transaction.objectStore('keyval').put(new Uint8Array([1, 2, 3]), `${cachePath}/eng.traineddata`);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const engine = window.BoqOcrEngine.selectEngine(engineConfig);
    const cache = new window.BoqOcrModelCache.ModelCache({ dbName: 'boq-v1-ocr-real-smoke' });
    const controller = window.BoqOcrEngine.createOcrController({ engine, cache });
    let error; try { await controller.prepare(); } catch (caught) { error = { code: caught.code, message: caught.message }; }
    return { state: controller.state, error };
  }, browserEngineConfig());
  assert.equal(corrupted.state, 'evicted');
  assert.equal(corrupted.error.code, 'evicted');
  await page.close();
});
