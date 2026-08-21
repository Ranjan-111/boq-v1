const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { coerceBoxes, RASTER_PROMPT } = require('../src/vision/contract');
const { createVisionService } = require('../src/vision');

const png = readFileSync(`${__dirname}/fixtures/raster-200x100.png`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });

/** A stub vision service: proposes boundaries without touching a network. */
function stubVision(boxes, { available = true } = {}) {
  return {
    available,
    async proposeLabel() { return { status: 'unavailable', label: null, category: null, model: null }; },
    async proposeRegions() { return { status: available ? 'proposed' : 'unavailable', boxes, model: 'stub-vision-1' }; }
  };
}

async function rasterRun(application) {
  const project = application.createProject({ name: 'Proposal project' });
  const source = application.createSourceDocument({ filename: 'plan.png', content: png, projectId: project.id, sourceSheet: 'A-PNG' });
  const run = application.startProcessing(source.id);
  for (let attempt = 0; attempt < 200 && application.getRun(run.id).status !== 'awaiting_calibration'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return { project, run: application.getRun(run.id) };
}

test('the raster prompt never asks for a scale', () => {
  assert.ok(!/scale|metre|meter|dimension|size in|calibrat|quantity|area in/i.test(RASTER_PROMPT), RASTER_PROMPT);
});

test('boundary boxes are accepted but any scale-like value in the reply is discarded', () => {
  const result = coerceBoxes({
    boxes: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.4, label: 'floor_area', pixelsPerMetre: 50, area: 18.2, price: 9000 }],
    scale: { drawingUnitsPerMetre: 100 }, calibration: { pixelsPerMetre: 50 }
  }, { imageWidth: 200, imageHeight: 100 });
  assert.equal(result.boxes.length, 1);
  const [box] = result.boxes;
  assert.deepEqual(Object.keys(box).sort(), ['height', 'label', 'width', 'x', 'y'], 'nothing scale-like survives');
  assert.equal(result.scale, undefined);
  assert.equal(result.calibration, undefined);
  assert.equal(JSON.stringify(result).includes('pixelsPerMetre'), false);
});

test('degenerate slivers are dropped by a fraction of image size, not an absolute pixel count', () => {
  const sliver = { x: 0.1, y: 0.1, width: 0.002, height: 0.4, label: 'floor_area' };
  const solid = { x: 0.2, y: 0.2, width: 0.5, height: 0.5, label: 'floor_area' };
  const small = coerceBoxes({ boxes: [sliver, solid] }, { imageWidth: 200, imageHeight: 100 });
  const large = coerceBoxes({ boxes: [sliver, solid] }, { imageWidth: 4000, imageHeight: 2000 });
  assert.equal(small.boxes.length, 1, 'the sliver is dropped on a small image');
  assert.equal(large.boxes.length, 1, 'and on a large one - the same relative threshold applies');
  assert.equal(small.dropped, 1);
  assert.equal(large.dropped, 1);
});

test('coordinates outside the image are rejected rather than clamped into fiction', () => {
  const result = coerceBoxes({ boxes: [
    { x: -0.5, y: 0.1, width: 0.4, height: 0.4, label: 'floor_area' },
    { x: 0.8, y: 0.8, width: 0.9, height: 0.9, label: 'floor_area' },
    { x: 0.1, y: 0.1, width: 0.5, height: 0.5, label: 'floor_area' }
  ] }, { imageWidth: 200, imageHeight: 100 });
  assert.equal(result.boxes.length, 1);
});

test('an unconfirmed proposal contributes nothing to any quantity', async () => {
  const application = sync({ vision: stubVision([{ x: 0.1, y: 0.1, width: 0.5, height: 0.5, label: 'floor_area' }]) });
  const { run } = await rasterRun(application);
  application.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const proposed = await application.proposeRasterRegions(run.id, 'page_1');
  assert.ok(proposed.regions.length > 0, 'a proposal was made');
  assert.equal(proposed.regions[0].lifecycle, 'proposed');

  const state = application.getRun(run.id);
  assert.equal(state.boq, null, 'no BOQ exists while a proposal is unconfirmed');
  assert.notEqual(state.status, 'completed');
  assert.match(state.setup.pages[0].blockedReasons.join(' '), /confirm/i, 'the run is blocked on confirmation');
});

test('a confirmed proposal is recorded as model-proposed-confirmed, never bare', async () => {
  const application = sync({ vision: stubVision([{ x: 0.1, y: 0.1, width: 0.5, height: 0.5, label: 'floor_area' }]) });
  const { run } = await rasterRun(application);
  application.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const proposed = await application.proposeRasterRegions(run.id, 'page_1');
  application.confirmRasterRegion(run.id, 'page_1', proposed.regions[0].id);
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(application.getRun(run.id).status); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));

  const completed = application.getRun(run.id);
  assert.equal(completed.status, 'completed', completed.error || '');
  const sources = new Set(completed.boq.sourceObjects.map((object) => object.geometrySource));
  assert.deepEqual([...sources], ['model-proposed-confirmed']);
  assert.ok(!sources.has('model-proposed'), 'a bare proposal never reaches provenance');
  assert.ok(completed.boq.lines.find((line) => line.measurement === 'floor_area').quantity > 0);
});

test('a proposal carries no quantity until a human supplies the scale', async () => {
  const application = sync({ vision: stubVision([{ x: 0.1, y: 0.1, width: 0.5, height: 0.5, label: 'floor_area' }]) });
  const { run } = await rasterRun(application);
  // no calibration yet: proposing must not be able to produce a measurement
  await assert.rejects(() => application.proposeRasterRegions(run.id, 'page_1'), /calibrat/i,
    'boundaries without a human scale cannot become a quantity');
});

test('confirming a proposal is a recorded human decision', async () => {
  const { createRepository } = require('../src/repository');
  const repository = createRepository({});
  const application = sync({ repository, vision: stubVision([{ x: 0.1, y: 0.1, width: 0.5, height: 0.5, label: 'floor_area' }]) });
  const { run } = await rasterRun(application);
  application.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const proposed = await application.proposeRasterRegions(run.id, 'page_1');
  application.confirmRasterRegion(run.id, 'page_1', proposed.regions[0].id, { confirmedBy: 'surveyor' });
  const kinds = repository.listAudit().map((event) => event.kind);
  assert.ok(kinds.includes('raster_regions_proposed'), 'the proposal is on the trail');
  assert.ok(kinds.includes('raster_region_confirmed'), 'and so is the human decision');
  const confirmation = repository.listAudit().find((event) => event.kind === 'raster_region_confirmed');
  assert.equal(confirmation.payload.origin, 'model-proposed', 'the trail records that a model proposed it');
  assert.equal(confirmation.payload.confirmedBy, 'surveyor');
  repository.close();
});

test('with no vision configured the raster workflow still completes by hand', async () => {
  const application = sync();
  assert.equal(application.visionAvailable(), false);
  const { run } = await rasterRun(application);
  application.calibrateRasterPage(run.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const proposal = await application.proposeRasterRegions(run.id, 'page_1');
  assert.equal(proposal.status, 'unavailable', 'the model is reported unavailable, not faked');
  assert.equal(proposal.regions.length, 0);
  const created = application.createRasterRegion(run.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' });
  application.confirmRasterRegion(run.id, 'page_1', created.region.id);
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(application.getRun(run.id).status); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const completed = application.getRun(run.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.boq.sourceObjects[0].geometrySource, 'human-traced');
});
