# Implementation map

**Baseline commit:** see `git log -1` — the R2 unified provenance record.
**Established:** 20 Aug 2026, by integrating the divergent codex branches into `main`,
then replacing the two per-tier provenance shapes with one record (R2).
**Suite:** 122 tests, all passing together (`npm test`).

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
src/application.js    lifecycle, run schema, PDF + raster measurement
src/provenance.js     the unified SourceObject / Contribution record (R2)
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
| DXF | unit resolution ( `$INSUNITS` or explicit fallback ) | `dxf-entity` | yes |
| vector PDF | `awaiting_setup` — page scale + region selection | `native-vector` | no |
| raster PNG/JPEG | `awaiting_calibration` — two points + real distance, then a traced region | `human-traced` | no |

Evidence fusion is gated on `format === 'dxf'`, so PDF and raster runs cannot pick up
DXF classification provenance.

## Known gaps (not regressions — never built)

- **No BOQ export surface exists.** No CSV/XLSX/download path anywhere in `src/`.
  Merge-gate questions about exports are therefore vacuous today, not satisfied.
- **No rate book, vendor or pricing** in the Node application.
")

s=s.replace(## Provenance (R2) — implemented

One record for every tier; the tier is a field, not a different structure.

```
BoqLine.provenance = { version, contributions[], measurementStatus, aggregation }
Contribution        = { sourceObjectId, measurement, sign, quantity, unit,
                        ruleId, rulesetVersion, runId, typicalMultiplier, ruleInputs }
SourceObject        = { sourceObjectId, sourceDocumentId/Version, buildingId, storeyId,
                        zoneId, sheetId, pageId, geometrySource, coordinateSpace,
                        geometry, bounds, transform, rotation, nativeHandle, regionId }
```

Source objects live in a registry on the carrier — `run.boq.sourceObjects` and
`rollup.sourceObjects` — and contributions reference them by id. `bounds` is
precomputed at measurement time so a viewer never re-parses the source document.

| Tier | `coordinateSpace` | `geometrySource` |
|---|---|---|
| DXF | `dxf` | `dxf-entity` |
| vector PDF | `pdf-page` | `native-vector` |
| raster | `raster-pixel` | `human-traced`, or `model-proposed-confirmed` |

`model-proposed` is not a member of the enum: a proposal only becomes provenance
once a human confirms it, and `createSourceObject` throws on the bare value.

**Two deliberate additions to the R2 spec**, both additive, neither changing a
quantity: `typicalMultiplier` and `ruleInputs` on `Contribution`. Both are rule
inputs that scale the result — the storey multiplier, a PDF page scale, a raster
calibration. Without them a contribution is not reproducible from its own record,
which defeats the purpose of the record. `rotation` is likewise kept on
`SourceObject` because page geometry cannot be placed without it.

**Three-state measurement is now uniform.** All three tiers derive status from
`measurementStatusFor(quantity, contributions)`: no contributions resolved means
`not_measurable`, contributions summing to zero means `measured_zero`. The DXF tier
reaches `not_measurable` in normal operation (a plan with no room polygons). PDF and
raster cannot reach it end to end — their setup gates refuse to enter measurement
without at least one region, which is the stronger guarantee — so for them it is a
defensive state covered at the derivation seam.

**Migration losslessness.** Every DXF handle carried over: 0 lost. Wall and room
entities (`HATCH`/`LWPOLYLINE`) carry full polygon extents. Block references
(`INSERT` — doors, windows, furniture) carry only their **insertion point**, so their
`bounds` is a degenerate point box. Resolving a block's real footprint needs the
`BLOCKS` section geometry, which the parser does not expand. A viewer can locate
these objects but cannot fit their true extent.

## Known gaps (not regressions — never built)- **No rule emits a `deduct` contribution.** The record requires and validates `sign`,
  and `signedSum` subtracts deductions, but no measurement rule in `src/` subtracts
  anything today: door and window openings are counted, never deducted from wall
  areas. Adding a real deduction changes `wall_plaster`/`wall_masonry` quantities, so
  it is rule work, not part of this evidence-record refactor.
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
