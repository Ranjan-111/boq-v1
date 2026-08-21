/* The conformance corpus (#18).

   Expected quantities are keyed by (fixture, rulesetVersion, assumptionsVersion),
   because a ruleset changes quantities by design. Each expectation records the
   arithmetic that produces it, so a future contributor can see *why* a number is
   what it is rather than only that it changed.

   `clean-plan-v1` reproduces the pre-#6 historical numbers exactly. That is the
   strongest regression signal in the repository: if it moves, either the parser
   or the rule engine has drifted, and it is not a policy change. */

const DEFAULT_ASSUMPTIONS_VERSION = 1;

// clean-plan.dxf, $INSUNITS = 4 (mm). Two rooms, five wall hatches,
// two doors (0.9 m, 0.75 m), two windows (1.2 m, 1.5 m), four furniture blocks.
const CLEAN_GEOMETRY = {
  wall_plan: { value: 6.026, arithmetic: 'Sum of five wall HATCH polygon areas x (0.001 m/mm)^2 x typical multiplier 1.' },
  floor_area: { value: 27.72, arithmetic: 'Two room LWPOLYLINE areas: 16.2 + 11.52 m2.' },
  skirting: { value: 29.8, arithmetic: 'Sum of the two room perimeters x 0.001 m/mm.' },
  room_count: { value: 2, arithmetic: 'Two LWPOLYLINEs on a room layer.' },
  door_count: { value: 2, arithmetic: 'Two INSERTs whose block names start DOOR.' },
  window_count: { value: 2, arithmetic: 'Two INSERTs on a glazing layer.' },
  furniture_count: { value: 4, arithmetic: 'Four furniture INSERTs (SOFA_3S, SOFA_2S, TABLE_DIN, BED_QN).' }
};

const CLEAN_PLAN = {
  fixture: 'clean-plan.dxf',
  tier: 'dxf',
  description: 'A clean single-storey DXF: layers, blocks and hatches all present.',
  expectations: {
    'clean-plan-v1': {
      ...CLEAN_GEOMETRY,
      wall_masonry: { value: 18.078, arithmetic: 'wall_plan 6.026 m2 x wallHeight 3 m.' },
      wall_plaster: {
        value: 157.2,
        arithmetic: 'Centre-line length = 6.026 / wallThickness 0.23 = 26.2 m; x 2 faces x 3 m = 157.2 m2. '
          + 'v1 never deducts openings -- this is the historical pre-#6 number and must not move.'
      }
    },
    'clean-plan-v2': {
      ...CLEAN_GEOMETRY,
      wall_masonry: { value: 18.078, arithmetic: 'Unchanged from v1: deductOpeningsFromMasonry is off in v2.' },
      wall_plaster: {
        value: 143.79,
        arithmetic: 'Gross 157.2 m2 less openings on both faces: '
          + 'door 0.90x2.1x2 = 3.78, door 0.75x2.1x2 = 3.15, window 1.20x1.2x2 = 2.88, window 1.50x1.2x2 = 3.60. '
          + 'Total deduction 13.41 m2 -> 143.79 m2.'
      }
    },
    'clean-plan-v2-net-masonry': {
      ...CLEAN_GEOMETRY,
      wall_masonry: {
        value: 16.53585,
        arithmetic: 'Gross 18.078 m3 less opening voids at wallThickness 0.23 m: '
          + '0.9x2.1x0.23 = 0.4347, 0.75x2.1x0.23 = 0.36225, 1.2x1.2x0.23 = 0.3312, 1.5x1.2x0.23 = 0.414. '
          + 'Total 1.54215 m3 -> 16.53585 m3.'
      },
      wall_plaster: { value: 143.79, arithmetic: 'As clean-plan-v2; the plaster policy is identical.' }
    }
  }
};

// The same drawing assigned to two storeys, the upper one a typical storey x2.
const MULTI_STOREY = {
  fixture: 'clean-plan.dxf',
  tier: 'dxf',
  variant: 'multi-storey',
  description: 'One drawing assigned to a ground storey and to a first storey with a typical multiplier of 2.',
  storeys: [{ name: 'Ground', multiplier: 1 }, { name: 'First', multiplier: 2 }],
  expectations: {
    'clean-plan-v2': {
      floor_area: { value: 83.16, arithmetic: 'Ground 27.72 + First 27.72 x 2 = 83.16 m2. The multiplier is applied once, at measurement.' },
      room_count: { value: 6, arithmetic: '2 rooms + 2 rooms x 2 = 6.' },
      wall_plaster: { value: 431.37, arithmetic: '143.79 + 143.79 x 2 = 431.37 m2; deductions scale with the storey.' }
    }
  }
};

