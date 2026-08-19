const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractPageGeometry } = require('../src/ingestion/pdf');

const OPS = {
  save: 1, restore: 2, transform: 3, constructPath: 4, moveTo: 5, lineTo: 6, rectangle: 7,
  closePath: 8, curveTo: 9, curveTo2: 10, curveTo3: 11, paintImageXObject: 12,
  stroke: 13, closeStroke: 14, fill: 15, fillStroke: 16, closeFillStroke: 17, endPath: 18, paintImageXObjectRepeat: 19, paintImageMaskXObjectGroup: 20
};

test('PDF adapter never measures an unclosed polyline as an area', () => {
  const result = extractPageGeometry({
    fnArray: [OPS.constructPath],
    argsArray: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo], [0, 0, 10, 0, 10, 10]]]
  }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1);
  assert.deepEqual(result.regions, []);
});

test('PDF adapter rejects every unsupported packed curve operator', () => {
  for (const curve of [OPS.curveTo, OPS.curveTo2, OPS.curveTo3]) {
    assert.throws(() => extractPageGeometry({
      fnArray: [OPS.constructPath],
      argsArray: [[[OPS.moveTo, curve], [0, 0, 1, 2, 3, 4, 5, 6]]]
    }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1), /Unsupported curved PDF path/);
  }
});

test('PDF adapter records image operators with the current display transform and size', () => {
  const result = extractPageGeometry({
    fnArray: [OPS.transform, OPS.paintImageXObject],
    argsArray: [[2, 0, 0, 2, 10, 20], ['image-1', 20, 30]]
  }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1);
  assert.equal(result.rasterRegions.length, 1);
  assert.deepEqual(result.rasterRegions[0].transform, [2, 0, 0, 2, 10, 20]);
  assert.equal(result.rasterRegions[0].pixelWidth, 20);
  assert.equal(result.rasterRegions[0].pixelHeight, 30);
});

test('PDF adapter emits only paths that are subsequently painted', () => {
  const result = extractPageGeometry({
    fnArray: [OPS.constructPath, OPS.endPath, OPS.constructPath, OPS.stroke],
    argsArray: [
      [[OPS.rectangle], [0, 0, 10, 10]], [],
      [[OPS.rectangle], [0, 0, 5, 5]], []
    ]
  }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].area, 25);
});

test('PDF adapter closes active paths for close-paint operators before emitting', () => {
  const result = extractPageGeometry({
    fnArray: [OPS.constructPath, OPS.closeStroke],
    argsArray: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo], [0, 0, 10, 0, 10, 10]], []]
  }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].area, 50);
});

test('PDF fill-family paint operators close and emit active open subpaths', () => {
  for (const paint of [OPS.fill, OPS.fillStroke]) {
    const result = extractPageGeometry({
      fnArray: [OPS.constructPath, paint],
      argsArray: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo], [0, 0, 10, 0, 10, 10]], []]
    }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1);
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].area, 50);
  }
});

test('PDF adapter rejects repeated/grouped images instead of bypassing accounting limits', () => {
  for (const operator of [OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectGroup]) {
    assert.throws(() => extractPageGeometry({ fnArray: [operator], argsArray: [['image', 1, 1]] }, OPS, { transform: [1, 0, 0, 1, 0, 0] }, 1), /unsupported|repeat|group/i);
  }
});

test('PDF adapter normalizes native text transforms into page viewport space', async () => {
  const { inspectPdf } = require('../src/ingestion/pdf');
  const pdf = require('node:fs').readFileSync(`${__dirname}/fixtures/vector-plan.pdf`);
  const page = (await inspectPdf(pdf, { filename: 'vector-plan.pdf' })).pages[0];
  assert.deepEqual(page.nativeText[0].transform, [0, 12, -12, 0, 26, 10]);
  assert.deepEqual(page.nativeText[0].rawTransform, [12, 0, 0, 12, 10, 10]);
  assert.equal(page.nativeText[0].coordinateSpace, 'pdf');
});
