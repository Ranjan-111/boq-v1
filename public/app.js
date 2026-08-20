const form = document.querySelector('#upload-form');
const message = document.querySelector('#message');
const runSection = document.querySelector('#run');
const reviewSection = document.querySelector('#review');
const runSummary = document.querySelector('#run-summary');
const boqLines = document.querySelector('#boq-lines');
const reprocess = document.querySelector('#reprocess');
const pdfSetupSection = document.querySelector('#pdf-setup');
const pdfSetupForm = document.querySelector('#pdf-setup-form');
const pdfPages = document.querySelector('#pdf-pages');
const rollupSection = document.querySelector('#rollup');
const rollupSummary = document.querySelector('#rollup-summary');
const rollupLines = document.querySelector('#rollup-lines');
const classificationReview = document.querySelector('#classification-review');
const rasterWorkflow = document.querySelector('#raster-workflow');
const rasterStatus = document.querySelector('#raster-status');
const rasterPageSelect = document.querySelector('#raster-page-select');
const rasterImage = document.querySelector('#raster-image');
const rasterPdfCanvas = document.querySelector('#raster-pdf-canvas');
const rasterCanvas = document.querySelector('#raster-canvas');
const rasterPointX = document.querySelector('#raster-point-x');
const rasterPointY = document.querySelector('#raster-point-y');
const rasterAddPoint = document.querySelector('#raster-add-point');
const rasterClearPoints = document.querySelector('#raster-clear-points');
const rasterRenderError = document.querySelector('#raster-render-error');
const rasterCalibrationForm = document.querySelector('#raster-calibration-form');
const rasterCalibrationSubmit = document.querySelector('#raster-calibration-submit');
const rasterCorrectCalibration = document.querySelector('#raster-correct-calibration');
const rasterDistance = document.querySelector('#raster-distance');
const rasterUnit = document.querySelector('#raster-unit');
const rasterCategoryLabel = document.querySelector('#raster-category-label');
const rasterCategory = document.querySelector('#raster-category');
const rasterCloseRegion = document.querySelector('#raster-close-region');
const rasterRegions = document.querySelector('#raster-regions');
const projectForm = document.querySelector('#project-form');
const projectStatus = document.querySelector('#project-status');
const projectControls = document.querySelector('#project-controls');
const buildingForm = document.querySelector('#building-form');
const storeyForm = document.querySelector('#storey-form');
const buildingSelect = document.querySelector('#building-select');
const storeySelect = document.querySelector('#storey-select');
const sourceDocumentSelect = document.querySelector('#source-document-select');
const reassignmentScope = document.querySelector('#reassignment-scope');
const reassignSource = document.querySelector('#reassign-source');
let currentProject = null;
let currentSourceDocumentId = null;
let rollupRenderSequence = 0;
let rasterRun = null;
let rasterPage = null;
let rasterPoints = [];
let rasterImageUrl = '';
let rasterSelectedPageId = null;
let rasterMode = 'trace';
let rasterEditRegionId = null;
let rasterEditReplace = false;
let rasterPreview = null;
let rasterRenderToken = 0;
let pdfjsPromise;
let pdfPreviewSession = null;

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = projectForm.querySelector('button');
  button.disabled = true;
  projectStatus.textContent = 'Creating project…';
  try {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#project-name').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Project creation failed.');
    currentProject = result.project;
    projectControls.hidden = false;
    projectStatus.textContent = `${currentProject.name} (${currentProject.id}) ready for building and storey assignments.`;
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = '0';
    renderProjectControls();
  } catch (error) {
    projectStatus.textContent = `Project creation failed: ${error.message}`;
    projectStatus.className = 'error';
  } finally {
    button.disabled = false;
  }
});

buildingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentProject) return;
  projectStatus.dataset.ready = 'false';
  buildingForm.querySelector('button').disabled = true;
  try {
    const response = await fetch(`/api/projects/${currentProject.id}/buildings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#building-name').value }) });
    if (!response.ok) { projectStatus.textContent = (await response.json()).error || 'Building creation failed.'; return; }
    currentProject = (await fetch(`/api/projects/${currentProject.id}`).then((result) => result.json())).project;
    document.querySelector('#building-name').value = '';
    renderProjectControls();
    projectStatus.textContent = `${currentProject.name} workspace synchronized.`;
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = String(Number(projectStatus.dataset.revision || 0) + 1);
  } catch (error) { projectStatus.textContent = `Building creation failed: ${error.message}`; }
  finally { buildingForm.querySelector('button').disabled = false; }
});

storeyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const buildingId = buildingSelect.value;
  if (!buildingId) { projectStatus.textContent = 'Select a building before adding a storey.'; return; }
  projectStatus.dataset.ready = 'false';
  storeyForm.querySelector('button').disabled = true;
  try {
    const response = await fetch(`/api/buildings/${buildingId}/storeys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#storey-name').value }) });
    if (!response.ok) { projectStatus.textContent = (await response.json()).error || 'Storey creation failed.'; return; }
    document.querySelector('#storey-name').value = '';
    await refreshProject();
    projectStatus.textContent = `${currentProject.name} workspace synchronized.`;
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = String(Number(projectStatus.dataset.revision || 0) + 1);
  }
  catch (error) { projectStatus.textContent = `Storey creation failed: ${error.message}`; }
  finally { storeyForm.querySelector('button').disabled = false; }
});

