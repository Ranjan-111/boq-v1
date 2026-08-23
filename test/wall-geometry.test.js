const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inspectDxf, measureDxf } = require('../src/dxf');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);
function measure(name) {
  const document = { id: 'src_0001', version: 1, filename: name, sourceSheet: 'A', content: fixture(name) };
  const { document: parsed, units, versions } = inspectDxf(document);
  return measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
}
const line = (boq, m) => boq.lines.find((l) => l.measurement === m);
const round = (v) => Number(v.toFixed(6));

/* A wall's fundamental measure is its centre-line length. A drawing supplies it
   as a filled HATCH (length = area / thickness), a single LINE, an open
   polyline path, or a closed boundary loop (length = perimeter). All four must
   measure the same wall the same way. */

for (const name of ['line-walls.dxf', 'polyline-walls-open.dxf', 'polyline-walls-closed.dxf']) {
  test(`walls drawn as ${name.replace('.dxf', '')} are measured by centre-line length`, () => {
    const boq = measure(name);
    // 6 m x 4 m room, wall run 20 m, thickness 0.23 m, height 3 m
    assert.equal(round(line(boq, 'wall_plan').quantity), 4.6, 'run 20 m x thickness 0.23');
    assert.equal(round(line(boq, 'wall_masonry').quantity), 13.8, 'run x thickness x height');
    assert.equal(round(line(boq, 'wall_plaster').quantity), 120, 'run x 2 faces x height');
    assert.equal(line(boq, 'wall_plan').measurementStatus, 'measured');
  });
}

test('a hatch-drawn wall still measures exactly as before (regression guard)', () => {
  const boq = measure('clean-plan.dxf');
  assert.equal(line(boq, 'wall_plan').quantity, 6.026);
  assert.equal(line(boq, 'wall_masonry').quantity, 18.078);
  assert.equal(line(boq, 'wall_plaster').quantity, 143.79);
});

test('the wall provenance records how its length was derived', () => {
  const boq = measure('line-walls.dxf');
  const object = boq.sourceObjects.find((o) => o.nativeHandle === 'L0');
  assert.ok(object, 'the wall line is a source object');
  assert.equal(object.wallGeometry, 'centre-line', 'a line is a centre-line, not a filled footprint');
  const hatchBoq = measure('clean-plan.dxf');
  const hatchObject = hatchBoq.sourceObjects.find((o) => o.geometryResolution === 'native' && o.wallGeometry);
  assert.equal(hatchObject.wallGeometry, 'footprint', 'a hatch is a filled footprint');
});

test('a two-vertex wall line encloses no area but still has length', () => {
  // a single 5 m wall segment, not a loop
  const single = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'W1', '8', 'A-WALL', '10', '0', '20', '0', '11', '5000', '21', '0',
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const document = { id: 'src_0001', version: 1, filename: 'single-wall.dxf', sourceSheet: 'A', content: single };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
  // 5 m run x 0.23 thickness
  assert.equal(round(line(boq, 'wall_plan').quantity), 1.15);
  assert.equal(round(line(boq, 'wall_plaster').quantity), 30);
});
