const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../src/application');
const { fuseEvidence, groupClassificationConflicts, mappingSnapshot } = require('../src/classification');
const { blockCategory } = require('../src/dxf');

const objectContext = { sourceObjectId: 'object-1', sourceObject: { sourceObjectId: 'object-1', entity: { layer: 'A-FURN', block: 'CHAIR' }, projectId: 'project-1', storeyId: 'storey-1' }, projectId: 'project-1', storeyId: 'storey-1' };
function evidence(id, kind, dimension, value, categoryAncestor) {
  return { id, kind, dimension, candidate: { value, categoryAncestor }, source: { authority: 'native', quality: 'verified', reference: { sourceObjectId: 'object-1' } }, sourceObjectId: 'object-1' };
}

test('fusion is order independent and separates seating category from chair/stool item conflict', () => {
  const observations = [evidence('layer', 'layer', 'category', 'furniture'), evidence('chair', 'block', 'catalogItem', 'chair', 'seating'), evidence('stool', 'block', 'catalogItem', 'stool', 'seating')];
  const first = fuseEvidence(observations, undefined, null, objectContext);
  const second = fuseEvidence([...observations].reverse(), undefined, null, objectContext);
  assert.deepEqual(second, first);
  assert.deepEqual(first.category.value, 'seating');
  assert.equal(first.catalogItem.value, null);
  assert.equal(first.catalogItem.state, 'abstained');
  assert.equal(first.catalogItem.conflict.candidateValues.join(','), 'chair,stool');
  assert.equal(first.conflicts.length, 1);
});

test('approved scoped mapping outranks weak evidence and does not cross project/storey scope', () => {
  const snapshot = mappingSnapshot([{ id: 'mapping-1', version: 1, status: 'approved', scope: { projectId: 'project-1', storeyId: 'storey-1', layerPattern: 'A-FURN', blockPattern: 'CHAIR' }, target: { category: 'seating', catalogItem: 'chair' } }]);
  const resolved = fuseEvidence([evidence('model', 'model-proposal', 'catalogItem', 'stool', 'seating')], undefined, snapshot, objectContext);
  assert.equal(resolved.catalogItem.value, 'chair');
  assert.ok(resolved.evidence.some((item) => item.kind === 'approved-mapping'));
  const outOfScope = fuseEvidence([evidence('model', 'model-proposal', 'catalogItem', 'stool', 'seating')], undefined, snapshot, { ...objectContext, projectId: 'project-2', sourceObject: { ...objectContext.sourceObject, projectId: 'project-2' } });
  assert.equal(outOfScope.catalogItem.value, null);
  assert.equal(outOfScope.catalogItem.state, 'unresolved');
});

test('conflicting approvals abstain once while one scoped mapping resolves every matching object', () => {
  const approved = mappingSnapshot([{ id: 'mapping-chair', version: 1, status: 'approved', scope: { projectId: 'project-1', layerPattern: 'A-FURN', blockPattern: 'CHAIR' }, target: { category: 'seating', catalogItem: 'chair' } }]);
  for (const sourceObjectId of ['object-1', 'object-2']) {
    const sourceObject = { sourceObjectId, entity: { layer: 'A-FURN', block: 'CHAIR' }, projectId: 'project-1' };
    const result = fuseEvidence([], undefined, approved, { sourceObjectId, sourceObject, projectId: 'project-1' });
    assert.equal(result.category.value, 'seating'); assert.equal(result.catalogItem.value, 'chair');
  }

  const conflicting = mappingSnapshot([
    { id: 'mapping-chair', version: 1, status: 'approved', scope: { projectId: 'project-1', layerPattern: 'A-FURN', blockPattern: 'CHAIR' }, target: { category: 'seating', catalogItem: 'chair' } },
    { id: 'mapping-stool', version: 1, status: 'approved', scope: { projectId: 'project-1', layerPattern: 'A-FURN', blockPattern: 'CHAIR' }, target: { category: 'seating', catalogItem: 'stool' } }
  ]);
  const result = fuseEvidence([], undefined, conflicting, objectContext);
  assert.equal(result.category.value, 'seating'); assert.equal(result.catalogItem.state, 'abstained');
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].class, 'high-trust-conflict');
});