buildingSelect.addEventListener('change', () => renderStoreys());
sourceDocumentSelect.addEventListener('change', updateReassignAvailability);
reassignmentScope.addEventListener('change', updateReassignAvailability);

reassignSource.addEventListener('click', async () => {
  const sourceDocumentId = sourceDocumentSelect.value;
  const scope = reassignmentScope.value;
  const targetReady = scope === 'project' || (scope === 'building' && buildingSelect.value) || (scope === 'storey' && buildingSelect.value && storeySelect.value);
  if (!sourceDocumentId || !currentProject || !targetReady) return;
  reassignSource.disabled = true;
  reassignSource.dataset.state = 'running';
  message.textContent = 'Reassigning source and recomputing rollups…';
  try {
    const assignment = {
      projectId: currentProject.id,
      buildingId: scope === 'project' ? null : buildingSelect.value,
      storeyId: scope === 'storey' ? storeySelect.value : null,
      typicalMultiplier: scope === 'storey' ? (document.querySelector('#typical-multiplier').value || '1') : 1
    };
    const response = await fetch(`/api/source-documents/${sourceDocumentId}/assignment`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(assignment)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (!result.processingRun) {
      currentSourceDocumentId = sourceDocumentId;
      await refreshProject();
      message.textContent = 'Source assignment is already up to date.';
      reassignSource.dataset.state = 'completed';
      return;
    }
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    runSection.hidden = false;
    reviewSection.hidden = true;
    rollupSection.hidden = true;
    await pollRun();
    reassignSource.dataset.state = 'completed';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
    reassignSource.dataset.state = 'failed';
  } finally {
    reassignSource.disabled = false;
  }
});

async function refreshProject() {
  if (!currentProject) return;
  currentProject = (await fetch(`/api/projects/${currentProject.id}`).then((result) => result.json())).project;
  renderProjectControls();
}

function renderProjectControls() {
  const selectedBuildingId = buildingSelect.value;
  const selectedSourceDocumentId = sourceDocumentSelect.value || currentSourceDocumentId || '';
  buildingSelect.replaceChildren(new Option('Select a building…', ''), ...currentProject.buildings.map((building) => new Option(building.name, building.id)));
  buildingSelect.value = currentProject.buildings.some((building) => building.id === selectedBuildingId) ? selectedBuildingId : '';
  renderStoreys(storeySelect.value);
  renderSourceDocuments(selectedSourceDocumentId);
}

function renderStoreys(preferredStoreyId = '') {
  const building = currentProject?.buildings.find((candidate) => candidate.id === buildingSelect.value);
  storeySelect.replaceChildren(new Option('Select a storey…', ''), ...(building?.storeys || []).map((storey) => new Option(storey.name, storey.id)));
  storeySelect.value = building?.storeys.some((storey) => storey.id === preferredStoreyId) ? preferredStoreyId : '';
  updateReassignAvailability();
}

storeySelect.addEventListener('change', updateReassignAvailability);

function renderSourceDocuments(preferredSourceDocumentId = '') {
  const documents = currentProject?.documentVersions || [];
  sourceDocumentSelect.replaceChildren(
    new Option('Select a source document…', ''),
    ...documents.map((document) => new Option(
      `${document.sourceSheet} · v${document.version} · ${document.storeyId ? 'storey' : document.buildingId ? 'building' : 'project'}`,
      document.id
    ))
  );
  sourceDocumentSelect.value = documents.some((document) => document.id === preferredSourceDocumentId) ? preferredSourceDocumentId : '';
  updateReassignAvailability();
}

function updateReassignAvailability() {
  const scope = reassignmentScope.value;
  const targetReady = scope === 'project' || (scope === 'building' && buildingSelect.value) || (scope === 'storey' && buildingSelect.value && storeySelect.value);
  reassignSource.hidden = !currentProject || !sourceDocumentSelect.value || !targetReady;
}
let currentRunId = null;

pdfSetupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pages = [...pdfPages.querySelectorAll('[data-source-page-id]')].map((pageElement) => ({
    sourcePageId: pageElement.dataset.sourcePageId,
    scale: { drawingUnitsPerMetre: pageElement.querySelector('input[type="number"]').value },
    selectedRegions: [...pageElement.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value)
  }));
  const button = pdfSetupForm.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch(`/api/runs/${currentRunId}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pages }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    pdfSetupSection.hidden = true;
    await pollRun();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
  } finally { button.disabled = false; }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit('/api/source-documents', new FormData(form));
});

reprocess.addEventListener('click', async () => {
  await submit(`/api/runs/${currentRunId}/reprocess`);
});

async function submit(url, body) {
  message.textContent = 'Submitting drawing…';
  message.className = '';
  form.querySelector('button').disabled = true;
  try {
    if (body instanceof FormData && currentProject) {
      if (currentProject.id) body.set('projectId', currentProject.id);
      if (buildingSelect.value) body.set('buildingId', buildingSelect.value);
      if (storeySelect.value) body.set('storeyId', storeySelect.value);
      const sourceSheet = document.querySelector('#source-sheet').value.trim();
      if (sourceSheet) body.set('sourceSheet', sourceSheet);
      body.set('typicalMultiplier', document.querySelector('#typical-multiplier').value || '1');
    }
    const response = await fetch(url, { method: 'POST', body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    message.textContent = `Source ${result.processingRun.sourceDocument.id} v${result.processingRun.sourceDocument.version} accepted.`;
    runSection.hidden = false;
    reviewSection.hidden = true;
    reprocess.hidden = true;
    rasterWorkflow.hidden = true;
    rasterPoints = [];
    rasterEditRegionId = null;
    updateReassignAvailability();
    await pollRun();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
  } finally {
    form.querySelector('button').disabled = false;
  }
}

async function pollRun() {
  const response = await fetch(`/api/runs/${currentRunId}`);
  const run = await response.json();
  renderRun(run);
  if (run.status === 'completed') {
    pdfSetupSection.hidden = true;
    const isRasterRun = run.setup?.route === 'raster';
    rasterWorkflow.hidden = !isRasterRun;
    if (isRasterRun) renderRasterWorkflow(run);
    renderBoq(run.boq?.lines || [], run.classifications || []);
    await refreshProject();
    await renderProjectRollup(run);
    reprocess.hidden = false;
    return;
  }
  if (run.status === 'awaiting_setup') {
    renderPdfSetup(run);
    return;
  }
  const rasterWaiting = ['awaiting_calibration', 'awaiting_trace', 'awaiting_confirmation'].includes(run.status) && run.setup?.route === 'raster';
  if (rasterWaiting) {
    pdfSetupSection.hidden = true;
    pdfPages.replaceChildren();
    reviewSection.hidden = true;
    boqLines.replaceChildren();
    rollupSection.hidden = true;
    reprocess.hidden = true;
    renderRasterWorkflow(run);
    message.textContent = run.blockedReasons?.join(' ') || 'This source requires raster calibration before measurement.';
    message.className = 'error';
    return;
  }
  if (run.status === 'failed') {
    message.textContent = run.error;
    message.className = 'error';
    return;
  }
  setTimeout(pollRun, 50);
}

function renderRasterWorkflow(run) {
  const rasterPages = run.pages?.filter((candidate) => candidate.route === 'raster') || [];
  if (!rasterPages.length) return;
  rasterPageSelect.replaceChildren(...rasterPages.map((candidate) => new Option(`Page ${candidate.pageNumber}`, candidate.sourcePageId)));
  if (!rasterSelectedPageId || !rasterPages.some((candidate) => candidate.sourcePageId === rasterSelectedPageId)) rasterSelectedPageId = rasterPages[0].sourcePageId;
  rasterPageSelect.value = rasterSelectedPageId;
  const page = rasterPages.find((candidate) => candidate.sourcePageId === rasterSelectedPageId);
  if (!page) return;
  rasterWorkflow.hidden = false;
  const pageChanged = rasterPage?.sourcePageId !== page.sourcePageId || rasterRun?.id !== run.id;
  if (pageChanged) {
    cancelPdfPreview();
    rasterPoints = [];
    rasterEditRegionId = null;
    rasterEditReplace = false;
    rasterMode = page.calibration?.status === 'confirmed' ? 'trace' : 'calibration';
    rasterPreview = null;
  }
  rasterRun = run;
  rasterPage = page;
  const dimensions = rasterDimensions(page);
  const imageUrl = `/api/runs/${run.id}/pages/${page.sourcePageId}/image`;
  const pdfSource = run.sourceDocument?.format === 'pdf';
  if (pageChanged) rasterRenderError.textContent = '';
  rasterCanvas.style.pointerEvents = rasterRenderError.textContent ? 'none' : 'auto';
  if (pdfSource) {
    rasterImage.hidden = true;
    rasterPdfCanvas.hidden = false;
    if (rasterImageUrl !== imageUrl || rasterPreview?.pageId !== page.sourcePageId || rasterPreview?.kind !== 'pdf') {
      rasterImageUrl = imageUrl;
      rasterCanvas.style.pointerEvents = 'none';
      void renderPdfRasterPage(run, page, imageUrl);
    }
  } else {
    rasterImage.hidden = false;
    rasterPdfCanvas.hidden = true;
    if (rasterImageUrl !== imageUrl || rasterPreview?.pageId !== page.sourcePageId || rasterPreview?.kind !== 'image') {
      rasterImageUrl = imageUrl;
      setRasterLayerDimensions(dimensions.width, dimensions.height);
      rasterImage.onload = () => drawRasterCanvas();
      rasterImage.onerror = () => showRasterRenderError('This image preview could not be decoded. Upload a valid PNG or JPEG export.');
      rasterImage.src = imageUrl;
    }
  }
  rasterPointX.min = '0'; rasterPointX.max = String(dimensions.width);
  rasterPointY.min = '0'; rasterPointY.max = String(dimensions.height);
  if (!rasterPreview) setRasterLayerDimensions(dimensions.width, dimensions.height, pdfSource ? 'pdf' : 'image');
  drawRasterCanvas();
  renderRasterRegions(run, page);
  const calibration = page.calibration;
  const activeRegions = (page.regions || []).filter((region) => region.lifecycle !== 'deleted');
  const pending = activeRegions.find((region) => region.lifecycle !== 'confirmed');
  const calibrated = calibration?.status === 'confirmed';
  rasterCalibrationForm.hidden = calibrated && rasterMode !== 'calibration';
  rasterCorrectCalibration.hidden = !calibrated || rasterMode === 'calibration';
  rasterCalibrationSubmit.textContent = calibrated ? 'Apply calibration correction' : 'Confirm calibration';
  rasterCategoryLabel.hidden = !calibrated;
  rasterCloseRegion.textContent = rasterEditRegionId ? 'Save region edits' : 'Close traced region';
  rasterCloseRegion.disabled = !calibrated || rasterPoints.length < 3 || (Boolean(pending) && !rasterEditRegionId);
  if (run.status === 'awaiting_calibration') rasterStatus.textContent = 'Select two points on the image, enter their real-world distance, then confirm calibration.';
  else if (rasterMode === 'calibration') rasterStatus.textContent = 'Select two new points to correct the calibration. Existing regions remain unchanged until you apply it.';
  else if (rasterMode === 'edit') rasterStatus.textContent = 'Edit the boundary, then save the region edits. The region must be confirmed again.';
  else if (run.status === 'awaiting_trace') rasterStatus.textContent = 'Calibration confirmed. Click at least three points around a region, then close the traced boundary.';
  else if (run.status === 'awaiting_confirmation') rasterStatus.textContent = 'Review the traced boundary and confirm each active region below.';
  else rasterStatus.textContent = run.blockedReasons?.join(' ') || 'Raster tracing is ready.';
}

rasterPageSelect.addEventListener('change', () => {
  rasterSelectedPageId = rasterPageSelect.value;
  rasterPoints = [];
  rasterEditRegionId = null;
  rasterEditReplace = false;
  if (rasterRun) renderRasterWorkflow(rasterRun);
});

rasterCorrectCalibration.addEventListener('click', () => {
  rasterMode = 'calibration';
  rasterPoints = [];
  rasterEditRegionId = null;
  rasterEditReplace = false;
  renderRasterWorkflow(rasterRun);
});

function rasterDimensions(page) {
  return { width: Number(page.pixelWidth || page.width), height: Number(page.pixelHeight || page.height) };
}

function setRasterLayerDimensions(width, height, kind = 'image', cssWidth = null, cssHeight = null) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const fittedWidth = cssWidth || Math.min(1000, width);
  const fittedHeight = cssHeight || fittedWidth * height / width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const backingWidth = Math.max(1, Math.ceil(fittedWidth * dpr));
  const backingHeight = Math.max(1, Math.ceil(fittedHeight * dpr));
  rasterPreview = { kind, pageId: rasterPage?.sourcePageId, canonicalWidth: width, canonicalHeight: height, cssWidth: fittedWidth, cssHeight: fittedHeight, dpr };
  const preview = document.querySelector('#raster-preview');
  preview.style.width = `${fittedWidth}px`;
  preview.style.height = `${fittedHeight}px`;
  for (const canvas of [rasterPdfCanvas, rasterCanvas]) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${fittedWidth}px`;
    canvas.style.height = `${fittedHeight}px`;
  }
  rasterImage.style.width = `${fittedWidth}px`;
  rasterImage.style.height = `${fittedHeight}px`;
}

