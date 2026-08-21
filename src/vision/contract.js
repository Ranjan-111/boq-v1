/* The label contract (#10).

   A model may propose WHAT a thing is. It may never supply a number that
   becomes a quantity. That is enforced structurally, not by convention:
   `coerceLabel` returns `{ label, category }` and has no numeric field to put a
   number in. Whatever the provider replies -- prose, JSON carrying a price, a
   prompt-injection attempt -- the only thing that can leave this module is a
   member of a closed ontology and the category that ontology assigns it.

   On Tier A the geometry is already exact, so a label is the only useful
   machine contribution. There is no code path from a model reply to an
   arithmetic operand. */

const ONTOLOGY = Object.freeze(['SOFA', 'BED', 'TABLE', 'CHAIR', 'CABINET', 'WARDROBE',
  'WC', 'BASIN', 'DOOR', 'WINDOW', 'STAIR', 'KITCHEN_UNIT', 'UNKNOWN']);

const CATEGORY_OF = Object.freeze({
  SOFA: 'furniture', BED: 'furniture', TABLE: 'furniture', CHAIR: 'furniture',
  CABINET: 'furniture', WARDROBE: 'furniture', KITCHEN_UNIT: 'furniture',
  WC: 'fixture', BASIN: 'fixture', DOOR: 'door', WINDOW: 'window',
  STAIR: 'stair', UNKNOWN: null
});

class VisionContractError extends Error {}

const LABEL_PROMPT = [
  'You are looking at a single symbol cropped from an architectural floor plan, drawn in plan view.',
  'Reply with exactly one label naming what the symbol depicts, chosen from this list:',
  ONTOLOGY.join(', ') + '.',
  'If you are not confident, reply UNKNOWN.',
  'Reply with the single label and nothing else.'
].join('\n');

/* Candidate label text out of an arbitrary reply. Everything that is not one of
   the closed ontology words is discarded, so digits never reach a caller. */
function candidateFrom(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    return typeof reply.label === 'string' ? reply.label : '';
  }
  return '';
}

/**
 * @returns {{label: string, category: string|null}} - no numeric field exists.
 */
function coerceLabel(reply, { strict = false, allowed = ONTOLOGY } = {}) {
  if (strict && (!Array.isArray(allowed) || allowed.length === 0)) {
    throw new VisionContractError('A label contract needs a non-empty ontology.');
  }
  const text = candidateFrom(reply).toUpperCase();
  /* Match whole ontology words only. A reply of "SOFA 2400mm wide" yields SOFA
     and the rest is dropped; "4.2" matches nothing and becomes UNKNOWN. */
  let label = 'UNKNOWN';
  for (const candidate of allowed) {
    if (candidate === 'UNKNOWN') continue;
    if (new RegExp(`\\b${candidate}\\b`).test(text)) { label = candidate; break; }
  }
  return { label, category: CATEGORY_OF[label] ?? null };
}

/* Raster boundary proposals (#11).

   On Tier C there is no geometry, so a boundary proposal is the only useful
   machine contribution. Boxes are normalised to the image (0..1) and mean
   nothing in metres: the operator's calibration is what turns pixels into a
   quantity. Strip the calibration and every Tier C number is undefined, which
   is precisely why a model cannot independently produce one.

   Anything scale-like in a reply is discarded here rather than ignored later. */
const RASTER_CLASSES = Object.freeze(['floor_area', 'wall_area']);

const RASTER_PROMPT = [
  'You are looking at an architectural floor plan image.',
  'Outline each region that is clearly a floor or a wall face.',
  'Reply with JSON: {"boxes":[{"x":0,"y":0,"width":0,"height":0,"label":"floor_area"}]}.',
  'All four numbers are fractions of the image between 0 and 1.',
  'Use only these labels: ' + RASTER_CLASSES.join(', ') + '.',
  'Reply with the JSON and nothing else.'
].join('\n');

/* A proposal that is a few pixels across is noise. The threshold is a fraction
   of the image, not an absolute pixel count: an absolute floor lets slivers
   through on a large scan and rejects real regions on a small one. */
const MIN_AREA_FRACTION = 0.002;
const MIN_EDGE_FRACTION = 0.01;

function parseReply(reply) {
  if (reply && typeof reply === 'object') return reply;
  if (typeof reply !== 'string') return null;
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * @returns {{boxes: Array<{x,y,width,height,label}>, dropped: number}}
 *   Only these five fields exist on a box. There is nowhere to put a scale.
 */
function coerceBoxes(reply, { imageWidth, imageHeight, minAreaFraction = MIN_AREA_FRACTION } = {}) {
  const payload = parseReply(reply);
  const candidates = Array.isArray(payload?.boxes) ? payload.boxes : [];
  const boxes = [];
  let dropped = 0;
  for (const candidate of candidates) {
    const x = Number(candidate?.x); const y = Number(candidate?.y);
    const width = Number(candidate?.width); const height = Number(candidate?.height);
    if (![x, y, width, height].every(Number.isFinite)) { dropped += 1; continue; }
    // must lie wholly inside the image; a box hanging off the edge is not clamped into fiction
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) { dropped += 1; continue; }
    if (width * height < minAreaFraction || width < MIN_EDGE_FRACTION || height < MIN_EDGE_FRACTION) { dropped += 1; continue; }
    const label = RASTER_CLASSES.includes(candidate?.label) ? candidate.label : RASTER_CLASSES[0];
    boxes.push({ x, y, width, height, label });
  }
  return { boxes, dropped };
}

/** Normalised box -> image pixel polygon. Still pixels: still not a quantity. */
function boxToPolygon(box, imageWidth, imageHeight) {
  const left = box.x * imageWidth; const top = box.y * imageHeight;
  const right = (box.x + box.width) * imageWidth; const bottom = (box.y + box.height) * imageHeight;
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

module.exports = { ONTOLOGY, CATEGORY_OF, LABEL_PROMPT, coerceLabel, VisionContractError,
  RASTER_CLASSES, RASTER_PROMPT, coerceBoxes, boxToPolygon, MIN_AREA_FRACTION };
