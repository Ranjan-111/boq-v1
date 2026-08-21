const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { createRepository } = require('../src/repository');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });

const liveRates = (overrides = {}) => ({
  studioId: 'studio_alpha', label: 'Studio rates', currency: 'INR', locality: 'Bengaluru',
  source: { label: 'Studio historical prices', suppliedBy: 'commercial lead' },
  rates: [
    { itemCode: 'floor_area', unit: 'm²', amount: 1800, validFrom: '2026-01-01', validTo: '2026-12-31' },
    { itemCode: 'wall_plaster', unit: 'm²', amount: 420, validFrom: '2026-01-01', validTo: '2026-12-31' }
  ], ...overrides
});

function workspace(options = {}) {
  const application = sync(options);
  const project = application.createProject({ name: 'Priced project' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  const run = application.getRun(application.startProcessing(source.id).id);
  return { application, project, source, run };
}

test('with no rate book the BOQ is unpriced, and that is visible', () => {
  const { application, project } = workspace();
  const priced = application.getPricedBoq(project.id, { on: '2026-06-01' });
  assert.equal(priced.status, 'unavailable');
  assert.equal(priced.total, null, 'no total is invented');
  assert.match(priced.reason, /no rate book/i);
  for (const line of priced.lines) assert.equal(line.amount, null);
});

test('a published rate book prices the BOQ and every amount is re-derivable', () => {
  const { application, project } = workspace();
  const book = application.publishRateBook(project.id, liveRates());
  assert.equal(book.version, 1);
  const priced = application.getPricedBoq(project.id, { on: '2026-06-01' });
  assert.equal(priced.status, 'priced');
  const floor = priced.lines.find((line) => line.measurement === 'floor_area');
  assert.equal(floor.status, 'priced');
  assert.equal(floor.amount, 27.72 * 1800);
  assert.equal(floor.quantity * floor.rate.amount, floor.amount);
  assert.equal(floor.rate.source.suppliedBy, 'commercial lead', 'the amount carries who supplied its rate');
  assert.equal(priced.total.currency, 'INR');
  assert.equal(priced.total.complete, false, 'unpriced lines are reported, not skipped');
  assert.ok(priced.total.unpricedLines > 0);
});

test('a BOQ priced under v1 still reproduces v1 after v2 is published', () => {
  const { application, project } = workspace();
  application.publishRateBook(project.id, liveRates());
  const beforeAmount = application.getPricedBoq(project.id, { on: '2026-06-01' }).lines.find((line) => line.measurement === 'floor_area').amount;

  const v2 = application.publishRateBook(project.id, liveRates({ rates: [{ itemCode: 'floor_area', unit: 'm²', amount: 2400, validFrom: '2026-01-01', validTo: '2026-12-31' }] }));
  assert.equal(v2.version, 2, 'a price change is a new version, never an edit');

  const atV2 = application.getPricedBoq(project.id, { on: '2026-06-01' }).lines.find((line) => line.measurement === 'floor_area').amount;
  const atV1 = application.getPricedBoq(project.id, { on: '2026-06-01', rateBookVersion: 1 }).lines.find((line) => line.measurement === 'floor_area').amount;
  assert.equal(atV2, 27.72 * 2400, 'the current version prices at the new rate');
  assert.equal(atV1, beforeAmount, 'and v1 still prices exactly as it did');
});

test('an expired rate raises a blocking exception and refuses approval', () => {
  const { application, project } = workspace();
  application.publishRateBook(project.id, liveRates({ rates: [
    { itemCode: 'floor_area', unit: 'm²', amount: 1800, validFrom: '2025-01-01', validTo: '2025-12-31' }
  ] }));
  const queue = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  const stale = queue.exceptions.find((exception) => exception.type === 'stale_rate');
  assert.ok(stale, 'the expired rate is in the queue');
  assert.equal(stale.severity, 'blocking');
  assert.match(stale.raisedBecause, /expired|2025-12-31/);

  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  assert.throws(() => application.approveBoqVersion(boqVersionId, { approvedBy: 'qs', on: '2026-06-01' }), /blocking exception/i);
});

test('a live rate book does not raise a staleness exception', () => {
  const { application, project } = workspace();
  application.publishRateBook(project.id, liveRates());
  const queue = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  assert.equal(queue.exceptions.some((exception) => exception.type === 'stale_rate'), false);
});

test('the ranker flips from quantity-proxy to money-at-risk when rates exist', () => {
  const { application, project } = workspace();
  const before = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  assert.equal(before.rankedBy, 'quantity-proxy');
  assert.ok(before.caveat);

  application.publishRateBook(project.id, liveRates());
  const after = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  assert.equal(after.rankedBy, 'money-at-risk', 'the label changes');
  assert.equal(after.caveat, null, 'and the provisional caveat is gone');
});

test('money ordering genuinely differs from the quantity proxy', () => {
  const { application, project } = workspace();
  // wall_plaster is the larger quantity; floor_area is worth far more per unit
  application.publishRateBook(project.id, liveRates({ rates: [
    { itemCode: 'floor_area', unit: 'm²', amount: 9000, validFrom: '2026-01-01', validTo: '2026-12-31' },
    { itemCode: 'wall_plaster', unit: 'm²', amount: 5, validFrom: '2026-01-01', validTo: '2026-12-31' }
  ] }));
  const ranker = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  assert.equal(ranker.rankedBy, 'money-at-risk');
  const scored = [
    { type: 'low_confidence', measurement: 'wall_plaster', impact: { quantity: 143.79, unit: 'm²' }, severity: 'advisory' },
    { type: 'low_confidence', measurement: 'floor_area', impact: { quantity: 27.72, unit: 'm²' }, severity: 'advisory' }
  ];
  const ordered = application.rankExceptions(project.id, scored, { on: '2026-06-01' });
  assert.equal(ordered[0].measurement, 'floor_area', '27.72 m² at 9000 outranks 143.79 m² at 5');
  assert.ok(ordered[0].impactScore > ordered[1].impactScore);
  assert.equal(ordered[0].rankedBy, 'money-at-risk');
});

test('a run records the rate book version it priced under', () => {
  const { application, project } = workspace();
  application.publishRateBook(project.id, liveRates());
  const priced = application.getPricedBoq(project.id, { on: '2026-06-01' });
  assert.equal(priced.rateBookId !== null, true);
  assert.equal(priced.rateBookVersion, 1);
  assert.equal(priced.pricedOn, '2026-06-01');
});

test('vendor offers are surfaced per item and never selected automatically', () => {
  const { application, project } = workspace();
  application.publishRateBook(project.id, liveRates());
  application.recordVendorOffer(project.id, { vendorId: 'v1', vendorName: 'Alpha Interiors', itemCode: 'floor_area', unit: 'm²', amount: 1700, currency: 'INR', validFrom: '2026-01-01', validTo: '2026-12-31', source: { label: 'Quotation', suppliedBy: 'procurement' } });
  application.recordVendorOffer(project.id, { vendorId: 'v2', vendorName: 'Beta Works', itemCode: 'floor_area', unit: 'm²', amount: 1900, currency: 'INR', validFrom: '2026-01-01', validTo: '2026-12-31', source: { label: 'Quotation', suppliedBy: 'procurement' } });

  const offers = application.getVendorOffers(project.id, 'floor_area', { on: '2026-06-01' });
  assert.equal(offers.offers.length, 2);
  assert.equal(offers.selected, undefined, 'nothing is chosen for the operator');
  assert.equal(offers.recommended, undefined);
});

test('selecting a vendor is an audited decision that supersedes, and moves no quantity', () => {
  const repository = createRepository({});
  const { application, project } = workspace({ repository });
  application.publishRateBook(project.id, liveRates());
  const first = application.recordVendorOffer(project.id, { vendorId: 'v1', vendorName: 'Alpha', itemCode: 'floor_area', unit: 'm²', amount: 1700, currency: 'INR', validFrom: '2026-01-01', validTo: '2026-12-31', source: { label: 'Q', suppliedBy: 'p' } });
  const second = application.recordVendorOffer(project.id, { vendorId: 'v2', vendorName: 'Beta', itemCode: 'floor_area', unit: 'm²', amount: 1900, currency: 'INR', validFrom: '2026-01-01', validTo: '2026-12-31', source: { label: 'Q', suppliedBy: 'p' } });

  const quantityBefore = application.getProjectRollup(project.id).lines.find((line) => line.measurement === 'floor_area').quantity;
  const chosen = application.selectVendorOffer(project.id, { itemCode: 'floor_area', offerId: first.id, selectedBy: 'lead', reason: 'preferred supplier' });
  assert.equal(chosen.resolution.supersedes, null);
  const revised = application.selectVendorOffer(project.id, { itemCode: 'floor_area', offerId: second.id, selectedBy: 'lead', reason: 'better lead time' });
  assert.equal(revised.resolution.supersedes, chosen.resolution.id, 'a change of mind supersedes rather than overwrites');

  const quantityAfter = application.getProjectRollup(project.id).lines.find((line) => line.measurement === 'floor_area').quantity;
  assert.equal(quantityAfter, quantityBefore, 'a vendor choice never moves a quantity');
  const kinds = repository.listAudit().map((event) => event.kind);
  assert.ok(kinds.includes('vendor_offer_selected'));
  repository.close();
});

test('selecting an expired offer is refused', () => {
  const { application, project } = workspace();
  const expired = application.recordVendorOffer(project.id, { vendorId: 'v1', vendorName: 'Alpha', itemCode: 'floor_area', unit: 'm²', amount: 1700, currency: 'INR', validFrom: '2025-01-01', validTo: '2025-06-30', source: { label: 'Q', suppliedBy: 'p' } });
  assert.throws(() => application.selectVendorOffer(project.id, { itemCode: 'floor_area', offerId: expired.id, selectedBy: 'lead', on: '2026-06-01' }), /expired|not eligible|valid/i);
});
