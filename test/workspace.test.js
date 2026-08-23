const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { createRepository } = require('../src/repository');
const { fitViewport, signedBreakdown, tierOfContribution } = require('../src/workspace');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);
const png = readFileSync(`${__dirname}/fixtures/raster-200x100.png`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });

function oneStorey(options = {}) {
  const application = sync(options);
  const project = application.createProject({ name: 'Workspace project' });
  const building = application.createBuilding({ projectId: project.id, name: 'Block A' });
  const storey = application.createStorey({ buildingId: building.id, name: 'Ground' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: storey.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  application.startProcessing(source.id);
  return { application, project, building, storey };
}

test('a fitted viewport contains every source object it was given', () => {
  const objects = [
    { sourceObjectId: 'a', bounds: [0, 0, 100, 50] },
    { sourceObjectId: 'b', bounds: [-40, 20, 10, 300] }
  ];
  const viewport = fitViewport(objects);
  assert.ok(viewport.minX <= -40 && viewport.minY <= 0 && viewport.maxX >= 100 && viewport.maxY >= 300);
  assert.ok(viewport.width > 0 && viewport.height > 0);
  assert.equal(viewport.objectCount, 2);
});

test('a single point-bounds object still yields a usable viewport, never a zero-area rectangle', () => {
  // an INSERT whose block had no definition resolves to a point
  const viewport = fitViewport([{ sourceObjectId: 'p', bounds: [2000, 3000, 2000, 3000] }]);
  assert.ok(viewport.width > 0, `width ${viewport.width}`);
  assert.ok(viewport.height > 0, `height ${viewport.height}`);
  assert.ok(viewport.minX < 2000 && viewport.maxX > 2000, 'it is centred on the point');
  assert.equal(viewport.degenerate, true, 'and says the extent was invented for viewing, not measured');
});

test('no objects yields no viewport rather than an empty rectangle', () => {
  const viewport = fitViewport([]);
  assert.equal(viewport, null);
});

test('line to evidence returns navigation, objects, signs and a viewport in one call', () => {
  const { application, project, building, storey } = oneStorey();
  const evidence = application.getLineEvidence(project.id, 'wall_plaster');
  assert.equal(evidence.measurement, 'wall_plaster');
  assert.equal(evidence.navigate.buildingId, building.id);
  assert.equal(evidence.navigate.storeyId, storey.id);
  assert.equal(evidence.navigate.sheetId, 'A-PLAN');
  assert.ok(evidence.sourceObjects.length > 0);
  for (const object of evidence.sourceObjects) {
    for (const field of ['bounds', 'geometrySource', 'coordinateSpace']) {
      assert.ok(object[field] !== undefined, `object carries ${field}`);
    }
  }
  for (const contribution of evidence.contributions) {
    assert.ok(['add', 'deduct'].includes(contribution.sign));
    assert.ok(contribution.sourceObjectId);
  }
  assert.ok(evidence.viewport, 'a viewport was computed server-side');
});

test('the viewport contains every source object of the line', () => {
  const { application, project } = oneStorey();
  const evidence = application.getLineEvidence(project.id, 'wall_plaster');
  for (const object of evidence.sourceObjects) {
    const [minX, minY, maxX, maxY] = object.bounds;
    assert.ok(minX >= evidence.viewport.minX && maxX <= evidence.viewport.maxX, `${object.sourceObjectId} fits horizontally`);
    assert.ok(minY >= evidence.viewport.minY && maxY <= evidence.viewport.maxY, `${object.sourceObjectId} fits vertically`);
  }
});

test('a line spanning two storeys says so rather than picking one', () => {
  const application = sync();
  const project = application.createProject({ name: 'Two storeys' });
  const building = application.createBuilding({ projectId: project.id, name: 'Block A' });
  const ground = application.createStorey({ buildingId: building.id, name: 'Ground' });
  const first = application.createStorey({ buildingId: building.id, name: 'First' });
  for (const [storey, sheet] of [[ground, 'A-GROUND'], [first, 'A-FIRST']]) {
    const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: storey.id, sourceSheet: sheet, studioId: 'studio_alpha' });
    application.startProcessing(source.id);
  }
  const evidence = application.getLineEvidence(project.id, 'floor_area');
  assert.equal(evidence.spansMultiple, true);
  assert.deepEqual(evidence.spans.storeyIds.sort(), [ground.id, first.id].sort());
  assert.equal(evidence.spans.sheetIds.length, 2);
  assert.equal(evidence.navigate.storeyId, null, 'no single storey is silently chosen');
  assert.match(evidence.spans.note, /more than one/i);
  assert.equal(evidence.viewportsByStorey.length, 2, 'a viewport per storey, since one rectangle cannot span them');
});

