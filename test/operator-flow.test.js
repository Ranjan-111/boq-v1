const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

/* Provenance is a two-part record now: a line carries contributions, and each
   contribution resolves to a SourceObject in the run's (or rollup's) registry. */
const objectFor = (carrier, contribution) => carrier.sourceObjects.find((object) => object.sourceObjectId === contribution.sourceObjectId);
const handlesOf = (carrier, line) => line.provenance.contributions.map((contribution) => objectFor(carrier, contribution).nativeHandle).sort();
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

async function uploadPdf(filename = 'vector-plan.dat', fields = {}) {
  const pdf = await readFile(`${__dirname}/fixtures/vector-plan.pdf`);
  const form = new FormData();
  form.set('drawing', new Blob([pdf], { type: 'application/octet-stream' }), filename);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
}

function makeImageOnlyPdf(withVector = false) {
  const content = `${withVector ? '0 0 50 50 re S\n' : ''}q\n20 0 0 20 10 10 cm\n/Im1 Do\nQ\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 8 >>\nstream\n000000>\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function uploadPdfBytes(bytes, filename, fields = {}) {
  const form = new FormData();
  form.set('drawing', new Blob([bytes], { type: 'application/pdf' }), filename);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
}

async function completedRun(runId) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(response.status, 200);
    const run = await response.json();
    if (['completed', 'awaiting_setup', 'awaiting_calibration', 'failed'].includes(run.status)) return run;
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
      /* 157.2 under clean-plan-v1, which never deducted openings. The default
         ruleset is now clean-plan-v2: two doors (0.9 m, 0.75 m at 2.1 m) and
         two windows (1.2 m, 1.5 m at 1.2 m), each removed from both plastered
         faces, deduct 13.41 m2. Masonry stays gross -- that is a v2 policy
         setting, off by default. */
      wall_plaster: 143.79,
      floor_area: 27.72,
      skirting: 29.8,
      room_count: 2,
      door_count: 2,
      window_count: 2,
      furniture_count: 4
    }
  );
  assert.deepEqual(handlesOf(run.boq, lines.floor_area), ['10A', '10C']);
  assert.deepEqual(handlesOf(run.boq, lines.door_count), ['10E', '10F']);
  assert.equal(lines.wall_masonry.unit, 'm³');
  assert.equal(lines.wall_masonry.confidence.evidence.join(','), 'layer,hatch');
  assert.equal(lines.floor_area.measurementStatus, 'measured');
  assert.equal(objectFor(run.boq, lines.floor_area.provenance.contributions[0]).sourceDocumentId, submission.sourceDocument.id);
});

test('content-sniffed vector PDF preserves bytes and waits for explicit setup', async () => {
  const response = await uploadPdf();
  assert.equal(response.status, 202);
  const submission = await response.json();
  const pdf = await readFile(`${__dirname}/fixtures/vector-plan.pdf`);
  assert.equal(submission.sourceDocument.format, 'pdf');
  assert.equal(submission.sourceDocument.mediaType, 'application/pdf');
  assert.equal(submission.sourceDocument.byteLength, pdf.length);
  assert.equal(submission.sourceDocument.contentSha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(submission.processingRun.status, 'ingestion');

  const run = await completedRun(submission.processingRun.id);
  assert.equal(run.status, 'awaiting_setup');
  assert.equal(run.setup.status, 'pending');
  assert.equal(run.pages.length, 1);
  assert.equal(run.pages[0].rotation, 90);
  assert.equal(run.pages[0].kind, 'vector');
  assert.match(run.pages[0].nativeText[0].text, /ROOM 101/);
  assert.ok(run.pages[0].vectorRegions.some((region) => region.id === 'pdf:p1:path:0001'));
  assert.equal(run.boq, null);
});

test('image-only PDF enters the normalized raster calibration handoff without a BOQ', async () => {
  const response = await uploadPdfBytes(makeImageOnlyPdf(), 'image-only-vector.pdf');
  assert.equal(response.status, 202);
  const submission = await response.json();
  const run = await completedRun(submission.processingRun.id);
  assert.equal(run.status, 'awaiting_calibration');
  assert.equal(run.pages[0].kind, 'raster');
  assert.equal(run.setup.route, 'raster');
  assert.equal(run.boq, null);
  assert.match(run.blockedReasons.join(' '), /calibration|tracing/i);
});

test('PDF pages with vector and image content fail closed without omitting vector quantities', async () => {
  const response = await uploadPdfBytes(makeImageOnlyPdf(true), 'mixed-vector-image.pdf');
  assert.equal(response.status, 202);
  const submission = await response.json();
  const run = await completedRun(submission.processingRun.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.errorDetails.code, 'mixed_pdf_unsupported');
  assert.equal(run.exportable, false);
  assert.equal(run.boq, null);
  assert.equal(run.setup.status, 'pending');
  assert.match(run.error, /vector quantities and raster regions cannot be measured together/i);
  assert.equal(run.pages[0].kind, 'mixed');
  assert.equal(run.pages[0].route, 'raster');
  assert.ok(run.pages[0].nativeRegionIds.length > 0);
  assert.ok(run.pages[0].rasterRegionIds.length > 0);
});

test('PDF setup rejects scales that would underflow or overflow area conversion', async () => {
  const submission = await (await uploadPdf('extreme-scale-vector.pdf')).json();
  const inspected = await completedRun(submission.processingRun.id);
  for (const scale of ['1e-200', '1e200']) {
    const response = await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: scale }, selectedRegions: ['pdf:p1:path:0001'] }] })
    });
    assert.equal(response.status, 422);
  assert.match((await response.json()).error, /finite|range|scale/i);
  }
});

test('vector PDF setup gates measurement and preserves page-region provenance', async () => {
  const submission = await (await uploadPdf('vector-plan.dxf')).json();
  const inspected = await completedRun(submission.processingRun.id);
  const setupResponse = await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }] })
  });
  assert.equal(setupResponse.status, 202);
  const configured = await setupResponse.json();
  const run = await completedRun(configured.processingRun.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.boq.lines.find((line) => line.measurement === 'floor_area').quantity, 0.5);
  const floorLine = run.boq.lines.find((line) => line.measurement === 'floor_area');
  const provenance = objectFor(run.boq, floorLine.provenance.contributions[0]);
  assert.equal(provenance.pageId, 'page_1');
  assert.equal(provenance.regionId, 'pdf:p1:path:0001');
  assert.equal(provenance.geometrySource, 'native-vector');
  assert.equal(provenance.coordinateSpace, 'pdf-page');
  assert.equal(provenance.rotation, 90);
  assert.deepEqual(provenance.transform, [0, 1, 1, 0, 0, 0]);
  assert.equal(floorLine.provenance.contributions[0].runId, run.id);
  assert.equal(floorLine.provenance.contributions[0].ruleInputs.setupRevision, 1);
  assert.equal(floorLine.provenance.contributions[0].ruleInputs.scale.drawingUnitsPerMetre, 72);
  assert.equal(floorLine.provenance.contributions[0].rulesetVersion, run.versions.ruleset);
  assert.equal(run.boq.versions.ruleset, run.versions.ruleset);
});

test('vector PDF setup rejects duplicate or missing page entries', async () => {
  const submission = await (await uploadPdf()).json();
  const inspected = await completedRun(submission.processingRun.id);
  const response = await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }, { sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }] })
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /exactly one setup entry/i);
});

test('configured vector PDF reprocess replays the validated setup', async () => {
  const submission = await (await uploadPdf('replay-vector.pdf')).json();
  const inspected = await completedRun(submission.processingRun.id);
  const configured = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }] })
  })).json();
  const firstRun = await completedRun(configured.processingRun.id);
  const replay = await fetch(`${baseUrl}/api/runs/${firstRun.id}/reprocess`, { method: 'POST' });
  assert.equal(replay.status, 202);
  const replaySubmission = await replay.json();
  const replayed = await completedRun(replaySubmission.processingRun.id);
  assert.equal(replayed.status, 'completed');
  assert.equal(replayed.boq.lines.find((line) => line.measurement === 'floor_area').quantity, 0.5);
  assert.equal(replayed.setup.status, 'ready');
});

test('reassignment invalidates an inspected PDF setup run', async () => {
  const projectResponse = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF reassignment project' })
  });
  const project = (await projectResponse.json()).project;
  const response = await uploadPdf('reassigned-vector.pdf');
  const submission = await response.json();
  const inspected = await completedRun(submission.processingRun.id);
  const assignment = await fetch(`${baseUrl}/api/source-documents/${submission.sourceDocument.id}/assignment`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, typicalMultiplier: 1 })
  });
  assert.equal(assignment.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/runs/${inspected.id}`)).status, 200);
  const staleSetup = await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }] })
  });
  assert.equal(staleSetup.status, 409);
});

