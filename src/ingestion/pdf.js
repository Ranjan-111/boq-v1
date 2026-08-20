const { LIMITS, LimitError } = require('./limits');
const { PDF_VERSIONS } = require('./pdf-config');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

let pdfjsPromise;

async function pdfjs() {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function inspectPdf(content, sourceDocument, { limits = LIMITS } = {}) {
  if (!isMainThread) return inspectPdfInternal(content, sourceDocument, { limits });
  return inspectPdfInWorker(content, limits);
}

async function inspectPdfInWorker(content, limits) {
  const bytes = Buffer.from(content);
  const transferable = Uint8Array.from(bytes).buffer;
  const worker = new Worker(__filename, {
    workerData: { pdfInspection: true, content: transferable, limits },
    transferList: [transferable],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 }
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let bestPageId = null;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate().catch(() => {}); fn(value); };
    const timer = setTimeout(() => finish(reject, new LimitError(`PDF parsing exceeded ${limits.pdfParseMs} ms; split or simplify the source.`, { limitName: 'pdfParseMs', maximum: limits.pdfParseMs, sourcePageId: bestPageId })), limits.pdfParseMs);
    worker.on('message', (message) => {
      if (message.progress) { bestPageId = message.progress.sourcePageId; return; }
      if (message.ok) return finish(resolve, message.result);
      const error = new Error(message.error.message);
      Object.assign(error, message.error);
      finish(reject, error);
    });
    worker.once('error', (error) => finish(reject, workerFailure(error.message, error.code, bestPageId)));
    worker.once('exit', (code) => {
      if (settled) return;
      if (code !== 0) return finish(reject, workerFailure(`PDF parser resource boundary exited with code ${code}.`, code === 1 ? 'ERR_WORKER_OUT_OF_MEMORY' : 'ERR_WORKER_EXIT', bestPageId));
      return finish(reject, workerFailure('PDF parser exited without returning an inspection result.', 'ERR_WORKER_NO_RESULT', bestPageId));
    });
  });
}

function workerFailure(message, code, sourcePageId) {
  const error = new Error(`${message} Re-export the PDF or split it into smaller files.`);
  error.code = 'pdf_resource_exhausted';
  error.adapterCode = code;
  error.stage = 'inspection';
  error.sourcePageId = sourcePageId || null;
  error.retryable = false;
  return error;
}

