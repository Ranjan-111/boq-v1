const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CATALOGUE, applyCatalogue, itemsFor } = require('../src/catalogue');

test('the default catalogue maps every standard DXF measurement', () => {
  for (const measurement of ['wall_plan', 'wall_masonry', 'wall_plaster', 'floor_area', 'skirting', 'room_count', 'door_count', 'window_count', 'furniture_count']) {
    const items = itemsFor(DEFAULT_CATALOGUE, measurement);
    assert.equal(items.length, 1, `${measurement} has a default item`);
    assert.ok(items[0].description.length > 5, `${measurement} has a real description`);
    assert.notEqual(items[0].description, measurement, 'the description is client-facing, not the internal name');
  }
});

test('applyCatalogue falls back to the default when no catalogue is published', () => {
  const mapped = applyCatalogue({ measurement: 'floor_area', unit: 'm²' }, null);
  assert.equal(mapped.status, 'mapped', 'a standard measurement maps out of the box');
  assert.match(mapped.item.description, /floor/i);
  assert.equal(mapped.catalogueId, DEFAULT_CATALOGUE.id);
});

test('a genuinely custom measurement still surfaces as unmapped under the default', () => {
  const mapped = applyCatalogue({ measurement: 'ceiling_area', unit: 'm²' }, null);
  assert.equal(mapped.status, 'unmapped', 'the default does not invent items it does not know');
});

test('a published catalogue overrides the default', () => {
  const { createCatalogue } = require('../src/catalogue');
  const custom = createCatalogue({ id: 'c1', studioId: 's', version: 1, items: [
    { code: 'MY-FLOOR', description: 'Our special flooring', unit: 'm²', measurement: 'floor_area' }
  ] });
  const mapped = applyCatalogue({ measurement: 'floor_area', unit: 'm²' }, custom);
  assert.equal(mapped.item.code, 'MY-FLOOR', 'the studio catalogue wins');
});
