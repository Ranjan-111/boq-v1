const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createApplication } = require('../src/application');
const { LimitError } = require('../src/ingestion/limits');
const { normalizeOcrResults } = require('../src/ocr-results');

function waitForRun(app, runId, predicate = (run) => run.status !== 'ingestion') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      try {
        const run = app.getRun(runId);
        if (predicate(run)) return resolve(run);
        if (Date.now() > deadline) return reject(new Error(`run ${runId} did not reach expected state`));
        setTimeout(poll, 10);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

async function rasterRun() {
  const app = createApplication();
  const sourceDocument = app.createSourceDocument({ filename: 'ocr.png', content: fs.readFileSync('test/fixtures/raster-200x100.png') });
  const processingRun = app.startProcessing(sourceDocument.id);
  const run = await waitForRun(app, processingRun.id);
  return { app, sourceDocument, processingRun, run };
}

async function vectorRun() {
  const app = createApplication();
  const sourceDocument = app.createSourceDocument({ filename: 'vector.pdf', content: fs.readFileSync('test/fixtures/vector-plan.pdf') });
  const processingRun = app.startProcessing(sourceDocument.id);
  const run = await waitForRun(app, processingRun.id);
  return { app, sourceDocument, processingRun, run };
}

function resultBody(sourceDocument, processingRun, observations, extra = {}) {
  return {
    sourceDocumentId: sourceDocument.id,
    sourceDocumentVersion: sourceDocument.version,
    contentSha256: sourceDocument.contentSha256,
    processingRunId: processingRun.id,
    engine: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng',
    normalizationVersion: 'ocr-normalization-v1',
    observations,
    ...extra
  };
}

function observation(text, x = 10, y = 10, score = 0.9) {
  return { text, textPolygon: [[x, y], [x + 30, y], [x + 30, y + 10], [x, y + 10]], confidence: { score } };
}

test('OCR observations are deterministic, idempotent, review-only, and side-effect isolated', async () => {
  const { app, sourceDocument, processingRun } = await rasterRun();
  const body = resultBody(sourceDocument, processingRun, [observation('  1200   mm  ')]);
  const before = app.getRun(processingRun.id);
  const first = app.submitOcrResults(processingRun.id, 'page_1', body);
  const second = app.submitOcrResults(processingRun.id, 'page_1', body);
  assert.deepEqual(second, first);
  assert.equal(first.ocr.observations[0].text, '1200 mm');
  assert.equal(first.ocr.observations[0].semanticEvidence[0].state, 'needs_review');
  const after = app.getRun(processingRun.id);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.boq, before.boq);
  assert.deepEqual(after.setup, before.setup);
  assert.deepEqual(after.pages, before.pages);
});

test('overlapping OCR tiles deduplicate deterministically and retain native precedence/conflicts', async () => {
  const { app, sourceDocument, processingRun } = await rasterRun();
  const output = app.submitOcrResults(processingRun.id, 'page_1', resultBody(sourceDocument, processingRun, [
    observation('Room name', 10, 10, 0.7), observation('Room   name', 11, 11, 0.95)
  ]));
  assert.equal(output.observations.length, 1);
  assert.ok(output.observations.some((item) => item.text === 'Room name'));
  const run = { ...app.getRun(processingRun.id), sourceDocumentId: sourceDocument.id };
  const page = { ...run.pages[0], nativeText: [{ id: 'native_1', text: 'Room name', textPolygon: [[10, 10], [40, 10], [40, 20], [10, 20]] }] };
  const native = normalizeOcrResults(resultBody(sourceDocument, processingRun, [observation('Room name')]), { run, page, pageId: 'page_1' });
  assert.equal(native.observations[0].status, 'suppressed_by_native');
  const conflict = normalizeOcrResults(resultBody(sourceDocument, processingRun, [observation('Different')]), { run, page, pageId: 'page_1' });
  assert.equal(conflict.observations[0].status, 'conflict');
});