async function inspectPdfInternal(content, sourceDocument, { limits = LIMITS } = {}) {
  const deadline = Date.now() + limits.pdfParseMs;
  const pdf = await awaitDeadline(pdfjs(), deadline, limits, 'loading PDF.js');
  const bytes = new Uint8Array(content);
  let loadingTask;
  let document;
  let timedOut = false;
  let currentSourcePageId = null;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ||= boundedCleanup([document, loadingTask], limits.pdfCleanupMs);
    return cleanupPromise;
  };
  const destroy = () => {
    timedOut = true;
    return cleanup();
  };
  try {
    loadingTask = pdf.getDocument({
      data: bytes,
      disableWorker: true,
      useWorkerFetch: false,
      maxImageSize: 1024 * 1024,
      stopAtErrors: true,
      isEvalSupported: false,
      verbosity: pdf.VerbosityLevel.ERRORS
    });
    document = await awaitDeadline(loadingTask.promise, deadline, limits, 'loading PDF', destroy);
    if (document.numPages > limits.pdfPages) throw new LimitError(`PDF has ${document.numPages} pages; split it into files with no more than ${limits.pdfPages} pages.`, { limitName: 'pdfPages', observed: document.numPages, maximum: limits.pdfPages });
    const pages = [];
    let operators = 0;
    let textItems = 0;
    let vectorRegions = 0;
    let rasterRegions = 0;
    let rasterPixels = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      currentSourcePageId = pageId(pageNumber);
      if (parentPort) parentPort.postMessage({ progress: { sourcePageId: currentSourcePageId } });
      checkDeadline(deadline, limits, destroy, currentSourcePageId);
      const page = await awaitDeadline(document.getPage(pageNumber), deadline, limits, `loading PDF page ${pageNumber}`, destroy, currentSourcePageId);
      const rotation = page.rotate || 0;
      // Match the browser preview's PDF.js viewport exactly. The default
      // viewport includes PDF.js's y-axis flip; using dontFlip here made
      // rotated-page tracing coordinates disagree with the rendered canvas.
      const viewport = page.getViewport({ scale: 1, rotation });
      const pageText = await readTextContent(page, deadline, limits, destroy, limits.pdfTextItems - textItems, pageNumber);
      textItems += pageText.length;
      const nativeText = pageText.map((item, index) => {
        const transform = multiply(viewport.transform, item.transform);
        return {
          id: `pdf:p${pageNumber}:text:${String(index + 1).padStart(4, '0')}`,
          text: item.str,
          transform,
          rawTransform: item.transform,
          width: item.width,
          height: item.height,
          textPolygon: textPolygon(transform, item.width, item.height),
          geometrySource: 'native-pdf',
          coordinateSpace: 'pdf'
        };
      });
      const operatorList = await awaitDeadline(page.getOperatorList(pdf.AnnotationMode ? { annotationMode: pdf.AnnotationMode.DISABLE } : undefined), deadline, limits, `reading PDF geometry on page ${pageNumber}`, destroy, currentSourcePageId);
      operators += operatorList.fnArray.length;
      if (operators > limits.pdfOperators) throw new LimitError(`PDF contains more than ${limits.pdfOperators} drawing operators; simplify or split the source.`, { limitName: 'pdfOperators', observed: operators, maximum: limits.pdfOperators, sourcePageId: pageId(pageNumber) });
      const argumentCount = operatorList.argsArray.reduce((total, args) => total + (Array.isArray(args) ? args.length : args ? 1 : 0), 0);
      if (argumentCount > limits.pdfOperatorArgs) throw new LimitError(`PDF operator arguments exceed ${limits.pdfOperatorArgs}; simplify or split the source.`, { limitName: 'pdfOperatorArgs', observed: argumentCount, maximum: limits.pdfOperatorArgs, sourcePageId: pageId(pageNumber) });
      const geometry = extractPageGeometry(operatorList, pdf.OPS, viewport, pageNumber, { limits: { ...limits, pdfRasterPixels: limits.pdfRasterPixels - rasterPixels }, check: () => checkDeadline(deadline, limits, destroy, currentSourcePageId) });
      vectorRegions += geometry.regions.length;
      rasterRegions += geometry.rasterRegions.length;
      rasterPixels += geometry.rasterPixels;
      if (vectorRegions > limits.pdfVectorRegions) throw new LimitError(`PDF contains more than ${limits.pdfVectorRegions} vector regions; simplify or split the source.`, { limitName: 'pdfVectorRegions', observed: vectorRegions, maximum: limits.pdfVectorRegions, sourcePageId: pageId(pageNumber) });
      if (rasterRegions > limits.pdfRasterRegions) throw new LimitError(`PDF contains more than ${limits.pdfRasterRegions} raster regions; simplify or split the source.`, { limitName: 'pdfRasterRegions', observed: rasterRegions, maximum: limits.pdfRasterRegions, sourcePageId: pageId(pageNumber) });
      const kind = geometry.regions.length && geometry.rasterRegions.length ? 'mixed' : geometry.regions.length ? 'vector' : 'raster';
      const pageWidth = page.view[2] - page.view[0];
      const pageHeight = page.view[3] - page.view[1];
      const previewWidth = viewport.width;
      const previewHeight = viewport.height;
      if (kind !== 'vector') {
        if (!Number.isFinite(previewWidth) || !Number.isFinite(previewHeight) || previewWidth <= 0 || previewHeight <= 0) throw new Error(`PDF raster page ${pageNumber} has invalid preview dimensions; re-export the source.`);
        if (previewWidth > limits.rasterWidth) throw new LimitError(`PDF raster page width exceeds ${limits.rasterWidth}; simplify or split the source.`, { limitName: 'rasterWidth', observed: previewWidth, maximum: limits.rasterWidth, sourcePageId: pageId(pageNumber) });
        if (previewHeight > limits.rasterHeight) throw new LimitError(`PDF raster page height exceeds ${limits.rasterHeight}; simplify or split the source.`, { limitName: 'rasterHeight', observed: previewHeight, maximum: limits.rasterHeight, sourcePageId: pageId(pageNumber) });
        if (previewWidth * previewHeight > limits.rasterPixels) throw new LimitError(`PDF raster page pixel area exceeds ${limits.rasterPixels}; simplify or split the source.`, { limitName: 'rasterPixels', observed: previewWidth * previewHeight, maximum: limits.rasterPixels, sourcePageId: pageId(pageNumber) });
      }
      pages.push({
        sourcePageId: pageId(pageNumber),
        pageNumber,
        kind,
        width: pageWidth,
        height: pageHeight,
        // Raster interaction uses the same normalized, page-preview coordinate
        // space as the browser PDF canvas. Keep the PDF viewport transform so
        // downstream evidence can still map back to source PDF user space.
        // Raster interaction is expressed in the same rotated viewport space
        // used by PDF.js in the browser. Raw PDF user-space geometry remains
        // recoverable through sourceTransform and the explicit rotation.
        pixelWidth: kind === 'vector' ? undefined : previewWidth,
        pixelHeight: kind === 'vector' ? undefined : previewHeight,
        coordinateSpace: 'pdf',
        coordinateSpaceDefinition: 'page viewport after rotation; raw PDF user space is preserved in rawTransform fields',
        rotation,
        transform: viewport.transform,
        sourceTransform: viewport.transform,
        rasterTransform: kind === 'vector' ? undefined : [1, 0, 0, 1, 0, 0],
        route: kind === 'vector' ? 'native-vector' : 'raster',
        nativeText,
        nativeTextIds: nativeText.map((item) => item.id),
        nativeRegionIds: geometry.regions.map((region) => region.id),
        rasterRegionIds: geometry.rasterRegions.map((region) => region.id),
        vectorRegions: geometry.regions,
        rasterRegions: geometry.rasterRegions
      });
    }
    return { format: 'pdf', ingestVersion: PDF_VERSIONS.parser, versions: PDF_VERSIONS, pages };
  } catch (error) {
    if (timedOut) throw new LimitError(`PDF parsing exceeded ${limits.pdfParseMs} ms; split or simplify the source.`, { limitName: 'pdfParseMs', maximum: limits.pdfParseMs, sourcePageId: currentSourcePageId });
    annotatePdfError(error);
    throw error;
  } finally {
    await cleanup();
  }
}