function showRasterRenderError(text) {
  rasterRenderError.textContent = text;
  rasterRenderError.className = 'error';
  rasterCanvas.style.pointerEvents = 'none';
}

function cancelPdfPreview() {
  rasterRenderToken += 1;
  const session = pdfPreviewSession;
  pdfPreviewSession = null;
  if (!session) return;
  if (session.timeout) clearTimeout(session.timeout);
  try { session.task?.cancel(); } catch {}
  if (session.document) void session.document.destroy().catch(() => {});
}

async function renderPdfRasterPage(run, page, imageUrl) {
  const token = ++rasterRenderToken;
  const session = { token, task: null, timeout: null, document: null, imageUrl };
  pdfPreviewSession = session;
  try {
    const pdfjs = await (pdfjsPromise ||= import('/pdfjs/pdf.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('/pdfjs/pdf.worker.mjs', window.location.origin).href;
    if (token !== rasterRenderToken) return;
    const response = await fetch(imageUrl, { headers: { accept: 'application/pdf' } });
    if (!response.ok) throw new Error('The PDF preview could not be loaded.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('The PDF preview exceeds the upload limit.');
    const loadedDocument = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, isEvalSupported: false, stopAtErrors: true, maxImageSize: 25 * 1000 * 1000 }).promise;
    if (token !== rasterRenderToken) {
      await loadedDocument.destroy().catch(() => {});
      return;
    }
    session.document = loadedDocument;
    const pdfPage = await session.document.getPage(page.pageNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1, rotation: page.rotation || 0 });
    const fit = Math.min(1, 1000 / baseViewport.width, 1000 / baseViewport.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = pdfPage.getViewport({ scale: fit * dpr, rotation: page.rotation || 0 });
    setRasterLayerDimensions(baseViewport.width, baseViewport.height, 'pdf', viewport.width / dpr, viewport.height / dpr);
    session.task = pdfPage.render({ canvasContext: rasterPdfCanvas.getContext('2d'), viewport });
    await Promise.race([session.task.promise, new Promise((_, reject) => { session.timeout = setTimeout(() => { try { session.task?.cancel(); } catch {} reject(new Error('The PDF preview timed out.')); }, 5000); })]);
    if (token !== rasterRenderToken) return;
    drawRasterCanvas();
    if (!rasterRenderError.textContent) rasterCanvas.style.pointerEvents = 'auto';
  } catch (error) {
    if (token === rasterRenderToken) showRasterRenderError(error.message || 'The PDF preview could not be rendered.');
  } finally {
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = null;
    session.task = null;
    if (pdfPreviewSession === session) {
      pdfPreviewSession = null;
      if (session.document) await session.document.destroy().catch(() => {});
    }
  }
}

function canvasPoint(event) {
  if (!rasterPreview) return null;
  const bounds = rasterCanvas.getBoundingClientRect();
  const x = (event.clientX - bounds.left) * rasterPreview.canonicalWidth / bounds.width;
  const y = (event.clientY - bounds.top) * rasterPreview.canonicalHeight / bounds.height;
  if (x < 0 || y < 0 || x > rasterPreview.canonicalWidth || y > rasterPreview.canonicalHeight) return null;
  return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) };
}

