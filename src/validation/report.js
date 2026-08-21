/* One command, one report (#19 tooling).

   E1 always; E0 only once a ground truth is supplied. Where E0 is absent it is
   shown as unavailable rather than as zero -- an unrun comparison and a
   comparison that found nothing wrong are different states. */

const { CATEGORIES } = require('./e1');

function buildReport({ e1, e0 = null, drawingsPath = null, generatedAt = new Date().toISOString() }) {
  return {
    generatedAt, drawingsPath,
    e1,
    e0,
    e0Status: e0 ? 'compared' : 'unavailable — no ground truth was supplied, so no comparison was run',
    caveat: e1?.aggregate?.caveat ?? null
  };
}

const pct = (value) => (value === null || value === undefined ? '   n/a' : `${value.toFixed(1).padStart(5)}%`);

function formatReport(report) {
  const out = [];
  const { e1, e0 } = report;
  out.push(`Validation report — ${report.generatedAt}`);
  if (report.drawingsPath) out.push(`Drawings: ${report.drawingsPath}`);
  out.push('');
  out.push('E1 — classification from layer, hatch and block name alone (no vision call)');
  out.push('');
  out.push('  file                                     classified   total       %');
  for (const file of e1.files) {
    if (file.status !== 'read') { out.push(`  ${file.name.padEnd(40)} UNREADABLE — ${file.reason}`); continue; }
    out.push(`  ${file.name.padEnd(40)} ${String(file.classified).padStart(10)} ${String(file.total).padStart(7)} ${pct(file.percentage)}`);
  }
  const aggregate = e1.aggregate;
  out.push('');
  out.push(`  aggregate${''.padEnd(31)} ${String(aggregate.classified).padStart(10)} ${String(aggregate.total).padStart(7)} ${pct(aggregate.percentage)}`);
  if (aggregate.unreadableFiles) out.push(`  (${aggregate.unreadableFiles} file(s) unreadable and excluded from the totals)`);
  out.push('');
  out.push('  entities classified into each category (a zero here is a collapse)');
  for (const category of CATEGORIES) {
    const entry = aggregate.byCategory[category];
    const share = entry.shareOfClassified === null ? '' : ` (${(entry.shareOfClassified * 100).toFixed(1)}% of all classified)`;
    out.push(`    ${category.padEnd(12)} ${String(entry.classified).padStart(6)}${share}${entry.classified === 0 ? '   <- nothing classified into this category' : ''}`);
  }
  out.push(`    ${'unclassified'.padEnd(12)} ${String(aggregate.unclassified).padStart(6)}   (no category could be determined)`);
  if (aggregate.band) {
    out.push('');
    out.push(`  band: ${aggregate.band.label} — ${aggregate.band.note}`);
  }
  out.push(`  ${aggregate.caveat}`);
  out.push('');
  out.push('E0 — measured against a hand-prepared takeoff');
  out.push('');
  if (!e0) {
    out.push(`  ${report.e0Status}.`);
  } else if (e0.status !== 'compared') {
    out.push(`  ${e0.file}: ${e0.reason}`);
  } else {
    out.push(`  ${e0.file}${e0.source ? ` against ${e0.source}` : ''}`);
    out.push('');
    out.push('  measurement            expected      actual       delta   outcome');
    for (const comparison of e0.comparisons) {
      const actual = comparison.actual === null ? 'no line' : String(comparison.actual);
      const delta = comparison.delta === null ? '-' : String(comparison.delta);
      out.push(`    ${comparison.measurement.padEnd(20)} ${String(comparison.expected).padStart(9)} ${actual.padStart(11)} ${delta.padStart(11)}   ${comparison.outcome}`);
    }
    out.push('');
    out.push('  ledger');
    for (const [outcome, count] of Object.entries(e0.counts)) out.push(`    ${outcome.padEnd(28)} ${String(count).padStart(4)}`);
    out.push(`    gate: ${e0.gate.rule} → ${e0.gate.passed ? 'PASS' : 'FAIL'}`);
    out.push(`  ${e0.note}`);
  }
  return `${out.join('\n')}\n`;
}

module.exports = { buildReport, formatReport };