test('object to lines is the exact inverse of line to objects, signs included', () => {
  const { application, project } = oneStorey();
  const forward = new Map();
  for (const line of application.getProjectRollup(project.id).lines) {
    for (const contribution of line.provenance.contributions) {
      const key = `${contribution.sourceObjectId}|${line.measurement}|${contribution.sign}`;
      forward.set(key, (forward.get(key) || 0) + 1);
    }
  }
  const reverse = new Map();
  const objectIds = [...new Set(application.getProjectRollup(project.id).sourceObjects.map((object) => object.sourceObjectId))];
  for (const objectId of objectIds) {
    for (const line of application.getObjectLines(project.id, objectId).lines) {
      for (const contribution of line.contributions) {
        const key = `${objectId}|${line.measurement}|${contribution.sign}`;
        reverse.set(key, (reverse.get(key) || 0) + 1);
      }
    }
  }
  assert.deepEqual([...reverse.entries()].sort(), [...forward.entries()].sort(), 'the two directions agree exactly');
});

test('object to lines tells an architect what one wall costs them', () => {
  const { application, project } = oneStorey();
  const rollup = application.getProjectRollup(project.id);
  const wallLine = rollup.lines.find((line) => line.measurement === 'wall_plaster');
  const wallObjectId = wallLine.provenance.contributions.find((contribution) => contribution.sign === 'add').sourceObjectId;
  const result = application.getObjectLines(project.id, wallObjectId);
  assert.ok(result.object, 'the object itself is returned');
  assert.ok(result.lines.length >= 3, 'a wall hatch drives plan, masonry and plaster');
  assert.ok(result.lines.every((line) => line.contributions.every((contribution) => ['add', 'deduct'].includes(contribution.sign))));
  assert.equal(result.lines.some((line) => line.measurement === 'wall_plaster'), true);
});

test('an unknown object is reported, not silently empty', () => {
  const { application, project } = oneStorey();
  assert.throws(() => application.getObjectLines(project.id, 'no_such_object'), /not found/i);
});

test('the signed breakdown reconciles: gross minus deductions equals the reported quantity', () => {
  const { application, project } = oneStorey();
  const line = application.getProjectRollup(project.id).lines.find((candidate) => candidate.measurement === 'wall_plaster');
  const breakdown = signedBreakdown(line);
  assert.equal(breakdown.deductions.length, 4, 'two doors and two windows');
  assert.ok(breakdown.gross > breakdown.net);
  assert.equal(Number((breakdown.gross - breakdown.deductionTotal).toFixed(6)), Number(breakdown.net.toFixed(6)));
  assert.equal(Number(breakdown.net.toFixed(6)), Number(line.quantity.toFixed(6)), 'net is the number on the BOQ');
  assert.equal(breakdown.gross, 157.2);
  assert.equal(Number(breakdown.deductionTotal.toFixed(2)), 13.41);
  assert.equal(breakdown.net, 143.79);
});

test('each deduction says which rule made it and against which object', () => {
  const { application, project } = oneStorey();
  const breakdown = application.getLineEvidence(project.id, 'wall_plaster').breakdown;
  for (const deduction of breakdown.deductions) {
    assert.ok(deduction.sourceObjectId);
    assert.ok(deduction.ruleId, 'the rule that subtracted it');
    assert.ok(deduction.quantity > 0, 'a deduction carries a positive magnitude and a deduct sign');
  }
});

test('a line with no deductions reports an empty deduction list, not a missing one', () => {
  const { application, project } = oneStorey();
  const breakdown = application.getLineEvidence(project.id, 'floor_area').breakdown;
  assert.deepEqual(breakdown.deductions, []);
  assert.equal(breakdown.deductionTotal, 0);
  assert.equal(breakdown.gross, breakdown.net);
});

