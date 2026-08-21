const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { createRepository } = require('../src/repository');
const { buildArtefact, encodeCsv, encodeXlsx, TIERS, tierOf } = require('../src/export');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);
const png = readFileSync(`${__dirname}/fixtures/raster-200x100.png`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

const RATES = (rates) => ({
  studioId: 'studio_alpha', label: 'Studio rates', currency: 'INR', locality: 'Bengaluru',
  source: { label: 'Studio historical prices', suppliedBy: 'commercial lead' }, rates
});
const LIVE_RATES = [
  { itemCode: 'FIN-FL-001', unit: 'm²', amount: 1800, validFrom: '2026-01-01', validTo: '2026-12-31' },
  { itemCode: 'FIN-WL-002', unit: 'm²', amount: 420, validFrom: '2026-01-01', validTo: '2026-12-31' }
];
const CATALOGUE = (items) => ({ studioId: 'studio_alpha', label: 'Studio catalogue', items });
const FULL_ITEMS = [
  { code: 'FIN-FL-001', description: 'Vitrified tile flooring 600x600, laid and polished', unit: 'm²', measurement: 'floor_area', sortOrder: 10 },
  { code: 'FIN-WL-002', description: 'Cement plaster 12mm to internal walls', unit: 'm²', measurement: 'wall_plaster', sortOrder: 20 },
  { code: 'STR-WL-001', description: 'Brick masonry in cement mortar 1:6', unit: 'm³', measurement: 'wall_masonry', sortOrder: 5 },
  { code: 'FIN-SK-001', description: 'Skirting, 100mm, to match flooring', unit: 'm', measurement: 'skirting', sortOrder: 30 },
  { code: 'GEN-RM-001', description: 'Rooms enumerated', unit: 'nos', measurement: 'room_count', sortOrder: 40 },
  { code: 'GEN-DR-001', description: 'Door openings enumerated', unit: 'nos', measurement: 'door_count', sortOrder: 50 },
  { code: 'GEN-WN-001', description: 'Window openings enumerated', unit: 'nos', measurement: 'window_count', sortOrder: 60 },
  { code: 'GEN-FR-001', description: 'Loose furniture enumerated', unit: 'nos', measurement: 'furniture_count', sortOrder: 70 },
  { code: 'STR-WP-001', description: 'Wall footprint, plan area', unit: 'm²', measurement: 'wall_plan', sortOrder: 1 }
];

function approvedProject({ items = FULL_ITEMS, rates = LIVE_RATES, ...options } = {}) {
  const application = sync(options);
  const project = application.createProject({ name: 'Export project' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  application.startProcessing(source.id);
  application.publishCatalogue(project.id, CATALOGUE(items));
  application.publishRateBook(project.id, RATES(rates));
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'quantity surveyor', on: '2026-06-01' });
  return { application, project, boqVersionId };
}

test('an unmapped measurement raises an exception instead of exporting a raw name', () => {
  const application = sync();
  const project = application.createProject({ name: 'Partial catalogue' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  application.startProcessing(source.id);
  application.publishCatalogue(project.id, CATALOGUE(FULL_ITEMS.filter((item) => item.measurement !== 'skirting')));
  const queue = application.getExceptionQueue(project.id, { on: '2026-06-01' });
  const unmapped = queue.exceptions.find((exception) => exception.type === 'unmapped_measurement');
  assert.ok(unmapped, 'the gap in the studio setup is surfaced');
  assert.equal(unmapped.severity, 'blocking');
  assert.equal(unmapped.measurement, 'skirting');
  assert.match(unmapped.raisedBecause, /catalogue/i);
});

test('export is refused for a version that is not approved', () => {
  const application = sync();
  const project = application.createProject({ name: 'Draft' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, projectId: project.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  application.startProcessing(source.id);
  application.publishCatalogue(project.id, CATALOGUE(FULL_ITEMS));
  application.publishRateBook(project.id, RATES(LIVE_RATES));
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  assert.throws(() => application.exportBoq(boqVersionId, { format: 'csv' }), /approved/i);
});

test('an approved version exports, and every row carries code, description, unit, quantity, rate, amount', () => {
  const { application, boqVersionId } = approvedProject();
  const result = application.exportBoq(boqVersionId, { format: 'csv' });
  assert.equal(result.format, 'csv');
  const text = result.content.toString('utf8');
  assert.match(text, /FIN-FL-001/);
  assert.match(text, /Vitrified tile flooring/);
  assert.ok(!/\bfloor_area\b/.test(text.split('\n').filter((line) => line.startsWith('FIN-FL')).join('\n')), 'no raw measurement name in a priced row');
  const header = text.split('\n').find((line) => line.startsWith('Item code'));
  assert.ok(header, 'the table header exists below the stamp block');
  for (const column of ['Item code', 'Description', 'Unit', 'Quantity', 'Rate', 'Amount', 'Tier']) {
    assert.ok(header.includes(column), `header carries ${column}`);
  }
});

test('the stamp carries every version the number depends on', () => {
  const { application, boqVersionId } = approvedProject();
  const result = application.exportBoq(boqVersionId, { format: 'csv' });
  const stamp = result.artefact.stamp;
  for (const field of ['approvedBy', 'approvedAt', 'rulesetVersion', 'assumptionsVersion', 'rateBookVersion', 'catalogueVersion', 'parserVersion', 'tiers', 'currency']) {
    assert.ok(stamp[field] !== undefined && stamp[field] !== null, `stamp carries ${field}`);
  }
  assert.equal(stamp.approvedBy, 'quantity surveyor');
  const text = result.content.toString('utf8');
  assert.match(text, /quantity surveyor/, 'and it reaches the document');
  assert.match(text, /clean-plan-v2/);
});

test('re-export is byte-identical after new rulesets, rate books and catalogues are published', () => {
  const { application, project, boqVersionId } = approvedProject();
  const first = application.exportBoq(boqVersionId, { format: 'csv' });

  application.publishRateBook(project.id, RATES([{ itemCode: 'FIN-FL-001', unit: 'm²', amount: 9999, validFrom: '2026-01-01', validTo: '2026-12-31' }]));
  application.publishCatalogue(project.id, CATALOGUE(FULL_ITEMS.map((item) => ({ ...item, description: `REVISED ${item.description}` }))));

  const second = application.exportBoq(boqVersionId, { format: 'csv' });
  assert.equal(digest(second.content), digest(first.content), 'the approved artefact does not move under it');
  // the superseded rate is 9999 per unit: it must not appear as a rate column value
  const rateColumns = second.content.toString('utf8').split('\n')
    .filter((line) => /^[A-Z]{3}-/.test(line)).map((line) => line.split(',').slice(-6, -5)[0]);
  assert.equal(rateColumns.includes('9999'), false, 'the newly published rate did not leak in');
  assert.equal(second.content.toString('utf8').includes('REVISED'), false);
});

test('export is refused when a dependency was superseded after approval', () => {
  const { application, project, boqVersionId } = approvedProject();
  application.exportBoq(boqVersionId, { format: 'csv' });
  application.recordQuantityAffectingResolution(project.id, { action: 'adjust_assumptions', values: { wallHeight: 3.4 }, reason: 'survey', resolvedBy: 'lead' });
  assert.throws(() => application.exportBoq(boqVersionId, { format: 'csv' }), /stale|superseded|re-approve/i);
});

test('a Tier C traced line is distinguishable from a Tier A measured line in the document', () => {
  const application = sync();
  const project = application.createProject({ name: 'Mixed tiers' });
  const building = application.createBuilding({ projectId: project.id, name: 'B' });
  const storey = application.createStorey({ buildingId: building.id, name: 'G' });
  const scope = { projectId: project.id, buildingId: building.id, storeyId: storey.id, studioId: 'studio_alpha' };
  const dxf = application.createSourceDocument({ filename: 'plan.dxf', content: cleanPlan, ...scope, sourceSheet: 'A-DXF' });
  application.startProcessing(dxf.id);
  const raster = application.createSourceDocument({ filename: 'plan.png', content: png, ...scope, sourceSheet: 'A-PNG' });
  const rasterRun = application.startProcessing(raster.id);
  application.calibrateRasterPage(rasterRun.id, 'page_1', { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' });
  const region = application.createRasterRegion(rasterRun.id, 'page_1', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' });
  application.confirmRasterRegion(rasterRun.id, 'page_1', region.region.id);

  const rollup = application.getProjectRollup(project.id);
  const floor = rollup.lines.find((line) => line.measurement === 'floor_area');
  const tier = tierOf(floor, rollup.sourceObjects);
  assert.equal(tier.tier, 'C', 'a line mixing traced raster with CAD is reported at the weakest tier');
  assert.match(tier.note, /traced|estimate|not measured/i);
  assert.notEqual(TIERS.A.note, TIERS.C.note, 'the tiers read differently in a document');
});

test('an unpriced line has no amount and the total declares itself incomplete', () => {
  // rates cover only flooring; everything else is mapped but unpriced
  const { application, boqVersionId } = approvedProject({ rates: [LIVE_RATES[0]] });
  const result = application.exportBoq(boqVersionId, { format: 'csv' });
  const artefact = result.artefact;
  const unpriced = artefact.rows.find((row) => row.itemCode === 'STR-WL-001');
  assert.ok(unpriced, 'the masonry row exists');
  assert.equal(unpriced.amount, null);
  assert.equal(unpriced.rate, null);
  assert.equal(artefact.total.complete, false);
  assert.ok(artefact.total.unpricedLines > 0);
  const text = result.content.toString('utf8');
  assert.match(text, /incomplete/i, 'the document says so rather than presenting a partial figure as a total');
});

test('the printed total equals the sum of the printed row amounts', () => {
  // An estimator must be able to tie the column by hand; "the total doesn't add
  // up" is indefensible to a contractor. The exact figure is kept alongside.
  const { application, boqVersionId } = approvedProject({
    rates: [{ itemCode: 'FIN-FL-001', unit: 'm²', amount: 1, validFrom: '2026-01-01', validTo: '2026-12-31' }]
  });
  const result = application.exportBoq(boqVersionId, { format: 'csv' });
  const artefact = result.artefact;
  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const priced = artefact.rows.filter((row) => Number.isFinite(row.amount));
  const sumOfPrinted = round(priced.reduce((sum, row) => sum + round(row.amount), 0));
  assert.equal(artefact.total.amount, sumOfPrinted, 'the printed total ties to the printed column');

  const exact = priced.reduce((sum, row) => sum + row.amount, 0);
  assert.equal(artefact.total.exactAmount, exact, 'the exact figure is retained');
  assert.equal(artefact.total.exactRounded, round(exact));

  const sidecar = JSON.parse(result.provenance.toString('utf8'));
  assert.equal(sidecar.total.exactAmount, exact, 'and reaches the provenance sidecar');
});

test('a total that cannot tie by hand is not printed', () => {
  // three rows of 0.125 print as 0.13 each: the printed total must be 0.39, the
  // figure someone adding the column gets, not the accumulate-exact 0.38.
  const { buildArtefact } = require('../src/export');
  const stamp = { approvedBy: 'a', approvedAt: 't', rulesetVersion: 'r', assumptionsVersion: 1, rateBookVersion: 1, catalogueVersion: 1, parserVersion: 'p', tiers: ['A'], currency: 'INR', pricedOn: '2026-06-01' };
  const lines = [0, 1, 2].map((index) => ({ measurement: `m${index}`, itemCode: `C${index}`, description: 'd', unit: 'm', quantity: 0.125, rate: 1, amount: 0.125, measurementStatus: 'measured', pricingStatus: 'priced', sortOrder: index, provenance: { contributions: [] } }));
  const artefact = buildArtefact({ boqVersionId: 'v', projectName: 'P', catalogue: null, sourceObjects: [], stamp, lines });
  assert.equal(artefact.total.amount, 0.39, 'ties to 0.13 + 0.13 + 0.13');
  assert.equal(artefact.total.exactRounded, 0.38, 'while the exact figure is still recorded');
});

test('xlsx is the same artefact in a different encoding', () => {
  const { application, boqVersionId } = approvedProject();
  const csv = application.exportBoq(boqVersionId, { format: 'csv' });
  const xlsx = application.exportBoq(boqVersionId, { format: 'xlsx' });
  assert.deepEqual(xlsx.artefact.rows, csv.artefact.rows, 'one artefact, two encodings');
  assert.deepEqual(xlsx.artefact.stamp, csv.artefact.stamp);
  assert.equal(xlsx.content.subarray(0, 2).toString('latin1'), 'PK', 'a real zip container');
  assert.equal(digest(application.exportBoq(boqVersionId, { format: 'xlsx' }).content), digest(xlsx.content), 'and it re-exports byte-identically too');
});

test('a provenance sidecar traces every exported number back to source objects', () => {
  const { application, boqVersionId } = approvedProject();
  const result = application.exportBoq(boqVersionId, { format: 'csv' });
  const sidecar = JSON.parse(result.provenance.toString('utf8'));
  assert.equal(sidecar.boqVersionId, boqVersionId);
  assert.ok(sidecar.stamp.approvedBy);
  const floor = sidecar.lines.find((line) => line.itemCode === 'FIN-FL-001');
  assert.ok(floor.contributions.length > 0);
  const objectIds = new Set(sidecar.sourceObjects.map((object) => object.sourceObjectId));
  assert.ok(floor.contributions.every((contribution) => objectIds.has(contribution.sourceObjectId)), 'every contribution resolves inside the sidecar');
  const object = sidecar.sourceObjects.find((candidate) => candidate.sourceObjectId === floor.contributions[0].sourceObjectId);
  assert.ok(Array.isArray(object.bounds) && object.bounds.length === 4, 'with geometry, so it is traceable without the application');
});

test('an unsupported format is refused rather than silently defaulting', () => {
  const { application, boqVersionId } = approvedProject();
  assert.throws(() => application.exportBoq(boqVersionId, { format: 'pdf' }), /format/i);
});
