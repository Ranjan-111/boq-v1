const { readFile } = require('node:fs/promises');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { startOperatorApp } = require('../test-support/operator-app');

let app;
let baseUrl;
let cleanPlan;

before(async () => {
  app = await startOperatorApp();
  baseUrl = app.baseUrl;
  cleanPlan = await readFile(`${__dirname}/fixtures/clean-plan.dxf`, 'utf8');
});

after(async () => {
  await app.close();
});

async function uploadDrawing(content, filename, fields = {}) {
  const form = new FormData();
  form.set('drawing', new Blob([content], { type: 'application/dxf' }), filename);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return fetch(`${baseUrl}/api/source-documents`, { method: 'POST', body: form });
}

async function waitForRun(runId) {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    assert.equal(response.status, 200);
    const run = await response.json();
    if (['completed', 'failed'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('processing run did not settle');
}

test('missing DXF units fail before quantities and explain the evidence gap', async () => {
  const response = await uploadDrawing(cleanPlan.replace('9\n$INSUNITS\n70\n4\n', ''), 'missing-units.dxf');
  assert.equal(response.status, 202);
  const submission = await response.json();
  const run = await waitForRun(submission.processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /We cannot tell which drawing unit was used/);
  assert.match(run.error, /missing-units\.dxf/);
});

test('malformed PDF fails safely with actionable re-export guidance', async () => {
  const response = await uploadDrawing(Buffer.from('%PDF-1.4\nnot a valid PDF'), 'broken-vector.pdf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /PDF|re-export|simplif/i);
  assert.equal(run.errorDetails.stage, 'ingestion');
  assert.equal(run.errorDetails.sourcePageId, null);
  assert.equal(run.errorDetails.retryable, false);
  assert.match(run.errorDetails.action, /re-export|split/i);
});

test('oversized PDF upload is rejected before PDF parsing', async () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x25);
  oversized.write('%PDF-1.7', 0, 'ascii');
  const response = await uploadDrawing(oversized, 'oversized-vector.pdf');
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /body exceeds|limit/i);
});

