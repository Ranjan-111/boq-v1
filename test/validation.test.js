const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runE1, aggregateE1, CATEGORIES, categoryOf } = require('../src/validation/e1');
const { parseGroundTruth, runE0, GroundTruthError } = require('../src/validation/e0');
const { buildReport, formatReport } = require('../src/validation/report');
const { OUTCOMES } = require('../src/conformance');

const fixture = (name) => readFileSync(`${__dirname}/fixtures/${name}`);
const file = (name, path = name) => ({ name, content: fixture(path) });

/* Hand-checked against the fixtures before the harness existed. If the harness
   is wrong, these are what catch it -- not the other way round. */
const KNOWN = {
  'clean-plan.dxf': { total: 15, classified: 15, percentage: 100 },
  'garbage-layers.dxf': { total: 15, classified: 8, percentage: 53.3 },
  'residual-blocks.dxf': { total: 15, classified: 14, percentage: 93.3 },
  'blocks-plan.dxf': { total: 6, classified: 6, percentage: 100 }
};

test('the reported categories are the four the launch plan asks for', () => {
  assert.deepEqual([...CATEGORIES].sort(), ['floor', 'furniture', 'opening', 'wall']);
  assert.equal(categoryOf('room'), 'floor');
  assert.equal(categoryOf('door'), 'opening');
  assert.equal(categoryOf('window'), 'opening');
  assert.equal(categoryOf('wall'), 'wall');
  assert.equal(categoryOf('furniture'), 'furniture');
  assert.equal(categoryOf(null), null);
});

test('E1 reproduces the hand-checked percentage on the synthetic corpus', () => {
  for (const [name, expected] of Object.entries(KNOWN)) {
    const path = name === 'garbage-layers.dxf' ? `adversarial/${name}` : name;
    const result = runE1([file(name, path)]).files[0];
    assert.equal(result.total, expected.total, `${name} entity count`);
    assert.equal(result.classified, expected.classified, `${name} classified count`);
    assert.equal(Number(result.percentage.toFixed(1)), expected.percentage, `${name} percentage`);
  }
});

test('E1 reports per category, so a category collapsing to zero cannot hide in an aggregate', () => {
  const result = runE1([file('garbage-layers.dxf', 'adversarial/garbage-layers.dxf')]).files[0];
  assert.equal(result.byCategory.wall.classified, 0, 'walls collapsed entirely');
  assert.equal(result.byCategory.floor.classified, 0);
  assert.equal(result.byCategory.opening.classified, 4, 'openings survived on block names');
  assert.equal(result.byCategory.furniture.classified, 4);
  assert.equal(result.unclassified, 7, 'and the entities with no determinable category are counted whole');
  for (const category of CATEGORIES) {
    assert.ok(result.byCategory[category], `${category} is reported even when zero`);
    assert.ok(Number.isFinite(result.byCategory[category].classified));
    assert.equal(result.byCategory[category].percentage, undefined,
      'no per-category rate is invented: an unclassified entity has no known category, so there is no honest denominator');
  }
});

test('E1 aggregates across a folder without losing the per-file breakdown', () => {
  const result = runE1([
    file('clean-plan.dxf'),
    file('garbage-layers.dxf', 'adversarial/garbage-layers.dxf')
  ]);
  assert.equal(result.files.length, 2);
  assert.equal(result.aggregate.total, 30);
  assert.equal(result.aggregate.classified, 23);
  assert.equal(Number(result.aggregate.percentage.toFixed(1)), 76.7);
  assert.equal(result.aggregate.byCategory.wall.classified, 5, 'only the clean file classified any walls');
  assert.equal(result.aggregate.byCategory.opening.classified, 8, 'openings classified in both files');
  assert.equal(result.aggregate.unclassified, 7);
  assert.ok(result.aggregate.byCategory.wall.shareOfClassified > 0, 'share of what did classify is reported');
});

