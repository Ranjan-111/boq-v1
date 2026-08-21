const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRateBook, priceLine, RateError, PRICING_STATUSES,
  isStale, roundMoney, totalOf
} = require('../src/rates');

const book = (overrides = {}) => createRateBook({
  id: 'ratebook_0001', studioId: 'studio_alpha', label: 'Studio rates',
  version: 1, currency: 'INR', locality: 'Bengaluru',
  source: { label: 'Studio historical prices', suppliedBy: 'commercial lead', importedAt: '2026-01-10T00:00:00.000Z' },
  rates: [
    { itemCode: 'floor_area', unit: 'm²', amount: 1800, validFrom: '2026-01-01', validTo: '2026-12-31' },
    { itemCode: 'wall_plaster', unit: 'm²', amount: 420, validFrom: '2026-01-01', validTo: '2026-12-31' },
    { itemCode: 'skirting', unit: 'm', amount: 0, validFrom: '2026-01-01', validTo: '2026-12-31' },
    { itemCode: 'wall_masonry', unit: 'm³', amount: 6200, validFrom: '2025-01-01', validTo: '2025-12-31' },
    { itemCode: 'trim', unit: 'm', amount: 1, validFrom: '2026-01-01', validTo: '2026-12-31' }
  ], ...overrides
});

test('a rate without provenance is refused - a price is a fact with an owner and a date', () => {
  assert.throws(() => createRateBook({ id: 'r', studioId: 's', version: 1, currency: 'INR', source: null, rates: [] }), RateError);
  assert.throws(() => createRateBook({ id: 'r', studioId: 's', version: 1, currency: 'INR', source: { label: 'x' },
    rates: [{ itemCode: 'floor_area', unit: 'm²', amount: 100 }] }), RateError, 'a rate with no validity window is refused');
  assert.throws(() => createRateBook({ id: 'r', studioId: 's', version: 1, source: { label: 'x', suppliedBy: 'y' },
    rates: [{ itemCode: 'a', unit: 'm²', amount: 1, validFrom: '2026-01-01', validTo: '2026-12-31' }] }), RateError, 'currency is explicit, never assumed');
});

test('a rate book is immutable - a price change is a new version', () => {
  const first = book();
  const original = first.rates[0].amount;
  // frozen: assignment is a no-op here rather than a throw (non-strict callers)
  first.rates[0].amount = 9999;
  first.version = 2;
  assert.equal(first.rates[0].amount, original, 'the stored price did not move');
  assert.equal(first.version, 1, 'nor did the version');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.rates[0]), true);
});

test('a line with no applicable rate has no amount, and that is not zero', () => {
  const priced = priceLine({ measurement: 'room_count', quantity: 2, unit: 'nos' }, book(), { on: '2026-06-01' });
  assert.equal(priced.status, 'no_rate');
  assert.equal(priced.amount, null, 'absent, not zero');
  assert.equal(priced.rate, null);
  assert.ok(PRICING_STATUSES.includes(priced.status));
  assert.match(priced.reason, /no rate/i);
});

test('a genuinely free item is distinguishable from an unpriced one', () => {
  const free = priceLine({ measurement: 'skirting', quantity: 29.8, unit: 'm' }, book(), { on: '2026-06-01' });
  assert.equal(free.status, 'priced');
  assert.equal(free.amount, 0, 'a zero rate produces a real zero amount');
  assert.equal(free.rate.amount, 0);
  const missing = priceLine({ measurement: 'room_count', quantity: 2, unit: 'nos' }, book(), { on: '2026-06-01' });
  assert.notEqual(free.status, missing.status, 'free and unpriced are different states');
  assert.notEqual(free.amount, missing.amount);
});

test('an expired rate does not quietly price a line', () => {
  const expired = priceLine({ measurement: 'wall_masonry', quantity: 18.078, unit: 'm³' }, book(), { on: '2026-06-01' });
  assert.equal(expired.status, 'stale_rate');
  assert.equal(expired.amount, null, 'a stale rate produces no amount at all');
  assert.match(expired.reason, /expired|valid/i);
  assert.equal(expired.rate.validTo, '2025-12-31', 'but the rate it would have used is still shown');
  assert.equal(isStale(expired.rate, '2026-06-01'), true);
  assert.equal(isStale(expired.rate, '2025-06-01'), false);
});

