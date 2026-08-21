# Implementation map

**Baseline commit:** see `git log -1` — the R2 unified provenance record.
**Established:** 20 Aug 2026, by integrating the divergent codex branches into `main`,
then replacing the two per-tier provenance shapes with one record (R2).
**Suite:** 214 tests, all passing together (`npm test`).

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

### Issue #6 — originally never implemented, now built

`codex/issue-6-versioned-rules` pointed at commit `8817c59` — the *same commit* as
`codex/issue-5-evidence-fusion`. It contributed zero lines, and `ruleset:
'clean-plan-v1'` was a frozen label rather than a selectable ruleset. Rebuilt from
scratch: see **Measurement rules** below.

## Module layout

```
src/application.js    lifecycle, run schema, PDF + raster measurement
src/provenance.js     the unified SourceObject / Contribution record (R2)
src/repository.js     SQLite store and schema (R1) -- the only file that sees SQL
src/rules.js          versioned measurement rules, rulesets and assumptions (#6)
src/conformance.js    the four-outcome ledger (#18)
src/vision/           server-side vision: contract, provider, crop, residuals (#10, #11)
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

## Provenance (R2) — implemented

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

**Block references now carry real footprints.** `parseDxf` reads the `BLOCKS`
section (name, base point, definition geometry) and an `INSERT` is placed as
`insertion + R(rotation) * S(scale) * (point - base)`, so rotation (code 50) and
scale (41/42) are reflected in `bounds`. Block bodies are parsed leniently — their
geometry only ever sets bounds, never a quantity, so an entity type the measurement
rules reject must not fail the drawing.

`SourceObject.geometryResolution` records how the geometry was obtained:

| value | meaning |
|---|---|
| `native` | read straight off the entity (`HATCH`, `LWPOLYLINE`, PDF/raster regions) |
| `block-definition` | an `INSERT` expanded from its block definition — a real footprint |
| `insertion-point` | the block could not be found; `bounds` is a point, **not** an extent |

An `INSERT` whose block has no definition keeps its insertion point and is marked;
no extent is invented and the run does not fail. Degenerate bounds in
`clean-plan.dxf`: **8 of 15 before, 0 after**.

## Persistence (R1) — implemented

SQLite (`better-sqlite3`, WAL) behind `src/repository.js`. `src/application.js`
calls repository methods and never sees SQL. Plain portable SQL, no ORM, so the
move to Postgres is a swap of one file.

**Tables:** `projects`, `buildings`, `storeys`, `boq_versions`, `source_documents`
(bytes in a `content` BLOB, assignment in real columns), `processing_runs`,
`source_objects`, `boq_lines`, `contributions`, `audit_events`.

`source_objects` carries `min_x, min_y, max_x, max_y` as four indexed REAL columns
with the polygon alongside as `geometry_json`. Fitting a viewport is a range query
on four numbers; nothing queries inside a polygon, so it stays JSON. The shape rule
throughout is relational where we query, JSON where we do not.

`audit_events` is append-only **enforced by the store**: `BEFORE UPDATE` and
`BEFORE DELETE` triggers `RAISE(ABORT)`. That is a property of the database, not a
convention the next contributor has to remember.

### Source objects are deduplicated, one row per `sourceObjectId`

R2 defines `sourceObjectId` to be stable across reprocessing of one document
version, and geometry is a pure function of immutable inputs (that version's bytes,
the parser version). Two runs of one version therefore describe the same object, so
storing N identical copies is exactly what a primary key exists to prevent — and it
is what would turn the rollup into a fan-out join.

Per-run audit correctness is not lost: what a run claimed is recoverable through
run → lines → contributions → object. Only the shared, immutable description is
shared.

Two consequences, both handled explicitly rather than left to chance:

- **Divergent geometry is never silently overwritten.** If a write arrives for an
  existing id with different geometry (a parser change under a stored version), the
  first write wins — runs keep the geometry they actually measured — and a
  `source_object_geometry_divergence` event is appended to the audit trail.
- **Navigation fields are not authoritative on the row.** `building_id`,
  `storey_id` and `sheet_id` are the assignment *as first observed*, and an operator
  can reassign a document later. The application overlays the assignment of the run
  it is reading when it materialises an object. The columns remain for scoped
  queries and audit, not as current truth.

### The rollup is four queries, whatever the tree

Rendering a project draws a rollup for the project, each building and each storey.
Loading per rollup would be N+1 in the number of storeys, so the whole tree is
loaded once and every nested rollup is computed from that context:

1. candidate completed, non-superseded runs for every document in scope
2. their BOQ lines
3. their contributions
4. the source objects those contributions reference

Measured: **4 queries at 1, 5, 20 and 50 storeys**, and 4 at 100 contributing runs.

Which run wins for an assignment key — latest document revision per
(BOQ version, project, building, storey, sheet), tie-broken by run sequence — stays
in JS deliberately. It is the rule that decides which revision counts, and
expressing it in SQL would risk moving a quantity for no gain.

### Working set

The maps in `createApplication` are a working set written through on every state
transition and rehydrated from the store on construction — one code path, not an
in-memory alternative implementation. Only `parsedDocument` is transient (a parse
cache, re-derivable from the stored bytes).

**Startup is bounded.** `hydrate()` loads the most recent `hydrateRunLimit` runs
(default 200) in a batch, and anything outside that window is fetched on demand by
`loadRun`. Measured constant at **11 queries** for 1, 10, 50 and 150 stored runs; it
was previously linear (3 runs → 18 queries, 30 → 126).

### Migration trigger — noted, not acted on

Move to Postgres when **either** is true: the project goes multi-tenant SaaS, or it
runs more than one app node. Not before. The repository interface is deliberately
narrow so that day is a swap rather than a rewrite.

## Measurement rules (#6) — implemented

`src/rules.js` holds a registry of plain JavaScript functions keyed by `ruleId`, and
named rulesets that select rules and set policy. Deliberately **not** a formula DSL:
functions are testable, debuggable and diffable, and a DSL would be a second language
to maintain before anyone asked for one.

The split that matters: **geometry is fact, rules are policy.** Running a different
ruleset over identical geometry may produce different quantities, and that is correct
behaviour rather than a defect.

### Rulesets

| version | plaster | masonry |
|---|---|---|
| `clean-plan-v1` | gross | gross |
| `clean-plan-v2` *(default)* | openings deducted | gross |
| `clean-plan-v2-net-masonry` | openings deducted | openings deducted |

Rulesets are immutable — a policy change is a new version, never an edit — so a
quantity measured under one stays reproducible. Selecting an unknown ruleset throws;
it is never silently defaulted.

**Deduction policies implemented:** door and window openings deducted from wall
plaster (both faces, so the opening area is removed twice). **Left as a ruleset
option:** whether openings are voids in the masonry volume — off by default, since
treating small openings as solid is the common convention, and the choice differs
between practices rather than being a fact about the drawing.

An opening's **width comes from its block footprint** (3a), taken as the long axis of
the bounds so it is rotation independent. An unresolved block reference is a point
and cannot size an opening, so it contributes no deduction rather than a guessed one.

### Assumptions

A plan view gives an opening's width but never its height, and wall height and
thickness are project conventions. These are operator-owned, per-project, versioned
inputs with defaults, not constants inside a measurement function:

| assumption | default | feeds |
|---|---|---|
| `wallHeight` | 3 m | masonry volume, plaster area |
| `wallThickness` | 0.23 m | centre-line length from plan area, masonry deduction |
| `doorOpeningHeight` | 2.1 m | plaster/masonry deduction |
| `windowOpeningHeight` | 1.2 m | plaster/masonry deduction |

Each is bounded — a zero wall thickness is refused before it divides into plaster,
and an unknown assumption name is refused rather than ignored. Every change bumps a
version and appends to a history carrying the reason, who made it and what moved.

Runs **snapshot** the ruleset and assumptions they measured under, so a run stays
reproducible after the project's policy moves on.

### Changing policy invalidates approvals (merge gate Q4, now real)

`approveBoqVersion` records the assumptions version and ruleset version it approved.
Changing either re-measures every current source in the project, supersedes the runs
that measured the old number, and moves any approved BOQ version to `stale` with the
cause recorded. An approval cannot outlive the number it approved.

### Impossible quantities

Deductions can, with the wrong assumptions, subtract more than the geometry holds. A
negative area is not a small quantity — it is a contradiction between the rules and
the drawing. Such a line reports `not_measurable` with `provenance.impossible`
carrying the reason and the actual signed sum; the negative number is never
published, and the contributions stay visible. A rollup that includes an unmeasurable
line is itself `not_measurable`, so a partial sum is never presented as a complete
one.

## Conformance corpus (#18) — implemented

`test/conformance/corpus.js` holds the expectations; `test/conformance.test.js` runs
them as part of the suite. Expectations are keyed by **(fixture, rulesetVersion,
assumptionsVersion)** because a ruleset changes quantities by design, and every
expected value records **the arithmetic that produces it** — a contributor can see why
143.79, not only that it is 143.79.

**Coverage:** DXF clean (× 3 rulesets), DXF multi-storey with a typical multiplier,
vector PDF, traced raster, and a rollup spanning all three tiers — plus 7 adversarial
fixtures. 63 observations per run.

`clean-plan-v1` reproduces every pre-#6 historical quantity exactly. That is the
strongest regression signal in the repository: if it moves, the parser or the rule
engine has drifted — it is not a policy change.

### Adversarial fixtures assert behaviour, not numbers

In `test/fixtures/adversarial/`. A corrupted drawing must never yield a confident BOQ.

| Fixture | Expected behaviour |
|---|---|
| `no-insunits.dxf` | halts at unit resolution; no quantity exists |
| `truncated.dxf` | rejected at the boundary, plain language |
| `scaled-10x.dxf` | measured, but flagged implausible; confidence drops to LOW |
| `garbage-layers.dxf` | classification degrades to `not_measurable`; counts survive on block names |
| `no-hatch.dxf` | wall area `not_measurable`, never zero |
| `exploded-furniture.dxf` | the four bare polylines are reported unclassifiable, not dropped |
| `garbage-and-exploded.dxf` | worst case: only block-proven counts survive; everything else degrades |
| (assumptions) | deductions exceeding geometry → `not_measurable` + `provenance.impossible` |
| (limits) | oversized upload refused by the limits module at the boundary |

### The four-outcome ledger

Every observation lands in exactly one bucket: **correct**, **flagged uncertainty**
(wrong or unknown, and the system said so), **confidently wrong** (wrong, unflagged,
but something else gates the run), **unflagged financial error** (wrong, unflagged,
nothing stops it reaching a BOQ).

**The gate is `unflagged_financial_error === 0`** — not a threshold. A run with lower
accuracy and zero unflagged errors is healthier than the reverse, which a single score
would hide.

**No headline accuracy percentage is computed, deliberately.** The corpus is synthetic;
a percentage would read as a product-accuracy claim it cannot support. `summary()` has
no `accuracy` field and a test asserts its absence.

The summary artefact is written to `.conformance/ledger.json` (gitignored) and printed
after every suite run.

### Two behaviours this ticket had to add

- **Implausible magnitude** (`src/rules.js`). Per source object, not per total: a
  drawing exported at the wrong scale measures cleanly — the arithmetic is valid, the
  input was not — so the only way to catch it is to ask whether a single room or wall
  could plausibly be that size. Bands are loose by design, sized to catch a 10× scale
  error rather than to second-guess an unusual building. A flagged line drops to
  `confidence: LOW` and carries `provenance.plausibility`.
- **Unclassified geometry** (`boq.unclassified`). Geometry no rule could consume is
  reported with a reason and a resolvable `sourceObjectId`. Silently discarding it is
  how a BOQ ends up confidently short.

### `exportable` now means something

A completed run with any `not_measurable` line is `exportable: false` and carries
`exportBlockedReasons`. Nothing consumes this yet — there is still no export surface —
but the flag must not claim a readiness the numbers cannot back.

## Vision (#10, #11) — implemented

**The invariant.** A model may propose *what* a thing is, and on raster only *where*
its boundary is. A model may never supply a number that becomes a quantity. On Tier A
the geometry is already exact, so a label is the only useful machine contribution. On
Tier C there is no geometry, so a boundary proposal is — but scale stays
human-supplied, which is what makes it impossible for a model to independently produce
a quantity. Strip the operator's calibration and every Tier C number is undefined;
`proposeRasterRegions` refuses to run before the page is calibrated, so that is
enforced rather than assumed.

### Where the key lives

Server config only: `BOQ_VISION_API_KEY` (or `VISION_API_KEY`), read by
`readApiKey(process.env)`. Sent as the provider's `x-goog-api-key` **header**, never in
a URL — query strings reach proxy logs, browser history and error reports, and a leaked
key is a billing incident. The service object exposes no key property, and a test
asserts a URL never contains the key.

**With no key the system still works end to end.** `visionAvailable()` is false, every
residual routes to a human with `proposal.status: 'unavailable'`, and no label is
invented. Vision is optional, not load-bearing.

### Model discovery

Names are discovered from the provider's list endpoint and filtered to those
advertising `generateContent`; a hardcoded name once broke when the provider retired
it. `PREFERENCE_CHAIN` orders known-good names first and is used alone only when
discovery returns nothing usable.

`classifyProviderError` decides what a failure means. **Model-not-found advances the
chain; auth does not** — walking the chain on a rejected key turns one clear failure
into several confusing ones and hides the cause.

### The label contract is a type, not a comment

`coerceLabel` returns `{ label, category }` and **has no numeric field**. Whatever
arrives — prose, JSON carrying `quantity`/`area`/`price`, a prompt-injection attempt —
only a member of the closed ontology can leave. Tested against hostile replies and
injections; no digit survives.

Raster boundary replies pass `coerceBoxes`, whose box type is exactly
`{x, y, width, height, label}` — normalised to the image, with nowhere to put a scale.
Any `scale`/`calibration`/`pixelsPerMetre` in a reply is discarded. Degenerate slivers
are dropped by **a fraction of image area, not an absolute pixel count**: an absolute
floor passes slivers on a large scan and rejects real regions on a small one. Boxes
that hang off the image are rejected rather than clamped into fiction.

### Crops

Rendered from the residual's **real footprint** (3a), as an 8-bit greyscale PNG built
in-process with `zlib` — no native dependency. The renderer has **no text primitive**:
not a decision to omit dimensions, but no code path that can place a glyph, so a crop
cannot depict a number for a model to read off and echo back.

### Residuals: two different unknowns

| `missing` | meaning |
|---|---|
| `item` | the layer says furniture, `Block_17` says nothing — the **count is already right**, the identity needed to price it is missing |
| `category+item` | neither layer nor block name resolves it |

The first is the common case in real drawings, and it is the commercially important
one. `residualSummary` reports `{ total, itemUnknown, categoryUnknown, resolvedFromMemory }`.

### Memorised confirmations — the compounding asset

When a human resolves a residual, `confirmResidual` creates **and approves** a studio
mapping scoped to `(studioId, blockPattern)`. The same symbol is never asked again for
that studio, and memory is scoped to the studio that confirmed it — another studio does
not inherit a decision it did not make.

**This is persisted**, in a `studio_mappings` table with its own index. It was
previously in-memory only and vanished on restart, which defeated the entire premise:
first project heavy, third nearly clean is a switching cost, not a cache.

### Proposals are not geometry

A model-proposed raster region starts at `lifecycle: 'proposed'`. Measurement only ever
reads `lifecycle === 'confirmed'` regions, and the raster gate refuses to become ready
while any active region is unconfirmed — so an unconfirmed proposal contributes nothing
to any quantity, structurally rather than by a render-time filter.

`geometrySource` is **derived at measurement from origin plus lifecycle**, not stamped
at creation. Previously a model-proposed region carried `model-proposed-confirmed` from
the moment it existed, before any human had seen it. The UI now shows `region.origin`
(a fact from creation) and the lifecycle separately, so an unconfirmed proposal cannot
read as accepted evidence.

Every proposal and every confirmation is on the audit trail
(`raster_regions_proposed`, `raster_region_confirmed`, `vision_label_proposed`,
`residual_confirmed`), and a confirmation records the proposal it superseded.

## Known gaps (not regressions — never built)

- **No BOQ export surface exists.** No CSV/XLSX/download path anywhere in `src/`.
  Merge-gate questions about exports are therefore vacuous today, not satisfied.
- **No rate book, vendor or pricing** in the Node application.
- **`vision.js` (repository root) is the retired prototype.** Superseded by
  `src/vision/`; kept only as the prototype artefact it always was. Nothing in `src/`
  imports it.

## Branch topology that produced this

```
ab28927 (#2/PR21)
 └ d27c123 (#3) ── 226cdec (#4) ─┬─ 8817c59 (#5, and #6 pointing at the same commit)
                                 └─ 3ec0ead (#7) ─ e5e9fad (#8) ─ 0c4ea5a (#9)
```

`main` already contained #3 and #4, and its tree was byte-identical to `226cdec`. The
#7→#8→#9 chain was already linear. So there was exactly one divergence to resolve —
fusion against the PDF/raster/OCR chain — not five.
