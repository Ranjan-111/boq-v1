const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const objectFor = (carrier, contribution) => carrier.sourceObjects.find((object) => object.sourceObjectId === contribution.sourceObjectId);
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { startOperatorApp } = require('../test-support/operator-app');

const PNG_FIXTURE = join(__dirname, 'fixtures', 'raster-200x100.png');


let app;
let baseUrl;

before(async () => { app = await startOperatorApp(); baseUrl = app.baseUrl; });
after(async () => { await app.close(); });

async function uploadRaster() {
  const form = new FormData();
  form.set('drawing', new Blob([await readFile(PNG_FIXTURE)], { type: 'image/png' }), 'raster-plan.png');
  const response = await fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
  assert.equal(response.status, 202);
  return response.json();
}

function makeImageOnlyPdf() {
  const content = 'q\n20 0 0 20 10 10 cm\n/Im1 Do\nQ\n';
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

async function uploadPdfRaster() {
  const form = new FormData();
  form.set('drawing', new Blob([makeImageOnlyPdf()], { type: 'application/pdf' }), 'image-only.pdf');
  const response = await fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
  assert.equal(response.status, 202);
  return response.json();
}

async function waitRun(runId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = await (await fetch(`${baseUrl}/api/runs/${runId}`)).json();
    if (['awaiting_calibration', 'awaiting_trace', 'awaiting_confirmation', 'completed', 'failed'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('raster run did not settle');
}

test('PNG raster flow calibrates, traces, confirms, measures, and exposes human provenance', async () => {
  const submission = await uploadRaster();
  const inspected = await waitRun(submission.processingRun.id);
  assert.equal(inspected.status, 'awaiting_calibration');
  assert.equal(inspected.pages[0].pixelWidth, 200);
  assert.equal(inspected.pages[0].pixelHeight, 100);
  assert.equal(inspected.exportable, false);
  assert.equal(inspected.boq, null);

  const invalid = await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/calibration`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, realDistance: 2, realUnit: 'm' })
  });
  assert.equal(invalid.status, 422);

  const calibrated = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/calibration`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' })
  })).json();
  assert.equal(calibrated.processingRun.status, 'awaiting_trace');

  const region = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/regions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' })
  })).json();
  const regionId = region.region.id;
  assert.equal(region.processingRun.status, 'awaiting_confirmation');
  const confirmed = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/regions/${regionId}/confirm`, { method: 'POST' })).json();
  const completed = await waitRun(confirmed.processingRun.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.boq.lines.find((line) => line.measurement === 'floor_area').quantity, 2);
  const floorLine = completed.boq.lines.find((line) => line.measurement === 'floor_area');
  const contribution = floorLine.provenance.contributions[0];
  const evidence = objectFor(completed.boq, contribution);
  assert.equal(evidence.geometrySource, 'human-traced');
  assert.equal(evidence.coordinateSpace, 'raster-pixel');
  assert.equal(evidence.regionId, regionId);
  assert.equal(contribution.ruleInputs.calibrationRevision, 1);
});

test('raster calibration correction recomputes from canonical points and preserves region history', async () => {
  const submission = await uploadRaster();
  const inspected = await waitRun(submission.processingRun.id);
  await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' }) });
  const region = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/regions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' }) })).json();
  await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/regions/${region.region.id}/confirm`, { method: 'POST' });
  const corrected = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 4, realUnit: 'm' }) })).json();
  assert.equal(corrected.processingRun.status, 'awaiting_confirmation');
  const reconfirmed = await (await fetch(`${baseUrl}/api/runs/${inspected.id}/pages/page_1/regions/${region.region.id}/confirm`, { method: 'POST' })).json();
  const completed = await waitRun(reconfirmed.processingRun.id);
  assert.equal(completed.boq.lines[0].quantity, 8);
  assert.equal(completed.pages[0].calibration.revision, 2);
  assert.equal(completed.pages[0].calibration.history.length, 1);
});

test('truncated raster payload fails safely before calibration', async () => {
  const form = new FormData();
  form.set('drawing', new Blob([(await readFile(PNG_FIXTURE)).subarray(0, 30)], { type: 'image/png' }), 'truncated.png');
  const response = await fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
  assert.equal(response.status, 202);
  const submission = await response.json();
  const run = await waitRun(submission.processingRun.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Malformed PNG|could not be processed/);
  assert.equal(run.exportable, false);
});

