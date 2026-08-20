(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoqOcrModelCache = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CACHE_VERSION = 'ocr-cache-v1';
  const DB_VERSION = 1;
  const DEFAULT_DB_NAME = 'boq-v1-ocr';

  class OcrCacheError extends Error {
    constructor(message, code = 'unsupported') {
      super(message);
      this.name = 'OcrCacheError';
      this.code = code;
      this.retryable = code !== 'unsupported';
    }
  }

  function keyFor(identity) {
    const value = identity || {};
    return [value.engine, value.engineVersion, value.modelVersion, value.language, value.assetHash]
      .map((part) => String(part == null ? '' : part)).join('|');
  }

  function hasIndexedDb(indexedDb) {
    return Boolean(indexedDb && typeof indexedDb.open === 'function');
  }

  class ModelCache {
    constructor(options = {}) {
      this.dbName = options.dbName || DEFAULT_DB_NAME;
      this.indexedDb = options.indexedDB === undefined
        ? (typeof indexedDB === 'undefined' ? null : indexedDB)
        : options.indexedDB;
      this.now = options.now || (() => new Date().toISOString());
      this.memory = options.memory || null;
      this.dbPromise = null;
      this.writeChain = Promise.resolve();
    }

    async open() {
      if (this.memory) return this.memory;
      if (!hasIndexedDb(this.indexedDb)) throw new OcrCacheError('OCR unavailable: this browser cannot provide IndexedDB storage.', 'unsupported');
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        let request;
        try { request = this.indexedDb.open(this.dbName, DB_VERSION); }
        catch (error) { reject(new OcrCacheError(error.message || 'OCR cache storage is unavailable.', 'unsupported')); return; }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('manifest')) db.createObjectStore('manifest', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new OcrCacheError('OCR cache storage is unavailable.', 'unsupported'));
        request.onblocked = () => reject(new OcrCacheError('OCR cache storage is blocked by another browser tab.', 'storage-failed'));
      });
      return this.dbPromise;
    }

    async _readStore(storeName, mode, operation) {
      const db = await this.open();
      if (this.memory) return operation(this.memory[storeName]);
      return new Promise((resolve, reject) => {
        let transaction;
        try { transaction = db.transaction(storeName, mode); }
        catch (error) { reject(new OcrCacheError(error.message || 'OCR cache transaction failed.', 'storage-failed')); return; }
        const store = transaction.objectStore(storeName);
        let result;
        try { result = operation(store); }
        catch (error) { reject(error); return; }
        let requestResult = result;
        let settled = false;
        const fail = (error) => { if (!settled) { settled = true; reject(error || new OcrCacheError('OCR cache transaction failed.', 'storage-failed')); } };
        if (result && typeof result.onsuccess !== 'undefined') {
          result.onsuccess = () => { requestResult = result.result; };
          result.onerror = () => fail(result.error);
        }
        transaction.oncomplete = () => { if (!settled) { settled = true; resolve(requestResult); } };
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error || new OcrCacheError('OCR cache transaction aborted.', 'storage-failed'));
      });
    }

    _enqueueWrite(task) {
      const next = this.writeChain.then(task, task);
      this.writeChain = next.catch(() => {});
      return next;
    }

    async _get(identity) {
      const key = keyFor(identity);
      if (this.memory) return this.memory.manifest.get(key) || null;
      const result = await this._readStore('manifest', 'readonly', (store) => store.get(key));
      return result || null;
    }

    async get(identity) {
      await this.writeChain;
      const entry = await this._get(identity);
      return entry && entry.cacheVersion !== CACHE_VERSION ? Object.assign({}, entry, { status: 'evicted' }) : entry;
    }

    async list() {
      await this.writeChain;
      if (this.memory) return [...this.memory.manifest.values()];
      return this._readStore('manifest', 'readonly', (store) => store.getAll());
    }

    async beginDownload(identity) {
      const entry = Object.assign({}, identity, {
        key: keyFor(identity), cacheVersion: CACHE_VERSION, status: 'downloading',
        downloadedBytes: 0, totalBytes: Number(identity.totalBytes || 0), updatedAt: this.now()
      });
      return this._enqueueWrite(async () => { if (this.memory) { this.memory.manifest.set(entry.key, entry); return entry; } await this._readStore('manifest', 'readwrite', (store) => store.put(entry)); return entry; });
    }

    async updateProgress(identity, progress = {}) {
      const key = keyFor(identity);
      return this._enqueueWrite(async () => { const existing = await this._get(identity) || Object.assign({}, identity, { key, cacheVersion: CACHE_VERSION }); const entry = Object.assign(existing, { status: 'downloading', downloadedBytes: Number(progress.loaded || 0), totalBytes: Number(progress.total || existing.totalBytes || 0), progress: Number(progress.percent || 0), updatedAt: this.now() }); if (this.memory) { this.memory.manifest.set(key, entry); return entry; } await this._readStore('manifest', 'readwrite', (store) => store.put(entry)); return entry; });
    }

    async markReady(identity, metadata = {}) {
      const key = keyFor(identity);
      return this._enqueueWrite(async () => { const existing = await this._get(identity) || Object.assign({}, identity, { key }); const entry = Object.assign(existing, metadata, { key, cacheVersion: CACHE_VERSION, status: 'ready', readyAt: this.now(), updatedAt: this.now() }); if (this.memory) { this.memory.manifest.set(key, entry); return entry; } await this._readStore('manifest', 'readwrite', (store) => store.put(entry)); return entry; });
    }

    async markEvicted(identity) {
      const key = keyFor(identity);
      return this._enqueueWrite(async () => { const existing = await this._get(identity) || Object.assign({}, identity, { key }); const entry = Object.assign(existing, { key, cacheVersion: CACHE_VERSION, status: 'evicted', updatedAt: this.now() }); if (this.memory) { this.memory.manifest.set(key, entry); return entry; } await this._readStore('manifest', 'readwrite', (store) => store.put(entry)); return entry; });
    }

    async remove(identity) {
      const key = keyFor(identity);
      return this._enqueueWrite(async () => { if (this.memory) { this.memory.manifest.delete(key); this.memory.assets.delete(key); return; } const db = await this.open(); await new Promise((resolve, reject) => { const transaction = db.transaction(['manifest', 'assets'], 'readwrite'); transaction.objectStore('manifest').delete(key); transaction.objectStore('assets').delete(key); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error || new OcrCacheError('OCR cache removal failed.', 'storage-failed')); transaction.onabort = () => reject(transaction.error || new OcrCacheError('OCR cache removal aborted.', 'storage-failed')); }); });
    }

    async putAsset(identity, asset) {
      const key = keyFor(identity);
      return this._enqueueWrite(async () => { if (this.memory) { this.memory.assets.set(key, asset); return; } await this._readStore('assets', 'readwrite', (store) => store.put({ key, asset })); });
    }

    async getAsset(identity) {
      await this.writeChain;
      const key = keyFor(identity);
      if (this.memory) return this.memory.assets.get(key) || null;
      const result = await this._readStore('assets', 'readonly', (store) => store.get(key));
      return result ? result.asset : null;
    }
  }

  function createMemoryCache(options = {}) {
    return new ModelCache(Object.assign({}, options, {
      memory: { manifest: new Map(), assets: new Map() }
    }));
  }

  return { CACHE_VERSION, DB_VERSION, DEFAULT_DB_NAME, OcrCacheError, ModelCache, createModelCache: (options) => new ModelCache(options), createMemoryCache, keyFor };
}));