function drawRasterCanvas() {
  if (!rasterCanvas || !rasterPage || !rasterPreview) return;
  const context = rasterCanvas.getContext('2d');
  const scaleX = rasterCanvas.width / rasterPreview.canonicalWidth;
  const scaleY = rasterCanvas.height / rasterPreview.canonicalHeight;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, rasterCanvas.width, rasterCanvas.height);
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  const points = rasterPoints;
  const polygons = [...(rasterPage.regions || []).map((region) => ({ points: region.points, color: region.lifecycle === 'deleted' ? '#ff7777' : region.lifecycle === 'confirmed' ? '#70d6a0' : '#ffcc66', deleted: region.lifecycle === 'deleted', proposed: region.geometrySource !== 'human-traced' })), ...(points.length ? [{ points, color: '#80bfff', deleted: false, proposed: true }] : [])];
  for (const polygon of polygons) {
    if (!polygon.points.length) continue;
    context.strokeStyle = polygon.color; context.fillStyle = polygon.color === '#70d6a0' ? 'rgba(112,214,160,.2)' : polygon.deleted ? 'rgba(255,119,119,.12)' : polygon.proposed ? 'rgba(128,191,255,.16)' : 'rgba(255,204,102,.2)'; context.lineWidth = Math.max(1, rasterPreview.canonicalWidth / 400); context.setLineDash(polygon.deleted || polygon.proposed ? [6, 4] : []);
    context.beginPath(); context.moveTo(polygon.points[0].x, polygon.points[0].y); polygon.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    if (polygon.points.length > 2) context.closePath(); context.stroke(); if (polygon.points.length > 2) context.fill();
    if (!polygon.deleted) { context.fillStyle = polygon.color; polygon.points.forEach((point) => { context.beginPath(); context.arc(point.x, point.y, Math.max(2, rasterPreview.canonicalWidth / 100), 0, Math.PI * 2); context.fill(); }); }
  }
  context.setLineDash([]);
}

