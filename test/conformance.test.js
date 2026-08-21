const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { inspectDxf, measureDxf, InputError } = require('../src/dxf');
const { createLedger, DISQUALIFYING } = require('../src/conformance');
const { CORPUS, ADVERSARIAL, DEFAULT_ASSUMPTIONS_VERSION } = require('./conformance/corpus');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);
const sync = () => createApplication({ schedule: (callback) => callback() });
const ledger = createLedger();
const lineOf = (carrier, measurement) => carrier.lines.find((line) => line.measurement === measurement);

function measureDxfFixture(name, rulesetVersion) {
  const document = { id: 'src_0001', version: 1, filename: name, sourceSheet: 'A-PLAN', content: fixture(name) };
  const { document: parsed, units, versions } = inspectDxf(document);
  return measureDxf(document, units, parsed, { versions, runId: 'run_0001', rulesetVersion });
}

function record(entry, rulesetVersion, carrier, { gated = false } = {}) {
  const expectations = entry.expectations[rulesetVersion];
  if (!expectations) return;
  for (const [measurement, expected] of Object.entries(expectations)) {
    assert.ok(expected.arithmetic, `${entry.fixture}/${measurement} records how its expected value is derived`);
    const line = lineOf(carrier, measurement);
    const outcome = ledger.record({
      fixture: entry.variant ? `${entry.fixture} (${entry.variant})` : entry.fixture,
      rulesetVersion, assumptionsVersion: DEFAULT_ASSUMPTIONS_VERSION,
      measurement, expectedQuantity: expected.value, line, gated
    });
    assert.equal(outcome, 'correct',
      `${entry.fixture} [${rulesetVersion}] ${measurement}: expected ${expected.value}, got ${line?.quantity}\n  because: ${expected.arithmetic}`);
  }
}

test('DXF clean plan matches expectations under every ruleset', () => {
  const entry = CORPUS.find((item) => item.fixture === 'clean-plan.dxf' && !item.variant);
  for (const rulesetVersion of Object.keys(entry.expectations)) {
    record(entry, rulesetVersion, measureDxfFixture('clean-plan.dxf', rulesetVersion));
  }
});

test('clean-plan-v1 reproduces the pre-#6 historical quantities exactly', () => {
  const entry = CORPUS.find((item) => item.fixture === 'clean-plan.dxf' && !item.variant);
  const boq = measureDxfFixture('clean-plan.dxf', 'clean-plan-v1');
  // the numbers this repository produced before deductions existed
  const historical = { wall_plan: 6.026, wall_masonry: 18.078, wall_plaster: 157.2, floor_area: 27.72, skirting: 29.8, room_count: 2, door_count: 2, window_count: 2, furniture_count: 4 };
  for (const [measurement, value] of Object.entries(historical)) {
    assert.equal(lineOf(boq, measurement).quantity, value, `${measurement} drifted from the pre-#6 baseline`);
  }
  assert.equal(entry.expectations['clean-plan-v1'].wall_plaster.value, 157.2);
});

test('DXF multi-storey applies the typical multiplier once, across storeys', () => {
  const entry = CORPUS.find((item) => item.variant === 'multi-storey');
  const application = sync();
  const project = application.createProject({ name: 'Conformance multi-storey' });
  const building = application.createBuilding({ projectId: project.id, name: 'Block' });
  for (const storeyDefinition of entry.storeys) {
    const storey = application.createStorey({ buildingId: building.id, name: storeyDefinition.name });
    const source = application.createSourceDocument({
      filename: 'clean-plan.dxf', content: fixture('clean-plan.dxf'),
      projectId: project.id, buildingId: building.id, storeyId: storey.id,
      sourceSheet: `A-${storeyDefinition.name}`, typicalMultiplier: storeyDefinition.multiplier
    });
    application.startProcessing(source.id);
  }
  record(entry, 'clean-plan-v2', application.getProjectRollup(project.id));
});

