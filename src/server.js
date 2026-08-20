const { createServer: createHttpServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createApplication, InputError, NotFoundError } = require('./application');

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 10 * 1024 * 1024;

class PayloadTooLargeError extends Error {}

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
      const runClassificationsMatch = /^\/api\/runs\/(run_\d+)\/classifications$/.exec(url.pathname);
      if (request.method === 'GET' && runClassificationsMatch) return sendJson(response, 200, application.getClassifications(runClassificationsMatch[1]));
      const reprocessMatch = /^\/api\/runs\/(run_\d+)\/reprocess$/.exec(url.pathname);
      if (request.method === 'POST' && reprocessMatch) return sendJson(response, 202, { processingRun: application.reprocess(reprocessMatch[1]) });
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error instanceof PayloadTooLargeError ? 413 : error instanceof InputError ? 422 : error instanceof NotFoundError ? 404 : 500;
      return sendJson(response, status, { error: error.message || 'Unexpected server error.' });
    }
  });
}

async function readUpload(request) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new InputError('Submit the DXF as multipart form data.');

  const body = await readBody(request, MAX_UPLOAD_BODY_BYTES);
  const parts = body.toString('utf8').split(`--${boundary}`);
  const fields = {};
  let drawingPart;
  for (const part of parts) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    const separator = part.indexOf('\r\n\r\n');
    if (!name || separator === -1) continue;
    const value = part.slice(separator + 4).replace(/\r\n$/, '');
    if (name === 'drawing') drawingPart = { part, value, filename: /filename="([^"]+)"/.exec(part)?.[1] };
    else fields[name] = value;
  }
  if (!drawingPart?.filename) throw new InputError('A DXF drawing field is required.');
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

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BODY_BYTES);
  try { return JSON.parse(body.toString('utf8') || '{}'); }
  catch { throw new InputError('Submit a valid JSON request body.'); }
}

async function readBody(request, maxBytes) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes} byte limit.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes} byte limit.`);
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
