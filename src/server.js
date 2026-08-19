const { createServer: createHttpServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createApplication, InputError, NotFoundError, ConflictError } = require('./application');
const { LIMITS, LimitError } = require('./ingestion/limits');

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = LIMITS.uploadBytes;

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
      const reprocessMatch = /^\/api\/runs\/(run_\d+)\/reprocess$/.exec(url.pathname);
      if (request.method === 'POST' && reprocessMatch) return sendJson(response, 202, { processingRun: application.reprocess(reprocessMatch[1]) });
      const setupMatch = /^\/api\/runs\/(run_\d+)\/setup$/.exec(url.pathname);
      if (request.method === 'POST' && setupMatch) return sendJson(response, 202, { processingRun: application.confirmSourceSetup(setupMatch[1], await readJson(request)) });
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error instanceof PayloadTooLargeError || error instanceof LimitError ? 413 : error instanceof ConflictError ? 409 : error instanceof InputError ? 422 : error instanceof NotFoundError ? 404 : 500;
      const body = { error: status === 500 ? 'Unexpected server error.' : (error.message || 'Unexpected server error.') };
      if (error instanceof LimitError || error instanceof PayloadTooLargeError) Object.assign(body, { code: 'limit_exceeded', stage: error.stage || 'upload', limitName: error.limitName, observed: error.observed, maximum: error.maximum });
      return sendJson(response, status, body);
    }
  });
}

async function readUpload(request) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new InputError('Submit the DXF as multipart form data.');

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
  if (!drawingPart?.filename) throw new InputError('A DXF drawing field is required.');
  return {
    filename: drawingPart.filename,
    content: drawingPart.value,
    fallbackUnit: fields.fallbackUnit,
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

if (require.main === module) {
  createServer().listen(process.env.PORT || 3000, () => console.log('BOQ operator app listening on http://localhost:3000'));
}

module.exports = { createServer };
