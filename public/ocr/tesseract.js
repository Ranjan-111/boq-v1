(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoqOcrTesseract = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class TesseractUnsupportedError extends Error {
    constructor(message) { super(message); this.name = 'TesseractUnsupportedError'; this.code = 'unsupported'; this.retryable = false; }
  }

  function createTesseractAdapter(options = {}) {
    const language = options.language || 'eng';
    const runtime = options.runtime || (typeof globalThis !== 'undefined' ? globalThis.Tesseract : null);
    const factory = options.createWorker || runtime?.createWorker?.bind(runtime);
    let worker = options.worker || null;
    let workerReady = Boolean(options.worker);
    let progressSink = null;
    let disposePromise = null;
    function report(event, fallbackMessage) {
      const progress = Number(event?.progress);
      progressSink?.({ loaded: Number.isFinite(progress) ? progress * 100 : 0, total: 100, percent: Number.isFinite(progress) ? progress * 100 : 0, message: event?.status || fallbackMessage });
    }
    function workerOptions(cacheHit) {
      const output = {
        logger: (event) => report(event, 'Preparing OCR model…'),
        cacheMethod: cacheHit ? 'readOnly' : 'refresh',
        cachePath: `${String(options.cachePath || 'boq-v1-ocr-cache').replace(/\/$/, '')}/${['tesseract-js', options.engineVersion || runtime?.version || 'unknown', options.modelVersion || `tessdata-${language}`, language, options.assetHash || `tessdata-${language}`].map((part) => String(part).replace(/[^a-zA-Z0-9._-]/g, '_')).join('__')}`
      };
      for (const name of ['workerPath', 'corePath', 'langPath', 'gzip', 'workerBlobURL']) if (options[name] !== undefined) output[name] = options[name];
      return output;
    }
    function modelUrl() {
      if (options.modelUrl) return new URL(options.modelUrl, typeof location === 'undefined' ? 'http://localhost/' : location.href).href;
      if (!options.langPath) return null;
      const base = new URL(options.langPath, typeof location === 'undefined' ? 'http://localhost/' : location.href);
      if (/\.(?:gz|traineddata)$/iu.test(base.pathname)) return base.href;
      return new URL(`${language}.traineddata${options.gzip === false ? '' : '.gz'}`, base.href.endsWith('/') ? base.href : `${base.href}/`).href;
    }
    async function sha256(bytes) {
      if (typeof crypto === 'undefined' || !crypto.subtle) throw Object.assign(new Error('OCR model hash verification is unsupported in this browser.'), { code: 'unsupported' });
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    async function readInternalCache(key) {
      if (typeof indexedDB === 'undefined') throw Object.assign(new Error('OCR model cache verification is unsupported in this browser.'), { code: 'unsupported' });
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onerror = () => reject(Object.assign(new Error('OCR model cache could not be opened.'), { code: 'evicted' }));
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('keyval')) { db.close(); resolve(null); return; }
          const transaction = db.transaction('keyval', 'readonly');
          const get = transaction.objectStore('keyval').get(key);
          get.onsuccess = () => { const value = get.result; db.close(); resolve(value == null ? null : value); };
          get.onerror = () => { db.close(); reject(Object.assign(new Error('OCR model cache could not be read.'), { code: 'evicted' })); };
        };
      });
    }
    async function verifyInternalCache({ signal } = {}) {
      const expected = String(options.cachedAssetHash || '');
      if (!/^[a-f0-9]{64}$/iu.test(expected)) return { verified: false };
      const key = `${workerOptions(true).cachePath}/${language}.traineddata`;
      const cached = await readInternalCache(key);
      if (signal?.aborted) throw Object.assign(new Error('OCR cache verification was aborted.'), { code: 'aborted' });
      const bytes = cached instanceof Uint8Array ? cached : cached instanceof ArrayBuffer ? new Uint8Array(cached) : ArrayBuffer.isView(cached) ? new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength) : null;
      if (!bytes || (await sha256(bytes)).toLowerCase() !== expected.toLowerCase()) throw Object.assign(new Error('The exact OCR model cache is missing or failed integrity verification.'), { code: 'evicted' });
      return { verified: true, totalBytes: bytes.byteLength };
    }
    async function verifyModelAsset({ signal, onProgress, maxModelBytes = options.maxModelBytes || 50 * 1024 * 1024 } = {}) {
      const expected = String(options.assetHash || '');
      const url = modelUrl();
      if (!url || !/^[a-f0-9]{64}$/iu.test(expected)) return { verified: false, totalBytes: options.totalBytes || 0 };
      if (typeof fetch !== 'function' || typeof crypto === 'undefined' || !crypto.subtle) throw Object.assign(new Error('OCR model hash verification is unsupported in this browser.'), { code: 'unsupported' });
      if (typeof location !== 'undefined' && new URL(url, location.href).origin !== location.origin) throw Object.assign(new Error('OCR model URL must be same-origin for verification.'), { code: 'unsupported' });
      const response = await fetch(url, { cache: 'reload', signal });
      if (!response.ok) throw Object.assign(new Error(`OCR model download failed (${response.status}).`), { code: 'failed' });
      const total = Number(response.headers.get('content-length')) || Number(options.totalBytes || 0);
      const chunks = []; let loaded = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) { const part = await reader.read(); if (part.done) break; loaded += part.value.byteLength; if (loaded > maxModelBytes) throw Object.assign(new Error('OCR model exceeds the bounded download size.'), { code: 'limit' }); chunks.push(part.value); onProgress?.({ loaded, total, percent: total ? loaded / total * 100 : 0, message: 'Verifying OCR model…' }); }
      } else { const bytes = new Uint8Array(await response.arrayBuffer()); loaded = bytes.byteLength; if (loaded > maxModelBytes) throw Object.assign(new Error('OCR model exceeds the bounded download size.'), { code: 'limit' }); chunks.push(bytes); onProgress?.({ loaded, total, percent: total ? loaded / total * 100 : 0, message: 'Verifying OCR model…' }); }
      const bytes = new Uint8Array(loaded); let offset = 0; chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
      const digest = await sha256(bytes);
      if (digest.toLowerCase() !== expected.toLowerCase()) throw Object.assign(new Error('OCR model hash verification failed.'), { code: 'failed' });
      return { verified: true, totalBytes: loaded };
    }
    function smokeImage() {
      if (options.smokeImage) return options.smokeImage;
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(1, 1);
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
        return canvas;
      }
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
        return canvas;
      }
      return new Uint8Array([0]);
    }
    function bboxOf(value) {
      if (!value) return null;
      if (Array.isArray(value) && value.length >= 4) {
        const [x, y, third, fourth] = value.map(Number);
        if (![x, y, third, fourth].every(Number.isFinite)) return null;
        return { x0: x, y0: y, x1: third > x ? third : x + third, y1: fourth > y ? fourth : y + fourth };
      }
      const x0 = Number(value.x0 ?? value.left ?? value.x); const y0 = Number(value.y0 ?? value.top ?? value.y);
      const x1 = Number(value.x1 ?? value.right ?? (x0 + Number(value.width || 0))); const y1 = Number(value.y1 ?? value.bottom ?? (y0 + Number(value.height || 0)));
      return [x0, y0, x1, y1].every(Number.isFinite) ? { x0, y0, x1, y1 } : null;
    }
    function collectWords(value, output = []) {
      if (!value || typeof value !== 'object') return output;
      if (Array.isArray(value)) { value.forEach((item) => collectWords(item, output)); return output; }
      if (Array.isArray(value.words)) { value.words.forEach((word) => { if (word && typeof word === 'object') output.push(word); }); }
      for (const key of ['blocks', 'paragraphs', 'lines']) if (Array.isArray(value[key])) value[key].forEach((item) => collectWords(item, output));
      return output;
    }
    function parseTsv(tsv) {
      const rows = String(tsv || '').split(/\r?\n/).filter(Boolean); if (rows.length < 2) return [];
      const headers = rows[0].split('\t'); const column = (name) => headers.indexOf(name);
      const indexes = { left: column('left'), top: column('top'), width: column('width'), height: column('height'), confidence: column('conf'), text: column('text') };
      return rows.slice(1).map((row) => row.split('\t')).filter((cells) => cells.length > 1 && (indexes.text < 0 || cells[indexes.text]?.trim())).map((cells) => ({ text: indexes.text < 0 ? cells.at(-1) : cells[indexes.text], confidence: indexes.conf < 0 ? 0 : Number(cells[indexes.conf]), bbox: { x: Number(cells[indexes.left]), y: Number(cells[indexes.top]), width: Number(cells[indexes.width]), height: Number(cells[indexes.height]) } }));
    }
    function resultWords(data) {
      const words = Array.isArray(data?.words) ? data.words : collectWords(data?.blocks || data?.paragraphs || data?.lines);
      return words.length ? words : parseTsv(data?.tsv);
    }
    const engine = {
      id: 'tesseract-js',
      engineVersion: options.engineVersion || runtime?.version || 'benchmark-pending',
      modelVersion: options.modelVersion || `tessdata-${language}-benchmark-pending`,
      language,
      assetHash: options.assetHash || `tessdata-${language}`,
      async prepare({ signal, onProgress, cacheHit = false, forceRefresh = false, maxModelBytes } = {}) {
        if (signal?.aborted) throw Object.assign(new Error('OCR preparation was aborted.'), { code: 'aborted' });
        if (!factory && !worker) throw new TesseractUnsupportedError('Tesseract.js is not bundled in this build. OCR remains available through an injected local adapter or a separately benchmarked asset.');
        progressSink = onProgress || progressSink;
        let verified = { verified: false, totalBytes: options.totalBytes || 0 };
        if (cacheHit) verified = await verifyInternalCache({ signal });
        else { options.forceRefresh = forceRefresh; verified = await verifyModelAsset({ signal, onProgress, maxModelBytes }); }
        if (!worker) { worker = await factory(language, options.oem, workerOptions(cacheHit)); workerReady = true; }
        if (signal?.aborted) { await engine.dispose(); throw Object.assign(new Error('OCR preparation was aborted.'), { code: 'aborted' }); }
        if (!workerReady && options.manualLifecycle) {
          if (typeof worker.load === 'function') await worker.load();
          if (typeof worker.loadLanguage === 'function') await worker.loadLanguage(language);
          if (typeof worker.initialize === 'function') await worker.initialize(language, options.oem);
          workerReady = true;
        }
        report({ progress: 1 }, 'OCR model ready.');
        onProgress?.({ loaded: 100, total: 100, percent: 100, message: 'OCR model ready.' });
        return { assetHash: engine.assetHash, totalBytes: verified.totalBytes || options.totalBytes || 0, assetVerified: verified.verified };
      },
      async smoke({ signal, onProgress } = {}) {
        if (!worker || typeof worker.recognize !== 'function') throw new TesseractUnsupportedError('Tesseract.js worker is not initialized.');
        progressSink = onProgress || progressSink;
        await worker.recognize(smokeImage(), { rotateAuto: false });
        if (signal?.aborted) throw Object.assign(new Error('OCR smoke recognition was aborted.'), { code: 'aborted' });
        return { ok: true };
      },
      async recognize({ image, signal, onProgress } = {}) {
        if (signal?.aborted) throw Object.assign(new Error('OCR was aborted.'), { code: 'aborted' });
        if (!worker || typeof worker.recognize !== 'function') throw new TesseractUnsupportedError('Tesseract.js worker is not initialized.');
        progressSink = onProgress || progressSink;
        const result = await worker.recognize(image, { rotateAuto: false }, { text: true, blocks: true, tsv: true });
        if (signal?.aborted) throw Object.assign(new Error('OCR was aborted.'), { code: 'aborted' });
        const words = resultWords(result?.data || result);
        return { observations: words.map((word) => {
          const box = bboxOf(word.bbox || word.box || word);
          const confidence = Number(word.confidence ?? word.score ?? 0);
          const score = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)) : 0;
          return { text: word.text || '', score, bbox: box || undefined };
        }).filter((word) => word.text && word.bbox) };
      },
      async dispose() {
        if (disposePromise) return disposePromise;
        disposePromise = (async () => { if (worker && typeof worker.terminate === 'function') await worker.terminate(); worker = null; workerReady = false; progressSink = null; })().finally(() => { disposePromise = null; });
        return disposePromise;
      }
    };
    return engine;
  }

  return { TesseractUnsupportedError, createTesseractAdapter, createAdapter: createTesseractAdapter };
}));
