# Project context — drawing-to-BOQ backend

Handoff note for a fresh chat window. Read `docs/agents/implementation-map.md` first;
it is the orientation doc and is kept current. `OPEN-ITEMS.md` tracks known limitations.
This file is a pointer, not a duplicate of either.

## What this is

A system that turns architectural drawings into a Bill of Quantities, where **every
number is traceable to the geometry that produced it** and nothing is ever silently
guessed. The product's differentiator is refusal: a missing measurement is
`not_measurable`, never zero; an unpriced line has no amount, never zero; a traced
raster estimate never reads like measured CAD geometry.

## Current state

- **Branch:** `main`, committed directly (no PRs, no GitHub issues — house rule).
- **Suite:** ~324 tests, all passing (`npm test`).
- **Conformance ledger:** 63 observations, **zero unflagged financial errors** (the gate).
- **Backend: feature-complete** through the planned batches. Frontend is in progress.

### Merge gate (nine questions, run as a probe every batch — not a checklist)

All nine currently answered. Q8 (stale rate reaching an export) closed by #15/#16;
Q9 (unresolved BOQ exported) closed by #17. Twice this session the gate caught
something the test suite structurally could not see — keep running it.

## Architecture in one line

`geometry → rules → items → rates → export`, with provenance threaded end to end.

| Module | Responsibility |
|---|---|
| `src/dxf.js` | DXF parse, block geometry expansion, measurement |
| `src/provenance.js` | SourceObject / Contribution record (R2) |
| `src/rules.js` | Versioned rulesets, opening deductions, project assumptions (#6) |
| `src/repository.js` | SQLite store — the only file that sees SQL (R1) |
| `src/exceptions.js` | One exception queue, grouping, pluggable ranker (#12) |
| `src/rates.js` / `src/vendors.js` | Versioned rate books, eligible vendor offers (#15/#16) |
| `src/catalogue.js` | Measurement → client-facing BOQ item (#24) |
| `src/export.js` | Reproducible approved exports, CSV/XLSX + provenance sidecar (#17) |
| `src/workspace.js` | Line↔object evidence, signed breakdown, viewports (#14) |
| `src/vision/` | Server-side vision: label-only contract, crops, residuals (#10/#11) |
| `src/validation/` | E0/E1 harness — read-only tooling for #19 |

## Invariants — do not break these

1. **No quantity changes** except where a ticket explicitly licenses it. Snapshot
   quantities before and after; every move must be explained.
2. **A model may never supply a number that becomes a quantity.** It proposes labels,
   and on raster only boundaries; scale stays human-supplied.
3. **Absent ≠ zero.** `not_measurable` vs `measured_zero`; `no_rate` vs a zero rate.
4. **Provenance must resolve.** Every contribution points at a real SourceObject.
5. **Tier honesty survives to the delivered document.** Tier C never reads as Tier A.
6. **Append-only** for resolutions and audit events, enforced by SQLite triggers.
7. **No headline accuracy percentage.** Per-category deltas only — the corpus is
   synthetic and cannot support a product claim.

## Working rules

Commit directly to `main`. Test-first at public seams. Never fabricate results —
unimplemented is reported as unavailable. Run the full nine-question gate on anything
touching quantities or provenance. Add new limitations to `OPEN-ITEMS.md` rather than
burying them in prose.

## Where things stand right now

- **#19 real-project validation is blocked** and cannot be unblocked by engineering:
  it needs real studio DXFs and one studio's past BOQ. The E0/E1 harness that runs the
  day those arrive is built and proven against synthetic fixtures.
- **Every number this system has produced is measured against fixtures we wrote.**
  That is the single largest open risk.
- **Frontend** exists (built separately) and is **uncommitted** in `public/`. See the
  findings section of the latest session summary; the open items are a missing
  list-projects endpoint, no export route, and an upload-limit mismatch.

## Commands

```bash
npm test                       # full suite
npm run check                  # syntax check every source and test file
npm start                      # operator app on :3000
npm run validate -- --drawings <dir> [--ground-truth <file.csv>]
```
