const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EXCEPTION_TYPES, SEVERITIES, exceptionsForRun, groupExceptions, createImpactRanker, rectangularityOf } = require('../src/exceptions');

const line = (measurement, overrides = {}) => ({
  measurement, label: measurement, quantity: 10, unit: 'm²',
  confidence: { level: 'HIGH', evidence: ['layer', 'hatch'] },
  measurementStatus: 'measured',
  provenance: { version: 'provenance-v2', contributions: [{ sourceObjectId: `obj:${measurement}`, sign: 'add', quantity: 10 }], measurementStatus: 'measured', aggregation: {} },
  ...overrides
});

test('every exception type declares a severity and what it blocks', () => {
  for (const type of EXCEPTION_TYPES) {
    assert.ok(SEVERITIES[type], `${type} declares a severity`);
    assert.ok(['blocking', 'advisory'].includes(SEVERITIES[type].severity));
    assert.ok(SEVERITIES[type].blocks.length > 0, `${type} says what it blocks`);
  }
});

test('every signal type reaches the queue, none stays in its own module', () => {
  const run = {
    id: 'run_0001', projectId: 'project_0001', sourceDocumentId: 'src_0001',
    boq: {
      lines: [
        line('wall_plaster', { quantity: 0, measurementStatus: 'not_measurable', provenance: { contributions: [], impossible: { reason: 'deductions exceed geometry', signedSum: -12 }, measurementStatus: 'not_measurable' } }),
        line('floor_area', { measurementStatus: 'not_measurable', quantity: 0, provenance: { contributions: [], measurementStatus: 'not_measurable' } }),
        line('wall_plan', { confidence: { level: 'LOW', evidence: ['layer'] }, provenance: { contributions: [{ sourceObjectId: 'obj:w', sign: 'add', quantity: 10 }], plausibility: { flagged: true, reasons: ['1620 m² is implausible for a single room'] } } }),
        line('skirting', { confidence: { level: 'MEDIUM', evidence: ['layer'] } }),
        line('room_count', { provenance: { contributions: [{ sourceObjectId: 'obj:r', sign: 'add', quantity: 2 }], classificationConflicts: ['seating-vs-chair'] } })
      ],
      unclassified: [{ sourceObjectId: 'obj:u', handle: '114', type: 'LWPOLYLINE', layer: 'A-FURN', block: null, reason: 'no rule could measure it' }],
      sourceObjects: []
    },
    residuals: [{ id: 'residual_1', sourceObjectId: 'obj:b17', blockName: 'Block_17', missing: 'item', categoryKnown: 'furniture', status: 'awaiting_human' }],
    pages: [{ sourcePageId: 'page_1', route: 'raster', pixelWidth: 200, pixelHeight: 100, regions: [
      { id: 'region_0001', lifecycle: 'proposed', origin: 'model-proposed', category: 'floor_area', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] }
    ] }]
  };
  const found = exceptionsForRun(run);
  const types = new Set(found.map((exception) => exception.type));
  for (const expected of ['impossible_quantity', 'not_measurable', 'implausible_magnitude', 'low_confidence', 'unclassified_geometry', 'unidentified_symbol', 'unconfirmed_proposal', 'classification_conflict']) {
    assert.ok(types.has(expected), `${expected} reached the queue`);
  }
});

test('an exception carries what it is, why, what it blocks, and how to resolve it', () => {
  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq: { lines: [line('floor_area', { measurementStatus: 'not_measurable', quantity: 0, provenance: { contributions: [], measurementStatus: 'not_measurable' } })], unclassified: [], sourceObjects: [] }, residuals: [], pages: [] };
  const [exception] = exceptionsForRun(run);
  for (const field of ['id', 'type', 'severity', 'title', 'raisedBecause', 'blocks', 'resolutionOptions', 'groupKey', 'runId']) {
    assert.ok(exception[field] !== undefined, `exception carries ${field}`);
  }
  assert.ok(exception.resolutionOptions.length > 0);
  assert.ok(exception.resolutionOptions.every((option) => option.action && option.label));
  assert.ok(exception.raisedBecause.length > 10, 'the reason is a sentence, not a code');
});

test('equivalent exceptions group so one decision clears many', () => {
  const residuals = Array.from({ length: 12 }, (_, index) => ({
    id: `residual_${index}`, sourceObjectId: `obj:${index}`, blockName: 'Block_17',
    missing: 'item', categoryKnown: 'furniture', status: 'awaiting_human'
  }));
  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq: { lines: [], unclassified: [], sourceObjects: [] }, residuals, pages: [] };
  const found = exceptionsForRun(run);
  assert.equal(found.length, 12, 'each instance is still an exception');
  const groups = groupExceptions(found);
  assert.equal(groups.length, 1, 'twelve instances of one symbol are one decision');
  assert.equal(groups[0].count, 12);
  assert.equal(groups[0].groupKey, 'unidentified_symbol:Block_17');
  assert.equal(groups[0].members.length, 12);
  assert.deepEqual(groups[0].sourceObjectIds.slice(0, 2), ['obj:0', 'obj:1'], 'every instance stays reachable');
});

