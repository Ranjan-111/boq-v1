const { createHash } = require('node:crypto');

const FUSION_VERSION = 'evidence-fusion-v1';
const ONTOLOGY_VERSION = 'ontology-v1';
const MAPPING_SNAPSHOT_VERSION = 'mapping-snapshot-v1';
const TRUST = Object.freeze({
  'approved-mapping': 100,
  'approved-profile': 90,
  schedule: 70,
  block: 60,
  layer: 50,
  hatch: 40,
  geometry: 40,
  'native-text': 40,
  'human-confirmed': 90,
  ocr: 10,
  'model-proposal': 10
});
const POLICY = Object.freeze({
  version: FUSION_VERSION,
  trust: TRUST,
  qualityAdjustment: Object.freeze({ verified: 0, normal: -5, degraded: -15 }),
  // OCR/model proposals remain proposals when they are the only signal.
  // A verified deterministic geometry signal is the weakest auto-resolving tier.
  minimumWinningTrust: 40,
  winningMargin: 10
});
const DEFAULT_ONTOLOGY = Object.freeze({
  furniture: null,
  seating: 'furniture',
  chair: 'seating',
  stool: 'seating',
  sofa: 'seating',
  table: 'furniture',
  bed: 'furniture',
  door: null,
  window: null,
  wall: null,
  room: null
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function digest(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
function canonical(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}
function ancestor(value, ontology = DEFAULT_ONTOLOGY) {
  const result = [];
  let current = canonical(value);
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = ontology[current] ? canonical(ontology[current]) : null;
  }
  return result;
}
function sourceSignature(sourceObject = {}) {
  const entity = sourceObject.entity || sourceObject;
  return {
    layer: canonical(entity.layer || sourceObject.layer),
    block: canonical(entity.block || sourceObject.block),
    type: canonical(entity.type || sourceObject.type),
    scheduleCode: canonical(sourceObject.scheduleCode || entity.scheduleCode),
    sourceSheet: canonical(sourceObject.sourceSheet),
    sourceObjectId: sourceObject.sourceObjectId || sourceObject.id || null
  };
}
function scopeOf(sourceObject = {}, fallback = {}) {
  return {
    studioId: sourceObject.studioId ?? fallback.studioId ?? null,
    projectId: sourceObject.projectId ?? fallback.projectId ?? null,
    buildingId: sourceObject.buildingId ?? fallback.buildingId ?? null,
    storeyId: sourceObject.storeyId ?? fallback.storeyId ?? null,
    sourceSheet: sourceObject.sourceSheet ?? fallback.sourceSheet ?? null
  };
}
function patternMatches(value, pattern) {
  if (pattern === undefined || pattern === null || pattern === '') return true;
  const actual = canonical(value);
  const expected = canonical(pattern);
  if (expected === '*' || expected === 'any') return true;
  return actual === expected;
}
function mappingScopeMatches(mapping, sourceObject = {}, context = {}) {
  const scope = mapping?.scope || {};
  const current = scopeOf(sourceObject, context);
  const signature = sourceSignature(sourceObject);
  const effectiveStudioId = mapping?.studioId ?? scope.studioId;
  return (effectiveStudioId === undefined || effectiveStudioId === null || effectiveStudioId === current.studioId)
    && ['projectId', 'buildingId', 'storeyId'].every((key) => scope[key] === undefined || scope[key] === null || scope[key] === current[key])
    && patternMatches(current.sourceSheet, scope.sourceSheetPattern ?? scope.sourceSheet)
    && patternMatches(signature.layer, scope.layerPattern)
    && patternMatches(signature.block, scope.blockPattern)
    && patternMatches(signature.scheduleCode, scope.scheduleCode)
    && (!scope.type || patternMatches(signature.type, scope.type));
}
function mappingSnapshot(mappings = []) {
  const approved = mappings.filter((mapping) => mapping.status === 'approved').map((mapping) => ({ ...mapping, scope: { ...(mapping.scope || {}) }, target: { ...(mapping.target || {}) } })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const content = approved.map(({ contentHash, ...mapping }) => mapping);
  return { version: MAPPING_SNAPSHOT_VERSION, mappingIds: approved.map((mapping) => mapping.id), mappingVersions: approved.map((mapping) => ({ id: mapping.id, version: mapping.version, contentHash: mapping.contentHash || digest(mapping) })), mappings: approved, digest: digest(content) };
}
function normalizeEvidence(observation = {}, context = {}, ontology = DEFAULT_ONTOLOGY) {
  const candidate = observation.candidate && typeof observation.candidate === 'object' ? observation.candidate : { value: observation.candidate };
  const value = canonical(candidate.value);
  const categoryAncestor = canonical(candidate.categoryAncestor || ancestor(value, ontology)[1] || '') || null;
  const sourceObjectId = observation.sourceObjectId || observation.source?.reference?.sourceObjectId || context.sourceObjectId || null;
  const scope = { ...scopeOf(observation.scope || {}, context), ...(observation.scope || {}) };
  const normalized = {
    id: observation.id || null,
    kind: observation.kind || 'geometry',
    dimension: observation.dimension || 'category',
    candidate: { value, categoryAncestor },
    source: {
      authority: observation.source?.authority || (observation.kind === 'model-proposal' ? 'model' : 'native'),
      quality: observation.source?.quality || 'normal',
      reference: { ...(observation.source?.reference || {}), sourceObjectId }
    },
    scope,
    sourceDocumentId: observation.sourceDocumentId ?? context.sourceDocumentId ?? null,
    sourceDocumentVersion: observation.sourceDocumentVersion ?? context.sourceDocumentVersion ?? null,
    contentSha256: observation.contentSha256 ?? context.contentSha256 ?? null,
    processingRunId: observation.processingRunId ?? context.processingRunId ?? null,
    status: observation.status || 'observed',
    fusionVersion: observation.fusionVersion || FUSION_VERSION,
    ruleVersion: observation.ruleVersion || observation.fusionVersion || FUSION_VERSION,
    profileVersion: observation.profileVersion ?? null,
    mappingSnapshotId: observation.mappingSnapshotId || context.mappingSnapshotId || null,
    createdAt: observation.createdAt || null
  };
  normalized.trust = scoreEvidence(normalized);
  normalized.id = normalized.id || `evidence_${digest({ ...normalized, id: undefined })}`.slice(0, 24);
  return normalized;
}
function scoreEvidence(evidence) {
  const base = POLICY.trust[evidence.kind] ?? 0;
  const adjustment = POLICY.qualityAdjustment[evidence.source?.quality || 'normal'] ?? 0;
  return base + adjustment;
}
function conflictKey(decision, evidence, sourceObjectIds, mappingSnapshotId) {
  return `conflict_${digest({ class: decision.class, scope: evidence.map((item) => item.scope).sort((a, b) => stable(a).localeCompare(stable(b)))[0] || null, sourceObjectIds: [...new Set(sourceObjectIds)].sort(), candidates: decision.candidateValues.slice().sort(), evidenceIds: evidence.map((item) => item.id).sort(), fusionVersion: FUSION_VERSION, mappingSnapshotId: mappingSnapshotId || null }).slice(0, 24)}`;
}
function decisionFor(dimension, evidence, sourceObjectIds, mappingSnapshotId) {
  const eligibleEvidence = evidence.filter((item) => !['rejected', 'suppressed'].includes(item.status));
  const candidateEvidence = new Map();
  for (const item of eligibleEvidence) {
    const values = dimension === 'category' && item.dimension === 'catalogItem'
      ? [item.candidate.categoryAncestor]
      : [item.candidate.value];
    if (item.dimension !== dimension && !(dimension === 'category' && item.dimension === 'catalogItem')) continue;
    for (const value of values.filter(Boolean)) {
      if (!candidateEvidence.has(value)) candidateEvidence.set(value, []);
      candidateEvidence.get(value).push(item);
    }
  }
  const candidateScores = [...candidateEvidence.entries()].map(([value, refs]) => ({ value, score: Math.max(...refs.map(scoreEvidence)), evidenceIds: refs.map((ref) => ref.id).sort() })).sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
  const winner = candidateScores[0];
  const candidateValues = candidateScores.map((item) => item.value);
  const allIds = eligibleEvidence.map((item) => item.id).sort();
  const base = { dimension, value: null, state: 'unresolved', winningEvidenceIds: [], candidateScores, conflict: null, fusionVersion: FUSION_VERSION, mappingSnapshotId: mappingSnapshotId || null };
  if (!winner || winner.score < POLICY.minimumWinningTrust) {
    base.conflict = { class: 'missing', groupKey: conflictKey({ class: 'missing', candidateValues }, eligibleEvidence, sourceObjectIds, mappingSnapshotId), candidateValues, evidenceIds: allIds };
    return base;
  }
  const tied = candidateScores.filter((item) => item.score === winner.score);
  const runner = candidateScores[1];
  if (tied.length > 1 || (runner && winner.score - runner.score < POLICY.winningMargin)) {
    const conflictClass = tied.length > 1 && winner.score >= TRUST['approved-profile'] ? 'high-trust-conflict' : 'tie';
    base.state = 'abstained';
    base.conflict = { class: conflictClass, groupKey: conflictKey({ class: conflictClass, candidateValues }, eligibleEvidence.filter((item) => tied.some((entry) => entry.value === item.candidate.value || entry.value === item.candidate.categoryAncestor)), sourceObjectIds, mappingSnapshotId), candidateValues: tied.length > 1 ? tied.map((item) => item.value) : candidateValues.slice(0, 2), evidenceIds: allIds };
    return base;
  }
  base.value = winner.value;
  base.state = 'resolved';
  base.winningEvidenceIds = winner.evidenceIds;
  return base;
}
function fuseEvidence(inputEvidence = [], ontology = DEFAULT_ONTOLOGY, snapshot = null, context = {}) {
  const sourceObjectId = context.sourceObjectId || inputEvidence[0]?.sourceObjectId || inputEvidence[0]?.source?.reference?.sourceObjectId || null;
  const sourceObjectIds = context.sourceObjectIds || (sourceObjectId ? [sourceObjectId] : inputEvidence.map((item) => item.sourceObjectId).filter(Boolean));
  const mappingId = snapshot?.digest || snapshot?.id || context.mappingSnapshotId || null;
  const normalized = inputEvidence.map((item) => normalizeEvidence(item, context, ontology));
  const mappings = Array.isArray(snapshot) ? snapshot : snapshot?.mappings || [];
  for (const mapping of mappings) {
    const target = mapping.target || {};
    if (mapping.status !== 'approved' || !mappingScopeMatches(mapping, context.sourceObject || context, context)) continue;
    if (target.category) normalized.push(normalizeEvidence({ id: `${mapping.id}:${sourceObjectId}:category`, kind: 'approved-mapping', dimension: 'category', candidate: { value: target.category }, source: { authority: 'approved', quality: 'verified', reference: { sourceObjectId } }, scope: mapping.scope, mappingSnapshotId: mapping.id, profileVersion: mapping.version, fusionVersion: FUSION_VERSION }, context, ontology));
    if (target.catalogItem) normalized.push(normalizeEvidence({ id: `${mapping.id}:${sourceObjectId}:item`, kind: 'approved-mapping', dimension: 'catalogItem', candidate: { value: target.catalogItem, categoryAncestor: target.category }, source: { authority: 'approved', quality: 'verified', reference: { sourceObjectId } }, scope: mapping.scope, mappingSnapshotId: mapping.id, profileVersion: mapping.version, fusionVersion: FUSION_VERSION }, context, ontology));
  }
  const deduped = [...new Map(normalized.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const categoryEvidence = deduped.filter((item) => item.dimension === 'category' || item.dimension === 'catalogItem');
  const itemEvidence = deduped.filter((item) => item.dimension === 'catalogItem');
  const category = decisionFor('category', categoryEvidence, sourceObjectIds, mappingId);
  const catalogItem = decisionFor('catalogItem', itemEvidence, sourceObjectIds, mappingId);
  const conflictDecisions = [category, catalogItem].filter((decision) => decision.conflict && decision.conflict.class !== 'missing');
  return {
    sourceObjectId,
    category,
    catalogItem,
    evidence: deduped,
    conflict: conflictDecisions[0]?.conflict || null,
    conflicts: conflictDecisions.map((decision) => ({ dimension: decision.dimension, ...decision.conflict })),
    fusionVersion: FUSION_VERSION,
    ontologyVersion: ONTOLOGY_VERSION,
    mappingSnapshot: snapshot ? { version: snapshot.version, mappingIds: snapshot.mappingIds, mappingVersions: snapshot.mappingVersions || [], digest: snapshot.digest } : { version: MAPPING_SNAPSHOT_VERSION, mappingIds: [], mappingVersions: [], digest: null }
  };
}

function groupClassificationConflicts(classifications = []) {
  const ordered = classifications.map((classification) => structuredClone(classification)).sort((left, right) => String(left.sourceObjectId).localeCompare(String(right.sourceObjectId)));
  const groups = new Map();
  for (const classification of ordered) for (const conflict of classification.conflicts || []) {
    const evidenceById = new Map((classification.evidence || []).map((item) => [item.id, item]));
    const evidenceShape = (conflict.evidenceIds || []).map((id) => evidenceById.get(id)).filter(Boolean).map((item) => ({ kind: item.kind, dimension: item.dimension, candidate: item.candidate, trust: item.trust, mappingSnapshotId: item.mappingSnapshotId, scope: item.scope })).sort((a, b) => stable(a).localeCompare(stable(b)));
    const { sourceObjectId: ignoredSourceObjectId, ...semanticSourceSignature } = sourceSignature(classification.sourceObject || {});
    const signature = digest({ class: conflict.class, dimension: conflict.dimension, candidateValues: [...conflict.candidateValues].sort(), evidenceShape, sourceSignature: semanticSourceSignature, fusionVersion: classification.fusionVersion, mappingSnapshotDigest: classification.mappingSnapshot?.digest || null });
    const group = groups.get(signature) || { members: [], sourceObjectIds: new Set(), evidenceIds: new Set() };
    group.members.push({ classification, conflict }); group.sourceObjectIds.add(classification.sourceObjectId); (conflict.evidenceIds || []).forEach((id) => group.evidenceIds.add(id)); groups.set(signature, group);
  }
  for (const [signature, group] of groups) {
    const affectedSourceObjectIds = [...group.sourceObjectIds].sort(); const groupedEvidenceIds = [...group.evidenceIds].sort();
    const groupKey = `conflict_${digest({ signature, affectedSourceObjectIds, fusionVersion: FUSION_VERSION }).slice(0, 24)}`;
    for (const { classification, conflict } of group.members) {
      const priorGroupKey = conflict.groupKey;
      Object.assign(conflict, { groupKey, affectedSourceObjectIds, groupedEvidenceIds });
      if (classification.conflict?.groupKey === priorGroupKey) classification.conflict = { ...conflict };
      for (const decision of [classification.category, classification.catalogItem]) {
        if (decision?.conflict?.groupKey === priorGroupKey) decision.conflict = { ...conflict };
      }
    }
  }
  return ordered;
}

module.exports = { FUSION_VERSION, ONTOLOGY_VERSION, POLICY, TRUST, DEFAULT_ONTOLOGY, stable, digest, canonical, ancestor, sourceSignature, patternMatches, mappingScopeMatches, mappingSnapshot, normalizeEvidence, fuseEvidence, groupClassificationConflicts };
