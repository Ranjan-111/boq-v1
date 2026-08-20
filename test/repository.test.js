const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRepository } = require('../src/repository');

function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'boq-repo-'));
  return { file: join(directory, 'boq.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const sourceObject = (id, overrides = {}) => ({
  version: 'provenance-v2', sourceObjectId: id,
  sourceDocumentId: 'src_0001', sourceDocumentVersion: 1,
  buildingId: 'building_0001', storeyId: 'storey_0001', zoneId: null,
  sheetId: 'A-PLAN', pageId: null,
  geometrySource: 'dxf-entity', coordinateSpace: 'dxf', geometryResolution: 'native',
  geometry: [[0, 0], [10, 0], [10, 5]], bounds: [0, 0, 10, 5],
  transform: null, rotation: null, nativeHandle: id.split(':').at(-1), regionId: null, ...overrides
});
const contribution = (objectId, runId, quantity = 4) => ({
  sourceObjectId: objectId, measurement: 'floor_area', sign: 'add', quantity, unit: 'm²',
  ruleId: 'dxf-floor-area-v1', rulesetVersion: 'clean-plan-v1', runId, typicalMultiplier: 1, ruleInputs: null
});

function runFixture(runId = 'run_0001', documentId = 'src_0001') {
  const objects = [sourceObject(`${documentId}:v1:dxf:10A`), sourceObject(`${documentId}:v1:dxf:10C`)];
  return {
    id: runId, sourceDocumentId: documentId, status: 'completed', superseded: false,
    projectId: 'project_0001', buildingId: 'building_0001', storeyId: 'storey_0001',
    boqVersionId: 'boqv_0001', typicalMultiplier: 1,
    stages: [{ name: 'ingestion', status: 'completed' }],
    units: { code: 4, name: 'millimetres', toMetres: 0.001 },
    versions: { parser: 'dxf-v1', ruleset: 'clean-plan-v1' },
    boq: {
      versions: { parser: 'dxf-v1', ruleset: 'clean-plan-v1' }, ruleset: 'clean-plan-v1',
      sourceObjects: objects,
      aggregation: { scope: 'source_document', scopeId: documentId },
      lines: [{
        measurement: 'floor_area', label: 'Floor finish area', quantity: 8, unit: 'm²',
        confidence: { level: 'HIGH', evidence: ['layer', 'geometry'] },
        measurementStatus: 'measured',
        provenance: {
          version: 'provenance-v2',
          contributions: [contribution(objects[0].sourceObjectId, runId), contribution(objects[1].sourceObjectId, runId)],
          measurementStatus: 'measured',
          aggregation: { scope: 'source_document', scopeId: documentId }
        }
      }]
    }
  };
}

test('a run survives a process restart byte-identically', () => {
  const { file, cleanup } = tempFile();
  try {
    const written = runFixture();
    const first = createRepository({ file });
    first.saveSourceDocument({ id: 'src_0001', filename: 'clean-plan.dxf', version: 1, format: 'dxf', contentSha256: 'a'.repeat(64), projectId: 'project_0001', buildingId: 'building_0001', storeyId: 'storey_0001', sourceSheet: 'A-PLAN', typicalMultiplier: 1 });
    first.saveRun(written);
    first.close();

    // a genuinely fresh instance against the same file - nothing in process memory
    const second = createRepository({ file });
    const read = second.getRun('run_0001');
    second.close();
    assert.deepEqual(read, written, 'the run round-trips unchanged');
  } finally { cleanup(); }
});

test('audit_events rejects UPDATE and DELETE at the store, not just by convention', () => {
  const { file, cleanup } = tempFile();
  try {
    const repository = createRepository({ file });
    repository.appendAudit({ kind: 'run_completed', subjectId: 'run_0001', payload: { quantity: 8 } });
    const events = repository.listAudit();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'run_completed');
    assert.throws(() => repository.unsafeExec("UPDATE audit_events SET kind = 'tampered'"), /append-only/i);
    assert.throws(() => repository.unsafeExec('DELETE FROM audit_events'), /append-only/i);
    assert.equal(repository.listAudit().length, 1, 'the event is still there, unchanged');
    assert.equal(repository.listAudit()[0].kind, 'run_completed');
    repository.close();
  } finally { cleanup(); }
});

