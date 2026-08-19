const { readFile } = require('node:fs/promises');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startOperatorApp } = require('../test-support/operator-app');

let app;
let baseUrl;

before(async () => {
  app = await startOperatorApp();
  baseUrl = app.baseUrl;
});

after(async () => {
  await app.close();
});

async function uploadCleanPlan() {
  const plan = await readFile(`${__dirname}/fixtures/clean-plan.dxf`);
  const form = new FormData();
  form.set('drawing', new Blob([plan], { type: 'application/dxf' }), 'clean-plan.dxf');
  const response = await fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
  assert.equal(response.status, 202);
  return response.json();
}

async function completedRun(runId) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(response.status, 200);
    const run = await response.json();
    if (run.status === 'completed') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('processing run did not complete');
}

test('operator can submit a clean DXF and review deterministic source-backed quantities', async () => {
  const submission = await uploadCleanPlan();

  assert.equal(submission.sourceDocument.version, 1);
  assert.match(submission.sourceDocument.id, /^src_/);
  assert.match(submission.processingRun.id, /^run_/);
  assert.equal(submission.processingRun.status, 'ingestion');

  const run = await completedRun(submission.processingRun.id);
  assert.deepEqual(run.stages.map((stage) => stage.name), ['ingestion', 'measurement', 'boq']);
  assert.ok(run.stages.every((stage) => stage.status === 'completed'));

  const lines = Object.fromEntries(run.boq.lines.map((line) => [line.measurement, line]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(lines).map(([measurement, line]) => [measurement, line.quantity])),
    {
      wall_plan: 6.026,
      wall_masonry: 18.078,
      wall_plaster: 157.2,
      floor_area: 27.72,
      skirting: 29.8,
      room_count: 2,
      door_count: 2,
      window_count: 2,
      furniture_count: 4
    }
  );
  assert.deepEqual(lines.floor_area.provenance.sourceHandles, ['10A', '10C']);
  assert.deepEqual(lines.door_count.provenance.sourceHandles, ['10E', '10F']);
  assert.equal(lines.wall_masonry.unit, 'm³');
  assert.equal(lines.wall_masonry.confidence.evidence.join(','), 'layer,hatch');
  assert.equal(lines.floor_area.measurementStatus, 'measured');
  assert.equal(lines.floor_area.provenance.sourceDocumentId, submission.sourceDocument.id);
});

test('operator can reprocess the same source and versions without changing quantities', async () => {
  const firstSubmission = await uploadCleanPlan();
  const firstRun = await completedRun(firstSubmission.processingRun.id);

  const response = await fetch(`${baseUrl}/api/runs/${firstRun.id}/reprocess`, { method: 'POST' });
  assert.equal(response.status, 202);
  const secondSubmission = await response.json();
  const secondRun = await completedRun(secondSubmission.processingRun.id);

  assert.equal(secondRun.sourceDocument.id, firstRun.sourceDocument.id);
  assert.deepEqual(secondRun.versions, firstRun.versions);
  assert.deepEqual(
    secondRun.boq.lines.map((line) => [line.measurement, line.quantity, line.provenance.sourceHandles]),
    firstRun.boq.lines.map((line) => [line.measurement, line.quantity, line.provenance.sourceHandles])
  );
});

test('operator interface provides DXF upload and a reviewable BOQ table', async () => {
  const response = await fetch(baseUrl);

  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Upload clean DXF/);
  assert.match(page, /Measurement status/);
  assert.match(page, /Provenance/);
});
