const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication, InputError, ConflictError } = require('../src/application');

const png = readFileSync(`${__dirname}/fixtures/raster-200x100.png`);
const mixedPdf = readFileSync(`${__dirname}/fixtures/mixed-plan.pdf`);
function delayedApplication() {
  const app = createApplication({ schedule: (callback) => setImmediate(callback) });
  return app;
}

function wait(milliseconds = 20) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('raster gates expose per-page calibration and trace blockers', async () => {
  const app = delayedApplication();
  const source = app.createSourceDocument({ filename: 'plan.png', content: png });
  const run = app.startProcessing(source.id);
  await wait();
  const state = app.getRun(run.id);
  assert.equal(state.status, 'awaiting_calibration');
  assert.match(state.setup.pages[0].blockedReasons.join(' '), /calibration/i);
  assert.throws(() => app.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 1e-20, realUnit: 'm' }), InputError);
  assert.equal(app.getRun(run.id).pages[0].calibration, null);
  app.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  assert.match(app.getRun(run.id).setup.pages[0].blockedReasons.join(' '), /traced region/i);
});

test('raster categories and typical multipliers are bounded server-side', () => {
  const app = delayedApplication();
  assert.throws(() => app.createSourceDocument({ filename: 'plan.png', content: png, typicalMultiplier: 1001 }), /between 1 and 1000/i);
  const source = app.createSourceDocument({ filename: 'plan.png', content: png });
  const run = app.startProcessing(source.id);
  return wait().then(() => {
    app.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
    assert.throws(() => app.createRasterRegion(run.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], category: 'not-supported' }), InputError);
    assert.throws(() => app.createRasterRegion(run.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], category: 'x'.repeat(65) }), InputError);
  });
});

test('reprocessing guards stale raster runs from mutating source state', async () => {
  const app = delayedApplication();
  const source = app.createSourceDocument({ filename: 'plan.png', content: png });
  const oldRun = app.startProcessing(source.id);
  await wait();
  const newRun = app.reprocess(oldRun.id);
  assert.notEqual(newRun.id, oldRun.id);
  assert.throws(() => app.calibrateRasterPage(oldRun.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' }), ConflictError);
});

test('mixed PDFs fail closed instead of omitting vector quantities', async () => {
  const app = delayedApplication();
  const source = app.createSourceDocument({ filename: 'mixed.pdf', content: mixedPdf });
  const run = app.startProcessing(source.id);
  await wait(250);
  const state = app.getRun(run.id);
  assert.equal(state.status, 'failed');
  assert.equal(state.errorDetails.code, 'mixed_pdf_unsupported');
  assert.match(state.error, /vector quantities and raster regions cannot be measured together/i);
  assert.equal(state.exportable, false);
  assert.equal(state.boq, null);
});
