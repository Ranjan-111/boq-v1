/* The four-outcome ledger (#18).

   The project's stated evaluation model. Every conformance observation lands in
   exactly one bucket:

     correct                   matched what we expected
     flagged_uncertainty       wrong or unknown, and the system said so
     confidently_wrong         wrong, unflagged, but something else gates the run
     unflagged_financial_error wrong, unflagged, and nothing stops it reaching a BOQ

   Deliberately not collapsed into an accuracy percentage. The corpus is
   synthetic, so a percentage would read as a product-accuracy claim it cannot
   support -- and a run with lower accuracy and zero unflagged errors is
   healthier than the reverse, which a single score hides.

   The gate is `unflagged_financial_error === 0`. Not a threshold. */

const OUTCOMES = Object.freeze(['correct', 'flagged_uncertainty', 'confidently_wrong', 'unflagged_financial_error']);
const DISQUALIFYING = 'unflagged_financial_error';

/** Every way the system can say "do not trust this number as-is". */
function flagsOn(line) {
  const flags = [];
  if (!line) return ['line absent'];
  if (line.measurementStatus === 'not_measurable') flags.push('not_measurable');
  if (line.provenance?.impossible) flags.push('impossible');
  if (line.provenance?.plausibility?.flagged) flags.push('implausible magnitude');
  if (line.confidence && line.confidence.level !== 'HIGH') flags.push(`confidence ${line.confidence.level}`);
  if (line.provenance?.classificationConflicts?.length) flags.push('classification conflict');
  return flags;
}

function matches(actual, expected, tolerance = 1e-6) {
  if (expected === null || expected === undefined) return actual === undefined || actual === null;
  if (typeof expected === 'number') return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  return actual === expected;
}

/**
 * Classify one expected-vs-actual observation.
 * `gated` means something independent of this line stops the run reaching a BOQ
 * (the run halted, or its export is blocked). It is what separates a wrong
 * number that a human will still be stopped by from one that would ship.
 */
function classify({ line, expectedQuantity, expectedStatus, gated = false, tolerance = 1e-6 }) {
  const flags = flagsOn(line);
  const quantityOk = expectedQuantity === undefined || matches(line?.quantity, expectedQuantity, tolerance);
  const statusOk = expectedStatus === undefined || line?.measurementStatus === expectedStatus;
  if (quantityOk && statusOk) return { outcome: 'correct', flags };
  if (flags.length) return { outcome: 'flagged_uncertainty', flags };
  if (gated) return { outcome: 'confidently_wrong', flags };
  return { outcome: DISQUALIFYING, flags };
}

function createLedger() {
  const entries = [];
  return {
    record(observation) {
      const { outcome, flags } = classify(observation);
      entries.push({
        fixture: observation.fixture, rulesetVersion: observation.rulesetVersion,
        assumptionsVersion: observation.assumptionsVersion, measurement: observation.measurement,
        expectedQuantity: observation.expectedQuantity, expectedStatus: observation.expectedStatus,
        actualQuantity: observation.line?.quantity ?? null, actualStatus: observation.line?.measurementStatus ?? null,
        outcome, flags
      });
      return outcome;
    },
    get entries() { return [...entries]; },
    counts() {
      const counts = Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
      for (const entry of entries) counts[entry.outcome] += 1;
      return counts;
    },
    failures() { return entries.filter((entry) => entry.outcome === DISQUALIFYING || entry.outcome === 'confidently_wrong'); },
    summary() {
      const counts = this.counts();
      return {
        observations: entries.length,
        counts,
        gate: { rule: 'unflagged_financial_error === 0', passed: counts[DISQUALIFYING] === 0 },
        /* Intentionally no accuracy percentage. See the note at the top. */
        note: 'Synthetic corpus. Counts describe this corpus only and are not a product-accuracy claim.',
        offenders: this.failures().map(({ fixture, rulesetVersion, measurement, expectedQuantity, actualQuantity, outcome }) =>
          ({ fixture, rulesetVersion, measurement, expectedQuantity, actualQuantity, outcome }))
      };
    },
    format() {
      const { observations, counts, gate } = this.summary();
      const rows = OUTCOMES.map((name) => `  ${name.padEnd(26)} ${String(counts[name]).padStart(4)}`).join('\n');
      return `conformance ledger — ${observations} observations\n${rows}\n  gate: ${gate.rule} → ${gate.passed ? 'PASS' : 'FAIL'}`;
    }
  };
}

module.exports = { OUTCOMES, DISQUALIFYING, classify, flagsOn, createLedger };
