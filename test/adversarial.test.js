const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inspectDxf, measureDxf, InputError } = require('../src/dxf');
const { LIMITS, LimitError } = require('../src/ingestion/limits');
const { createApplication } = require('../src/application');

const adversarial = (name) => readFileSync(`${__dirname}/fixtures/adversarial/${name}`);
function measure(name, options = {}) {
  const document = { id: 'src_0001', version: 1, filename: name, sourceSheet: 'A-PLAN', content: adversarial(name) };
  const { document: parsed, units, versions } = inspectDxf(document);
  return measureDxf(document, units, parsed, { versions, runId: 'run_0001', ...options });
}
const lineOf = (boq, measurement) => boq.lines.find((line) => line.measurement === measurement);

test('a file with no $INSUNITS halts at unit resolution and produces no quantity', () => {
  let error = null;
  try { measure('no-insunits.dxf'); } catch (caught) { error = caught; }
  assert.ok(error instanceof InputError, 'the drawing is refused, not measured');
  assert.match(error.message, /which drawing unit/i);
  assert.match(error.message, /fallback unit|re-export/i, 'and says what to do about it');
});

test('geometry scaled ten times is measured but flagged as implausible', () => {
  const scaled = measure('scaled-10x.dxf');
  const floor = lineOf(scaled, 'floor_area');
  assert.equal(floor.measurementStatus, 'measured', 'the arithmetic is still valid');
  assert.ok(floor.quantity > 2000, `scaled up as expected: ${floor.quantity}`);
  assert.equal(floor.provenance.plausibility.flagged, true, 'but the magnitude is called out');
  assert.ok(floor.provenance.plausibility.reasons.length > 0);
  assert.match(floor.provenance.plausibility.reasons[0], /implausible|single room/i);
  assert.equal(floor.confidence.level, 'LOW', 'and the line is not presented as confident');
});

test('the same drawing at true scale is not flagged', () => {
  const clean = { id: 'src_0001', version: 1, filename: 'clean-plan.dxf', sourceSheet: 'A', content: readFileSync(`${__dirname}/fixtures/clean-plan.dxf`) };
  const { document, units, versions } = inspectDxf(clean);
  const boq = measureDxf(clean, units, document, { versions, runId: 'run_0001' });
  for (const line of boq.lines) {
    assert.notEqual(line.provenance.plausibility?.flagged, true, `${line.measurement} must not false-positive`);
  }
});

test('meaningless layer names degrade classification but counts survive on block names', () => {
  const garbage = measure('garbage-layers.dxf');
  for (const measurement of ['wall_plan', 'floor_area', 'wall_plaster']) {
    assert.equal(lineOf(garbage, measurement).measurementStatus, 'not_measurable', `${measurement} degrades rather than guessing`);
    assert.equal(lineOf(garbage, measurement).quantity, 0);
  }
  assert.equal(lineOf(garbage, 'door_count').quantity, 2, 'block names still identify doors');
  assert.equal(lineOf(garbage, 'furniture_count').quantity, 4);
  assert.ok(garbage.unclassified.length > 0, 'the geometry we could not classify is reported, not dropped');
});

test('no hatch means wall area is not measurable, never zero', () => {
  const boq = measure('no-hatch.dxf');
  const wall = lineOf(boq, 'wall_plan');
  assert.equal(wall.measurementStatus, 'not_measurable');
  assert.notEqual(wall.measurementStatus, 'measured_zero');
  assert.equal(lineOf(boq, 'floor_area').measurementStatus, 'measured', 'rooms are unaffected');
});

test('furniture exploded to polylines is flagged unclassifiable, never silently dropped', () => {
  const boq = measure('exploded-furniture.dxf');
  assert.equal(lineOf(boq, 'furniture_count').measurementStatus, 'not_measurable', 'nothing countable remains');
  assert.equal(boq.unclassified.length, 4, 'but the four exploded outlines are still reported');
  for (const entry of boq.unclassified) {
    assert.ok(entry.sourceObjectId, 'each names a source object a human can go and look at');
    assert.ok(entry.reason, 'and says why it could not be used');
  }
  const ids = new Set(boq.sourceObjects.map((object) => object.sourceObjectId));
  assert.ok(boq.unclassified.every((entry) => ids.has(entry.sourceObjectId)), 'and resolves to real geometry');
});

test('garbage layers and exploded furniture together degrade and flag, never guess', () => {
  const boq = measure('garbage-and-exploded.dxf');
  const measured = boq.lines.filter((line) => line.measurementStatus === 'measured');
  assert.deepEqual(measured.map((line) => line.measurement).sort(), ['door_count', 'window_count'],
    'only what block names can still prove survives');
  assert.ok(boq.unclassified.length >= 4, `everything else is reported unclassifiable, got ${boq.unclassified.length}`);
  for (const line of boq.lines) {
    if (line.measurementStatus === 'measured') continue;
    assert.equal(line.quantity, 0);
    assert.equal(line.measurementStatus, 'not_measurable', `${line.measurement} must not look like a measured zero`);
  }
});

test('a deduction that exceeds the geometry is not measurable and says so', () => {
  const boq = (() => {
    const clean = { id: 'src_0001', version: 1, filename: 'clean-plan.dxf', sourceSheet: 'A', content: readFileSync(`${__dirname}/fixtures/clean-plan.dxf`) };
    const { document, units, versions } = inspectDxf(clean);
    return measureDxf(clean, units, document, { versions, runId: 'run_0001', assumptions: { wallHeight: 0.5, doorOpeningHeight: 10, windowOpeningHeight: 10 } });
  })();
  const plaster = lineOf(boq, 'wall_plaster');
  assert.equal(plaster.measurementStatus, 'not_measurable');
  assert.ok(plaster.provenance.impossible.signedSum < 0);
  assert.equal(plaster.quantity, 0);
});

test('a truncated DXF is rejected at the boundary in plain language', () => {
  let error = null;
  try { measure('truncated.dxf'); } catch (caught) { error = caught; }
  assert.ok(error instanceof InputError);
  assert.match(error.message, /malformed|re-export/i);
  assert.ok(!/undefined|NaN|TypeError|\[object/.test(error.message), `plain language, got: ${error.message}`);
});

test('an oversized upload is refused by the limits module, not by exhausting memory', async () => {
  const { startOperatorApp } = require('../test-support/operator-app');
  const app = await startOperatorApp();
  try {
    const oversized = Buffer.alloc(LIMITS.uploadBytes + 1024, 0x41);
    const form = new FormData();
    form.set('drawing', new Blob([oversized]), 'huge.dxf');
    const response = await fetch(`${app.baseUrl}/api/source-documents`, { method: 'POST', body: form });
    assert.ok([413, 422].includes(response.status), `refused at the boundary, got ${response.status}`);
    const body = await response.json();
    assert.match(body.error, /limit|large|size|bytes/i);
  } finally { await app.close(); }
});

test('the limits module names the limit it enforced', () => {
  const error = new LimitError('too big', { limitName: 'uploadBytes', observed: 99, maximum: 10 });
  assert.equal(error.limitName, 'uploadBytes');
  assert.ok(LIMITS.uploadBytes > 0);
});
