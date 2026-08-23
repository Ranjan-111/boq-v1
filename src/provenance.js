/* Unified provenance record (R2).
   One shape for every tier: the tier is a field, not a different structure.

   The two shapes this replaces -- DXF's `sourceHandles: ['10A']` and the
   PDF/raster `sourceContributions` -- both lacked geometry, contribution sign
   and a coordinate space. A bare handle cannot locate anything on screen
   without re-parsing the source document at render time, which is why
   `bounds` is precomputed here at measurement time. */

const PROVENANCE_VERSION = 'provenance-v2';

/* 'model-proposed' is deliberately absent. A model proposal only becomes
   provenance once a human confirms it, and it is recorded as a distinct value
   so the Tier C guarantee survives all the way to an export. */
const GEOMETRY_SOURCES = Object.freeze(['dxf-entity', 'native-vector', 'human-traced', 'model-proposed-confirmed']);
const COORDINATE_SPACES = Object.freeze(['dxf', 'pdf-page', 'raster-pixel']);
/* How the geometry was obtained. 'insertion-point' means only a placement was
   recoverable -- the bounds is a point and must not be read as a footprint. */
const GEOMETRY_RESOLUTIONS = Object.freeze(['native', 'block-definition', 'insertion-point']);
const SIGNS = Object.freeze(['add', 'deduct']);
const MEASUREMENT_STATUSES = Object.freeze(['measured', 'measured_zero', 'not_measurable']);

class ProvenanceError extends Error {}

/** Accepts [x, y] pairs or { x, y } points; returns null when there is no geometry. */
function normalizePoints(geometry) {
  if (!Array.isArray(geometry)) return [];
  const points = [];
  for (const point of geometry) {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point?.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push([x, y]);
  }
  return points;
}

/** [minX, minY, maxX, maxY], or null when no geometry was recoverable.
    A single point yields a degenerate box rather than a fabricated extent. */
function boundsOfPoints(geometry) {
  const points = normalizePoints(geometry);
  if (!points.length) return null;
  let [minX, minY] = points[0];
  let [maxX, maxY] = points[0];
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new ProvenanceError(`Provenance ${field} is required.`);
  return value;
}
function requireMember(value, allowed, field) {
  if (!allowed.includes(value)) throw new ProvenanceError(`Provenance ${field} must be one of ${allowed.join(', ')}; received ${JSON.stringify(value)}.`);
  return value;
}

/** Stable across reprocessing: derived only from the source document identity
    and the native element, never from a run id or a sequence counter. */
function sourceObjectId({ sourceDocumentId, sourceDocumentVersion, coordinateSpace, nativeHandle, regionId, pageId }) {
  const discriminator = [pageId, nativeHandle ?? regionId].filter(Boolean).join(':');
  if (!discriminator) throw new ProvenanceError('A source object needs a native handle or a region id to be addressable.');
  return `${sourceDocumentId}:v${sourceDocumentVersion}:${coordinateSpace}:${discriminator}`;
}

function createSourceObject(input) {
  const geometrySource = requireMember(input.geometrySource, GEOMETRY_SOURCES, 'geometrySource');
  const coordinateSpace = requireMember(input.coordinateSpace, COORDINATE_SPACES, 'coordinateSpace');
  const geometryResolution = requireMember(input.geometryResolution ?? 'native', GEOMETRY_RESOLUTIONS, 'geometryResolution');
  requireString(input.sourceDocumentId, 'sourceDocumentId');
  if (!Number.isInteger(input.sourceDocumentVersion)) throw new ProvenanceError('Provenance sourceDocumentVersion must be an integer.');
  const geometry = normalizePoints(input.geometry);
  const bounds = boundsOfPoints(geometry);
  return {
    version: PROVENANCE_VERSION,
    sourceObjectId: input.sourceObjectId || sourceObjectId({ ...input, coordinateSpace }),
    sourceDocumentId: input.sourceDocumentId,
    sourceDocumentVersion: input.sourceDocumentVersion,
    buildingId: input.buildingId ?? null,
    storeyId: input.storeyId ?? null,
    zoneId: input.zoneId ?? null,
    sheetId: input.sheetId ?? null,
    pageId: input.pageId ?? null,
    geometrySource,
    coordinateSpace,
    geometryResolution,
    geometry,
    bounds,
    transform: input.transform ?? null,
    rotation: input.rotation ?? null,
    nativeHandle: input.nativeHandle ?? null,
    handleSource: input.handleSource ?? 'file',
    regionId: input.regionId ?? null,
    wallGeometry: input.wallGeometry ?? null
  };
}

