const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inspectDxf, measureDxf } = require('../src/dxf');

const read = (name) => readFileSync(`${__dirname}/fixtures/${name}`);

function objectsFor(name) {
  const document = { id: 'src_0001', version: 1, filename: name, sourceSheet: 'A-PLAN', content: read(name) };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
  return Object.fromEntries(boq.sourceObjects.map((object) => [object.nativeHandle, object]));
}

const width = (object) => object.bounds[2] - object.bounds[0];
const height = (object) => object.bounds[3] - object.bounds[1];
const degenerate = (object) => width(object) === 0 && height(object) === 0;
const close = (actual, expected, tolerance = 0.5) => Math.abs(actual - expected) <= tolerance;

test('a block reference resolves to its definition footprint, not its insertion point', () => {
  const objects = objectsFor('blocks-plan.dxf');
  const door = objects.D1;
  assert.equal(door.geometrySource, 'dxf-entity');
  assert.ok(!degenerate(door), `door bounds should have extent, got ${JSON.stringify(door.bounds)}`);
  assert.ok(width(door) > 0 && height(door) > 0, 'maxX > minX and maxY > minY');
  // DOOR_900 is a 900 x 50 rectangle inserted at (2000, 0)
  assert.ok(close(width(door), 900), `width ${width(door)}`);
  assert.ok(close(height(door), 50), `height ${height(door)}`);
  assert.ok(close(door.bounds[0], 2000), 'placed at its insertion point');
  assert.equal(door.geometryResolution, 'block-definition');
});

test('rotation on the INSERT is reflected in the computed bounds', () => {
  const objects = objectsFor('blocks-plan.dxf');
  const plain = objects.D1;
  const rotated = objects.D2;
  // same block, rotated 90 degrees: the extents swap
  assert.ok(close(width(rotated), 50), `rotated width ${width(rotated)} should match the unrotated height`);
  assert.ok(close(height(rotated), 900), `rotated height ${height(rotated)} should match the unrotated width`);
  assert.ok(close(width(plain), height(rotated)) && close(height(plain), width(rotated)),
    'a 90 degree rotation swaps the footprint extents');
  // a 2000 x 800 block rotated 45 degrees has an axis-aligned box of
  // (2000 + 800) / sqrt(2) on both axes: much taller, marginally narrower
  const sofa = objects.F1;
  const expected = 2800 / Math.SQRT2;
  assert.ok(close(width(sofa), expected), `rotated width ${width(sofa)} vs ${expected}`);
  assert.ok(close(height(sofa), expected), `rotated height ${height(sofa)} vs ${expected}`);
  assert.ok(height(sofa) > 800, 'the rotated footprint is far taller than the unrotated block');
});

test('scale on the INSERT is reflected in the computed bounds', () => {
  const objects = objectsFor('blocks-plan.dxf');
  const window = objects.W1;
  // WIN_1200 is 1200 x 50, inserted with an x scale of 2
  assert.ok(close(width(window), 2400), `scaled width ${width(window)}`);
  assert.ok(close(height(window), 50), `unscaled height ${height(window)}`);
});

test('an INSERT referencing an undefined block keeps point bounds and is marked, not fabricated', () => {
  const objects = objectsFor('blocks-plan.dxf');
  const unresolved = objects.U1;
  assert.ok(unresolved, 'the source object still exists');
  assert.deepEqual(unresolved.bounds, [5000, 3000, 5000, 3000], 'bounds stay at the insertion point');
  assert.ok(degenerate(unresolved), 'no extent is invented for a block we cannot see');
  assert.equal(unresolved.geometryResolution, 'insertion-point');
});

test('a drawing with no BLOCKS section at all still processes, with every INSERT marked unresolved', () => {
  // Strip the block definitions back out of the clean plan: every reference
  // becomes unresolvable, and the drawing must still measure rather than fail.
  const stripped = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`, 'utf8').replace(/0\nSECTION\n2\nBLOCKS\n[\s\S]*?0\nENDSEC\n/, '');
  assert.ok(!stripped.includes('BLOCKS'), 'the BLOCKS section is gone');
  const document = { id: 'src_0001', version: 1, filename: 'no-blocks.dxf', sourceSheet: 'A-PLAN', content: stripped };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
  const inserts = boq.sourceObjects.filter((object) => object.geometryResolution !== 'native');
  assert.ok(inserts.length > 0, 'the clean fixture has block references');
  for (const insert of inserts) {
    assert.equal(insert.geometryResolution, 'insertion-point');
    assert.ok(degenerate(insert), 'point bounds, honestly reported');
  }
  // and the quantities are untouched by the missing definitions
  assert.equal(boq.lines.find((line) => line.measurement === 'door_count').quantity, 2);
  assert.equal(boq.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
});

test('resolving block definitions leaves the clean plan with no degenerate bounds', () => {
  const objects = Object.values(objectsFor('clean-plan.dxf'));
  assert.equal(objects.filter(degenerate).length, 0, 'every source object can be fitted in a viewer');
  assert.equal(objects.filter((object) => object.geometryResolution === 'block-definition').length, 8);
});

test('polygon entities are marked as native geometry, not block-resolved', () => {
  const objects = objectsFor('blocks-plan.dxf');
  assert.equal(objects.R1.geometryResolution, 'native');
  assert.ok(!degenerate(objects.R1));
});
