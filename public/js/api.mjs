/* ═══════════════════════════════════════════════════════════════════════════
   API client — the ONLY place in the frontend that calls fetch.

   Every previous approval bug had the same shape: a caller read a field off a
   response body without asking whether the request had succeeded. An error
   body has no `boqVersion`, so the read threw, the handler died mid-way, and
   the reason the server gave was never shown. Centralising the ok-check means
   that mistake has nowhere left to live.
   ═══════════════════════════════════════════════════════════════════════════ */

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status}).`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code || 'request_error';
    this.stage = body?.stage || null;
    this.retryable = body?.retryable ?? false;
    this.body = body || {};
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (cause) {
    /* A network failure is not a 4xx; it deserves its own wording so the
       operator is not told their drawing was rejected when the server is
       simply unreachable. */
    throw new ApiError(0, { error: 'The server could not be reached. Check that it is running, then try again.', code: 'network_unreachable', retryable: true });
  }
  const text = await response.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 400) }; } }
  if (!response.ok) throw new ApiError(response.status, body);
  return body ?? {};
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  }),
  patch: (path, body) => request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload: (path, formData) => request(path, { method: 'POST', body: formData }),

  /* Downloads bypass JSON parsing but must still fail loudly. */
  async download(path, filename) {
    const response = await fetch(path);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let body = null;
      try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 400) }; }
      throw new ApiError(response.status, body);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
};