function createContribution(input) {
  requireString(input.sourceObjectId, 'contribution.sourceObjectId');
  requireString(input.measurement, 'contribution.measurement');
  requireMember(input.sign, SIGNS, 'contribution.sign');
  if (!Number.isFinite(input.quantity)) throw new ProvenanceError('Provenance contribution.quantity must be finite.');
  requireString(input.unit, 'contribution.unit');
  requireString(input.ruleId, 'contribution.ruleId');
  requireString(input.rulesetVersion, 'contribution.rulesetVersion');
  requireString(input.runId, 'contribution.runId');
  /* Deviation from the R2 spec, deliberately additive: the typical-storey
     multiplier scales the quantity, so dropping it would make a contribution
     irreproducible from its own record. */
  const typicalMultiplier = input.typicalMultiplier === undefined ? 1 : input.typicalMultiplier;
  if (!Number.isInteger(typicalMultiplier) || typicalMultiplier < 1) throw new ProvenanceError('Provenance contribution.typicalMultiplier must be a positive integer.');
  /* Second deliberate addition: the operator-supplied inputs the rule consumed
     (a PDF page scale, a raster calibration). Without them the quantity cannot
     be reproduced from its own provenance record, which is the whole point. */
  if (input.ruleInputs !== undefined && (typeof input.ruleInputs !== 'object' || input.ruleInputs === null || Array.isArray(input.ruleInputs))) throw new ProvenanceError('Provenance contribution.ruleInputs must be an object.');
  return {
    sourceObjectId: input.sourceObjectId,
    measurement: input.measurement,
    sign: input.sign,
    quantity: input.quantity,
    unit: input.unit,
    ruleId: input.ruleId,
    rulesetVersion: input.rulesetVersion,
    runId: input.runId,
    typicalMultiplier,
    ruleInputs: input.ruleInputs ? structuredClone(input.ruleInputs) : null
  };
}

/** Deductions subtract. This is what makes an opening visible in a wall line. */
function signedSum(contributions = []) {
  return contributions.reduce((total, contribution) => total + (contribution.sign === 'deduct' ? -contribution.quantity : contribution.quantity), 0);
}

/* A zero is not a measurement. If nothing resolved, the measurement was not
   possible -- that must never render the same as a measured zero. */
function measurementStatusFor(quantity, contributions = []) {
  if (!contributions.length) return 'not_measurable';
  return quantity > 0 ? 'measured' : 'measured_zero';
}

function buildProvenance({ contributions = [], quantity = 0, aggregation = null, measurementStatus, ...rest }) {
  return {
    version: PROVENANCE_VERSION,
    contributions,
    measurementStatus: measurementStatus || measurementStatusFor(quantity, contributions),
    aggregation: aggregation || { scope: 'source_document', scopeId: null },
    ...rest
  };
}

module.exports = {
  PROVENANCE_VERSION, GEOMETRY_SOURCES, COORDINATE_SPACES, GEOMETRY_RESOLUTIONS, SIGNS, MEASUREMENT_STATUSES,
  ProvenanceError, boundsOfPoints, normalizePoints, sourceObjectId,
  createSourceObject, createContribution, signedSum, measurementStatusFor, buildProvenance
};
