const { digest } = require('./classification');
const { LIMITS, LimitError } = require('./ingestion/limits');

// This module deliberately has no dependency on the application store.  It is
// a pure boundary for browser-produced text evidence; the application supplies
// the run/page snapshot used for ownership checks.
const OCR_LIMITS = Object.freeze({
  maxObservations: LIMITS.ocrObservations,
  maxRunObservations: LIMITS.ocrRunObservations,
  maxTextLength: LIMITS.ocrTextLength,
  maxTotalTextChars: LIMITS.ocrTotalTextChars,
  maxPolygonPoints: LIMITS.ocrPolygonPoints,
  maxMetadataLength: 160,
  maxSemanticEvidence: LIMITS.ocrSemanticEvidence,
  overlapThreshold: 0.5,
  normalizationVersion: 'ocr-normalization-v1'
});

const FORBIDDEN_KEYS = new Set([
  'quantity', 'rate', 'rates', 'geometry', 'sourcegeometry', 'geometrysource',
  'sourcehandles', 'measurement', 'measurements', 'area', 'length', 'volume',
  'calibration', 'pixelspermetre', 'drawingunitspermetre', 'scale', 'regions',
  'regiongeometry', 'points', 'coordinates', 'width', 'height', 'boq', 'price',
  'unitprice', 'cost'
]);

class OcrResultError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OcrResultError';
    this.code = details.code || 'invalid_ocr_result';
    this.stage = details.stage || 'ocr';
    this.retryable = details.retryable ?? false;
    Object.assign(this, details);
  }
}

function assertObject(value, message = 'OCR result must be a JSON object.') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OcrResultError(message);
}

