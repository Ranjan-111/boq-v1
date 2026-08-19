const { createServer: createHttpServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createApplication, InputError, NotFoundError } = require('./application');

function createServer(application = createApplication()) {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/') return sendFile(response, 'index.html', 'text/html; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/app.js') return sendFile(response, 'app.js', 'text/javascript; charset=utf-8');
      if (request.method === 'POST' && url.pathname === '/api/source-documents') {
        const upload = await readUpload(request);
        const sourceDocument = application.createSourceDocument(upload);
        const processingRun = application.startProcessing(sourceDocument.id);
        return sendJson(response, 202, { sourceDocument, processingRun });
      }
      const runMatch = /^\/api\/runs\/(run_\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && runMatch) return sendJson(response, 200, application.getRun(runMatch[1]));
      const reprocessMatch = /^\/api\/runs\/(run_\d+)\/reprocess$/.exec(url.pathname);
      if (request.method === 'POST' && reprocessMatch) return sendJson(response, 202, { processingRun: application.reprocess(reprocessMatch[1]) });
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = error instanceof InputError ? 422 : error instanceof NotFoundError ? 404 : 500;
      return sendJson(response, status, { error: error.message || 'Unexpected server error.' });
    }
  });
}

async function readUpload(request) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new InputError('Submit the DXF as multipart form data.');

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const parts = Buffer.concat(chunks).toString('utf8').split(`--${boundary}`);
  const drawing = parts.find((part) => /name="drawing"/.test(part));
  const filename = /filename="([^"]+)"/.exec(drawing || '')?.[1];
  const separator = drawing?.indexOf('\r\n\r\n');
  if (!drawing || !filename || separator === -1) throw new InputError('A DXF drawing field is required.');
  return { filename, content: drawing.slice(separator + 4).replace(/\r\n$/, '') };
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
