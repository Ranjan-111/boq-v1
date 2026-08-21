const { createServer: createHttpServer } = require('node:http');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createApplication, InputError, NotFoundError, ConflictError } = require('./application');
const { LIMITS, LimitError } = require('./ingestion/limits');
const { OcrResultError } = require('./ocr-results');

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = LIMITS.uploadBytes;
const PDFJS_ASSETS = Object.freeze({
  '/pdfjs/pdf.mjs': 'pdf.mjs',
  '/pdfjs/pdf.worker.mjs': 'pdf.worker.mjs'
});
const OCR_ASSETS = Object.freeze({
  '/ocr/engine.js': { file: 'public/ocr/engine.js', contentType: 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=3600' },
  '/ocr/model-cache.js': { file: 'public/ocr/model-cache.js', contentType: 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=3600' },
  '/ocr/normalize.js': { file: 'public/ocr/normalize.js', contentType: 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=3600' },
  '/ocr/tesseract.js': { file: 'public/ocr/tesseract.js', contentType: 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=3600' },
  '/ocr/paddle.js': { file: 'public/ocr/paddle.js', contentType: 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=3600' },
  '/ocr/vendor/tesseract.js/dist/tesseract.min.js': { file: 'node_modules/tesseract.js/dist/tesseract.min.js', contentType: 'text/javascript; charset=utf-8' },
  '/ocr/vendor/tesseract.js/dist/worker.min.js': { file: 'node_modules/tesseract.js/dist/worker.min.js', contentType: 'text/javascript; charset=utf-8' },
  '/ocr/vendor/tesseract.js-core/tesseract-core-lstm.wasm.js': { file: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', contentType: 'text/javascript; charset=utf-8' },
  '/ocr/vendor/tesseract.js-core/tesseract-core-lstm.wasm': { file: 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm', contentType: 'application/wasm' },
  '/ocr/vendor/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js': { file: 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', contentType: 'text/javascript; charset=utf-8' },
  '/ocr/vendor/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm': { file: 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', contentType: 'application/wasm' },
  '/ocr/vendor/tesseract.js-core/tesseract-core-simd-lstm.wasm.js': { file: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', contentType: 'text/javascript; charset=utf-8' },
  '/ocr/vendor/tesseract.js-core/tesseract-core-simd-lstm.wasm': { file: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', contentType: 'application/wasm' },
  '/ocr/vendor/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz': { file: 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', contentType: 'application/gzip', trainedDataSha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' }
});

class PayloadTooLargeError extends Error {
  constructor(message, details = {}) {
    super(message);
    Object.assign(this, details);
  }
}

function createServer(application = createApplication()) {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/') return sendFile(response, 'index.html', 'text/html; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/app.js') return sendFile(response, 'app.js', 'text/javascript; charset=utf-8');
      if (request.method === 'GET' && PDFJS_ASSETS[url.pathname]) return sendPdfjsAsset(response, PDFJS_ASSETS[url.pathname]);
      if (request.method === 'GET' && OCR_ASSETS[url.pathname]) return sendOcrAsset(response, OCR_ASSETS[url.pathname]);
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        return sendJson(response, 201, { project: application.createProject(await readJson(request)) });
      }
      const projectRollupMatch = /^\/api\/projects\/(project_\d+)\/rollup$/.exec(url.pathname);
      if (request.method === 'GET' && projectRollupMatch) return sendJson(response, 200, { rollup: application.getProjectRollup(projectRollupMatch[1], { boqVersionId: url.searchParams.get('boqVersionId') || undefined }) });
      const projectMatch = /^\/api\/projects\/(project_\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && projectMatch) return sendJson(response, 200, { project: application.getProject(projectMatch[1], { boqVersionId: url.searchParams.get('boqVersionId') || undefined }) });
      const projectBuildingMatch = /^\/api\/projects\/(project_\d+)\/buildings$/.exec(url.pathname);
      if (request.method === 'POST' && projectBuildingMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, { building: application.createBuilding({ ...body, projectId: projectBuildingMatch[1] }) });
      }
      const projectUploadMatch = /^\/api\/projects\/(project_\d+)\/source-documents$/.exec(url.pathname);
      if (request.method === 'POST' && projectUploadMatch) {
        const upload = await readUpload(request);
        upload.projectId = projectUploadMatch[1];
        const sourceDocument = application.createSourceDocument(upload);
        const processingRun = application.startProcessing(sourceDocument.id);
        return sendJson(response, 202, { sourceDocument, processingRun });
      }
      const projectVersionMatch = /^\/api\/projects\/(project_\d+)\/boq-versions$/.exec(url.pathname);
      if (request.method === 'POST' && projectVersionMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, { boqVersion: application.createBoqVersion({ ...body, projectId: projectVersionMatch[1] }) });
      }
      const projectMappingsMatch = /^\/api\/projects\/(project_\d+)\/mappings$/.exec(url.pathname);
      if (request.method === 'GET' && projectMappingsMatch) return sendJson(response, 200, { mappings: application.getStudioMappings({ projectId: projectMappingsMatch[1] }) });
      if (request.method === 'POST' && projectMappingsMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, { mapping: application.createStudioMapping({ ...body, projectId: projectMappingsMatch[1] }) });
      }
      const projectStudioMappingsMatch = /^\/api\/projects\/(project_\d+)\/studio-mappings$/.exec(url.pathname);
      if (request.method === 'GET' && projectStudioMappingsMatch) return sendJson(response, 200, { mappings: application.getStudioMappings({ projectId: projectStudioMappingsMatch[1] }) });
      if (request.method === 'POST' && projectStudioMappingsMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, { mapping: application.createStudioMapping({ ...body, projectId: projectStudioMappingsMatch[1] }) });
      }
      if (request.method === 'GET' && url.pathname === '/api/studio-mappings') return sendJson(response, 200, { mappings: application.getStudioMappings({ studioId: url.searchParams.get('studioId') || undefined }) });
      const mappingActionMatch = /^\/api\/mappings\/(mapping_\d+)\/(approve|retire)$/.exec(url.pathname);
      if (request.method === 'POST' && mappingActionMatch) {
        const body = await readJson(request);
        const mapping = mappingActionMatch[2] === 'approve' ? application.approveStudioMapping(mappingActionMatch[1], body) : application.retireStudioMapping(mappingActionMatch[1], body);
        return sendJson(response, 200, { mapping });
      }
      const mappingAliasMatch = /^\/api\/studio-mappings\/(mapping_\d+)\/(approve|retire)$/.exec(url.pathname);
      if (request.method === 'POST' && mappingAliasMatch) {
        const body = await readJson(request);
        const mapping = mappingAliasMatch[2] === 'approve' ? application.approveStudioMapping(mappingAliasMatch[1], body) : application.retireStudioMapping(mappingAliasMatch[1], body);
        return sendJson(response, 200, { mapping });
      }
      const buildingMatch = /^\/api\/buildings\/(building_\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && buildingMatch) return sendJson(response, 200, { building: application.getBuilding(buildingMatch[1]) });
      const buildingStoreyMatch = /^\/api\/buildings\/(building_\d+)\/storeys$/.exec(url.pathname);
      if (request.method === 'POST' && buildingStoreyMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, { storey: application.createStorey({ ...body, buildingId: buildingStoreyMatch[1] }) });
      }
      const storeyMatch = /^\/api\/storeys\/(storey_\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && storeyMatch) return sendJson(response, 200, { storey: application.getStorey(storeyMatch[1]) });
      if (request.method === 'POST' && url.pathname === '/api/source-documents') {
        const upload = await readUpload(request);
        const sourceDocument = application.createSourceDocument(upload);
        const processingRun = application.startProcessing(sourceDocument.id);
        return sendJson(response, 202, { sourceDocument, processingRun });
      }
      const assignmentMatch = /^\/api\/source-documents\/(src_\d+)\/(?:assignment|assign)$/.exec(url.pathname);
      if ((request.method === 'POST' || request.method === 'PATCH' || request.method === 'PUT') && assignmentMatch) {
        const assignment = application.assignSourceDocument(assignmentMatch[1], await readJson(request));
        return sendJson(response, 200, { sourceDocument: assignment, processingRun: assignment.processingRun || null });
      }
      const runMatch = /^\/api\/runs\/(run_\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && runMatch) return sendJson(response, 200, application.getRun(runMatch[1]));
      const exceptionsMatch = /^\/api\/projects\/(project_\d+)\/exceptions$/.exec(url.pathname);
      if (request.method === 'GET' && exceptionsMatch) return sendJson(response, 200, application.getExceptionQueue(exceptionsMatch[1]));
      const resolveMatch = /^\/api\/projects\/(project_\d+)\/exceptions\/resolve$/.exec(url.pathname);
      if (request.method === 'POST' && resolveMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, application.resolveExceptionGroup(resolveMatch[1], body.groupKey, body));
      }
      const resolutionsMatch = /^\/api\/projects\/(project_\d+)\/resolutions$/.exec(url.pathname);
      if (request.method === 'GET' && resolutionsMatch) return sendJson(response, 200, { resolutions: application.getResolutions(resolutionsMatch[1]) });
      const approveMatch = /^\/api\/boq-versions\/(boqv_\d+)\/approve$/.exec(url.pathname);
      if (request.method === 'POST' && approveMatch) {
        const body = await readJson(request);
        return sendJson(response, 201, { boqVersion: application.approveBoqVersion(approveMatch[1], body) });
      }
      const boqVersionMatch = /^\/api\/boq-versions\/(boqv_\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && boqVersionMatch) return sendJson(response, 200, { boqVersion: application.getBoqVersion(boqVersionMatch[1]) });
      const runClassificationsMatch = /^\/api\/runs\/(run_\d+)\/classifications$/.exec(url.pathname);
      if (request.method === 'GET' && runClassificationsMatch) return sendJson(response, 200, application.getClassifications(runClassificationsMatch[1]));
      const ocrResultsMatch = /^\/api\/runs\/(run_\d+)\/pages\/(page_\d+)\/ocr-results$/.exec(url.pathname);
      if (request.method === 'GET' && ocrResultsMatch) return sendJson(response, 200, application.getOcrResults(ocrResultsMatch[1], ocrResultsMatch[2]));
      if (request.method === 'POST' && ocrResultsMatch) return sendJson(response, 201, application.submitOcrResults(ocrResultsMatch[1], ocrResultsMatch[2], await readJson(request)));
      const ocrStatusMatch = /^\/api\/runs\/(run_\d+)\/ocr-status$/.exec(url.pathname);
      if (request.method === 'GET' && ocrStatusMatch) return sendJson(response, 200, application.getOcrStatus(ocrStatusMatch[1]));
      const imageMatch = /^\/api\/runs\/(run_\d+)\/pages\/(page_\d+)\/image$/.exec(url.pathname);
      if (request.method === 'GET' && imageMatch) {
        const image = application.getRasterImage(imageMatch[1], imageMatch[2]);
        response.writeHead(200, { 'content-type': image.mediaType, 'cache-control': 'no-store' });
        return response.end(image.content);
      }
      const reprocessMatch = /^\/api\/runs\/(run_\d+)\/reprocess$/.exec(url.pathname);
      if (request.method === 'POST' && reprocessMatch) return sendJson(response, 202, { processingRun: application.reprocess(reprocessMatch[1]) });
      const setupMatch = /^\/api\/runs\/(run_\d+)\/setup$/.exec(url.pathname);
      if (request.method === 'POST' && setupMatch) return sendJson(response, 202, { processingRun: application.confirmSourceSetup(setupMatch[1], await readJson(request)) });
      const calibrationMatch = /^\/api\/runs\/(run_\d+)\/pages\/(page_\d+)\/calibration$/.exec(url.pathname);
      if (request.method === 'POST' && calibrationMatch) return sendJson(response, 202, application.calibrateRasterPage(calibrationMatch[1], calibrationMatch[2], await readJson(request)));
      const regionMatch = /^\/api\/runs\/(run_\d+)\/pages\/(page_\d+)\/regions(?:\/(region_\d+))?(?:\/(confirm))?$/.exec(url.pathname);
      if (regionMatch?.[4] === 'confirm' && request.method === 'POST') return sendJson(response, 202, application.confirmRasterRegion(regionMatch[1], regionMatch[2], regionMatch[3], { ...await readJson(request), ...revisionQuery(url) }));
      if (request.method === 'POST' && regionMatch && !regionMatch[3]) return sendJson(response, 202, application.createRasterRegion(regionMatch[1], regionMatch[2], await readJson(request)));
      if (request.method === 'PATCH' && regionMatch?.[3]) return sendJson(response, 200, application.updateRasterRegion(regionMatch[1], regionMatch[2], regionMatch[3], await readJson(request)));
      if (request.method === 'DELETE' && regionMatch?.[3]) return sendJson(response, 200, application.deleteRasterRegion(regionMatch[1], regionMatch[2], regionMatch[3], revisionQuery(url)));
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error instanceof PayloadTooLargeError || error instanceof LimitError ? 413 : error instanceof ConflictError ? 409 : error instanceof InputError || error instanceof OcrResultError || error.code === 'invalid_ocr_result' ? 422 : error instanceof NotFoundError || error.code === 'not_found' ? 404 : 500;
      const runContext = /^\/api\/runs\/(run_\d+)(?:\/pages\/(page_\d+))?/.exec(new URL(request.url, 'http://localhost').pathname);
      const body = {
        error: status === 500 ? 'Unexpected server error.' : (error.message || 'Unexpected server error.'),
        code: status === 500 ? 'internal_error' : error.code || ({ 400: 'invalid_request', 404: 'not_found', 409: 'workflow_conflict', 413: 'limit_exceeded', 422: 'invalid_input' }[status] || 'request_error'),
        stage: error.stage || (runContext ? 'raster' : 'request'),
        retryable: error.retryable ?? false,
        ...(runContext ? { runId: runContext[1], sourcePageId: runContext[2] || null } : {})
      };
      if (error.sourceDocumentId) body.sourceDocumentId = error.sourceDocumentId;
      if (error instanceof LimitError || error instanceof PayloadTooLargeError) Object.assign(body, { code: 'limit_exceeded', stage: error.stage || 'upload', limitName: error.limitName, observed: error.observed, maximum: error.maximum });
      return sendJson(response, status, body);
    }
  });
}

function revisionQuery(url) {
  const result = {};
  for (const key of ['expectedRevision', 'expectedPageRevision', 'expectedRegionRevision']) {
    const value = url.searchParams.get(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

async function readUpload(request) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new InputError('Submit the drawing as multipart form data.');

  const body = await readBody(request, MAX_UPLOAD_BODY_BYTES, 'uploadBytes');
  const parts = splitMultipart(body, Buffer.from(`--${boundary}`));
  const fields = {};
  let drawingPart;
  for (const part of parts) {
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator === -1) continue;
    const headers = part.subarray(0, separator).toString('latin1');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    let value = part.subarray(separator + 4);
    if (value.subarray(-2).equals(Buffer.from('\r\n'))) value = value.subarray(0, -2);
    if (name === 'drawing') drawingPart = { value, filename: /filename="([^"]+)"/.exec(headers)?.[1] };
    else fields[name] = value.toString('utf8');
  }
  if (!drawingPart?.filename) throw new InputError('A drawing file field is required.');
  return {
    filename: drawingPart.filename,
    content: drawingPart.value,
    fallbackUnit: fields.fallbackUnit,
    studioId: fields.studioId,
    projectId: fields.projectId,
    buildingId: fields.buildingId,
    storeyId: fields.storeyId,
    sourceSheet: fields.sourceSheet || fields.sheet,
    boqVersionId: fields.boqVersionId,
    typicalMultiplier: fields.typicalStoreyMultiplier || fields.typicalMultiplier || 1
  };
}

function splitMultipart(body, boundary) {
  const parts = [];
  let cursor = findBoundary(body, boundary, 0);
  while (cursor !== -1) {
    const start = cursor + boundary.length;
    if (body.subarray(start, start + 2).equals(Buffer.from('--'))) break;
    if (!body.subarray(start, start + 2).equals(Buffer.from('\r\n'))) {
      cursor = findBoundary(body, boundary, start);
      continue;
    }
    const next = findBoundary(body, boundary, start + 2);
    if (next === -1) break;
    const part = body.subarray(start, next);
    parts.push(part.subarray(0, part.length - (part.subarray(-2).equals(Buffer.from('\r\n')) ? 2 : 0)));
    cursor = next;
  }
  return parts;
}

function findBoundary(body, boundary, from) {
  let cursor = body.indexOf(boundary, from);
  while (cursor !== -1) {
    const atLineStart = cursor === 0 || body.subarray(cursor - 2, cursor).equals(Buffer.from('\r\n'));
    const suffix = body.subarray(cursor + boundary.length, cursor + boundary.length + 2);
    const validSuffix = suffix.equals(Buffer.from('\r\n')) || suffix.equals(Buffer.from('--'));
    if (atLineStart && validSuffix) return cursor;
    cursor = body.indexOf(boundary, cursor + 1);
  }
  return -1;
}

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BODY_BYTES, 'jsonBodyBytes');
  try { return JSON.parse(body.toString('utf8') || '{}'); }
  catch { throw new InputError('Submit a valid JSON request body.'); }
}

async function readBody(request, maxBytes, limitName) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes} byte limit.`, { limitName, observed: declaredLength, maximum: maxBytes });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes} byte limit.`, { limitName, observed: size, maximum: maxBytes });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function sendFile(response, filename, contentType) {
  const content = await readFile(join(__dirname, '..', 'public', filename));
  response.writeHead(200, { 'content-type': contentType });
  response.end(content);
}

async function sendPdfjsAsset(response, filename) {
  const content = await readFile(join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', filename));
  response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  response.end(content);
}

async function sendOcrAsset(response, asset) {
  const content = await readFile(join(__dirname, '..', asset.file));
  const headers = { 'content-type': asset.contentType, 'cache-control': asset.cacheControl || 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' };
  if (asset.trainedDataSha256) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (sha256 !== asset.trainedDataSha256) throw new Error('Pinned OCR model asset integrity check failed.');
    headers.etag = `"${sha256}"`;
    headers['x-content-sha256'] = sha256;
  }
  response.writeHead(200, headers);
  response.end(content);
}

if (require.main === module) {
  createServer().listen(process.env.PORT || 3000, () => console.log('BOQ operator app listening on http://localhost:3000'));
}

module.exports = { createServer };
