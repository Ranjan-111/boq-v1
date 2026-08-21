const { createHash } = require('node:crypto');
const { DXF_VERSIONS, inspectDxf, measureDxf, UNIT_DEFINITIONS, layerCategory, blockCategory, placeBlockGeometry, InputError } = require('./dxf');
const { FUSION_VERSION, canonical, digest, patternMatches, mappingSnapshot, fuseEvidence, groupClassificationConflicts } = require('./classification');
const { asBytes, sniffContent } = require('./ingestion/sniff');
const { inspectPdf, PDF_VERSIONS } = require('./ingestion/pdf');
const { inspectRaster, RASTER_VERSIONS } = require('./ingestion/raster');
const { LIMITS, LimitError } = require('./ingestion/limits');
const { OCR_LIMITS, normalizeOcrResults, presentOcrBatch } = require('./ocr-results');
const { createSourceObject, createContribution, buildProvenance, measurementStatusFor, signedSum, PROVENANCE_VERSION } = require('./provenance');
const { createRepository } = require('./repository');
const { createVisionService, residualsFor, splitCounts } = require('./vision');
const { coerceBoxes, boxToPolygon } = require('./vision/contract');
const { exceptionsForRun, groupExceptions, createImpactRanker } = require('./exceptions');
const { createRateBook, priceLine, totalOf, isStale, findRate, RateError } = require('./rates');
const { createVendorOffer, eligibleOffers, VendorError } = require('./vendors');
const { createCatalogue, applyCatalogue, itemsFor, CatalogueError } = require('./catalogue');
const { buildArtefact, encode, encodeProvenance, tierOf, ExportError, FORMATS } = require('./export');
const { lineEvidence, objectLines, fitViewport, signedBreakdown } = require('./workspace');
const { normalizeAssumptions, getRuleset, listRulesets, ASSUMPTION_DEFINITIONS, DEFAULT_ASSUMPTIONS, DEFAULT_RULESET_VERSION, RuleError } = require('./rules');

const VERSIONS = DXF_VERSIONS;
const PROCESSING_STAGE_DELAY_MS = 150;

