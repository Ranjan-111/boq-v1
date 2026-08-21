/* E0 harness: ground-truth comparison (#19 tooling).

   A real DXF plus a hand-prepared takeoff, run through the real pipeline, and
   the delta reported per category. The output extends #18's four-outcome ledger
   rather than inventing a second vocabulary -- the same buckets, now measured
   against a real answer instead of a synthetic fixture.

   No accuracy percentage is computed. Per-category deltas only. #18 refused a
   headline figure because a synthetic corpus cannot support one; against a
   single studio's drawings it would be an even worse claim, because it would
   look like it could. */

const { createApplication } = require('../application');
const { classify, OUTCOMES } = require('../conformance');
const { categoryOf, CATEGORIES } = require('./e1');

class GroundTruthError extends Error {}

/* Deliberately the simplest thing a non-engineer can fill in from their own BOQ:
   one row per quantity, no nesting, no codes to look up. */
function parseGroundTruth(text, format = 'csv') {
  if (format === 'json') {
    let payload;
    try { payload = JSON.parse(text); } catch (error) { throw new GroundTruthError(`Ground truth is not valid JSON: ${error.message}`); }
    const rows = Array.isArray(payload) ? payload : payload.rows;
    if (!Array.isArray(rows)) throw new GroundTruthError('Ground truth JSON needs a `rows` array.');
    return { source: payload.source ?? null, preparedBy: payload.preparedBy ?? null, rows: rows.map(normalizeRow) };
  }
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new GroundTruthError('Ground truth file is empty.');
  const header = lines[0].split(',').map((cell) => cell.trim().toLowerCase());
  const required = ['measurement', 'quantity'];
  for (const column of required) {
    if (!header.includes(column)) throw new GroundTruthError(`Ground truth CSV needs a "${column}" column. Found: ${header.join(', ')}.`);
  }
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((column, index) => { row[column] = (cells[index] ?? '').trim(); });
    return normalizeRow(row);
  });
  return { source: null, preparedBy: null, rows };
}

function normalizeRow(row) {
  const measurement = String(row.measurement ?? '').trim();
  if (!measurement) throw new GroundTruthError('Every ground-truth row needs a measurement name.');
  /* A blank cell is not zero. Number('') is 0, which would turn an unfilled row
     into a claim that the studio measured nothing. */
  const raw = String(row.quantity ?? '').trim();
  if (!raw) throw new GroundTruthError(`Ground-truth row "${measurement}" has a blank quantity. A blank is not zero -- leave the row out instead.`);
  const quantity = Number(raw);
  if (!Number.isFinite(quantity)) throw new GroundTruthError(`Ground-truth row "${measurement}" has an unusable quantity "${raw}".`);
  return { measurement, quantity, unit: (row.unit ?? '').trim() || null, notes: (row.notes ?? '').trim() || null };
}

/** Run one drawing through the real pipeline, read-only. */
function measureThroughPipeline({ name, content }) {
  const application = createApplication({ schedule: (callback) => callback() });
  const project = application.createProject({ name: `E0 ${name}` });
  const source = application.createSourceDocument({ filename: name, content, projectId: project.id, sourceSheet: name, studioId: 'e0_harness' });
  const run = application.getRun(application.startProcessing(source.id).id);
  return { run, lines: run.boq?.lines || [] };
}

function runE0({ file, groundTruth, tolerance = 1e-6 }) {
  let pipeline;
  try {
    pipeline = measureThroughPipeline(file);
  } catch (error) {
    return {
      file: file.name, status: 'unreadable', reason: error.message,
      comparisons: [], counts: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
      byCategory: {}, note: 'The drawing could not be read, so no comparison was possible.'
    };
  }
  const { run, lines } = pipeline;
  /* Something independent of a given line stopping the run reaching a BOQ is
     what separates a wrong number a human will still be stopped by from one that
     would ship. Same rule #18 uses. */
  const gated = run.status !== 'completed' || run.exportable === false;
  const byMeasurement = new Map(lines.map((line) => [line.measurement, line]));

  const comparisons = groundTruth.rows.map((row) => {
    const line = byMeasurement.get(row.measurement) || null;
    const actual = line && line.measurementStatus !== 'not_measurable' ? line.quantity : null;
    const { outcome, flags } = classify({
      line: line || undefined,
      expectedQuantity: row.quantity,
      gated,
      tolerance
    });
    return {
      measurement: row.measurement,
      category: categoryOf(categoryForMeasurement(row.measurement)) || 'other',
      expected: row.quantity,
      actual,
      delta: actual === null ? null : Number((actual - row.quantity).toFixed(6)),
      unit: row.unit ?? line?.unit ?? null,
      measurementStatus: line?.measurementStatus ?? null,
      outcome, flags,
      reason: line ? null : 'The pipeline does not produce a line for this measurement, so there is no quantity to compare.',
      notes: row.notes
    };
  });

  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const comparison of comparisons) counts[comparison.outcome] += 1;

  /* Per category: the deltas, not a score. */
  const byCategory = {};
  for (const comparison of comparisons) {
    const bucket = byCategory[comparison.category] || (byCategory[comparison.category] = { rows: 0, deltas: [], outcomes: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) });
    bucket.rows += 1;
    bucket.outcomes[comparison.outcome] += 1;
    if (comparison.delta !== null) bucket.deltas.push({ measurement: comparison.measurement, expected: comparison.expected, actual: comparison.actual, delta: comparison.delta, unit: comparison.unit });
  }

  return {
    file: file.name, status: 'compared', reason: null,
    source: groundTruth.source, preparedBy: groundTruth.preparedBy,
    gated, comparisons, counts, byCategory,
    gate: { rule: 'unflagged_financial_error === 0', passed: counts.unflagged_financial_error === 0 },
    note: 'Per-category deltas against a hand-prepared takeoff. Deliberately not an accuracy figure: a delta per category is checkable, a single number is not.'
  };
}

/* Measurement name -> internal category, for grouping only. */
function categoryForMeasurement(measurement) {
  const name = String(measurement).toLowerCase();
  if (name.startsWith('wall')) return 'wall';
  if (name.startsWith('floor') || name.startsWith('room') || name.startsWith('skirting')) return 'room';
  if (name.startsWith('door') || name.startsWith('window')) return 'door';
  if (name.startsWith('furniture')) return 'furniture';
  return null;
}

module.exports = { runE0, parseGroundTruth, GroundTruthError, categoryForMeasurement };