function stringValue(value, field, { required = true, max = OCR_LIMITS.maxMetadataLength } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new OcrResultError(`OCR ${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) throw new OcrResultError(`OCR ${field} must be a non-empty string.`);
  const result = value.normalize('NFKC').trim();
  if (result.length > max) throw new LimitError(`OCR ${field} exceeds ${max} characters.`, { limitName: `ocr${field[0].toUpperCase()}${field.slice(1)}Length`, observed: result.length, maximum: max, stage: 'ocr' });
  return result;
}

function finiteNumber(value, field) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new OcrResultError(`OCR ${field} must be finite.`);
  return number;
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function walkForbidden(value, path = 'result') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) walkForbidden(value[index], `${path}[${index}]`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[ _-]/g, ''))) throw new OcrResultError(`OCR result contains forbidden field ${path}.${key}; OCR cannot create geometry, quantities, rates, or calibration.`);
    walkForbidden(child, `${path}.${key}`);
  }
}

function polygonFromValue(value) {
  const candidate = value?.textPolygon ?? value?.polygon ?? value?.poly ?? value?.box;
  if (!Array.isArray(candidate)) throw new OcrResultError('OCR observation requires textPolygon.');
  let points = candidate;
  if (candidate.length === 4 && candidate.every((item) => typeof item === 'number' || typeof item === 'string')) {
    const [x, y, width, height] = candidate.map((item) => finiteNumber(item, 'textPolygon'));
    points = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }
  if (points.length < 3) throw new OcrResultError('OCR textPolygon requires at least three points.');
  if (points.length > OCR_LIMITS.maxPolygonPoints) throw new LimitError(`OCR textPolygon may contain at most ${OCR_LIMITS.maxPolygonPoints} points.`, { limitName: 'ocrPolygonPoints', observed: points.length, maximum: OCR_LIMITS.maxPolygonPoints, stage: 'ocr' });
  const normalized = points.map((point) => {
    if (!Array.isArray(point) || point.length < 2) throw new OcrResultError('OCR textPolygon points must be [x, y] pairs.');
    return [finiteNumber(point[0], 'textPolygon.x'), finiteNumber(point[1], 'textPolygon.y')];
  });
  const area = polygonArea(normalized);
  if (!Number.isFinite(area) || area <= 0) throw new OcrResultError('OCR textPolygon must enclose a positive area.');
  return normalized;
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

function bounds(points) {
  return points.reduce((box, [x, y]) => ({ minX: Math.min(box.minX, x), minY: Math.min(box.minY, y), maxX: Math.max(box.maxX, x), maxY: Math.max(box.maxY, y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function pageBounds(page) {
  if (page.coordinateSpace === 'image') {
    const pixelWidth = Number(page.pixelWidth || page.width); const pixelHeight = Number(page.pixelHeight || page.height);
    return Number.isFinite(pixelWidth) && Number.isFinite(pixelHeight) && pixelWidth > 0 && pixelHeight > 0
      ? { minX: 0, minY: 0, maxX: pixelWidth, maxY: pixelHeight }
      : null;
  }
  const width = Number(page.width || page.pixelWidth); const height = Number(page.height || page.pixelHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const transform = page.transform || page.sourceTransform;
  if (!Array.isArray(transform) || transform.length < 6 || transform.some((item) => !Number.isFinite(Number(item)))) return { minX: 0, minY: 0, maxX: width, maxY: height };
  const matrix = transform.map(Number);
  const points = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
  return points.reduce((box, [x, y]) => ({ minX: Math.min(box.minX, x), minY: Math.min(box.minY, y), maxX: Math.max(box.maxX, x), maxY: Math.max(box.maxY, y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function boxesOverlap(a, b) {
  const left = Math.max(a.minX, b.minX); const top = Math.max(a.minY, b.minY);
  const right = Math.min(a.maxX, b.maxX); const bottom = Math.min(a.maxY, b.maxY);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = (a.maxX - a.minX) * (a.maxY - a.minY) + (b.maxX - b.minX) * (b.maxY - b.minY) - intersection;
  return union > 0 ? intersection / union : 0;
}

function centroid(box) { return [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2]; }
function contains(box, [x, y]) { return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY; }

function nativePolygon(item) {
  if (Array.isArray(item?.textPolygon)) return item.textPolygon;
  if (Array.isArray(item?.polygon)) return item.polygon;
  if (Array.isArray(item?.bbox)) {
    const [x, y, width, height] = item.bbox.map(Number);
    if ([x, y, width, height].every(Number.isFinite)) return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  }
  const transform = Array.isArray(item?.transform) && item.transform.length >= 6 ? item.transform.map(Number) : null;
  const width = Number(item?.width); const height = Number(item?.height);
  if (!transform || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const baselineLength = Math.hypot(transform[0], transform[1]);
  const verticalLength = Math.hypot(transform[2], transform[3]);
  if (![baselineLength, verticalLength].every(Number.isFinite) || baselineLength <= 0 || verticalLength <= 0 || width <= 0 || height <= 0) return null;
  const origin = [transform[4], transform[5]];
  const baseline = [transform[0] / baselineLength * width, transform[1] / baselineLength * width];
  const vertical = [transform[2] / verticalLength * height, transform[3] / verticalLength * height];
  const add = (left, right) => [left[0] + right[0], left[1] + right[1]];
  return [origin, add(origin, baseline), add(add(origin, baseline), vertical), add(origin, vertical)];
}

function normalizeCropPolygon(value, page) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 3) throw new OcrResultError('OCR cropPolygon requires at least three points.');
  if (value.length > OCR_LIMITS.maxPolygonPoints) throw new LimitError(`OCR cropPolygon may contain at most ${OCR_LIMITS.maxPolygonPoints} points.`, { limitName: 'ocrCropPolygonPoints', observed: value.length, maximum: OCR_LIMITS.maxPolygonPoints, stage: 'ocr' });
  const polygon = value.map((point) => {
    const pair = Array.isArray(point) ? point : point && typeof point === 'object' ? [point.x, point.y] : null;
    if (!pair || pair.length < 2) throw new OcrResultError('OCR cropPolygon points must be [x, y] pairs or {x, y} objects.');
    return [finiteNumber(pair[0], 'cropPolygon.x'), finiteNumber(pair[1], 'cropPolygon.y')];
  });
  const limits = pageBounds(page);
  if (!limits || polygon.some(([x, y]) => x < limits.minX || y < limits.minY || x > limits.maxX || y > limits.maxY)) throw new OcrResultError('OCR cropPolygon must be finite and inside page bounds.');
  if (polygonArea(polygon) <= 0) throw new OcrResultError('OCR cropPolygon must enclose a positive area.');
  return polygon;
}

function parseDimension(text) {
  const match = /(^|[^\d])([+-]?(?:\d+(?:[.,]\d+)?|\.\d+))\s*(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?)\b/iu.exec(text);
  if (!match) return [];
  const unitRaw = match[3].toLowerCase();
  const unit = unitRaw.startsWith('mm') || unitRaw.startsWith('mill') ? 'mm' : unitRaw.startsWith('cm') || unitRaw.startsWith('cent') ? 'cm' : 'm';
  const value = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return [];
  return [{ kind: 'dimension', raw: match[0].trim(), value, unit, state: 'needs_review', parserVersion: 'dimension-parser-v1' }];
}

function semanticEvidence(input, text) {
  const supplied = input?.semanticEvidence;
  if (supplied !== undefined && !Array.isArray(supplied)) throw new OcrResultError('OCR semanticEvidence must be an array.');
  if ((supplied || []).length > OCR_LIMITS.maxSemanticEvidence) throw new LimitError(`OCR semanticEvidence may contain at most ${OCR_LIMITS.maxSemanticEvidence} entries.`, { limitName: 'ocrSemanticEvidence', observed: supplied.length, maximum: OCR_LIMITS.maxSemanticEvidence, stage: 'ocr' });
  const parsed = (supplied || []).map((entry) => {
    assertObject(entry, 'OCR semantic evidence must be an object.');
    const kind = stringValue(entry.kind, 'semantic evidence kind', { max: 64 });
    const raw = stringValue(entry.raw ?? text, 'semantic evidence raw', { max: OCR_LIMITS.maxTextLength });
    const output = { kind, raw, state: 'needs_review' };
    if (entry.value !== undefined) output.value = finiteNumber(entry.value, 'semantic evidence value');
    if (entry.unit !== undefined) output.unit = stringValue(entry.unit, 'semantic evidence unit', { max: 32 }).toLowerCase();
    output.parserVersion = stringValue(entry.parserVersion ?? 'external-review-parser-v1', 'semantic evidence parserVersion', { max: 64 });
    return output;
  });
  return [...parsed, ...parseDimension(text)];
}

function canonicalPageTransform(value, page) {
  const expected = page.transform || page.sourceTransform || null;
  if (value === undefined || value === null) return expected ? [...expected] : null;
  if (!Array.isArray(value) || value.length !== 6 || value.some((item) => !Number.isFinite(Number(item)))) throw new OcrResultError('OCR pageTransform must contain six finite numbers.');
  const result = value.map(Number);
  if (expected && (expected.length !== 6 || expected.some((item, index) => Number(item) !== result[index]))) throw new OcrResultError('OCR pageTransform does not match the inspected page.');
  return result;
}

function metadata(input, run, page, pageId, regionId) {
  const nested = input.metadata && typeof input.metadata === 'object'
    ? input.metadata
    : input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  const pick = (key, aliases = []) => input[key] ?? nested[key] ?? aliases.map((alias) => input[alias] ?? nested[alias]).find((value) => value !== undefined);
  const sourceDocumentId = stringValue(pick('sourceDocumentId'), 'sourceDocumentId');
  const sourceDocumentVersion = Number(pick('sourceDocumentVersion'));
  if (!Number.isInteger(sourceDocumentVersion)) throw new OcrResultError('OCR sourceDocumentVersion must be an integer.');
  const contentSha256 = stringValue(pick('contentSha256', ['sourceDocumentSha256']), 'contentSha256', { max: 128 });
  const processingRunId = stringValue(pick('processingRunId', ['runId']), 'processingRunId');
  const engine = stringValue(pick('engine'), 'engine');
  const engineVersion = stringValue(pick('engineVersion'), 'engineVersion');
  const modelVersion = stringValue(pick('modelVersion'), 'modelVersion');
  const language = stringValue(pick('language', ['lang']), 'language');
  const normalizationVersion = stringValue(pick('normalizationVersion'), 'normalizationVersion', { max: 64 });
  const expectedCoordinateSpace = page.coordinateSpace || (page.route === 'raster' ? 'image' : 'pdf');
  const coordinateSpace = stringValue(pick('coordinateSpace'), 'coordinateSpace', { required: false, max: 32 }) || expectedCoordinateSpace;
  if (coordinateSpace !== expectedCoordinateSpace) throw new OcrResultError(`OCR coordinateSpace must match the inspected page (${expectedCoordinateSpace}).`);
  const rotation = pick('rotation') === undefined ? Number(page.rotation || 0) : finiteNumber(pick('rotation'), 'rotation');
  if (rotation % 90 !== 0) throw new OcrResultError('OCR rotation must be a multiple of 90 degrees.');
  if (sourceDocumentId !== run.sourceDocumentId || sourceDocumentVersion !== run.assignmentSnapshot?.sourceDocumentVersion || contentSha256 !== run.assignmentSnapshot?.contentSha256 || processingRunId !== run.id) throw new OcrResultError('OCR provenance does not belong to this processing run.');
  if (normalizationVersion !== OCR_LIMITS.normalizationVersion) throw new OcrResultError(`Unsupported OCR normalizationVersion; expected ${OCR_LIMITS.normalizationVersion}.`);
  return { sourceDocumentId, sourceDocumentVersion, contentSha256, processingRunId, pageId, regionId: regionId || null, engine, engineVersion, modelVersion, language, normalizationVersion, coordinateSpace, pageTransform: canonicalPageTransform(pick('pageTransform'), page), rotation, cropPolygon: normalizeCropPolygon(pick('cropPolygon'), page) };
}

function normalizeOcrResults(input, context) {
  assertObject(input);
  walkForbidden(input);
  const { run, page, pageId } = context;
  if (!page) throw new OcrResultError('OCR page does not belong to this processing run.', { code: 'not_found' });
  const regionId = input.regionId ?? input.metadata?.regionId ?? null;
  if (regionId !== null && typeof regionId !== 'string') throw new OcrResultError('OCR regionId must be a string or null.');
  if (regionId) {
    const owned = page.regions?.some((region) => region.id === regionId && region.lifecycle !== 'deleted')
      || page.nativeRegionIds?.includes(regionId) || page.rasterRegionIds?.includes(regionId) || page.vectorRegions?.some((region) => region.id === regionId);
    if (!owned) throw new OcrResultError('OCR region does not belong to this page.');
  }
  const meta = metadata(input, run, page, pageId, regionId);
  if (input.pageId !== undefined && input.pageId !== pageId) throw new OcrResultError('OCR pageId does not match the requested page.');
  const raw = input.observations ?? input.results ?? input.items;
  if (!Array.isArray(raw)) throw new OcrResultError('OCR request requires an observations array.');
  if (raw.length > OCR_LIMITS.maxObservations) throw new LimitError(`OCR result contains more than ${OCR_LIMITS.maxObservations} observations.`, { limitName: 'ocrObservations', observed: raw.length, maximum: OCR_LIMITS.maxObservations, stage: 'ocr' });
  const limits = pageBounds(page);
  if (!limits) throw new OcrResultError('OCR page has no finite image/page bounds.');
  let totalTextChars = 0;
  const observations = raw.map((entry) => {
    assertObject(entry, 'OCR observations must be objects.');
    const polygon = polygonFromValue(entry);
    const box = bounds(polygon);
    if (box.minX < limits.minX || box.minY < limits.minY || box.maxX > limits.maxX || box.maxY > limits.maxY) throw new OcrResultError('OCR textPolygon must be finite and inside page bounds.');
    const text = normalizeText(entry.text);
    if (!text) throw new OcrResultError('OCR observation text is required.');
    if (text.length > OCR_LIMITS.maxTextLength) throw new LimitError(`OCR text exceeds ${OCR_LIMITS.maxTextLength} characters.`, { limitName: 'ocrTextLength', observed: text.length, maximum: OCR_LIMITS.maxTextLength, stage: 'ocr' });
    totalTextChars += text.length;
    const scoreValue = entry.confidence?.score ?? entry.confidence ?? entry.score;
    const score = finiteNumber(scoreValue, 'confidence.score');
    if (score < 0 || score > 1) throw new OcrResultError('OCR confidence.score must be between 0 and 1.');
    const engineField = stringValue(entry.confidence?.engineField ?? 'score', 'confidence.engineField', { max: 64 });
    return { ...meta, textPolygon: polygon, text, confidence: { score, engineField }, status: 'observed', nativeMatchId: null, semanticEvidence: semanticEvidence(entry, text) };
  });
  if (totalTextChars > OCR_LIMITS.maxTotalTextChars) throw new LimitError(`OCR text exceeds ${OCR_LIMITS.maxTotalTextChars} characters per request.`, { limitName: 'ocrTotalTextChars', observed: totalTextChars, maximum: OCR_LIMITS.maxTotalTextChars, stage: 'ocr' });
  const deduped = dedupe(observations);
  applyNativePrecedence(deduped, page);
  const withIds = deduped.map((observation) => ({ ...observation, id: observationId(observation) }));
  withIds.sort((left, right) => left.id.localeCompare(right.id));
  const batch = { ...meta, observations: withIds, observationCount: withIds.length };
  batch.batchKey = digest({ ...batch, observations: withIds });
  return batch;
}

function dedupe(observations) {
  const result = [];
  for (const candidate of observations.sort(compareObservation)) {
    const candidateBox = bounds(candidate.textPolygon);
    const duplicate = result.find((prior) => normalizeText(prior.text).toLocaleLowerCase() === normalizeText(candidate.text).toLocaleLowerCase() && boxesOverlap(bounds(prior.textPolygon), candidateBox) >= OCR_LIMITS.overlapThreshold);
    if (!duplicate) result.push(candidate);
    else if (candidate.confidence.score > duplicate.confidence.score) Object.assign(duplicate, candidate);
  }
  return result;
}

function compareObservation(a, b) {
  const aBox = bounds(a.textPolygon); const bBox = bounds(b.textPolygon);
  return (aBox.minY - bBox.minY) || (aBox.minX - bBox.minX) || a.text.localeCompare(b.text) || (b.confidence.score - a.confidence.score);
}

function applyNativePrecedence(observations, page) {
  const native = (page.nativeText || []).map((item) => ({ item, polygon: nativePolygon(item) })).filter((entry) => entry.polygon);
  for (const observation of observations) {
    const observationBox = bounds(observation.textPolygon); const observationCenter = centroid(observationBox); const normalized = normalizeText(observation.text).toLocaleLowerCase();
    const match = native.find(({ item, polygon }) => {
      const nativeBox = bounds(polygon); const overlap = boxesOverlap(observationBox, nativeBox);
      const sameText = normalizeText(item.text).toLocaleLowerCase() === normalized;
      return overlap >= OCR_LIMITS.overlapThreshold || (sameText && contains(nativeBox, observationCenter));
    });
    if (!match) continue;
    const sameText = normalizeText(match.item.text).toLocaleLowerCase() === normalized;
    observation.nativeMatchId = match.item.id || null;
    observation.status = sameText ? 'suppressed_by_native' : 'conflict';
    observation.precedence = 'native-preferred';
  }
}

function observationId(observation) {
  return `ocr_${digest(observation).slice(0, 24)}`;
}



function presentOcrBatch(batch) { return structuredClone(batch); }

module.exports = { OCR_LIMITS, OcrResultError, normalizeOcrResults, validateOcrResults: normalizeOcrResults, presentOcrBatch, digest };