function createApplication({ schedule = setTimeout, file = ':memory:', repository = createRepository({ file }), hydrateRunLimit = 200, vision = createVisionService(), rateSource = null } = {}) {
  /* SQLite is the system of record. The maps below are a working set that is
     written through on every state transition and rehydrated from the store on
     construction -- one code path, not an in-memory alternative. Rollups, the
     one genuinely set-shaped read, go to SQL directly. */
  const sourceDocuments = new Map();
  const runs = new Map();
  const projects = new Map();
  const buildings = new Map();
  const storeys = new Map();
  const boqVersions = new Map();
  const studioMappings = new Map();
  const retiredMappingIds = new Set();
  const approvedDraftIds = new Set();
  let sourceSequence = 0;
  let runSequence = 0;
  let projectSequence = 0;
  let buildingSequence = 0;
  let storeySequence = 0;
  let boqVersionSequence = 0;
  let mappingSequence = 0;
  let resolutionSequence = 0;
  let offerSequence = 0;

  const TRANSIENT_RUN_FIELDS = ['parsedDocument'];
  function persistRun(run) {
    /* A run's trailing write can land after the owning store was deliberately
       closed. Dropping it then is intended -- closing the store ends the
       session -- and must not surface as an unhandled rejection. */
    if (!run || (repository.isOpen && !repository.isOpen())) return;
    const record = { ...run };
    for (const field of TRANSIENT_RUN_FIELDS) delete record[field];
    repository.saveRun(record);
  }
  function persistDocument(document) { if (document) repository.saveSourceDocument(document); }
  function persistScopeOf(document) {
    if (document.storeyId && storeys.has(document.storeyId)) persistStorey(storeys.get(document.storeyId));
    if (document.buildingId && buildings.has(document.buildingId)) persistBuilding(buildings.get(document.buildingId));
    if (document.projectId && projects.has(document.projectId)) persistProject(projects.get(document.projectId));
  }
  function persistProject(project) { repository.saveEntity('projects', project.id, { name: project.name, version: project.version, current_boq_version_id: project.currentBoqVersionId ?? null }, project); }
  function persistBuilding(building) { repository.saveEntity('buildings', building.id, { project_id: building.projectId, name: building.name, version: building.version }, building); }
  function persistStorey(storey) { repository.saveEntity('storeys', storey.id, { building_id: storey.buildingId, project_id: storey.projectId, name: storey.name, level: storey.level ?? null, version: storey.version }, storey); }
  function persistBoqVersion(version) { repository.saveEntity('boq_versions', version.id, { project_id: version.projectId, version: version.version, label: version.label ?? null, status: version.status }, version); }

  function persistMapping(mapping) {
    repository.saveStudioMapping(mapping, { retired: retiredMappingIds.has(mapping.id), usedAsDraft: approvedDraftIds.has(mapping.id) });
  }

  function hydrate() {
    const sequenceOf = (id) => Number.parseInt(String(id).split('_').at(-1), 10) || 0;
    for (const project of repository.allEntities('projects')) { projects.set(project.id, project); projectSequence = Math.max(projectSequence, sequenceOf(project.id)); }
    for (const building of repository.allEntities('buildings')) { buildings.set(building.id, building); buildingSequence = Math.max(buildingSequence, sequenceOf(building.id)); }
    for (const storey of repository.allEntities('storeys')) { storeys.set(storey.id, storey); storeySequence = Math.max(storeySequence, sequenceOf(storey.id)); }
    for (const version of repository.allEntities('boq_versions')) { boqVersions.set(version.id, version); boqVersionSequence = Math.max(boqVersionSequence, sequenceOf(version.id)); }
    for (const document of repository.allSourceDocuments()) { sourceDocuments.set(document.id, document); sourceSequence = Math.max(sourceSequence, sequenceOf(document.id)); }
    for (const { mapping, retired, usedAsDraft } of repository.allStudioMappings()) {
      studioMappings.set(mapping.id, mapping);
      if (retired) retiredMappingIds.add(mapping.id);
      if (usedAsDraft) approvedDraftIds.add(mapping.id);
      mappingSequence = Math.max(mappingSequence, sequenceOf(mapping.id));
    }
    /* Bounded: the most recent window of runs, batch-loaded. Startup must not
       get slower every time the project processes another drawing. Anything
       outside the window is fetched on demand by loadRun. */
    runSequence = Math.max(runSequence, repository.countRuns());
    for (const run of repository.getRuns(repository.recentRunIds(hydrateRunLimit))) {
      if (run) { runs.set(run.id, run); runSequence = Math.max(runSequence, sequenceOf(run.id)); }
    }
  }

  /* One code path for reading a run: the working set is a cache of the store,
     not an alternative to it. */
  function loadRun(runId) {
    if (runs.has(runId)) return runs.get(runId);
    const stored = repository.getRun(runId);
    if (!stored) return undefined;
    runs.set(runId, stored);
    return stored;
  }
  hydrate();

  function requireProject(projectId) {
    const project = projects.get(projectId);
    if (!project) throw new NotFoundError('Project not found.');
    return project;
  }
  function requireBoqVersion(projectId, boqVersionId) {
    const version = boqVersions.get(boqVersionId);
    if (!version || version.projectId !== projectId) throw new InputError('The requested BOQ version does not belong to this project.');
    return version;
  }
  function requireBuilding(buildingId) {
    const building = buildings.get(buildingId);
    if (!building) throw new NotFoundError('Building not found.');
    return building;
  }
  function requireStorey(storeyId) {
    const storey = storeys.get(storeyId);
    if (!storey) throw new NotFoundError('Storey not found.');
    return storey;
  }
  function validateAssignment({ projectId, buildingId, storeyId, sourceSheet, boqVersionId, typicalMultiplier = 1, studioId = null }) {
    if (!projectId && !buildingId && !storeyId && boqVersionId) throw new InputError('A source assignment requires a project.');
    const storey = storeyId ? requireStorey(storeyId) : null;
    const building = buildingId ? requireBuilding(buildingId) : storey ? requireBuilding(storey.buildingId) : null;
    const project = projectId ? requireProject(projectId) : building ? requireProject(building.projectId) : null;
    if (building && building.projectId !== project?.id) throw new InputError('The building does not belong to the selected project.');
    if (storey && (!building || storey.buildingId !== building.id)) throw new InputError('The storey does not belong to the selected building.');
    const multiplier = Number(typicalMultiplier);
    if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > LIMITS.typicalMultiplierMax) throw new InputError(`Typical-storey multiplier must be an explicit integer between 1 and ${LIMITS.typicalMultiplierMax}.`);
    if (multiplier > 1 && !storey) throw new InputError('A typical-storey multiplier greater than one requires a storey assignment.');
    if (boqVersionId) {
      const boqVersion = boqVersions.get(boqVersionId);
      if (!boqVersion || boqVersion.projectId !== project?.id) throw new InputError('The BOQ version does not belong to the selected project.');
    }
    return { studioId: studioId || null, projectId: project?.id || null, buildingId: building?.id || null, storeyId: storey?.id || null, sourceSheet: String(sourceSheet || '').trim() || null, boqVersionId: boqVersionId || project?.currentBoqVersionId || null, typicalMultiplier: multiplier };
  }
  function addAssignmentReference(sourceDocument) {
    if (sourceDocument.storeyId) storeys.get(sourceDocument.storeyId).sourceDocumentIds.push(sourceDocument.id);
    else if (sourceDocument.buildingId) buildings.get(sourceDocument.buildingId).sourceDocumentIds.push(sourceDocument.id);
    else if (sourceDocument.projectId) projects.get(sourceDocument.projectId).sourceDocumentIds.push(sourceDocument.id);
  }
  function removeAssignmentReference(sourceDocument) {
    if (sourceDocument.storeyId) removeValue(storeys.get(sourceDocument.storeyId).sourceDocumentIds, sourceDocument.id);
    else if (sourceDocument.buildingId) removeValue(buildings.get(sourceDocument.buildingId).sourceDocumentIds, sourceDocument.id);
    else if (sourceDocument.projectId) removeValue(projects.get(sourceDocument.projectId).sourceDocumentIds, sourceDocument.id);
  }
  function assignmentSnapshot(sourceDocument, resolvedBoqVersionId = sourceDocument.boqVersionId) {
    return {
      studioId: sourceDocument.studioId || null,
      projectId: sourceDocument.projectId,
      buildingId: sourceDocument.buildingId,
      storeyId: sourceDocument.storeyId,
      sourceSheet: sourceDocument.sourceSheet,
      sourceDocumentId: sourceDocument.id,
      sourceDocumentVersion: sourceDocument.version,
      contentSha256: sourceDocument.contentSha256,
      sourceBoqVersionId: sourceDocument.boqVersionId,
      boqVersionId: resolvedBoqVersionId,
      typicalMultiplier: sourceDocument.typicalMultiplier
    };
  }
  function invalidateRuns(sourceDocumentId) {
    for (const run of runs.values()) {
      if (run.sourceDocumentId === sourceDocumentId && ['ingestion', 'awaiting_setup', 'awaiting_calibration', 'awaiting_trace', 'awaiting_confirmation', 'measurement', 'boq', 'completed'].includes(run.status)) { run.superseded = true; persistRun(run); }
    }
  }

  function createProject({ name }) {
    if (!String(name || '').trim()) throw new InputError('A project name is required.');
    const project = { id: `project_${String(++projectSequence).padStart(4, '0')}`, name: String(name).trim(), version: 1, buildingIds: [], sourceDocumentIds: [], boqVersionIds: [], currentBoqVersionId: null,
      /* Assumptions are versioned rather than edited: a quantity measured under
         version 1 must stay reproducible after someone changes the wall height. */
      assumptions: { version: 1, values: { ...DEFAULT_ASSUMPTIONS }, history: [{ version: 1, at: new Date().toISOString(), reason: 'Defaults applied at project creation.', updatedBy: 'system', changed: {} }] },
      rulesetVersion: DEFAULT_RULESET_VERSION };
    projects.set(project.id, project);
    persistProject(project);
    project.currentBoqVersionId = createBoqVersion({ projectId: project.id, label: 'Initial BOQ' }).id;
    persistProject(project);
    repository.appendAudit({ kind: 'project_created', subjectId: project.id, payload: { name: project.name } });
    return presentProject(project);
  }

  function getProjectAssumptions(projectId) {
    const project = requireProject(projectId);
    return {
      version: project.assumptions.version,
      values: { ...project.assumptions.values },
      history: structuredClone(project.assumptions.history),
      rulesetVersion: project.rulesetVersion,
      currentBoqVersionId: project.currentBoqVersionId,
      definitions: structuredClone(ASSUMPTION_DEFINITIONS),
      availableRulesets: listRulesets()
    };
  }

  /* Changing an assumption or a ruleset changes what the drawing measures to.
     Both therefore re-measure every current source and cannot leave an earlier
     approval standing -- that approval was of a different number. */
  function updateProjectAssumptions(projectId, { values = {}, rulesetVersion, reason = '', updatedBy = 'operator' } = {}) {
    const project = requireProject(projectId);
    const nextRuleset = rulesetVersion === undefined ? project.rulesetVersion : getRuleset(rulesetVersion).version;
    const merged = normalizeAssumptions({ ...project.assumptions.values, ...values });
    const changed = {};
    for (const name of Object.keys(ASSUMPTION_DEFINITIONS)) {
      if (merged[name] !== project.assumptions.values[name]) changed[name] = { from: project.assumptions.values[name], to: merged[name] };
    }
    const rulesetChanged = nextRuleset !== project.rulesetVersion;
    if (!Object.keys(changed).length && !rulesetChanged) return getProjectAssumptions(projectId);

    project.assumptions = {
      version: project.assumptions.version + 1,
      values: { ...merged },
      history: [...project.assumptions.history, { version: project.assumptions.version + 1, at: new Date().toISOString(), reason: String(reason || ''), updatedBy: String(updatedBy || 'operator'), changed, rulesetVersion: nextRuleset }]
    };
    project.rulesetVersion = nextRuleset;
    persistProject(project);
    repository.appendAudit({ kind: 'project_assumptions_changed', subjectId: project.id, payload: { version: project.assumptions.version, changed, rulesetVersion: nextRuleset, reason, updatedBy } });

    const cause = [Object.keys(changed).length ? `assumption change (v${project.assumptions.version})` : null, rulesetChanged ? `ruleset change to ${nextRuleset}` : null].filter(Boolean).join(' and ');
    staleApprovalsFor(project, cause);
    remeasureProject(project);
    return getProjectAssumptions(projectId);
  }

  function staleApprovalsFor(project, cause) {
    for (const versionId of project.boqVersionIds) {
      const version = boqVersions.get(versionId);
      if (!version || version.status !== 'approved') continue;
      version.status = 'stale';
      version.staleReason = `Approved quantities no longer hold after a ${cause}.`;
      version.staleAt = new Date().toISOString();
      persistBoqVersion(version);
      repository.appendAudit({ kind: 'boq_version_approval_invalidated', subjectId: version.id, payload: { cause, approvedBy: version.approvedBy } });
    }
  }

  /* Re-measure every source currently assigned anywhere in the project. */
  function remeasureProject(project) {
    const scopedIds = new Set([
      ...project.sourceDocumentIds,
      ...project.buildingIds.flatMap((buildingId) => {
        const building = buildings.get(buildingId);
        return [...(building?.sourceDocumentIds || []), ...(building?.storeyIds.flatMap((storeyId) => storeys.get(storeyId)?.sourceDocumentIds || []) || [])];
      })
    ]);
    for (const sourceDocumentId of scopedIds) {
      if (!sourceDocuments.has(sourceDocumentId)) continue;
      /* The earlier runs measured a number this project no longer stands
         behind, so they are superseded rather than left to look current. */
      invalidateRuns(sourceDocumentId);
      startProcessing(sourceDocumentId);
    }
  }

  function approveBoqVersion(boqVersionId, { approvedBy = 'operator', reason = '', on = new Date().toISOString().slice(0, 10) } = {}) {
    const version = boqVersions.get(boqVersionId);
    if (!version) throw new NotFoundError('BOQ version not found.');
    const project = requireProject(version.projectId);
    if (version.status === 'approved') throw new ConflictError('This BOQ version is already approved.');
    /* `exportable` was found claiming a readiness the numbers could not back.
       `approved` must not acquire the same problem. */
    const queue = getExceptionQueue(project.id, { on });
    if (queue.counts.blocking > 0) {
      throw new ConflictError(`Cannot approve while ${queue.counts.blocking} blocking exception${queue.counts.blocking === 1 ? '' : 's'} remain open: ${queue.exceptions.filter((exception) => exception.severity === 'blocking').slice(0, 3).map((exception) => exception.title).join('; ')}.`);
    }
    version.status = 'approved';
    version.approvedBy = String(approvedBy || 'operator');
    version.approvedAt = new Date().toISOString();
    version.approvalReason = String(reason || '');
    version.approvedAssumptionsVersion = project.assumptions.version;
    version.approvedRulesetVersion = project.rulesetVersion;
    version.approvedRunIds = currentRunsFor(project).map((run) => run.id);
    version.approvedRateBookVersion = currentRateBook(project.id)?.version ?? null;
    version.approvedCatalogueVersion = currentCatalogue(project.id)?.version ?? null;
    /* The artefact is frozen here, not re-derived at export time. Re-deriving
       would make a delivered document depend on whatever has been published
       since; freezing is what makes a re-export byte-identical six months
       later. The versions above say what it was frozen from. */
    version.approvedSnapshot = freezeSnapshot(project, version, on);
    version.approvedAt = new Date().toISOString();
    delete version.staleReason;
    delete version.staleAt;
    persistBoqVersion(version);
    repository.appendAudit({ kind: 'boq_version_approved', subjectId: version.id, payload: { approvedBy: version.approvedBy, assumptionsVersion: version.approvedAssumptionsVersion, rulesetVersion: version.approvedRulesetVersion } });
    return { ...version };
  }

  /* --- reproducible exports (#17) -------------------------------------- */

  function freezeSnapshot(project, version, on) {
    const rollup = getProject(project.id).rollup;
    const priced = getPricedBoq(project.id, { on });
    const book = currentRateBook(project.id);
    const catalogue = currentCatalogue(project.id);
    const pricedByMeasurement = new Map(priced.lines.map((line) => [line.measurement, line]));
    const tiers = new Set();
    const lines = rollup.lines.map((line) => {
      const pricing = pricedByMeasurement.get(line.measurement) || {};
      const tier = tierOf(line, rollup.sourceObjects);
      tiers.add(tier.tier);
      return {
        measurement: line.measurement,
        itemCode: pricing.itemCode ?? line.measurement,
        description: pricing.description ?? null,
        unit: line.unit,
        quantity: line.measurementStatus === 'not_measurable' ? null : line.quantity,
        rate: pricing.rate?.amount ?? null,
        amount: Number.isFinite(pricing.amount) ? pricing.amount : null,
        measurementStatus: line.measurementStatus,
        pricingStatus: pricing.status ?? 'no_rate_book',
        rateSource: pricing.rate?.source ?? null,
        sortOrder: pricing.sortOrder ?? 1000,
        provenance: { contributions: structuredClone(line.provenance?.contributions || []) }
      };
    });
    return {
      boqVersionId: version.id,
      projectName: project.name,
      lines,
      sourceObjects: structuredClone(rollup.sourceObjects || []),
      catalogue: catalogue ? { id: catalogue.id, version: catalogue.version } : null,
      stamp: {
        approvedBy: version.approvedBy,
        approvedAt: version.approvedAt,
        rulesetVersion: project.rulesetVersion,
        assumptionsVersion: project.assumptions.version,
        rateBookVersion: book?.version ?? null,
        catalogueVersion: catalogue?.version ?? null,
        parserVersion: VERSIONS.parser,
        tiers: [...tiers].sort(),
        currency: book?.currency ?? null,
        pricedOn: on
      }
    };
  }

  /**
   * Export an approved BOQ version. Refuses a draft, refuses a stale approval,
   * and refuses if anything it depended on has been superseded since.
   */
  function exportBoq(boqVersionId, { format = 'csv' } = {}) {
    const version = boqVersions.get(boqVersionId);
    if (!version) throw new NotFoundError('BOQ version not found.');
    if (!FORMATS.includes(format)) throw new ExportError(`Unsupported export format "${format}". Supported: ${FORMATS.join(', ')}.`);
    if (version.status !== 'approved') {
      throw new ConflictError(version.status === 'stale'
        ? `This BOQ version is stale (${version.staleReason || 'a dependency changed'}). Re-approve it before exporting; an export must reflect an approval that still holds.`
        : 'Only an approved BOQ version can be exported. A draft has not been reviewed.');
    }
    if (!version.approvedSnapshot) throw new ConflictError('This approval predates reproducible exports and has no frozen snapshot. Re-approve it.');
    /* Belt and braces alongside the stale check: a run that produced an
       approved number must still be the current one. */
    const superseded = (version.approvedRunIds || []).filter((runId) => loadRun(runId)?.superseded);
    if (superseded.length) throw new ConflictError(`${superseded.length} run(s) this approval rests on have been superseded since. Re-approve before exporting.`);

    const artefact = buildArtefact(version.approvedSnapshot);
    return {
      boqVersionId, format,
      filename: `${version.id}-boq.${format}`,
      content: encode(artefact, format, version.approvedSnapshot),
      provenance: encodeProvenance(artefact, version.approvedSnapshot),
      artefact
    };
  }

  /* --- workspace (#14) -------------------------------------------------- */

  /* One rollup load serves the whole call. lineEvidence and objectLines are
     pure over what it returns, so neither is N+1 in contributions. */
  function getLineEvidence(projectId, measurement, options = {}) {
    const rollup = getProject(projectId).rollup;
    const line = rollup.lines.find((candidate) => candidate.measurement === measurement);
    if (!line) throw new NotFoundError(`No BOQ line for ${measurement} in this project.`);
    return { projectId, ...lineEvidence(line, rollup.sourceObjects, options) };
  }

  function getObjectLines(projectId, sourceObjectId) {
    const rollup = getProject(projectId).rollup;
    const result = objectLines(sourceObjectId, rollup.lines, rollup.sourceObjects);
    if (!result.object) throw new NotFoundError(`Source object ${sourceObjectId} not found in this project.`);
    return { projectId, ...result };
  }

  /* Queue traversal: one rollup load and one queue build per step, whatever the
     queue length, so working the queue is one screen with no hunting. */
  function getQueueStep(projectId, { index = 0, on = new Date().toISOString().slice(0, 10), margin } = {}) {
    const rollup = getProject(projectId).rollup;
    const queue = getExceptionQueue(projectId, { on, rollup });
    const total = queue.groups.length;
    if (!total) return { projectId, index: 0, total: 0, exception: null, evidence: null, hasNext: false, hasPrevious: false };
    const position = Math.max(0, Math.min(Number(index) || 0, total - 1));
    const group = queue.groups[position];
    const line = group.measurement ? rollup.lines.find((candidate) => candidate.measurement === group.measurement) : null;
    return {
      projectId, index: position, total,
      rankedBy: queue.rankedBy, caveat: queue.caveat,
      exception: group,
      evidence: line ? lineEvidence(line, rollup.sourceObjects, { margin }) : null,
      hasNext: position < total - 1,
      hasPrevious: position > 0,
      nextIndex: position < total - 1 ? position + 1 : null,
      previousIndex: position > 0 ? position - 1 : null
    };
  }

  function getBoqVersion(boqVersionId) {
    const version = boqVersions.get(boqVersionId);
    if (!version) throw new NotFoundError('BOQ version not found.');
    return { ...version };
  }

  function createBuilding({ projectId, name }) {
    const project = requireProject(projectId);
    if (!String(name || '').trim()) throw new InputError('A building name is required.');
    const building = { id: `building_${String(++buildingSequence).padStart(4, '0')}`, projectId: project.id, name: String(name).trim(), version: 1, storeyIds: [], sourceDocumentIds: [] };
    buildings.set(building.id, building);
    project.buildingIds.push(building.id);
    persistBuilding(building); persistProject(project);
    return presentBuilding(building);
  }

  function createStorey({ buildingId, name, level = null }) {
    const building = requireBuilding(buildingId);
    if (!String(name || '').trim()) throw new InputError('A storey name is required.');
    const storey = { id: `storey_${String(++storeySequence).padStart(4, '0')}`, buildingId: building.id, projectId: building.projectId, name: String(name).trim(), level, version: 1, sourceDocumentIds: [] };
    storeys.set(storey.id, storey);
    building.storeyIds.push(storey.id);
    persistStorey(storey); persistBuilding(building);
    return presentStorey(storey);
  }

  function createBoqVersion({ projectId, label = 'BOQ version' }) {
    const project = requireProject(projectId);
    const version = { id: `boqv_${String(++boqVersionSequence).padStart(4, '0')}`, projectId: project.id, version: project.boqVersionIds.length + 1, label: String(label || 'BOQ version'), status: 'open' };
    boqVersions.set(version.id, version);
    project.boqVersionIds.push(version.id);
    persistBoqVersion(version); persistProject(project);
    project.currentBoqVersionId = version.id;
    return { ...version };
  }

  function createStudioMapping({ studioId = null, projectId = null, scope = {}, target = {}, reason = '', createdBy = 'operator', fusionVersion = FUSION_VERSION } = {}) {
    if (fusionVersion !== FUSION_VERSION) throw new InputError(`Studio mappings must use ${FUSION_VERSION}.`);
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !target || typeof target !== 'object' || Array.isArray(target)) throw new InputError('Studio mapping scope and target must be objects.');
    const allowedScope = new Set(['studioId', 'projectId', 'buildingId', 'storeyId', 'sourceSheet', 'sourceSheetPattern', 'layerPattern', 'blockPattern', 'scheduleCode', 'type']);
    if (Object.keys(scope).some((key) => !allowedScope.has(key))) throw new InputError('Studio mapping scope contains an unsupported field.');
    const text = (value, label, maximum = 128) => {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new InputError(`${label} must be a bounded non-empty string.`);
      return value.trim();
    };
    const normalizedScope = {};
    for (const key of allowedScope) { const value = text(scope[key], `Mapping scope ${key}`); if (value !== null) normalizedScope[key] = value; }
    const effectiveStudioId = text(studioId ?? normalizedScope.studioId, 'Studio ID');
    const effectiveProjectId = projectId || normalizedScope.projectId || null;
    if (effectiveProjectId) requireProject(effectiveProjectId);
    if (normalizedScope.buildingId) { const building = requireBuilding(normalizedScope.buildingId); if (effectiveProjectId && building.projectId !== effectiveProjectId) throw new InputError('The mapping building does not belong to its project scope.'); }
    if (normalizedScope.storeyId) { const storey = requireStorey(normalizedScope.storeyId); if (normalizedScope.buildingId && storey.buildingId !== normalizedScope.buildingId) throw new InputError('The mapping storey does not belong to its building scope.'); if (effectiveProjectId && storey.projectId !== effectiveProjectId) throw new InputError('The mapping storey does not belong to its project scope.'); }
    if (effectiveStudioId) normalizedScope.studioId = effectiveStudioId; else delete normalizedScope.studioId;
    if (effectiveProjectId) normalizedScope.projectId = effectiveProjectId;
    const signatureKeys = ['layerPattern', 'blockPattern', 'scheduleCode', 'type'];
    if (!signatureKeys.some((key) => normalizedScope[key] && !['*', 'any'].includes(canonical(normalizedScope[key])))) throw new InputError('A studio mapping requires an exact layer, block, schedule, or source-type signature.');
    const normalizedTarget = {};
    for (const [key, maximum] of [['category', 64], ['catalogItem', 128]]) { const value = text(target[key], `Mapping target ${key}`, maximum); if (value !== null) normalizedTarget[key] = canonical(value); }
    if (!normalizedTarget.category && !normalizedTarget.catalogItem) throw new InputError('A studio mapping needs a category or catalog item target.');
    const id = `mapping_${String(++mappingSequence).padStart(4, '0')}`;
    const base = { id, version: 1, studioId: effectiveStudioId, scope: normalizedScope, target: normalizedTarget, status: 'draft', createdBy: text(createdBy, 'Mapping creator') || 'operator', approvedBy: null, createdAt: new Date().toISOString(), approvedAt: null, reason: text(reason, 'Mapping reason', 500) || '', supersedes: null, fusionVersion };
    const mapping = { ...base, contentHash: digest(base) };
    studioMappings.set(id, mapping);
    persistMapping(mapping);
    return presentMapping(mapping);
  }
  function approveStudioMapping(mappingId, { approvedBy = 'operator', reason } = {}) {
    const draft = studioMappings.get(mappingId);
    if (!draft) throw new NotFoundError('Studio mapping not found.');
    if (draft.status !== 'draft' || approvedDraftIds.has(draft.id) || retiredMappingIds.has(draft.id)) throw new InputError('Only an unused draft studio mapping can be approved.');
    const allSiblings = [...studioMappings.values()].filter((mapping) => ['approved', 'retired'].includes(mapping.status) && mapping.studioId === draft.studioId && digest(mapping.scope) === digest(draft.scope)).sort((left, right) => left.version - right.version || left.id.localeCompare(right.id));
    const activeSiblings = allSiblings.filter((mapping) => mapping.status === 'approved' && !retiredMappingIds.has(mapping.id));
    const base = { ...draft, id: `mapping_${String(++mappingSequence).padStart(4, '0')}`, version: Math.max(0, ...allSiblings.map((mapping) => mapping.version)) + 1, status: 'approved', approvedBy: String(approvedBy || 'operator'), approvedAt: new Date().toISOString(), reason: String(reason || draft.reason || 'Explicit operator approval.'), supersedes: activeSiblings.at(-1)?.id || allSiblings.at(-1)?.id || draft.id };
    delete base.contentHash;
    const approved = { ...base, contentHash: digest(base) };
    studioMappings.set(approved.id, approved);
    approvedDraftIds.add(draft.id);
    activeSiblings.forEach((mapping) => retiredMappingIds.add(mapping.id));
    persistMapping(approved); persistMapping(draft);
    activeSiblings.forEach(persistMapping);
    repository.appendAudit({ kind: 'studio_mapping_approved', subjectId: approved.id, payload: { blockPattern: approved.scope.blockPattern || null, target: approved.target, approvedBy: approved.approvedBy } });
    return presentMapping(approved);
  }
  function retireStudioMapping(mappingId, { approvedBy = 'operator', reason = 'Retired by operator.' } = {}) {
    const mapping = studioMappings.get(mappingId);
    if (!mapping) throw new NotFoundError('Studio mapping not found.');
    if (mapping.status !== 'approved' || retiredMappingIds.has(mapping.id)) throw new InputError('Only an active approved studio mapping can be retired.');
    const base = { ...mapping, id: `mapping_${String(++mappingSequence).padStart(4, '0')}`, version: mapping.version + 1, status: 'retired', approvedBy, approvedAt: mapping.approvedAt, reason, supersedes: mapping.id };
    delete base.contentHash;
    const retired = { ...base, contentHash: digest(base) };
    studioMappings.set(retired.id, retired);
    retiredMappingIds.add(mapping.id);
    persistMapping(retired); persistMapping(mapping);
    return presentMapping(retired);
  }
  function getStudioMappings({ projectId, studioId } = {}) {
    return [...studioMappings.values()].filter((mapping) => {
      const effectiveStudioId = mapping.studioId ?? mapping.scope.studioId;
      return (projectId === undefined || mapping.scope.projectId === projectId || mapping.scope.projectId === null || mapping.scope.projectId === undefined)
        && (studioId === undefined || effectiveStudioId === null || effectiveStudioId === undefined || effectiveStudioId === studioId);
    }).map((mapping) => ({ ...presentMapping(mapping), effectiveStatus: retiredMappingIds.has(mapping.id) ? 'retired' : approvedDraftIds.has(mapping.id) ? 'superseded' : mapping.status }));
  }

  function createSourceDocument({ filename, content, fallbackUnit, studioId, projectId, buildingId, storeyId, sourceSheet, sheet, boqVersionId, typicalMultiplier = 1, typicalStoreyMultiplier }) {
    const bytes = asBytes(content);
    const sniffed = sniffContent(bytes);
    if (sniffed.format === 'dwg' || /\.dwg$/i.test(filename || '')) {
      throw new InputError('DWG files are refused. Use a native DXF export from the authoring CAD application; no automatic conversion is performed.');
    }
    if (!['dxf', 'pdf', 'png', 'jpeg'].includes(sniffed.format)) throw new InputError('Unsupported drawing format. Submit a native DXF, born-digital PDF, PNG, or JPEG.');
    if (['png', 'jpeg'].includes(sniffed.format)) {
      // Enforce cheap image resource limits at the upload boundary. Structural
      // errors remain run-scoped so existing uploads receive an actionable
      // failed-run record rather than being silently accepted.
      try { inspectRaster(bytes, { format: sniffed.format }); }
      catch (error) { if (error instanceof LimitError) throw error; }
    }

    const explicitUnit = normalizeUnit(fallbackUnit);
    if (fallbackUnit !== undefined && fallbackUnit !== null && fallbackUnit !== '' && !explicitUnit) {
      throw new InputError('Choose a supported fallback unit: millimetres, centimetres, or metres.');
    }

    const assignment = validateAssignment({ studioId, projectId, buildingId, storeyId, sourceSheet: sourceSheet || sheet || filename, boqVersionId, typicalMultiplier: typicalStoreyMultiplier ?? typicalMultiplier });
    const previousVersions = [...sourceDocuments.values()].filter((document) => assignment.projectId && document.projectId === assignment.projectId && document.sourceSheet === assignment.sourceSheet);

    const sourceDocument = {
      id: `src_${String(++sourceSequence).padStart(4, '0')}`,
      filename,
      version: previousVersions.reduce((highest, document) => Math.max(highest, document.version), 0) + 1,
      content: bytes,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mediaType: sniffed.mediaType,
      format: sniffed.format,
      ingestVersion: sniffed.format === 'pdf' ? 'pdf-native-v1' : ['png', 'jpeg'].includes(sniffed.format) ? 'raster-native-v1' : 'dxf-v1',
      fallbackUnit: explicitUnit,
      ...assignment
    };
    sourceDocuments.set(sourceDocument.id, sourceDocument);
    addAssignmentReference(sourceDocument);
    persistDocument(sourceDocument);
    persistScopeOf(sourceDocument);
    repository.appendAudit({ kind: 'source_document_created', subjectId: sourceDocument.id, payload: { filename: sourceDocument.filename, version: sourceDocument.version, contentSha256: sourceDocument.contentSha256 } });
    return presentSourceDocument(sourceDocument);
  }

  function assignSourceDocument(sourceDocumentId, assignment) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');
    const next = validateAssignment({ ...sourceDocument, ...assignment });
    const changed = ['studioId', 'projectId', 'buildingId', 'storeyId', 'sourceSheet', 'boqVersionId', 'typicalMultiplier'].some((key) => sourceDocument[key] !== next[key]);
    if (!changed) return presentSourceDocument(sourceDocument);
    invalidateRuns(sourceDocument.id);
    removeAssignmentReference(sourceDocument);
    Object.assign(sourceDocument, next);
    addAssignmentReference(sourceDocument);
    const processingRun = startProcessing(sourceDocument.id, { boqVersionId: sourceDocument.boqVersionId });
    return Object.assign(presentSourceDocument(sourceDocument), { processingRun });
  }

  function startProcessing(sourceDocumentId, { boqVersionId, replaySetup } = {}) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');

    const resolvedBoqVersionId = boqVersionId || sourceDocument.boqVersionId || null;
    if (resolvedBoqVersionId) requireBoqVersion(sourceDocument.projectId, resolvedBoqVersionId);
    const run = {
      id: `run_${String(++runSequence).padStart(4, '0')}`,
      sequence: runSequence,
      sourceDocumentId,
      /* The ruleset is no longer a frozen label on the parser: it is whichever
         ruleset this project selected, and it must agree with what the BOQ was
         actually measured under. */
      versions: sourceDocument.format === 'pdf' ? { ...PDF_VERSIONS } : ['png', 'jpeg'].includes(sourceDocument.format) ? { ...RASTER_VERSIONS }
        : { ...VERSIONS, ruleset: (projects.get(sourceDocument.projectId)?.rulesetVersion) || DEFAULT_RULESET_VERSION },
      projectId: sourceDocument.projectId || null,
      buildingId: sourceDocument.buildingId || null,
      storeyId: sourceDocument.storeyId || null,
      boqVersionId: resolvedBoqVersionId,
      typicalMultiplier: sourceDocument.typicalMultiplier || 1,
      /* Snapshotted, not looked up at measurement time: a run must be
         reproducible after the project's policy moves on. */
      rulesetVersion: (projects.get(sourceDocument.projectId)?.rulesetVersion) || DEFAULT_RULESET_VERSION,
      assumptions: structuredClone(projects.get(sourceDocument.projectId)?.assumptions || { version: 1, values: { ...DEFAULT_ASSUMPTIONS }, history: [] }),
      assignmentSnapshot: assignmentSnapshot(sourceDocument, resolvedBoqVersionId),
      mappingSnapshot: mappingSnapshot([...studioMappings.values()].filter((mapping) => !retiredMappingIds.has(mapping.id) && mappingEligibleForRun(mapping, sourceDocument))),
      sourceProcessingRevision: (sourceDocument.processingRevision || 0) + 1,
      superseded: false,
      status: 'ingestion',
      stages: stageState('ingestion', 'running'),
      units: null,
      boq: null,
      error: null,
      pages: [],
      // OCR is an immutable evidence sidecar.  It is intentionally not part
      // of the processing state machine, BOQ, calibration, or region state.
      ocr: { status: 'idle', observations: [], batches: [], lastBatchKey: null },
      setup: ['pdf', 'png', 'jpeg'].includes(sourceDocument.format)
        ? { route: sourceDocument.format === 'pdf' ? 'vector-pdf' : 'raster', status: 'pending', pages: [] }
        : { route: 'dxf', status: 'not_required', pages: [] },
      blockedReasons: ['pdf', 'png', 'jpeg'].includes(sourceDocument.format) ? ['Inspect the source and complete the required page setup before measurement.'] : [],
      exportable: false
    };
    run.decisionContext = {
      sourceDocumentId: sourceDocument.id,
      sourceDocumentVersion: sourceDocument.version,
      contentSha256: sourceDocument.contentSha256,
      processingRunId: run.id,
      studioId: run.assignmentSnapshot.studioId,
      projectId: run.projectId,
      buildingId: run.buildingId,
      storeyId: run.storeyId,
      sourceSheet: sourceDocument.sourceSheet,
      boqVersionId: run.boqVersionId,
      parserVersion: VERSIONS.parser,
      unitResolutionVersion: VERSIONS.unitResolution,
      fusionVersion: FUSION_VERSION,
      ontologyVersion: 'ontology-v1',
      mappingSnapshot: presentMappingSnapshot(run.mappingSnapshot)
    };
    sourceDocument.processingRevision = run.sourceProcessingRevision;
    sourceDocument.currentProcessingRunId = run.id;
    if (['pdf', 'png', 'jpeg'].includes(sourceDocument.format) && replaySetup?.status === 'ready') run.setupReplay = structuredClone(replaySetup);
    runs.set(run.id, run);
    persistRun(run);
    repository.appendAudit({ kind: 'run_started', subjectId: run.id, payload: { sourceDocumentId: run.sourceDocumentId } });
    schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
    return presentRun(run, sourceDocument);
  }

  /* Deliberately not async: awaiting here would turn the fully synchronous DXF
     path asynchronous and change when callers observe a completed run. The body
     of advanceRun executes synchronously up to its first await, so persist once
     immediately and again when any async work settles. */
  function advance(run) {
    const settled = advanceRun(run);
    persistRun(run);
    return settled.then(() => persistRun(run), () => persistRun(run));
  }

  async function advanceRun(run) {
    if (run.superseded) return;
    const source = sourceDocuments.get(run.sourceDocumentId);
    if ((['png', 'jpeg'].includes(source?.format) || (source?.format === 'pdf' && (source.rasterPages || run.setup.route === 'raster'))) && !isCurrentRasterRun(run, source)) {
      run.superseded = true;
      return;
    }
    if (run.status === 'ingestion') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        if (['png', 'jpeg'].includes(document.format)) {
          const inspection = inspectRaster(document.content, document);
          run.versions = { ...inspection.versions };
          run.pages = restoreRasterPages(document.rasterPages, inspection.pages);
          persistRasterRun(run);
          completeStage(run, 'ingestion');
          if (enterRasterGate(run)) return;
          return;
        }
        if (document.format === 'pdf') {
          const inspection = await inspectPdf(document.content, document);
          run.versions = { ...inspection.versions };
          run.pages = inspection.pages;
          const rasterPage = inspection.pages.find((page) => page.kind !== 'vector');
          run.inspection = { format: inspection.format, ingestVersion: inspection.ingestVersion, pageCount: inspection.pages.length, route: rasterPage ? 'raster' : 'native-vector' };
          if (rasterPage) {
            const hasVectorPage = inspection.pages.some((page) => page.kind === 'vector');
            const hasMixedPage = inspection.pages.some((page) => page.kind === 'mixed');
            if (hasMixedPage || hasVectorPage) {
              const error = new InputError('Mixed or hybrid PDFs are not supported: vector quantities and raster regions cannot be measured together. Re-export as a vector-only or image-only PDF so no quantities are omitted.');
              error.code = 'mixed_pdf_unsupported';
              error.stage = 'inspection';
              error.sourcePageId = inspection.pages.find((page) => page.kind !== 'raster')?.sourcePageId || rasterPage.sourcePageId;
              failRun(run, error, 'ingestion', document);
              return;
            }
            completeStage(run, 'ingestion');
            run.pages = restoreRasterPages(document.rasterPages, inspection.pages);
            persistRasterRun(run);
            enterRasterGate(run);
            return;
          }
          run.setup.pages = inspection.pages.map((page) => ({ sourcePageId: page.sourcePageId, phase: 'scale', revision: 0, blockedReasons: ['Page scale and selected regions are required.'] }));
          completeStage(run, 'ingestion');
          if (run.setupReplay && canReplaySetup(run.setupReplay, run, document)) {
            run.setup = structuredClone(run.setupReplay);
            delete run.setupReplay;
            run.blockedReasons = [];
            run.status = 'measurement';
            setStage(run, 'measurement', 'running');
            schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
            return;
          }
          delete run.setupReplay;
          run.status = 'awaiting_setup';
          run.blockedReasons = ['Confirm a drawing scale for each page and select vector regions before measurement.'];
          return;
        }
        const inspection = inspectDxf(document, { versions: VERSIONS });
        run.parsedDocument = inspection.document;
        run.units = inspection.units;
        run.classifications = classifyDocument(run, document, inspection.document.entities);
        completeStage(run, 'ingestion');
        run.status = 'measurement';
        setStage(run, 'measurement', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error, 'ingestion', sourceDocuments.get(run.sourceDocumentId));
      }
      return;
    }

    if (run.status === 'measurement') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        run.boq = document.format === 'pdf'
          ? (run.setup.route === 'raster' ? measureRaster(document, run) : measurePdf(document, run))
          : ['png', 'jpeg'].includes(document.format)
            ? measureRaster(document, run)
            : measureDxf(document, run.units, run.parsedDocument, { versions: VERSIONS, typicalMultiplier: run.typicalMultiplier, runId: run.id, rulesetVersion: run.rulesetVersion, assumptions: run.assumptions?.values });
        if (document.format === 'dxf') {
          attachClassificationProvenance(run);
          attachResiduals(run, document);
        }
        completeStage(run, 'measurement');
        run.status = 'boq';
        setStage(run, 'boq', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error, 'measurement', sourceDocuments.get(run.sourceDocumentId));
      }
      return;
    }

    if (run.status === 'boq') {
      completeStage(run, 'boq');
      run.status = 'completed';
      /* A run that could not measure something is not an exportable BOQ. The
         export surface does not exist yet, so nothing consumes this today --
         but the flag must not claim readiness the numbers cannot back. */
      const unmeasurable = (run.boq?.lines || []).filter((line) => line.measurementStatus === 'not_measurable');
      run.exportable = unmeasurable.length === 0;
      run.exportBlockedReasons = unmeasurable.map((line) => `${line.label || line.measurement} could not be measured; a zero here would silently delete a cost line.`);
    }
  }

  function getRun(runId) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return presentRun(run, sourceDocuments.get(run.sourceDocumentId));
  }

  /* A residual a human already resolved for this studio is never asked again --
     that memory is the compounding asset, so it is consulted before the model
     and persisted rather than cached. */
  function memorisedItemFor(studioId, blockName) {
    if (!blockName) return null;
    const candidates = [...studioMappings.values()].filter((mapping) => {
      if (mapping.status !== 'approved' || retiredMappingIds.has(mapping.id)) return false;
      const scopedStudio = mapping.studioId ?? mapping.scope.studioId ?? null;
      if (scopedStudio !== (studioId ?? null)) return false;
      const pattern = mapping.scope.blockPattern;
      return pattern && canonical(pattern) === canonical(blockName);
    });
    const winner = candidates.sort((left, right) => right.version - left.version)[0];
    return winner ? { mappingId: winner.id, item: winner.target.catalogItem || null, category: winner.target.category || null } : null;
  }

  function attachResiduals(run, sourceDocument) {
    const found = residualsFor(run.parsedDocument, {
      layerCategory,
      blockCategory,
      geometryFor: (entity) => placeBlockGeometry(run.parsedDocument.blocks?.[entity.block], entity)
    });
    run.residuals = found.map((residual, index) => {
      const memorised = memorisedItemFor(sourceDocument.studioId ?? null, residual.blockName);
      return {
        id: `residual_${run.id}_${String(index + 1).padStart(3, '0')}`,
        handle: residual.handle, blockName: residual.blockName, layer: residual.layer,
        categoryKnown: residual.categoryKnown, missing: residual.missing,
        sourceObjectId: `${sourceDocument.id}:v${sourceDocument.version}:dxf:${residual.handle}`,
        status: memorised ? 'resolved_from_memory' : 'awaiting_human',
        resolution: memorised ? { source: 'studio_mapping', ...memorised } : null,
        proposal: null
      };
    });
    run.residualSummary = { ...splitCounts(found), resolvedFromMemory: run.residuals.filter((residual) => residual.status === 'resolved_from_memory').length };
  }

  /* A model label is a proposal until a human accepts it. */
  async function proposeResidualLabels(runId) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    for (const residual of run.residuals || []) {
      if (residual.status !== 'awaiting_human') continue;
      const object = (run.boq?.sourceObjects || []).find((candidate) => candidate.sourceObjectId === residual.sourceObjectId);
      const proposal = await vision.proposeLabel({ ...residual, geometry: object?.geometry || [] });
      residual.proposal = proposal;
      repository.appendAudit({ kind: 'vision_label_proposed', subjectId: residual.sourceObjectId, payload: { runId: run.id, blockName: residual.blockName, status: proposal.status, label: proposal.label, model: proposal.model, prompt: proposal.prompt ? 'label-only' : null } });
    }
    persistRun(run);
    return presentRun(run, sourceDocuments.get(run.sourceDocumentId));
  }

  /* The human decision supersedes the model, and is what gets memorised. */
  function confirmResidual(runId, residualId, { item, category, confirmedBy = 'operator', reason = '' } = {}) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    const residual = (run.residuals || []).find((candidate) => candidate.id === residualId);
    if (!residual) throw new NotFoundError('Residual not found.');
    if (!String(item || '').trim()) throw new InputError('Confirming a residual requires the item it resolves to.');
    const sourceDocument = sourceDocuments.get(run.sourceDocumentId);
    const studioId = sourceDocument?.studioId ?? null;
    if (!residual.blockName) throw new InputError('This residual has no block name to memorise against.');

    const draft = createStudioMapping({
      studioId, projectId: sourceDocument?.projectId || null,
      scope: { blockPattern: residual.blockName },
      target: { catalogItem: item, ...(category ? { category } : {}) },
      reason: reason || `Operator confirmed ${residual.blockName} is ${item}.`,
      createdBy: confirmedBy
    });
    const approved = approveStudioMapping(draft.id, { approvedBy: confirmedBy, reason: reason || 'Residual confirmed by operator.' });
    residual.status = 'confirmed';
    residual.resolution = { source: 'human', mappingId: approved.id, item, category: category || null, confirmedBy, at: approved.approvedAt };
    repository.appendAudit({
      kind: 'residual_confirmed', subjectId: residual.sourceObjectId,
      payload: { runId: run.id, blockName: residual.blockName, item, confirmedBy, mappingId: approved.id,
        supersededProposal: residual.proposal ? { label: residual.proposal.label, model: residual.proposal.model } : null }
    });
    persistRun(run);
    return { residual: structuredClone(residual), mapping: approved };
  }

  /* Ask the model where the boundaries are. It is never asked for scale, and a
     proposal cannot become a quantity until the operator has calibrated the
     page and confirmed the region. */
  async function proposeRasterRegions(runId, pageIdValue) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    if (page.calibration?.status !== 'confirmed') throw new ConflictError('Calibrate the raster page before asking for boundary proposals; without a scale a proposal cannot become a quantity.');
    if (!vision.available || typeof vision.proposeRegions !== 'function') {
      return { status: 'unavailable', reason: 'No vision model is configured; trace the regions by hand.', regions: [], dropped: 0 };
    }
    const width = Number(page.pixelWidth || page.width);
    const height = Number(page.pixelHeight || page.height);
    const image = getRasterImage(runId, pageIdValue);
    const reply = await vision.proposeRegions({ runId, pageId: pageIdValue, imageWidth: width, imageHeight: height,
      imageBase64: Buffer.from(image.content).toString('base64'), mediaType: image.mediaType });
    if (reply.status !== 'proposed') return { status: reply.status || 'unavailable', reason: reply.reason || 'No proposal was returned.', regions: [], dropped: 0 };
    const { boxes, dropped } = coerceBoxes({ boxes: reply.boxes }, { imageWidth: width, imageHeight: height });
    const created = [];
    for (const box of boxes) {
      const result = createRasterRegion(runId, pageIdValue, { points: boxToPolygon(box, width, height), category: box.label, origin: 'model-proposed' });
      created.push(result.region);
    }
    repository.appendAudit({ kind: 'raster_regions_proposed', subjectId: run.id, payload: { pageId: pageIdValue, model: reply.model || null, proposed: created.length, dropped, labels: boxes.map((box) => box.label) } });
    return { status: 'proposed', model: reply.model || null, regions: created, dropped };
  }

  /* One queue for every signal the pipeline can raise. Nothing here reads a
     module directly -- exceptionsForRun consolidates them, so a new check that
     forgets to register is visible as a missing type rather than a silent gap. */
  function currentRunsFor(project) {
    const scoped = new Set([
      ...project.sourceDocumentIds,
      ...project.buildingIds.flatMap((buildingId) => {
        const building = buildings.get(buildingId);
        return [...(building?.sourceDocumentIds || []), ...(building?.storeyIds.flatMap((storeyId) => storeys.get(storeyId)?.sourceDocumentIds || []) || [])];
      })
    ]);
    const latest = new Map();
    for (const run of runs.values()) {
      if (!scoped.has(run.sourceDocumentId) || run.superseded) continue;
      const previous = latest.get(run.sourceDocumentId);
      if (!previous || (run.sequence || 0) > (previous.sequence || 0)) latest.set(run.sourceDocumentId, run);
    }
    return [...latest.values()];
  }

  function getExceptionQueue(projectId, { on = new Date().toISOString().slice(0, 10), rollup = null } = {}) {
    const project = requireProject(projectId);
    const ranker = rankerFor(projectId, on);
    /* The rate and catalogue checks both need the rollup. Load it once here and
       pass it down rather than letting each rebuild the tree. */
    const tree = rollup || getProject(projectId).rollup;
    const raw = [...currentRunsFor(project).flatMap((run) => exceptionsForRun(run)), ...rateExceptionsFor(project, on, tree), ...catalogueExceptionsFor(project, tree)];
    const resolvedKeys = new Set(activeResolutions(projectId).map((resolution) => resolution.groupKey));
    const open = raw.filter((exception) => !resolvedKeys.has(exception.groupKey));
    const exceptions = ranker.order(open);
    const groups = ranker.order(groupExceptions(exceptions).map((group) => ({ ...group, impact: group.members[0].impact, measurement: group.members[0].measurement, id: group.groupKey })));
    return {
      projectId: project.id,
      rankedBy: ranker.rankedBy,
      caveat: ranker.caveat,
      counts: {
        total: exceptions.length,
        blocking: exceptions.filter((exception) => exception.severity === 'blocking').length,
        advisory: exceptions.filter((exception) => exception.severity === 'advisory').length,
        groups: groups.length
      },
      groups, exceptions
    };
  }

  /* A rate outside its validity window must not quietly price a BOQ. It becomes
     a blocking exception in the same queue as every other signal -- this is what
     makes merge-gate Q8 answerable rather than vacuous. */
  function rateExceptionsFor(project, on, rollup = null) {
    const book = currentRateBook(project.id);
    if (!book) return [];
    const catalogue = currentCatalogue(project.id);
    const out = [];
    for (const line of (rollup || getProject(project.id).rollup).lines) {
      /* Rates price the catalogue item's code, not the internal measurement
         name. Looking up by measurement here would find nothing once a
         catalogue exists, and an expired rate would stop being detected. */
      const mapped = applyCatalogue({ measurement: line.measurement, unit: line.unit }, catalogue);
      const itemCode = mapped.status === 'mapped' ? mapped.item.code : line.measurement;
      const rate = findRate(book, itemCode, book.locality);
      if (!rate || !isStale(rate, on)) continue;
      out.push({
        id: `stale_rate:${project.id}:${line.measurement}`, type: 'stale_rate',
        severity: 'blocking', blocks: ['approval', 'export'],
        runId: null, projectId: project.id, sourceDocumentId: null,
        measurement: line.measurement, sourceObjectId: null,
        groupKey: `stale_rate:${line.measurement}`,
        impact: { quantity: line.quantity ?? null, unit: line.unit ?? null },
        title: `The rate for ${line.label || line.measurement} has expired`,
        raisedBecause: `The rate in ${book.label || book.id} v${book.version} was valid to ${rate.validTo}, which is before ${on}. An expired rate must not price a BOQ.`,
        resolutionOptions: [
          { action: 'publish_rate_book', label: 'Publish a new rate book version with a current rate' },
          { action: 'price_as_of', label: 'Price this BOQ as of a date the rate covered' }
        ]
      });
    }
    return out;
  }

  /* Latest decision per group. Superseded rows stay in the table; they are just
     not the current answer. */
  function activeResolutions(projectId) {
    const byGroup = new Map();
    for (const resolution of repository.listResolutions(projectId)) byGroup.set(resolution.groupKey, resolution);
    return [...byGroup.values()];
  }
  function getResolutions(projectId) { return repository.listResolutions(projectId); }
  function studioIdForGroup(project, blockName) {
    for (const run of currentRunsFor(project)) {
      const document = sourceDocuments.get(run.sourceDocumentId);
      if (document?.studioId) return document.studioId;
    }
    return null;
  }

  function appendResolution(projectId, { groupKey, action, resolvedBy = 'operator', reason = '', ...rest }) {
    const previous = activeResolutions(projectId).find((candidate) => candidate.groupKey === groupKey) || null;
    const resolution = {
      id: `resolution_${String(++resolutionSequence).padStart(4, '0')}`,
      projectId, groupKey, action, resolvedBy, reason,
      at: new Date().toISOString(),
      supersedes: previous ? previous.id : null,
      ...rest
    };
    repository.appendResolution(resolution);
    repository.appendAudit({ kind: 'exception_resolved', subjectId: groupKey || resolution.id, payload: { projectId, action, resolvedBy, supersedes: resolution.supersedes, reason } });
    return resolution;
  }

  /** One decision clears every equivalent exception in the group. */
  function resolveExceptionGroup(projectId, groupKey, { action, item, category, resolvedBy = 'operator', reason = '' } = {}) {
    const project = requireProject(projectId);
    if (!action) throw new InputError('Resolving an exception requires an action.');
    /* Look across every exception the project can raise, not only the open ones:
       revising an earlier decision is the same operation, and it is what
       `supersedes` exists for. Resolving one that has already been answered
       appends a correction rather than being refused. */
    const allGroups = groupExceptions(currentRunsFor(project).flatMap((run) => exceptionsForRun(run)));
    const previous = activeResolutions(projectId).find((candidate) => candidate.groupKey === groupKey) || null;
    const group = allGroups.find((candidate) => candidate.groupKey === groupKey)
      || (previous ? { groupKey, members: [], count: previous.clearedCount ?? 0, resolutionOptions: [{ action: previous.action, label: 'Revise this decision' }] } : null);
    if (!group) throw new NotFoundError('Exception group not found.');
    if (!group.resolutionOptions.some((option) => option.action === action)) {
      throw new InputError(`"${action}" is not a resolution this exception offers. Options: ${group.resolutionOptions.map((option) => option.action).join(', ')}.`);
    }

    /* confirm_item is also memorised for the studio, so the same symbol is not
       asked again on the next drawing. */
    let blockName = previous?.blockName ?? null;
    if (action === 'confirm_item') {
      if (!String(item || '').trim()) throw new InputError('Confirming an item requires the item it resolves to.');
      let confirmedAny = false;
      for (const member of group.members) {
        const run = member.residualId ? loadRun(member.runId) : null;
        const residual = (run?.residuals || []).find((candidate) => candidate.id === member.residualId);
        if (!residual || residual.status !== 'awaiting_human') continue;
        blockName = blockName || residual.blockName;
        confirmResidual(member.runId, member.residualId, { item, category, confirmedBy: resolvedBy, reason });
        confirmedAny = true;
      }
      /* A correction: the residuals were confirmed under the old answer, so
         memorise the new one directly. The old mapping is retired by approval,
         which already supersedes same-scope siblings. */
      if (!confirmedAny && blockName) {
        const draft = createStudioMapping({ studioId: sourceDocuments.get(loadRun(previous?.runId)?.sourceDocumentId)?.studioId ?? studioIdForGroup(project, blockName),
          projectId: project.id, scope: { blockPattern: blockName },
          target: { catalogItem: item, ...(category ? { category } : {}) },
          reason: reason || `Corrected: ${blockName} is ${item}.`, createdBy: resolvedBy });
        approveStudioMapping(draft.id, { approvedBy: resolvedBy, reason: reason || 'Resolution revised by operator.' });
      }
    }
    if (action === 'confirm_region') {
      for (const member of group.members) confirmRasterRegion(member.runId, member.pageId, member.regionId, { confirmedBy: resolvedBy });
    }

    const resolution = appendResolution(projectId, { groupKey, action, resolvedBy, reason, item: item ?? null, category: category ?? null, blockName, clearedCount: group.count });
    return { resolution, cleared: group.count };
  }

  /* A resolution that moves a number behaves exactly as an assumption change
     does: re-measure, supersede the runs that produced the old number, and
     invalidate any approval that rested on it. */
  function recordQuantityAffectingResolution(projectId, { action, values = {}, rulesetVersion, reason = '', resolvedBy = 'operator', groupKey = null } = {}) {
    requireProject(projectId);
    const resolution = appendResolution(projectId, { groupKey, action, resolvedBy, reason, values, rulesetVersion: rulesetVersion ?? null });
    updateProjectAssumptions(projectId, { values, rulesetVersion, reason: reason || `Resolution ${resolution.id}`, updatedBy: resolvedBy });
    return resolution;
  }

  /* --- rate books (#15) ------------------------------------------------ */

  function rateBooksFor(projectId) { return repository.listRateBooks(projectId); }

  function currentRateBook(projectId, version = null) {
    const books = rateBooksFor(projectId);
    if (!books.length) return null;
    if (version !== null) return books.find((book) => book.version === version) || null;
    return books.reduce((latest, book) => (book.version > latest.version ? book : latest), books[0]);
  }

  /** Publishing never edits: each call is the next immutable version. */
  function publishRateBook(projectId, { studioId, label = '', currency, locality = null, source, rates = [], kind = 'studio', publishedOn = null } = {}) {
    const project = requireProject(projectId);
    const existing = rateBooksFor(projectId);
    const id = existing[0]?.id || `ratebook_${String(existing.length + 1).padStart(4, '0')}_${project.id}`;
    const book = createRateBook({
      id, studioId: studioId || studioIdForGroup(project, null) || 'studio_default',
      label, version: existing.length + 1, currency, locality, source, rates, kind, publishedOn
    });
    repository.saveRateBook(book, project.id);
    repository.appendAudit({ kind: 'rate_book_published', subjectId: book.id, payload: { projectId: project.id, version: book.version, currency: book.currency, rateCount: book.rates.length, source: book.source } });
    return book;
  }

  /** Prices the current rollup. Never invents a rate; an unpriced line has no
      amount, which is a state and not a zero. */
  function getPricedBoq(projectId, { on = new Date().toISOString().slice(0, 10), rateBookVersion = null } = {}) {
    const project = requireProject(projectId);
    const rollup = getProject(projectId).rollup;
    const book = currentRateBook(projectId, rateBookVersion);
    if (!book) {
      return {
        projectId: project.id, status: 'unavailable', pricedOn: on,
        rateBookId: null, rateBookVersion: null, total: null,
        reason: 'No rate book has been published for this project, so nothing here has an amount. That is different from an amount of zero.',
        lines: rollup.lines.map((line) => ({ measurement: line.measurement, quantity: line.quantity, unit: line.unit, amount: null, status: 'no_rate_book', rate: null }))
      };
    }
    const catalogue = currentCatalogue(projectId);
    const lines = rollup.lines.map((line) => {
      const mapped = applyCatalogue({ measurement: line.measurement, unit: line.unit }, catalogue);
      /* The rate book prices the catalogue item's code, not the internal
         measurement name -- that is what the items layer exists for. */
      const itemCode = mapped.status === 'mapped' ? mapped.item.code : line.measurement;
      const priced = priceLine(
        { measurement: itemCode, quantity: line.measurementStatus === 'not_measurable' ? null : line.quantity, unit: line.unit, measurementStatus: line.measurementStatus },
        book, { on, locality: book.locality });
      return { ...priced, measurement: line.measurement, itemCode, catalogueStatus: mapped.status, item: mapped.item, description: mapped.item?.description ?? null, sortOrder: mapped.item?.sortOrder ?? 1000 };
    });
    return {
      projectId: project.id, status: 'priced', pricedOn: on,
      rateBookId: book.id, rateBookVersion: book.version, currency: book.currency,
      total: totalOf(lines), lines
    };
  }

  /* --- item catalogue (#24) -------------------------------------------- */

  function cataloguesFor(projectId) { return repository.listCatalogues(projectId); }
  function currentCatalogue(projectId, version = null) {
    const all = cataloguesFor(projectId);
    if (!all.length) return null;
    if (version !== null) return all.find((entry) => entry.version === version) || null;
    return all.reduce((latest, entry) => (entry.version > latest.version ? entry : latest), all[0]);
  }

  function publishCatalogue(projectId, { studioId, label = '', items = [], locality = null } = {}) {
    const project = requireProject(projectId);
    const existing = cataloguesFor(projectId);
    const id = existing[0]?.id || `catalogue_${String(existing.length + 1).padStart(4, '0')}_${project.id}`;
    const catalogue = createCatalogue({
      id, studioId: studioId || studioIdForGroup(project, null) || 'studio_default',
      version: existing.length + 1, label, items, locality
    });
    repository.saveCatalogue(catalogue, project.id);
    repository.appendAudit({ kind: 'catalogue_published', subjectId: catalogue.id, payload: { projectId: project.id, version: catalogue.version, itemCount: catalogue.items.length } });
    return catalogue;
  }

  /* geometry -> rules -> items -> rates. Each rollup line resolves to a
     catalogue item first; the item's code is what the rate book prices. */
  function catalogueExceptionsFor(project, rollup = null) {
    const catalogue = currentCatalogue(project.id);
    const out = [];
    for (const line of (rollup || getProject(project.id).rollup).lines) {
      const mapped = applyCatalogue({ measurement: line.measurement, unit: line.unit }, catalogue);
      if (mapped.status === 'mapped') continue;
      out.push({
        id: `unmapped_measurement:${project.id}:${line.measurement}`, type: 'unmapped_measurement',
        severity: 'blocking', blocks: ['approval', 'export'],
        runId: null, projectId: project.id, sourceDocumentId: null,
        measurement: line.measurement, sourceObjectId: null,
        groupKey: `unmapped_measurement:${line.measurement}`,
        impact: { quantity: line.quantity ?? null, unit: line.unit ?? null },
        title: `${line.label || line.measurement} has no catalogue item`,
        raisedBecause: mapped.reason,
        resolutionOptions: [
          { action: 'publish_catalogue', label: 'Add a catalogue item mapping this measurement to a BOQ item' },
          { action: 'exclude_measurement', label: 'Record that this measurement is not billed' }
        ]
      });
    }
    return out;
  }

  /* --- vendor offers (#16) --------------------------------------------- */

  function recordVendorOffer(projectId, offer) {
    const project = requireProject(projectId);
    const built = createVendorOffer({
      id: `offer_${String(++offerSequence).padStart(4, '0')}`,
      studioId: offer.studioId || studioIdForGroup(project, null) || 'studio_default',
      ...offer
    });
    repository.saveVendorOffer(built, project.id);
    repository.appendAudit({ kind: 'vendor_offer_recorded', subjectId: built.id, payload: { projectId: project.id, vendorId: built.vendorId, itemCode: built.itemCode, validTo: built.validTo, source: built.source } });
    return built;
  }

  function getVendorOffers(projectId, itemCode, { on = new Date().toISOString().slice(0, 10), unit = null } = {}) {
    const project = requireProject(projectId);
    const studioId = studioIdForGroup(project, null) || 'studio_default';
    const line = getProject(projectId).rollup.lines.find((candidate) => candidate.measurement === itemCode);
    const result = eligibleOffers(repository.listVendorOffers(project.id), { itemCode, studioId, unit: unit ?? line?.unit ?? null, on });
    const selected = activeResolutions(projectId).find((resolution) => resolution.groupKey === `vendor_selection:${itemCode}`);
    /* The current selection is reported as history, not as a default: it says
       what a human chose, it does not pre-choose for the next one. */
    return { ...result, selectionOnRecord: selected ? { offerId: selected.offerId, selectedBy: selected.resolvedBy, at: selected.at } : null };
  }

  function selectVendorOffer(projectId, { itemCode, offerId, selectedBy = 'operator', reason = '', on = new Date().toISOString().slice(0, 10) } = {}) {
    const project = requireProject(projectId);
    const available = getVendorOffers(projectId, itemCode, { on });
    const offer = available.offers.find((candidate) => candidate.id === offerId);
    if (!offer) {
      const stale = available.stale.find((candidate) => candidate.id === offerId);
      if (stale) throw new InputError(`That vendor offer is not eligible: ${stale.reason}`);
      throw new NotFoundError('Vendor offer not found for this item.');
    }
    const resolution = appendResolution(projectId, {
      groupKey: `vendor_selection:${itemCode}`, action: 'select_vendor_offer',
      resolvedBy: selectedBy, reason, itemCode, offerId: offer.id, vendorId: offer.vendorId
    });
    repository.appendAudit({ kind: 'vendor_offer_selected', subjectId: offer.id, payload: { projectId: project.id, itemCode, vendorId: offer.vendorId, vendorName: offer.vendorName, amount: offer.amount, currency: offer.currency, selectedBy, supersedes: resolution.supersedes } });
    /* A vendor choice prices what was measured. It has no path back into
       measurement, so no run is superseded and no quantity moves. */
    return { resolution, offer };
  }

  function rankExceptions(projectId, exceptions, { on = new Date().toISOString().slice(0, 10) } = {}) {
    return rankerFor(projectId, on).order(exceptions);
  }

  /* With a rate book present the queue ranks by money at risk and says so; with
     none it stays an explicitly-labelled proxy. */
  function rankerFor(projectId, on) {
    const book = currentRateBook(projectId);
    if (!book) return createImpactRanker({ rateSource: rateSource || null });
    return createImpactRanker({ rateSource: {
      rateFor: (measurement) => {
        const rate = findRate(book, measurement, book.locality);
        return rate && !isStale(rate, on) ? rate.amount : 0;
      }
    } });
  }

  function getClassifications(runId) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return { runId: run.id, fusionVersion: FUSION_VERSION, mappingSnapshot: presentMappingSnapshot(run.mappingSnapshot), classifications: structuredClone(run.classifications || []) };
  }
  function submitOcrResults(runId, pageIdValue, input) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    const page = run.pages.find((candidate) => candidate.sourcePageId === pageIdValue);
    if (!page) throw new NotFoundError('OCR page not found.');
    const batch = normalizeOcrResults(input, { run, page, pageId: pageIdValue });
    const identityKey = digest({
      sourceDocumentId: batch.sourceDocumentId,
      sourceDocumentVersion: batch.sourceDocumentVersion,
      contentSha256: batch.contentSha256,
      processingRunId: batch.processingRunId,
      pageId: batch.pageId,
      regionId: batch.regionId,
      engine: batch.engine,
      engineVersion: batch.engineVersion,
      modelVersion: batch.modelVersion,
      language: batch.language,
      normalizationVersion: batch.normalizationVersion,
      coordinateSpace: batch.coordinateSpace,
      pageTransform: batch.pageTransform,
      rotation: batch.rotation,
      cropPolygon: batch.cropPolygon
    });
    const existing = run.ocr.batches.find((candidate) => candidate.identityKey === identityKey);
    if (existing) {
      if (existing.batchKey !== batch.batchKey) throw new ConflictError('An immutable OCR observation set already exists for this run/page/model snapshot.');
      return presentOcrResponse(run, existing);
    }
    if (run.ocr.observations.length + batch.observations.length > OCR_LIMITS.maxRunObservations) throw new LimitError(`A processing run may contain at most ${OCR_LIMITS.maxRunObservations} OCR observations.`, { limitName: 'ocrRunObservations', observed: run.ocr.observations.length + batch.observations.length, maximum: OCR_LIMITS.maxRunObservations, stage: 'ocr' });
    const stored = { ...batch, identityKey };
    run.ocr.batches.push(stored);
    run.ocr.observations = [...run.ocr.batches.flatMap((candidate) => candidate.observations)].sort((left, right) => left.id.localeCompare(right.id));
    run.ocr.status = 'completed';
    run.ocr.lastBatchKey = stored.batchKey;
    return presentOcrResponse(run, stored);
  }

  function presentOcrResponse(run, batch) {
    const ocr = {
      status: run.ocr.status,
      lastBatchKey: run.ocr.lastBatchKey,
      observations: structuredClone(run.ocr.observations),
      batch: presentOcrBatch(batch)
    };
    return { ocr, observations: structuredClone(batch.observations), processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)) };
  }

  function getOcrResults(runId, pageIdValue) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    if (pageIdValue !== undefined && !run.pages.some((page) => page.sourcePageId === pageIdValue)) throw new NotFoundError('OCR page not found.');
    const observations = run.ocr.observations.filter((observation) => pageIdValue === undefined || observation.pageId === pageIdValue);
    return { status: run.ocr.status, observations: structuredClone(observations), observationCount: observations.length, lastBatchKey: run.ocr.lastBatchKey };
  }

  function getOcrStatus(runId) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return { status: run.ocr.status, observationCount: run.ocr.observations.length, lastBatchKey: run.ocr.lastBatchKey };
  }

  function confirmSourceSetup(runId, setup) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    if (run.superseded || !isCurrentSnapshot(run, sourceDocuments.get(run.sourceDocumentId))) throw new ConflictError('This run no longer matches the current source assignment. Reprocess the current source assignment.');
    if (run.status !== 'awaiting_setup') throw new ConflictError('This run is not awaiting PDF setup.');
    if (run.setup.route !== 'vector-pdf') throw new ConflictError('This run is awaiting raster calibration, not vector PDF setup.');
    if (!Array.isArray(setup?.pages) || setup.pages.length !== run.pages.length) throw new InputError('Provide exactly one setup entry for each inspected PDF page.');
    const requestedPageIds = setup.pages.map((page) => page?.sourcePageId);
    const inspectedPageIds = run.pages.map((page) => page.sourcePageId);
    if (new Set(requestedPageIds).size !== requestedPageIds.length || requestedPageIds.some((pageId) => !inspectedPageIds.includes(pageId))) throw new InputError('Provide exactly one setup entry for each inspected PDF page.');
    const pages = setup.pages.map((requested) => {
      const page = run.pages.find((candidate) => candidate.sourcePageId === requested.sourcePageId);
      if (!page) throw new InputError(`The PDF page ${requested?.sourcePageId || '(missing)'} does not belong to this run.`);
      const drawingUnitsPerMetre = Number(requested.scale?.drawingUnitsPerMetre);
      if (!Number.isFinite(drawingUnitsPerMetre) || drawingUnitsPerMetre < 1e-6 || drawingUnitsPerMetre > 1e9) throw new InputError(`Page ${page.pageNumber} requires a finite drawing-units-per-metre scale between 0.000001 and 1000000000.`);
      const selectedRegions = requested.selectedRegions;
      if (!Array.isArray(selectedRegions) || selectedRegions.length === 0) throw new InputError(`Select at least one native vector region on PDF page ${page.pageNumber}.`);
      if (selectedRegions.some((regionId) => !page.nativeRegionIds.includes(regionId))) throw new InputError(`A selected vector region does not belong to PDF page ${page.pageNumber}.`);
      return { sourcePageId: page.sourcePageId, pageNumber: page.pageNumber, phase: 'scale', revision: 1, scale: { drawingUnitsPerMetre }, selectedRegions, blockedReasons: [] };
    });
    run.setup = { route: 'vector-pdf', status: 'ready', pages };
    run.blockedReasons = [];
    run.status = 'measurement';
    setStage(run, 'measurement', 'running');
    schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
    return presentRun(run, sourceDocuments.get(run.sourceDocumentId));
  }

  function requireRasterPage(runId, pageIdValue) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    const page = run.pages.find((candidate) => candidate.sourcePageId === pageIdValue);
    if (!page || page.route !== 'raster') throw new NotFoundError('Raster page not found.');
    if (run.superseded || !isCurrentRasterRun(run, sourceDocuments.get(run.sourceDocumentId))) throw new ConflictError('This processing run is stale or superseded; reprocess the current source before changing raster state.');
    return { run, page };
  }

  function persistRasterRun(run) {
    const source = sourceDocuments.get(run.sourceDocumentId);
    if (!isCurrentRasterRun(run, source)) throw new ConflictError('This raster run is stale; reprocess the current source before changing raster state.');
    source.rasterPages = structuredClone(run.pages);
    persistDocument(source);
    persistRun(run);
  }

  function enterRasterGate(run, customBlockedReason = null) {
    const activePages = run.pages.filter((page) => page.route === 'raster');
    if (!activePages.length) throw new InputError('The source has no raster pages available for calibration.');
    const pageStates = activePages.map((page) => {
      const activeRegions = page.regions.filter((region) => region.lifecycle !== 'deleted');
      const calibrated = page.calibration?.status === 'confirmed';
      const phase = !calibrated ? 'calibration' : activeRegions.length === 0 ? 'trace' : activeRegions.every((region) => region.lifecycle === 'confirmed') ? 'ready' : 'confirmation';
      const blockedReasons = [];
      if (!calibrated) blockedReasons.push(`Page ${page.pageNumber} requires two confirmed image-space calibration points and a positive real-world distance.`);
      if (calibrated && activeRegions.length === 0) blockedReasons.push(`Page ${page.pageNumber} requires at least one traced region.`);
      if (activeRegions.length > 0 && !activeRegions.every((region) => region.lifecycle === 'confirmed')) blockedReasons.push(`Page ${page.pageNumber} requires every active region to be classified and confirmed.`);
      return { page, activeRegions, calibrated, phase, blockedReasons };
    });
    const allCalibrated = pageStates.every((state) => state.calibrated);
    const allPagesReady = pageStates.every((state) => state.phase === 'ready');
    run.setup = {
      route: 'raster',
      status: allPagesReady ? 'ready' : 'pending',
      pages: pageStates.map(({ page, phase, blockedReasons }) => ({ sourcePageId: page.sourcePageId, phase, revision: page.revision ?? page.calibration?.revision ?? 0, blockedReasons }))
    };
    resetRasterOutput(run);
    run.boq = null;
    run.exportable = false;
    if (!allCalibrated) {
      run.status = 'awaiting_calibration';
      run.blockedReasons = customBlockedReason ? [customBlockedReason] : pageStates.flatMap((state) => state.blockedReasons);
    } else if (pageStates.some((state) => state.phase === 'trace')) {
      run.status = 'awaiting_trace';
      run.blockedReasons = pageStates.flatMap((state) => state.blockedReasons);
    } else if (!allPagesReady) {
      run.status = 'awaiting_confirmation';
      run.blockedReasons = pageStates.flatMap((state) => state.blockedReasons);
    } else {
      run.status = 'measurement';
      run.blockedReasons = [];
      setStage(run, 'measurement', 'running');
      schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      return false;
    }
    return true;
  }

  function calibrateRasterPage(runId, pageIdValue, input) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    assertExpectedPageRevision(page, input);
    const p0 = point(input?.p0);
    const p1 = point(input?.p1);
    const realDistance = Number(input?.realDistance);
    const realUnit = String(input?.realUnit || '').trim().toLowerCase();
    const unitMetres = { mm: 0.001, millimetres: 0.001, cm: 0.01, centimetres: 0.01, m: 1, metre: 1, metres: 1 }[realUnit];
    if (!p0 || !p1 || !unitMetres || !Number.isFinite(realDistance) || realDistance <= 0) throw new InputError('Calibration requires two finite image points and a positive real-world distance/unit.');
    const width = Number(page.pixelWidth || page.width); const height = Number(page.pixelHeight || page.height);
    if (![p0, p1].every((candidate) => candidate.x >= 0 && candidate.y >= 0 && candidate.x <= width && candidate.y <= height)) throw new InputError('Calibration points must be finite and inside the image bounds.');
    const pixelDistance = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const realDistanceMetres = realDistance * unitMetres;
    const pixelsPerMetre = pixelDistance / realDistanceMetres;
    const scaleSquared = pixelsPerMetre * pixelsPerMetre;
    const inverseScaleSquared = 1 / scaleSquared;
    if (!Number.isFinite(realDistanceMetres) || realDistanceMetres < LIMITS.rasterRealDistanceMin || realDistanceMetres > LIMITS.rasterRealDistanceMax || !Number.isFinite(pixelsPerMetre) || pixelsPerMetre < LIMITS.rasterPixelsPerMetreMin || pixelsPerMetre > LIMITS.rasterPixelsPerMetreMax || !Number.isFinite(scaleSquared) || scaleSquared <= 0 || !Number.isFinite(inverseScaleSquared) || inverseScaleSquared <= 0 || pixelDistance <= 0) throw new InputError(`Calibration must produce a finite scale with real distance between ${LIMITS.rasterRealDistanceMin}m and ${LIMITS.rasterRealDistanceMax}m.`);
    const prior = page.calibration;
    const revision = (prior?.revision || 0) + 1;
    page.calibration = { status: 'confirmed', p0, p1, pixelDistance, realDistance, realUnit, realDistanceMetres, pixelsPerMetre, revision, source: 'operator-confirmed', correctedFrom: prior ? prior.revision : null, history: [...(prior?.history || []), ...(prior ? [stripHistory(prior)] : [])] };
    page.revision = revision;
    for (const region of page.regions) if (region.lifecycle === 'confirmed') {
      region.history ||= [];
      region.history.push({ revision: region.revision, points: structuredClone(region.points), category: region.category, lifecycle: region.lifecycle, reason: 'calibration-correction' });
      region.lifecycle = 'traced';
      region.revision += 1;
      region.audit.push({ action: 'stale_after_calibration_correction', revision: region.revision, calibrationRevision: revision });
    }
    persistRasterRun(run);
    enterRasterGate(run);
    persistRun(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), page: presentRasterPage(page) };
  }

  function createRasterRegion(runId, pageIdValue, input) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    assertExpectedPageRevision(page, input, true);
    if (page.calibration?.status !== 'confirmed') throw new ConflictError('Calibrate the raster page before tracing a region.');
    if (page.regions.filter((region) => region.lifecycle !== 'deleted').length >= LIMITS.rasterRegions) throw new LimitError(`A raster page may contain at most ${LIMITS.rasterRegions} active regions.`, { limitName: 'rasterRegions', observed: page.regions.filter((region) => region.lifecycle !== 'deleted').length + 1, maximum: LIMITS.rasterRegions, stage: 'trace' });
    const points = validatePolygon(input?.points, page);
    const origin = input?.origin === 'model-proposed' ? 'model-proposed' : 'human-traced';
    /* A proposal is not geometry until a human says so. Its lifecycle starts at
       'proposed', and geometrySource is derived from that lifecycle rather than
       stamped at creation -- otherwise an unconfirmed proposal would carry the
       word "confirmed" from the moment it existed. */
    const region = { id: `region_${String(page.regions.length + 1).padStart(4, '0')}`, points, category: normalizeRasterCategory(input?.category), lifecycle: origin === 'model-proposed' ? 'proposed' : 'traced', origin, revision: 1, history: [], audit: [{ action: origin === 'model-proposed' ? 'proposed' : 'created', revision: 1 }] };
    page.regions.push(region);
    persistRasterRun(run);
    enterRasterGate(run);
    persistRun(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), region: { ...region } };
  }

  function updateRasterRegion(runId, pageIdValue, regionId, input) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    const region = page.regions.find((candidate) => candidate.id === regionId && candidate.lifecycle !== 'deleted');
    if (!region) throw new NotFoundError('Raster region not found.');
    assertExpectedRevisions(page, region, input, true);
    const prior = { revision: region.revision, points: structuredClone(region.points), category: region.category, lifecycle: region.lifecycle };
    if (input?.points) region.points = validatePolygon(input.points, page);
    if (input && Object.hasOwn(input, 'category')) region.category = normalizeRasterCategory(input.category);
    region.lifecycle = 'traced'; region.revision += 1; region.audit.push({ action: 'updated', revision: region.revision });
    region.history ||= []; region.history.push(prior);
    persistRasterRun(run); enterRasterGate(run); persistRun(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), region: { ...region } };
  }

  function deleteRasterRegion(runId, pageIdValue, regionId, input = {}) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    const region = page.regions.find((candidate) => candidate.id === regionId && candidate.lifecycle !== 'deleted');
    if (!region) throw new NotFoundError('Raster region not found.');
    assertExpectedRevisions(page, region, input, true);
    region.history ||= [];
    region.history.push({ revision: region.revision, points: structuredClone(region.points), category: region.category, lifecycle: region.lifecycle, reason: 'deleted' });
    region.lifecycle = 'deleted'; region.revision += 1; region.deletedAt = new Date().toISOString(); region.tombstone = { id: region.id, deletedAt: region.deletedAt, revision: region.revision }; region.audit.push({ action: 'deleted', revision: region.revision });
    persistRasterRun(run); enterRasterGate(run); persistRun(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), region: { ...region } };
  }

  function confirmRasterRegion(runId, pageIdValue, regionId, input = {}) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    const region = page.regions.find((candidate) => candidate.id === regionId && candidate.lifecycle !== 'deleted');
    if (!region) throw new NotFoundError('Raster region not found.');
    assertExpectedRevisions(page, region, input, true);
    if (!region.category) throw new InputError('Classify the raster region before confirmation.');
    region.lifecycle = 'confirmed'; region.revision += 1;
    const confirmedBy = String(input?.confirmedBy || 'operator');
    region.confirmedBy = confirmedBy;
    region.audit.push({ action: 'confirmed', revision: region.revision, by: confirmedBy, at: new Date().toISOString() });
    repository.appendAudit({ kind: 'raster_region_confirmed', subjectId: region.id, payload: { runId: run.id, pageId: pageIdValue, origin: region.origin, category: region.category, confirmedBy } });
    persistRasterRun(run); enterRasterGate(run); persistRun(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), region: { ...region } };
  }

  function getRasterImage(runId, pageIdValue) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    if (!run.pages.some((page) => page.sourcePageId === pageIdValue)) throw new NotFoundError('Source page not found.');
    const source = sourceDocuments.get(run.sourceDocumentId);
    if (source.format === 'pdf') return { content: source.content, mediaType: source.mediaType, format: 'pdf' };
    requireRasterPage(runId, pageIdValue);
    if (!['png', 'jpeg'].includes(source.format)) throw new InputError('Browser raster preview is available only for raster sources.');
    return { content: source.content, mediaType: source.mediaType };
  }

  function assertExpectedPageRevision(page, input, legacy = false) {
    const expected = input?.expectedPageRevision !== undefined ? input.expectedPageRevision : legacy ? input?.expectedRevision : undefined;
    if (expected !== undefined && Number(expected) !== Number(page.revision ?? page.calibration?.revision ?? 0)) throw new ConflictError('Raster page state changed; reload before applying this edit.');
  }

  function assertExpectedRevisions(page, region, input, legacyRegion = false) {
    assertExpectedPageRevision(page, input);
    // expectedRevision is the legacy browser page token. New clients should
    // send expectedRegionRevision explicitly so page and region revisions can
    // be checked independently.
    const expectedRegion = input?.expectedRegionRevision !== undefined ? input.expectedRegionRevision : legacyRegion ? input?.expectedRevision : undefined;
    if (expectedRegion !== undefined && Number(expectedRegion) !== Number(region.revision)) throw new ConflictError('Raster region state changed; reload before applying this edit.');
  }

  function resetRasterOutput(run) {
    run.boq = null; run.exportable = false;
    for (const stage of run.stages) if (stage.name !== 'ingestion') stage.status = 'pending';
  }

  function reprocess(runId) {
    const run = loadRun(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    if (run.superseded) throw new InputError('This processing run is superseded; reprocess the current source assignment instead.');
    return startProcessing(run.sourceDocumentId, { boqVersionId: run.boqVersionId, replaySetup: run.setup });
  }

  function sourceDocumentsFor(ids) {
    return [...sourceDocuments.values()].filter((sourceDocument) => ids.includes(sourceDocument.id));
  }

  function rollupForSourceIds(ids, scope, scopeId, requestedBoqVersionId = null, context = null) {
    const documents = sourceDocumentsFor(ids);
    const byId = new Map(documents.map((document) => [document.id, document]));
    /* One query for every candidate run across every document in scope. The
       winner-per-assignment policy below stays in JS deliberately: it is the
       rule that decides which revision counts, and expressing it in SQL would
       risk moving a quantity for no gain. */
    const candidates = context ? context.candidates.filter((entry) => byId.has(entry.sourceDocumentId)) : repository.completedRuns([...byId.keys()]);
    const selected = new Map();
    for (const { id: runId, sourceDocumentId, envelope } of candidates) {
      const sourceDocument = byId.get(sourceDocumentId);
      const snapshot = envelope?.assignmentSnapshot;
      if (!sourceDocument || !snapshot || !envelope.boqShape) continue;
      if (requestedBoqVersionId && snapshot.boqVersionId !== requestedBoqVersionId) continue;
      const contributionKey = [snapshot.boqVersionId || runId, snapshot.projectId, snapshot.buildingId, snapshot.storeyId, snapshot.sourceSheet].join('|');
      const previous = selected.get(contributionKey);
      const candidate = { sourceDocument, runId, envelope, snapshot, sequence: envelope.sequence };
      if (!previous || snapshot.sourceDocumentVersion > previous.snapshot.sourceDocumentVersion || (snapshot.sourceDocumentVersion === previous.snapshot.sourceDocumentVersion && candidate.sequence > previous.sequence)) {
        selected.set(contributionKey, candidate);
      }
    }
    /* Three more queries for the lines, contributions and source objects of
       every selected run at once -- four in total, whatever the run count. */
    const runIds = [...selected.values()].map((entry) => entry.runId);
    const loaded = context ? context.slice(runIds) : repository.resultsFor(runIds);
    const lines = new Map();
    const contributions = [];
    const sourceObjects = new Map();
    const unitDecisions = [];
    const loadedById = new Map(loaded.sourceObjects.map((object) => [object.sourceObjectId, object]));
    for (const entry of selected.values()) {
      const { sourceDocument, runId, envelope, snapshot } = entry;
      const run = { id: runId, ...envelope, boq: { lines: loaded.linesByRun.get(runId) || [] } };
      /* Where an object sits in the navigation tree is a property of the
         assignment, not of the geometry, and an assignment can be changed after
         the fact. The stored row records the assignment first observed; what a
         rollup reports is the assignment of the run it is reading. */
      for (const line of run.boq.lines) {
        for (const contribution of line.provenance.contributions) {
          const stored = loadedById.get(contribution.sourceObjectId);
          if (stored) sourceObjects.set(stored.sourceObjectId, { ...stored, buildingId: snapshot.buildingId ?? null, storeyId: snapshot.storeyId ?? null, sheetId: snapshot.sourceSheet ?? stored.sheetId });
        }
      }
      const contribution = {
        key: [snapshot.boqVersionId || run.id, snapshot.projectId, snapshot.buildingId, snapshot.storeyId, snapshot.sourceSheet].join('|'),
        sourceDocumentId: snapshot.sourceDocumentId,
        sourceDocumentVersion: snapshot.sourceDocumentVersion,
        contentSha256: snapshot.contentSha256,
        sourceSheet: snapshot.sourceSheet,
        projectId: snapshot.projectId,
        buildingId: snapshot.buildingId,
        storeyId: snapshot.storeyId,
        boqVersionId: snapshot.boqVersionId,
        typicalMultiplier: snapshot.typicalMultiplier,
        units: run.units
      };
      contributions.push(contribution);
      unitDecisions.push({ storeyId: snapshot.storeyId, sourceDocumentId: snapshot.sourceDocumentId, decision: run.units });
      for (const sourceLine of run.boq.lines) {
        const line = lines.get(sourceLine.measurement) || {
          measurement: sourceLine.measurement,
          label: sourceLine.label,
          quantity: 0,
          unit: sourceLine.unit,
          measurementStatus: 'not_measurable',
          provenance: buildProvenance({ contributions: [], quantity: 0, aggregation: { scope, scopeId } })
        };
        line.quantity = Number((line.quantity + sourceLine.quantity).toFixed(6));
        /* The rolled-up line keeps every underlying contribution, so a
           selection in the viewer still resolves to real source objects
           across documents, storeys and buildings. */
        line.provenance.contributions.push(...(sourceLine.provenance.contributions || []));
        for (const field of ['classificationEvidenceIds', 'classificationConflicts']) {
          if (sourceLine.provenance[field]?.length) line.provenance[field] = [...new Set([...(line.provenance[field] || []), ...sourceLine.provenance[field]])].sort();
        }
        if (sourceLine.provenance.classificationEvidence?.length) {
          const merged = [...(line.provenance.classificationEvidence || []), ...sourceLine.provenance.classificationEvidence];
          line.provenance.classificationEvidence = merged.filter((evidence, index, all) => all.findIndex((candidate) => candidate.id === evidence.id) === index);
        }
        if (sourceLine.provenance.fusionVersion) line.provenance.fusionVersion = sourceLine.provenance.fusionVersion;
        if (sourceLine.provenance.mappingSnapshot) line.provenance.mappingSnapshot = sourceLine.provenance.mappingSnapshot;
        /* A total that includes something we could not measure is not a total.
           Inheriting the weakest state stops a rollup presenting a partial sum
           as a complete one. */
        if (sourceLine.measurementStatus === 'not_measurable') line.provenance.impossible = sourceLine.provenance.impossible || { reason: 'A contributing measurement was not measurable.' };
        line.measurementStatus = line.provenance.impossible ? 'not_measurable' : measurementStatusFor(line.quantity, line.provenance.contributions);
        line.provenance.measurementStatus = line.measurementStatus;
        lines.set(sourceLine.measurement, line);
      }
    }
    return { scope, scopeId, boqVersionId: requestedBoqVersionId, quantityPolicy: 'latest-document-revision-per-boq-version-and-source-sheet-assignment', lines: [...lines.values()], sourceObjects: [...sourceObjects.values()], sourceContributions: contributions, unitDecisions, typicalStoreyMultiplier: 'explicit-only' };
  }

  /* Rendering a project draws a rollup for the project, each building and each
     storey. Loading per rollup would be N+1 in the number of storeys, so the
     whole tree is loaded once here and every nested rollup is computed from it. */
  function loadRollupContext(ids) {
    const unique = [...new Set(ids)];
    const candidates = repository.completedRuns(unique);
    const results = repository.resultsFor(candidates.map((entry) => entry.id));
    return {
      candidates,
      slice(runIds) {
        const wanted = new Set(runIds);
        const linesByRun = new Map([...results.linesByRun].filter(([runId]) => wanted.has(runId)));
        return { linesByRun, sourceObjects: results.sourceObjects };
      }
    };
  }

  function presentStorey(storey, requestedBoqVersionId = projects.get(storey.projectId).currentBoqVersionId, context = null) {
    return { ...storey, sourceDocuments: sourceDocumentsFor(storey.sourceDocumentIds).map(presentSourceDocument), rollup: rollupForSourceIds(storey.sourceDocumentIds, 'storey', storey.id, requestedBoqVersionId, context) };
  }
  function presentBuilding(building, requestedBoqVersionId = projects.get(building.projectId).currentBoqVersionId, context = null) {
    const ids = [...building.sourceDocumentIds, ...building.storeyIds.flatMap((storeyId) => storeys.get(storeyId)?.sourceDocumentIds || [])];
    const shared = context || loadRollupContext(ids);
    return { ...building, storeys: building.storeyIds.map((storeyId) => presentStorey(storeys.get(storeyId), requestedBoqVersionId, shared)), rollup: rollupForSourceIds(ids, 'building', building.id, requestedBoqVersionId, shared) };
  }
  function presentProject(project, requestedBoqVersionId = project.currentBoqVersionId) {
    const ids = [
      ...project.sourceDocumentIds,
      ...project.buildingIds.flatMap((buildingId) => {
        const building = buildings.get(buildingId);
        return [...(building?.sourceDocumentIds || []), ...(building?.storeyIds.flatMap((storeyId) => storeys.get(storeyId)?.sourceDocumentIds || []) || [])];
      })
    ];
    const context = loadRollupContext(ids);
    return {
      id: project.id,
      name: project.name,
      version: project.version,
      boqVersions: project.boqVersionIds.map((id) => ({ ...boqVersions.get(id) })),
      currentBoqVersionId: project.currentBoqVersionId,
      documentVersions: sourceDocumentsFor(ids).map(presentSourceDocument),
      buildings: project.buildingIds.map((buildingId) => presentBuilding(buildings.get(buildingId), requestedBoqVersionId, context)),
      rollup: rollupForSourceIds(ids, 'project', project.id, requestedBoqVersionId, context)
    };
  }

  function getProject(projectId, { boqVersionId } = {}) {
    const project = requireProject(projectId);
    const requestedBoqVersionId = boqVersionId || project.currentBoqVersionId;
    requireBoqVersion(project.id, requestedBoqVersionId);
    return presentProject(project, requestedBoqVersionId);
  }
  function getBuilding(buildingId) { return presentBuilding(requireBuilding(buildingId)); }
  function getStorey(storeyId) { return presentStorey(requireStorey(storeyId)); }

  function assignSourceToStorey(sourceDocumentId, { storeyId, typicalMultiplier, typicalStoreyMultiplier } = {}) {
    const storey = requireStorey(storeyId);
    return assignSourceDocument(sourceDocumentId, { projectId: storey.projectId, buildingId: storey.buildingId, storeyId, ...(typicalMultiplier === undefined && typicalStoreyMultiplier === undefined ? {} : { typicalMultiplier: typicalStoreyMultiplier ?? typicalMultiplier }) });
  }

  return { getLineEvidence, getObjectLines, getQueueStep, publishCatalogue, getCatalogues: cataloguesFor, exportBoq, publishRateBook, getPricedBoq, getRateBooks: rateBooksFor, recordVendorOffer, getVendorOffers, selectVendorOffer, rankExceptions, getExceptionQueue, resolveExceptionGroup, getResolutions, recordQuantityAffectingResolution, proposeRasterRegions, proposeResidualLabels, confirmResidual, visionAvailable: () => vision.available, createProject, createBuilding, createStorey, createBoqVersion, getProjectAssumptions, updateProjectAssumptions, approveBoqVersion, getBoqVersion, createStudioMapping, approveStudioMapping, retireStudioMapping, getStudioMappings, createSourceDocument, assignSourceDocument, assignSourceToStorey, startProcessing, confirmSourceSetup, calibrateRasterPage, createRasterRegion, updateRasterRegion, deleteRasterRegion, confirmRasterRegion, getRasterImage, getRun, getClassifications, submitOcrResults, addOcrResults: submitOcrResults, recordOcrResults: submitOcrResults, getOcrResults, getOcrStatus, getProject, getBuilding, getStorey, getProjectRollup: (projectId, options) => getProject(projectId, options).rollup, reprocess };
}

