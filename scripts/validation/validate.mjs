#!/usr/bin/env node
/* One command, one report (#19 tooling).
 *
 *   node scripts/validation/validate.mjs --drawings <dir> [--ground-truth <file>] [--json <out>]
 *
 * Read-only. It reads drawings and an optional hand-prepared takeoff, runs the
 * real pipeline, and prints a report. It writes nothing except the report.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runE1 } = require('../../src/validation/e1');
const { runE0, parseGroundTruth } = require('../../src/validation/e0');
const { buildReport, formatReport } = require('../../src/validation/report');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const drawingsPath = arg('drawings');
if (!drawingsPath) {
  console.error('Usage: validate.mjs --drawings <dir> [--ground-truth <file.csv|file.json>] [--json <out.json>]');
  console.error('\n  --drawings      folder of DXF files (searched one level deep)');
  console.error('  --ground-truth  a hand-prepared takeoff; without it E0 is reported as unavailable');
  console.error('  --json          also write the full report as JSON');
  process.exit(2);
}

function collectDxf(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { found.push(...collectDxf(path)); continue; }
    if (extname(entry.name).toLowerCase() === '.dxf') found.push({ name: entry.name, path, content: readFileSync(path) });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

const files = collectDxf(drawingsPath);
if (!files.length) {
  console.error(`No .dxf files found under ${drawingsPath}.`);
  process.exit(1);
}

const e1 = runE1(files);

let e0 = null;
const groundTruthPath = arg('ground-truth');
if (groundTruthPath) {
  const format = extname(groundTruthPath).toLowerCase() === '.json' ? 'json' : 'csv';
  const groundTruth = parseGroundTruth(readFileSync(groundTruthPath, 'utf8'), format);
  /* A takeoff describes one drawing. Match it to the file it names, or to the
     only drawing present; never guess across several. */
  const named = arg('ground-truth-for');
  const target = named
    ? files.find((file) => file.name === named)
    : files.length === 1 ? files[0] : null;
  if (!target) {
    console.error(`A ground truth covers one drawing. ${files.length} were supplied — name it with --ground-truth-for <file.dxf>.`);
    process.exit(1);
  }
  e0 = runE0({ file: target, groundTruth });
}

const report = buildReport({ e1, e0, drawingsPath });
process.stdout.write(formatReport(report));

const jsonOut = arg('json');
if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`\nreport written to ${jsonOut}\n`);
}

/* Exit non-zero only on a disqualifying E0 finding. E1 is a measurement, not a
   pass/fail -- a low percentage is a product decision, not a broken build. */
process.exit(e0 && !e0.gate.passed ? 1 : 0);
