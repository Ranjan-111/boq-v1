const { createHash } = require('node:crypto');
const { DXF_VERSIONS, inspectDxf, measureDxf, UNIT_DEFINITIONS, InputError } = require('./dxf');
const { asBytes, sniffContent } = require('./ingestion/sniff');
const { inspectPdf, PDF_VERSIONS } = require('./ingestion/pdf');
const { inspectRaster, RASTER_VERSIONS } = require('./ingestion/raster');
const { LIMITS, LimitError } = require('./ingestion/limits');

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
    if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > LIMITS.typicalMultiplierMax) throw new InputError(`Typical-storey multiplier must be an explicit integer between 1 and ${LIMITS.typicalMultiplierMax}.`);
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
      sourceBoqVersionId: sourceDocument.boqVersionId,
      boqVersionId: resolvedBoqVersionId,
      typicalMultiplier: sourceDocument.typicalMultiplier
    };
  }
  function invalidateRuns(sourceDocumentId) {
    for (const run of runs.values()) {
      if (run.sourceDocumentId === sourceDocumentId && ['ingestion', 'awaiting_setup', 'awaiting_calibration', 'awaiting_trace', 'awaiting_confirmation', 'measurement', 'boq', 'completed'].includes(run.status)) run.superseded = true;
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
    const bytes = asBytes(content);
    const sniffed = sniffContent(bytes);
    if (sniffed.format === 'dwg') {
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

    const assignment = validateAssignment({ projectId, buildingId, storeyId, sourceSheet: sourceSheet || sheet || filename, boqVersionId, typicalMultiplier: typicalStoreyMultiplier ?? typicalMultiplier });
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

  function startProcessing(sourceDocumentId, { boqVersionId, replaySetup } = {}) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');

    const resolvedBoqVersionId = boqVersionId || sourceDocument.boqVersionId || null;
    if (resolvedBoqVersionId) requireBoqVersion(sourceDocument.projectId, resolvedBoqVersionId);
    const run = {
      id: `run_${String(++runSequence).padStart(4, '0')}`,
      sequence: runSequence,
      sourceDocumentId,
      versions: sourceDocument.format === 'pdf' ? { ...PDF_VERSIONS } : ['png', 'jpeg'].includes(sourceDocument.format) ? { ...RASTER_VERSIONS } : { ...VERSIONS },
      projectId: sourceDocument.projectId || null,
      buildingId: sourceDocument.buildingId || null,
      storeyId: sourceDocument.storeyId || null,
      boqVersionId: resolvedBoqVersionId,
      typicalMultiplier: sourceDocument.typicalMultiplier || 1,
      assignmentSnapshot: assignmentSnapshot(sourceDocument, resolvedBoqVersionId),
      sourceProcessingRevision: (sourceDocument.processingRevision || 0) + 1,
      superseded: false,
      status: 'ingestion',
      stages: stageState('ingestion', 'running'),
      units: null,
      boq: null,
      error: null,
      pages: [],
      setup: ['pdf', 'png', 'jpeg'].includes(sourceDocument.format)
        ? { route: sourceDocument.format === 'pdf' ? 'vector-pdf' : 'raster', status: 'pending', pages: [] }
        : { route: 'dxf', status: 'not_required', pages: [] },
      blockedReasons: ['pdf', 'png', 'jpeg'].includes(sourceDocument.format) ? ['Inspect the source and complete the required page setup before measurement.'] : [],
      exportable: false
    };
    sourceDocument.processingRevision = run.sourceProcessingRevision;
    sourceDocument.currentProcessingRunId = run.id;
    if (['pdf', 'png', 'jpeg'].includes(sourceDocument.format) && replaySetup?.status === 'ready') run.setupReplay = structuredClone(replaySetup);
    runs.set(run.id, run);
    schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
    return presentRun(run, sourceDocument);
  }

  async function advance(run) {
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
            : measureDxf(document, run.units, run.parsedDocument, { versions: VERSIONS, typicalMultiplier: run.typicalMultiplier });
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
      run.exportable = true;
    }
  }

  function getRun(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return presentRun(run, sourceDocuments.get(run.sourceDocumentId));
  }

  function confirmSourceSetup(runId, setup) {
    const run = runs.get(runId);
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
    const run = runs.get(runId);
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
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), page: presentRasterPage(page) };
  }

  function createRasterRegion(runId, pageIdValue, input) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    assertExpectedPageRevision(page, input, true);
    if (page.calibration?.status !== 'confirmed') throw new ConflictError('Calibrate the raster page before tracing a region.');
    if (page.regions.filter((region) => region.lifecycle !== 'deleted').length >= LIMITS.rasterRegions) throw new LimitError(`A raster page may contain at most ${LIMITS.rasterRegions} active regions.`, { limitName: 'rasterRegions', observed: page.regions.filter((region) => region.lifecycle !== 'deleted').length + 1, maximum: LIMITS.rasterRegions, stage: 'trace' });
    const points = validatePolygon(input?.points, page);
    const region = { id: `region_${String(page.regions.length + 1).padStart(4, '0')}`, points, category: normalizeRasterCategory(input?.category), lifecycle: 'traced', geometrySource: 'human-traced', revision: 1, history: [], audit: [{ action: 'created', revision: 1 }] };
    page.regions.push(region);
    persistRasterRun(run);
    enterRasterGate(run);
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
    persistRasterRun(run); enterRasterGate(run);
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
    persistRasterRun(run); enterRasterGate(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), region: { ...region } };
  }

  function confirmRasterRegion(runId, pageIdValue, regionId, input = {}) {
    const { run, page } = requireRasterPage(runId, pageIdValue);
    const region = page.regions.find((candidate) => candidate.id === regionId && candidate.lifecycle !== 'deleted');
    if (!region) throw new NotFoundError('Raster region not found.');
    assertExpectedRevisions(page, region, input, true);
    if (!region.category) throw new InputError('Classify the raster region before confirmation.');
    region.lifecycle = 'confirmed'; region.revision += 1; region.audit.push({ action: 'confirmed', revision: region.revision });
    persistRasterRun(run); enterRasterGate(run);
    return { processingRun: presentRun(run, sourceDocuments.get(run.sourceDocumentId)), region: { ...region } };
  }

  function getRasterImage(runId, pageIdValue) {
    const { run } = requireRasterPage(runId, pageIdValue);
    const source = sourceDocuments.get(run.sourceDocumentId);
    if (source.format === 'pdf') return { content: source.content, mediaType: source.mediaType, format: 'pdf' };
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
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    if (run.superseded) throw new InputError('This processing run is superseded; reprocess the current source assignment instead.');
    return startProcessing(run.sourceDocumentId, { boqVersionId: run.boqVersionId, replaySetup: run.setup });
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
        const evidence = sourceLine.provenance.sourceContributions || [null];
        for (const detail of evidence) line.provenance.sourceContributions.push({
          ...contribution,
          ...(detail || {}),
          sourceHandles: sourceLine.provenance.sourceHandles || [],
          runId: run.id,
          quantity: detail?.quantity ?? sourceLine.quantity
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

  return { createProject, createBuilding, createStorey, createBoqVersion, createSourceDocument, assignSourceDocument, assignSourceToStorey, startProcessing, confirmSourceSetup, calibrateRasterPage, createRasterRegion, updateRasterRegion, deleteRasterRegion, confirmRasterRegion, getRasterImage, getRun, getProject, getBuilding, getStorey, getProjectRollup: (projectId, options) => getProject(projectId, options).rollup, reprocess };
}

function measurePdf(sourceDocument, run) {
  const contributions = [];
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
      contributions.push({
        sourceDocumentId: sourceDocument.id,
        sourceDocumentVersion: sourceDocument.version,
        contentSha256: sourceDocument.contentSha256,
        sourcePageId: page.sourcePageId,
        pageNumber: page.pageNumber,
        nativeElementIds: [region.id],
        coordinateSpace: page.coordinateSpace,
        pageTransform: page.transform,
        rotation: page.rotation,
        geometrySource: 'native-vector',
        parserVersion: run.versions.parser,
        rulesetVersion: run.versions.ruleset,
        normalizationVersion: run.versions.normalization,
        typicalMultiplier: run.typicalMultiplier,
        processingRunId: run.id,
        setupRevision: setupPage.revision,
        scale: { drawingUnitsPerMetre: setupPage.scale.drawingUnitsPerMetre },
        selectedRegionIds: [...setupPage.selectedRegions],
        sourceHandles: [],
        sourceSheet: sourceDocument.sourceSheet,
        quantity
      });
    }
  }
  return {
    versions: run.versions,
    ruleset: run.versions.ruleset,
    lines: [{
      measurement: 'floor_area',
      label: 'Floor finish area',
      quantity: area,
      unit: 'm²',
      confidence: { level: 'HIGH', evidence: ['native vector path', 'operator-selected page region'] },
      measurementStatus: area > 0 ? 'measured' : 'measured_zero',
      provenance: { sourceHandles: [], sourceContributions: contributions }
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
      contributions.push({
        sourceDocumentId: sourceDocument.id,
        sourceDocumentVersion: sourceDocument.version,
        contentSha256: sourceDocument.contentSha256,
        processingRunId: run.id,
        sourcePageId: page.sourcePageId,
        pageNumber: page.pageNumber,
        coordinateSpace: 'image',
        pageTransform: page.sourceTransform || page.transform,
        rasterTransform: page.rasterTransform,
        rotation: page.rotation || 0,
        geometrySource: 'human-traced',
        nativeElementIds: [],
        sourceRegionIds: [region.id],
        calibrationRevision: calibration.revision,
        calibration: { source: calibration.source, p0: calibration.p0, p1: calibration.p1, pixelDistance: calibration.pixelDistance, realDistance: calibration.realDistance, realUnit: calibration.realUnit, realDistanceMetres: calibration.realDistanceMetres, pixelsPerMetre: calibration.pixelsPerMetre },
        parserVersion: run.versions.parser,
        normalizationVersion: run.versions.normalization,
        rulesetVersion: run.versions.ruleset,
        evidence: ['operator-confirmed calibration', 'human-traced region'],
        points: structuredClone(region.points),
        category: region.category,
        typicalMultiplier: run.typicalMultiplier,
        sourceHandles: [],
        sourceSheet: sourceDocument.sourceSheet,
        quantity
      });
    }
  }
  const lines = [...byCategory.entries()].map(([measurement, quantity]) => {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new InputError(`Raster category ${measurement} produced an invalid aggregate area.`);
    return { measurement, label: measurement === 'floor_area' ? 'Floor finish area' : measurement === 'wall_area' ? 'Wall finish area' : measurement, quantity, unit: 'm²', confidence: { level: 'HIGH', evidence: ['operator-confirmed calibration', 'human-traced region'] }, measurementStatus: 'measured', provenance: { sourceHandles: [], sourceContributions: contributions.filter((contribution) => contribution.category === measurement) } };
  });
  if (!lines.length) lines.push({ measurement: 'floor_area', label: 'Floor finish area', quantity: area, unit: 'm²', confidence: { level: 'HIGH', evidence: ['operator-confirmed calibration', 'human-traced region'] }, measurementStatus: 'measured_zero', provenance: { sourceHandles: [], sourceContributions: [] } });
  return { versions: run.versions, ruleset: run.versions.ruleset, lines };
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
    pages: run.pages,
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