const VECTOR_PDF = {
  fixture: 'vector-plan.pdf',
  tier: 'pdf',
  description: 'A born-digital vector PDF: exact path geometry, no layers or blocks, operator-supplied scale.',
  setup: { drawingUnitsPerMetre: 100 },
  expectations: {
    'clean-plan-v2': {
      floor_area: {
        value: 0.2592, unit: 'm²',
        arithmetic: 'Single native vector path region, area in PDF user units / (100 units per metre)^2. '
          + 'PDF carries no layers or blocks, so only floor_area is measurable at all.'
      }
    }
  }
};

const RASTER_TRACED = {
  fixture: 'raster-200x100.png',
  tier: 'raster',
  description: 'A raster image: no geometry at all until a human calibrates and traces.',
  calibration: { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 }, realDistance: 2, realUnit: 'm' },
  region: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], category: 'floor_area' },
  expectations: {
    'clean-plan-v2': {
      floor_area: {
        value: 2,
        arithmetic: 'Calibration 100 px = 2 m, so 50 px/m. Traced region 100 x 50 px = 2 m x 1 m = 2 m2. '
          + 'Human-traced, so geometrySource is human-traced and never native CAD geometry.'
      }
    }
  }
};

const ROLLUP_MULTI_DOCUMENT = {
  fixture: 'rollup:dxf+pdf+raster',
  tier: 'rollup',
  description: 'A project rollup spanning a DXF, a vector PDF and a traced raster, each on its own sheet.',
  expectations: {
    'clean-plan-v2': {
      floor_area: { value: 29.9792, arithmetic: 'DXF 27.72 + PDF 0.2592 + raster 2 = 29.9792 m2, summed across three source documents.' },
      wall_plaster: { value: 143.79, arithmetic: 'Only the DXF can measure plaster; PDF and raster contribute nothing to it.' },
      door_count: { value: 2, arithmetic: 'Only the DXF carries block-identified doors.' }
    }
  }
};

const CORPUS = [CLEAN_PLAN, MULTI_STOREY, VECTOR_PDF, RASTER_TRACED, ROLLUP_MULTI_DOCUMENT];

/* Adversarial cases assert behaviour, not numbers: a corrupted drawing must
   never yield a confident BOQ. */
const ADVERSARIAL = [
  { fixture: 'adversarial/no-insunits.dxf', expect: 'halt', reason: 'which drawing unit', description: 'No $INSUNITS declaration.' },
  { fixture: 'adversarial/truncated.dxf', expect: 'halt', reason: 'malformed dxf sections', description: 'Truncated mid-file.' },
  { fixture: 'adversarial/scaled-10x.dxf', expect: 'flagged', flag: 'implausible magnitude', measurements: ['floor_area'], description: 'Geometry exported at ten times true scale.' },
  { fixture: 'adversarial/garbage-layers.dxf', expect: 'degraded', notMeasurable: ['wall_plan', 'floor_area', 'wall_plaster', 'skirting', 'room_count'], surviving: { door_count: 2, window_count: 2, furniture_count: 4 }, description: 'Layer names carry no meaning; block names intact.' },
  { fixture: 'adversarial/no-hatch.dxf', expect: 'degraded', notMeasurable: ['wall_plan', 'wall_masonry', 'wall_plaster'], surviving: { floor_area: 27.72, room_count: 2 }, description: 'Wall hatches absent.' },
  { fixture: 'adversarial/exploded-furniture.dxf', expect: 'degraded', notMeasurable: ['furniture_count'], surviving: { floor_area: 27.72, door_count: 2 }, minimumUnclassified: 4, description: 'Furniture exploded to bare polylines.' },
  { fixture: 'adversarial/garbage-and-exploded.dxf', expect: 'degraded', notMeasurable: ['wall_plan', 'floor_area', 'wall_plaster', 'furniture_count', 'room_count', 'skirting', 'wall_masonry'], surviving: { door_count: 2, window_count: 2 }, minimumUnclassified: 4, description: 'Worst case: meaningless layers and exploded furniture together.' }
];

module.exports = { CORPUS, ADVERSARIAL, DEFAULT_ASSUMPTIONS_VERSION };