test('application captures mapping snapshot and evidence metadata on BOQ lines', () => {
  const app = createApplication({ schedule: (callback) => callback() });
  const project = app.createProject({ name: 'Classification project' });
  const draft = app.createStudioMapping({ projectId: project.id, scope: { layerPattern: 'A-FURN', blockPattern: 'CHAIR' }, target: { category: 'seating', catalogItem: 'chair' } });
  const approved = app.approveStudioMapping(draft.id);
  const source = app.createSourceDocument({ filename: 'clean.dxf', content: require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'clean-plan.dxf'), 'utf8'), projectId: project.id });
  const run = app.startProcessing(source.id);
  assert.deepEqual(run.mappingSnapshot.mappingIds, [approved.id]);
  assert.ok(run.classifications.length > 0);
  assert.ok(run.boq.lines.every((line) => line.provenance.fusionVersion === 'evidence-fusion-v1'));
  assert.ok(run.boq.lines.some((line) => line.provenance.classificationEvidenceIds.length > 0));
});

test('mapping versions are immutable snapshots across approval and retirement', () => {
  const app = createApplication({ schedule: (callback) => callback() });
  const project = app.createProject({ name: 'Lifecycle project' });
  const firstDraft = app.createStudioMapping({ projectId: project.id, scope: { layerPattern: 'A-FURN' }, target: { category: 'furniture', catalogItem: 'chair' } });
  const first = app.approveStudioMapping(firstDraft.id);
  const source = app.createSourceDocument({ filename: 'clean.dxf', content: require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'clean-plan.dxf'), 'utf8'), projectId: project.id });
  const runA = app.startProcessing(source.id);
  const retired = app.retireStudioMapping(first.id);
  const runB = app.startProcessing(source.id);
  assert.deepEqual(runA.mappingSnapshot.mappingIds, [first.id]);
  assert.deepEqual(runB.mappingSnapshot.mappingIds, []);
  assert.equal(retired.status, 'retired');
  assert.equal(first.status, 'approved');

  const replacementDraft = app.createStudioMapping({ projectId: project.id, scope: { layerPattern: 'A-FURN' }, target: { category: 'furniture', catalogItem: 'stool' } });
  const replacement = app.approveStudioMapping(replacementDraft.id);
  assert.equal(replacement.version, 3);
  assert.equal(replacement.supersedes, retired.id);
});

test('a new approved version supersedes the old mapping only for future runs', () => {
  const app = createApplication({ schedule: (callback) => callback() });
  const project = app.createProject({ name: 'Versioned mapping project' });
  const scope = { layerPattern: 'A-FURN', blockPattern: 'CHAIR' };
  const firstDraft = app.createStudioMapping({ projectId: project.id, scope, target: { category: 'seating', catalogItem: 'chair' } });
  const first = app.approveStudioMapping(firstDraft.id);
  const source = app.createSourceDocument({ filename: 'clean.dxf', content: require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'clean-plan.dxf'), 'utf8'), projectId: project.id });
  const runA = app.startProcessing(source.id);
  const secondDraft = app.createStudioMapping({ projectId: project.id, scope: { blockPattern: 'CHAIR', layerPattern: 'A-FURN' }, target: { category: 'seating', catalogItem: 'stool' } });
  const second = app.approveStudioMapping(secondDraft.id);
  const runB = app.startProcessing(source.id);
  assert.deepEqual(runA.mappingSnapshot.mappingIds, [first.id]);
  assert.deepEqual(runB.mappingSnapshot.mappingIds, [second.id]);
  assert.equal(second.version, 2); assert.equal(second.supersedes, first.id);
  assert.throws(() => app.approveStudioMapping(secondDraft.id), /unused draft/i);
});

