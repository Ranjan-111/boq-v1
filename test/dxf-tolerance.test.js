const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inspectDxf, measureDxf, parseDxf, InputError } = require('../src/dxf');
const { exceptionsForRun } = require('../src/exceptions');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);

function measure(content, filename = 'plan.dxf') {
  const document = { id: 'src_0001', version: 1, filename, sourceSheet: 'A', content };
  const { document: parsed, units, versions } = inspectDxf(document);
  return measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
}

/* The contract this file pins:

   unsupported  != malformed.  A drawing we cannot fully interpret is measured
   for what we can read, and every entity we could not use is reported. A
   drawing whose geometry is corrupt in a way that could produce a WRONG number
   is still refused outright.

   Refusing every file containing a TEXT label meant refusing every real
   architectural drawing, which has no safety value at all -- the operator just
   goes back to manual takeoff. */

test('an annotation entity does not fail the drawing, and is reported', () => {
  const withText = fixture('clean-plan.dxf').toString('utf8')
    .replace('0\nENDSEC\n0\nEOF\n', '0\nTEXT\n5\nT1\n8\nA-ANNO\n10\n100\n20\n100\n40\n200\n1\nLIVING ROOM\n0\nENDSEC\n0\nEOF\n');
  const boq = measure(withText);
  assert.equal(boq.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72,
    'the drawing still measures exactly as it did');
  const skipped = boq.unclassified.filter((entry) => entry.type === 'TEXT');
  assert.equal(skipped.length, 1, 'the label is reported, not silently dropped');
  assert.equal(skipped[0].kind, 'annotation');
  assert.match(skipped[0].reason, /annotation|label/i);
});

test('an annotation-only omission is advisory: labels carry no quantity', () => {
  const withText = fixture('clean-plan.dxf').toString('utf8')
    .replace('0\nENDSEC\n0\nEOF\n', '0\nTEXT\n5\nT1\n8\nA-ANNO\n10\n1\n20\n1\n1\nKITCHEN\n0\nENDSEC\n0\nEOF\n');
  const boq = measure(withText);
  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq, residuals: [], pages: [] };
  const raised = exceptionsForRun(run).filter((exception) => ['unclassified_geometry', 'unmeasured_geometry'].includes(exception.type));
  assert.ok(raised.length > 0, 'it is still surfaced');
  assert.ok(raised.every((exception) => exception.severity === 'advisory'),
    'a room label cannot change a quantity, so it must not block approval');
});

test('unmeasured GEOMETRY blocks approval, because it could have been a quantity', () => {
  const withCircle = fixture('clean-plan.dxf').toString('utf8')
    .replace('0\nENDSEC\n0\nEOF\n', '0\nCIRCLE\n5\nC1\n8\nA-WALL\n10\n0\n20\n0\n40\n100\n0\nENDSEC\n0\nEOF\n');
  const boq = measure(withCircle);
  assert.equal(boq.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
  const skipped = boq.unclassified.filter((entry) => entry.type === 'CIRCLE');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'unmeasured-geometry');

  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq, residuals: [], pages: [] };
  const blocking = exceptionsForRun(run).filter((exception) => exception.type === 'unmeasured_geometry');
  assert.equal(blocking.length > 0, true, 'geometry we could not read is raised');
  assert.equal(blocking[0].severity, 'blocking',
    'a circle on a wall layer might be a column; a BOQ that ignored it would be short');
  assert.match(blocking[0].raisedBecause, /CIRCLE/);
});