function annotatePdfError(error) {
  const pageMatch = /page[_ ](\d+)|page (\d+)/i.exec(error.message || '');
  if (!error.sourcePageId && pageMatch) error.sourcePageId = pageId(Number(pageMatch[1] || pageMatch[2]));
  error.stage ||= 'inspection';
  error.code ||= error instanceof LimitError ? 'limit_exceeded' : /unsupported/i.test(error.message || '') ? 'unsupported_pdf' : 'malformed_pdf';
  error.retryable ??= false;
  return error;
}

function boundedCleanup(targets, milliseconds) {
  const pending = Promise.all(targets.map((target) => safelyDestroy(target)));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function safelyDestroy(target) {
  if (!target?.destroy) return Promise.resolve();
  try { return Promise.resolve(target.destroy()).catch(() => {}); }
  catch { return Promise.resolve(); }
}

if (!isMainThread && workerData?.pdfInspection) {
  inspectPdfInternal(Buffer.from(workerData.content), null, { limits: workerData.limits })
    .then((result) => parentPort.postMessage({ ok: true, result }))
    .catch((error) => parentPort.postMessage({ ok: false, error: { message: error.message, name: error.name, code: error.code, stage: error.stage, sourcePageId: error.sourcePageId, retryable: error.retryable, limitName: error.limitName, observed: error.observed, maximum: error.maximum } }));
}

async function readTextContent(page, deadline, limits, destroy, remainingItems, pageNumber) {
  const items = [];
  if (typeof page.streamTextContent === 'function') {
    const reader = page.streamTextContent().getReader();
    try {
      while (true) {
        const chunk = await awaitDeadline(reader.read(), deadline, limits, `reading PDF text on page ${pageNumber}`, destroy, pageId(pageNumber));
        if (chunk.done) break;
        const chunkItems = chunk.value?.items || [];
        if (items.length + chunkItems.length > remainingItems) throw new LimitError(`PDF contains more than ${limits.pdfTextItems} text items; split or simplify the source.`, { limitName: 'pdfTextItems', observed: items.length + chunkItems.length, maximum: limits.pdfTextItems, sourcePageId: pageId(pageNumber) });
        items.push(...chunkItems);
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return items;
  }
  const content = await awaitDeadline(page.getTextContent(), deadline, limits, `reading PDF text on page ${pageNumber}`, destroy, pageId(pageNumber));
  if (content.items.length > remainingItems) throw new LimitError(`PDF contains more than ${limits.pdfTextItems} text items; split or simplify the source.`, { limitName: 'pdfTextItems', observed: content.items.length, maximum: limits.pdfTextItems, sourcePageId: pageId(pageNumber) });
  return content.items;
}

function extractRegions(operatorList, OPS, viewport, pageNumber, options = {}) {
  return extractPageGeometry(operatorList, OPS, viewport, pageNumber, options).regions;
}

function extractPageGeometry(operatorList, OPS, viewport, pageNumber, { limits = LIMITS, check = () => {} } = {}) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const paths = [];
  const rasterRegions = [];
  let rasterPixels = 0;
  let current = null;
  let pathOps = 0;
  let pathCoordinates = 0;
  const imageOperators = new Set([
    OPS.paintImageMaskXObject, OPS.paintImageXObject, OPS.paintInlineImageXObject
  ].filter((value) => value !== undefined));
  const unsupportedImageOperators = new Set([
    OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup,
    OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup,
    OPS.paintSolidColorImageMask
  ].filter((value) => value !== undefined));
  const paintOperators = new Set([
    OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke
  ].filter((value) => value !== undefined));
  const discardOperators = new Set([OPS.clip, OPS.eoClip, OPS.endPath].filter((value) => value !== undefined));
  const closePaintOperators = new Set([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter((value) => value !== undefined));
  const implicitClosePaintOperators = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].filter((value) => value !== undefined));
  const pendingPaths = [];
  const commitClosedCurrent = () => {
    if (current?.length >= 3) pendingPaths.push(current);
    current = null;
  };
  const discardCurrent = () => { current = null; };
  const requireCoordinates = (count, args, cursor) => {
    pathCoordinates += count;
    if (pathCoordinates > limits.pdfPathCoordinates) throw new LimitError(`PDF path coordinates exceed ${limits.pdfPathCoordinates}; simplify the source.`, { limitName: 'pdfPathCoordinates', observed: pathCoordinates, maximum: limits.pdfPathCoordinates, sourcePageId: pageId(pageNumber) });
    if (!Array.isArray(args) || cursor + count > args.length) throw new Error(`Malformed packed PDF path on page ${pageNumber}; re-export or simplify the source.`);
  };
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    check();
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (unsupportedImageOperators.has(fn)) throw new Error(`Unsupported repeated or grouped PDF image operator on page ${pageNumber}; flatten images or simplify the source.`);
    if (imageOperators.has(fn)) {
      const pixelWidth = imageWidth(args);
      const pixelHeight = imageHeight(args);
      if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight) || pixelWidth <= 0 || pixelHeight <= 0) throw new Error(`PDF image on page ${pageNumber} has unknown intrinsic dimensions; flatten the image or simplify the source.`);
      const pixels = imagePixels(args);
      if (!Number.isFinite(pixels) || pixels <= 0) throw new Error(`PDF image on page ${pageNumber} has an unsafe pixel area; flatten the image or simplify the source.`);
      rasterPixels += pixels;
      if (rasterPixels > limits.pdfRasterPixels) throw new LimitError(`PDF raster pixels exceed ${limits.pdfRasterPixels}; simplify or split the source.`, { limitName: 'pdfRasterPixels', observed: rasterPixels, maximum: limits.pdfRasterPixels, sourcePageId: pageId(pageNumber) });
      const displayTransform = multiply(viewport.transform, ctm);
      rasterRegions.push({ id: `pdf:p${pageNumber}:raster:${String(rasterRegions.length + 1).padStart(4, '0')}`, pageNumber, operator: fn, operatorIndex: index, geometrySource: 'native-pdf-image', coordinateSpace: 'pdf', transform: displayTransform, displayQuad: [multiplyPoint(displayTransform, 0, 0), multiplyPoint(displayTransform, 1, 0), multiplyPoint(displayTransform, 1, 1), multiplyPoint(displayTransform, 0, 1)], pixelWidth, pixelHeight });
      continue;
    }
    if (closePaintOperators.has(fn) || implicitClosePaintOperators.has(fn)) commitClosedCurrent();
    if (paintOperators.has(fn)) { paths.push(...pendingPaths.splice(0)); continue; }
    if (discardOperators.has(fn)) { pendingPaths.length = 0; current = null; continue; }
    if (fn === OPS.save) { stack.push(ctm); continue; }
    if (fn === OPS.restore) { ctm = stack.pop() || ctm; continue; }
    if (fn === OPS.transform) {
      if (!Array.isArray(args) || args.length < 6) throw new Error(`Malformed PDF transform on page ${pageNumber}; re-export or simplify the source.`);
      ctm = multiply(ctm, args);
      continue;
    }
    if (fn === OPS.constructPath) {
      if (!Array.isArray(args) || args.length < 2 || !Array.isArray(args[0]) || !Array.isArray(args[1])) throw new Error(`Malformed packed PDF path on page ${pageNumber}; re-export or simplify the source.`);
      const [ops, coords] = args;
      let cursor = 0;
      for (const op of ops) {
        check();
        pathOps += 1;
        if (pathOps > limits.pdfPathOperators) throw new LimitError(`PDF path operators exceed ${limits.pdfPathOperators}; simplify the source.`, { limitName: 'pdfPathOperators', observed: pathOps, maximum: limits.pdfPathOperators, sourcePageId: pageId(pageNumber) });
        if (op === OPS.moveTo) {
          requireCoordinates(2, coords, cursor);
          discardCurrent();
          current = [mapPoint(viewport.transform, ctm, coords[cursor], coords[cursor + 1])];
          cursor += 2;
        } else if (op === OPS.lineTo) {
          requireCoordinates(2, coords, cursor);
          if (!current) throw new Error(`PDF line path starts before moveTo on page ${pageNumber}; re-export or simplify the source.`);
          current.push(mapPoint(viewport.transform, ctm, coords[cursor], coords[cursor + 1]));
          cursor += 2;
        } else if (op === OPS.rectangle) {
          requireCoordinates(4, coords, cursor);
          discardCurrent();
          const [x, y, width, height] = coords.slice(cursor, cursor + 4);
          cursor += 4;
          pendingPaths.push([
            mapPoint(viewport.transform, ctm, x, y),
            mapPoint(viewport.transform, ctm, x + width, y),
            mapPoint(viewport.transform, ctm, x + width, y + height),
            mapPoint(viewport.transform, ctm, x, y + height)
          ]);
        } else if (op === OPS.closePath) {
          commitClosedCurrent();
        } else if ([OPS.curveTo, OPS.curveTo2, OPS.curveTo3].includes(op)) {
          throw new Error(`Unsupported curved PDF path on page ${pageNumber}; export straight-line vector geometry or simplify the source.`);
        } else {
          throw new Error(`Unsupported packed PDF path operator ${op} on page ${pageNumber}; re-export straight-line vector geometry.`);
        }
      }
      if (cursor !== coords.length) throw new Error(`Malformed packed PDF path coordinates on page ${pageNumber}; re-export or simplify the source.`);
      continue;
    }
    if (fn === OPS.closePath) { commitClosedCurrent(); continue; }
  }
  const regions = paths.map((points, index) => ({
    id: `pdf:p${pageNumber}:path:${String(index + 1).padStart(4, '0')}`,
    pageNumber, points, area: polygonArea(points), geometrySource: 'native-pdf', coordinateSpace: 'pdf', transform: viewport.transform
  })).filter((region) => region.area > 0);
  return { regions, rasterRegions, rasterPixels };
}