function renderRasterRegions(run, page) {
  rasterRegions.replaceChildren(...(page.regions || []).map((region) => {
    const row = document.createElement('div');
    row.dataset.regionId = region.id;
    row.className = `raster-region ${region.geometrySource === 'human-traced' ? 'human-traced' : 'proposed'}`;
    const geometryLabel = region.geometrySource === 'human-traced' ? 'HUMAN TRACED' : 'PROPOSED';
    row.textContent = `${region.id} · ${geometryLabel} · ${region.category || 'unclassified'} · ${region.lifecycle}${region.lifecycle === 'deleted' ? ' (audit retained)' : ''}`;
    if (region.lifecycle !== 'deleted' && region.lifecycle !== 'confirmed') {
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Confirm region'; confirm.dataset.action = 'confirm-region';
      confirm.addEventListener('click', () => mutateRasterRegion(`/api/runs/${run.id}/pages/${page.sourcePageId}/regions/${region.id}/confirm?expectedPageRevision=${page.revision || page.calibration?.revision || 0}&expectedRegionRevision=${region.revision || 0}`, { method: 'POST' }, confirm));
      row.append(' ', confirm);
    }
    if (region.lifecycle !== 'deleted') {
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit region'; edit.dataset.action = 'edit-region';
      edit.addEventListener('click', () => beginRegionEdit(region));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete region'; remove.dataset.action = 'delete-region';
      remove.addEventListener('click', () => mutateRasterRegion(`/api/runs/${run.id}/pages/${page.sourcePageId}/regions/${region.id}?expectedPageRevision=${page.revision || page.calibration?.revision || 0}&expectedRegionRevision=${region.revision || 0}`, { method: 'DELETE' }, remove));
      row.append(' ', edit, ' ', remove);
    }
    return row;
  }));
}

