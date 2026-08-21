const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogue, applyCatalogue, itemsFor, CatalogueError, CATALOGUE_STATUSES } = require('../src/catalogue');
const { normaliseLocality, localityMatches } = require('../src/rates');

const catalogue = (overrides = {}) => createCatalogue({
  id: 'catalogue_0001', studioId: 'studio_alpha', version: 1, label: 'Studio catalogue',
  items: [
    { code: 'FIN-FL-001', description: 'Vitrified tile flooring 600x600, laid and polished', unit: 'm²', measurement: 'floor_area', sortOrder: 10 },
    { code: 'FIN-WL-002', description: 'Cement plaster 12mm to internal walls, finished smooth', unit: 'm²', measurement: 'wall_plaster', sortOrder: 20 },
    { code: 'STR-WL-001', description: 'Brick masonry in cement mortar 1:6', unit: 'm³', measurement: 'wall_masonry', sortOrder: 5 }
  ], ...overrides
});

test('a catalogue item carries client-facing text, not a measurement name', () => {
  const item = itemsFor(catalogue(), 'floor_area')[0];
  assert.equal(item.code, 'FIN-FL-001');
  assert.match(item.description, /Vitrified tile/);
  assert.notEqual(item.description, 'floor_area', 'nobody can send a client a row that says floor_area');
});

test('a catalogue is versioned, immutable and studio-scoped', () => {
  const first = catalogue();
  const original = first.items[0].description;
  first.items[0].description = 'tampered';
  first.version = 9;
  assert.equal(first.items[0].description, original);
  assert.equal(first.version, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.studioId, 'studio_alpha');
});

test('an item without a description or code is refused', () => {
  assert.throws(() => createCatalogue({ id: 'c', studioId: 's', version: 1, items: [{ code: 'X', unit: 'm²', measurement: 'floor_area' }] }), CatalogueError);
  assert.throws(() => createCatalogue({ id: 'c', studioId: 's', version: 1, items: [{ description: 'D', unit: 'm²', measurement: 'floor_area' }] }), CatalogueError);
  assert.throws(() => createCatalogue({ id: 'c', studioId: 's', version: 0, items: [] }), CatalogueError);
});

test('one measurement may map to several items', () => {
  const many = catalogue({ items: [
    { code: 'FIN-WL-002', description: 'Cement plaster to internal walls', unit: 'm²', measurement: 'wall_plaster' },
    { code: 'FIN-WL-003', description: 'Cement plaster to external walls', unit: 'm²', measurement: 'wall_plaster' }
  ] });
  assert.equal(itemsFor(many, 'wall_plaster').length, 2, 'internal and external are different items');
});

test('an unmapped measurement is reported, never silently passed through as a raw name', () => {
  const result = applyCatalogue({ measurement: 'skirting', quantity: 29.8, unit: 'm' }, catalogue());
  assert.equal(result.status, 'unmapped');
  assert.equal(result.item, null);
  assert.match(result.reason, /no catalogue entry|not mapped/i);
  assert.equal(result.description, undefined, 'no fallback description is invented');
  assert.ok(CATALOGUE_STATUSES.includes(result.status));
});

test('a unit mismatch is refused with the same mechanism #15 uses', () => {
  const wrong = catalogue({ items: [{ code: 'X-1', description: 'Something per metre', unit: 'm', measurement: 'floor_area' }] });
  const result = applyCatalogue({ measurement: 'floor_area', quantity: 27.72, unit: 'm²' }, wrong);
  assert.equal(result.status, 'unit_mismatch', 'the same status name #15 already uses');
  assert.equal(result.item, null);
  assert.match(result.reason, /unit/i);
});

test('a mapped measurement resolves to its item', () => {
  const result = applyCatalogue({ measurement: 'floor_area', quantity: 27.72, unit: 'm²' }, catalogue());
  assert.equal(result.status, 'mapped');
  assert.equal(result.item.code, 'FIN-FL-001');
  assert.equal(result.catalogueVersion, 1);
});

test('items sort by their declared order, not by measurement name', () => {
  const ordered = catalogue().items.map((item) => item.code);
  assert.deepEqual(ordered, ['STR-WL-001', 'FIN-FL-001', 'FIN-WL-002'], 'sortOrder 5, 10, 20');
});

test('locality matching survives Bengaluru vs Bangalore', () => {
  assert.equal(normaliseLocality('Bengaluru'), normaliseLocality('Bangalore'));
  assert.equal(normaliseLocality('  BANGALORE '), 'bengaluru');
  assert.equal(localityMatches('Bengaluru', 'Bangalore'), true);
  assert.equal(localityMatches('New Delhi', 'Delhi'), true);
  assert.equal(localityMatches('Bengaluru', 'Chennai'), false);
  assert.equal(localityMatches(null, 'Chennai'), true, 'an unscoped rate applies anywhere');
});
