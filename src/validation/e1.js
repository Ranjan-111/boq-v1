/* E1 harness: classification coverage (#19 tooling).

   What fraction of entities classify from layer, hatch and block name alone,
   with no vision call. This is the number that decides the product's shape, so
   it uses the real classifier -- `layerCategory` and `blockCategory` straight
   out of src/dxf.js. Reimplementing the rules here would measure the harness
   rather than the product.

   Read-only: nothing here writes, and nothing in the measurement pipeline
   imports it. */

const { parseDxf, layerCategory, blockCategory } = require('../dxf');

/* Reported categories are the four the launch plan asks for. The internal
   vocabulary is finer (door and window are separate rules), so it folds. */
const CATEGORIES = Object.freeze(['wall', 'floor', 'opening', 'furniture']);
const INTERNAL_TO_REPORTED = Object.freeze({
  wall: 'wall', room: 'floor', door: 'opening', window: 'opening', furniture: 'furniture'
});

function categoryOf(internal) {
  return INTERNAL_TO_REPORTED[internal] || null;
}

/* The launch plan's decision bands. Reported as a band with its caveat, never as
   a verdict -- a synthetic corpus cannot decide a product's shape. */
const BANDS = Object.freeze([
  { min: 70, label: 'build as planned', note: 'Classification carries most of the work; the planned product shape holds.' },
  { min: 40, label: 'the studio profile becomes the product', note: 'Classification carries some of the work; per-studio setup is doing the heavy lifting.' },
  { min: 0, label: 'reconsider the segment', note: 'Classification carries too little for the planned shape.' }
]);
function bandFor(percentage) {
  return BANDS.find((band) => percentage >= band.min) || BANDS[BANDS.length - 1];
}

/* A category reports how many entities classified INTO it, not a percentage.
   There is no honest denominator: an unclassified entity has no known category
   -- that is precisely what makes it unclassified -- so a per-category rate
   would only ever count its own successes and read as 100%. A collapse is
   visible as `classified: 0`, and the unclassified entities are reported whole
   against the file. */
const emptyCategoryTable = () => Object.fromEntries(CATEGORIES.map((category) => [category, { classified: 0 }]));

/** One drawing. Reads only; never measures, prices or persists. */
function e1ForFile({ name, content }) {
  let document;
  try {
    document = parseDxf(typeof content === 'string' ? content : content.toString('utf8'));
  } catch (error) {
    /* An unreadable file is a finding, not a crash and not a silent skip. */
    return { name, status: 'unreadable', reason: error.message, total: 0, classified: 0, unclassified: 0, percentage: null, byCategory: emptyCategoryTable(), unclassifiedEntities: [] };
  }
  const byCategory = emptyCategoryTable();
  const unclassifiedEntities = [];
  let total = 0;
  let classified = 0;
  for (const entity of document.entities || []) {
    total += 1;
    const internal = layerCategory(entity.layer) || blockCategory(entity.block);
    const category = categoryOf(internal);
    if (category) {
      classified += 1;
      byCategory[category].classified += 1;
      continue;
    }
    /* Unclassified entities have no category to attribute to, so they are
       counted against the file rather than invented into one. */
    unclassifiedEntities.push({ handle: entity.handle, type: entity.type, layer: entity.layer, block: entity.block || null });
  }
  return {
    name, status: 'read', reason: null,
    total, classified, unclassified: total - classified,
    percentage: total ? (classified / total) * 100 : null,
    byCategory, unclassifiedEntities
  };
}

/**
 * Run over a folder's worth of drawings.
 * @param {{name: string, content: Buffer|string}[]} files
 */
function runE1(files = []) {
  const results = files.map(e1ForFile);
  const readable = results.filter((result) => result.status === 'read');
  const byCategory = emptyCategoryTable();
  let total = 0;
  let classified = 0;
  for (const result of readable) {
    total += result.total;
    classified += result.classified;
    for (const category of CATEGORIES) byCategory[category].classified += result.byCategory[category].classified;
  }
  /* Share of everything that classified, so one category dominating or
     disappearing is visible. Not a success rate for that category. */
  for (const category of CATEGORIES) {
    byCategory[category].shareOfClassified = classified ? byCategory[category].classified / classified : null;
  }
  const percentage = total ? (classified / total) * 100 : null;
  return {
    files: results,
    aggregate: {
      files: results.length,
      readableFiles: readable.length,
      unreadableFiles: results.length - readable.length,
      total, classified, unclassified: total - classified,
      percentage, byCategory,
      band: percentage === null ? null : bandFor(percentage),
      caveat: 'These figures describe the drawings supplied. Run against a synthetic corpus they prove the harness, not a product accuracy claim.'
    }
  };
}

module.exports = { runE1, e1ForFile, aggregateE1: runE1, CATEGORIES, categoryOf, bandFor, BANDS };
