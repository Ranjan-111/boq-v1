const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { DEFAULT_RULESET_VERSION } = require('../src/rules');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`, 'utf8');
const sync = () => createApplication({ schedule: (callback) => callback() });

function workspace() {
  const application = sync();
  const project = application.createProject({ name: 'Assumption project' });
  const building = application.createBuilding({ projectId: project.id, name: 'B' });
  const storey = application.createStorey({ buildingId: building.id, name: 'G' });
  const source = application.createSourceDocument({ filename: 'clean-plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: storey.id, sourceSheet: 'A-PLAN' });
  const run = application.startProcessing(source.id);
  return { application, project, building, storey, source, run };
}
const rollupLine = (application, projectId, measurement) =>
  application.getProjectRollup(projectId).lines.find((line) => line.measurement === measurement);

test('a project exposes editable, versioned assumptions with defaults', () => {
  const { application, project } = workspace();
  const assumptions = application.getProjectAssumptions(project.id);
  assert.equal(assumptions.version, 1);
  assert.equal(assumptions.values.wallHeight, 3);
  assert.equal(assumptions.values.wallThickness, 0.23);
  assert.equal(assumptions.rulesetVersion, DEFAULT_RULESET_VERSION);
  assert.ok(assumptions.definitions.wallHeight.description, 'each assumption explains itself');
});

test('a run records the assumptions and ruleset it measured under', () => {
  const { application, run } = workspace();
  const state = application.getRun(run.id);
  assert.equal(state.rulesetVersion, DEFAULT_RULESET_VERSION);
  assert.equal(state.assumptions.version, 1);
  assert.equal(state.assumptions.values.wallHeight, 3);
  assert.equal(state.boq.ruleset, DEFAULT_RULESET_VERSION);
});

test('changing an assumption re-runs measurement and moves the dependent quantity', () => {
  const { application, project, run } = workspace();
  const before = rollupLine(application, project.id, 'wall_masonry').quantity;
  assert.equal(before, 18.078);

  const updated = application.updateProjectAssumptions(project.id, { values: { wallHeight: 3.5 }, reason: 'Client confirmed 3.5 m floor-to-soffit' });
  assert.equal(updated.version, 2, 'assumptions are versioned, not edited in place');

  const after = rollupLine(application, project.id, 'wall_masonry').quantity;
  assert.equal(after, 21.091, '6.026 m2 x 3.5 m');
  assert.notEqual(after, before);
  assert.equal(application.getRun(run.id).superseded, true, 'the run measured under the old assumption is superseded');
  assert.equal(rollupLine(application, project.id, 'wall_plan').quantity, 6.026, 'geometry-only lines are untouched');
});

test('an approval does not survive a changed assumption', () => {
  const { application, project } = workspace();
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  const approved = application.approveBoqVersion(boqVersionId, { approvedBy: 'quantity surveyor' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'quantity surveyor');
  assert.equal(approved.approvedAssumptionsVersion, 1);

  application.updateProjectAssumptions(project.id, { values: { wallHeight: 3.5 }, reason: 'revised' });

  const after = application.getBoqVersion(boqVersionId);
  assert.equal(after.status, 'stale', 'the approval cannot outlive the number it approved');
  assert.match(after.staleReason, /assumption/i);
  assert.equal(after.approvedBy, 'quantity surveyor', 'who approved it is still on the record');
});

test('an approval does not survive a changed ruleset either', () => {
  const { application, project } = workspace();
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  application.updateProjectAssumptions(project.id, { rulesetVersion: 'clean-plan-v1', reason: 'client measures gross' });
  const after = application.getBoqVersion(boqVersionId);
  assert.equal(after.status, 'stale');
  assert.match(after.staleReason, /ruleset/i);
});

test('selecting a different ruleset re-measures the same geometry to a different quantity', () => {
  const { application, project } = workspace();
  assert.equal(rollupLine(application, project.id, 'wall_plaster').quantity, 143.79, 'net under the current default');
  application.updateProjectAssumptions(project.id, { rulesetVersion: 'clean-plan-v1', reason: 'gross convention' });
  assert.equal(rollupLine(application, project.id, 'wall_plaster').quantity, 157.2, 'gross under the historical ruleset');
  application.updateProjectAssumptions(project.id, { rulesetVersion: 'clean-plan-v2-net-masonry', reason: 'net everything' });
  assert.equal(rollupLine(application, project.id, 'wall_plaster').quantity, 143.79);
  assert.equal(rollupLine(application, project.id, 'wall_masonry').quantity, 16.53585);
});

test('an unknown ruleset or assumption is refused rather than silently defaulted', () => {
  const { application, project } = workspace();
  assert.throws(() => application.updateProjectAssumptions(project.id, { rulesetVersion: 'invented' }), /Unknown ruleset/);
  assert.throws(() => application.updateProjectAssumptions(project.id, { values: { wallHeight: 0 } }), /between/);
  assert.throws(() => application.updateProjectAssumptions(project.id, { values: { madeUp: 4 } }), /Unknown assumption/);
  assert.equal(application.getProjectAssumptions(project.id).version, 1, 'a rejected change does not bump the version');
});

test('reprocessing with the same ruleset and assumptions is byte-identical', () => {
  const { application, run } = workspace();
  const first = application.getRun(run.id);
  const second = application.getRun(application.reprocess(run.id).id);
  assert.deepEqual(
    second.boq.lines.map((line) => [line.measurement, line.quantity, line.measurementStatus, line.provenance.contributions.map((entry) => [entry.sourceObjectId, entry.sign, entry.quantity])]),
    first.boq.lines.map((line) => [line.measurement, line.quantity, line.measurementStatus, line.provenance.contributions.map((entry) => [entry.sourceObjectId, entry.sign, entry.quantity])]),
    'same geometry, same rules, same assumptions - same evidence'
  );
});

test('the assumption change is on the audit trail with its reason', () => {
  const { application, project } = workspace();
  application.updateProjectAssumptions(project.id, { values: { wallHeight: 3.2 }, reason: 'site survey', updatedBy: 'lead' });
  const history = application.getProjectAssumptions(project.id).history;
  const latest = history.at(-1);
  assert.equal(latest.version, 2);
  assert.equal(latest.reason, 'site survey');
  assert.equal(latest.updatedBy, 'lead');
  assert.deepEqual(latest.changed, { wallHeight: { from: 3, to: 3.2 } });
});

test('a rollup does not launder an unmeasurable line into a smaller total', () => {
  const { application, project } = workspace();
  assert.equal(rollupLine(application, project.id, 'wall_plaster').measurementStatus, 'measured');
  application.updateProjectAssumptions(project.id, { values: { wallHeight: 0.5, doorOpeningHeight: 10, windowOpeningHeight: 10 }, reason: 'deliberately impossible' });
  const plaster = rollupLine(application, project.id, 'wall_plaster');
  assert.equal(plaster.measurementStatus, 'not_measurable', 'the rolled-up line inherits the impossibility');
  assert.equal(plaster.quantity, 0);
  assert.equal(rollupLine(application, project.id, 'wall_plan').measurementStatus, 'measured', 'other lines still roll up normally');
});
