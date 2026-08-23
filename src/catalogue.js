/* Item catalogue (#24).

   The architecture is geometry -> rules -> items -> rates, and `items` was never
   built: rate lookup matched a rate book's itemCode directly against a
   measurement name. That works only if a studio authors its rate book as
   `floor_area`, and it produces exported rows labelled `floor_area`, which is
   not a BOQ anyone can send a client.

   The catalogue is the missing layer. It is studio-scoped, versioned and
   immutable like rulesets and rate books, and mapping is explicit: a measurement
   with no entry is a real gap in the studio's setup, so it surfaces as an
   exception rather than falling back to the raw name. */

class CatalogueError extends Error {}

const CATALOGUE_STATUSES = Object.freeze(['mapped', 'unmapped', 'unit_mismatch']);

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new CatalogueError(`Catalogue ${field} is required.`);
  return value.trim();
}

function createCatalogue({ id, studioId, version, label = '', items = [], locality = null } = {}) {
  requireText(id, 'id');
  requireText(studioId, 'studioId');
  if (!Number.isInteger(version) || version < 1) throw new CatalogueError('Catalogue version must be a positive integer.');
  const normalized = items.map((item) => {
    requireText(item?.code, 'item.code');
    /* The client-facing text. Without it an export is a list of internal
       measurement names. */
    requireText(item?.description, 'item.description');
    requireText(item?.unit, 'item.unit');
    requireText(item?.measurement, 'item.measurement');
    return Object.freeze({
      code: item.code, description: item.description, unit: item.unit,
      measurement: item.measurement, notes: item.notes ?? null,
      sortOrder: Number.isFinite(item.sortOrder) ? item.sortOrder : 1000
    });
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
  return Object.freeze({ id, studioId, version, label, locality, items: Object.freeze(normalized) });
}


/* A built-in default catalogue for the standard DXF measurements. It supplies
   client-facing descriptions -- not prices -- so a drawing can be approved and
   exported without a studio first authoring a catalogue, exactly as the default
   ruleset lets it be measured. A studio's own published catalogue overrides it,
   and a measurement the default does not know still surfaces as unmapped. */
const DEFAULT_CATALOGUE = createCatalogue({
  id: 'catalogue_default', studioId: 'system', version: 1, label: 'Default BOQ items',
  items: [
    { code: 'WALL-PLAN', description: 'Wall footprint, plan area', unit: 'm\u00b2', measurement: 'wall_plan', sortOrder: 10 },
    { code: 'WALL-MAS', description: 'Wall masonry, brick or block in cement mortar', unit: 'm\u00b3', measurement: 'wall_masonry', sortOrder: 20 },
    { code: 'WALL-PLAS', description: 'Wall plaster, cement, both faces', unit: 'm\u00b2', measurement: 'wall_plaster', sortOrder: 30 },
    { code: 'FLOOR-FIN', description: 'Floor finish area', unit: 'm\u00b2', measurement: 'floor_area', sortOrder: 40 },
    { code: 'SKIRTING', description: 'Skirting, to match floor finish', unit: 'm', measurement: 'skirting', sortOrder: 50 },
    { code: 'ROOM-CNT', description: 'Rooms enumerated', unit: 'nos', measurement: 'room_count', sortOrder: 60 },
    { code: 'DOOR-CNT', description: 'Door openings enumerated', unit: 'nos', measurement: 'door_count', sortOrder: 70 },
    { code: 'WIN-CNT', description: 'Window openings enumerated', unit: 'nos', measurement: 'window_count', sortOrder: 80 },
    { code: 'FURN-CNT', description: 'Loose furniture and fixtures enumerated', unit: 'nos', measurement: 'furniture_count', sortOrder: 90 }
  ]
});

/** Every item a measurement maps to. One measurement may legitimately map to
    several -- internal versus external plaster is the obvious case. */
function itemsFor(catalogue, measurement) {
  return catalogue.items.filter((item) => item.measurement === measurement);
}

/**
 * Resolve one BOQ line to its catalogue item. Unit disagreement reuses #15's
 * `unit_mismatch` rather than inventing a second refusal mechanism.
 */
function applyCatalogue(line, catalogue) {
  const effective = catalogue || DEFAULT_CATALOGUE;
  const base = { measurement: line.measurement, catalogueId: effective.id, catalogueVersion: effective.version, item: null };
  catalogue = effective;
  const candidates = itemsFor(catalogue, line.measurement);
  if (!candidates.length) {
    return { ...base, status: 'unmapped', reason: `No catalogue entry maps ${line.measurement} to a BOQ item. Add one so this line can be described to a client; it will not be exported under its internal name.` };
  }
  const matching = candidates.find((item) => item.unit === line.unit);
  if (!matching) {
    return { ...base, status: 'unit_mismatch', reason: `Catalogue item ${candidates[0].code} is priced per ${candidates[0].unit} but ${line.measurement} is measured in ${line.unit}. Mapping is refused rather than reconciling units silently.` };
  }
  return { ...base, status: 'mapped', item: matching };
}

module.exports = { createCatalogue, applyCatalogue, itemsFor, DEFAULT_CATALOGUE, CatalogueError, CATALOGUE_STATUSES };