function imageWidth(args) {
  if (Array.isArray(args)) return args.length === 1 ? Number(args[0]?.width) || null : Number(args[1]) || null;
  return Number(args?.width) || null;
}

function imageHeight(args) {
  if (Array.isArray(args)) return args.length === 1 ? Number(args[0]?.height) || null : Number(args[2]) || null;
  return Number(args?.height) || null;
}

function imagePixels(args) {
  if (Array.isArray(args) && args.length === 1 && Array.isArray(args[0])) return args[0].reduce((total, descriptor) => total + imagePixels(descriptor), 0);
  const width = imageWidth(args);
  const height = imageHeight(args);
  return width && height ? width * height : 0;
}

function mapPoint(pageTransform, ctm, x, y) {
  const point = multiplyPoint(ctm, x, y);
  return multiplyPoint(pageTransform, point[0], point[1]);
}

function multiply(left, right) {
  return [left[0] * right[0] + left[2] * right[1], left[1] * right[0] + left[3] * right[1], left[0] * right[2] + left[2] * right[3], left[1] * right[2] + left[3] * right[3], left[0] * right[4] + left[2] * right[5] + left[4], left[1] * right[4] + left[3] * right[5] + left[5]];
}

function multiplyPoint(matrix, x, y) { return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]; }

function textPolygon(transform, width, height) {
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const baselineLength = Math.hypot(transform[0], transform[1]);
  const verticalLength = Math.hypot(transform[2], transform[3]);
  const textWidth = Number(width); const textHeight = Number(height);
  if (![baselineLength, verticalLength, textWidth, textHeight].every(Number.isFinite) || baselineLength <= 0 || verticalLength <= 0 || textWidth <= 0 || textHeight <= 0) return null;
  const origin = [transform[4], transform[5]];
  const baseline = [transform[0] / baselineLength * textWidth, transform[1] / baselineLength * textWidth];
  const vertical = [transform[2] / verticalLength * textHeight, transform[3] / verticalLength * textHeight];
  const add = (left, right) => [left[0] + right[0], left[1] + right[1]];
  return [origin, add(origin, baseline), add(add(origin, baseline), vertical), add(origin, vertical)];
}