function addRasterPoint(point) {
  if (!rasterPage || !rasterPreview || !point) return false;
  if (rasterMode === 'calibration') {
    if (rasterPoints.length >= 2) rasterPoints = [];
    rasterPoints.push(point);
  } else if (rasterMode === 'trace' || rasterMode === 'edit') {
    const activeRegions = (rasterPage.regions || []).filter((region) => region.lifecycle !== 'deleted');
    if (rasterMode === 'trace' && activeRegions.some((region) => region.lifecycle !== 'confirmed')) return;
    if (rasterMode === 'edit' && rasterEditReplace) { rasterPoints = []; rasterEditReplace = false; }
    rasterPoints.push(point);
  } else return false;
  drawRasterCanvas();
  renderRasterWorkflow(rasterRun);
  return true;
}

rasterCanvas.addEventListener('click', (event) => {
  if (rasterCanvas.style.pointerEvents === 'none') return;
  addRasterPoint(canvasPoint(event));
});

rasterAddPoint.addEventListener('click', () => {
  const point = { x: Number(rasterPointX.value), y: Number(rasterPointY.value) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    rasterStatus.textContent = 'Enter finite image-space X and Y coordinates.';
    return;
  }
  if (!addRasterPoint(point)) rasterStatus.textContent = 'Select a raster calibration or tracing mode before adding a point.';
});

rasterClearPoints.addEventListener('click', () => {
  rasterPoints = [];
  drawRasterCanvas();
  renderRasterWorkflow(rasterRun);
});

rasterCanvas.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && rasterPointX.value !== '' && rasterPointY.value !== '') {
    event.preventDefault();
    rasterAddPoint.click();
  }
});

function beginRegionEdit(region) {
  rasterMode = 'edit';
  rasterEditRegionId = region.id;
  rasterPoints = structuredClone(region.points);
  rasterEditReplace = true;
  rasterCategory.value = region.category || 'floor_area';
  drawRasterCanvas();
  renderRasterWorkflow(rasterRun);
}

async function mutateRasterRegion(url, options, button) {
  button.disabled = true;
  try {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Raster region update failed.');
    currentRunId = result.processingRun.id;
    rasterPoints = [];
    rasterEditRegionId = null;
    rasterEditReplace = false;
    rasterMode = 'trace';
    await pollRun();
  } catch (error) {
    rasterStatus.textContent = error.message;
    rasterStatus.className = 'error';
    button.disabled = false;
  }
}

rasterCanvas.addEventListener('dblclick', (event) => {
  event.preventDefault();
  if (rasterPoints.length >= 3) rasterCloseRegion.click();
});

rasterCalibrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!rasterRun || rasterPoints.length !== 2) { rasterStatus.textContent = 'Select exactly two calibration points first.'; return; }
  const button = rasterCalibrationForm.querySelector('button'); button.disabled = true;
  try {
    const response = await fetch(`/api/runs/${rasterRun.id}/pages/${rasterPage.sourcePageId}/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p0: rasterPoints[0], p1: rasterPoints[1], realDistance: rasterDistance.value, realUnit: rasterUnit.value, expectedPageRevision: rasterPage.revision || rasterPage.calibration?.revision || 0 }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    rasterPoints = []; rasterEditRegionId = null; rasterEditReplace = false; rasterMode = 'trace'; currentRunId = result.processingRun.id; await pollRun();
  } catch (error) { rasterStatus.textContent = error.message; rasterStatus.className = 'error'; }
  finally { button.disabled = false; }
});

rasterCloseRegion.addEventListener('click', async () => {
  if (!rasterRun || rasterPoints.length < 3) return;
  rasterCloseRegion.disabled = true;
  try {
    const base = `/api/runs/${rasterRun.id}/pages/${rasterPage.sourcePageId}/regions`;
    const editing = Boolean(rasterEditRegionId);
    const editedRegion = editing ? rasterPage.regions.find((region) => region.id === rasterEditRegionId) : null;
    const body = { points: rasterPoints, category: rasterCategory.value, expectedPageRevision: rasterPage.revision || rasterPage.calibration?.revision || 0, ...(editedRegion ? { expectedRegionRevision: editedRegion.revision || 0 } : {}) };
    const response = await fetch(editing ? `${base}/${rasterEditRegionId}` : base, { method: editing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    rasterPoints = []; rasterEditRegionId = null; rasterEditReplace = false; rasterMode = 'trace'; currentRunId = result.processingRun.id; await pollRun();
  } catch (error) { rasterStatus.textContent = error.message; rasterStatus.className = 'error'; rasterCloseRegion.disabled = false; }
});

function renderPdfSetup(run) {
  pdfSetupSection.hidden = false;
  pdfPages.replaceChildren(...run.pages.map((page) => {
    const section = document.createElement('fieldset');
    section.dataset.sourcePageId = page.sourcePageId;
    const title = document.createElement('legend');
    title.textContent = `Page ${page.pageNumber} (${page.rotation}°) — ${page.width} × ${page.height} ${page.coordinateSpace}`;
    section.append(title);
    const scaleLabel = document.createElement('label');
    scaleLabel.textContent = 'Drawing units per metre ';
    const scale = document.createElement('input');
    scale.type = 'number';
    scale.min = '0.000001';
    scale.step = 'any';
    scale.id = `pdf-scale-page-${page.pageNumber}`;
    scale.required = true;
    scaleLabel.append(scale);
    section.append(scaleLabel);
    const text = document.createElement('p');
    text.textContent = `Native text: ${page.nativeText.map((item) => item.text).join(' ') || 'none'}`;
    section.append(text);
    for (const region of page.vectorRegions) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = region.id;
      checkbox.id = `pdf-region-${region.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      label.append(checkbox, ` ${region.id} (${region.area} square drawing units)`);
      section.append(label);
    }
    return section;
  }));
}

