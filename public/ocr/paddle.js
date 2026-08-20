(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoqOcrPaddle = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class PaddleBenchmarkPendingError extends Error {
    constructor(message) { super(message); this.name = 'PaddleBenchmarkPendingError'; this.code = 'unsupported'; this.retryable = false; }
  }

  // This adapter deliberately does not claim that PaddleOCR.js is production-ready.
  // A benchmarked runtime can be injected by the application or a test harness.
  function createPaddleAdapter(options = {}) {
    const language = options.language || 'en';
    const runtime = options.runtime || null;
    const engine = {
      id: 'paddleocr-js', engineVersion: options.engineVersion || 'benchmark-pending',
      modelVersion: options.modelVersion || 'paddle-model-benchmark-pending', language,
      assetHash: options.assetHash || `paddle-${language}`,
      async prepare(context = {}) {
        if (!runtime || typeof runtime.prepare !== 'function') throw new PaddleBenchmarkPendingError('PaddleOCR.js is a benchmark candidate only; no approved local runtime is bundled.');
        const result = await runtime.prepare(context);
        context.onProgress?.({ loaded: 100, total: 100, percent: 100, message: 'OCR model ready.' });
        return Object.assign({ assetHash: engine.assetHash }, result || {});
      },
      async recognize(context = {}) {
        if (!runtime || typeof runtime.recognize !== 'function') throw new PaddleBenchmarkPendingError('PaddleOCR.js local runtime is unavailable.');
        return runtime.recognize(context);
      },
      async dispose() { if (typeof runtime?.dispose === 'function') await runtime.dispose(); }
    };
    return engine;
  }

  return { PaddleBenchmarkPendingError, createPaddleAdapter, createAdapter: createPaddleAdapter };
}));
