# BOQ v1 implementation map

## Baseline and public contract

Current baseline is merged PR #21 (`ab28927`): one clean DXF enters an in-memory application, advances through `ingestion` → `measurement` → `boq`, and exposes deterministic quantities plus source handles.

- `src/application.js:3-5` — version constants, supported units, stage delay.
- `src/application.js:7-86` — `createApplication`; source/run stores and public methods `createSourceDocument`, `startProcessing`, `getRun`, `reprocess`.
- `src/application.js:13-25` — source document: `src_NNNN`, filename, version 1, SHA-256.
- `src/application.js:27-72` — run state machine and failure path.
- `src/application.js:131-190` — deterministic clean-DXF measurement and line schema (`measurement`, `quantity`, `unit`, confidence, measurement status, provenance).
- `src/application.js:193-283` — parser, category rules, polygon math, quantity rounding.
- `src/server.js:6-27` — HTTP contract: `POST /api/source-documents`, `GET /api/runs/run_N`, `POST /api/runs/run_N/reprocess`.
- `src/server.js:30-55` — multipart `drawing` upload and JSON/static responses.
- `public/index.html:24-45` — single-DXF upload, run summary, review table.
- `public/app.js:10-89` — submit, 50 ms polling, run rendering, BOQ rendering.

Test seams and fixture:

- `test/operator-flow.test.js:18-36` — HTTP upload/completion helpers.
- `test/operator-flow.test.js:38-71` — clean quantities and provenance assertions.
- `test/operator-flow.test.js:73-88` — deterministic reprocessing.
- `test/operator-interface.test.js:22-45` — browser upload, stage progression, table, reprocess.
- `test/fixtures/clean-plan.dxf:1-324` — only production fixture; `$INSUNITS=4`, room handles `10A/10C`, opening handles `10E/10F`.

## Reusable legacy prototype seams

`drawing-to-boq-prototype.html` is a monolith, not a production dependency. Extract behavior behind public application boundaries rather than importing its globals directly.

- `drawing-to-boq-prototype.html:313-432` — richer `parseDXF`/`readEntity` (blocks, layers, text, closed geometry).
- `drawing-to-boq-prototype.html:435-488` — geometry/category helpers and `scaleGate` (absent, unitless, unsupported, declared units).
- `drawing-to-boq-prototype.html:490-616` — `measure` with assumptions, evidence, residuals, plausibility and blocking flags.
- `drawing-to-boq-prototype.html:618-655` — `DEFAULT_RATES`/`buildBOQ` pricing and money-at-risk review routing.
- `drawing-to-boq-prototype.html:683-864` — `INGEST`: format sniffing, explicit DWG refusal, vector-PDF extraction, raster routing.
- `drawing-to-boq-prototype.html:1335-1555` — raster calibration, manual tracing, region confirmation and deterministic synthetic-document conversion.
- `drawing-to-boq-prototype.html:1578-1653` — review state, stale invalidation, append-only audit, accept/edit/override/reject.
- `drawing-to-boq-prototype.html:1686-1792` — checks, BOQ review, selection and handle provenance.
- `drawing-to-boq-prototype.html:1949-2033` — approval blockers and CSV export contract.
- `vision.js:28-50` — residual category-vs-item distinction.
- `vision.js:53-114` — crop rendering and closed-label coercion to `UNKNOWN`.
- `vision.js:128-207` — model discovery/classification fallback and error metadata; currently browser-keyed and therefore not suitable as server credential handling.
- `vision.js:230-297` — normalized raster box parsing, label coercion and proposal fallback.

## Issue routing and dependency waves

Declared issue dependencies form these waves. Issue #2 is already implemented by PR #21; #1 remains a retroactive acceptance-harness gap. Because #3 depends on the delivered #2 code, #1 and #3 may proceed in parallel in isolated worktrees.

| Wave | Issues | Primary seams |
| --- | --- | --- |
| 0 | #1, #3 | acceptance harness; unsafe-input boundary and recovery |
| 1 | #4, #7, #8 | project/storey model; PDF `INGEST`; raster calibration/tracing |
| 2 | #5, #6, #9 | classification/evidence model; rules/assumption versions; OCR boundary |
| 3 | #10, #12, #15 | server semantic fallback; exception queue; versioned rate books |
| 4 | #11, #13, #16 | confirmed raster proposals; approval/audit; vendor offers |
| 5 | #14, #18 | synchronized provenance UI; conformance corpus and boundary hardening |
| 6 | #17 | reproducible approved export across review, provenance and pricing |
| 7 | #19 | real-project feasibility and launch gate |

Dependency edges as declared by the tracker: #2←#1; #3←#2; #4←#3; #5/#6←#4; #7←#3; #8←#3; #9←#7,#8; #10←#5; #11←#8,#10; #12←#4,#5,#6,#7,#8; #13←#12; #14←#13; #15←#5,#6; #16←#15; #17←#13,#14,#15,#16; #18←#9,#10,#11,#12; #19←#17,#18.

## Conflict zones

- `src/application.js:7-86` — in-memory lifecycle and run schema; changes here affect every API/UI/test seam.
- `src/application.js:131-190` — quantity and provenance schema; preserve deterministic replay and source handles while adding rules, tiers, pricing or review state.
- `src/application.js:193-246` — parser boundary; do not silently replace missing/unsafe source evidence with defaults.
- `src/server.js:12-21` — endpoint/status contract; extend versioned response fields compatibly and keep failures visible.
- `public/index.html` + `public/app.js` — current simple flow; later workspace changes must retain upload/run/reprocess behavior unless the issue explicitly supersedes it.
- `drawing-to-boq-prototype.html` — reference-only monolith; parallel extraction by multiple branches risks duplicate models and divergent terminology.
- `test/fixtures/clean-plan.dxf` and `test/operator-flow.test.js` — baseline assertions; preserve them and add adversarial fixtures alongside them.
- Provenance/version fields — all later recalculation, review, pricing and export work must retain source revision, rule/rate/model metadata and deterministic replay.

## Branch, PR and map rules

- One issue per branch and PR; branch names should include the issue number.
- Read the full issue body, comments, labels and blockers before implementation; do not close or rewrite parent issues.
- Preserve the #21 public contract and baseline tests; add tests through public application/HTTP/browser behavior rather than private helpers.
- Keep prototype extraction isolated and name new modules around the domain vocabulary already used by the issue tracker.
- Do not merge dependent work before every declared blocker is resolved or explicitly superseded by maintainers.
- After each merged PR, update this file with the new baseline commit, public interfaces, test seams, changed dependency frontier, and any newly created conflict zone.