test('a file the parser refuses is reported, not skipped and not fatal', () => {
  const result = runE1([
    file('clean-plan.dxf'),
    file('truncated.dxf', 'adversarial/truncated.dxf')
  ]);
  assert.equal(result.files.length, 2);
  const failed = result.files.find((entry) => entry.name === 'truncated.dxf');
  assert.equal(failed.status, 'unreadable');
  assert.match(failed.reason, /malformed|re-export/i);
  assert.equal(failed.total, 0);
  assert.equal(result.aggregate.unreadableFiles, 1, 'the aggregate says how much it could not read');
  assert.equal(result.aggregate.total, 15, 'and an unreadable file does not inflate or deflate the percentage');
});

test('the go/no-go band is reported as a band, never as a verdict on a synthetic corpus', () => {
  const result = runE1([file('clean-plan.dxf')]);
  assert.ok(result.aggregate.band, 'a band is named');
  assert.match(result.aggregate.band.label, /build as planned/i);
  assert.match(result.aggregate.caveat, /synthetic|not a product/i, 'and it says the corpus cannot support a product claim');
});

test('ground truth parses from a plain CSV a non-engineer can fill in', () => {
  const csv = [
    'measurement,quantity,unit,notes',
    'floor_area,27.72,m²,From the studio takeoff',
    'wall_plan,6.026,m²,',
    'door_count,2,nos,'
  ].join('\n');
  const truth = parseGroundTruth(csv, 'csv');
  assert.equal(truth.rows.length, 3);
  assert.equal(truth.rows[0].measurement, 'floor_area');
  assert.equal(truth.rows[0].quantity, 27.72);
  assert.equal(truth.rows[0].unit, 'm²');
  assert.equal(truth.rows[0].notes, 'From the studio takeoff');
});

test('ground truth also parses from JSON, and refuses a row with no quantity', () => {
  const json = JSON.stringify({ source: 'Studio BOQ, March 2026', rows: [{ measurement: 'floor_area', quantity: 27.72, unit: 'm²' }] });
  const truth = parseGroundTruth(json, 'json');
  assert.equal(truth.source, 'Studio BOQ, March 2026');
  assert.equal(truth.rows.length, 1);
  assert.throws(() => parseGroundTruth('measurement,quantity,unit\nfloor_area,,m²', 'csv'), GroundTruthError);
  assert.throws(() => parseGroundTruth('measurement,quantity,unit\n,27.72,m²', 'csv'), GroundTruthError);
});

test('E0 buckets a matching quantity as correct', () => {
  const truth = parseGroundTruth('measurement,quantity,unit\nfloor_area,27.72,m²', 'csv');
  const result = runE0({ file: file('clean-plan.dxf'), groundTruth: truth });
  const entry = result.comparisons.find((candidate) => candidate.measurement === 'floor_area');
  assert.equal(entry.outcome, 'correct');
  assert.equal(entry.expected, 27.72);
  assert.equal(entry.actual, 27.72);
  assert.equal(entry.delta, 0);
});

test('E0 buckets a deliberately wrong ground truth into the right ledger category', () => {
  // the pipeline measures 27.72; the "takeoff" says 40 and nothing flags the line
  const truth = parseGroundTruth('measurement,quantity,unit\nfloor_area,40,m²', 'csv');
  const result = runE0({ file: file('clean-plan.dxf'), groundTruth: truth });
  const entry = result.comparisons.find((candidate) => candidate.measurement === 'floor_area');
  assert.equal(entry.outcome, 'unflagged_financial_error', 'a confident wrong number with nothing gating it');
  assert.equal(Number(entry.delta.toFixed(2)), -12.28);
  assert.equal(result.counts.unflagged_financial_error, 1);
});

