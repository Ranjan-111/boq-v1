const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeObservations } = require('../public/ocr/normalize');

function normalize(poly, overrides = {}) {
  return normalizeObservations({ observations: [{ text: '1200 mm', score: 0.9, poly }] }, {
    sourceDocumentId: 'src_1', sourceDocumentVersion: 1, processingRunId: 'run_1', pageId: 'page_1',
    engine: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng',
    coordinateSpace: 'image', crop: { x: 20, y: 30, width: 100, height: 50 },
    pageWidth: 300, pageHeight: 200, pageTransform: [0, 1, 1, 0, 0, 0], ...overrides
  })[0];
}

test('OCR polygons from physically rotated crops map back to canonical image space', () => {
  assert.deepEqual(normalize([[0, 0], [10, 0], [10, 5], [0, 5]], { rotation: 90 }).textPolygon, [[20, 80], [20, 70], [25, 70], [25, 80]]);
  assert.deepEqual(normalize([[0, 0], [10, 0], [10, 5], [0, 5]], { rotation: 180 }).textPolygon, [[120, 80], [110, 80], [110, 75], [120, 75]]);
  assert.deepEqual(normalize([[0, 0], [10, 0], [10, 5], [0, 5]], { rotation: 270 }).textPolygon, [[120, 30], [120, 40], [115, 40], [115, 30]]);
});

test('image-space OCR retains but does not reapply the PDF source transform', () => {
  const observation = normalize([[1, 2], [11, 2], [11, 7], [1, 7]], { rotation: 0 });
  assert.deepEqual(observation.textPolygon, [[21, 32], [31, 32], [31, 37], [21, 37]]);
  assert.deepEqual(observation.pageTransform, [0, 1, 1, 0, 0, 0]);
  assert.equal(observation.coordinateSpace, 'image');
});
