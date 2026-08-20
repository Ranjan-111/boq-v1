const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVENANCE_VERSION, GEOMETRY_SOURCES, COORDINATE_SPACES, SIGNS,
  boundsOfPoints, createSourceObject, createContribution,
  measurementStatusFor, signedSum, ProvenanceError
} = require('../src/provenance');

const object = (overrides = {}) => createSourceObject({
  sourceObjectId: 'src_0001:v1:dxf:10A',
  sourceDocumentId: 'src_0001', sourceDocumentVersion: 1,
  buildingId: 'building_0001', storeyId: 'storey_0001', sheetId: 'A-PLAN',
  geometrySource: 'dxf-entity', coordinateSpace: 'dxf',
  geometry: [[0, 0], [10, 0], [10, 5], [0, 5]], nativeHandle: '10A', ...overrides
});

test('bounds are computed from geometry and are never empty for real points', () => {
  assert.deepEqual(boundsOfPoints([[0, 0], [10, 0], [10, 5]]), [0, 0, 10, 5]);
  assert.deepEqual(boundsOfPoints([[2000, 0]]), [2000, 0, 2000, 0], 'a single insertion point yields a degenerate but present bounds');
  assert.equal(boundsOfPoints([]), null, 'no geometry yields null rather than a fake zero box');
});

test('a SourceObject precomputes bounds so the viewer never re-parses the source', () => {
  const built = object();
  assert.deepEqual(built.bounds, [0, 0, 10, 5]);
  assert.equal(built.version, PROVENANCE_VERSION);
});

test('geometrySource never accepts an unconfirmed model proposal', () => {
  assert.ok(GEOMETRY_SOURCES.includes('model-proposed-confirmed'));
  assert.ok(!GEOMETRY_SOURCES.includes('model-proposed'), 'plain model-proposed must not be a storable provenance value');
  assert.throws(() => object({ geometrySource: 'model-proposed' }), ProvenanceError);
});

test('coordinateSpace is constrained to the three tier spaces', () => {
  assert.deepEqual([...COORDINATE_SPACES].sort(), ['dxf', 'pdf-page', 'raster-pixel']);
  assert.throws(() => object({ coordinateSpace: 'screen' }), ProvenanceError);
});

test('a Contribution requires an explicit sign', () => {
  assert.deepEqual([...SIGNS].sort(), ['add', 'deduct']);
  const base = { sourceObjectId: 'src_0001:v1:dxf:10A', measurement: 'wall_plaster', quantity: 4, unit: 'm²', ruleId: 'wall-plaster-v1', rulesetVersion: 'clean-plan-v1', runId: 'run_0001' };
  assert.throws(() => createContribution({ ...base }), ProvenanceError, 'sign is required, never defaulted');
  assert.throws(() => createContribution({ ...base, sign: 'negative' }), ProvenanceError);
  assert.equal(createContribution({ ...base, sign: 'add' }).sign, 'add');
  assert.equal(createContribution({ ...base, sign: 'deduct' }).sign, 'deduct');
});

test('signed sum subtracts deductions so a line reconciles to its reported quantity', () => {
  const contribution = (sign, quantity) => createContribution({ sourceObjectId: 'o', measurement: 'wall_plaster', sign, quantity, unit: 'm²', ruleId: 'r', rulesetVersion: 'v', runId: 'run_0001' });
  assert.equal(signedSum([contribution('add', 10), contribution('add', 5)]), 15);
  assert.equal(signedSum([contribution('add', 10), contribution('deduct', 2.5)]), 7.5);
  assert.equal(signedSum([]), 0);
});

test('measurement status distinguishes a measured zero from an absent measurement', () => {
  const one = [{ sign: 'add', quantity: 0 }];
  assert.equal(measurementStatusFor(5, one), 'measured');
  assert.equal(measurementStatusFor(0, one), 'measured_zero', 'geometry resolved and measured zero');
  assert.equal(measurementStatusFor(0, []), 'not_measurable', 'nothing resolved - this is not a zero');
  assert.notEqual(measurementStatusFor(0, []), measurementStatusFor(0, one));
});
