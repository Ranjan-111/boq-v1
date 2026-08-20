const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inspectDxf, measureDxf } = require('../src/dxf');
const { RULESETS, DEFAULT_RULESET_VERSION, DEFAULT_ASSUMPTIONS, getRuleset, normalizeAssumptions, RuleError } = require('../src/rules');
const { signedSum } = require('../src/provenance');

const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);

function measure({ rulesetVersion = DEFAULT_RULESET_VERSION, assumptions } = {}) {
  const document = { id: 'src_0001', version: 1, filename: 'clean-plan.dxf', sourceSheet: 'A-PLAN', content: cleanPlan };
  const { document: parsed, units, versions } = inspectDxf(document);
  return measureDxf(document, units, parsed, { versions, runId: 'run_0001', rulesetVersion, assumptions: normalizeAssumptions(assumptions) });
}
const lineOf = (boq, measurement) => boq.lines.find((line) => line.measurement === measurement);
const reconciles = (line) => Math.abs(signedSum(line.provenance.contributions) - line.quantity) <= 1e-6;

test('the registry exposes named, versioned rulesets over one rule set', () => {
  assert.ok(RULESETS['clean-plan-v1'], 'the historical ruleset is still selectable');
  assert.ok(RULESETS['clean-plan-v2'], 'the current ruleset exists');
  assert.equal(DEFAULT_RULESET_VERSION, 'clean-plan-v2');
  for (const [version, ruleset] of Object.entries(RULESETS)) {
    assert.equal(ruleset.version, version);
    assert.ok(ruleset.ruleIds.length > 0, `${version} names its rules`);
    assert.ok(ruleset.settings && typeof ruleset.settings === 'object', `${version} carries settings`);
  }
  assert.throws(() => getRuleset('no-such-ruleset'), RuleError, 'an unknown ruleset is refused, never defaulted');
});

test('a wall with openings produces deduct contributions that reconcile exactly', () => {
  const boq = measure();
  const plaster = lineOf(boq, 'wall_plaster');
  const deductions = plaster.provenance.contributions.filter((entry) => entry.sign === 'deduct');
  assert.ok(deductions.length >= 1, 'at least one deduction');
  assert.equal(deductions.length, 4, 'two doors and two windows');
  assert.ok(deductions.every((entry) => entry.quantity > 0), 'a deduction carries a positive magnitude and a deduct sign, not a negative number');
  assert.ok(reconciles(plaster), `signed sum ${signedSum(plaster.provenance.contributions)} vs ${plaster.quantity}`);
  assert.equal(plaster.quantity, 143.79);
});

test('every deduction resolves to the opening that caused it, using its real footprint', () => {
  const boq = measure();
  const byId = new Map(boq.sourceObjects.map((object) => [object.sourceObjectId, object]));
  const deductions = lineOf(boq, 'wall_plaster').provenance.contributions.filter((entry) => entry.sign === 'deduct');
  const widths = deductions.map((entry) => {
    const object = byId.get(entry.sourceObjectId);
    assert.ok(object, 'the deduction resolves to a source object');
    assert.equal(object.geometryResolution, 'block-definition', 'the opening width comes from block geometry, not an insertion point');
    return Number((Math.max(object.bounds[2] - object.bounds[0], object.bounds[3] - object.bounds[1]) / 1000).toFixed(3));
  }).sort();
  assert.deepEqual(widths, [0.75, 0.9, 1.2, 1.5], 'the four real opening widths');
});

test('two rulesets over identical geometry give different, individually correct quantities', () => {
  const historical = measure({ rulesetVersion: 'clean-plan-v1' });
  const current = measure({ rulesetVersion: 'clean-plan-v2' });

  assert.equal(lineOf(historical, 'wall_plaster').quantity, 157.2, 'the historical ruleset still measures gross plaster');
  assert.equal(lineOf(current, 'wall_plaster').quantity, 143.79, 'the current ruleset deducts openings');
  assert.equal(lineOf(historical, 'wall_plan').quantity, lineOf(current, 'wall_plan').quantity, 'geometry-only lines are unaffected by policy');

  for (const boq of [historical, current]) {
    for (const line of boq.lines) assert.ok(reconciles(line), `${boq.ruleset}/${line.measurement} reconciles`);
  }
  assert.equal(historical.ruleset, 'clean-plan-v1');
  assert.equal(current.ruleset, 'clean-plan-v2');
});

