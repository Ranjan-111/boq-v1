(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./normalize'), require('./model-cache'), require('./tesseract'), require('./paddle'));
  else root.BoqOcrEngine = factory(root.BoqOcrNormalize, root.BoqOcrModelCache, root.BoqOcrTesseract, root.BoqOcrPaddle);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Normalize, CacheModule, TesseractModule, PaddleModule) {
  'use strict';

  const STATES = Object.freeze(['idle', 'checking-cache', 'downloading', 'ready', 'offline-cache-hit', 'offline-missing', 'running', 'completed', 'unsupported', 'evicted', 'aborted', 'failed']);
  const DEFAULT_LIMITS = Object.freeze({ maxCropPixels: 25 * 1000 * 1000, maxModelBytes: 50 * 1024 * 1024, maxRunMs: 30000, maxRegionMs: 15000 });

  function onlineDefault() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function errorWithCode(error, fallbackCode = 'failed') {
    const value = error instanceof Error ? error : new Error(String(error || 'OCR failed.'));
    if (typeof value.code === 'string' && value.code) return value;
    try {
      value.code = fallbackCode;
      if (value.code === fallbackCode) return value;
    } catch {}
    const wrapped = new Error(value.message, { cause: value });
    wrapped.name = value.name || 'Error';
    wrapped.code = fallbackCode;
    return wrapped;
  }
  function isAbort(error) { return error?.name === 'AbortError' || error?.code === 'aborted'; }

  class OcrController {
    constructor(options = {}) {
      if (!options.engine) throw new TypeError('An OCR engine adapter is required.');
      this.engine = options.engine;
      this.cache = options.cache || (CacheModule ? new CacheModule.ModelCache() : null);
      this.normalize = options.normalize || Normalize?.normalizeObservations;
      this.nativePrecedence = options.nativePrecedence || Normalize?.applyNativePrecedence;
      this.limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
      this.online = options.online || onlineDefault;
      this.listeners = new Set();
      this.state = 'idle';
      this.progress = { loaded: 0, total: 0, percent: 0 };
      this.error = null;
      this.prepared = false;
      this.preparePromise = null;
      this.prepareGeneration = 0;
      this.lifecycleGeneration = 0;
      this.disposePromise = null;
      this.abortController = null;
      this.recognizePromise = null;
    }

    subscribe(listener) { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
    snapshot() { return { state: this.state, progress: Object.assign({}, this.progress), error: this.error ? { message: this.error.message, code: this.error.code } : null, engine: this.engine.id, engineVersion: this.engine.engineVersion, modelVersion: this.engine.modelVersion, language: this.engine.language }; }
    _emit() { const snapshot = this.snapshot(); this.listeners.forEach((listener) => { try { listener(snapshot); } catch {} }); }
    _setState(state, error = null) { this.state = STATES.includes(state) ? state : 'failed'; this.error = error; this._emit(); }
    _progress(value = {}) { this.progress = { loaded: Number(value.loaded || 0), total: Number(value.total || 0), percent: Number(value.percent ?? (value.total ? value.loaded / value.total * 100 : 0)), message: value.message || '' }; this._emit(); }
    identity(extra = {}) { return Object.assign({ engine: this.engine.id, engineVersion: this.engine.engineVersion, modelVersion: this.engine.modelVersion, language: this.engine.language, assetHash: this.engine.assetHash || `${this.engine.id}-${this.engine.modelVersion}` }, extra); }

    _withDeadline(work, milliseconds, message) {
      const timeoutMs = Math.max(1, Number(milliseconds));
      let timer; let settled = false;
      return new Promise((resolve, reject) => {
        timer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          const error = Object.assign(new Error(message), { code: 'aborted' });
          let disposeTimer;
          await Promise.race([
            Promise.resolve(this.abort()).catch(() => {}).finally(() => clearTimeout(disposeTimer)),
            new Promise((done) => { disposeTimer = setTimeout(done, 1000); })
          ]);
          reject(error);
        }, timeoutMs);
        Promise.resolve(work).then((value) => {
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(error);
        });
      });
    }

    async prepare() {
      if (this.prepared) return this.snapshot();
      if (this.preparePromise) {
        const pending = this.preparePromise;
        if (this.prepareGeneration === this.lifecycleGeneration) return pending;
        if (this.preparePromise === pending) this.preparePromise = null;
      }
      const pending = this._prepare();
      const tracked = pending.finally(() => { if (this.preparePromise === tracked) this.preparePromise = null; });
      this.preparePromise = tracked;
      this.prepareGeneration = this.lifecycleGeneration;
      return tracked;
    }

    async _prepare() {
      this._setState('checking-cache');
      const identity = this.identity();
      const generation = this.lifecycleGeneration;
      const stale = () => generation !== this.lifecycleGeneration || this.abortController?.signal.aborted;
      let manifest;
      try {
        if (!this.cache) throw Object.assign(new Error('OCR cache storage is unavailable.'), { code: 'unsupported' });
        manifest = await this.cache.get(identity);
      } catch (error) {
        const value = errorWithCode(error, 'unsupported');
        if (!stale()) this._setState(value.code === 'evicted' ? 'evicted' : 'unsupported', value);
        throw value;
      }
      if (stale()) throw Object.assign(new Error('OCR preparation was aborted.'), { code: 'aborted' });
      const offline = !this.online();
      if (manifest?.status === 'ready') {
        try {
          await this.engine.prepare({ cacheHit: true, signal: this.abortController?.signal, onProgress: (value) => this._progress(value) });
          if (stale()) throw Object.assign(new Error('OCR preparation was aborted.'), { code: 'aborted' });
          this.prepared = true;
          this._setState(offline ? 'offline-cache-hit' : 'ready');
          return this.snapshot();
        } catch (error) {
          const value = errorWithCode(error, 'evicted');
          if (!stale() && value.code !== 'aborted' && value.code !== 'unsupported') await this.cache.markEvicted(identity).catch(() => {});
          if (generation === this.lifecycleGeneration) this._setState(value.code === 'aborted' ? 'aborted' : value.code === 'unsupported' ? 'unsupported' : 'evicted', value);
          throw value;
        }
      }
      if (manifest?.status === 'evicted') {
        this._setState('evicted', Object.assign(new Error('The cached OCR model was evicted; downloading a fresh copy.'), { code: 'evicted' }));
        if (offline) throw this.error;
      }
      if (offline) {
        const value = Object.assign(new Error('OCR unavailable offline: the exact model is not cached.'), { code: 'offline-missing' });
        this._setState('offline-missing', value);
        throw value;
      }
      this._setState('downloading');
      await this.cache.beginDownload(identity).catch((error) => { throw errorWithCode(error, 'unsupported'); });
      const progressWrites = [];
      let progressClosed = false;
      const onPrepareProgress = (value) => { if (progressClosed || stale()) return; this._progress(value); progressWrites.push(this.cache.updateProgress(identity, value)); };
      try {
        const result = await this.engine.prepare({ signal: this.abortController?.signal, forceRefresh: manifest?.status === 'evicted', maxModelBytes: this.limits.maxModelBytes, onProgress: onPrepareProgress });
        if (stale()) throw Object.assign(new Error('OCR preparation was aborted.'), { code: 'aborted' });
        if (Number(result?.totalBytes || 0) > this.limits.maxModelBytes) throw Object.assign(new Error('OCR model download exceeds the bounded model size limit.'), { code: 'limit' });
        const smoke = this.engine.smoke || this.engine.recognize;
        if (typeof smoke !== 'function') throw Object.assign(new Error('OCR adapter has no bounded smoke recognition.'), { code: 'unsupported' });
        await smoke.call(this.engine, { image: this.engine.smokeImage || { width: 1, height: 1 }, signal: this.abortController?.signal, onProgress: onPrepareProgress });
        progressClosed = true;
        await Promise.all(progressWrites);
        const metadata = Object.assign({}, result || {});
        delete metadata.asset;
        const preparedIdentity = Object.assign({}, identity, metadata, { assetHash: result?.assetHash || identity.assetHash });
        if (result && result.asset !== undefined) await this.cache.putAsset(preparedIdentity, result.asset);
        await this.cache.markReady(preparedIdentity, { totalBytes: Number(result?.totalBytes || 0), assetHash: preparedIdentity.assetHash });
        this.prepared = true;
        this._progress({ loaded: 100, total: 100, percent: 100, message: 'OCR model ready.' });
        this._setState('ready');
        return this.snapshot();
      } catch (error) {
        progressClosed = true;
        await Promise.allSettled(progressWrites);
        const value = errorWithCode(error, isAbort(error) ? 'aborted' : 'failed');
        if (!stale() && value.code !== 'aborted') await this.cache.markEvicted(identity).catch(() => {});
        if (generation === this.lifecycleGeneration) {
          if (value.code === 'unsupported') this._setState('unsupported', value);
          else if (value.code === 'aborted') this._setState('aborted', value);
          else this._setState('failed', value);
        }
        throw value;
      }
    }

    recognize(request = {}) {
      if (this.recognizePromise) return Promise.reject(Object.assign(new Error('OCR is already running; wait for the current crop to finish.'), { code: 'busy', retryable: true }));
      const promise = this._recognize(request);
      const tracked = promise.then((value) => { if (this.recognizePromise === tracked) this.recognizePromise = null; return value; }, (error) => { if (this.recognizePromise === tracked) this.recognizePromise = null; throw error; });
      this.recognizePromise = tracked;
      return tracked;
    }

    async _recognize(request = {}) {
      const crop = request.crop || request.image;
      const width = Number(request.cropWidth || crop?.width || request.image?.width || 0);
      const height = Number(request.cropHeight || crop?.height || request.image?.height || 0);
      if (width > 0 && height > 0 && width * height > this.limits.maxCropPixels) {
        const error = Object.assign(new Error('OCR crop exceeds the bounded pixel limit; select a smaller region.'), { code: 'limit' });
        this._setState('failed', error); throw error;
      }
      this.abortController = new AbortController();
      const startedAt = Date.now();
      const maximumRunMs = Math.min(Number(request.maxRunMs || this.limits.maxRunMs), this.limits.maxRunMs);
      const abortFromRequest = () => this.abort();
      if (request.signal) request.signal.addEventListener('abort', abortFromRequest, { once: true });
      try {
        await this._withDeadline(this.prepare(), maximumRunMs, 'OCR preparation exceeded the bounded run time.');
        const remainingMs = Math.max(0, maximumRunMs - (Date.now() - startedAt));
        if (!remainingMs) {
          await this.abort();
          throw Object.assign(new Error('OCR exceeded the bounded run time.'), { code: 'aborted' });
        }
        const regionMs = Math.min(Number(request.timeoutMs || this.limits.maxRegionMs), this.limits.maxRegionMs, remainingMs);
        this._setState('running');
        const raw = await this._withDeadline(this.engine.recognize({ ...request, image: crop, signal: this.abortController.signal, onProgress: (value) => this._progress(value) }), regionMs, 'OCR recognition exceeded the bounded region time.');
        if (this.abortController.signal.aborted) throw Object.assign(new Error('OCR was aborted.'), { code: 'aborted' });
        let observations = this.normalize ? this.normalize(raw, Object.assign({}, request.provenance || {}, {
          engine: this.engine.id, engineVersion: this.engine.engineVersion, modelVersion: this.engine.modelVersion, language: this.engine.language,
          crop: request.cropRect || request.provenance?.crop, cropPolygon: request.cropPolygon || request.provenance?.cropPolygon,
          pageTransform: request.pageTransform || request.provenance?.pageTransform, rotation: request.rotation || request.provenance?.rotation,
          pageWidth: request.pageWidth || request.provenance?.pageWidth, pageHeight: request.pageHeight || request.provenance?.pageHeight,
          limits: request.limits
        })) : raw;
        if (request.nativeText && this.nativePrecedence) observations = this.nativePrecedence(observations, request.nativeText, request.nativeOverlapThreshold);
        this._setState('completed');
        return observations;
      } catch (error) {
        const value = errorWithCode(error, isAbort(error) ? 'aborted' : 'failed');
        if (value.code === 'offline-missing') this._setState('offline-missing', value);
        else if (value.code === 'unsupported') this._setState('unsupported', value);
        else if (value.code === 'evicted') this._setState('evicted', value);
        else if (value.code === 'aborted' || isAbort(value)) this._setState('aborted', value);
        else if (this.state !== 'failed') this._setState('failed', value);
        throw value;
      } finally {
        if (request.signal) request.signal.removeEventListener('abort', abortFromRequest);
      }
    }

    abort() {
      this.lifecycleGeneration += 1;
      this.prepared = false;
      if (this.abortController && !this.abortController.signal.aborted) this.abortController.abort();
      try { this.disposePromise = Promise.resolve(this.engine.dispose?.()).catch(() => {}); } catch { this.disposePromise = Promise.resolve(); }
      return this.disposePromise;
    }
    async dispose() { await this.abort(); this.listeners.clear(); }
  }

  function createOcrController(options) { return new OcrController(options); }
  function selectEngine(options = {}) {
    if (options.engine) return options.engine;
    if (options.provider === 'paddleocr-js') return PaddleModule?.createPaddleAdapter(options);
    return TesseractModule?.createTesseractAdapter(options);
  }

  return { STATES, DEFAULT_LIMITS, OcrController, createOcrController, createController: createOcrController, selectEngine, errorWithCode };
}));
