const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inspectDxf, measureDxf } = require('../src/dxf');
const { exceptionsForRun } = require('../src/exceptions');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);
function measure(name) {
  const document = { id: 'src_0001', version: 1, filename: name, sourceSheet: 'A', content: fixture(name) };
  const { document: parsed, units, versions } = inspectDxf(document);
  return measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
}
const line = (boq, m) => boq.lines.find((l) => l.measurement === m);

test('floor is inferred from the largest closed wall boundary when no room polygon exists', () => {
  const boq = measure('walls-no-room.dxf');
  const floor = line(boq, 'floor_area');
  assert.equal(floor.quantity, 24, 'gross floor = outer 6 m x 4 m boundary, not the inner partition');
  assert.equal(floor.measurementStatus, 'measured');
});

test('an inferred floor is LOW confidence and raises a review exception, never silently trusted', () => {
  const boq = measure('walls-no-room.dxf');
  const floor = line(boq, 'floor_area');
  assert.equal(floor.confidence.level, 'LOW', 'a floor read off the walls is not a measured room');
  assert.ok(floor.confidence.evidence.includes('inferred-from-walls'));
  assert.equal(floor.provenance.floorBasis, 'wall-boundary');

  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq, residuals: [], pages: [] };
  const raised = exceptionsForRun(run).filter((e) => e.type === 'inferred_floor');
  assert.equal(raised.length, 1, 'the operator is asked to confirm the inference');
  assert.match(raised[0].raisedBecause, /wall|boundary|no room/i);
});

test('an explicit room polygon is always preferred over inference from walls', () => {
  const boq = measure('walls-and-room.dxf');
  const floor = line(boq, 'floor_area');
  assert.equal(floor.quantity, 20, 'the tagged 5 m x 4 m room, not the 24 wall boundary');
  assert.equal(floor.confidence.level, 'HIGH', 'a tagged room is measured, not inferred');
  assert.equal(floor.provenance.floorBasis ?? 'room-polygon', 'room-polygon');

  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq, residuals: [], pages: [] };
  assert.equal(exceptionsForRun(run).some((e) => e.type === 'inferred_floor'), false,
    'no inference exception when a real room exists');
});

test('a drawing whose walls form no closed loop leaves floor not_measurable', () => {
  // three disconnected wall lines: no enclosed boundary to infer from
  const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'W1', '8', 'A-WALL', '10', '0', '20', '0', '11', '6000', '21', '0',
    '0', 'LINE', '5', 'W2', '8', 'A-WALL', '10', '0', '20', '2000', '11', '6000', '21', '2000',
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const document = { id: 'src_0001', version: 1, filename: 'open-walls.dxf', sourceSheet: 'A', content: `${lines}\n` };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
  const floor = line(boq, 'floor_area');
  assert.equal(floor.measurementStatus, 'not_measurable', 'no closed boundary means no honest floor');
  assert.equal(floor.quantity, 0);
  // but the walls themselves still measure
  assert.equal(line(boq, 'wall_plan').measurementStatus, 'measured');
});

test('floor-intent layer names beyond ROOM are recognised', () => {
  const { layerCategory } = require('../src/dxf');
  for (const name of ['A-FLOR', 'FLOOR-FINISH', 'A-SLAB', 'SPACE-01', 'CARPET']) {
    assert.equal(layerCategory(name), 'room', `${name} should be a floor/room layer`);
  }
  // and a hand-written closed poly on a floor layer measures as floor
  const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '5', 'F1', '8', 'A-FLOR', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '5000', '20', '0', '10', '5000', '20', '4000', '10', '0', '20', '4000',
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const document = { id: 'src_0001', version: 1, filename: 'floor-layer.dxf', sourceSheet: 'A', content: `${lines}\n` };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
  assert.equal(line(boq, 'floor_area').quantity, 20, 'a floor-layer polygon measures directly');
  assert.equal(line(boq, 'floor_area').confidence.level, 'HIGH', 'a tagged floor is not an inference');
});
