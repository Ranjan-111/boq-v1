/* Versioned measurement rules (issue #6).

   A registry of plain JavaScript functions keyed by ruleId, and named rulesets
   that select rules and set policy. Deliberately not a formula DSL: for V1,
   functions are testable, debuggable and diffable, and a DSL would be a second
   language to maintain before anyone has asked for one.

   The split that matters: geometry is fact, rules are policy. Running a
   different ruleset over identical geometry may produce different quantities,
   and that is correct behaviour rather than a defect. */

class RuleError extends Error {}

/* Assumptions the drawing cannot tell us. A plan view gives an opening's width
   but never its height, and wall height/thickness are project conventions, so
   these are operator-owned inputs with defaults -- not constants buried in a
   measurement function. */
const ASSUMPTION_DEFINITIONS = Object.freeze({
  wallHeight: { unit: 'm', default: 3, min: 0.1, max: 30, description: 'Floor-to-soffit wall height used for masonry and plaster.' },
  wallThickness: { unit: 'm', default: 0.23, min: 0.01, max: 2, description: 'Nominal wall thickness used to derive centre-line length from plan area.' },
  doorOpeningHeight: { unit: 'm', default: 2.1, min: 0.1, max: 10, description: 'Structural door opening height, deducted from wall finishes.' },
  windowOpeningHeight: { unit: 'm', default: 1.2, min: 0.1, max: 10, description: 'Structural window opening height, deducted from wall finishes.' }
});

const DEFAULT_ASSUMPTIONS = Object.freeze(Object.fromEntries(
  Object.entries(ASSUMPTION_DEFINITIONS).map(([name, definition]) => [name, definition.default])
));

function normalizeAssumptions(values = {}) {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new RuleError('Assumptions must be an object.');
  for (const name of Object.keys(values)) {
    if (!ASSUMPTION_DEFINITIONS[name]) throw new RuleError(`Unknown assumption "${name}". Known assumptions: ${Object.keys(ASSUMPTION_DEFINITIONS).join(', ')}.`);
  }
  const resolved = { ...DEFAULT_ASSUMPTIONS };
  for (const [name, definition] of Object.entries(ASSUMPTION_DEFINITIONS)) {
    if (values[name] === undefined || values[name] === null) continue;
    const value = Number(values[name]);
    if (!Number.isFinite(value)) throw new RuleError(`Assumption ${name} must be a finite number.`);
    if (value < definition.min || value > definition.max) throw new RuleError(`Assumption ${name} must be between ${definition.min} and ${definition.max} ${definition.unit}.`);
    resolved[name] = value;
  }
  return Object.freeze(resolved);
}

/* An opening's width is the long axis of its block footprint in plan. Taking
   the longer of the two extents is rotation independent, so a door drawn along
   Y measures the same as one drawn along X. Requires resolved block geometry --
   an unresolved block reference is a point and cannot size an opening. */
function openingWidth(entity, context) {
  const object = context.objectFor(entity);
  if (!object || object.geometryResolution !== 'block-definition' || !object.bounds) return null;
  const [minX, minY, maxX, maxY] = object.bounds;
  const width = Math.max(maxX - minX, maxY - minY) * context.toMetres;
  return width > 0 ? width : null;
}

function openings(context) {
  const entries = [];
  for (const [entity, height] of [
    ...context.doors.map((door) => [door, context.assumptions.doorOpeningHeight]),
    ...context.windows.map((window) => [window, context.assumptions.windowOpeningHeight])
  ]) {
    const width = openingWidth(entity, context);
    if (width === null) continue;
    /* A typical storey repeated N times has N times the openings, exactly as it
       has N times the wall. Scaling the gross but not the deduction understates
       every deduction on a multiplied storey. */
    entries.push({ entity, width, height, area: width * height * context.typicalMultiplier });
  }
  return entries;
}