test('E0 buckets a disagreement the system flagged as flagged uncertainty, not an error', () => {
  // garbage layers: wall_plan is not_measurable, so a disagreement is flagged
  const truth = parseGroundTruth('measurement,quantity,unit\nwall_plan,6.026,m²', 'csv');
  const result = runE0({ file: file('garbage-layers.dxf', 'adversarial/garbage-layers.dxf'), groundTruth: truth });
  const entry = result.comparisons.find((candidate) => candidate.measurement === 'wall_plan');
  assert.equal(entry.outcome, 'flagged_uncertainty', 'the system said it could not measure this');
  assert.ok(entry.flags.length > 0);
  assert.equal(result.counts.unflagged_financial_error, 0);
});

test('E0 reports deltas per category and computes no accuracy percentage anywhere', () => {
  const truth = parseGroundTruth([
    'measurement,quantity,unit',
    'floor_area,27.72,m²',
    'wall_plan,6.026,m²',
    'door_count,2,nos'
  ].join('\n'), 'csv');
  const result = runE0({ file: file('clean-plan.dxf'), groundTruth: truth });
  assert.ok(result.byCategory.floor, 'deltas are grouped by category');
  assert.ok(result.byCategory.wall);
  assert.ok(result.byCategory.opening);
  for (const outcome of OUTCOMES) assert.ok(Number.isFinite(result.counts[outcome]));

  const serialized = JSON.stringify(result);
  assert.equal(result.accuracy, undefined, 'no accuracy field');
  assert.equal(result.score, undefined);
  assert.equal(/"accuracy"|"score"|"accuracyPercent"/.test(serialized), false, 'and none anywhere in the payload');
  assert.match(result.note, /per-category|not an accuracy/i);
});

test('a ground-truth row naming a measurement the pipeline does not produce is reported, not dropped', () => {
  const truth = parseGroundTruth('measurement,quantity,unit\nceiling_area,50,m²', 'csv');
  const result = runE0({ file: file('clean-plan.dxf'), groundTruth: truth });
  const entry = result.comparisons.find((candidate) => candidate.measurement === 'ceiling_area');
  assert.equal(entry.outcome, 'flagged_uncertainty');
  assert.equal(entry.actual, null);
  assert.match(entry.reason, /does not produce|no line/i);
});

test('the report carries E1 and, only once supplied, E0', () => {
  const withoutTruth = buildReport({ e1: runE1([file('clean-plan.dxf')]), e0: null });
  assert.ok(withoutTruth.e1);
  assert.equal(withoutTruth.e0, null);
  assert.match(withoutTruth.e0Status, /no ground truth|unavailable/i, 'E0 is shown as unavailable, never as zero');

  const text = formatReport(withoutTruth);
  assert.match(text, /E1/);
  assert.match(text, /not supplied|unavailable/i);
  assert.equal(/E0 delta/.test(text) && !/unavailable|not supplied/.test(text), false);
});

test('the harness changes no pipeline behaviour', () => {
  const { createApplication } = require('../src/application');
  const run = () => {
    const application = createApplication({ schedule: (callback) => callback() });
    const project = application.createProject({ name: 'Control' });
    const source = application.createSourceDocument({ filename: 'a.dxf', content: fixture('clean-plan.dxf'), projectId: project.id, sourceSheet: 'A', studioId: 'st' });
    return application.getRun(application.startProcessing(source.id).id).boq.lines.map((line) => [line.measurement, line.quantity, line.measurementStatus]);
  };
  const before = run();
  runE1([file('clean-plan.dxf')]);
  runE0({ file: file('clean-plan.dxf'), groundTruth: parseGroundTruth('measurement,quantity,unit\nfloor_area,27.72,m²', 'csv') });
  assert.deepEqual(run(), before, 'quantities are identical after running the harness');
});

test('no validation module is imported by the measurement pipeline', () => {
  for (const name of ['application.js', 'dxf.js', 'rules.js', 'export.js', 'provenance.js', 'rates.js']) {
    const source = readFileSync(`${__dirname}/../src/${name}`, 'utf8');
    assert.equal(/require\(['"]\.\/validation/.test(source), false, `${name} must not depend on the harness`);
  }
});
