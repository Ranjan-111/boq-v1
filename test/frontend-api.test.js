const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const apiModule = import(pathToFileURL(join(__dirname, '..', 'public', 'js', 'api.mjs')).href);

function stubFetch(response) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/* The single most expensive habit in the previous frontend was reading a field
   off a response without asking whether the request had succeeded. An error
   body has no `boqVersion`, so the read threw, the handler died, and the
   server's reason was never shown. Centralising the check means the mistake
   has nowhere left to live -- these tests hold that line. */

test('a refusal becomes an ApiError carrying the server’s own words', async () => {
  const { api, ApiError } = await apiModule;
  const restore = stubFetch(jsonResponse(409, {
    error: 'Cannot approve while 1 blocking exception remain open.',
    code: 'workflow_conflict'
  }));
  try {
    await assert.rejects(
      () => api.post('/api/boq-versions/boqv_0001/approve', {}),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'workflow_conflict');
        assert.match(error.message, /1 blocking exception/);
        return true;
      }
    );
  } finally { restore(); }
});

test('a success returns the parsed body', async () => {
  const { api } = await apiModule;
  const restore = stubFetch(jsonResponse(201, { boqVersion: { id: 'boqv_0001', status: 'approved' } }));
  try {
    const body = await api.post('/api/boq-versions/boqv_0001/approve', {});
    assert.equal(body.boqVersion.status, 'approved');
  } finally { restore(); }
});

test('an unreachable server is reported as unreachable, not as a rejected drawing', async () => {
  const { api, ApiError } = await apiModule;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(() => api.get('/api/projects'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      assert.equal(error.code, 'network_unreachable');
      assert.equal(error.retryable, true);
      assert.match(error.message, /could not be reached/i);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test('a non-JSON error body still produces a readable message', async () => {
  const { api } = await apiModule;
  const restore = stubFetch({ ok: false, status: 500, text: async () => '<html>Internal Server Error</html>' });
  try {
    await assert.rejects(() => api.get('/api/projects'), /Internal Server Error/);
  } finally { restore(); }
});

test('an empty success body is an empty object, not a crash', async () => {
  const { api } = await apiModule;
  const restore = stubFetch({ ok: true, status: 204, text: async () => '' });
  try {
    assert.deepEqual(await api.get('/api/projects'), {});
  } finally { restore(); }
});