test('OCR rejects malformed, out-of-bounds, forbidden, and oversized results without mutation', async () => {
  const { app, sourceDocument, processingRun } = await rasterRun();
  const before = JSON.stringify(app.getRun(processingRun.id));
  const invalid = [
    observation('outside', 190, 95),
    { text: 'bad', textPolygon: [[1, 1], [2, 1], [1, 2]], confidence: { score: 2 } },
    { text: 'bad', textPolygon: [[1, 1], [2, 1], [1, 2]], confidence: { score: 0.5 }, quantity: 99 }
  ];
  for (const item of invalid) assert.throws(() => app.submitOcrResults(processingRun.id, 'page_1', resultBody(sourceDocument, processingRun, [item])), /OCR|forbidden|confidence|bounds/i);
  const oversized = Array.from({ length: 1001 }, (_, index) => observation(`x${index}`, 1 + (index % 10) * 10, 1 + Math.floor(index / 10) % 9));
  assert.throws(() => app.submitOcrResults(processingRun.id, 'page_1', resultBody(sourceDocument, processingRun, oversized)), (error) => error instanceof LimitError && error.limitName === 'ocrObservations');
  assert.equal(JSON.stringify(app.getRun(processingRun.id)), before);
});

test('multiple bounded crop polygons accumulate independently and repeat idempotently', async () => {
  const { app, sourceDocument, processingRun } = await rasterRun();
  const first = app.submitOcrResults(processingRun.id, 'page_1', resultBody(sourceDocument, processingRun, [observation('one', 10, 10)], { cropPolygon: [[0, 0], [80, 0], [80, 50], [0, 50]], coordinateSpace: 'image' }));
  const secondBody = resultBody(sourceDocument, processingRun, [observation('two', 100, 10)], { cropPolygon: [{ x: 80, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 50 }, { x: 80, y: 50 }], coordinateSpace: 'image' });
  const second = app.submitOcrResults(processingRun.id, 'page_1', secondBody);
  assert.deepEqual(app.submitOcrResults(processingRun.id, 'page_1', secondBody), second);
  assert.equal(first.ocr.batch.cropPolygon[0][0], 0);
  assert.deepEqual(second.ocr.batch.cropPolygon, [[80, 0], [180, 0], [180, 50], [80, 50]]);
  assert.equal(app.getRun(processingRun.id).ocr.observations.length, 2);
  assert.notEqual(first.ocr.batch.batchKey, second.ocr.batch.batchKey);
  assert.throws(() => app.submitOcrResults(processingRun.id, 'page_1', resultBody(sourceDocument, processingRun, [observation('bad', 10, 10)], { cropPolygon: [[0, 0], [80, 0], [80, 50], [0, 50]], coordinateSpace: 'pdf' })), /coordinateSpace/i);
});

test('actual vector PDF native text polygons suppress matching OCR and retain conflicts', async () => {
  const { app, sourceDocument, processingRun, run } = await vectorRun();
  const page = run.pages[0];
  const native = page.nativeText[0];
  assert.deepEqual(native.textPolygon, [[10, 10], [10, 70.684], [22, 70.684], [22, 10]]);
  const common = { pageTransform: page.transform, coordinateSpace: 'pdf' };
  const output = app.submitOcrResults(processingRun.id, page.sourcePageId, resultBody(sourceDocument, processingRun, [
    { text: ' ROOM   101 ', textPolygon: [[10, 10], [10, 70], [22, 70], [22, 10]], confidence: { score: 0.8 } },
    { text: ' ROOM   999 ', textPolygon: [[10, 10], [10, 70], [22, 70], [22, 10]], confidence: { score: 0.8 } }
  ], common));
  const same = output.observations.find((item) => item.text === 'ROOM 101');
  const conflict = output.observations.find((item) => item.text === 'ROOM 999');
  assert.equal(same.status, 'suppressed_by_native');
  assert.equal(same.nativeMatchId, native.id);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.precedence, 'native-preferred');
  assert.equal(app.getRun(processingRun.id).boq, null);
});