test('a drawing with no handles is measured, with stable synthesized identity', () => {
  // Handles are optional in older DXF revisions and many exporters omit them.
  const noHandles = fixture('clean-plan.dxf').toString('utf8').replace(/\n5\n[0-9A-Za-z]+\n/g, '\n');
  assert.equal(/\n5\n/.test(noHandles), false, 'the fixture really has no handles');
  const first = measure(noHandles);
  assert.equal(first.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
  const second = measure(noHandles);
  assert.deepEqual(
    second.sourceObjects.map((object) => object.sourceObjectId),
    first.sourceObjects.map((object) => object.sourceObjectId),
    'synthesized identity is deterministic, so provenance is still stable across reprocessing'
  );
  assert.ok(first.sourceObjects.every((object) => object.nativeHandle), 'every object still has a handle');
  assert.ok(first.sourceObjects.some((object) => object.handleSource === 'synthesized'),
    'and says the handle was ours, not the file s');
});

test('a file that ends without EOF is still read', () => {
  const truncatedTail = fixture('clean-plan.dxf').toString('utf8').replace(/0\nEOF\n?$/, '0\n');
  const boq = measure(truncatedTail);
  assert.equal(boq.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
});

test('genuinely corrupt geometry is still refused outright', () => {
  // A LWPOLYLINE we DO measure, with a coordinate that is not a number: this
  // could produce a wrong quantity, so it must not be measured around.
  const corrupt = fixture('clean-plan.dxf').toString('utf8')
    .replace('0\nLWPOLYLINE\n5\n10A\n8\nA-ROOM\n70\n1\n10\n0\n20\n0\n', '0\nLWPOLYLINE\n5\n10A\n8\nA-ROOM\n70\n1\n10\nnot-a-number\n20\n0\n');
  assert.throws(() => measure(corrupt), InputError, 'a bad coordinate on a measured entity still rejects');
});

test('an unterminated section is still refused', () => {
  const half = fixture('clean-plan.dxf').toString('utf8').slice(0, 400);
  assert.throws(() => measure(half), InputError);
});

test('external references are still refused', () => {
  const withXref = fixture('clean-plan.dxf').toString('utf8')
    .replace('0\nENDSEC\n0\nEOF\n', '0\nIMAGE\n5\nI1\n8\nA-WALL\n0\nENDSEC\n0\nEOF\n');
  assert.throws(() => measure(withXref), InputError, 'geometry living outside the file is a different problem');
});

test('a drawing carrying every trait that broke real files still ingests', () => {
  /* One fixture, authored here rather than vendored, combining exactly what the
     wild files carried: no entity handles, a TEXT label, a two-vertex dimension
     polyline, an ARC, and no EOF terminator. Each of these failed ingestion
     outright before. */
  const boq = measure(fixture('wild-traits-plan.dxf'), 'wild-traits-plan.dxf');

  assert.equal(boq.lines.find((line) => line.measurement === 'floor_area').quantity, 20,
    '5 m x 4 m room measured despite everything else in the file');
  assert.equal(boq.lines.find((line) => line.measurement === 'wall_plan').measurementStatus, 'measured');

  const kinds = boq.unclassified.reduce((totals, entry) => ({ ...totals, [entry.kind]: (totals[entry.kind] || 0) + 1 }), {});
  assert.ok(kinds.annotation >= 1, 'the label is reported as an annotation');
  assert.ok(kinds['unmeasured-geometry'] >= 2, 'the arc and the open polyline are reported as geometry');

  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq, residuals: [], pages: [] };
  const raised = exceptionsForRun(run);
  assert.ok(raised.some((exception) => exception.type === 'unmeasured_geometry' && exception.severity === 'blocking'),
    'and the geometry we could not read still blocks approval');
});

test('a LINE on a wall layer is measured, not discarded', () => {
  /* Regression: LINE was validated but then returned null, so a wall drawn as
     lines measured nothing and said nothing. Wall lines are now measured by
     centre-line length (see wall-geometry.test.js); a LINE that no rule
     consumes still surfaces through boq.unclassified rather than vanishing. */
  const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const [x1, y1, x2, y2] of [[0, 0, 6000, 0], [6000, 0, 6000, 4000], [6000, 4000, 0, 4000], [0, 4000, 0, 0]]) {
    lines.push('0', 'LINE', '8', 'A-WALL', '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2));
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  const document = { id: 'src_0001', version: 1, filename: 'lines.dxf', sourceSheet: 'A', content: `${lines.join('\n')}\n` };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });

  // 6 m x 4 m room, wall run 20 m: the lines produce a real wall quantity
  const wall = boq.lines.find((line) => line.measurement === 'wall_plan');
  assert.equal(wall.measurementStatus, 'measured', 'the wall lines are measured, not thrown away');
  assert.equal(Number(wall.quantity.toFixed(6)), 4.6, '20 m run x 0.23 thickness');
  assert.equal(boq.unclassified.filter((entry) => entry.type === 'LINE').length, 0, 'nothing is left unclassified because everything was measured');
});

test('a LINE on a non-measured layer still surfaces rather than vanishing', () => {
  const lines = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'A-GRID', '10', '0', '20', '0', '11', '5000', '21', '0',
    '0', 'ENDSEC', '0', 'EOF'];
  const document = { id: 'src_0001', version: 1, filename: 'grid.dxf', sourceSheet: 'A', content: `${lines.join('\n')}\n` };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });
  const reported = boq.unclassified.filter((entry) => entry.type === 'LINE');
  assert.equal(reported.length, 1, 'a line no rule measured is reported, not silently dropped');
  assert.equal(reported[0].kind, 'unmeasured-geometry');
});

test('an INSERT referencing an external block is skipped and reported, not fatal', () => {
  /* A furniture library referenced as an xref lives outside the file. We cannot
     measure it, but the rest of the drawing is fine -- skip the xref, measure
     the walls and rooms, and raise it as unmeasured geometry so the incomplete
     count is visible rather than the whole upload failing. */
  const withXref = fixture('clean-plan.dxf').toString('utf8')
    .replace('0\nENDSEC\n0\nEOF\n', '0\nINSERT\n5\nX1\n8\nA-FURN\n2\nxref-external-library-sofa\n10\n1000\n20\n1000\n0\nENDSEC\n0\nEOF\n');
  const document = { id: 'src_0001', version: 1, filename: 'with-xref.dxf', sourceSheet: 'A', content: withXref };
  const { document: parsed, units, versions } = inspectDxf(document);
  const boq = measureDxf(document, units, parsed, { versions, runId: 'run_0001' });

  assert.equal(boq.lines.find((l) => l.measurement === 'floor_area').quantity, 27.72, 'the rest still measures');
  const reported = boq.unclassified.filter((e) => /xref/i.test(e.block || ''));
  assert.equal(reported.length, 1, 'the xref insert is reported');
  assert.equal(reported[0].kind, 'external-reference');

  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq, residuals: [], pages: [] };
  const blocking = exceptionsForRun(run).filter((e) => e.type === 'unmeasured_geometry');
  assert.ok(blocking.length > 0, 'and the incomplete geometry blocks a clean approval');
});