function classifyDocument(run, sourceDocument, entities) {
  const classifications = [...entities].sort((left, right) => String(left.handle).localeCompare(String(right.handle))).map((entity) => {
    const sourceObjectId = `${sourceDocument.id}:${entity.handle}`;
    const sourceObject = { sourceObjectId, entity, projectId: run.projectId, buildingId: run.buildingId, storeyId: run.storeyId, sourceSheet: run.assignmentSnapshot.sourceSheet };
    const context = { ...run.assignmentSnapshot, processingRunId: run.id, sourceObjectId, sourceObject };
    const evidence = [];
    const layer = layerCategory(entity.layer);
    if (layer) evidence.push({ id: `${sourceObjectId}:layer`, kind: 'layer', dimension: 'category', candidate: { value: layer }, source: { authority: 'native', quality: 'normal', reference: { sourceObjectId, sourceHandle: entity.handle } }, ...context });
    const item = itemFromBlock(entity.block);
    if (item) evidence.push({ id: `${sourceObjectId}:block`, kind: 'block', dimension: 'catalogItem', candidate: { value: item, categoryAncestor: item === 'chair' || item === 'stool' || item === 'sofa' ? 'seating' : 'furniture' }, source: { authority: 'native', quality: 'normal', reference: { sourceObjectId, sourceHandle: entity.handle } }, ...context });
    if (entity.type === 'HATCH' && entity.points?.length) evidence.push({ id: `${sourceObjectId}:geometry`, kind: 'geometry', dimension: 'category', candidate: { value: layer || 'furniture' }, source: { authority: 'native', quality: 'normal', reference: { sourceObjectId, sourceHandle: entity.handle } }, ...context });
    return { ...fuseEvidence(evidence, undefined, run.mappingSnapshot, { ...context, sourceObject }), sourceObject: { id: sourceObjectId, handle: entity.handle, type: entity.type, layer: entity.layer, block: entity.block, sourceSheet: run.assignmentSnapshot.sourceSheet } };
  });
  return groupClassificationConflicts(classifications);
}

