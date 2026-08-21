const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVendorOffer, eligibleOffers, VendorError } = require('../src/vendors');

const offer = (overrides = {}) => createVendorOffer({
  id: 'offer_0001', studioId: 'studio_alpha', vendorId: 'vendor_1', vendorName: 'Sharma Interiors',
  itemCode: 'floor_area', unit: 'm²', amount: 1750, currency: 'INR',
  validFrom: '2026-01-01', validTo: '2026-12-31',
  source: { label: 'Emailed quotation', suppliedBy: 'procurement' }, ...overrides
});

test('an offer without provenance or a validity window is refused', () => {
  assert.throws(() => createVendorOffer({ ...offer(), source: null }), VendorError);
  assert.throws(() => createVendorOffer({ id: 'o', studioId: 's', vendorId: 'v', vendorName: 'V', itemCode: 'i', unit: 'm²', amount: 1, currency: 'INR', source: { label: 'l', suppliedBy: 'p' } }), VendorError);
  assert.throws(() => createVendorOffer({ ...offer(), currency: undefined }), VendorError);
});

test('offers are surfaced, never selected', () => {
  const offers = [
    offer({ id: 'offer_1', vendorId: 'v1', vendorName: 'Cheapest', amount: 1500 }),
    offer({ id: 'offer_2', vendorId: 'v2', vendorName: 'Middle', amount: 1750 }),
    offer({ id: 'offer_3', vendorId: 'v3', vendorName: 'Dearest', amount: 2100 })
  ];
  const result = eligibleOffers(offers, { itemCode: 'floor_area', studioId: 'studio_alpha', unit: 'm²', on: '2026-06-01' });
  assert.equal(result.offers.length, 3, 'every eligible vendor is shown');
  assert.equal(result.selected, undefined, 'nothing is chosen');
  assert.equal(result.recommended, undefined, 'and nothing is nudged');
  assert.equal(result.cheapest, undefined, 'not even by implication');
  assert.ok(result.offers.every((entry) => entry.vendorName && Number.isFinite(entry.amount) && entry.validTo));
});

test('offers are scoped to the studio that holds them', () => {
  const offers = [offer({ id: 'a', studioId: 'studio_alpha' }), offer({ id: 'b', studioId: 'studio_beta' })];
  const result = eligibleOffers(offers, { itemCode: 'floor_area', studioId: 'studio_alpha', unit: 'm²', on: '2026-06-01' });
  assert.deepEqual(result.offers.map((entry) => entry.id), ['a'], 'another studio does not see these suppliers');
});

test('an expired offer is excluded from eligibility and reported as stale', () => {
  const offers = [
    offer({ id: 'live' }),
    offer({ id: 'expired', validFrom: '2025-01-01', validTo: '2025-06-30' })
  ];
  const result = eligibleOffers(offers, { itemCode: 'floor_area', studioId: 'studio_alpha', unit: 'm²', on: '2026-06-01' });
  assert.deepEqual(result.offers.map((entry) => entry.id), ['live']);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].id, 'expired');
  assert.match(result.stale[0].reason, /expired|valid/i);
});

test('an offer priced per a different unit is not eligible', () => {
  const offers = [offer({ id: 'wrong-unit', unit: 'm' })];
  const result = eligibleOffers(offers, { itemCode: 'floor_area', studioId: 'studio_alpha', unit: 'm²', on: '2026-06-01' });
  assert.equal(result.offers.length, 0);
  assert.match(result.ineligible[0].reason, /unit/i);
});

test('no eligible offers is a reported state, not an empty silence', () => {
  const result = eligibleOffers([], { itemCode: 'floor_area', studioId: 'studio_alpha', unit: 'm²', on: '2026-06-01' });
  assert.equal(result.offers.length, 0);
  assert.equal(result.status, 'none_eligible');
  assert.match(result.reason, /no eligible/i);
});