test('configured vector PDF contributes page provenance to a storey rollup', async () => {
  const project = (await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF project' }) })).json()).project;
  const building = (await (await fetch(`${baseUrl}/api/projects/${project.id}/buildings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF building' }) })).json()).building;
  const storey = (await (await fetch(`${baseUrl}/api/buildings/${building.id}/storeys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF storey' }) })).json()).storey;
  const pdf = await readFile(`${__dirname}/fixtures/vector-plan.pdf`);
  const form = new FormData();
  form.set('drawing', new Blob([pdf], { type: 'application/pdf' }), 'vector-plan.pdf');
  form.set('storeyId', storey.id);
  const submission = await (await fetch(`${baseUrl}/api/projects/${project.id}/source-documents`, { method: 'POST', body: form })).json();
  const inspected = await completedRun(submission.processingRun.id);
  const configured = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }] }) })).json();
  await completedRun(configured.processingRun.id);
  const result = (await (await fetch(`${baseUrl}/api/projects/${project.id}`)).json()).project;
  const line = result.buildings[0].storeys[0].rollup.lines.find((candidate) => candidate.measurement === 'floor_area');
  assert.equal(line.quantity, 0.5);
  const rolledObject = objectFor(result.buildings[0].storeys[0].rollup, line.provenance.contributions[0]);
  assert.equal(rolledObject.pageId, 'page_1');
  assert.equal(rolledObject.regionId, 'pdf:p1:path:0001');
});

