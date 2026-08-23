/* ─── BOQ Operator — Application Logic ────────────────────────────────────── */
/* Vanilla JS, no framework. All API calls match the existing server routes.  */

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  DOM References                                                            */
/* ═══════════════════════════════════════════════════════════════════════════ */

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
const rasterWorkflowTitle = document.querySelector('#raster-workflow-title');
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
const ocrWorkflow = document.querySelector('#ocr-workflow');
const ocrStatus = document.querySelector('#ocr-status');
const ocrProgress = document.querySelector('#ocr-progress');
const ocrRunButton = document.querySelector('#ocr-run');
const ocrAbortButton = document.querySelector('#ocr-abort');
const ocrResults = document.querySelector('#ocr-results');
const ocrCropX = document.querySelector('#ocr-crop-x');
const ocrCropY = document.querySelector('#ocr-crop-y');
const ocrCropWidth = document.querySelector('#ocr-crop-width');
const ocrCropHeight = document.querySelector('#ocr-crop-height');
const ocrRotation = document.querySelector('#ocr-rotation');
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  State                                                                     */
/* ═══════════════════════════════════════════════════════════════════════════ */

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
let ocrController = null;
let ocrControllerEngine = null;
let ocrOnlyPdf = false;
let currentRunId = null;

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  View Router                                                               */
/* ═══════════════════════════════════════════════════════════════════════════ */

const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item[data-view]');