function polygonArea(points) {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

function pageId(pageNumber) { return `page_${pageNumber}`; }

function checkDeadline(deadline, limits, onTimeout, sourcePageId = null) {
  if (Date.now() >= deadline) {
    void Promise.resolve(onTimeout()).catch(() => {});
    throw new LimitError(`PDF parsing exceeded ${limits.pdfParseMs} ms; split or simplify the source.`, { limitName: 'pdfParseMs', maximum: limits.pdfParseMs, sourcePageId });
  }
}

function awaitDeadline(promise, deadline, limits, action, onTimeout = () => {}, sourcePageId = null) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new LimitError(`PDF parsing exceeded ${limits.pdfParseMs} ms while ${action}; split or simplify the source.`, { limitName: 'pdfParseMs', maximum: limits.pdfParseMs, sourcePageId }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void Promise.resolve(onTimeout()).catch(() => {});
      reject(new LimitError(`PDF parsing exceeded ${limits.pdfParseMs} ms while ${action}; split or simplify the source.`, { limitName: 'pdfParseMs', maximum: limits.pdfParseMs, sourcePageId }));
    }, remaining);
    Promise.resolve(promise).then((value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } }, (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

module.exports = { inspectPdf, extractRegions, extractPageGeometry, polygonArea, PDF_VERSIONS };