test('raster region edits are revision-guarded and preserve tombstones', async () => {
  const submission = await uploadRaster();
  const inspected = await waitRun(submission.processingRun.id);
  const base = `${baseUrl}/api/runs/${inspected.id}/pages/page_1`;
  await fetch(`${base}/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' }) });
  const created = await (await fetch(`${base}/regions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }], category: 'wall_area', expectedRevision: 1 }) })).json();
  const regionId = created.region.id;
  const conflict = await fetch(`${base}/regions/${regionId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, category: 'floor_area' }) });
  assert.equal(conflict.status, 409);
  const staleConfirm = await fetch(`${base}/regions/${regionId}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }) });
  assert.equal(staleConfirm.status, 409);
  const staleDelete = await fetch(`${base}/regions/${regionId}?expectedRevision=0`, { method: 'DELETE' });
  assert.equal(staleDelete.status, 409);
  const deleted = await (await fetch(`${base}/regions/${regionId}?expectedRevision=1`, { method: 'DELETE' })).json();
  assert.equal(deleted.region.lifecycle, 'deleted');
  assert.equal(deleted.processingRun.pages[0].regions[0].lifecycle, 'deleted');
});

test('image-only PDF uses canonical page-preview coordinates and serves original bytes/assets', async () => {
  const sourceBytes = makeImageOnlyPdf();
  const submission = await uploadPdfRaster();
  const run = await waitRun(submission.processingRun.id);
  assert.equal(run.status, 'awaiting_calibration');
  assert.equal(run.pages[0].coordinateSpace, 'image');
  assert.equal(run.pages[0].pixelWidth, 100);
  assert.equal(run.pages[0].pixelHeight, 100);
  assert.deepEqual(run.pages[0].sourceTransform, run.pages[0].transform);
  const preview = await fetch(`${baseUrl}/api/runs/${run.id}/pages/page_1/image`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), sourceBytes);
  for (const asset of ['/pdfjs/pdf.mjs', '/pdfjs/pdf.worker.mjs']) {
    const response = await fetch(`${baseUrl}${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('cache-control'), /immutable/);
  }
  assert.equal((await fetch(`${baseUrl}/pdfjs/not-allowed.mjs`)).status, 404);
});

test('invalid calibration and polygons are atomic and explicit page/region revisions are enforced', async () => {
  const submission = await uploadRaster();
  const run = await waitRun(submission.processingRun.id);
  const base = `${baseUrl}/api/runs/${run.id}/pages/page_1`;
  const calibrated = await (await fetch(`${base}/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' }) })).json();
  assert.equal(calibrated.page.revision, 1);
  const invalidCalibration = await fetch(`${base}/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedPageRevision: 1, p0: { x: -1, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 4, realUnit: 'm' }) });
  assert.equal(invalidCalibration.status, 422);
  const unchanged = await (await fetch(`${baseUrl}/api/runs/${run.id}`)).json();
  assert.equal(unchanged.pages[0].calibration.revision, 1);
  const invalidPolygon = await fetch(`${base}/regions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedPageRevision: 1, points: [{ x: 0, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }, { x: 80, y: 0 }], category: 'floor_area' }) });
  assert.equal(invalidPolygon.status, 422);
  const created = await (await fetch(`${base}/regions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedPageRevision: 1, points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }], category: 'floor_area' }) })).json();
  const regionId = created.region.id;
  assert.equal((await fetch(`${base}/regions/${regionId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedPageRevision: 0, expectedRegionRevision: 1, category: 'wall_area' }) })).status, 409);
  assert.equal((await fetch(`${base}/regions/${regionId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedPageRevision: 1, expectedRegionRevision: 0, category: 'wall_area' }) })).status, 409);
});

test('raster categories group quantities and reprocess retains calibration/traces', async () => {
  const submission = await uploadRaster();
  const inspected = await waitRun(submission.processingRun.id);
  const base = `${baseUrl}/api/runs/${inspected.id}/pages/page_1`;
  await fetch(`${base}/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' }) });
  const floor = await (await fetch(`${base}/regions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' }) })).json();
  const wall = await (await fetch(`${base}/regions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ points: [{ x: 100, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 20 }, { x: 100, y: 20 }], category: 'wall_area' }) })).json();
  await fetch(`${base}/regions/${floor.region.id}/confirm`, { method: 'POST' });
  const confirmed = await (await fetch(`${base}/regions/${wall.region.id}/confirm`, { method: 'POST' })).json();
  const completed = await waitRun(confirmed.processingRun.id);
  const lines = Object.fromEntries(completed.boq.lines.map((line) => [line.measurement, line]));
  assert.equal(lines.floor_area.quantity, 2);
  assert.equal(lines.wall_area.quantity, 0.4);
  const wallObject = objectFor(completed.boq, lines.wall_area.provenance.contributions[0]);
  assert.equal(wallObject.geometrySource, 'human-traced');
  assert.equal(wallObject.regionId, wall.region.id);
  const replay = await (await fetch(`${baseUrl}/api/runs/${completed.id}/reprocess`, { method: 'POST' })).json();
  const replayed = await waitRun(replay.processingRun.id);
  assert.equal(replayed.status, 'completed');
  assert.equal(replayed.boq.lines.find((line) => line.measurement === 'floor_area').quantity, 2);
  assert.equal(replayed.pages[0].calibration.revision, 1);
  assert.equal(replayed.pages[0].regions.filter((region) => region.lifecycle === 'confirmed').length, 2);
});
