const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApplication } = require('../src/application');
const { createRepository } = require('../src/repository');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`, 'utf8');
function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'boq-app-'));
  return { file: join(directory, 'boq.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const sync = (extra = {}) => createApplication({ schedule: (callback) => callback(), ...extra });

function seed(application) {
  const project = application.createProject({ name: 'Persisted project' });
  const building = application.createBuilding({ projectId: project.id, name: 'Main building' });
  const storey = application.createStorey({ buildingId: building.id, name: 'Ground floor', level: 0 });
  const source = application.createSourceDocument({ filename: 'clean-plan.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: storey.id, sourceSheet: 'A-GROUND' });
  const run = application.startProcessing(source.id);
  return { project, building, storey, source, run };
}

test('a completed run and its rollup survive a fresh application over the same file', () => {
  const { file, cleanup } = tempFile();
  try {
    const first = sync({ file });
    const { project, run } = seed(first);
    const before = first.getRun(run.id);
    const rollupBefore = first.getProjectRollup(project.id);
    assert.equal(before.status, 'completed');

    // a genuinely new application instance: nothing carried over in memory
    const second = sync({ file });
    const after = second.getRun(run.id);
    assert.equal(after.status, 'completed');
    assert.deepEqual(
      after.boq.lines.map((line) => [line.measurement, line.quantity, line.measurementStatus]),
      before.boq.lines.map((line) => [line.measurement, line.quantity, line.measurementStatus]),
      'quantities and statuses survive the restart'
    );
    assert.deepEqual(
      after.boq.sourceObjects.map((object) => [object.sourceObjectId, object.bounds]).sort(),
      before.boq.sourceObjects.map((object) => [object.sourceObjectId, object.bounds]).sort(),
      'source objects and their bounds survive the restart'
    );
    const rollupAfter = second.getProjectRollup(project.id);
    assert.deepEqual(rollupAfter.lines.map((line) => [line.measurement, line.quantity]), rollupBefore.lines.map((line) => [line.measurement, line.quantity]));
  } finally { cleanup(); }
});

test('the richer block-resolved bounds reach the store intact', () => {
  const { file, cleanup } = tempFile();
  try {
    const { run } = seed(sync({ file }));
    const reopened = sync({ file }).getRun(run.id);
    const objects = reopened.boq.sourceObjects;
    assert.equal(objects.length, 15);
    const degenerate = objects.filter((object) => object.bounds[0] === object.bounds[2] && object.bounds[1] === object.bounds[3]);
    assert.equal(degenerate.length, 0, 'no source object round-trips as a zero-area box');
    const door = objects.find((object) => object.nativeHandle === '10E');
    assert.equal(door.geometryResolution, 'block-definition');
    assert.deepEqual(door.bounds, [2000, 0, 2900, 50]);
    assert.ok(door.geometry.length >= 4, 'the polygon itself round-trips, not only its bounds');
  } finally { cleanup(); }
});

test('reassigning a source updates where its objects sit, despite objects being deduplicated', () => {
  const application = sync();
  const { project, building, storey, source } = seed(application);
  const storeyRollup = application.getProject(project.id).buildings[0].storeys[0].rollup;
  assert.ok(storeyRollup.sourceObjects.every((object) => object.storeyId === storey.id));

  application.assignSourceDocument(source.id, { projectId: project.id, buildingId: building.id, storeyId: null });
  const reassigned = application.getProject(project.id).buildings[0].rollup;
  assert.ok(reassigned.sourceObjects.length > 0, 'the building rollup still resolves objects');
  assert.ok(reassigned.sourceObjects.every((object) => object.storeyId === null), 'the stale storey assignment does not survive');
  assert.ok(reassigned.sourceObjects.every((object) => object.buildingId === building.id));
});

test('the audit trail records the run lifecycle and is readable back', () => {
  const { file, cleanup } = tempFile();
  try {
    const repository = createRepository({ file });
    const application = sync({ repository });
    const { source, run } = seed(application);
    const events = repository.listAudit();
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes('project_created'));
    assert.ok(kinds.includes('source_document_created'));
    assert.ok(kinds.includes('run_started'));
    assert.equal(events.filter((event) => event.kind === 'run_started')[0].subjectId, run.id);
    assert.equal(events.filter((event) => event.kind === 'source_document_created')[0].subjectId, source.id);
    repository.close();
  } finally { cleanup(); }
});

test('a rollup stays a bounded number of queries as contributing runs grow', () => {
  const repository = createRepository({});
  const application = sync({ repository });
  const project = application.createProject({ name: 'Wide project' });
  const building = application.createBuilding({ projectId: project.id, name: 'B' });
  const counts = [];
  for (const total of [2, 12]) {
    for (let index = 0; index < total; index += 1) {
      const storey = application.createStorey({ buildingId: building.id, name: `S${counts.length}-${index}` });
      const source = application.createSourceDocument({ filename: 'p.dxf', content: cleanPlan, projectId: project.id, buildingId: building.id, storeyId: storey.id, sourceSheet: `A-${counts.length}-${index}` });
      application.startProcessing(source.id);
    }
    counts.push(repository.measureQueries(() => application.getProjectRollup(project.id)).queries);
  }
  assert.equal(counts[0], counts[1], `rollup query count must not grow with contributing runs (${counts.join(' vs ')})`);
  repository.close();
});