test('every line and contribution is stamped with the ruleset that produced it', () => {
  for (const version of ['clean-plan-v1', 'clean-plan-v2']) {
    const boq = measure({ rulesetVersion: version });
    assert.equal(boq.versions.ruleset, version);
    for (const line of boq.lines) {
      for (const entry of line.provenance.contributions) {
        assert.equal(entry.rulesetVersion, version, `${line.measurement} contribution stamped`);
        assert.ok(entry.ruleId, 'and names the rule that produced it');
      }
    }
  }
});

test('deducting openings from masonry is a ruleset policy, not a hardcoded choice', () => {
  const gross = measure({ rulesetVersion: 'clean-plan-v2' });
  const net = measure({ rulesetVersion: 'clean-plan-v2-net-masonry' });
  assert.equal(getRuleset('clean-plan-v2').settings.deductOpeningsFromMasonry, false);
  assert.equal(getRuleset('clean-plan-v2-net-masonry').settings.deductOpeningsFromMasonry, true);

  const grossMasonry = lineOf(gross, 'wall_masonry');
  const netMasonry = lineOf(net, 'wall_masonry');
  assert.equal(grossMasonry.quantity, 18.078, 'policy off leaves masonry gross');
  assert.equal(netMasonry.quantity, 16.53585, 'policy on subtracts the opening volumes');
  assert.equal(grossMasonry.provenance.contributions.filter((entry) => entry.sign === 'deduct').length, 0);
  assert.equal(netMasonry.provenance.contributions.filter((entry) => entry.sign === 'deduct').length, 4);
  assert.ok(reconciles(grossMasonry) && reconciles(netMasonry), 'each reconciles to its own signed sum');
});

test('assumptions are editable, bounded, and change the quantities they feed', () => {
  assert.equal(DEFAULT_ASSUMPTIONS.wallHeight, 3);
  assert.equal(DEFAULT_ASSUMPTIONS.wallThickness, 0.23);
  const taller = measure({ assumptions: { wallHeight: 3.5 } });
  const base = measure();
  assert.ok(lineOf(taller, 'wall_masonry').quantity > lineOf(base, 'wall_masonry').quantity, 'a taller wall is more masonry');
  assert.equal(lineOf(taller, 'wall_plan').quantity, lineOf(base, 'wall_plan').quantity, 'plan area does not depend on height');
  assert.throws(() => normalizeAssumptions({ wallHeight: 0 }), RuleError, 'a zero wall height is refused');
  assert.throws(() => normalizeAssumptions({ wallThickness: -1 }), RuleError);
  assert.throws(() => normalizeAssumptions({ notAnAssumption: 1 }), RuleError, 'unknown assumptions are refused, not silently ignored');
});

test('a larger opening height deducts more, and the line still reconciles', () => {
  const standard = measure();
  const tallDoors = measure({ assumptions: { doorOpeningHeight: 2.4 } });
  const standardPlaster = lineOf(standard, 'wall_plaster');
  const tallPlaster = lineOf(tallDoors, 'wall_plaster');
  // two doors, 0.9 + 0.75 wide, both faces, 0.3 m taller: 2 * 1.65 * 0.3
  assert.equal(Number((standardPlaster.quantity - tallPlaster.quantity).toFixed(6)), 0.99);
  assert.ok(reconciles(tallPlaster));
});

test('measuring twice with the same ruleset and assumptions is byte-identical', () => {
  const first = measure();
  const second = measure();
  assert.deepEqual(second, first, 'measurement is deterministic');
});

test('deductions that exceed the wall are impossible, not a negative or a zero', () => {
  // Within the allowed assumption bounds: a very low wall with very tall openings.
  const boq = measure({ assumptions: { wallHeight: 0.5, doorOpeningHeight: 10, windowOpeningHeight: 10 } });
  const plaster = lineOf(boq, 'wall_plaster');
  assert.equal(plaster.measurementStatus, 'not_measurable', 'openings larger than the wall are not a measurement');
  assert.notEqual(plaster.measurementStatus, 'measured_zero', 'and specifically not a measured zero');
  assert.equal(plaster.quantity, 0, 'no negative quantity escapes into a total');
  assert.match(plaster.provenance.impossible.reason, /exceed/i);
  assert.ok(plaster.provenance.impossible.signedSum < 0, 'the arithmetic that produced it is kept, not hidden');
  assert.ok(plaster.provenance.contributions.length > 0, 'the contributions stay visible so a human can see why');
  // the rest of the drawing is unaffected
  assert.equal(lineOf(boq, 'wall_plan').measurementStatus, 'measured');
});
