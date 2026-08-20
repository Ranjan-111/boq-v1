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

test('HTTP project workspace returns building/storey rollups with source drill-down provenance', async () => {
  const projectResponse = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HTTP multi-floor project' })
  });
  assert.equal(projectResponse.status, 201);
  const project = (await projectResponse.json()).project;
  const building = (await (await fetch(`${baseUrl}/api/projects/${project.id}/buildings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Main building' })
  })).json()).building;
  const storey = (await (await fetch(`${baseUrl}/api/buildings/${building.id}/storeys`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ground floor' })
  })).json()).storey;
  const plan = await readFile(`${__dirname}/fixtures/clean-plan.dxf`);
  const form = new FormData();
  form.set('drawing', new Blob([plan], { type: 'application/dxf' }), 'ground.dxf');
  form.set('storeyId', storey.id);
  form.set('typicalMultiplier', '2');
  const upload = await fetch(`${baseUrl}/api/projects/${project.id}/source-documents`, { method: 'POST', body: form });
  assert.equal(upload.status, 202);
  const submission = await upload.json();
  await completedRun(submission.processingRun.id);
  const result = await (await fetch(`${baseUrl}/api/projects/${project.id}`)).json();
  const floor = result.project.buildings[0].storeys[0].rollup.lines.find((line) => line.measurement === 'floor_area');
  assert.equal(floor.quantity, 55.44);
  assert.equal(floor.provenance.sourceContributions[0].sourceDocumentId, submission.sourceDocument.id);
  assert.equal(floor.provenance.sourceContributions[0].storeyId, storey.id);
});

test('HTTP mapping lifecycle applies an approved scoped decision with versioned provenance', async () => {
  const project = (await (await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'HTTP classification project' })
  })).json()).project;
  const invalid = await fetch(`${baseUrl}/api/projects/${project.id}/mappings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: {}, target: { category: 'seating' } })
  });
  assert.equal(invalid.status, 422);
  const draftResponse = await fetch(`${baseUrl}/api/projects/${project.id}/mappings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: { layerPattern: 'A-FURN', blockPattern: 'SOFA_3S' }, target: { category: 'seating', catalogItem: 'sofa' } })
  });
  assert.equal(draftResponse.status, 201);
  const draft = (await draftResponse.json()).mapping;
  const approval = await fetch(`${baseUrl}/api/mappings/${draft.id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Verified studio convention.' })
  });
  assert.equal(approval.status, 200);
  const approved = (await approval.json()).mapping;

  const plan = await readFile(`${__dirname}/fixtures/clean-plan.dxf`);
  const form = new FormData();
  form.set('drawing', new Blob([plan], { type: 'application/dxf' }), 'mapped.dxf');
  const upload = await fetch(`${baseUrl}/api/projects/${project.id}/source-documents`, { method: 'POST', body: form });
  assert.equal(upload.status, 202);
  const submission = await upload.json();
  await completedRun(submission.processingRun.id);
  const classificationsResponse = await fetch(`${baseUrl}/api/runs/${submission.processingRun.id}/classifications`);
  assert.equal(classificationsResponse.status, 200);
  const result = await classificationsResponse.json();
  assert.deepEqual(result.mappingSnapshot.mappingVersions.map(({ id, version }) => ({ id, version })), [{ id: approved.id, version: 1 }]);
  const sofa = result.classifications.find((classification) => classification.sourceObject.block === 'SOFA_3S');
  assert.equal(sofa.category.value, 'seating');
  assert.equal(sofa.catalogItem.value, 'sofa');
  assert.ok(sofa.evidence.some((item) => item.kind === 'approved-mapping' && item.profileVersion === 1));
});

test('HTTP project and rollup endpoints expose a requested historical BOQ version through nested drill-down', async () => {
  const project = (await (await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Historical HTTP project' })
  })).json()).project;
  const building = (await (await fetch(`${baseUrl}/api/projects/${project.id}/buildings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Main building' })
  })).json()).building;
  const storey = (await (await fetch(`${baseUrl}/api/buildings/${building.id}/storeys`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ground floor' })
  })).json()).storey;
  const plan = await readFile(`${__dirname}/fixtures/clean-plan.dxf`);
  const firstForm = new FormData();
  firstForm.set('drawing', new Blob([plan], { type: 'application/dxf' }), 'historical.dxf');
  firstForm.set('storeyId', storey.id);
  const firstUpload = await (await fetch(`${baseUrl}/api/projects/${project.id}/source-documents`, { method: 'POST', body: firstForm })).json();
  await completedRun(firstUpload.processingRun.id);
  const firstVersion = project.currentBoqVersionId;
  const secondVersion = (await (await fetch(`${baseUrl}/api/projects/${project.id}/boq-versions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Current BOQ' })
  })).json()).boqVersion;
  const secondForm = new FormData();
  secondForm.set('drawing', new Blob([plan], { type: 'application/dxf' }), 'historical.dxf');
  secondForm.set('storeyId', storey.id);
  secondForm.set('boqVersionId', secondVersion.id);
  const secondUpload = await (await fetch(`${baseUrl}/api/projects/${project.id}/source-documents`, { method: 'POST', body: secondForm })).json();
  await completedRun(secondUpload.processingRun.id);

  const historicalProjectResponse = await fetch(`${baseUrl}/api/projects/${project.id}?boqVersionId=${firstVersion}`);
  assert.equal(historicalProjectResponse.status, 200);
  const historicalProject = (await historicalProjectResponse.json()).project;
  assert.equal(historicalProject.rollup.boqVersionId, firstVersion);
  assert.equal(historicalProject.buildings[0].rollup.boqVersionId, firstVersion);
  assert.equal(historicalProject.buildings[0].storeys[0].rollup.boqVersionId, firstVersion);
  assert.equal(historicalProject.buildings[0].storeys[0].rollup.sourceContributions[0].boqVersionId, firstVersion);

  const historicalRollupResponse = await fetch(`${baseUrl}/api/projects/${project.id}/rollup?boqVersionId=${firstVersion}`);
  assert.equal(historicalRollupResponse.status, 200);
  assert.equal((await historicalRollupResponse.json()).rollup.boqVersionId, firstVersion);

  const otherProject = (await (await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other project' })
  })).json()).project;
  const invalid = await fetch(`${baseUrl}/api/projects/${project.id}?boqVersionId=${otherProject.currentBoqVersionId}`);
  assert.equal(invalid.status, 422);
});

test('HTTP rejects oversized JSON bodies before accumulating them', async () => {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(1024 * 1024) })
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /body exceeds/);
});

test('HTTP assignment no-op returns safely without a processing run', async () => {
  const project = (await (await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No-op assignment project' })
  })).json()).project;
  const plan = await readFile(`${__dirname}/fixtures/clean-plan.dxf`);
  const form = new FormData();
  form.set('drawing', new Blob([plan], { type: 'application/dxf' }), 'no-op.dxf');
  form.set('projectId', project.id);
  const source = (await (await fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form })).json()).sourceDocument;
  const response = await fetch(`${baseUrl}/api/source-documents/${source.id}/assignment`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, buildingId: null, storeyId: null, typicalMultiplier: 1 })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).processingRun, null);
});