async function renderProjectRollup(run) {
  if (!run.projectId) return;
  const renderSequence = ++rollupRenderSequence;
  const versionQuery = run.boqVersionId ? `?boqVersionId=${encodeURIComponent(run.boqVersionId)}` : '';
  const response = await fetch(`/api/projects/${run.projectId}${versionQuery}`);
  if (!response.ok) return;
  const project = (await response.json()).project;
  if (renderSequence !== rollupRenderSequence) return;
  rollupSummary.textContent = `${project.name} (${project.id}) — BOQ ${project.rollup.boqVersionId || project.currentBoqVersionId}; quantities are drilled down by building, storey, and source provenance.`;
  rollupLines.replaceChildren(...project.rollup.lines.map((line) => {
    const row = document.createElement('tr');
    const projectQuantity = line.provenance.sourceContributions
      .filter((contribution) => !contribution.buildingId)
      .reduce((total, contribution) => total + contribution.quantity, 0);
    const projectScope = projectQuantity ? [`Project scope: ${Number(projectQuantity.toFixed(6))} ${line.unit}`] : [];
    const drilldown = [...projectScope, ...project.buildings.flatMap((building) => {
      const buildingLine = building.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
      const directQuantity = buildingLine?.provenance.sourceContributions
        .filter((contribution) => !contribution.storeyId)
        .reduce((total, contribution) => total + contribution.quantity, 0);
      const direct = directQuantity ? [`${building.name}: ${Number(directQuantity.toFixed(6))} ${buildingLine.unit}`] : [];
      const floors = building.storeys.map((storey) => {
        const storeyLine = storey.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
        return storeyLine ? `${building.name} / ${storey.name}: ${storeyLine.quantity} ${storeyLine.unit}` : null;
      }).filter(Boolean);
      return [...direct, ...floors];
    })].join('\n');
    const scope = contribution => contribution.storeyId ? `storey ${contribution.storeyId}` : contribution.buildingId ? `building ${contribution.buildingId}` : 'project';
    const provenance = line.provenance.sourceContributions.map((contribution) => `${contribution.sourceDocumentId} v${contribution.sourceDocumentVersion} (run ${contribution.processingRunId || contribution.runId || 'n/a'}; ${contribution.sourceSheet}; ${scope(contribution)}; page ${contribution.sourcePageId || 'n/a'}; regions ${(contribution.selectedRegionIds || contribution.nativeElementIds || []).join(', ') || 'n/a'}; scale ${contribution.scale?.drawingUnitsPerMetre || 'n/a'}; setup revision ${contribution.setupRevision || 'n/a'}; transform ${(contribution.pageTransform || []).join(',') || 'n/a'}; typical-storey multiplier: ×${contribution.typicalMultiplier}) handles: ${contribution.sourceHandles.join(', ')}`).join('\n');
    for (const value of [line.label, String(line.quantity), drilldown, provenance]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  rollupSection.hidden = false;
}

function renderRun(run) {
  const unitStatus = run.units
    ? Object.assign(document.createElement('span'), {
      className: `stage ${run.units.source === 'operator-assumption' ? 'running' : 'completed'}`,
      textContent: `units: ${run.units.name} (${run.units.source})`
    })
    : null;
  runSummary.replaceChildren(...[
    Object.assign(document.createElement('strong'), { textContent: `${run.id}: ${run.status}` }),
    ...(unitStatus ? [unitStatus] : []),
    ...(run.projectId ? [Object.assign(document.createElement('span'), { className: 'stage completed', textContent: `project: ${run.projectId}${run.storeyId ? ` / ${run.storeyId}` : ''}` })] : []),
    ...(run.typicalMultiplier > 1 ? [Object.assign(document.createElement('span'), { className: 'stage running', textContent: `typical-storey multiplier: ×${run.typicalMultiplier}` })] : []),
    ...run.stages.map((stage) => {
      const element = document.createElement('span');
      element.className = `stage ${stage.status}`;
      element.textContent = `${stage.name}: ${stage.status}`;
      return element;
    })
  ]);
}

function renderBoq(lines, classifications = []) {
  classificationReview.replaceChildren();
  const conflicts = classifications.flatMap((classification) => classification.conflicts || []).filter((conflict, index, all) => all.findIndex((candidate) => candidate.groupKey === conflict.groupKey) === index);
  if (classifications.length) {
    const summary = document.createElement('p');
    summary.textContent = `${classifications.length} source objects classified; category and exact catalog item are tracked separately.`;
    classificationReview.append(summary);
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Source object</th><th>Category</th><th>Exact catalog item</th></tr></thead><tbody></tbody>';
    const body = table.querySelector('tbody');
    for (const classification of classifications) {
      const row = document.createElement('tr');
      for (const value of [classification.sourceObjectId, `${classification.category.value || 'Unresolved'} (${classification.category.state})`, `${classification.catalogItem.value || 'Unresolved'} (${classification.catalogItem.state})`]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    classificationReview.append(table);
  }
  for (const conflict of conflicts) {
    const alert = document.createElement('p');
    alert.className = 'error';
    alert.textContent = `Grouped classification conflict (${conflict.groupKey}): ${conflict.candidateValues.join(' vs ')} — exact item remains unresolved.`;
    classificationReview.append(alert);
  }
  boqLines.replaceChildren(...lines.map((line) => {
    const row = document.createElement('tr');
    const contributions = line.provenance.sourceContributions || [];
    const firstContribution = contributions[0] || {};
    const sourceId = line.provenance.sourceDocumentId || firstContribution.sourceDocumentId || '';
    const sourceVersion = line.provenance.sourceDocumentVersion || firstContribution.sourceDocumentVersion || '';
    const nativeEvidence = contributions.map((contribution) => `${contribution.sourcePageId || ''} ${(contribution.sourceRegionIds || contribution.nativeElementIds || []).join(', ')} run ${contribution.processingRunId || contribution.runId || 'n/a'} geometry ${contribution.geometrySource || 'native'} scale ${contribution.scale?.drawingUnitsPerMetre || 'n/a'} transform ${(contribution.pageTransform || []).join(',') || 'n/a'}`.trim()).filter(Boolean).join('\n');
    const provenance = `${sourceId} v${sourceVersion}\n${line.provenance.sourceHandles.join(', ')}${nativeEvidence ? `\n${nativeEvidence}` : ''}`;
    for (const value of [
      line.label,
      String(line.quantity),
      line.unit,
      `${line.confidence.level}: ${line.confidence.evidence.join(', ')}`,
      line.measurementStatus,
      provenance
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  reviewSection.hidden = false;
}