function itemFromBlock(block = '') {
  const value = String(block).trim().toLowerCase().replace(/[_-]+/g, ' ');
  const match = /^(chair|stool|sofa|table|bed|desk|wardrobe)(?:\b|\s)/.exec(value);
  return match ? match[1] : null;
}

function mappingEligibleForRun(mapping, sourceDocument) {
  const scope = mapping.scope || {};
  const exact = (expected, actual) => expected === undefined || expected === null || expected === actual;
  return exact(mapping.studioId ?? scope.studioId, sourceDocument.studioId)
    && exact(scope.projectId, sourceDocument.projectId)
    && exact(scope.buildingId, sourceDocument.buildingId)
    && exact(scope.storeyId, sourceDocument.storeyId)
    && patternMatches(sourceDocument.sourceSheet, scope.sourceSheetPattern ?? scope.sourceSheet);
}

function attachClassificationProvenance(run) {
  const byHandle = new Map((run.classifications || []).map((classification) => [classification.sourceObjectId.split(':').at(-1), classification]));
  for (const line of run.boq?.lines || []) {
      const objectsById = new Map((run.boq?.sourceObjects || []).map((object) => [object.sourceObjectId, object]));
    const classifications = line.provenance.contributions
      .map((contribution) => objectsById.get(contribution.sourceObjectId)?.nativeHandle)
      .filter(Boolean)
      .map((handle) => byHandle.get(handle))
      .filter(Boolean);
    line.provenance.classificationEvidenceIds = [...new Set(classifications.flatMap((classification) => classification.evidence.map((evidence) => evidence.id)))].sort();
    line.provenance.classificationEvidence = classifications.flatMap((classification) => classification.evidence.map((evidence) => structuredClone(evidence))).filter((evidence, index, all) => all.findIndex((candidate) => candidate.id === evidence.id) === index).sort((a, b) => a.id.localeCompare(b.id));
    line.provenance.classificationConflicts = classifications.flatMap((classification) => classification.conflicts).map((conflict) => conflict.groupKey).filter(Boolean).filter((key, index, keys) => keys.indexOf(key) === index).sort();
    line.provenance.fusionVersion = FUSION_VERSION;
    line.provenance.mappingSnapshot = presentMappingSnapshot(run.mappingSnapshot);
  }
}