const RULES = Object.freeze({
  'dxf-wall-plan-v1': {
    id: 'dxf-wall-plan-v1', measurement: 'wall_plan', label: 'Wall footprint (plan)', unit: 'm²', evidence: ['layer', 'hatch'],
    compute: (context) => context.walls.map((entity) => ({ entity, sign: 'add', quantity: context.areaOf(entity) }))
  },
  'dxf-wall-masonry-v1': {
    id: 'dxf-wall-masonry-v1', measurement: 'wall_masonry', label: 'Wall masonry volume', unit: 'm³', evidence: ['layer', 'hatch'],
    compute: (context) => {
      const added = context.walls.map((entity) => ({ entity, sign: 'add', quantity: context.areaOf(entity) * context.assumptions.wallHeight }));
      /* Whether an opening is a void in the masonry or is ignored as a minor
         item is a measurement convention that differs between practices, so it
         is a ruleset setting rather than a decision baked into this function. */
      if (!context.settings.deductOpeningsFromMasonry) return added;
      const deducted = openings(context).map(({ entity, area }) => ({ entity, sign: 'deduct', quantity: area * context.assumptions.wallThickness }));
      return [...added, ...deducted];
    }
  },
  'dxf-wall-plaster-v1': {
    id: 'dxf-wall-plaster-v1', measurement: 'wall_plaster', label: 'Wall plaster (both faces)', unit: 'm²', evidence: ['layer', 'hatch'],
    compute: (context) => {
      const centreLength = (entity) => context.areaOf(entity) / context.assumptions.wallThickness;
      const added = context.walls.map((entity) => ({ entity, sign: 'add', quantity: centreLength(entity) * 2 * context.assumptions.wallHeight }));
      if (!context.settings.deductOpeningsFromPlaster) return added;
      /* Plaster is measured to both faces, so an opening removes its area twice. */
      const deducted = openings(context).map(({ entity, area }) => ({ entity, sign: 'deduct', quantity: area * 2 }));
      return [...added, ...deducted];
    }
  },
  'dxf-floor-area-v1': {
    id: 'dxf-floor-area-v1', measurement: 'floor_area', label: 'Floor finish area', unit: 'm²', evidence: ['layer', 'geometry'],
    compute: (context) => context.rooms.map((entity) => ({ entity, sign: 'add', quantity: context.areaOf(entity) }))
  },
  'dxf-skirting-v1': {
    id: 'dxf-skirting-v1', measurement: 'skirting', label: 'Skirting length', unit: 'm', evidence: ['layer', 'geometry'],
    compute: (context) => context.rooms.map((entity) => ({ entity, sign: 'add', quantity: context.perimeterOf(entity) }))
  },
  'dxf-room-count-v1': {
    id: 'dxf-room-count-v1', measurement: 'room_count', label: 'Room count', unit: 'nos', evidence: ['layer', 'geometry'],
    compute: (context) => context.rooms.map((entity) => ({ entity, sign: 'add', quantity: context.typicalMultiplier }))
  },
  'dxf-door-count-v1': {
    id: 'dxf-door-count-v1', measurement: 'door_count', label: 'Doors', unit: 'nos', evidence: ['layer', 'block'],
    compute: (context) => context.doors.map((entity) => ({ entity, sign: 'add', quantity: context.typicalMultiplier }))
  },
  'dxf-window-count-v1': {
    id: 'dxf-window-count-v1', measurement: 'window_count', label: 'Windows', unit: 'nos', evidence: ['layer', 'block'],
    compute: (context) => context.windows.map((entity) => ({ entity, sign: 'add', quantity: context.typicalMultiplier }))
  },
  'dxf-furniture-count-v1': {
    id: 'dxf-furniture-count-v1', measurement: 'furniture_count', label: 'Furniture items', unit: 'nos', evidence: ['layer', 'block'],
    compute: (context) => context.furniture.map((entity) => ({ entity, sign: 'add', quantity: context.typicalMultiplier }))
  }
});

const DXF_RULE_IDS = Object.freeze(Object.keys(RULES));

/* A ruleset is a named, versioned selection of rules plus policy settings.
   Rulesets are immutable: a policy change is a new version, never an edit, so a
   quantity measured under one can always be reproduced. */
