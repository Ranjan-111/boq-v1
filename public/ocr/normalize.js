(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoqOcrNormalize = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NORMALIZATION_VERSION = 'ocr-normalization-v1';
  const DEFAULT_LIMITS = Object.freeze({ maxBoxes: 5000, maxChars: 100000, maxPolygonPoints: 8 });

  function finite(value) { return Number.isFinite(Number(value)); }
  function point(value) { return value && finite(value.x) && finite(value.y) ? { x: Number(value.x), y: Number(value.y) } : null; }
  function polygonOf(value) {
    if (!Array.isArray(value)) return null;
    const points = value.map((item) => Array.isArray(item) ? { x: Number(item[0]), y: Number(item[1]) } : point(item));
    return points.length ? points : null;
  }
  function bboxPolygon(value) {
    if (!value || !finite(value.x0 ?? value.left ?? value.x) || !finite(value.y0 ?? value.top ?? value.y)) return null;
    const x0 = Number(value.x0 ?? value.left ?? value.x);
    const y0 = Number(value.y0 ?? value.top ?? value.y);
    const x1 = Number(value.x1 ?? value.right ?? (x0 + Number(value.width || 0)));
    const y1 = Number(value.y1 ?? value.bottom ?? (y0 + Number(value.height || 0)));
    return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  }
  function normalizeText(text) { return String(text == null ? '' : text).normalize('NFKC').replace(/\s+/gu, ' ').trim(); }
  function matrixApply(matrix, p) {
    if (!matrix) return p;
    const m = Array.isArray(matrix) ? matrix : [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    if (m.length < 6 || m.some((value) => !finite(value))) return p;
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
  }
  function rotatePoint(p, width, height, rotation) {
    const degrees = ((Number(rotation || 0) % 360) + 360) % 360;
    if (degrees === 90) return { x: height - p.y, y: p.x };
    if (degrees === 180) return { x: width - p.x, y: height - p.y };
    if (degrees === 270) return { x: p.y, y: width - p.x };
    return p;
  }
  function unrotatePoint(p, width, height, rotation) {
    const degrees = ((Number(rotation || 0) % 360) + 360) % 360;
    if (degrees === 90) return { x: p.y, y: height - p.x };
    if (degrees === 180) return { x: width - p.x, y: height - p.y };
    if (degrees === 270) return { x: width - p.y, y: p.x };
    return p;
  }
  function asPoint(value) { return Array.isArray(value) ? { x: Number(value[0]), y: Number(value[1]) } : value; }
  function boundsOf(polygon) {
    return polygon.reduce((box, value) => { const p = asPoint(value); return ({ minX: Math.min(box.minX, p.x), minY: Math.min(box.minY, p.y), maxX: Math.max(box.maxX, p.x), maxY: Math.max(box.maxY, p.y) }); }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }
  function area(polygon) {
    return Math.abs(polygon.reduce((total, value, index) => { const p = asPoint(value); const next = asPoint(polygon[(index + 1) % polygon.length]); return total + p.x * next.y - next.x * p.y; }, 0)) / 2;
  }
  function iou(a, b) {
    const aa = boundsOf(a); const bb = boundsOf(b);
    const w = Math.max(0, Math.min(aa.maxX, bb.maxX) - Math.max(aa.minX, bb.minX));
    const h = Math.max(0, Math.min(aa.maxY, bb.maxY) - Math.max(aa.minY, bb.minY));
    const intersection = w * h; const union = area(a) + area(b) - intersection;
    return union > 0 ? intersection / union : 0;
  }
  function hash(value) {
    const text = JSON.stringify(value);
    let h = 2166136261;
    for (let index = 0; index < text.length; index += 1) { h ^= text.charCodeAt(index); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function dimensionEvidence(text) {
    const evidence = [];
    const pattern = /((?:\d+(?:[.,]\d+)?|\.\d+)\s*(?:mm|cm|m|in|ft|'))/giu;
    let match;
    while ((match = pattern.exec(text)) && evidence.length < 8) {
      const raw = match[1].replace(/\s+/g, ' ').trim();
      const number = Number(raw.replace(',', '.').match(/[\d.]+/)?.[0]);
      const unit = raw.match(/mm|cm|m|in|ft|'$/iu)?.[0]?.toLowerCase() || null;
      if (finite(number) && unit) evidence.push({ kind: 'dimension', raw, value: number, unit, state: 'needs_review', parserVersion: 'dimension-parser-v1' });
    }
    return evidence;
  }
  function rawItems(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.observations)) return result.observations;
    if (Array.isArray(result?.lines)) return result.lines;
    if (Array.isArray(result?.data?.words)) return result.data.words;
    if (Array.isArray(result?.data?.lines)) return result.data.lines;
    return [];
  }
  function localPolygon(item) {
    return polygonOf(item.poly || item.polygon || item.points || item.box || item.bbox) || bboxPolygon(item);
  }
  function mapPolygon(polygon, options) {
    const crop = options.crop || options.cropRect || { x: 0, y: 0, width: options.cropWidth || options.imageWidth || 0, height: options.cropHeight || options.imageHeight || 0 };
    const cropWidth = Number(crop.width || options.cropWidth || options.imageWidth || 0);
    const cropHeight = Number(crop.height || options.cropHeight || options.imageHeight || 0);
    const pageWidth = Number(options.pageWidth || options.width || 0);
    const pageHeight = Number(options.pageHeight || options.height || 0);
    const cropOrigin = { x: Number(crop.x || 0), y: Number(crop.y || 0) };
    const mapped = polygon.map((p) => {
      // OCR sees a physically rotated crop. Map its output back into the
      // unrotated crop before adding the image-space page origin.
      const local = unrotatePoint(p, cropWidth, cropHeight, options.rotation || 0);
      let result = { x: local.x + cropOrigin.x, y: local.y + cropOrigin.y };
      if (Array.isArray(options.cropPolygon) && options.cropPolygon.length >= 4 && cropWidth > 0 && cropHeight > 0) {
        const cp = options.cropPolygon.map(asPoint);
        const u = local.x / cropWidth; const v = local.y / cropHeight;
        result = { x: (1 - u) * (1 - v) * cp[0].x + u * (1 - v) * cp[1].x + u * v * cp[2].x + (1 - u) * v * cp[3].x, y: (1 - u) * (1 - v) * cp[0].y + u * (1 - v) * cp[1].y + u * v * cp[2].y + (1 - u) * v * cp[3].y };
      }
      // Raster and image-only PDF previews already use canonical image-space
      // coordinates. A PDF source transform is provenance, not another map.
      return options.applyPageTransform === true ? matrixApply(options.pageTransform || options.transform, result) : result;
    });
    const bounds = boundsOf(mapped);
    const within = pageWidth > 0 && pageHeight > 0 && bounds.minX >= 0 && bounds.minY >= 0 && bounds.maxX <= pageWidth && bounds.maxY <= pageHeight;
    return { mapped, within };
  }

  function normalizeObservations(result, options = {}) {
    const limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
    const source = Object.assign({}, options);
    const items = rawItems(result);
    const observations = [];
    let chars = 0;
    for (let index = 0; index < items.length && observations.length < limits.maxBoxes; index += 1) {
      const item = items[index] || {};
      const text = normalizeText(item.text ?? item.label);
      const polygon = localPolygon(item);
      const base = { sourceIndex: index, text, engine: options.engine || 'unknown', modelVersion: options.modelVersion || 'unknown' };
      if (!text || !polygon || polygon.length < 3 || polygon.length > limits.maxPolygonPoints || polygon.some((p) => !finite(p.x) || !finite(p.y))) {
        observations.push(Object.assign(base, { id: `ocr_${hash(base)}`, textPolygon: polygon || [], confidence: { score: 0, engineField: item.score == null ? 'score' : 'score' }, status: 'rejected', rejectionReason: 'Malformed OCR polygon or empty text.' }));
        continue;
      }
      chars += text.length;
      const mapped = mapPolygon(polygon, source);
      const score = Math.max(0, Math.min(1, Number(item.score ?? item.confidence ?? 0)));
      const observation = Object.assign(base, {
        textPolygon: mapped.mapped.map((p) => [Number(p.x.toFixed(6)), Number(p.y.toFixed(6))]),
        confidence: { score: Number(score.toFixed(6)), engineField: item.score == null ? 'confidence' : 'score' },
        engine: options.engine || 'unknown', engineVersion: options.engineVersion || 'unknown', modelVersion: options.modelVersion || 'unknown',
        language: options.language || 'eng', normalizationVersion: NORMALIZATION_VERSION, rotation: Number(options.rotation || 0),
        pageTransform: options.pageTransform || options.transform || null, status: mapped.within ? 'observed' : 'rejected',
        rejectionReason: mapped.within ? null : 'OCR polygon is outside the selected page bounds.',
        semanticEvidence: dimensionEvidence(text)
      });
      observation.id = `ocr_${hash({ ...observation, id: undefined })}`;
      observations.push(observation);
    }
    if (items.length > limits.maxBoxes) observations.push({ id: `ocr_${hash('box-limit')}`, text: '', textPolygon: [], confidence: { score: 0, engineField: 'score' }, status: 'rejected', rejectionReason: 'OCR result exceeds the text-box limit.' });
    if (chars > limits.maxChars) return observations.map((observation) => Object.assign({}, observation, { status: 'rejected', rejectionReason: 'OCR result exceeds the text-character limit.' }));
    const deduped = [];
    for (const observation of observations) {
      if (observation.status !== 'observed') { deduped.push(observation); continue; }
      const duplicate = deduped.find((candidate) => candidate.status === 'observed' && candidate.text === observation.text && iou(candidate.textPolygon, observation.textPolygon) >= Number(options.dedupeIou ?? .8));
      if (!duplicate) deduped.push(observation);
      else if (observation.confidence.score > duplicate.confidence.score) Object.assign(duplicate, observation);
    }
    return deduped.map((observation, index) => Object.assign(observation, {
      sourceDocumentId: options.sourceDocumentId || null, sourceDocumentVersion: options.sourceDocumentVersion ?? null,
      processingRunId: options.processingRunId || options.runId || null, pageId: options.pageId || options.sourcePageId || null,
      regionId: options.regionId || null, coordinateSpace: options.coordinateSpace || 'image', cropPolygon: options.cropPolygon || null,
      index
    }));
  }

  function normalizedText(value) { return normalizeText(value).toLocaleLowerCase(); }
  function applyNativePrecedence(observations, nativeText = [], threshold = .5) {
    const native = Array.isArray(nativeText) ? nativeText : [];
    return observations.map((observation) => {
      if (observation.status !== 'observed') return observation;
      const match = native.find((item) => {
        const polygon = polygonOf(item.textPolygon || item.polygon || item.box) || bboxPolygon(item);
        return polygon && (iou(polygon, observation.textPolygon) >= threshold || (normalizedText(item.text) === normalizedText(observation.text) && boundsOf(polygon).minX <= boundsOf(observation.textPolygon).minX && boundsOf(polygon).maxX >= boundsOf(observation.textPolygon).maxX));
      });
      if (!match) return observation;
      return Object.assign({}, observation, { status: normalizedText(match.text) === normalizedText(observation.text) ? 'suppressed_by_native' : 'conflict', nativeMatchId: match.id || null });
    });
  }

  return { NORMALIZATION_VERSION, DEFAULT_LIMITS, normalizeText, normalizeObservations, normalizeOcrResult: normalizeObservations, normalize: normalizeObservations, applyNativePrecedence, dimensionEvidence, matrixApply, rotatePoint, unrotatePoint, iou };
}));