function presentMapping(mapping) {
  return { ...mapping, scope: { ...(mapping.scope || {}) }, target: { ...(mapping.target || {}) } };
}
function presentMappingSnapshot(snapshot) {
  if (!snapshot) return { version: 'mapping-snapshot-v1', mappingIds: [], mappingVersions: [], digest: null };
  return { version: snapshot.version, mappingIds: [...snapshot.mappingIds], mappingVersions: structuredClone(snapshot.mappingVersions || []), digest: snapshot.digest };
}

function measurePdf(sourceDocument, run) {
  const contributions = [];
  const sourceObjects = new Map();
  let area = 0;
  for (const setupPage of run.setup.pages) {
    const page = run.pages.find((candidate) => candidate.sourcePageId === setupPage.sourcePageId);
    const selected = page.vectorRegions.filter((region) => setupPage.selectedRegions.includes(region.id));
    for (const region of selected) {
      const scale = setupPage.scale.drawingUnitsPerMetre;
      const scaleSquared = scale ** 2;
      if (!Number.isFinite(scaleSquared) || scaleSquared <= Number.MIN_VALUE) throw new InputError(`Page ${page.pageNumber} scale cannot produce a finite area conversion.`);
      const rawQuantity = region.area / scaleSquared * run.typicalMultiplier;
      if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) throw new InputError(`Page ${page.pageNumber} produced a non-finite or zero quantity; choose a practical scale or simplify the source.`);
      const quantity = Number(rawQuantity.toFixed(6));
      if (!Number.isFinite(quantity) || quantity <= 0) throw new InputError(`Page ${page.pageNumber} produced a non-finite or zero quantity; choose a practical scale or simplify the source.`);
      area = Number((area + quantity).toFixed(6));
      if (!Number.isFinite(area)) throw new InputError(`Page ${page.pageNumber} produced a non-finite total quantity; choose a practical scale or simplify the source.`);
      const object = createSourceObject({
        sourceDocumentId: sourceDocument.id,
        sourceDocumentVersion: sourceDocument.version,
        buildingId: sourceDocument.buildingId ?? null,
        storeyId: sourceDocument.storeyId ?? null,
        sheetId: sourceDocument.sourceSheet || sourceDocument.filename || null,
        pageId: page.sourcePageId,
        geometrySource: 'native-vector',
        coordinateSpace: 'pdf-page',
        geometry: region.points,
        transform: page.transform || null,
        rotation: page.rotation ?? null,
        regionId: region.id
      });
      sourceObjects.set(object.sourceObjectId, object);
      contributions.push(createContribution({
        sourceObjectId: object.sourceObjectId,
        measurement: 'floor_area',
        sign: 'add',
        quantity,
        unit: 'm\u00b2',
        ruleId: 'pdf-vector-region-area-v1',
        rulesetVersion: run.versions.ruleset,
        runId: run.id,
        typicalMultiplier: run.typicalMultiplier,
        ruleInputs: { scale: { drawingUnitsPerMetre: setupPage.scale.drawingUnitsPerMetre }, setupRevision: setupPage.revision }
      }));
    }
  }
  return {
    versions: run.versions,
    ruleset: run.versions.ruleset,
    sourceObjects: [...sourceObjects.values()],
    aggregation: { scope: 'source_document', scopeId: sourceDocument.id },
    lines: [{
      measurement: 'floor_area',
      label: 'Floor finish area',
      quantity: area,
      unit: 'm\u00b2',
      confidence: { level: 'HIGH', evidence: ['native vector path', 'operator-selected page region'] },
      measurementStatus: measurementStatusFor(area, contributions),
      provenance: buildProvenance({ contributions, quantity: area, aggregation: { scope: 'source_document', scopeId: sourceDocument.id } })
    }]
  };
}