test('multipart parser keeps boundary-like bytes inside the drawing payload', async () => {
  const boundary = 'boq-boundary';
  const payload = Buffer.from(cleanPlan.replace('0\nEOF\n', `999\nraw bytes --${boundary} remain drawing content\n0\nEOF\n`));
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="drawing"; filename="boundary-bytes.dxf"\r\nContent-Type: application/dxf\r\n\r\n`),
    payload,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await fetch(`${baseUrl}/api/source-documents`, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) }, body
  });
  assert.equal(response.status, 202);
  const runResponse = await response.json();
  const run = await waitForRun(runResponse.processingRun.id);
  assert.equal(run.status, 'completed');
});

test('unsupported DXF units fail before quantities and name the unsupported evidence', async () => {
  const response = await uploadDrawing(cleanPlan.replace('70\n4\n', '70\n1\n'), 'unsupported-units.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /We cannot tell which drawing unit was used/);
  assert.match(run.error, /unsupported-units\.dxf/);
});

test('a non-integer $INSUNITS value fails without a fallback', async () => {
  const response = await uploadDrawing(cleanPlan.replace('70\n4\n', '70\n4.5\n'), 'decimal-units.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /We cannot tell which drawing unit was used/);
  assert.match(run.error, /complete integer|4\.5/);
  assert.match(run.error, /decimal-units\.dxf/);
});

test('$INSUNITS does not borrow a later header variable value', async () => {
  const missingImmediateValue = cleanPlan.replace(
    '9\n$INSUNITS\n70\n4\n0\nENDSEC\n',
    '9\n$INSUNITS\n9\n$LIMMAX\n70\n4\n0\nENDSEC\n'
  );
  const response = await uploadDrawing(missingImmediateValue, 'non-adjacent-units.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /We cannot tell which drawing unit was used/);
  assert.match(run.error, /non-adjacent-units\.dxf/);
  assert.match(run.error, /complete integer|missing value|re-export/i);
});

test('malformed entities fail with affected source and re-export guidance', async () => {
  const malformed = cleanPlan.replace('20\n-115\n10\n7700', '20\nnot-a-coordinate\n10\n7700');
  const response = await uploadDrawing(malformed, 'malformed-plan.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /malformed-plan\.dxf/);
  assert.match(run.error, /malformed|invalid/i);
  assert.match(run.error, /re-export/i);
});

test('an open DXF section cannot be overwritten by a new SECTION record', async () => {
  const openHeader = cleanPlan.replace(
    '0\nENDSEC\n0\nSECTION\n2\nTABLES\n',
    '0\nSECTION\n2\nTABLES\n'
  );
  const response = await uploadDrawing(openHeader, 'open-section.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /section|malformed/i);
  assert.match(run.error, /open-section\.dxf/);
  assert.match(run.error, /re-export/i);
});

test('malformed LINE entities fail while valid unsupported LINE entities remain acceptable', async () => {
  const malformed = cleanPlan.replace('0\nENDSEC\n0\nEOF\n', '0\nLINE\n5\nBADLINE\n8\nA-WALL\n10\n0\n20\n0\n11\nnot-a-number\n21\n100\n0\nENDSEC\n0\nEOF\n');
  const malformedResponse = await uploadDrawing(malformed, 'malformed-line.dxf');
  assert.equal(malformedResponse.status, 202);
  const malformedRun = await waitForRun((await malformedResponse.json()).processingRun.id);
  assert.equal(malformedRun.status, 'failed');
  assert.equal(malformedRun.boq, null);
  assert.match(malformedRun.error, /LINE|malformed/i);
  assert.match(malformedRun.error, /malformed-line\.dxf/);
  assert.match(malformedRun.error, /re-export/i);

  const valid = cleanPlan.replace('0\nENDSEC\n0\nEOF\n', '0\nLINE\n5\nGOODLINE\n8\nA-WALL\n10\n0\n20\n0\n11\n100\n21\n100\n0\nENDSEC\n0\nEOF\n');
  const validResponse = await uploadDrawing(valid, 'valid-line.dxf');
  assert.equal(validResponse.status, 202);
  const validRun = await waitForRun((await validResponse.json()).processingRun.id);
  assert.equal(validRun.status, 'completed');
  assert.ok(validRun.boq);
});

test('an unmeasurable CIRCLE is reported rather than failing the drawing', async () => {
  /* Contract changed deliberately: refusing every drawing containing an entity
     we cannot measure meant refusing every real architectural drawing. The
     safety intent is kept downstream -- see the blocking assertion below. */
  const malformed = cleanPlan.replace(
    '0\nENDSEC\n0\nEOF\n',
    '0\nCIRCLE\n5\nBAD-CIRCLE\n8\nA-WALL\n10\nnot-a-number\n20\n0\n40\n100\n0\nENDSEC\n0\nEOF\n'
  );
  const response = await uploadDrawing(malformed, 'malformed-circle.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'completed', 'the rest of the drawing still measures');
  assert.equal(run.boq.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72);
  const reported = run.boq.unclassified.filter((entry) => entry.type === 'CIRCLE');
  assert.equal(reported.length, 1, 'and the circle is reported, never silently dropped');
  assert.equal(reported[0].kind, 'unmeasured-geometry');
});

test('unmeasured geometry blocks approval, so a short BOQ cannot ship', async () => {
  /* This is where the old "cannot complete" guarantee now lives: the drawing
     ingests, but a BOQ that ignored real geometry cannot be approved. */
  const plausible = cleanPlan.replace(
    '0\nENDSEC\n0\nEOF\n',
    '0\nCIRCLE\n5\nGOOD-CIRCLE\n8\nA-WALL\n10\n0\n20\n0\n40\n100\n0\nENDSEC\n0\nEOF\n'
  );
  const response = await uploadDrawing(plausible, 'unsupported-circle.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);
  assert.equal(run.status, 'completed');

  const { createApplication } = require('../src/application');
  const { exceptionsForRun } = require('../src/exceptions');
  const raised = exceptionsForRun({ id: run.id, projectId: null, sourceDocumentId: null, boq: run.boq, residuals: [], pages: [] })
    .filter((exception) => exception.type === 'unmeasured_geometry');
  assert.ok(raised.length > 0, 'the circle raises an exception');
  assert.equal(raised[0].severity, 'blocking');
  assert.ok(raised[0].blocks.includes('approval') && raised[0].blocks.includes('export'));
});

test('missing external references fail with affected source and re-export guidance', async () => {
  const withReference = cleanPlan.replace('0\nEOF\n', '0\nXREF\n1\nmissing-reference.dwg\n0\nEOF\n');
  const response = await uploadDrawing(withReference, 'external-reference-plan.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /external-reference-plan\.dxf/);
  assert.match(run.error, /external reference/i);
  assert.match(run.error, /re-export/i);
});

test('BLOCKS XREF flags fail with the affected block and source guidance', async () => {
  const withXrefBlock = cleanPlan.replace('0\nSECTION\n2\nENTITIES\n', '0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n5\nB1\n8\n0\n70\n4\n2\nARCH_XREF\n3\nARCH_XREF\n1\nexternal-reference.dwg\n0\nENDBLK\n5\nB1E\n8\n0\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n');
  const response = await uploadDrawing(withXrefBlock, 'block-xref-plan.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.boq, null);
  assert.match(run.error, /external reference/i);
  assert.match(run.error, /ARCH_XREF/);
  assert.match(run.error, /block-xref-plan\.dxf/);
  assert.match(run.error, /re-export/i);
});

test('notes mentioning external references do not trigger a false positive', async () => {
  const noted = cleanPlan.replace('0\nENDSEC\n0\nEOF\n', '999\nThis note discusses external references but is not an external reference record.\n0\nENDSEC\n0\nEOF\n');
  const response = await uploadDrawing(noted, 'note-about-references.dxf');
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);
  assert.equal(run.status, 'completed');
  assert.ok(run.boq);
});

test('DWG is refused at upload with native DXF export guidance', async () => {
  const response = await uploadDrawing('AC1032\0binary DWG', 'drawing.dwg');
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.match(result.error, /DWG/i);
  assert.match(result.error, /native DXF export/i);
});

test('a DWG named file without DWG magic bytes still gets DWG-specific guidance', async () => {
  // Content sniffing alone (issue #7) would fall through to the generic
  // unsupported-format message and lose the re-export instruction.
  const response = await uploadDrawing('this file is not valid DWG content', 'drawing.dwg');
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.match(result.error, /DWG/i);
  assert.match(result.error, /native DXF export/i);
});

test('an explicit fallback unit is versioned, auditable, and visible on the completed run', async () => {
  const response = await uploadDrawing(cleanPlan.replace('9\n$INSUNITS\n70\n4\n', ''), 'assumed-units.dxf', { fallbackUnit: 'millimetres' });
  assert.equal(response.status, 202);
  const submission = await response.json();
  const run = await waitForRun(submission.processingRun.id);

  assert.equal(run.status, 'completed');
  assert.ok(run.boq);
  assert.equal(run.units.source, 'operator-assumption');
  assert.equal(run.units.name, 'millimetres');
  assert.equal(run.units.version, 'unit-resolution-v1');
  assert.equal(run.units.recorded, true);
  assert.equal(run.versions.unitResolution, 'unit-resolution-v1');
  assert.equal(run.units.audit.sourceDocumentId, submission.sourceDocument.id);
  assert.match(run.units.audit.decision, /operator/i);
});

test('an explicit fallback can recover an unsupported source declaration', async () => {
  const response = await uploadDrawing(cleanPlan.replace('70\n4\n', '70\n1\n'), 'unsupported-with-fallback.dxf', { fallbackUnit: 'centimetres' });
  assert.equal(response.status, 202);
  const run = await waitForRun((await response.json()).processingRun.id);

  assert.equal(run.status, 'completed');
  assert.equal(run.units.source, 'operator-assumption');
  assert.equal(run.units.name, 'centimetres');
  assert.ok(run.boq.lines.some((line) => line.measurement === 'floor_area' && line.quantity === 2772));
});