test('no source file issues an UPDATE or DELETE against audit_events', () => {
  const { readFileSync, readdirSync } = require('node:fs');
  const directory = `${__dirname}/../src`;
  const files = readdirSync(directory, { recursive: true }).filter((name) => String(name).endsWith('.js'));
  for (const name of files) {
    const source = readFileSync(`${directory}/${name}`, 'utf8');
    const offending = source.match(/(?:UPDATE|DELETE\s+FROM)\s+audit_events/gi) || [];
    assert.deepEqual(offending, [], `${name} mutates audit_events`);
  }
});

test('a rollup costs a bounded number of queries no matter how many runs contribute', () => {
  const { file, cleanup } = tempFile();
  try {
    const repository = createRepository({ file });
    const documentIds = [];
    for (let index = 1; index <= 12; index += 1) {
      const documentId = `src_${String(index).padStart(4, '0')}`;
      documentIds.push(documentId);
      repository.saveSourceDocument({ id: documentId, filename: `${index}.dxf`, version: 1, format: 'dxf', contentSha256: String(index).repeat(64).slice(0, 64), projectId: 'project_0001', buildingId: 'building_0001', storeyId: 'storey_0001', sourceSheet: `A-${index}`, typicalMultiplier: 1 });
      repository.saveRun(runFixture(`run_${String(index).padStart(4, '0')}`, documentId));
    }

    const small = repository.measureQueries(() => repository.rollup({ sourceDocumentIds: documentIds.slice(0, 2), scope: 'storey', scopeId: 'storey_0001' }));
    const large = repository.measureQueries(() => repository.rollup({ sourceDocumentIds: documentIds, scope: 'storey', scopeId: 'storey_0001' }));

    assert.equal(large.queries, small.queries, `6x the runs must not cost more queries (${small.queries} vs ${large.queries})`);
    assert.ok(large.queries <= 8, `a rollup should be a handful of set-based queries, took ${large.queries}`);
    assert.equal(large.result.lines.length, 1);
    assert.equal(large.result.lines[0].quantity, 96, '12 runs x 8');
    assert.equal(large.result.lines[0].provenance.contributions.length, 24);
    assert.equal(large.result.sourceObjects.length, 24);
    repository.close();
  } finally { cleanup(); }
});

test('source objects are deduplicated on their stable id across runs of one document version', () => {
  const { file, cleanup } = tempFile();
  try {
    const repository = createRepository({ file });
    repository.saveSourceDocument({ id: 'src_0001', filename: 'a.dxf', version: 1, format: 'dxf', contentSha256: 'a'.repeat(64), projectId: 'project_0001', sourceSheet: 'A', typicalMultiplier: 1 });
    repository.saveRun(runFixture('run_0001'));
    repository.saveRun(runFixture('run_0002'));
    assert.equal(repository.countSourceObjects(), 2, 'reprocessing reuses the same source objects');
    // both runs still resolve their own contributions
    for (const runId of ['run_0001', 'run_0002']) {
      const run = repository.getRun(runId);
      const ids = run.boq.lines[0].provenance.contributions.map((entry) => entry.sourceObjectId);
      assert.equal(ids.length, 2);
      assert.ok(run.boq.sourceObjects.every((object) => ids.includes(object.sourceObjectId)));
    }
    repository.close();
  } finally { cleanup(); }
});

test('geometry that diverges for an existing source object id is recorded, never silently overwritten', () => {
  const { file, cleanup } = tempFile();
  try {
    const repository = createRepository({ file });
    repository.saveSourceDocument({ id: 'src_0001', filename: 'a.dxf', version: 1, format: 'dxf', contentSha256: 'a'.repeat(64), projectId: 'project_0001', sourceSheet: 'A', typicalMultiplier: 1 });
    repository.saveRun(runFixture('run_0001'));

    const divergent = runFixture('run_0002');
    divergent.boq.sourceObjects[0].geometry = [[0, 0], [99, 0], [99, 99]];
    divergent.boq.sourceObjects[0].bounds = [0, 0, 99, 99];
    repository.saveRun(divergent);

    const stored = repository.getRun('run_0001').boq.sourceObjects.find((object) => object.sourceObjectId === 'src_0001:v1:dxf:10A');
    assert.deepEqual(stored.bounds, [0, 0, 10, 5], 'the original run keeps the geometry it actually measured');
    const divergence = repository.listAudit().filter((event) => event.kind === 'source_object_geometry_divergence');
    assert.equal(divergence.length, 1, 'and the conflict is on the audit trail');
    assert.equal(divergence[0].subjectId, 'src_0001:v1:dxf:10A');
    repository.close();
  } finally { cleanup(); }
});
