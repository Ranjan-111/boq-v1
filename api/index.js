/* Vercel serverless entry point.
 *
 * Vercel requires a function's default export to be a request handler or an
 * http.Server. `src/server.js` exports `{ createServer }` -- an object -- which
 * is why every request failed with "Invalid export found in module ... The
 * default export must be a function or server."
 *
 * This wraps the existing server without changing it: createServer returns an
 * http.Server, and emitting its 'request' event invokes exactly the same
 * handler the local `npm start` uses. One code path, not a serverless fork.
 */

const { createServer } = require('../src/server');
const { createApplication } = require('../src/application');

/* Module scope, so a warm instance reuses one application across requests
   rather than starting an empty one each time. */
let server = null;

function handler(request, response) {
  if (!server) {
    server = createServer(createApplication({
      /* Synchronous stage advancement. The default schedules the next stage on
         a timer, but a serverless function is frozen once it has responded, so
         those timers may never fire and a run would sit in `ingestion` for
         ever. Running the stages inline means an upload returns a completed
         run. This is the same scheduler the multi-storey tests use. */
      schedule: (callback) => callback()
    }));
  }
  server.emit('request', request, response);
}

module.exports = handler;
module.exports.default = handler;
