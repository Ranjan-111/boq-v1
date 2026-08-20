const assert = require('node:assert/strict');

const objectFor = (carrier, contribution) => carrier.sourceObjects.find((object) => object.sourceObjectId === contribution.sourceObjectId);
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { createApplication } = require('../src/application');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`, 'utf8');

function workspace() {
  const application = createApplication({ schedule: (callback) => callback() });
  const project = application.createProject({ name: 'Multi-floor house' });
  const building = application.createBuilding({ projectId: project.id, name: 'Main building' });
  const ground = application.createStorey({ buildingId: building.id, name: 'Ground floor', level: 0 });
  const first = application.createStorey({ buildingId: building.id, name: 'First floor', level: 1 });
  return { application, project, building, ground, first };
}

test('project rollups isolate storey assignments and expose drill-down provenance', () => {
  const { application, project, building, ground, first } = workspace();
  const groundSource = application.createSourceDocument({ filename: 'ground.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id, sourceSheet: 'A-GROUND' });
  const firstSource = application.createSourceDocument({ filename: 'first.dxf', content: cleanPlan.replace('10A', '20A'), projectId: project.id, buildingId: building.id, storeyId: first.id, sourceSheet: 'A-FIRST', typicalMultiplier: 2 });
  application.startProcessing(groundSource.id);
  application.startProcessing(firstSource.id);

  const result = application.getProject(project.id);
  const groundArea = result.buildings[0].storeys.find((storey) => storey.id === ground.id).rollup.lines.find((line) => line.measurement === 'floor_area');
  const firstArea = result.buildings[0].storeys.find((storey) => storey.id === first.id).rollup.lines.find((line) => line.measurement === 'floor_area');
  const projectArea = result.rollup.lines.find((line) => line.measurement === 'floor_area');

  assert.equal(groundArea.quantity, 27.72);
  assert.equal(firstArea.quantity, 55.44);
  assert.equal(projectArea.quantity, 83.16);
  const firstRollup = result.buildings[0].storeys.find((storey) => storey.id === first.id).rollup;
  const firstObject = objectFor(firstRollup, firstArea.provenance.contributions[0]);
  assert.equal(firstObject.storeyId, first.id);
  assert.equal(firstArea.provenance.contributions[0].typicalMultiplier, 2);
});

test('distinct storey assignments remain distinct and reassignment is visible', () => {
  const { application, project, building, ground, first } = workspace();
  const firstUpload = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id });
  const duplicateUpload = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: first.id });
  application.startProcessing(firstUpload.id);
  application.startProcessing(duplicateUpload.id);

  let result = application.getProject(project.id);
  assert.equal(result.rollup.lines.find((line) => line.measurement === 'floor_area').quantity, 55.44);
  assert.equal(result.documentVersions.find((document) => document.id === duplicateUpload.id).version, 2);

  application.assignSourceDocument(duplicateUpload.id, { buildingId: building.id, storeyId: ground.id });
  result = application.getProject(project.id);
  assert.equal(result.buildings[0].storeys.find((storey) => storey.id === first.id).rollup.lines.length, 0);
  assert.equal(result.buildings[0].storeys.find((storey) => storey.id === ground.id).sourceDocuments.length, 2);
});

test('rollups select the latest revision of a source sheet without summing superseded revisions', () => {
  const { application, project, building, ground } = workspace();
  const revisionOne = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id, sourceSheet: 'A-PLAN' });
  application.startProcessing(revisionOne.id);
  const revisionTwo = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan.replace('10A', '30A'), projectId: project.id, buildingId: building.id, storeyId: ground.id, sourceSheet: 'A-PLAN' });
  application.startProcessing(revisionTwo.id);
  const rollup = application.getProject(project.id).rollup;
  assert.equal(rollup.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
  assert.deepEqual(rollup.sourceContributions.map((contribution) => contribution.sourceDocumentVersion), [2]);
});

test('assignment changes snapshot provenance, invalidate the old contribution, and start a replacement run', () => {
  const { application, project, building, ground, first } = workspace();
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id, typicalMultiplier: 1 });
  const oldRun = application.startProcessing(source.id);
  const reassigned = application.assignSourceToStorey(source.id, { storeyId: first.id, typicalMultiplier: 2 });
  const newRun = reassigned.processingRun;
  assert.equal(application.getRun(oldRun.id).superseded, true);
  assert.equal(application.getRun(oldRun.id).assignmentSnapshot.storeyId, ground.id);
  assert.equal(application.getRun(newRun.id).assignmentSnapshot.storeyId, first.id);
  assert.equal(application.getRun(newRun.id).assignmentSnapshot.typicalMultiplier, 2);
  assert.equal(application.getProject(project.id).rollup.lines.find((line) => line.measurement === 'floor_area').quantity, 55.44);
  assert.throws(() => application.reprocess(oldRun.id), /superseded/i);
});

test('a multiplier greater than one cannot be assigned without a storey', () => {
  const { application, project, building } = workspace();
  assert.throws(() => application.createSourceDocument({ filename: 'project-plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, typicalMultiplier: 2 }), /requires a storey/i);
});

test('run metadata matches the immutable DXF versions applied by inspection and measurement', () => {
  const { application, project, building, ground } = workspace();
  const source = application.createSourceDocument({ filename: 'versioned.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id });
  const run = application.startProcessing(source.id);
  assert.deepEqual(run.versions, run.boq.versions);
  assert.equal(run.units.version, run.versions.unitResolution);
  assert.equal(run.boq.ruleset, run.versions.ruleset);
});

test('explicit BOQ-version selection is snapshotted and propagated through nested rollups', () => {
  const { application, project, building, ground } = workspace();
  const firstVersion = project.currentBoqVersionId;
  const source = application.createSourceDocument({ filename: 'historical.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id, boqVersionId: firstVersion });
  const firstRun = application.startProcessing(source.id, { boqVersionId: firstVersion });
  const secondVersion = application.createBoqVersion({ projectId: project.id, label: 'Current BOQ' });
  const secondRun = application.startProcessing(source.id, { boqVersionId: secondVersion.id });

  assert.equal(firstRun.assignmentSnapshot.boqVersionId, firstVersion);
  assert.equal(secondRun.assignmentSnapshot.boqVersionId, secondVersion.id);
  const historical = application.getProject(project.id, { boqVersionId: firstVersion });
  assert.equal(historical.rollup.boqVersionId, firstVersion);
  assert.equal(historical.buildings[0].rollup.boqVersionId, firstVersion);
  assert.equal(historical.buildings[0].storeys[0].rollup.boqVersionId, firstVersion);
  assert.equal(historical.buildings[0].storeys[0].rollup.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
});

test('storey unit decisions remain source-local', () => {
  const { application, project, building, ground, first } = workspace();
  const millimetres = application.createSourceDocument({ filename: 'mm.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id });
  const centimetres = application.createSourceDocument({ filename: 'cm.dxf', content: cleanPlan.replace('70\n4\n', '70\n5\n'), projectId: project.id, buildingId: building.id, storeyId: first.id });
  const mmRun = application.startProcessing(millimetres.id);
  const cmRun = application.startProcessing(centimetres.id);
  assert.equal(application.getRun(mmRun.id).units.name, 'millimetres');
  assert.equal(application.getRun(cmRun.id).units.name, 'centimetres');
  const result = application.getProject(project.id);
  assert.equal(result.buildings[0].storeys.find((storey) => storey.id === ground.id).rollup.unitDecisions[0].decision.name, 'millimetres');
  assert.equal(result.buildings[0].storeys.find((storey) => storey.id === first.id).rollup.unitDecisions[0].decision.name, 'centimetres');
});

test('run presentation keeps processed assignment provenance separate from current source assignment', () => {
  const { application, project, building, ground, first } = workspace();
  const source = application.createSourceDocument({ filename: 'snapshot.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id });
  const oldRun = application.startProcessing(source.id);
  application.assignSourceToStorey(source.id, { storeyId: first.id });
  const historical = application.getRun(oldRun.id);
  assert.equal(historical.sourceDocument.storeyId, ground.id);
  assert.equal(historical.currentSourceDocument.storeyId, first.id);
});

test('processing cannot attach a BOQ version from another project', () => {
  const { application, project, building, ground } = workspace();
  const otherProject = application.createProject({ name: 'Other project' });
  const source = application.createSourceDocument({ filename: 'cross-project.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: ground.id });
  assert.throws(() => application.startProcessing(source.id, { boqVersionId: otherProject.currentBoqVersionId }), /does not belong/i);
});
