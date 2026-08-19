const { createHash } = require('node:crypto');
const { DXF_VERSIONS, inspectDxf, measureDxf, UNIT_DEFINITIONS, InputError } = require('./dxf');

const VERSIONS = DXF_VERSIONS;
const PROCESSING_STAGE_DELAY_MS = 150;

function createApplication({ schedule = setTimeout } = {}) {
  const sourceDocuments = new Map();
  const runs = new Map();
  const projects = new Map();
  const buildings = new Map();
  const storeys = new Map();
  const boqVersions = new Map();
  let sourceSequence = 0;
  let runSequence = 0;
  let projectSequence = 0;
  let buildingSequence = 0;
  let storeySequence = 0;
  let boqVersionSequence = 0;

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
  function validateAssignment({ projectId, buildingId, storeyId, sourceSheet, boqVersionId, typicalMultiplier = 1 }) {
    if (!projectId && !buildingId && !storeyId && boqVersionId) throw new InputError('A source assignment requires a project.');
    const storey = storeyId ? requireStorey(storeyId) : null;
    const building = buildingId ? requireBuilding(buildingId) : storey ? requireBuilding(storey.buildingId) : null;
    const project = projectId ? requireProject(projectId) : building ? requireProject(building.projectId) : null;
    if (building && building.projectId !== project?.id) throw new InputError('The building does not belong to the selected project.');
    if (storey && (!building || storey.buildingId !== building.id)) throw new InputError('The storey does not belong to the selected building.');
    const multiplier = Number(typicalMultiplier);
    if (!Number.isInteger(multiplier) || multiplier < 1) throw new InputError('Typical-storey multiplier must be an explicit positive integer.');
    if (multiplier > 1 && !storey) throw new InputError('A typical-storey multiplier greater than one requires a storey assignment.');
    if (boqVersionId) {
      const boqVersion = boqVersions.get(boqVersionId);
      if (!boqVersion || boqVersion.projectId !== project?.id) throw new InputError('The BOQ version does not belong to the selected project.');
    }
    return { projectId: project?.id || null, buildingId: building?.id || null, storeyId: storey?.id || null, sourceSheet: String(sourceSheet || '').trim() || null, boqVersionId: boqVersionId || project?.currentBoqVersionId || null, typicalMultiplier: multiplier };
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
      projectId: sourceDocument.projectId,
      buildingId: sourceDocument.buildingId,
      storeyId: sourceDocument.storeyId,
      sourceSheet: sourceDocument.sourceSheet,
      sourceDocumentId: sourceDocument.id,
      sourceDocumentVersion: sourceDocument.version,
      contentSha256: sourceDocument.contentSha256,
      boqVersionId: resolvedBoqVersionId,
      typicalMultiplier: sourceDocument.typicalMultiplier
    };
  }
  function invalidateRuns(sourceDocumentId) {
    for (const run of runs.values()) {
      if (run.sourceDocumentId === sourceDocumentId && ['ingestion', 'measurement', 'boq', 'completed'].includes(run.status)) run.superseded = true;
    }
  }

  function createProject({ name }) {
    if (!String(name || '').trim()) throw new InputError('A project name is required.');
    const project = { id: `project_${String(++projectSequence).padStart(4, '0')}`, name: String(name).trim(), version: 1, buildingIds: [], sourceDocumentIds: [], boqVersionIds: [], currentBoqVersionId: null };
    projects.set(project.id, project);
    project.currentBoqVersionId = createBoqVersion({ projectId: project.id, label: 'Initial BOQ' }).id;
    return presentProject(project);
  }

  function createBuilding({ projectId, name }) {
    const project = requireProject(projectId);
    if (!String(name || '').trim()) throw new InputError('A building name is required.');
    const building = { id: `building_${String(++buildingSequence).padStart(4, '0')}`, projectId: project.id, name: String(name).trim(), version: 1, storeyIds: [], sourceDocumentIds: [] };
    buildings.set(building.id, building);
    project.buildingIds.push(building.id);
    return presentBuilding(building);
  }

  function createStorey({ buildingId, name, level = null }) {
    const building = requireBuilding(buildingId);
    if (!String(name || '').trim()) throw new InputError('A storey name is required.');
    const storey = { id: `storey_${String(++storeySequence).padStart(4, '0')}`, buildingId: building.id, projectId: building.projectId, name: String(name).trim(), level, version: 1, sourceDocumentIds: [] };
    storeys.set(storey.id, storey);
    building.storeyIds.push(storey.id);
    return presentStorey(storey);
  }

  function createBoqVersion({ projectId, label = 'BOQ version' }) {
    const project = requireProject(projectId);
    const version = { id: `boqv_${String(++boqVersionSequence).padStart(4, '0')}`, projectId: project.id, version: project.boqVersionIds.length + 1, label: String(label || 'BOQ version'), status: 'open' };
    boqVersions.set(version.id, version);
    project.boqVersionIds.push(version.id);
    project.currentBoqVersionId = version.id;
    return { ...version };
  }

  function createSourceDocument({ filename, content, fallbackUnit, projectId, buildingId, storeyId, sourceSheet, sheet, boqVersionId, typicalMultiplier = 1, typicalStoreyMultiplier }) {
    if (isDwg(filename, content)) {
      throw new InputError('DWG files are refused. Use a native DXF export from the authoring CAD application; no automatic conversion is performed.');
    }
    if (!/\.dxf$/i.test(filename || '')) throw new InputError('Only DXF files can be submitted.');

    const explicitUnit = normalizeUnit(fallbackUnit);
    if (fallbackUnit !== undefined && fallbackUnit !== null && fallbackUnit !== '' && !explicitUnit) {
      throw new InputError('Choose a supported fallback unit: millimetres, centimetres, or metres.');
    }

    const assignment = validateAssignment({ projectId, buildingId, storeyId, sourceSheet: sourceSheet || sheet || filename, boqVersionId, typicalMultiplier: typicalStoreyMultiplier ?? typicalMultiplier });
    const previousVersions = [...sourceDocuments.values()].filter((document) => assignment.projectId && document.projectId === assignment.projectId && document.sourceSheet === assignment.sourceSheet);

    const sourceDocument = {
      id: `src_${String(++sourceSequence).padStart(4, '0')}`,
      filename,
      version: previousVersions.reduce((highest, document) => Math.max(highest, document.version), 0) + 1,
      content,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      fallbackUnit: explicitUnit,
      ...assignment
    };
    sourceDocuments.set(sourceDocument.id, sourceDocument);
    addAssignmentReference(sourceDocument);
    return presentSourceDocument(sourceDocument);
  }

  function assignSourceDocument(sourceDocumentId, assignment) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');
    const next = validateAssignment({ ...sourceDocument, ...assignment });
    const changed = ['projectId', 'buildingId', 'storeyId', 'sourceSheet', 'boqVersionId', 'typicalMultiplier'].some((key) => sourceDocument[key] !== next[key]);
    if (!changed) return presentSourceDocument(sourceDocument);
    invalidateRuns(sourceDocument.id);
    removeAssignmentReference(sourceDocument);
    Object.assign(sourceDocument, next);
    addAssignmentReference(sourceDocument);
    const processingRun = startProcessing(sourceDocument.id, { boqVersionId: sourceDocument.boqVersionId });
    return Object.assign(presentSourceDocument(sourceDocument), { processingRun });
  }

  function startProcessing(sourceDocumentId, { boqVersionId } = {}) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');

    const resolvedBoqVersionId = boqVersionId || sourceDocument.boqVersionId || null;
    if (resolvedBoqVersionId) requireBoqVersion(sourceDocument.projectId, resolvedBoqVersionId);
    const run = {
      id: `run_${String(++runSequence).padStart(4, '0')}`,
      sequence: runSequence,
      sourceDocumentId,
      versions: { ...VERSIONS },
      projectId: sourceDocument.projectId || null,
      buildingId: sourceDocument.buildingId || null,
      storeyId: sourceDocument.storeyId || null,
      boqVersionId: resolvedBoqVersionId,
      typicalMultiplier: sourceDocument.typicalMultiplier || 1,
      assignmentSnapshot: assignmentSnapshot(sourceDocument, resolvedBoqVersionId),
      superseded: false,
      status: 'ingestion',
      stages: stageState('ingestion', 'running'),
      units: null,
      boq: null,
      error: null
    };
    runs.set(run.id, run);
    schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
    return presentRun(run, sourceDocument);
  }

  function advance(run) {
    if (run.superseded) return;
    if (run.status === 'ingestion') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        const inspection = inspectDxf(document, { versions: VERSIONS });
        run.parsedDocument = inspection.document;
        run.units = inspection.units;
        completeStage(run, 'ingestion');
        run.status = 'measurement';
        setStage(run, 'measurement', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error, 'ingestion');
      }
      return;
    }

    if (run.status === 'measurement') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        run.boq = measureDxf(document, run.units, run.parsedDocument, { versions: VERSIONS, typicalMultiplier: run.typicalMultiplier });
        completeStage(run, 'measurement');
        run.status = 'boq';
        setStage(run, 'boq', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error, 'measurement');
      }
      return;
    }

    if (run.status === 'boq') {
      completeStage(run, 'boq');
      run.status = 'completed';
    }
  }

  function getRun(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return presentRun(run, sourceDocuments.get(run.sourceDocumentId));
  }

  function reprocess(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    if (run.superseded) throw new InputError('This processing run is superseded; reprocess the current source assignment instead.');
    return startProcessing(run.sourceDocumentId, { boqVersionId: run.boqVersionId });
  }

  function sourceDocumentsFor(ids) {
    return [...sourceDocuments.values()].filter((sourceDocument) => ids.includes(sourceDocument.id));
  }

  function rollupForSourceIds(ids, scope, scopeId, requestedBoqVersionId = null) {
    const documents = sourceDocumentsFor(ids);
    const selected = new Map();
    for (const sourceDocument of documents) {
      for (const run of runs.values()) {
        const snapshot = run.assignmentSnapshot;
        if (run.sourceDocumentId !== sourceDocument.id || run.status !== 'completed' || run.superseded || !run.boq || !snapshot) continue;
        if (requestedBoqVersionId && snapshot.boqVersionId !== requestedBoqVersionId) continue;
        const contributionKey = [snapshot.boqVersionId || run.id, snapshot.projectId, snapshot.buildingId, snapshot.storeyId, snapshot.sourceSheet].join('|');
        const previous = selected.get(contributionKey);
        if (!previous || snapshot.sourceDocumentVersion > previous.run.assignmentSnapshot.sourceDocumentVersion || (snapshot.sourceDocumentVersion === previous.run.assignmentSnapshot.sourceDocumentVersion && run.sequence > previous.run.sequence)) {
          selected.set(contributionKey, { sourceDocument, run });
        }
      }
    }
    const lines = new Map();
    const contributions = [];
    const unitDecisions = [];
    for (const { sourceDocument, run } of selected.values()) {
      const snapshot = run.assignmentSnapshot;
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
          provenance: { scope, scopeId, sourceContributions: [] }
        };
        line.quantity = Number((line.quantity + sourceLine.quantity).toFixed(6));
        line.provenance.sourceContributions.push({
          ...contribution,
          sourceHandles: sourceLine.provenance.sourceHandles,
          runId: run.id,
          quantity: sourceLine.quantity
        });
        lines.set(sourceLine.measurement, line);
      }
    }
    return { scope, scopeId, boqVersionId: requestedBoqVersionId, quantityPolicy: 'latest-document-revision-per-boq-version-and-source-sheet-assignment', lines: [...lines.values()], sourceContributions: contributions, unitDecisions, typicalStoreyMultiplier: 'explicit-only' };
  }

  function presentStorey(storey, requestedBoqVersionId = projects.get(storey.projectId).currentBoqVersionId) {
    return { ...storey, sourceDocuments: sourceDocumentsFor(storey.sourceDocumentIds).map(presentSourceDocument), rollup: rollupForSourceIds(storey.sourceDocumentIds, 'storey', storey.id, requestedBoqVersionId) };
  }
  function presentBuilding(building, requestedBoqVersionId = projects.get(building.projectId).currentBoqVersionId) {
    const ids = [...building.sourceDocumentIds, ...building.storeyIds.flatMap((storeyId) => storeys.get(storeyId)?.sourceDocumentIds || [])];
    return { ...building, storeys: building.storeyIds.map((storeyId) => presentStorey(storeys.get(storeyId), requestedBoqVersionId)), rollup: rollupForSourceIds(ids, 'building', building.id, requestedBoqVersionId) };
  }
  function presentProject(project, requestedBoqVersionId = project.currentBoqVersionId) {
    const ids = [
      ...project.sourceDocumentIds,
      ...project.buildingIds.flatMap((buildingId) => {
        const building = buildings.get(buildingId);
        return [...(building?.sourceDocumentIds || []), ...(building?.storeyIds.flatMap((storeyId) => storeys.get(storeyId)?.sourceDocumentIds || []) || [])];
      })
    ];
    return {
      id: project.id,
      name: project.name,
      version: project.version,
      boqVersions: project.boqVersionIds.map((id) => ({ ...boqVersions.get(id) })),
      currentBoqVersionId: project.currentBoqVersionId,
      documentVersions: sourceDocumentsFor(ids).map(presentSourceDocument),
      buildings: project.buildingIds.map((buildingId) => presentBuilding(buildings.get(buildingId), requestedBoqVersionId)),
      rollup: rollupForSourceIds(ids, 'project', project.id, requestedBoqVersionId)
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

  return { createProject, createBuilding, createStorey, createBoqVersion, createSourceDocument, assignSourceDocument, assignSourceToStorey, startProcessing, getRun, getProject, getBuilding, getStorey, getProjectRollup: (projectId, options) => getProject(projectId, options).rollup, reprocess };
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

function failRun(run, error, stageName) {
  run.status = 'failed';
  run.error = error.message;
  setStage(run, stageName, 'failed');
}

function presentSourceDocument(sourceDocument) {
  return {
    id: sourceDocument.id,
    filename: sourceDocument.filename,
    version: sourceDocument.version,
    contentSha256: sourceDocument.contentSha256,
    fallbackUnit: sourceDocument.fallbackUnit ? sourceDocument.fallbackUnit.name : null,
    projectId: sourceDocument.projectId || null,
    buildingId: sourceDocument.buildingId || null,
    storeyId: sourceDocument.storeyId || null,
    sourceSheet: sourceDocument.sourceSheet || sourceDocument.filename,
    boqVersionId: sourceDocument.boqVersionId || null,
    typicalMultiplier: sourceDocument.typicalMultiplier || 1,
    assignment: sourceDocument.projectId ? {
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
  const currentSourceDocument = run.assignmentSnapshot && ['projectId', 'buildingId', 'storeyId', 'sourceSheet', 'boqVersionId', 'typicalMultiplier'].some((key) => sourceDocument[key] !== run.assignmentSnapshot[key])
    ? presentSourceDocument(sourceDocument)
    : null;
  return {
    id: run.id,
    status: run.status,
    sourceDocument: processedSourceDocument,
    currentSourceDocument,
    versions: run.versions,
    projectId: run.projectId,
    buildingId: run.buildingId,
    storeyId: run.storeyId,
    boqVersionId: run.boqVersionId,
    typicalMultiplier: run.typicalMultiplier,
    assignmentSnapshot: run.assignmentSnapshot,
    superseded: run.superseded,
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

function isDwg(filename, content) {
  if (/\.dwg$/i.test(filename || '')) return true;
  return /^AC10\d{2}/.test(String(content || '').slice(0, 6));
}

class NotFoundError extends Error {}

module.exports = { createApplication, InputError, NotFoundError };