function point(value) {
  const x = Number(value?.x); const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function validatePolygon(points, page) {
  if (!Array.isArray(points) || points.length < 3) throw new InputError(`A raster region requires at least three points.`);
  if (points.length > LIMITS.rasterRegionPoints) throw new LimitError(`A raster region may contain at most ${LIMITS.rasterRegionPoints} points.`, { limitName: 'rasterRegionPoints', observed: points.length, maximum: LIMITS.rasterRegionPoints, stage: 'trace' });
  const normalized = points.map(point);
  const width = Number(page.pixelWidth || page.width); const height = Number(page.pixelHeight || page.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || normalized.some((candidate) => !candidate || candidate.x < 0 || candidate.y < 0 || candidate.x > width || candidate.y > height)) throw new InputError('Raster region points must be finite and inside the image bounds.');
  const keys = new Set(normalized.map((candidate) => candidate ? `${candidate.x}:${candidate.y}` : 'invalid'));
  if (keys.size !== normalized.length) throw new InputError('Raster region boundary must not repeat points.');
  const area = polygonArea(normalized);
  if (!Number.isFinite(area) || area <= 0) throw new InputError('Raster region boundary must enclose a non-zero area.');
  for (let i = 0; i < normalized.length; i += 1) for (let j = i + 1; j < normalized.length; j += 1) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === normalized.length - 1)) continue;
    if (segmentsIntersect(normalized[i], normalized[(i + 1) % normalized.length], normalized[j], normalized[(j + 1) % normalized.length])) throw new InputError('Raster region boundary must not self-intersect.');
  }
  return normalized;
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const orientation = (value) => Math.abs(value) < Number.EPSILON ? 0 : value > 0 ? 1 : -1;
  const abC = orientation(cross(a, b, c)); const abD = orientation(cross(a, b, d));
  const cdA = orientation(cross(c, d, a)); const cdB = orientation(cross(c, d, b));
  const onSegment = (p, q, r) => q.x >= Math.min(p.x, r.x) && q.x <= Math.max(p.x, r.x) && q.y >= Math.min(p.y, r.y) && q.y <= Math.max(p.y, r.y);
  if (abC === 0 && onSegment(a, c, b)) return true;
  if (abD === 0 && onSegment(a, d, b)) return true;
  if (cdA === 0 && onSegment(c, a, d)) return true;
  if (cdB === 0 && onSegment(c, b, d)) return true;
  return abC !== abD && cdA !== cdB;
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, current, index) => {
    const next = points[(index + 1) % points.length];
    return sum + current.x * next.y - next.x * current.y;
  }, 0) / 2);
}

