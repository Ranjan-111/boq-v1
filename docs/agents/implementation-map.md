# Implementation map

**Baseline commit:** `38bacef` — `merge: cached browser OCR evidence (#9)`
**Established:** 20 Aug 2026, by integrating the divergent codex branches into `main`.
**Suite:** 107 tests, all passing together (`npm test`).

## What `main` now contains

`main` is no longer the PR #21 baseline. It carries every implemented issue:

| Issue | Branch | Status in `main` |
|---|---|---|
| #2 clean DXF end to end | `codex/issue-2-clean-dxf-end-to-end` | merged (PR #21) |
| #3 unsafe DXF | `codex/issue-3-unsafe-dxf` | merged (PR #23) |
| #4 multi-floor | `codex/issue-4-multi-floor` | merged (PR #24) |
| #5 evidence fusion | `codex/issue-5-evidence-fusion` | merged |
| #6 versioned rules | `codex/issue-6-versioned-rules` | **NOT BUILT** — see below |
| #7 vector PDF | `codex/issue-7-vector-pdf` | merged |
| #8 raster calibration | `codex/issue-8-raster-calibration` | merged |
| #9 local OCR | `codex/issue-9-local-ocr` | merged |

### Issue #6 was never implemented

`codex/issue-6-versioned-rules` points at commit `8817c59` — the *same commit* as
`codex/issue-5-evidence-fusion`. It contributed zero lines. Nothing in the tree
versions a ruleset in the sense #6 intended: `DXF_VERSIONS` in `src/dxf.js` stamps a
frozen identifier (`ruleset: 'clean-plan-v1'`) into provenance, but there are no rule
alternatives, no editable assumptions and no way to select a ruleset. #6 must be
recreated as live work.

## Module layout

```
src/application.js    lifecycle, run schema, quantity + provenance schema (the conflict zone)
src/classification.js evidence fusion, studio mappings, stable digest()
src/dxf.js            DXF parse, unit resolution, measurement rules
src/ocr-results.js    OCR normalization, forbidden-field enforcement
src/ingestion/sniff.js   content-based format detection
src/ingestion/pdf.js     vector PDF inspection
src/ingestion/raster.js  raster page inspection
src/ingestion/limits.js  bounded-input limits
src/server.js         HTTP routes
public/app.js         operator UI
```

There is exactly one parser per concern. No duplicate parser or category-rule module
survived the integration.

## Tier behaviour, as demonstrated on one instance

| Input | Gate before measurement | `geometrySource` | Fusion |
|---|---|---|---|
| DXF | unit resolution ( `$INSUNITS` or explicit fallback ) | DXF `sourceHandles` | yes |
| vector PDF | `awaiting_setup` — page scale + region selection | `native-vector` | no |
| raster PNG/JPEG | `awaiting_calibration` — two points + real distance, then a traced region | `human-traced` | no |

Evidence fusion is gated on `format === 'dxf'`, so PDF and raster runs cannot pick up
DXF classification provenance.

## Known gaps (not regressions — never built)

- **No BOQ export surface exists.** No CSV/XLSX/download path anywhere in `src/`.
  Merge-gate questions about exports are therefore vacuous today, not satisfied.
- **No rate book, vendor or pricing** in the Node application.
- **Provenance is not unified across tiers.** DXF lines carry `provenance.sourceHandles`;
  PDF and raster lines carry `provenance.sourceContributions`. Different shapes for the
  same concept — this is what research question R2 has to settle.
- **`not_measurable` is DXF-only.** `src/dxf.js` is the only module that emits it; the
  PDF and raster paths distinguish only `measured` / `measured_zero` and rely on their
  gates to block missing geometry earlier.
- **`vision.js` is prototype-only and browser-keyed.** It calls the model provider
  directly from the page with an operator-pasted key, and nothing in `src/` imports it.
  It cannot ship (research question R4).

## Branch topology that produced this

```
ab28927 (#2/PR21)
 └ d27c123 (#3) ── 226cdec (#4) ─┬─ 8817c59 (#5, and #6 pointing at the same commit)
                                 └─ 3ec0ead (#7) ─ e5e9fad (#8) ─ 0c4ea5a (#9)
```

`main` already contained #3 and #4, and its tree was byte-identical to `226cdec`. The
#7→#8→#9 chain was already linear. So there was exactly one divergence to resolve —
fusion against the PDF/raster/OCR chain — not five.
