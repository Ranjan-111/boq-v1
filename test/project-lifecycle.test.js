const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApplication } = require('../src/application');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });
function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'boq-life-'));
  return { file: join(directory, 'p.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('projects can be listed, so a workspace is recoverable after a reload (T5)', () => {
  const application = sync();
  const first = application.createProject({ name: 'Anjali Residence' });
  const second = application.createProject({ name: 'Sharma Interiors' });
  const listed = application.getProjects();
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((p) => p.id).sort(), [first.id, second.id].sort());
  for (const entry of listed) {
    assert.ok(entry.name, 'each carries a name to show in a picker');
    assert.ok(entry.createdAt, 'and when it was created, so the list can be ordered');
  }
});

test('the project list survives a restart, so refreshing does not strand work (T5)', () => {
  const { file, cleanup } = tempFile();
  try {
    const first = sync({ file });
    const project = first.createProject({ name: 'Persisted' });
    const source = first.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, sourceSheet: 'A' });
    first.startProcessing(source.id);

    const reopened = sync({ file });
    const listed = reopened.getProjects();
    assert.equal(listed.length, 1, 'the project is still listed after a restart');
    assert.equal(listed[0].id, project.id);
    assert.equal(reopened.getProject(project.id).rollup.lines.length > 0, true, 'and its work is still there');
  } finally { cleanup(); }
});

test('the list reports whether a project has any drawings yet', () => {
  const application = sync();
  const empty = application.createProject({ name: 'Empty' });
  const used = application.createProject({ name: 'Used' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: used.id, sourceSheet: 'A' });
  application.startProcessing(source.id);
  const listed = application.getProjects();
  assert.equal(listed.find((p) => p.id === empty.id).sourceDocumentCount, 0);
  assert.equal(listed.find((p) => p.id === used.id).sourceDocumentCount, 1);
});

test('a project can be created without naming it, so upload is not gated on a name (T7)', () => {
  const application = sync();
  const project = application.createProject({});
  assert.ok(project.id, 'it exists');
  assert.ok(project.name, 'and carries a readable placeholder rather than an empty string');
  assert.equal(project.unnamed, true, 'flagged so the UI can prompt for a real name later');
});

test('an unnamed project can be named afterwards', () => {
  const application = sync();
  const project = application.createProject({});
  const renamed = application.renameProject(project.id, 'Anjali Residence');
  assert.equal(renamed.name, 'Anjali Residence');
  assert.equal(renamed.unnamed, false);
  assert.equal(application.getProjects().find((p) => p.id === project.id).name, 'Anjali Residence');
});

test('renaming refuses an empty name rather than blanking the project', () => {
  const application = sync();
  const project = application.createProject({ name: 'Real name' });
  assert.throws(() => application.renameProject(project.id, '   '), /name/i);
  assert.equal(application.getProject(project.id).name, 'Real name');
});