function stripHistory(value) {
  const copy = structuredClone(value);
  delete copy.history;
  return copy;
}

function restoreRasterPages(storedPages = [], inspectedPages) {
  return inspectedPages.map((page) => {
    const stored = storedPages.find((candidate) => candidate.sourcePageId === page.sourcePageId);
    const canonical = {
      ...page,
      pixelWidth: Number(page.pixelWidth || page.width),
      pixelHeight: Number(page.pixelHeight || page.height),
      coordinateSpace: page.kind === 'mixed' || page.kind === 'raster' ? 'image' : page.coordinateSpace,
      sourceTransform: page.sourceTransform || page.transform,
      rasterTransform: page.rasterTransform || [1, 0, 0, 1, 0, 0]
    };
    return stored
      ? { ...canonical, ...structuredClone(stored), pixelWidth: canonical.pixelWidth, pixelHeight: canonical.pixelHeight, nativeText: page.nativeText, nativeRegionIds: page.nativeRegionIds, vectorRegions: page.vectorRegions, rasterRegions: page.rasterRegions, revision: stored.revision ?? stored.calibration?.revision ?? 0 }
      : { ...canonical, calibration: null, regions: [], revision: 0 };
  });
}

function presentRasterPage(page) {
  return structuredClone(page);
}

function measureRaster(sourceDocument, run) {
  let area = 0;
  const contributions = [];
  const sourceObjects = new Map();
  const byCategory = new Map();
  if (!Number.isInteger(run.typicalMultiplier) || run.typicalMultiplier < 1 || run.typicalMultiplier > LIMITS.typicalMultiplierMax) throw new InputError('Raster measurement has an invalid typical-storey multiplier.');
  for (const page of run.pages) {
    if (page.route !== 'raster') continue;
    const calibration = page.calibration;
    if (!calibration || calibration.status !== 'confirmed') throw new InputError(`Raster page ${page.sourcePageId} is not calibrated.`);
    const scaleSquared = calibration.pixelsPerMetre * calibration.pixelsPerMetre;
    const inverseScaleSquared = 1 / scaleSquared;
    if (!Number.isFinite(calibration.realDistanceMetres) || calibration.realDistanceMetres < LIMITS.rasterRealDistanceMin || calibration.realDistanceMetres > LIMITS.rasterRealDistanceMax || !Number.isFinite(calibration.pixelsPerMetre) || calibration.pixelsPerMetre < LIMITS.rasterPixelsPerMetreMin || calibration.pixelsPerMetre > LIMITS.rasterPixelsPerMetreMax || !Number.isFinite(scaleSquared) || scaleSquared <= 0 || !Number.isFinite(inverseScaleSquared) || inverseScaleSquared <= 0) throw new InputError(`Raster page ${page.sourcePageId} calibration cannot produce a finite, bounded area conversion.`);
    let pageArea = 0;
    for (const region of page.regions.filter((candidate) => candidate.lifecycle === 'confirmed')) {
      const regionArea = polygonArea(region.points);
      const rawQuantity = regionArea * inverseScaleSquared * run.typicalMultiplier;
      if (!Number.isFinite(regionArea) || regionArea <= 0 || !Number.isFinite(rawQuantity) || rawQuantity <= 0) throw new InputError(`Raster region ${region.id} produced a non-finite or zero quantity.`);
      const quantity = Number(rawQuantity.toFixed(6));
      if (!Number.isFinite(quantity) || quantity <= 0) throw new InputError(`Raster region ${region.id} produced a non-finite or zero quantity.`);
      pageArea = Number((pageArea + quantity).toFixed(6));
      if (!Number.isFinite(pageArea) || pageArea <= 0) throw new InputError(`Raster page ${page.sourcePageId} produced a non-finite aggregate area.`);
      area = Number((area + quantity).toFixed(6));
      if (!Number.isFinite(area) || area <= 0) throw new InputError('Raster source produced a non-finite aggregate area.');
      const measurement = normalizeRasterCategory(region.category);
      if (!measurement) throw new InputError(`Raster region ${region.id} must have a supported category before measurement.`);
      const categoryArea = Number(((byCategory.get(measurement) || 0) + quantity).toFixed(6));
      if (!Number.isFinite(categoryArea) || categoryArea <= 0) throw new InputError(`Raster category ${measurement} produced a non-finite aggregate area.`);
      byCategory.set(measurement, categoryArea);
      /* A region traced by a human and a model proposal a human confirmed are
         both valid evidence, but they are not the same claim, and the
         difference has to survive as far as an export. */
      const object = createSourceObject({
        sourceDocumentId: sourceDocument.id,
        sourceDocumentVersion: sourceDocument.version,
        buildingId: sourceDocument.buildingId ?? null,
        storeyId: sourceDocument.storeyId ?? null,
        sheetId: sourceDocument.sourceSheet || sourceDocument.filename || null,
        pageId: page.sourcePageId,
        /* Only confirmed regions reach measurement (see the filter above), so a
           model-proposed region here has been through a human decision. */
        geometrySource: region.origin === 'model-proposed' ? 'model-proposed-confirmed' : 'human-traced',
        coordinateSpace: 'raster-pixel',
        geometry: region.points,
        transform: page.sourceTransform || page.transform || null,
        rotation: page.rotation ?? 0,
        regionId: region.id
      });
      sourceObjects.set(object.sourceObjectId, object);
      contributions.push(createContribution({
        sourceObjectId: object.sourceObjectId,
        measurement,
        sign: 'add',
        quantity,
        unit: 'm\u00b2',
        ruleId: 'raster-traced-region-area-v1',
        rulesetVersion: run.versions.ruleset,
        runId: run.id,
        typicalMultiplier: run.typicalMultiplier,
        ruleInputs: { calibrationRevision: calibration.revision, pixelsPerMetre: calibration.pixelsPerMetre, realDistance: calibration.realDistance, realUnit: calibration.realUnit, realDistanceMetres: calibration.realDistanceMetres, category: region.category }
      }));
    }
  }
  const lines = [...byCategory.entries()].map(([measurement, quantity]) => {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new InputError(`Raster category ${measurement} produced an invalid aggregate area.`);
    const lineContributions = contributions.filter((contribution) => contribution.measurement === measurement);
    return { measurement, label: measurement === 'floor_area' ? 'Floor finish area' : measurement === 'wall_area' ? 'Wall finish area' : measurement, quantity, unit: 'm\u00b2', confidence: { level: 'HIGH', evidence: ['operator-confirmed calibration', 'human-traced region'] }, measurementStatus: measurementStatusFor(quantity, lineContributions), provenance: buildProvenance({ contributions: lineContributions, quantity, aggregation: { scope: 'source_document', scopeId: sourceDocument.id } }) };
  });
  /* No confirmed region resolved at all. That is not a floor area of zero --
     nothing was measured -- and the two must never render alike. */
  if (!lines.length) lines.push({ measurement: 'floor_area', label: 'Floor finish area', quantity: area, unit: 'm\u00b2', confidence: { level: 'HIGH', evidence: ['operator-confirmed calibration', 'human-traced region'] }, measurementStatus: measurementStatusFor(area, []), provenance: buildProvenance({ contributions: [], quantity: area, aggregation: { scope: 'source_document', scopeId: sourceDocument.id } }) });
  return { versions: run.versions, ruleset: run.versions.ruleset, sourceObjects: [...sourceObjects.values()], aggregation: { scope: 'source_document', scopeId: sourceDocument.id }, lines };
}