test('PDF typical-storey multiplier is applied once and retained in provenance', async () => {
  const project = (await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF multiplier project' }) })).json()).project;
  const building = (await (await fetch(`${baseUrl}/api/projects/${project.id}/buildings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF multiplier building' }) })).json()).building;
  const storey = (await (await fetch(`${baseUrl}/api/buildings/${building.id}/storeys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'PDF multiplier storey' }) })).json()).storey;
  const submission = await (await uploadPdf('multiplier-vector.pdf', { storeyId: storey.id, typicalMultiplier: '2' })).json();
  const inspected = await completedRun(submission.processingRun.id);
  const configured = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pages: [{ sourcePageId: 'page_1', scale: { drawingUnitsPerMetre: 72 }, selectedRegions: ['pdf:p1:path:0001'] }] }) })).json();
  const run = await completedRun(configured.processingRun.id);
  const line = run.boq.lines.find((candidate) => candidate.measurement === 'floor_area');
  assert.equal(line.quantity, 1);
  assert.equal(line.provenance.contributions[0].typicalMultiplier, 2);
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
  const shape = (run) => run.boq.lines.map((line) => [line.measurement, line.quantity, handlesOf(run.boq, line)]);
  assert.deepEqual(shape(secondRun), shape(firstRun));
  // and the source objects themselves keep their identity, not just their handles
  assert.deepEqual(
    secondRun.boq.sourceObjects.map((object) => object.sourceObjectId).sort(),
    firstRun.boq.sourceObjects.map((object) => object.sourceObjectId).sort()
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
  const rollup = result.project.buildings[0].storeys[0].rollup;
  const floorObject = objectFor(rollup, floor.provenance.contributions[0]);
  assert.equal(floorObject.sourceDocumentId, submission.sourceDocument.id);
  assert.equal(floorObject.storeyId, storey.id);
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
