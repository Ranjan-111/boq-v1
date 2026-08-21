# Implementation map

**Baseline commit:** see `git log -1` — the R2 unified provenance record.
**Established:** 20 Aug 2026, by integrating the divergent codex branches into `main`,
then replacing the two per-tier provenance shapes with one record (R2).
**Suite:** 317 tests, all passing together (`npm test`).

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
src/exceptions.js     one exception queue, grouping and the pluggable ranker (#12)
src/rates.js          versioned rate books and money arithmetic (#15)
src/vendors.js        eligible vendor offers (#16)
src/catalogue.js      studio item catalogue: measurement -> BOQ item (#24)
src/export.js         reproducible approved exports, CSV + XLSX + sidecar (#17)
src/workspace.js      line<->object evidence, signed breakdown, viewports (#14)
src/validation/       E0/E1 validation harness -- read-only tooling for #19
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

## Exception queue and approval (#12, #13) — implemented

The product's stated weakness is asking an architect for too many decisions across
too many screens. The fix is not fewer checks — it is fewer interruptions for the same
checks.

### One shape for every signal

`src/exceptions.js` consolidates nine signal types that were each built and surfaced
separately. **No exception type exists only in its originating module**; a new check
that forgets to register shows up as a missing type rather than a silent gap.

| type | severity | blocks |
|---|---|---|
| `impossible_quantity` | blocking | measurement, approval, export |
| `not_measurable` | blocking | approval, export |
| `implausible_magnitude` | blocking | approval |
| `classification_conflict` | blocking | approval |
| `unconfirmed_proposal` | blocking | measurement, approval |
| `rectangular_proposal` | blocking | approval |
| `unidentified_symbol` | advisory | **pricing** |
| `unclassified_geometry` | advisory | completeness |
| `low_confidence` | advisory | review |

`unidentified_symbol` is advisory on purpose: the layer voted, so the *count is already
correct*. What is missing is the identity needed to price it — it blocks pricing, not
measurement.

Every exception carries what it is (`title`), why it was raised (`raisedBecause`, a
sentence not a code), what it blocks, what would resolve it (`resolutionOptions`), and
a `sourceObjectId` so the evidence is one step away.

### Grouping is the workload lever

Twelve instances of `Block_17` are one decision, not twelve. Measured on real fixtures:

| fixture | exceptions | groups | reduction |
|---|---|---|---|
| `repeated-symbol.dxf` | 12 | 1 | **92%** |
| `garbage-and-exploded.dxf` | 18 | 10 | 44% |
| `residual-blocks.dxf` | 4 | 4 | 0% (causes genuinely differ) |

One `resolveExceptionGroup` clears the whole group, and for `confirm_item` it also
memorises the answer for the studio (#10), so it does not return on the next drawing.

### Ordering is labelled, never implied

The intended ranking is money at risk. **There is no rate book yet (#15)**, so
`createImpactRanker` is pluggable and the payload says which it used:
`rankedBy: 'quantity-proxy'` with a `caveat`, or `'money-at-risk'` when a rate source is
supplied.

The proxy's honest limit: share is computed **within a measurement class**, because
100 m² of floor and 5 m of skirting are not comparable without a rate. Sole members of
different classes tie rather than being ordered on a comparison the proxy cannot
justify. No monetary figure is invented, and the dev UI displays the label.

### A new exception type from the vision batch

`coerceBoxes` can only emit axis-aligned rectangles, so a confirmed proposal over an
L-shaped room squares it off and overstates its area. `rectangular_proposal` queues
that for shape review — the overlay makes it visible, but noticing it should not depend
on the operator happening to look. Resolution: confirm the shape, or re-trace as a
polygon (the geometry field already holds polygons; no schema change). A **human-traced**
rectangle is not flagged: a person who drew a rectangle meant to.

### Resolutions are append-only

A `resolutions` table with `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)`,
the same enforcement `audit_events` uses. A correction is a **new row carrying
`supersedes`**; the original decision is never overwritten, because what someone decided
at the time is the record. Revising an already-resolved group is the same operation, not
a refusal.

### Approval records what it approved, and cannot outrun the queue

`approveBoqVersion` records the ruleset version, the assumptions version and the
**run set**. It is refused while any blocking exception is open — `exportable` was found
claiming a readiness the numbers could not back, and `approved` must not acquire the
same problem. A single code path sets `status = 'approved'`, and a test pins that.

A resolution that changes a quantity (`recordQuantityAffectingResolution`) re-measures,
supersedes the runs that produced the old number, and moves any approval to `stale` —
exactly the mechanism #6 built for assumption changes.

### Dev UI

`#exception-review` in the operator page: the queue with its ordering label, resolve
buttons per group, and approval with its blocking reason. Deliberately unstyled — the
real frontend is a later batch and this is thrown away. Debugging a review workflow
through curl is a false economy.

## Rate books and vendor offers (#15, #16) — implemented

**A price is a fact with an owner and a date, or it does not exist.** Unlike every
other number here, a rate is not derived from geometry — it comes from outside — so it
carries where it came from, who supplied it, and when it was valid. A rate book without
`source.label` and `source.suppliedBy`, or a rate without `validFrom`/`validTo`, is
refused at construction. A rate with no provenance is worse than a missing rate,
because a missing rate is visibly missing.

### Shape and versioning

```
RateBook { id, studioId, version, currency, locality, kind, source{label,suppliedBy},
           rates: [{ itemCode, unit, amount, validFrom, validTo, locality, source }] }
```

Immutable and versioned like a ruleset — `publishRateBook` always creates the next
version, never an edit, and a `BEFORE UPDATE` trigger enforces it in the store. A BOQ
priced in March still reproduces March's numbers in October: `getPricedBoq(…, { rateBookVersion: 1 })`
prices at v1 after v2 exists.

Currency is explicit and never assumed; `totalOf` refuses to sum mixed currencies.

**Scope, deliberately narrow.** A studio's own rate book is the primary source. A dated
published schedule can be imported as another book (`kind`), labelled with its
publication date. **No such data is embedded in this repository** — licensing is
unverified, so this is an import path only. No live feed, no scraping.

### Never invent a rate

| status | meaning |
|---|---|
| `priced` | a live rate applied |
| `no_rate` | nothing prices this item — **amount is `null`, not zero** |
| `stale_rate` | a rate exists but its window has passed — no amount |
| `unit_mismatch` | the rate is per a different unit — refuses rather than multiplying |
| `no_quantity` | nothing to price |

A **zero rate** produces a real amount of `0` with status `priced`. That is a genuinely
free item, and it is a different state from an unpriced one — the same discipline as
`measured_zero` versus `not_measurable`, applied to money.

### Staleness is an exception, not a default

An expired rate raises a **blocking** `stale_rate` exception in the #12 queue and
refuses approval. This is what makes **merge-gate Q8 answerable for the first time**.
Vendor offers go stale identically and an expired offer cannot be selected.

### Money arithmetic

Amounts are stored unrounded; `roundMoney` is applied **once, at presentation**.
Demonstrated: three lines of 0.125 round individually to 0.13 each (0.39), but the
total rounds once to **0.38**. `amount = quantity × rate.amount` is re-derivable from
the stored line, and if either input is missing the amount is absent rather than zero.

### The ranker flips to real money

With no rate book the #12 queue reports `rankedBy: 'quantity-proxy'` with its caveat.
With one, it flips to **`money-at-risk`** and the caveat becomes `null`. The ordering
genuinely differs: 27.72 m² at ₹9000 outranks 143.79 m² at ₹5, which the
within-class proxy could never have expressed. Stale rates score zero — an expired
price does not get to rank work.

### An offer is an offer, not a selection

`eligibleOffers` returns `offers`, `stale` and `ineligible`, and deliberately has **no**
`selected`, `recommended` or `cheapest` field. Ordering is by vendor name, explicitly
not by price — ordering by price is a recommendation wearing a sort order. Offers are
scoped to the studio that holds them, like block-name mappings.

A selection is a recorded decision through the same append-only `resolutions` path as
every other human decision, with `supersedes` on a change of mind, and an audit entry.
**A vendor choice never moves a quantity** — offers price what was measured and have no
path back into measurement; no run is superseded by one.

## Item catalogue (#24) — implemented

The architecture is **geometry -> rules -> items -> rates**, and `items` was never built:
rate lookup matched a rate book's `itemCode` straight against a measurement name. That
forced a studio to author its rate book as `floor_area`, and would have exported rows
labelled `floor_area` -- not a BOQ anyone can send a client.

```
CatalogueItem { code, description, unit, measurement, notes?, sortOrder? }
```

`description` is the client-facing text. Studio-scoped, versioned and immutable like
rulesets and rate books; an approval snapshots the catalogue version it used.

**Mapping is explicit, never guessed.** One measurement may map to several items
(internal vs external plaster). A measurement with no entry raises a **blocking**
`unmapped_measurement` exception in the #12 queue rather than falling back to the raw
name. Unit disagreement between item and measurement reuses #15's `unit_mismatch`
rather than inventing a second refusal.

**Approval now requires a catalogue**, since a BOQ whose rows have no client-facing
description cannot be sent to anyone.

**Locality matching fixed.** `"Bengaluru"` and `"Bangalore"` normalise to the same key
through a documented alias table (also Bombay/Mumbai, Calcutta/Kolkata, Madras/Chennai,
New Delhi/Delhi, Gurgaon/Gurugram). An unscoped rate applies anywhere. An unknown
locality still misses -- but honestly, rather than presenting as "no rate".

## Reproducible exports (#17) — implemented, and Q9 is closed

**An export is a reproducible artefact, not a render.** It is built from a snapshot
**frozen at approval**, not re-derived at export time. Re-deriving would make a delivered
document depend on whatever has been published since; freezing is what makes a re-export
byte-identical six months later. `buildArtefact` is pure -- no clock, no current-state
lookup.

### Gating chain

1. the version must be **approved** -- never a draft, never a run;
2. approval is already refused while blocking exceptions are open (#13), a rate is stale
   (#15), or a measurement is unmapped (#24), so export inherits all three;
3. a **stale** approval (assumptions or ruleset changed since) refuses export with a
   re-approve instruction;
4. any **superseded run** the approval rests on refuses export.

### The stamp

Mandatory on every document: approver, approval date, ruleset version, assumptions
version, rate book version, catalogue version, parser version, input tiers, currency and
pricing date.

### Tier honesty survives into the document

Each row carries a tier derived from its contributions' `coordinateSpace` --
`dxf` -> **A Measured (CAD)**, `pdf-page` -> **B Measured (vector PDF)**,
`raster-pixel` -> **C Traced estimate** -- plus a plain-language basis-of-quantity
column. **A line mixing tiers is reported at its weakest**: a total containing a traced
estimate is not a measured quantity. This is the last point at which the distinction
could be lost.

### Money in the document

Row amounts are **presented rounded**; the total accumulates **exact** values and rounds
once, per #15. A raw binary float (`60391.799999999996`) reaching a client-facing row
was caught and fixed here. Unpriced lines carry no amount and the total states
`INCOMPLETE: n of m lines have no amount. This is not a whole-project total.`

### Formats and the sidecar

CSV and XLSX from one artefact -- same content, different encoding. The XLSX writer is
hand-rolled with fixed zip timestamps so the same artefact zips to the same bytes; no
dependency. A machine-readable **JSON provenance sidecar** ships alongside, carrying
every line's contributions and the source objects they resolve to **with geometry**, so
a delivered number is traceable without the application.

## Workspace API (#14) — backend half implemented

The visual workspace is a later frontend batch. This is the API it needs, plus an
unstyled dev probe to prove it works. Every field was already present -- `bounds`
precomputed (3a), `sign` required (R2), the navigation tree on the SourceObject -- so
this assembles rather than adds.

### Line -> evidence, one call

`getLineEvidence(projectId, measurement)` returns navigation target, the source objects
with `bounds`/`geometrySource`/`coordinateSpace`, every contribution with its `sign` and
tier, a **server-computed viewport**, the signed breakdown and the tier breakdown. The
client needs no geometry logic to know where to look.

**Spans are reported, never resolved silently.** Objects may sit in more than one sheet
or storey. When they do, `spansMultiple` is true, `navigate.storeyId` is `null` rather
than a guess, and `viewportsByStorey` gives one rectangle per storey — because one
rectangle cannot span two storeys. Navigating to one of several is a wrong answer that
looks like a right one.

**Degenerate bounds get a viewing extent, flagged as invented.** An `insertion-point`
object has no measurable extent; fitting to it would give a zero-area rectangle. The
viewport widens to a minimum and sets `degenerate: true` with a note that the extent is
a display affordance, never a measurement.

### Object -> lines, the reverse

`getObjectLines(projectId, sourceObjectId)` answers "what is this wall costing me":
every line the object contributes to, with sign, net contribution and share of the line.
Proven to be the **exact inverse** of line → objects, signs included.

### The signed breakdown

Today the BOQ shows 143.79 with no indication anything was subtracted. On
`clean-plan.dxf`:

```
Gross 157.2 m², less 4 openings totalling 13.41 m², net 143.79 m².
   deduct 3.78 m² via dxf-wall-plaster-v1  (10E)
   deduct 3.15 m² via dxf-wall-plaster-v1  (10F)
   deduct 2.88 m² via dxf-wall-plaster-v1  (110)
   deduct 3.60 m² via dxf-wall-plaster-v1  (111)
```

Each deduction names its rule and the object it was taken against. A line with no
deductions reports an empty list and `deductionTotal: 0`, not a missing field.

### Mixed-tier lines

#17 reports a mixed line at its weakest tier. The workspace additionally gives
`tierBreakdown` per tier and a `tier` on every contribution, so a line reported Tier C
is visibly **part measured and part traced** rather than uniformly degraded.

### Query cost

Constant, measured at 1 / 10 / 30 storeys: **line → evidence 4 queries, queue step 8**.
`lineEvidence` and `objectLines` are pure over one already-loaded rollup, so neither is
N+1 in contributions; the queue step shares a single tree load with the queue build.

### The printed total now ties by hand

**This overrules #15's accumulate-exact rule at the presentation boundary, and nowhere
else.** The printed total is the sum of the printed row amounts, because an estimator
who cannot tie the column distrusts the document and "the total doesn't add up" is
indefensible to a contractor. The exact figure is computed alongside as `exactAmount` /
`exactRounded` and carried in the provenance sidecar. Every internal total still
accumulates exact.

## Validation harness (#19 tooling) — implemented; #19 itself stays blocked

#19 needs real DXFs and a studio's past BOQ. That block is real. The machinery
that runs the day those arrive is built and proven against synthetic stand-ins,
so there is no engineering delay left in it — **but nothing here validates the
product.** Only real drawings do that.

**Read-only.** No measurement module imports `src/validation/`, and a test pins
that. Running either harness leaves quantities byte-identical.

### One command

```
node scripts/validation/validate.mjs --drawings <dir> [--ground-truth <file>] [--json <out>]
```

Exit code is non-zero only on a disqualifying E0 finding. A low E1 percentage is a
product decision, not a broken build.

### E1 — classification coverage

What fraction of entities classify from layer, hatch and block name alone, with no
vision call. Uses `layerCategory` and `blockCategory` straight from `src/dxf.js`;
reimplementing them would measure the harness rather than the product.

Verified against the synthetic corpus, hand-checked **before** the harness existed:

| fixture | classified | % |
|---|---|---|
| `clean-plan.dxf` | 15 / 15 | 100.0 |
| `residual-blocks.dxf` | 14 / 15 | 93.3 |
| `garbage-layers.dxf` | 8 / 15 | 53.3 |
| `garbage-and-exploded.dxf` | 4 / 15 | 26.7 |
| aggregate over `test/fixtures` | 129 / 148 | 87.2 |

**Per category, not one aggregate** — an aggregate hides a category collapsing.
`garbage-layers.dxf` shows walls and floors at **zero** while openings and furniture
survive on block names, which a single 53.3% would conceal.

A category reports **how many entities classified into it**, not a rate. There is no
honest denominator: an unclassified entity has no known category — that is what makes
it unclassified — so a per-category rate would count only its own successes and always
read 100%. My first cut did exactly that and the tests caught it.

The go/no-go bands (>70 / 40–70 / <40) are reported as a **named band with its
caveat**, never as a verdict.

### E0 — ground-truth comparison

A hand-prepared takeoff in a plain CSV (or JSON) a non-engineer fills from their own
BOQ; a template ships at `scripts/validation/ground-truth-template.csv`. A **blank cell
is refused**, not read as zero — `Number('')` is `0`, which would turn an unfilled row
into a claim the studio measured nothing.

Output extends #18's four-outcome ledger rather than inventing a second vocabulary:
correct / flagged uncertainty / confidently wrong / unflagged financial error, now
against a real answer. A measurement the pipeline does not produce is reported as
flagged uncertainty with `actual: null`, never dropped.

**No accuracy percentage is computed anywhere in the E0 path**, and a test asserts the
absence of the field — the same discipline #18 established. Per-category deltas only: a
delta per category is checkable, a single number is not.

## Known gaps (not regressions — never built)

- **No BOQ export surface exists.** No CSV/XLSX/download path anywhere in `src/`.
  Merge-gate questions about exports are therefore vacuous today, not satisfied.
- **No rate book, vendor or pricing** in the Node application.

## Branch topology that produced this

```
ab28927 (#2/PR21)
 └ d27c123 (#3) ── 226cdec (#4) ─┬─ 8817c59 (#5, and #6 pointing at the same commit)
                                 └─ 3ec0ead (#7) ─ e5e9fad (#8) ─ 0c4ea5a (#9)
```

`main` already contained #3 and #4, and its tree was byte-identical to `226cdec`. The
#7→#8→#9 chain was already linear. So there was exactly one divergence to resolve —
fusion against the PDF/raster/OCR chain — not five.
