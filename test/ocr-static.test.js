const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { startOperatorApp } = require('../test-support/operator-app');

let app;

before(async () => { app = await startOperatorApp(); });
after(async () => { await app.close(); });

test('allowlisted OCR browser assets are served as JavaScript with safe headers', async () => {
  const assets = [
    ...['engine.js', 'model-cache.js', 'normalize.js', 'tesseract.js', 'paddle.js'].map((name) => ({ path: `/ocr/${name}`, type: /^text\/javascript;\s*charset=utf-8$/i })),
    ...['tesseract.min.js', 'worker.min.js'].map((name) => ({ path: `/ocr/vendor/tesseract.js/dist/${name}`, type: /^text\/javascript;\s*charset=utf-8$/i })),
    ...[
      'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm',
      'tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm',
      'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm'
    ].map((name) => ({ path: `/ocr/vendor/tesseract.js-core/${name}`, type: name.endsWith('.js') ? /^text\/javascript;\s*charset=utf-8$/i : /^application\/wasm$/i })),
    { path: '/ocr/vendor/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', type: /^application\/gzip$/i, hash: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' }
  ];
  for (const asset of assets) {
    const response = await fetch(`${app.baseUrl}${asset.path}`);
    assert.equal(response.status, 200, asset.path);
    assert.match(response.headers.get('content-type') || '', asset.type, asset.path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', asset.path);
    assert.match(response.headers.get('cache-control') || '', /public/);
    if (asset.hash) {
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.hash);
      assert.equal(response.headers.get('etag'), `"${asset.hash}"`);
      assert.equal(response.headers.get('x-content-sha256'), asset.hash);
    } else assert.ok((await response.text()).length > 0, asset.path);
  }
});

test('OCR static serving has no generic path traversal or asset fallback', async () => {
  for (const path of [
    '/ocr/not-allowlisted.js',
    '/ocr/../server.js',
    '/ocr/%2e%2e/%2e%2e/src/server.js',
    '/ocr/%2Fetc%2Fpasswd',
    '/ocr/vendor/tesseract.js/../package.json',
    '/ocr/vendor/tesseract.js-core/tesseract-core.js'
  ]) {
    const response = await fetch(`${app.baseUrl}${path}`);
    assert.equal(response.status, 404, path);
  }
});