function showView(viewName) {
  const target = document.querySelector(`.view[data-view="${viewName}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  navItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });
  window.location.hash = viewName;
}

function initRouter() {
  navItems.forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      showView(item.dataset.view);
    });
  });
  // Highlight nav based on scroll position
  const content = document.querySelector('.content');
  if (content) {
    content.addEventListener('scroll', () => {
      let current = 'project';
      views.forEach((view) => {
        if (view.getBoundingClientRect().top <= 120) current = view.dataset.view;
      });
      navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === current));
    });
  }
  const hash = window.location.hash.slice(1);
  if (hash && document.querySelector(`[data-view="${hash}"]`)) showView(hash);
}

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1);
  if (hash && document.querySelector(`[data-view="${hash}"]`)) showView(hash);
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Toast Notifications                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

const toastContainer = document.querySelector('#toast-container');

function toast(text, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = text;
  toastContainer.prepend(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Upload Drop Zone                                                          */
/* ═══════════════════════════════════════════════════════════════════════════ */

const dropzone = document.querySelector('#upload-dropzone');
const drawingInput = document.querySelector('#drawing');

if (dropzone && drawingInput) {
  dropzone.addEventListener('click', () => drawingInput.click());
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    if (event.dataTransfer.files.length) {
      drawingInput.files = event.dataTransfer.files;
      const fileName = event.dataTransfer.files[0].name;
      dropzone.querySelector('p').textContent = fileName;
    }
  });
  drawingInput.addEventListener('change', () => {
    if (drawingInput.files.length) {
      dropzone.querySelector('p').innerHTML = `<strong>${drawingInput.files[0].name}</strong> selected`;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  OCR Engine                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */

function ocrEngineFromInjection() {
  const injected = window.__BOQ_OCR_ENGINE__;
  if (typeof injected === 'function') return injected();
  if (injected) return injected;
  return window.BoqOcrEngine?.selectEngine({
    provider: 'tesseract-js',
    engineVersion: '7.0.0',
    modelVersion: 'eng-4.0.0_best_int',
    language: 'eng',
    assetHash: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
    cachedAssetHash: '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747',
    totalBytes: 2952873,
    workerPath: '/ocr/vendor/tesseract.js/dist/worker.min.js',
    corePath: '/ocr/vendor/tesseract.js-core',
    langPath: '/ocr/vendor/@tesseract.js-data/eng/4.0.0_best_int',
    gzip: true,
    workerBlobURL: false
  });
}

function ensureOcrController() {
  if (ocrController) return ocrController;
  const engine = ocrEngineFromInjection();
  if (!engine || !window.BoqOcrEngine) {
    renderOcrState({ state: 'unsupported', error: { message: 'No browser-local OCR adapter is available.' } });
    return null;
  }
  ocrControllerEngine = engine;
  const cache = window.__BOQ_OCR_CACHE__ || (window.BoqOcrModelCache ? new window.BoqOcrModelCache.ModelCache() : null);
  try {
    ocrController = window.BoqOcrEngine.createOcrController({ engine, cache });
    ocrController.subscribe(renderOcrState);
    window.BoqOcrUi = { controller: ocrController, normalize: window.BoqOcrNormalize };
    return ocrController;
  } catch (error) {
    renderOcrState({ state: 'unsupported', error: { message: error.message } });
    return null;
  }
}

function renderOcrState(snapshot = {}) {
  if (!ocrStatus) return;
  const state = snapshot.state || 'idle';
  const labels = {
    idle: 'OCR idle.', 'checking-cache': 'Checking the exact OCR model cache…', downloading: 'Downloading OCR model…',
    ready: 'OCR model ready.', 'offline-cache-hit': 'Offline: exact cached OCR model ready.', 'offline-missing': 'OCR unavailable offline; continue without OCR.',
    running: 'Recognizing the selected crop…', completed: 'OCR completed; evidence only.', unsupported: 'OCR unsupported in this browser; continue without OCR.',
    evicted: 'OCR model cache was evicted; download it again when online.', aborted: 'OCR stopped; the drawing workflow is unchanged.', failed: 'OCR failed; the drawing workflow is unchanged.'
  };
  ocrStatus.dataset.state = state;
  ocrStatus.textContent = labels[state] || `OCR ${state}.`;
  if (snapshot.error?.message && ['failed', 'unsupported', 'offline-missing', 'evicted', 'aborted'].includes(state)) ocrStatus.textContent += ` ${snapshot.error.message}`;
  if (ocrProgress) { ocrProgress.hidden = !['downloading', 'running'].includes(state); ocrProgress.value = Math.max(0, Math.min(100, Number(snapshot.progress?.percent || 0))); }
  if (ocrRunButton) ocrRunButton.disabled = ['checking-cache', 'downloading', 'running'].includes(state);
  if (ocrAbortButton) ocrAbortButton.hidden = !['downloading', 'running'].includes(state);
}

function boundedOcrCrop(page) {
  const dimensions = rasterDimensions(page);
  const width = dimensions.width;
  const height = dimensions.height;
  const x = Number(ocrCropX?.value || 0); const y = Number(ocrCropY?.value || 0);
  const cropWidth = Number(ocrCropWidth?.value || 0); const cropHeight = Number(ocrCropHeight?.value || 0);
  if (![width, height, x, y, cropWidth, cropHeight].every(Number.isFinite) || width <= 0 || height <= 0 || cropWidth <= 0 || cropHeight <= 0 || x < 0 || y < 0 || x + cropWidth > width || y + cropHeight > height) throw new Error('Select a finite crop wholly inside the raster page.');
  if (cropWidth * cropHeight > 25 * 1000 * 1000) throw new Error('OCR crop exceeds the bounded pixel limit; select a smaller region.');
  return { x, y, width: cropWidth, height: cropHeight };
}

function captureOcrImage(crop, rotation = 0) {
  const source = document.createElement('canvas');
  source.width = Math.max(1, Math.round(crop.width)); source.height = Math.max(1, Math.round(crop.height));
  const context = source.getContext('2d');
  let captured = false;
  if (rasterImage && !rasterImage.hidden && rasterImage.complete && rasterImage.naturalWidth) { context.drawImage(rasterImage, crop.x, crop.y, crop.width, crop.height, 0, 0, source.width, source.height); captured = true; }
  else if (rasterPdfCanvas && !rasterPdfCanvas.hidden && rasterPreview) {
    const scaleX = rasterPdfCanvas.width / rasterPreview.canonicalWidth; const scaleY = rasterPdfCanvas.height / rasterPreview.canonicalHeight;
    context.drawImage(rasterPdfCanvas, crop.x * scaleX, crop.y * scaleY, crop.width * scaleX, crop.height * scaleY, 0, 0, source.width, source.height); captured = true;
  }
  if (!captured) throw new Error('The raster preview is not ready for OCR.');
  const degrees = ((Number(rotation || 0) % 360) + 360) % 360;
  if (degrees === 0) return source;
  const rotated = document.createElement('canvas');
  rotated.width = degrees === 90 || degrees === 270 ? source.height : source.width;
  rotated.height = degrees === 90 || degrees === 270 ? source.width : source.height;
  const rotatedContext = rotated.getContext('2d');
  if (degrees === 90) { rotatedContext.translate(rotated.width, 0); rotatedContext.rotate(Math.PI / 2); }
  else if (degrees === 180) { rotatedContext.translate(rotated.width, rotated.height); rotatedContext.rotate(Math.PI); }
  else if (degrees === 270) { rotatedContext.translate(0, rotated.height); rotatedContext.rotate(-Math.PI / 2); }
  rotatedContext.drawImage(source, 0, 0);
  return rotated;
}

function renderOcrResults(observations = []) {
  if (!ocrResults) return;
  ocrResults.replaceChildren(...observations.map((observation) => {
    const item = document.createElement('div');
    item.dataset.observationId = observation.id || '';
    item.className = 'text-sm mt-2';
    item.textContent = observation.status === 'rejected'
      ? `Rejected OCR observation: ${observation.rejectionReason || 'invalid result'}`
      : `${observation.text} · ${(Number(observation.confidence?.score || 0) * 100).toFixed(1)}% · ${observation.status} · page ${observation.pageId || 'n/a'} / region ${observation.regionId || 'page-crop'}`;
    return item;
  }));
}

async function submitOcrResults(context, observations, crop) {
  const { run, page, runId, rotation } = context;
  if (!runId || !page?.sourcePageId || !observations.length) return null;
  const payload = {
    sourceDocumentId: run.sourceDocument?.id,
    sourceDocumentVersion: run.sourceDocument?.version,
    contentSha256: run.sourceDocument?.contentSha256,
    processingRunId: run.id,
    pageId: page.sourcePageId,
    regionId: null,
    engine: ocrControllerEngine?.id || ocrController?.engine || 'unknown',
    engineVersion: ocrControllerEngine?.engineVersion || ocrController?.engineVersion || 'unknown',
    modelVersion: ocrControllerEngine?.modelVersion || ocrController?.modelVersion || 'unknown',
    language: ocrControllerEngine?.language || ocrController?.language || 'eng',
    normalizationVersion: window.BoqOcrNormalize?.NORMALIZATION_VERSION || 'ocr-normalization-v1',
    coordinateSpace: page.coordinateSpace || 'image',
    pageTransform: page.transform || page.sourceTransform || null,
    observations: observations.filter((observation) => observation.status !== 'rejected'),
    cropPolygon: [{ x: crop.x, y: crop.y }, { x: crop.x + crop.width, y: crop.y }, { x: crop.x + crop.width, y: crop.y + crop.height }, { x: crop.x, y: crop.y + crop.height }],
    rotation,
    evidenceOnly: true
  };
  const response = await fetch(`/api/runs/${runId}/pages/${page.sourcePageId}/ocr-results`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'OCR evidence could not be saved; the drawing workflow is unchanged.');
  return result;
}

async function runOcrOnSelectedCrop() {
  if (!rasterPage || !rasterRun) return;
  const controller = ensureOcrController();
  if (!controller) return;
  let crop;
  try { crop = boundedOcrCrop(rasterPage); }
  catch (error) { renderOcrState({ state: 'failed', error: { message: error.message } }); return; }
  ocrRunButton.disabled = true;
  try {
    const rotation = Number(ocrRotation.value || 0);
    const context = { run: rasterRun, page: rasterPage, runId: currentRunId, rotation };
    const image = captureOcrImage(crop, rotation);
    const dimensions = rasterDimensions(context.page);
    const observations = await controller.recognize({ image, cropRect: crop, cropWidth: image.width, cropHeight: image.height, pageWidth: dimensions.width, pageHeight: dimensions.height, rotation, nativeText: context.page.nativeText || [], provenance: { sourceDocumentId: context.run.sourceDocument?.id, sourceDocumentVersion: context.run.sourceDocument?.version, processingRunId: context.run.id, pageId: context.page.sourcePageId, regionId: null, coordinateSpace: context.page.coordinateSpace || 'image', pageTransform: context.page.transform || context.page.sourceTransform || null, applyPageTransform: false, crop: crop, pageWidth: dimensions.width, pageHeight: dimensions.height }, pageTransform: context.page.transform || context.page.sourceTransform || null });
    if (currentRunId !== context.runId || rasterRun?.id !== context.run.id || rasterPage?.sourcePageId !== context.page.sourcePageId) {
      renderOcrState({ state: 'aborted', error: { message: 'The selected run or page changed; stale OCR evidence was discarded.' } });
      return;
    }
    renderOcrResults(observations);
    try { await submitOcrResults(context, observations, crop); }
    catch (error) { ocrStatus.textContent = `OCR recognition completed, but evidence was not saved. ${error.message}`; ocrStatus.dataset.state = 'failed'; }
  } catch (error) {
    renderOcrState({ state: controller.state || (error.code === 'offline-missing' ? 'offline-missing' : 'failed'), error: { message: error.message }, progress: controller.progress });
  } finally { ocrRunButton.disabled = false; }
}

ocrRunButton?.addEventListener('click', runOcrOnSelectedCrop);
ocrAbortButton?.addEventListener('click', () => ocrController?.abort());

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Project Management                                                        */
/* ═══════════════════════════════════════════════════════════════════════════ */

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = projectForm.querySelector('button');
  button.disabled = true;
  projectStatus.textContent = 'Creating project…';
  projectStatus.className = 'mt-4 text-sm status-msg info';
  try {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#project-name').value || undefined }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Project creation failed.');
    currentProject = result.project;
    projectControls.hidden = false;
    projectStatus.textContent = `${currentProject.name} (${currentProject.id}) ready.`;
    projectStatus.className = 'mt-4 text-sm status-msg success';
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = '0';
    projectStatus.dataset.projectId = currentProject.id;
    try { localStorage.setItem('boq.activeProject', currentProject.id); } catch { /* private mode */ }
    updateHeaderProject();
    renderProjectControls();
    toast(`Project "${currentProject.name}" created`, 'success');
  } catch (error) {
    projectStatus.textContent = `Project creation failed: ${error.message}`;
    projectStatus.className = 'mt-4 text-sm error';
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

function updateHeaderProject() {
  const nameEl = document.querySelector('#header-project-name');
  const idEl = document.querySelector('#header-project-id');
  if (nameEl) nameEl.textContent = currentProject?.name || '';
  if (idEl) idEl.textContent = currentProject?.id || '';
}

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
    projectStatus.className = 'mt-4 text-sm status-msg success';
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = String(Number(projectStatus.dataset.revision || 0) + 1);
    autoSelectLatest();
    toast('Building added', 'success');
  } catch (error) { projectStatus.textContent = `Building creation failed: ${error.message}`; toast(error.message, 'error'); }
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
    projectStatus.className = 'mt-4 text-sm status-msg success';
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = String(Number(projectStatus.dataset.revision || 0) + 1);
    autoSelectLatest();
    toast('Storey added', 'success');
  }
  catch (error) { projectStatus.textContent = `Storey creation failed: ${error.message}`; toast(error.message, 'error'); }
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
  message.className = 'mt-4 text-sm status-msg info';
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
      message.className = 'mt-4 text-sm status-msg info';
      reassignSource.dataset.state = 'completed';
      return;
    }
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    runSection.hidden = false;
    reviewSection.hidden = true;
    rollupSection.hidden = true;
    showView('upload');
    await pollRun();
    reassignSource.dataset.state = 'completed';
    toast('Source reassigned', 'success');
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-4 text-sm error';
    reassignSource.dataset.state = 'failed';
    toast(error.message, 'error');
  } finally {
    reassignSource.disabled = false;
  }
});

async function refreshProject() {
  if (!currentProject) return;
  currentProject = (await fetch(`/api/projects/${currentProject.id}`).then((result) => result.json())).project;
  updateHeaderProject();
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Upload / Processing                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

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
    message.className = 'mt-4 text-sm error';
    toast(error.message, 'error');
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
  message.className = 'mt-4 text-sm status-msg info';
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
    message.className = 'mt-4 text-sm status-msg success';
    runSection.hidden = false;
    reviewSection.hidden = true;
    reprocess.hidden = true;
    rasterWorkflow.hidden = true;
    rasterPoints = [];
    rasterEditRegionId = null;
    updateReassignAvailability();
    showView('upload');
    await pollRun();
    toast('Drawing processed', 'success');
  } catch (error) {
    message.textContent = error.message;
    message.className = 'mt-4 text-sm error';
    toast(error.message, 'error');
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
    if (isRasterRun) { renderRasterWorkflow(run); showView('raster'); }
    else if (run.sourceDocument?.format === 'pdf') renderPdfOcrWorkflow(run);
    renderBoq(run.boq || { lines: [], sourceObjects: [] }, run.classifications || []);
    await refreshProject();
    await renderProjectRollup(run);
    await renderReview(run.projectId);
    renderWorkspaceLines(run);
    reprocess.hidden = false;
    return;
  }
  if (run.status === 'awaiting_setup') {
    renderPdfSetup(run);
    renderPdfOcrWorkflow(run);
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
    showView('raster');
    message.textContent = run.blockedReasons?.join(' ') || 'This source requires raster calibration before measurement.';
    message.className = 'mt-4 text-sm status-msg warning';
    return;
  }
  if (run.status === 'failed') {
    if (run.sourceDocument?.format === 'pdf' && run.pages?.length) renderPdfOcrWorkflow(run);
    message.textContent = run.error;
    message.className = 'mt-4 text-sm error';
    /* T3: if the only thing missing is the drawing unit, ask for it here --
       at the moment it actually matters -- instead of demanding it upfront. */
    if (promptForUnit(run.error)) {
      message.textContent = 'This drawing does not state its units. Choose the unit below and measure again.';
      toast('Choose the drawing unit to continue', 'error');
    } else {
      toast('Processing failed', 'error');
    }
    return;
  }
  setTimeout(pollRun, 50);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Raster Workflow                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

function renderRasterWorkflow(run) {
  ocrOnlyPdf = false;
  rasterWorkflow.classList.remove('ocr-only');
  rasterWorkflowTitle.textContent = 'Raster calibration and tracing';
  rasterCanvas.hidden = false;
  const rasterPages = run.pages?.filter((candidate) => candidate.route === 'raster') || [];
  if (!rasterPages.length) { if (ocrWorkflow) ocrWorkflow.hidden = true; return; }
  rasterPageSelect.replaceChildren(...rasterPages.map((candidate) => new Option(`Page ${candidate.pageNumber}`, candidate.sourcePageId)));
  if (!rasterSelectedPageId || !rasterPages.some((candidate) => candidate.sourcePageId === rasterSelectedPageId)) rasterSelectedPageId = rasterPages[0].sourcePageId;
  rasterPageSelect.value = rasterSelectedPageId;
  const page = rasterPages.find((candidate) => candidate.sourcePageId === rasterSelectedPageId);
  if (!page) return;
  rasterWorkflow.hidden = false;
  if (ocrWorkflow) ocrWorkflow.hidden = false;
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
  if (ocrCropWidth && (ocrCropWidth.value === '' || pageChanged)) {
    ocrCropX.value = '0'; ocrCropY.value = '0';
    ocrCropWidth.value = String(Math.min(dimensions.width, 1000));
    ocrCropHeight.value = String(Math.min(dimensions.height, 1000));
  }
  for (const input of [ocrCropX, ocrCropY, ocrCropWidth, ocrCropHeight]) {
    if (input) { input.max = String(input === ocrCropX || input === ocrCropWidth ? dimensions.width : dimensions.height); }
  }
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
  if (rasterRun) (ocrOnlyPdf ? renderPdfOcrWorkflow(rasterRun) : renderRasterWorkflow(rasterRun));
});

rasterCorrectCalibration.addEventListener('click', () => {
  rasterMode = 'calibration';
  rasterPoints = [];
  rasterEditRegionId = null;
  rasterEditReplace = false;
  renderRasterWorkflow(rasterRun);
});

function rasterDimensions(page) {
  if (Number(page.pixelWidth) > 0 && Number(page.pixelHeight) > 0) return { width: Number(page.pixelWidth), height: Number(page.pixelHeight) };
  const width = Number(page.width); const height = Number(page.height); const matrix = page.transform || page.sourceTransform;
  if (Array.isArray(matrix) && matrix.length >= 6 && matrix.every((value) => Number.isFinite(Number(value)))) {
    const points = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => ({ x: Number(matrix[0]) * x + Number(matrix[2]) * y + Number(matrix[4]), y: Number(matrix[1]) * x + Number(matrix[3]) * y + Number(matrix[5]) }));
    return { width: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)), height: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)) };
  }
  return { width, height };
}

function renderPdfOcrWorkflow(run) {
  const pages = run.pages || [];
  if (!pages.length) return;
  ocrOnlyPdf = true;
  rasterWorkflow.classList.add('ocr-only');
  rasterWorkflowTitle.textContent = 'PDF page preview for optional OCR';
  rasterWorkflow.hidden = false; ocrWorkflow.hidden = false; rasterCanvas.hidden = true;
  rasterPageSelect.replaceChildren(...pages.map((candidate) => new Option(`Page ${candidate.pageNumber}`, candidate.sourcePageId)));
  if (!rasterSelectedPageId || !pages.some((candidate) => candidate.sourcePageId === rasterSelectedPageId)) rasterSelectedPageId = pages[0].sourcePageId;
  rasterPageSelect.value = rasterSelectedPageId;
  const page = pages.find((candidate) => candidate.sourcePageId === rasterSelectedPageId);
  if (!page) return;
  const pageChanged = rasterPage?.sourcePageId !== page.sourcePageId || rasterRun?.id !== run.id;
  if (pageChanged) { cancelPdfPreview(); rasterPreview = null; }
  rasterRun = run; rasterPage = page;
  const dimensions = rasterDimensions(page);
  if (pageChanged) {
    ocrCropX.value = '0'; ocrCropY.value = '0';
    ocrCropWidth.value = String(Math.min(dimensions.width, 1000)); ocrCropHeight.value = String(Math.min(dimensions.height, 1000));
  }
  for (const input of [ocrCropX, ocrCropY, ocrCropWidth, ocrCropHeight]) input.max = String(input === ocrCropX || input === ocrCropWidth ? dimensions.width : dimensions.height);
  rasterImage.hidden = true; rasterPdfCanvas.hidden = false;
  const imageUrl = `/api/runs/${run.id}/pages/${page.sourcePageId}/image`;
  if (rasterImageUrl !== imageUrl || rasterPreview?.pageId !== page.sourcePageId || rasterPreview?.kind !== 'pdf') {
    rasterImageUrl = imageUrl; void renderPdfRasterPage(run, page, imageUrl);
  }
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
  rasterRenderError.className = 'error mt-2';
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
  const polygons = [...(rasterPage.regions || []).map((region) => ({ points: region.points, color: region.lifecycle === 'deleted' ? '#ff7777' : region.lifecycle === 'confirmed' ? '#70d6a0' : '#ffcc66', deleted: region.lifecycle === 'deleted', proposed: region.origin === 'model-proposed' })), ...(points.length ? [{ points, color: '#80bfff', deleted: false, proposed: true }] : [])];
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
    const modelProposed = region.origin === 'model-proposed';
    row.className = `raster-region ${modelProposed ? 'proposed' : 'human-traced'}`;
    const geometryLabel = modelProposed
      ? (region.lifecycle === 'confirmed' ? 'MODEL PROPOSED · CONFIRMED' : 'MODEL PROPOSED · UNCONFIRMED')
      : 'HUMAN TRACED';
    row.textContent = `${region.id} · ${geometryLabel} · ${region.category || 'unclassified'} · ${region.lifecycle}${region.lifecycle === 'deleted' ? ' (audit retained)' : ''}`;
    if (region.lifecycle !== 'deleted' && region.lifecycle !== 'confirmed') {
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Confirm region'; confirm.dataset.action = 'confirm-region'; confirm.className = 'btn-sm btn-success';
      confirm.addEventListener('click', () => mutateRasterRegion(`/api/runs/${run.id}/pages/${page.sourcePageId}/regions/${region.id}/confirm?expectedPageRevision=${page.revision || page.calibration?.revision || 0}&expectedRegionRevision=${region.revision || 0}`, { method: 'POST' }, confirm));
      row.append(' ', confirm);
    }
    if (region.lifecycle !== 'deleted') {
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.dataset.action = 'edit-region'; edit.className = 'btn-sm';
      edit.addEventListener('click', () => beginRegionEdit(region));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.dataset.action = 'delete-region'; remove.className = 'btn-sm btn-danger';
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
    rasterStatus.className = 'text-sm error';
    button.disabled = false;
    toast(error.message, 'error');
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
    toast('Calibration confirmed', 'success');
  } catch (error) { rasterStatus.textContent = error.message; rasterStatus.className = 'text-sm error'; toast(error.message, 'error'); }
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
    toast('Region saved', 'success');
  } catch (error) { rasterStatus.textContent = error.message; rasterStatus.className = 'text-sm error'; rasterCloseRegion.disabled = false; toast(error.message, 'error'); }
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  PDF Setup                                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

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
    text.className = 'text-sm text-muted mt-2';
    text.textContent = `Native text: ${page.nativeText.map((item) => item.text).join(' ') || 'none'}`;
    section.append(text);
    for (const region of page.vectorRegions) {
      const label = document.createElement('label');
      label.className = 'inline mt-2';
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

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Rollup                                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */

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
    const projectQuantity = signedQuantity(project.rollup, line, (object) => !object.buildingId);
    const projectScope = projectQuantity ? [`Project scope: ${Number(projectQuantity.toFixed(6))} ${line.unit}`] : [];
    const drilldown = [...projectScope, ...project.buildings.flatMap((building) => {
      const buildingLine = building.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
      const directQuantity = buildingLine ? signedQuantity(building.rollup, buildingLine, (object) => !object.storeyId) : 0;
      const direct = directQuantity ? [`${building.name}: ${Number(directQuantity.toFixed(6))} ${buildingLine.unit}`] : [];
      const floors = building.storeys.map((storey) => {
        const storeyLine = storey.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
        return storeyLine ? `${building.name} / ${storey.name}: ${storeyLine.quantity} ${storeyLine.unit}` : null;
      }).filter(Boolean);
      return [...direct, ...floors];
    })].join('\n');
    const provenance = describeContributions(project.rollup, line).join('\n');
    for (const value of [line.label, String(line.quantity), drilldown, provenance]) {
      const cell = document.createElement('td');
      if (value === provenance) cell.className = 'provenance-cell';
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  rollupSection.hidden = false;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Run & BOQ Rendering                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

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

/* Provenance helpers */
function sourceObjectFor(carrier, contribution) {
  return (carrier?.sourceObjects || []).find((object) => object.sourceObjectId === contribution.sourceObjectId) || {};
}
function signedQuantity(carrier, line, predicate = () => true) {
  return (line.provenance.contributions || [])
    .filter((contribution) => predicate(sourceObjectFor(carrier, contribution)))
    .reduce((total, contribution) => total + (contribution.sign === 'deduct' ? -contribution.quantity : contribution.quantity), 0);
}
function describeContributions(carrier, line) {
  return (line.provenance.contributions || []).map((contribution) => {
    const object = sourceObjectFor(carrier, contribution);
    const scope = object.storeyId ? `storey ${object.storeyId}` : object.buildingId ? `building ${object.buildingId}` : 'project';
    const where = object.nativeHandle || object.regionId || 'n/a';
    const scale = contribution.ruleInputs?.scale?.drawingUnitsPerMetre ?? contribution.ruleInputs?.pixelsPerMetre ?? 'n/a';
    return `${object.sourceDocumentId} v${object.sourceDocumentVersion} (run ${contribution.runId}; ${object.sheetId || 'n/a'}; ${scope}; page ${object.pageId || 'n/a'}; ${where}; ${contribution.sign} ${contribution.quantity} ${contribution.unit}; ${object.geometrySource} in ${object.coordinateSpace}; bounds ${(object.bounds || []).join(',') || 'n/a'}; scale ${scale}; rule ${contribution.ruleId}@${contribution.rulesetVersion}; typical-storey multiplier: \u00d7${contribution.typicalMultiplier})`;
  });
}

function confidenceBadge(level) {
  const map = { HIGH: 'badge-green', MEDIUM: 'badge-amber', LOW: 'badge-red' };
  return map[level] || 'badge-gray';
}

function statusBadge(status) {
  const map = { measured: 'badge-green', measured_zero: 'badge-amber', not_measurable: 'badge-red' };
  return map[status] || 'badge-gray';
}

function renderBoq(boq, classifications = []) {
  classificationReview.replaceChildren();
  const conflicts = classifications.flatMap((classification) => classification.conflicts || []).filter((conflict, index, all) => all.findIndex((candidate) => candidate.groupKey === conflict.groupKey) === index);
  if (classifications.length) {
    const summary = document.createElement('p');
    summary.className = 'text-sm text-secondary mb-4';
    summary.textContent = `${classifications.length} source objects classified; category and exact catalog item are tracked separately.`;
    classificationReview.append(summary);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap card-compact mb-4';
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
    wrap.append(table);
    classificationReview.append(wrap);
  }
  for (const conflict of conflicts) {
    const alert = document.createElement('p');
    alert.className = 'error mt-2';
    alert.textContent = `Grouped classification conflict (${conflict.groupKey}): ${conflict.candidateValues.join(' vs ')} — exact item remains unresolved.`;
    classificationReview.append(alert);
  }
  boqLines.replaceChildren(...(boq.lines || []).map((line) => {
    const row = document.createElement('tr');
    const first = sourceObjectFor(boq, line.provenance.contributions?.[0] || {});
    const header = line.provenance.contributions?.length
      ? `${first.sourceDocumentId} v${first.sourceDocumentVersion}`
      : 'no source object resolved';
    const provenance = [header, ...describeContributions(boq, line)].join('\n');

    /* Measurement */
    const nameCell = document.createElement('td');
    nameCell.innerHTML = `<strong>${line.label}</strong>`;
    row.append(nameCell);

    /* Quantity */
    const qtyCell = document.createElement('td');
    qtyCell.innerHTML = `<code>${String(line.quantity)}</code>`;
    row.append(qtyCell);

    /* Unit */
    const unitCell = document.createElement('td');
    unitCell.textContent = line.unit;
    row.append(unitCell);

    /* Confidence */
    const confCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${confidenceBadge(line.confidence.level)}`;
    badge.textContent = line.confidence.level;
    confCell.append(badge);
    const evidenceText = document.createElement('span');
    evidenceText.className = 'text-xs text-muted';
    evidenceText.textContent = ` ${line.confidence.evidence.join(', ')}`;
    confCell.append(evidenceText);
    row.append(confCell);

    /* Status */
    const statusCell = document.createElement('td');
    const statusEl = document.createElement('span');
    statusEl.className = `badge ${statusBadge(line.measurementStatus)}`;
    statusEl.textContent = line.measurementStatus;
    statusCell.append(statusEl);
    row.append(statusCell);

    /* Provenance (expandable) */
    const provCell = document.createElement('td');
    provCell.className = 'provenance-cell expandable';
    const provSummary = document.createElement('span');
    provSummary.textContent = header;
    provSummary.className = 'text-xs';
    const provDetail = document.createElement('div');
    provDetail.className = 'expand-content';
    provDetail.textContent = provenance;
    provCell.append(provSummary, provDetail);
    provCell.addEventListener('click', () => provCell.classList.toggle('open'));
    row.append(provCell);

    return row;
  }));
  reviewSection.hidden = false;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Exception Queue                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