function normalizeRasterCategory(value) {
  const category = String(value ?? '').trim();
  if (!category) return null;
  if (category.length > LIMITS.rasterCategoryLength) throw new InputError(`Raster category must be at most ${LIMITS.rasterCategoryLength} characters.`);
  if (!['floor_area', 'wall_area'].includes(category)) throw new InputError('Raster category must be one of: floor_area, wall_area.');
  return category;
}

function stageState(name, status) {
  return ['ingestion', 'measurement', 'boq'].map((stage) => ({
    name: stage,
    status: stage === name ? status : 'pending'
  }));
}

function setStage(run, name, status) {
  run.stages.find((stage) => stage.name === name).status = status;
}

function completeStage(run, name) {
  setStage(run, name, 'completed');
}

function failRun(run, error, stageName, sourceDocument) {
  run.status = 'failed';
  const message = error.message || 'Unexpected PDF processing failure.';
  const pageContext = error.sourcePageId ? ` Affected page: ${error.sourcePageId}.` : '';
  run.error = sourceDocument?.format === 'pdf' && error.code !== 'mixed_pdf_unsupported' && !/re-export|split the source|source assignment/i.test(message)
    ? `PDF "${sourceDocument.filename}" could not be processed: ${message}${pageContext} Re-export a born-digital vector PDF or split the source into smaller files.`
    : `${message}${pageContext}`;
  run.blockedReasons = [];
  run.exportable = false;
  run.errorDetails = {
    sourcePageId: error.sourcePageId || null,
    stage: stageName,
    adapterStage: error.stage || stageName,
    code: error.code || (sourceDocument?.format === 'pdf' ? 'pdf_processing_failed' : 'processing_failed'),
    retryable: error.retryable ?? false,
    action: sourceDocument?.format === 'pdf' ? 'Re-export the affected PDF page or split the source into smaller files, then retry.' : 'Review the source and retry.'
  };
  if (error.limitName) Object.assign(run, { limitName: error.limitName, observed: error.observed, maximum: error.maximum });
  setStage(run, stageName, 'failed');
}

function isCurrentSnapshot(run, sourceDocument) {
  if (!sourceDocument || !run.assignmentSnapshot) return false;
  const snapshot = run.assignmentSnapshot;
  return ['projectId', 'buildingId', 'storeyId', 'sourceSheet', 'typicalMultiplier', 'contentSha256']
    .every((key) => sourceDocument[key] === snapshot[key])
    && sourceDocument.boqVersionId === snapshot.sourceBoqVersionId
    && sourceDocument.id === snapshot.sourceDocumentId
    && sourceDocument.version === snapshot.sourceDocumentVersion;
}

function isCurrentRasterRun(run, sourceDocument) {
  return Boolean(sourceDocument && run && sourceDocument.currentProcessingRunId === run.id && sourceDocument.processingRevision === run.sourceProcessingRevision);
}

function canReplaySetup(setup, run, sourceDocument) {
  if (setup.route !== 'vector-pdf' || setup.status !== 'ready' || !isCurrentSnapshot(run, sourceDocument)) return false;
  const pageIds = new Set(run.pages.map((page) => page.sourcePageId));
  return Array.isArray(setup.pages) && setup.pages.length === pageIds.size && setup.pages.every((setupPage) => {
    const page = run.pages.find((candidate) => candidate.sourcePageId === setupPage.sourcePageId);
    return page && Array.isArray(setupPage.selectedRegions) && setupPage.selectedRegions.length > 0 && setupPage.selectedRegions.every((regionId) => page.nativeRegionIds.includes(regionId));
  });
}

function presentSourceDocument(sourceDocument) {
  return {
    id: sourceDocument.id,
    filename: sourceDocument.filename,
    version: sourceDocument.version,
    mediaType: sourceDocument.mediaType,
    format: sourceDocument.format,
    byteLength: sourceDocument.byteLength,
    ingestVersion: sourceDocument.ingestVersion,
    contentSha256: sourceDocument.contentSha256,
    studioId: sourceDocument.studioId || null,
    fallbackUnit: sourceDocument.fallbackUnit ? sourceDocument.fallbackUnit.name : null,
    projectId: sourceDocument.projectId || null,
    buildingId: sourceDocument.buildingId || null,
    storeyId: sourceDocument.storeyId || null,
    sourceSheet: sourceDocument.sourceSheet || sourceDocument.filename,
    boqVersionId: sourceDocument.boqVersionId || null,
    typicalMultiplier: sourceDocument.typicalMultiplier || 1,
    assignment: sourceDocument.projectId ? {
      studioId: sourceDocument.studioId || null,
      projectId: sourceDocument.projectId,
      buildingId: sourceDocument.buildingId,
      storeyId: sourceDocument.storeyId,
      sourceSheet: sourceDocument.sourceSheet,
      typicalMultiplier: sourceDocument.typicalMultiplier || 1
    } : null
  };
}

function presentRun(run, sourceDocument) {
  const processedSourceDocument = run.assignmentSnapshot
    ? presentSourceDocument({ ...sourceDocument, ...run.assignmentSnapshot })
    : presentSourceDocument(sourceDocument);
  const currentSourceDocument = run.assignmentSnapshot && ['studioId', 'projectId', 'buildingId', 'storeyId', 'sourceSheet', 'boqVersionId', 'typicalMultiplier'].some((key) => sourceDocument[key] !== run.assignmentSnapshot[key])
    ? presentSourceDocument(sourceDocument)
    : null;
  const classifications = structuredClone(run.classifications || []);
  const conflicts = classifications.flatMap((classification) => classification.conflicts || []).filter((conflict, index, all) => all.findIndex((candidate) => candidate.groupKey === conflict.groupKey) === index);
  return {
    id: run.id,
    status: run.status,
    sourceDocument: processedSourceDocument,
    currentSourceDocument,
    versions: run.versions,
    rulesetVersion: run.rulesetVersion || null,
    assumptions: run.assumptions ? structuredClone(run.assumptions) : null,
    exportable: run.exportable === true,
    exportBlockedReasons: [...(run.exportBlockedReasons || [])],
    residuals: structuredClone(run.residuals || []),
    residualSummary: run.residualSummary ? { ...run.residualSummary } : null,
    projectId: run.projectId,
    buildingId: run.buildingId,
    storeyId: run.storeyId,
    boqVersionId: run.boqVersionId,
    typicalMultiplier: run.typicalMultiplier,
    assignmentSnapshot: run.assignmentSnapshot,
    mappingSnapshot: presentMappingSnapshot(run.mappingSnapshot),
    decisionContext: structuredClone(run.decisionContext),
    classifications,
    conflicts,
    superseded: run.superseded,
    pages: run.pages,
    ocr: structuredClone(run.ocr || { status: 'idle', observations: [], batches: [], lastBatchKey: null }),
    inspection: run.inspection || null,
    setup: run.setup,
    blockedReasons: run.blockedReasons,
    exportable: run.exportable,
    ...(run.limitName ? { limitName: run.limitName, observed: run.observed, maximum: run.maximum } : {}),
    errorDetails: run.errorDetails || null,
    units: run.units,
    stages: run.stages,
    boq: run.boq,
    error: run.error
  };
}

function removeValue(values, value) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function normalizeUnit(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  const aliases = {
    '4': 4, mm: 4, millimetre: 4, millimetres: 4, millimeter: 4, millimeters: 4,
    '5': 5, cm: 5, centimetre: 5, centimetres: 5, centimeter: 5, centimeters: 5,
    '6': 6, m: 6, metre: 6, metres: 6, meter: 6, meters: 6
  };
  const code = aliases[normalized];
  return code ? UNIT_DEFINITIONS[code] : null;
}

class NotFoundError extends Error {}
class ConflictError extends Error {}

module.exports = { createApplication, InputError, NotFoundError, ConflictError };
