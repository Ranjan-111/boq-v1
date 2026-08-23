/* ═══════════════════════════════════════════════════════════════════════════
   Raster calibration, tracing, PDF setup and browser OCR.

   Ported from the previous app.js with behaviour deliberately unchanged. This
   is the one part of the old frontend that was genuinely intricate, genuinely
   worked, and was genuinely covered by browser tests -- rewriting it would
   have risked real regressions for no gain. What did change is its boundary:
   it no longer reaches for module-global state, and receives everything it
   needs through `initRaster`.
   ═══════════════════════════════════════════════════════════════════════════ */

const message = document.querySelector('#message');
const pdfSetupSection = document.querySelector('#pdf-setup');
const pdfPages = document.querySelector('#pdf-pages');
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

/* Injected by the shell so this module holds no opinion about navigation,
   notification, or how a run is polled. */

/* Raster-local state. These were module globals in the old app.js; here they
   are private to the raster workflow, which is the only code that ever read
   them. The run id is the one genuinely shared value, so it is reached through
   the shell rather than duplicated. */
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

let toast = () => {};
let submit = async () => {};
let pollRun = async () => {};
let getRunId = () => null;
let setRunId = () => {};

export function initRaster(deps) {
  toast = deps.toast;
  submit = deps.submit;
  pollRun = deps.pollRun;
  getRunId = deps.getRunId;
  setRunId = deps.setRunId;
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
    const context = { run: rasterRun, page: rasterPage, runId: getRunId(), rotation };
    const image = captureOcrImage(crop, rotation);
    const dimensions = rasterDimensions(context.page);
    const observations = await controller.recognize({ image, cropRect: crop, cropWidth: image.width, cropHeight: image.height, pageWidth: dimensions.width, pageHeight: dimensions.height, rotation, nativeText: context.page.nativeText || [], provenance: { sourceDocumentId: context.run.sourceDocument?.id, sourceDocumentVersion: context.run.sourceDocument?.version, processingRunId: context.run.id, pageId: context.page.sourcePageId, regionId: null, coordinateSpace: context.page.coordinateSpace || 'image', pageTransform: context.page.transform || context.page.sourceTransform || null, applyPageTransform: false, crop: crop, pageWidth: dimensions.width, pageHeight: dimensions.height }, pageTransform: context.page.transform || context.page.sourceTransform || null });
    if (getRunId() !== context.runId || rasterRun?.id !== context.run.id || rasterPage?.sourcePageId !== context.page.sourcePageId) {
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
/*  Raster Workflow                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function renderRasterWorkflow(run) {
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

export function renderPdfOcrWorkflow(run) {
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

export function cancelPdfPreview() {
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
    setRunId(result.processingRun.id);
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
    rasterPoints = []; rasterEditRegionId = null; rasterEditReplace = false; rasterMode = 'trace'; setRunId(result.processingRun.id); await pollRun();
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
    rasterPoints = []; rasterEditRegionId = null; rasterEditReplace = false; rasterMode = 'trace'; setRunId(result.processingRun.id); await pollRun();
    toast('Region saved', 'success');
  } catch (error) { rasterStatus.textContent = error.message; rasterStatus.className = 'text-sm error'; rasterCloseRegion.disabled = false; toast(error.message, 'error'); }
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  PDF Setup                                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

export function renderPdfSetup(run) {
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