test('a mixed-tier line reports per-contribution tiers, not just the weakest', () => {
  const application = sync();
  const project = application.createProject({ name: 'Mixed' });
  const building = application.createBuilding({ projectId: project.id, name: 'Block A' });
  const storey = application.createStorey({ buildingId: building.id, name: 'Ground' });
  const scope = { projectId: project.id, buildingId: building.id, storeyId: storey.id, studioId: 'studio_alpha' };
  application.startProcessing(application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, ...scope, sourceSheet: 'A-DXF' }).id);
  const rasterRun = application.startProcessing(application.createSourceDocument({ filename: 'plan.png', content: png, ...scope, sourceSheet: 'A-PNG' }).id);
  application.calibrateRasterPage(rasterRun.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const region = application.createRasterRegion(rasterRun.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' });
  application.confirmRasterRegion(rasterRun.id, 'page_1', region.region.id);

  const evidence = application.getLineEvidence(project.id, 'floor_area');
  assert.equal(evidence.tier.tier, 'C', 'the line is reported at its weakest tier');
  const tiers = new Set(evidence.contributions.map((contribution) => contribution.tier));
  assert.deepEqual([...tiers].sort(), ['A', 'C'], 'but each contribution says which tier it came from');
  assert.equal(evidence.tierBreakdown.A.count > 0 && evidence.tierBreakdown.C.count > 0, true);
  assert.ok(evidence.tierBreakdown.A.quantity > 0 && evidence.tierBreakdown.C.quantity > 0,
    'so a Tier C line is visibly part measured and part traced');
});

test('queue traversal carries evidence in the same shape and is bounded in queries', () => {
  const repository = createRepository({});
  const application = sync({ repository });
  const project = application.createProject({ name: 'Queue project' });
  const source = application.createSourceDocument({ filename: 'residual-blocks.dxf', content: readFileSync(`${__dirname}/fixtures/residual-blocks.dxf`), projectId: project.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  application.startProcessing(source.id);
  const queue = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  assert.ok(queue.groups.length > 1, `there is something to traverse (${queue.groups.length} groups)`);

  const first = repository.measureQueries(() => application.getQueueStep(project.id, { index: 0, on: '2026-06-01' }));
  const later = repository.measureQueries(() => application.getQueueStep(project.id, { index: queue.groups.length - 1, on: '2026-06-01' }));
  assert.equal(first.queries, later.queries, `traversal must not reload the tree per step (${first.queries} vs ${later.queries})`);

  const step = first.result;
  assert.equal(step.index, 0);
  assert.equal(step.total, queue.groups.length);
  assert.equal(step.hasNext, true);
  assert.equal(step.hasPrevious, false);
  assert.ok(step.exception, 'the exception itself');
  if (step.evidence) {
    assert.ok(step.evidence.viewport !== undefined, 'evidence is the same shape as line evidence');
    assert.ok(Array.isArray(step.evidence.sourceObjects));
  }
});

test('queue traversal is bounded no matter how many exceptions there are', () => {
  const repository = createRepository({});
  const application = sync({ repository });
  const project = application.createProject({ name: 'Wide queue' });
  const building = application.createBuilding({ projectId: project.id, name: 'B' });
  const counts = [];
  for (const target of [2, 10]) {
    while (application.getProject(project.id).buildings[0].storeys.length < target) {
      const index = application.getProject(project.id).buildings[0].storeys.length;
      const storey = application.createStorey({ buildingId: building.id, name: `S${index}` });
      const source = application.createSourceDocument({ filename: 'p.dxf', content: readFileSync(`${__dirname}/fixtures/residual-blocks.dxf`), projectId: project.id, buildingId: building.id, storeyId: storey.id, sourceSheet: `A-${index}`, studioId: 'studio_alpha' });
      application.startProcessing(source.id);
    }
    counts.push(repository.measureQueries(() => application.getQueueStep(project.id, { index: 0, on: '2026-06-01' })).queries);
  }
  assert.equal(counts[0], counts[1], `queue step cost must not grow with the queue (${counts.join(' vs ')})`);
  repository.close();
});