test('different causes do not group together', () => {
  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq: { lines: [], unclassified: [], sourceObjects: [] },
    residuals: [
      { id: 'a', sourceObjectId: 'obj:a', blockName: 'Block_17', missing: 'item', categoryKnown: 'furniture', status: 'awaiting_human' },
      { id: 'b', sourceObjectId: 'obj:b', blockName: 'Block_22', missing: 'category+item', categoryKnown: null, status: 'awaiting_human' }
    ], pages: [] };
  assert.equal(groupExceptions(exceptionsForRun(run)).length, 2);
});

test('ordering is labelled honestly and changes when a rate source is supplied', () => {
  const withoutRates = createImpactRanker({});
  assert.equal(withoutRates.rankedBy, 'quantity-proxy');
  assert.match(withoutRates.caveat, /not|proxy|provisional/i, 'the proxy says it is a proxy');

  const withRates = createImpactRanker({ rateSource: { rateFor: () => 1800 } });
  assert.equal(withRates.rankedBy, 'money-at-risk');
  assert.equal(withRates.caveat, null);

  // within one measurement class the proxy is meaningful: bigger share, higher up
  const sameClass = [
    { id: 'a', type: 'not_measurable', measurement: 'floor_area', impact: { quantity: 5, unit: 'm²' } },
    { id: 'b', type: 'not_measurable', measurement: 'floor_area', impact: { quantity: 100, unit: 'm²' } }
  ];
  assert.deepEqual(withoutRates.order(sameClass).map((exception) => exception.id), ['b', 'a'], 'larger share of its class first');
  for (const exception of withoutRates.order(sameClass)) {
    assert.equal(exception.rankedBy, 'quantity-proxy', 'each item is labelled with how it was ranked');
  }

  // across classes the proxy cannot compare 100 m² against 5 m, and does not pretend to
  const crossClass = [
    { id: 'm', type: 'not_measurable', measurement: 'skirting', impact: { quantity: 5, unit: 'm' } },
    { id: 'n', type: 'not_measurable', measurement: 'floor_area', impact: { quantity: 100, unit: 'm²' } }
  ];
  const ordered = withoutRates.order(crossClass);
  assert.equal(ordered[0].impactScore, ordered[1].impactScore, 'sole members of different classes tie rather than being ranked on incomparable units');
  assert.match(withoutRates.caveat, /within their measurement class/i, 'and the caveat says so');

  // rates make the comparison real
  const priced = withRates.order(crossClass);
  assert.equal(priced[0].measurement, 'floor_area', 'with a rate source the larger money at risk sorts first');
  assert.equal(priced[0].rankedBy, 'money-at-risk');
});

test('a proxy ordering is never presented as monetary', () => {
  const ranker = createImpactRanker({});
  const ordered = ranker.order([{ type: 'not_measurable', measurement: 'floor_area', impact: { quantity: 10, unit: 'm²' } }]);
  assert.equal(ordered[0].rankedBy, 'quantity-proxy');
  assert.equal(ordered[0].impact.money, undefined, 'no monetary figure is invented');
  assert.notEqual(ordered[0].rankedBy, 'money-at-risk');
});

test('rectangularity detects a proposal that cannot describe an L-shaped room', () => {
  const rectangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  assert.equal(rectangularityOf(rectangle).isAxisAlignedRectangle, true);
  const ell = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
  assert.equal(rectangularityOf(ell).isAxisAlignedRectangle, false);
});

test('a rectangular proposal over a non-rectangular region raises its own exception', () => {
  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq: { lines: [], unclassified: [], sourceObjects: [] }, residuals: [],
    pages: [{ sourcePageId: 'page_1', route: 'raster', pixelWidth: 200, pixelHeight: 100, regions: [
      { id: 'region_0001', lifecycle: 'confirmed', origin: 'model-proposed', category: 'floor_area',
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] }
    ] }] };
  const found = exceptionsForRun(run);
  const rectangular = found.find((exception) => exception.type === 'rectangular_proposal');
  assert.ok(rectangular, 'a confirmed rectangle from a model is flagged for shape review');
  assert.match(rectangular.raisedBecause, /rectangle|L-shaped|overstate/i);
  assert.deepEqual(rectangular.resolutionOptions.map((option) => option.action).sort(), ['confirm_shape', 'retrace_polygon']);
  assert.equal(rectangular.sourceObjectId !== undefined, true);
});

test('a human-traced rectangle is not flagged - only a model proposal is', () => {
  const run = { id: 'run_0001', projectId: 'p', sourceDocumentId: 's', boq: { lines: [], unclassified: [], sourceObjects: [] }, residuals: [],
    pages: [{ sourcePageId: 'page_1', route: 'raster', pixelWidth: 200, pixelHeight: 100, regions: [
      { id: 'region_0001', lifecycle: 'confirmed', origin: 'human-traced', category: 'floor_area',
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] }
    ] }] };
  assert.equal(exceptionsForRun(run).some((exception) => exception.type === 'rectangular_proposal'), false,
    'a person who drew a rectangle meant to draw a rectangle');
});
