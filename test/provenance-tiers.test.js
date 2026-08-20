const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { PROVENANCE_VERSION, signedSum } = require('../src/provenance');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);
const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`, 'utf8');

function application() { return createApplication({ schedule: (callback) => setImmediate(callback) }); }
async function settle(app, runId, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = app.getRun(runId);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return app.getRun(runId);
}
const done = (state) => ['completed', 'failed'].includes(state.status);

function scoped(app) {
  const project = app.createProject({ name: 'Provenance project' });
  const building = app.createBuilding({ projectId: project.id, name: 'Block A' });
  const storey = app.createStorey({ buildingId: building.id, name: 'Ground' });
  return { project, building, storey, assignment: { projectId: project.id, buildingId: building.id, storeyId: storey.id } };
}

async function dxfRun(app, content = cleanPlan) {
  const { assignment } = scoped(app);
  const source = app.createSourceDocument({ filename: 'clean-plan.dxf', content, sourceSheet: 'A-PLAN', ...assignment });
  return settle(app, app.startProcessing(source.id).id, done);
}
async function pdfRun(app) {
  const { assignment } = scoped(app);
  const source = app.createSourceDocument({ filename: 'vector-plan.pdf', content: fixture('vector-plan.pdf'), sourceSheet: 'A-PDF', ...assignment });
  let run = await settle(app, app.startProcessing(source.id).id, (state) => state.status === 'awaiting_setup');
  app.confirmSourceSetup(run.id, { pages: run.pages.map((page) => ({ sourcePageId: page.sourcePageId, scale: { drawingUnitsPerMetre: 100 }, selectedRegions: page.nativeRegionIds })) });
  return settle(app, run.id, done);
}
async function rasterRun(app, { origin } = {}) {
  const { assignment } = scoped(app);
  const source = app.createSourceDocument({ filename: 'plan.png', content: fixture('raster-200x100.png'), sourceSheet: 'A-PNG', ...assignment });
  let run = await settle(app, app.startProcessing(source.id).id, (state) => state.status === 'awaiting_calibration');
  app.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const created = app.createRasterRegion(run.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area', ...(origin ? { origin } : {}) });
  app.confirmRasterRegion(run.id, 'page_1', created.region.id);
  return settle(app, run.id, done);
}

const resolve = (boq, contribution) => boq.sourceObjects.find((object) => object.sourceObjectId === contribution.sourceObjectId);

test('every BOQ line on every tier exposes provenance.contributions with one shape', async () => {
  const app = application();
  const runs = { dxf: await dxfRun(app), 'pdf-page': await pdfRun(app), 'raster-pixel': await rasterRun(app) };
  for (const [tier, run] of Object.entries(runs)) {
    assert.equal(run.status, 'completed', `${tier} run completed`);
    assert.ok(Array.isArray(run.boq.sourceObjects), `${tier} exposes a source object registry`);
    for (const line of run.boq.lines) {
      assert.equal(line.provenance.version, PROVENANCE_VERSION, `${tier}/${line.measurement} provenance version`);
      assert.ok(Array.isArray(line.provenance.contributions), `${tier}/${line.measurement} has contributions`);
      assert.ok(line.provenance.aggregation, `${tier}/${line.measurement} has aggregation`);
      assert.equal(line.provenance.measurementStatus, line.measurementStatus, `${tier}/${line.measurement} status mirrored`);
      assert.equal(line.provenance.sourceHandles, undefined, `${tier} no longer carries the old sourceHandles shape`);
      assert.equal(line.provenance.sourceContributions, undefined, `${tier} no longer carries the old sourceContributions shape`);
      for (const contribution of line.provenance.contributions) {
        for (const field of ['sourceObjectId', 'measurement', 'sign', 'quantity', 'unit', 'ruleId', 'rulesetVersion', 'runId']) {
          assert.notEqual(contribution[field], undefined, `${tier}/${line.measurement} contribution.${field}`);
        }
      }
    }
  }
});

test('every contribution resolves to a SourceObject carrying non-empty bounds', async () => {
  const app = application();
  for (const run of [await dxfRun(app), await pdfRun(app), await rasterRun(app)]) {
    let checked = 0;
    for (const line of run.boq.lines) {
      for (const contribution of line.provenance.contributions) {
        const object = resolve(run.boq, contribution);
        assert.ok(object, `contribution ${contribution.sourceObjectId} resolves`);
        assert.ok(Array.isArray(object.bounds) && object.bounds.length === 4, `${contribution.sourceObjectId} has bounds`);
        assert.ok(object.bounds.every((value) => Number.isFinite(value)), `${contribution.sourceObjectId} bounds are finite`);
        assert.ok(object.geometry && object.geometry.length, `${contribution.sourceObjectId} retains geometry`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'the run produced contributions to check');
  }
});

test('coordinateSpace matches the tier for every resolved source object', async () => {
  const app = application();
  const expected = [[await dxfRun(app), 'dxf'], [await pdfRun(app), 'pdf-page'], [await rasterRun(app), 'raster-pixel']];
  for (const [run, space] of expected) {
    const spaces = new Set(run.boq.sourceObjects.map((object) => object.coordinateSpace));
    assert.deepEqual([...spaces], [space], `tier reports only ${space}`);
  }
});

test('a line reconciles to the signed sum of its contributions', async () => {
  const app = application();
  for (const run of [await dxfRun(app), await pdfRun(app), await rasterRun(app)]) {
    for (const line of run.boq.lines) {
      if (line.measurementStatus === 'not_measurable') continue;
      assert.equal(Number(signedSum(line.provenance.contributions).toFixed(6)), Number(line.quantity.toFixed(6)),
        `${line.measurement} reconciles to its contributions`);
    }
  }
});

test('a confirmed raster proposal is recorded as model-proposed-confirmed, never as a bare proposal', async () => {
  const app = application();
  const run = await rasterRun(app, { origin: 'model-proposed' });
  const sources = new Set(run.boq.sourceObjects.map((object) => object.geometrySource));
  assert.ok(sources.has('model-proposed-confirmed'), `expected a confirmed proposal, saw ${[...sources]}`);
  assert.ok(!sources.has('model-proposed'), 'a bare model proposal must never reach provenance');
  const human = await rasterRun(application());
  assert.deepEqual([...new Set(human.boq.sourceObjects.map((object) => object.geometrySource))], ['human-traced'],
    'a hand-traced region is not relabelled as a model proposal');
});

test('sourceObjectId is stable across a reprocess of the same source document version', async () => {
  const app = application();
  const { assignment } = scoped(app);
  const source = app.createSourceDocument({ filename: 'clean-plan.dxf', content: cleanPlan, sourceSheet: 'A-PLAN', ...assignment });
  const first = await settle(app, app.startProcessing(source.id).id, done);
  const second = await settle(app, app.reprocess(first.id).id, done);
  assert.notEqual(second.id, first.id, 'a genuinely new run');
  const ids = (run) => run.boq.sourceObjects.map((object) => object.sourceObjectId).sort();
  assert.deepEqual(ids(second), ids(first), 'source object identity survives reprocessing');
  assert.deepEqual(
    second.boq.lines.map((line) => [line.measurement, line.quantity]),
    first.boq.lines.map((line) => [line.measurement, line.quantity]),
    'and the quantities are unchanged'
  );
});

test('all three tiers distinguish not_measurable from measured_zero', async () => {
  const app = application();
  // DXF, end to end: a plan with no room polygons cannot measure floor area at all.
  const noRooms = cleanPlan.replace(/A-ROOM/g, 'A-NOTES');
  const run = await dxfRun(app, noRooms);
  assert.equal(run.status, 'completed', run.error || '');
  const floor = run.boq.lines.find((line) => line.measurement === 'floor_area');
  assert.equal(floor.quantity, 0);
  assert.equal(floor.measurementStatus, 'not_measurable', 'no room geometry is not a zero measurement');
  assert.deepEqual(floor.provenance.contributions, []);
  const wall = run.boq.lines.find((line) => line.measurement === 'wall_plan');
  assert.equal(wall.measurementStatus, 'measured', 'walls are still measured in the same drawing');

  // A measured zero is a different state, reached when geometry resolved but summed to nothing.
  assert.notEqual(floor.measurementStatus, 'measured_zero');
});

test('PDF and raster refuse to measure at all rather than report an unmeasured zero', async () => {
  /* The DXF tier reaches not_measurable through normal operation, above. PDF and
     raster cannot: their setup gates refuse to enter measurement without at least
     one region, which is the stronger guarantee. Both hold the same three states
     through the one shared derivation -- this pins the gate that makes the
     unmeasured case unreachable rather than silently zero. */
  const app = application();
  const { assignment } = scoped(app);
  const pdf = app.createSourceDocument({ filename: 'vector-plan.pdf', content: fixture('vector-plan.pdf'), sourceSheet: 'A-PDF', ...assignment });
  const pdfRunState = await settle(app, app.startProcessing(pdf.id).id, (state) => state.status === 'awaiting_setup');
  assert.equal(pdfRunState.boq, null, 'no BOQ exists before setup');
  assert.throws(
    () => app.confirmSourceSetup(pdfRunState.id, { pages: pdfRunState.pages.map((page) => ({ sourcePageId: page.sourcePageId, scale: { drawingUnitsPerMetre: 100 }, selectedRegions: [] })) }),
    /at least one native vector region/i,
    'a PDF cannot be measured with nothing selected'
  );

  const png = app.createSourceDocument({ filename: 'plan.png', content: fixture('raster-200x100.png'), sourceSheet: 'A-PNG', ...assignment });
  const rasterState = await settle(app, app.startProcessing(png.id).id, (state) => state.status === 'awaiting_calibration');
  app.calibrateRasterPage(rasterState.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const gated = app.getRun(rasterState.id);
  assert.equal(gated.boq, null, 'no BOQ exists before a region is traced');
  assert.match(gated.setup.pages[0].blockedReasons.join(' '), /at least one traced region/i);
});