test('a unit mismatch refuses to price rather than multiplying the wrong things', () => {
  const wrong = priceLine({ measurement: 'floor_area', quantity: 10, unit: 'm' }, book(), { on: '2026-06-01' });
  assert.equal(wrong.status, 'unit_mismatch');
  assert.equal(wrong.amount, null);
  assert.match(wrong.reason, /unit/i);
});

test('an amount is re-derivable from what is stored', () => {
  const priced = priceLine({ measurement: 'floor_area', quantity: 27.72, unit: 'm²' }, book(), { on: '2026-06-01' });
  assert.equal(priced.status, 'priced');
  assert.equal(priced.amount, 27.72 * 1800);
  assert.equal(priced.quantity * priced.rate.amount, priced.amount, 'quantity x rate reproduces the amount');
  assert.equal(priced.currency, 'INR');
  assert.equal(priced.rateBookId, 'ratebook_0001');
  assert.equal(priced.rateBookVersion, 1);
  assert.ok(priced.rate.source.suppliedBy, 'the amount carries who supplied its rate');
});

test('a missing quantity gives a missing amount, never zero', () => {
  const unmeasured = priceLine({ measurement: 'floor_area', quantity: null, unit: 'm²', measurementStatus: 'not_measurable' }, book(), { on: '2026-06-01' });
  assert.equal(unmeasured.status, 'no_quantity');
  assert.equal(unmeasured.amount, null);
});

test('totals never accumulate rounded values', () => {
  // three lines that each round up individually: 0.125 -> 0.13, but 0.375 -> 0.38
  const lines = [
    { measurement: 'trim', quantity: 0.125, unit: 'm' },
    { measurement: 'trim', quantity: 0.125, unit: 'm' },
    { measurement: 'trim', quantity: 0.125, unit: 'm' }
  ].map((line) => priceLine(line, book(), { on: '2026-06-01' }));

  const exact = lines.reduce((sum, line) => sum + line.amount, 0);
  const sumOfRounded = lines.reduce((sum, line) => sum + roundMoney(line.amount), 0);
  const total = totalOf(lines);
  assert.equal(total.amount, roundMoney(exact), 'rounded once, at the end');
  assert.notEqual(total.amount, sumOfRounded, 'and not the sum of rounded parts');
  assert.equal(total.currency, 'INR');
});

test('a total reports what it could not price rather than skipping it', () => {
  const lines = [
    priceLine({ measurement: 'floor_area', quantity: 10, unit: 'm²' }, book(), { on: '2026-06-01' }),
    priceLine({ measurement: 'room_count', quantity: 2, unit: 'nos' }, book(), { on: '2026-06-01' }),
    priceLine({ measurement: 'wall_masonry', quantity: 5, unit: 'm³' }, book(), { on: '2026-06-01' })
  ];
  const total = totalOf(lines);
  assert.equal(total.pricedLines, 1);
  assert.equal(total.unpricedLines, 2, 'the total says how much of the BOQ it does not cover');
  assert.equal(total.complete, false, 'and refuses to present itself as a whole-project figure');
});

test('mixing currencies is refused, never silently summed', () => {
  const other = priceLine({ measurement: 'floor_area', quantity: 1, unit: 'm²' }, book({ id: 'rb2', currency: 'USD' }), { on: '2026-06-01' });
  const inr = priceLine({ measurement: 'floor_area', quantity: 1, unit: 'm²' }, book(), { on: '2026-06-01' });
  assert.throws(() => totalOf([inr, other]), RateError);
});

test('a book priced in March still reproduces March after a new version is published', () => {
  const march = book({ id: 'rb', version: 1 });
  const october = book({ id: 'rb', version: 2, rates: [{ itemCode: 'floor_area', unit: 'm²', amount: 2400, validFrom: '2026-01-01', validTo: '2026-12-31' }] });
  const line = { measurement: 'floor_area', quantity: 100, unit: 'm²' };
  assert.equal(priceLine(line, march, { on: '2026-03-15' }).amount, 180000);
  assert.equal(priceLine(line, october, { on: '2026-10-15' }).amount, 240000);
  assert.equal(priceLine(line, march, { on: '2026-10-15' }).amount, 180000, 'the old version still prices as it did');
});