test('vector PDF measures its native path region at the operator-supplied scale', async () => {
  const entry = CORPUS.find((item) => item.tier === 'pdf');
  const application = sync();
  const project = application.createProject({ name: 'Conformance PDF' });
  const source = application.createSourceDocument({ filename: entry.fixture, content: fixture(entry.fixture), projectId: project.id, sourceSheet: 'A-PDF' });
  let run = application.startProcessing(source.id);
  for (let attempt = 0; attempt < 200 && application.getRun(run.id).status !== 'awaiting_setup'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const inspected = application.getRun(run.id);
  application.confirmSourceSetup(run.id, { pages: inspected.pages.map((page) => ({ sourcePageId: page.sourcePageId, scale: { drawingUnitsPerMetre: entry.setup.drawingUnitsPerMetre }, selectedRegions: page.nativeRegionIds })) });
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(application.getRun(run.id).status); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const completed = application.getRun(run.id);
  assert.equal(completed.status, 'completed', completed.error || '');
  record(entry, 'clean-plan-v2', completed.boq);
  assert.equal(completed.boq.sourceObjects[0].coordinateSpace, 'pdf-page');
});

test('raster measures only what a human calibrated and traced', async () => {
  const entry = CORPUS.find((item) => item.tier === 'raster');
  const application = sync();
  const project = application.createProject({ name: 'Conformance raster' });
  const source = application.createSourceDocument({ filename: entry.fixture, content: fixture(entry.fixture), projectId: project.id, sourceSheet: 'A-PNG' });
  const run = application.startProcessing(source.id);
  for (let attempt = 0; attempt < 200 && application.getRun(run.id).status !== 'awaiting_calibration'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  application.calibrateRasterPage(run.id, 'page_1', entry.calibration);
  const created = application.createRasterRegion(run.id, 'page_1', entry.region);
  application.confirmRasterRegion(run.id, 'page_1', created.region.id);
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(application.getRun(run.id).status); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const completed = application.getRun(run.id);
  assert.equal(completed.status, 'completed', completed.error || '');
  record(entry, 'clean-plan-v2', completed.boq);
  assert.equal(completed.boq.sourceObjects[0].geometrySource, 'human-traced');
});

test('a rollup spanning three source documents sums only what each tier can measure', async () => {
  const entry = CORPUS.find((item) => item.tier === 'rollup');
  const application = sync();
  const project = application.createProject({ name: 'Conformance rollup' });
  const building = application.createBuilding({ projectId: project.id, name: 'Block' });
  const storey = application.createStorey({ buildingId: building.id, name: 'Ground' });
  const scope = { projectId: project.id, buildingId: building.id, storeyId: storey.id };

  const dxf = application.createSourceDocument({ filename: 'clean-plan.dxf', content: fixture('clean-plan.dxf'), ...scope, sourceSheet: 'A-DXF' });
  application.startProcessing(dxf.id);

  const pdf = application.createSourceDocument({ filename: 'vector-plan.pdf', content: fixture('vector-plan.pdf'), ...scope, sourceSheet: 'A-PDF' });
  const pdfRun = application.startProcessing(pdf.id);
  for (let attempt = 0; attempt < 200 && application.getRun(pdfRun.id).status !== 'awaiting_setup'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const pdfState = application.getRun(pdfRun.id);
  application.confirmSourceSetup(pdfRun.id, { pages: pdfState.pages.map((page) => ({ sourcePageId: page.sourcePageId, scale: { drawingUnitsPerMetre: 100 }, selectedRegions: page.nativeRegionIds })) });
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(application.getRun(pdfRun.id).status); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  const png = application.createSourceDocument({ filename: 'raster-200x100.png', content: fixture('raster-200x100.png'), ...scope, sourceSheet: 'A-PNG' });
  const rasterRun = application.startProcessing(png.id);
  for (let attempt = 0; attempt < 200 && application.getRun(rasterRun.id).status !== 'awaiting_calibration'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  application.calibrateRasterPage(rasterRun.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const region = application.createRasterRegion(rasterRun.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' });
  application.confirmRasterRegion(rasterRun.id, 'page_1', region.region.id);
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(application.getRun(rasterRun.id).status); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  record(entry, 'clean-plan-v2', application.getProjectRollup(project.id));
});

test('every adversarial fixture produces its expected behaviour', () => {
  for (const entry of ADVERSARIAL) {
    const name = entry.fixture;
    if (entry.expect === 'halt') {
      let error = null;
      try { measureDxfFixture(name, 'clean-plan-v2'); } catch (caught) { error = caught; }
      assert.ok(error instanceof InputError, `${name} must halt: ${entry.description}`);
      assert.match(error.message.toLowerCase(), new RegExp(entry.reason), `${name} explains itself`);
      ledger.record({ fixture: name, rulesetVersion: 'clean-plan-v2', assumptionsVersion: DEFAULT_ASSUMPTIONS_VERSION, measurement: '(halted at boundary)', expectedStatus: 'halted', line: { measurementStatus: 'halted', quantity: null, confidence: { level: 'LOW' } }, gated: true });
      continue;
    }
    const boq = measureDxfFixture(name, 'clean-plan-v2');
    const gated = boq.lines.some((line) => line.measurementStatus === 'not_measurable');
    for (const measurement of entry.notMeasurable || []) {
      const line = lineOf(boq, measurement);
      assert.equal(line.measurementStatus, 'not_measurable', `${name}: ${measurement} must degrade, not guess`);
      assert.equal(line.quantity, 0, `${name}: ${measurement} must not present a number`);
      ledger.record({ fixture: name, rulesetVersion: 'clean-plan-v2', assumptionsVersion: DEFAULT_ASSUMPTIONS_VERSION, measurement, expectedStatus: 'not_measurable', line, gated });
    }
    for (const [measurement, value] of Object.entries(entry.surviving || {})) {
      const line = lineOf(boq, measurement);
      assert.equal(line.quantity, value, `${name}: ${measurement} should survive on evidence that is still intact`);
      ledger.record({ fixture: name, rulesetVersion: 'clean-plan-v2', assumptionsVersion: DEFAULT_ASSUMPTIONS_VERSION, measurement, expectedQuantity: value, line, gated });
    }
    for (const measurement of entry.expect === 'flagged' ? entry.measurements : []) {
      const line = lineOf(boq, measurement);
      assert.equal(line.provenance.plausibility?.flagged, true, `${name}: ${measurement} must be flagged as ${entry.flag}`);
      ledger.record({ fixture: name, rulesetVersion: 'clean-plan-v2', assumptionsVersion: DEFAULT_ASSUMPTIONS_VERSION, measurement, expectedQuantity: null, line, gated });
    }
    if (entry.minimumUnclassified) {
      assert.ok(boq.unclassified.length >= entry.minimumUnclassified,
        `${name}: expected at least ${entry.minimumUnclassified} unclassified entries, got ${boq.unclassified.length}`);
    }
  }
});

test('the ledger reports zero unflagged financial errors across the corpus', () => {
  const summary = ledger.summary();
  assert.ok(summary.observations > 0, 'the corpus actually ran');
  assert.equal(summary.counts[DISQUALIFYING], 0,
    `unflagged financial errors are disqualifying:\n${JSON.stringify(summary.offenders, null, 2)}`);
  assert.equal(summary.counts.confidently_wrong, 0,
    `confidently wrong results:\n${JSON.stringify(summary.offenders, null, 2)}`);
  assert.equal(summary.gate.passed, true);
  assert.equal(summary.accuracy, undefined, 'no headline accuracy percentage is emitted');
});

after(() => {
  // The summary artefact: emitted every run, next to the suite output.
  const summary = ledger.summary();
  mkdirSync(`${__dirname}/../.conformance`, { recursive: true });
  writeFileSync(`${__dirname}/../.conformance/ledger.json`, `${JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2)}\n`);
  console.log(`\n${ledger.format()}\n`);
});