test('mapping input is bounded, signature-scoped, studio-safe, and returned data is immutable', () => {
  const app = createApplication({ schedule: (callback) => callback() });
  const project = app.createProject({ name: 'Safe mapping project' });
  assert.throws(() => app.createStudioMapping({ projectId: project.id, scope: {}, target: { category: 'seating' } }), /exact layer, block, schedule, or source-type signature/i);
  assert.throws(() => app.createStudioMapping({ projectId: project.id, scope: { layerPattern: 'A-FURN' }, target: { category: {} } }), /bounded non-empty string/i);

  const snapshot = mappingSnapshot([{ id: 'studio-map', version: 1, status: 'approved', studioId: 'studio-a', scope: { layerPattern: 'A-FURN', blockPattern: 'CHAIR' }, target: { category: 'seating', catalogItem: 'chair' } }]);
  const foreign = fuseEvidence([], undefined, snapshot, { ...objectContext, studioId: 'studio-b', sourceObject: { ...objectContext.sourceObject, studioId: 'studio-b' } });
  assert.equal(foreign.catalogItem.value, null);

  const draft = app.createStudioMapping({ projectId: project.id, scope: { layerPattern: 'A-FURN' }, target: { category: 'furniture' } });
  app.approveStudioMapping(draft.id);
  const source = app.createSourceDocument({ filename: 'clean.dxf', content: require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'clean-plan.dxf'), 'utf8'), projectId: project.id });
  const run = app.startProcessing(source.id);
  const firstRead = app.getClassifications(run.id); firstRead.classifications[0].evidence.length = 0; firstRead.mappingSnapshot.mappingIds.length = 0;
  const secondRead = app.getClassifications(run.id);
  assert.ok(secondRead.classifications[0].evidence.length > 0); assert.equal(secondRead.mappingSnapshot.mappingIds.length, 1);
});

test('repeated equivalent conflicts share one stable group and list every affected object', () => {
  const make = (sourceObjectId) => ({ ...fuseEvidence([
    { ...evidence(`${sourceObjectId}:chair`, 'block', 'catalogItem', 'chair', 'seating'), sourceObjectId, source: { authority: 'native', quality: 'verified', reference: { sourceObjectId } } },
    { ...evidence(`${sourceObjectId}:stool`, 'block', 'catalogItem', 'stool', 'seating'), sourceObjectId, source: { authority: 'native', quality: 'verified', reference: { sourceObjectId } } }
  ], undefined, null, { sourceObjectId, sourceObject: { id: sourceObjectId, layer: 'A-FURN', block: 'SEAT', type: 'INSERT' } }), sourceObject: { id: sourceObjectId, layer: 'A-FURN', block: 'SEAT', type: 'INSERT', sourceSheet: 'A-101' } });
  const grouped = groupClassificationConflicts([make('object-2'), make('object-1')]);
  assert.equal(grouped[0].conflicts[0].groupKey, grouped[1].conflicts[0].groupKey);
  assert.equal(grouped[0].catalogItem.conflict.groupKey, grouped[0].conflicts[0].groupKey);
  assert.deepEqual(grouped[0].conflicts[0].affectedSourceObjectIds, ['object-1', 'object-2']);
  assert.deepEqual(grouped[0].conflicts[0].evidenceIds, ['object-1:chair', 'object-1:stool']);
  assert.deepEqual(grouped[0].conflicts[0].groupedEvidenceIds, ['object-1:chair', 'object-1:stool', 'object-2:chair', 'object-2:stool']);
  assert.equal(blockCategory('STOOL_01'), 'furniture');
});

test('rejected and suppressed evidence stays auditable but cannot affect a decision', () => {
  const result = fuseEvidence([
    evidence('accepted-chair', 'block', 'catalogItem', 'chair', 'seating'),
    { ...evidence('rejected-stool', 'approved-mapping', 'catalogItem', 'stool', 'seating'), status: 'rejected' },
    { ...evidence('suppressed-sofa', 'approved-mapping', 'catalogItem', 'sofa', 'seating'), status: 'suppressed' }
  ], undefined, null, objectContext);
  assert.equal(result.catalogItem.value, 'chair');
  assert.equal(result.catalogItem.state, 'resolved');
  assert.deepEqual(result.catalogItem.winningEvidenceIds, ['accepted-chair']);
  assert.deepEqual(result.evidence.map((item) => item.id), ['accepted-chair', 'rejected-stool', 'suppressed-sofa']);
});
