const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');

const cleanPlan = readFileSync(__dirname + "/fixtures/clean-plan.dxf");
const sync = (options = {}) => createApplication({ schedule: (cb) => cb(), ...options });

function seed(app) {
  const project = app.createProject({ name: 'Rate test' });
  const source = app.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, sourceSheet: 'A', studioId: 'studio_alpha' });
  const run = app.getRun(app.startProcessing(source.id).id);
  return { project, run };
}
test('a measured drawing prices itself with no operator setup', () => {
  const application = sync();
  const { project } = seed(application);
  const priced = application.getPricedBoq(project.id);
  assert.equal(priced.status, 'priced', 'default rate book applies with no publishing step');
  const floor = priced.lines.find((l) => l.measurement === 'floor_area');
  assert.equal(floor.status, 'priced');
  assert.ok(Number.isFinite(floor.amount) && floor.amount > 0, 'real amount exists');
});
test('every exported row carries a rate and an amount from the default book', () => {
  const application = sync();
  const { project } = seed(application);
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  const result = application.exportBoq(boqVersionId, { format: 'csv' });
  const text = result.content.toString('utf8');
  const dataRows = text.split('\n').filter((row) => /^[A-Z]{3,}[,-]/.test(row));
  assert.ok(dataRows.length >= 8, "got " + dataRows.length + ": " + dataRows.join(" | "));
  for (const row of dataRows) {
    const cells = row.split(',');
    assert.ok(cells[4] !== '', 'rate present for ' + cells[0]);
    assert.ok(cells[5] !== '', 'amount present for ' + cells[0]);
  }
  assert.doesNotMatch(text, /INCOMPLETE/);
});
test('the default book is labelled indicative, never a quotation', () => {
  const application = sync();
  const { project } = seed(application);
  const priced = application.getPricedBoq(project.id);
  for (const line of priced.lines.filter((e) => e.status === 'priced')) {
    assert.match(line.rate.source.label, /indicative|default/i);
    assert.equal(line.rate.source.suppliedBy, 'system-default');
  }
});

test('a studio-published rate book overrides the default', () => {
  const application = sync();
  const { project } = seed(application);
  const before = application.getPricedBoq(project.id).lines.find((l) => l.measurement === 'floor_area').amount;
  application.publishRateBook(project.id, { studioId: 'studio_alpha', label: 'Our rates', currency: 'INR', source: { label: 'Studio historical', suppliedBy: 'lead' }, rates: [{ itemCode: 'FLOOR-FIN', unit: 'm2', amount: 5000, validFrom: '2026-01-01', validTo: '2026-12-31' }] });
  const after = application.getPricedBoq(project.id).lines.find((l) => l.measurement === 'floor_area').amount;
  assert.notEqual(after, before);
});