const RULESETS = Object.freeze({
  'clean-plan-v1': Object.freeze({
    version: 'clean-plan-v1',
    label: 'Clean plan v1 (gross wall finishes)',
    note: 'The original ruleset. Openings are counted but never deducted. Kept selectable so quantities measured under it stay reproducible.',
    ruleIds: DXF_RULE_IDS,
    settings: Object.freeze({ deductOpeningsFromPlaster: false, deductOpeningsFromMasonry: false })
  }),
  'clean-plan-v2': Object.freeze({
    version: 'clean-plan-v2',
    label: 'Clean plan v2 (net plaster, gross masonry)',
    note: 'Door and window openings are deducted from plaster on both faces. Masonry stays gross, which is the common convention for small openings.',
    ruleIds: DXF_RULE_IDS,
    settings: Object.freeze({ deductOpeningsFromPlaster: true, deductOpeningsFromMasonry: false })
  }),
  'clean-plan-v2-net-masonry': Object.freeze({
    version: 'clean-plan-v2-net-masonry',
    label: 'Clean plan v2 (net plaster, net masonry)',
    note: 'As v2, and openings are also treated as voids in the masonry volume.',
    ruleIds: DXF_RULE_IDS,
    settings: Object.freeze({ deductOpeningsFromPlaster: true, deductOpeningsFromMasonry: true })
  })
});

/* Order-of-magnitude sanity, per source object rather than per total. A drawing
   exported at the wrong scale still measures cleanly -- the arithmetic is valid,
   the input was not -- so the only way to catch it is to ask whether a single
   room or wall could plausibly be this size. Bands are deliberately loose: they
   exist to catch a 10x scale error, not to second-guess an unusual building. */
const PLAUSIBILITY_BANDS = Object.freeze({
  floor_area: { max: 500, unit: 'm\u00b2', subject: 'a single room' },
  wall_plan: { max: 100, unit: 'm\u00b2', subject: 'a single wall' },
  wall_masonry: { max: 300, unit: 'm\u00b3', subject: 'a single wall' },
  wall_plaster: { max: 3000, unit: 'm\u00b2', subject: 'a single wall' },
  skirting: { max: 200, unit: 'm', subject: 'a single room' }
});

function checkPlausibility(measurement, contributions = []) {
  const band = PLAUSIBILITY_BANDS[measurement];
  if (!band) return null;
  const reasons = [];
  for (const contribution of contributions) {
    if (contribution.sign !== 'add') continue;
    if (contribution.quantity > band.max) {
      reasons.push(`${contribution.quantity} ${band.unit} is an implausible magnitude for ${band.subject} (over ${band.max} ${band.unit}); check the drawing's scale and units.`);
    }
  }
  return reasons.length ? { flagged: true, reasons: [...new Set(reasons)].slice(0, 5), band: { ...band } } : null;
}

const DEFAULT_RULESET_VERSION = 'clean-plan-v2';

function getRuleset(version = DEFAULT_RULESET_VERSION) {
  const ruleset = RULESETS[version];
  if (!ruleset) throw new RuleError(`Unknown ruleset "${version}". Known rulesets: ${Object.keys(RULESETS).join(', ')}.`);
  return ruleset;
}
function getRule(ruleId) {
  const rule = RULES[ruleId];
  if (!rule) throw new RuleError(`Unknown rule "${ruleId}".`);
  return rule;
}
function listRulesets() {
  return Object.values(RULESETS).map(({ version, label, note, settings, ruleIds }) => ({ version, label, note, settings: { ...settings }, ruleIds: [...ruleIds] }));
}

module.exports = {
  RuleError, RULES, RULESETS, DXF_RULE_IDS, DEFAULT_RULESET_VERSION,
  ASSUMPTION_DEFINITIONS, DEFAULT_ASSUMPTIONS, PLAUSIBILITY_BANDS, checkPlausibility,
  normalizeAssumptions, getRuleset, getRule, listRulesets, openingWidth, openings
};