const exceptionSection = document.querySelector('#exception-review');
const queueOrdering = document.querySelector('#queue-ordering');
const queueCounts = document.querySelector('#queue-counts');
const queueRows = document.querySelector('#queue-rows');
const queueCards = document.querySelector('#queue-cards');
const approvalState = document.querySelector('#approval-state');
const approveButton = document.querySelector('#approve-boq');
const approvalError = document.querySelector('#approval-error');
const approvalBanner = document.querySelector('#approval-banner');
const navExceptionCount = document.querySelector('#nav-exception-count');

async function renderReview(projectId) {
  if (!exceptionSection || !projectId) return;
  const response = await fetch(`/api/projects/${projectId}/exceptions`);
  if (!response.ok) return;
  const queue = await response.json();
  exceptionSection.hidden = false;
  queueOrdering.textContent = `Ordered by: ${queue.rankedBy}${queue.caveat ? ` — ${queue.caveat}` : ''}`;
  queueOrdering.dataset.rankedBy = queue.rankedBy;
  queueCounts.textContent = `${queue.counts.total} exceptions · ${queue.counts.groups} groups · ${queue.counts.blocking} blocking · ${queue.counts.advisory} advisory`;

  /* Update nav badge */
  if (navExceptionCount) {
    if (queue.counts.blocking > 0) {
      navExceptionCount.hidden = false;
      navExceptionCount.textContent = String(queue.counts.blocking);
      navExceptionCount.className = 'nav-badge blocking';
    } else if (queue.counts.advisory > 0) {
      navExceptionCount.hidden = false;
      navExceptionCount.textContent = String(queue.counts.advisory);
      navExceptionCount.className = 'nav-badge advisory';
    } else {
      navExceptionCount.hidden = true;
    }
  }

  /* Render as cards */
  if (queueCards) {
    queueCards.replaceChildren(...queue.groups.map((group) => {
      const card = document.createElement('div');
      card.className = 'exception-group';
      card.dataset.groupKey = group.groupKey;
      card.dataset.severity = group.severity;

      const title = document.createElement('div');
      title.className = 'exception-title';
      const severityBadge = document.createElement('span');
      severityBadge.className = `badge ${group.severity === 'BLOCK' ? 'badge-red' : 'badge-amber'}`;
      severityBadge.textContent = group.severity;
      title.append(severityBadge, ` ${group.title}`);
      if (group.count > 1) {
        const countBadge = document.createElement('span');
        countBadge.className = 'badge badge-gray';
        countBadge.textContent = `×${group.count}`;
        title.append(' ', countBadge);
      }
      card.append(title);

      const reason = document.createElement('div');
      reason.className = 'exception-reason';
      reason.textContent = group.raisedBecause;
      if (group.blocks?.length) reason.textContent += ` — blocks: ${group.blocks.join(', ')}`;
      card.append(reason);

      const actions = document.createElement('div');
      actions.className = 'exception-actions';
      for (const option of group.resolutionOptions || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = option.action === 'dismiss' ? 'btn-sm' : 'btn-sm btn-primary';
        button.textContent = option.label;
        button.dataset.action = option.action;
        button.addEventListener('click', async () => {
          const body = { groupKey: group.groupKey, action: option.action, resolvedBy: 'operator' };
          if (option.action === 'confirm_item') {
            const item = window.prompt(`What item is ${group.title}?`);
            if (!item) return;
            body.item = item;
          }
          button.disabled = true;
          await fetch(`/api/projects/${projectId}/exceptions/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          await renderReview(projectId);
          toast('Exception resolved', 'success');
        });
        actions.append(button);
      }
      card.append(actions);
      return card;
    }));
  }

  /* Hidden table for test compatibility */
  queueRows.replaceChildren(...queue.groups.map((group) => {
    const row = document.createElement('tr');
    row.dataset.groupKey = group.groupKey;
    row.dataset.severity = group.severity;
    for (const value of [group.severity, group.title, group.raisedBecause, (group.blocks || []).join(', '), String(group.count)]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const actions = document.createElement('td');
    for (const option of group.resolutionOptions || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.dataset.action = option.action;
      button.addEventListener('click', async () => {
        const body = { groupKey: group.groupKey, action: option.action, resolvedBy: 'operator' };
        if (option.action === 'confirm_item') {
          const item = window.prompt(`What item is ${group.title}?`);
          if (!item) return;
          body.item = item;
        }
        await fetch(`/api/projects/${projectId}/exceptions/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        await renderReview(projectId);
      });
      actions.append(button);
    }
    row.append(actions);
    return row;
  }));

  /* Approval */
  approvalState.textContent = queue.counts.blocking > 0
    ? `Approval blocked by ${queue.counts.blocking} exception(s).`
    : 'Nothing blocking. This BOQ version can be approved.';
  approvalState.dataset.blocking = String(queue.counts.blocking);
  if (approvalBanner) {
    approvalBanner.className = queue.counts.blocking > 0 ? 'approval-banner blocked' : 'approval-banner can-approve';
  }
  if (approveButton) approveButton.disabled = queue.counts.blocking > 0;
}

if (approveButton) {
  approveButton.addEventListener('click', async () => {
    const projectId = document.querySelector('#project-status')?.dataset.projectId;
    const versionId = document.querySelector('#project-status')?.dataset.boqVersionId;
    if (!projectId || !versionId) return;
    approveButton.disabled = true;
    const response = await fetch(`/api/boq-versions/${versionId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedBy: 'operator' }) });
    const body = await response.json();
    approvalError.textContent = response.ok ? `Approved: ruleset ${body.boqVersion.approvedRulesetVersion}, assumptions v${body.boqVersion.approvedAssumptionsVersion}` : body.error;
    if (response.ok) {
      approvalError.className = 'text-sm status-msg success mt-2';
      toast('BOQ version approved', 'success');
      const controls = document.querySelector('#export-controls');
      if (controls) { controls.hidden = false; controls.dataset.versionId = versionId; }
    } else {
      approvalError.className = 'text-sm error mt-2';
      toast(body.error, 'error');
    }
    await renderReview(projectId);
    approveButton.disabled = false;
  });
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Workspace Probe                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

const wsSection = document.querySelector('#workspace');
const wsLine = document.querySelector('#ws-line');
const wsNavigate = document.querySelector('#ws-navigate');
const wsBreakdown = document.querySelector('#ws-breakdown');
const wsTiers = document.querySelector('#ws-tiers');
const wsViewport = document.querySelector('#ws-viewport');
const wsContributions = document.querySelector('#ws-contributions');
const wsPosition = document.querySelector('#ws-position');
let wsQueueIndex = 0;

function renderWorkspaceLines(run) {
  if (!wsLine || !run.boq?.lines?.length) return;
  const current = wsLine.value;
  wsLine.replaceChildren(new Option('Select a measurement…', ''), ...run.boq.lines.map((line) => new Option(line.label, line.measurement)));
  if (run.boq.lines.some((line) => line.measurement === current)) wsLine.value = current;
  wsSection.hidden = false;
}

async function renderLineEvidence(projectId, measurement) {
  const response = await fetch(`/api/projects/${projectId}/lines/${measurement}/evidence`);
  if (!response.ok) return;
  const evidence = await response.json();
  wsSection.hidden = false;
  wsNavigate.textContent = evidence.spansMultiple
    ? `Spans ${evidence.spans.storeyIds.length} storeys / ${evidence.spans.sheetIds.length} sheets — ${evidence.spans.note}`
    : `Navigate to building ${evidence.navigate.buildingId} / storey ${evidence.navigate.storeyId} / sheet ${evidence.navigate.sheetId}`;
  wsNavigate.dataset.spansMultiple = String(evidence.spansMultiple);
  wsBreakdown.textContent = evidence.breakdown.summary;
  wsTiers.textContent = `Reported tier ${evidence.tier.tier} (${evidence.tier.label}) — ` + Object.entries(evidence.tierBreakdown)
    .map(([tier, entry]) => `${tier}: ${entry.count} contribution(s), ${entry.quantity}`).join('; ');
  wsViewport.textContent = evidence.viewport
    ? `Viewport ${Math.round(evidence.viewport.minX)},${Math.round(evidence.viewport.minY)} to ${Math.round(evidence.viewport.maxX)},${Math.round(evidence.viewport.maxY)}${evidence.viewport.degenerate ? ' (extent invented for viewing)' : ''}`
    : 'No viewport: this line resolved no geometry.';

  const objectsById = new Map(evidence.sourceObjects.map((object) => [object.sourceObjectId, object]));
  wsContributions.replaceChildren(...evidence.contributions.map((contribution) => {
    const row = document.createElement('tr');
    row.dataset.sign = contribution.sign;
    const object = objectsById.get(contribution.sourceObjectId) || {};
    for (const value of [contribution.sign, String(contribution.quantity), contribution.tier || '-', contribution.sourceObjectId, (object.bounds || []).map(Math.round).join(', ')]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const reverse = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-sm';
    button.textContent = 'what does this object affect?';
    button.addEventListener('click', async () => {
      const result = await (await fetch(`/api/projects/${projectId}/objects/${encodeURIComponent(contribution.sourceObjectId)}/lines`)).json();
      reverse.textContent = result.lines.map((line) => `${line.measurement} ${line.contributions.map((entry) => `${entry.sign} ${entry.quantity}`).join(', ')}`).join(' | ');
    });
    reverse.append(button);
    row.append(reverse);
    return row;
  }));
}

async function renderQueueStep(projectId, index) {
  const step = await (await fetch(`/api/projects/${projectId}/queue/step?index=${index}`)).json();
  if (!step.total) { wsPosition.textContent = 'queue empty'; return; }
  wsQueueIndex = step.index;
  wsPosition.textContent = `exception ${step.index + 1} of ${step.total} — ${step.exception.title} (ordered by ${step.rankedBy})`;
  if (step.exception.measurement) await renderLineEvidence(projectId, step.exception.measurement);
}

document.querySelector('#ws-next')?.addEventListener('click', () => {
  const projectId = document.querySelector('#project-status')?.dataset.projectId;
  if (projectId) renderQueueStep(projectId, wsQueueIndex + 1);
});
document.querySelector('#ws-prev')?.addEventListener('click', () => {
  const projectId = document.querySelector('#project-status')?.dataset.projectId;
  if (projectId) renderQueueStep(projectId, Math.max(0, wsQueueIndex - 1));
});
wsLine?.addEventListener('change', () => {
  const projectId = document.querySelector('#project-status')?.dataset.projectId;
  if (projectId && wsLine.value) renderLineEvidence(projectId, wsLine.value);
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Init                                                                      */
/* ═══════════════════════════════════════════════════════════════════════════ */

initRouter();


/* ---- export download (T4/T10) ------------------------------------------- */
document.querySelectorAll('[data-export]').forEach((button) => {
  button.addEventListener('click', async () => {
    const controls = document.querySelector('#export-controls');
    const versionId = controls?.dataset.versionId || document.querySelector('#project-status')?.dataset.boqVersionId;
    if (!versionId) { toast('Approve the BOQ version first', 'error'); return; }
    const kind = button.dataset.export;
    const query = kind === 'sidecar' ? 'format=csv&sidecar=1' : `format=${kind}`;
    const response = await fetch(`/api/boq-versions/${versionId}/export?${query}`);
    if (!response.ok) { const body = await response.json().catch(() => ({})); toast(body.error || 'Export failed', 'error'); return; }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const name = (disposition.match(/filename="([^"]+)"/) || [])[1] || `boq.${kind}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${name}`, 'success');
  });
});


/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Operator flow: resume, auto-select, unit prompt, empty sections           */
/* ═══════════════════════════════════════════════════════════════════════════ */

/* T13: creating a building or storey then being told to select it is friction
   with no purpose. Select whatever was just added. */
function autoSelectLatest() {
  const building = document.querySelector('#building-select');
  if (building && !building.value && building.options.length > 1) building.selectedIndex = building.options.length - 1;
  const storey = document.querySelector('#storey-select');
  if (storey && !storey.value && storey.options.length > 1) storey.selectedIndex = storey.options.length - 1;
}

/* T5: a reload must not strand an existing project. Offer the list, and reopen
   the last one worked on. */
async function loadProjectList() {
  const picker = document.querySelector('#project-picker');
  const resume = document.querySelector('#project-resume');
  if (!picker || !resume) return null;
  let payload;
  try { payload = await (await fetch('/api/projects')).json(); } catch { return null; }

  /* T12: state the limit the server actually enforces, not a number we invented. */
  const limitLabel = document.querySelector('#upload-limit');
  if (limitLabel && payload.limits?.uploadBytes) {
    limitLabel.textContent = ` — up to ${Math.round(payload.limits.uploadBytes / 1024 / 1024)} MB`;
  }

  const projects = payload.projects || [];
  resume.hidden = projects.length === 0;
  picker.replaceChildren(...projects.map((project) => {
    const option = document.createElement('option');
    option.value = project.id;
    const bits = [];
    if (project.sourceDocumentCount) bits.push(`${project.sourceDocumentCount} drawing${project.sourceDocumentCount === 1 ? '' : 's'}`);
    option.textContent = `${project.name}${bits.length ? ` — ${bits.join(', ')}` : ' — empty'}`;
    return option;
  }));
  return projects;
}

async function openProject(projectId) {
  const response = await fetch(`/api/projects/${projectId}`);
  if (!response.ok) return false;
  currentProject = (await response.json()).project;
  projectControls.hidden = false;
  projectStatus.textContent = `${currentProject.name} (${currentProject.id}) ready.`;
  projectStatus.className = 'mt-4 text-sm status-msg success';
  projectStatus.dataset.ready = 'true';
  projectStatus.dataset.revision = projectStatus.dataset.revision || '0';
  projectStatus.dataset.projectId = currentProject.id;
  try { localStorage.setItem('boq.activeProject', currentProject.id); } catch { /* private mode */ }
  updateHeaderProject();
  renderProjectControls();
  await renderReview(currentProject.id).catch(() => {});
  return true;
}

document.querySelector('#project-resume-button')?.addEventListener('click', async () => {
  const id = document.querySelector('#project-picker')?.value;
  if (!id) return;
  if (await openProject(id)) toast('Project reopened', 'success');
});

/* T3: the fallback unit answers a question the drawing has not yet raised. Ask
   only once unit resolution has actually failed, and re-run with the answer. */
function promptForUnit(errorText) {
  const prompt = document.querySelector('#unit-prompt');
  if (!prompt) return false;
  if (!/drawing unit|\$INSUNITS/i.test(String(errorText || ''))) return false;
  prompt.hidden = false;
  const text = document.querySelector('#unit-prompt-text');
  if (text) text.textContent = 'This drawing does not state its units, so nothing can be measured from it yet. Which unit was it drawn in?';
  document.querySelector('#fallback-unit')?.focus();
  return true;
}

/* T6: a heading with nothing under it reads as broken. Hide the work sections
   until they have something to show. */
function hideEmptySections() {
  const gated = [
    ['#view-review', () => document.querySelectorAll('#boq-lines tr').length > 0],
    ['#view-exceptions', () => document.querySelectorAll('#queue-rows tr').length > 0],
    ['#view-workspace', () => (document.querySelector('#ws-line')?.options.length || 0) > 1],
    ['#view-rollup', () => document.querySelectorAll('#rollup-lines tr').length > 0],
    ['#view-raster', () => !document.querySelector('#raster-workflow')?.hidden]
  ];
  for (const [selector, hasContent] of gated) {
    const view = document.querySelector(selector);
    if (!view) continue;
    const ready = hasContent();
    const navItem = document.querySelector(`[data-view="${view.dataset.view}"]`);
    if (navItem) {
      navItem.classList.toggle('nav-empty', !ready);
      navItem.title = ready ? '' : 'Nothing here yet — upload a drawing first';
    }
    /* Only the placeholder body is hidden; the view itself stays reachable so a
       curious operator is told why it is empty rather than finding it missing. */
    const placeholder = view.querySelector('.empty-placeholder');
    if (!ready && !placeholder && view.querySelector('.view-header')) {
      const note = document.createElement('p');
      note.className = 'empty-placeholder text-sm text-secondary';
      note.textContent = 'Nothing to show yet. Upload and measure a drawing first.';
      view.append(note);
    } else if (ready && placeholder) {
      placeholder.remove();
    }
  }
}

const observer = new MutationObserver(() => hideEmptySections());
document.addEventListener('DOMContentLoaded', () => {
  hideEmptySections();
  observer.observe(document.querySelector('#main-content') || document.body, { childList: true, subtree: true });
  loadProjectList().then(async (projects) => {
    if (!projects || !projects.length) return;
    let last = null;
    try { last = localStorage.getItem('boq.activeProject'); } catch { /* private mode */ }
    if (last && projects.some((p) => p.id === last)) await openProject(last);
  });
});
