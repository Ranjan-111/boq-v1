# Tickets - consolidated roadmap

One chart. Merges the original build plan, the pre-frontend HANDOFF, every ticket completed since, the post-frontend findings, and the phase roadmap into one ordered view. Last reconciled 25 Aug 2026.

| mark | meaning |
|---|---|
| DONE | implemented, tested, in main |
| NOW | the current batch |
| NEXT | after the current batch |
| LATER | real work, not yet |
| BLOCKED | needs something outside the code |
| DECIDED NO | deliberately not building |

**The working rule:** a user-facing ticket is only DONE when it works end to end in the real UI - not when the backend or tests alone pass.

---

## Where the project is

The V1 functional foundation is complete: DXF ingestion, measurement engine, BOQ engine, pricing and export, operator workflow, and the core interface. The Vercel deployment blocker is fixed. The product has shifted from "can I process a drawing" to "can a human see what was extracted and verify it".

That drawing-BOQ-evidence-verification loop is the heart of the remaining work.

---

## NOW - Phase 1: Drawing intelligence and human verification

The single next batch. Everything here serves one goal: the operator can see what the system extracted and verify it on the drawing.

| # | Ticket | What it needs |
|---|---|---|
| T24 | Interactive drawing viewer - complete the loop | The canvas viewer exists (drawing-viewer.mjs, commit a953a8f) and renders geometry, but is not yet reachable from the Review BOQ view. Finish the wiring so every BOQ row offers a view-on-drawing action. |
| T25 | BOQ <-> drawing bidirectional linking | BOQ row to highlight geometry exists in the workspace. Add the reverse: click a drawn object, see its measurement, quantity, catalogue item and provenance. The getObjectLines API already exists; it needs UI. |
| T26 | Exception to drawing evidence | Each exception card gets a view-on-drawing action that opens the viewer focused on the affected sourceObjectId. The evidence API and viewer both exist; the card just needs the link. |
| T27 | Exception overload reduction | A drawing can raise hundreds of exceptions. Grouping exists (12 to 1 on repeated symbols) but needs tuning: collapse same-cause groups across layers, cap the visible list. |
| T28 | Human verification on the drawing | Confirm or reject or correct detected geometry directly on the canvas. The resolution API exists; the canvas interaction is new. |
| T29 | Catalogue display in the review table | The review table shows "Unresolved" for the exact catalog item even though the default catalogue maps every standard measurement. Wire the mapped item into that column. |
| T30 | Professional drawing UI polish | Layers panel, hover tooltips, keyboard zoom, scale readout, minimap for large drawings. |

---

## NEXT - Phase 2: Raster and OCR workflow

| # | Ticket | What it needs |
|---|---|---|
| T8 | Draw the OCR crop on the image | Replace x/y/width/height text inputs with click-and-drag selection. The text-input crop produced 40 failures and 0 successes. |
| T9 | OCR-first raster flow | On upload, run OCR before asking anything: read the scale bar, units and dimensions, propose regions, then show the human. |
| T31 | Automatic scale detection | Detect scale bars and written dimensions before asking for two calibration points. |
| T32 | Automatic unit detection | OCR identifies units where possible; ask only when confidence is insufficient. |
| T33 | Visual region correction | Draw or fence missing regions on the image and optionally name them. |
| T34 | Re-OCR selected regions | After a region is marked, reprocess that region and present the conclusion. |
| T17 | Polygon raster proposals | Accept L-shaped and irregular region proposals, not only axis-aligned rectangles. |

---

## NEXT - Phase 3: Professional UX

| # | Ticket | What it needs |
|---|---|---|
| T35 | Proper landing page | Introduce the product before the operator workspace. |
| T36 | Upload-first experience | Upload without forced setup - partially done, finish it. |
| T37 | Contextual sections | Only show sections relevant to the current state. |
| T38 | Professional processing states | A clear processing timeline instead of sudden jumps. |
| T39 | Construction terminology | Continue replacing engineering terms with BOQ vocabulary. |
| T40 | Better error UX | Errors explain what happened, why it matters, and what to do. |

---

## LATER - Phase 4: Real pricing

| # | Ticket | What it needs |
|---|---|---|
| T15 | Real studio rate books | Studios upload their actual books instead of indicative defaults. |
| T16 | Vendor selection re-prices the line | A recorded selection should update the exported amount. |
| T18 | Split a measurement across items | Internal vs external plaster needs an apportionment rule. |
| T19 | Professional XLSX formatting | Sheets, headers, sections, totals, formatting. |
| T41 | BOQ pricing summary | Subtotals, line totals, taxes, pricing source per line. |
| T42 | Rate provenance in the export | Show whether a rate came from the studio book, the default, or a vendor. |

---

## LATER - Phase 5: Production infrastructure

| # | Ticket | What it needs |
|---|---|---|
| T14 | Persistent storage | Move off in-memory state; src/repository.js is a one-file swap by design. |
| T43 | Postgres deployment | Projects survive cold starts and multiple instances. |
| T44 | Production file storage | Persistent storage for drawings and exports. |
| T45 | Production deployment validation | Fresh deployment, env vars, API and runtime checks. |
| T23 | Hydration window tuning | Tune the 200-run window against real usage. |

---

## LATER - Phase 8: Final polish

| # | Ticket | What it needs |
|---|---|---|
| T20 | Exception tier tuning | implausible_magnitude blocking and low_confidence frequency are guesses until real drawings land. |
| T21 | Queue traversal by cursor | Resolving reorders the queue; an index can land on the wrong item. |
| T22 | Locality hierarchy | Karnataka will not match Mysuru; aliases are a flat table. |
| T46 | Drawing viewer minimap | A minimap so zoom and pan stay oriented on large drawings. |

---

## BLOCKED - needs real-world input, not code

| # | Ticket | What unblocks it |
|---|---|---|
| B1 | #19 real-project validation | 10 to 15 real architectural DXFs from 2 or 3 studios, saved from AutoCAD. The E0/E1 harness is built; it has never seen an architectural drawing. |
| B2 | E0 ground truth | One studio past BOQ for a drawing they also supply. |
| B3 | Live vision validation | A VISION_API_KEY and one real run; discovery and error handling are stub-verified only. |
| B4 | Exception calibration | Real drawings to decide which exceptions should actually block approval. |
| B5 | Accuracy validation | System quantities vs real BOQs, category by category. |
| B6 | Service vs SaaS | A business decision that changes what gets built. |

---

## DECIDED NO

| # | Decision | Reasoning |
|---|---|---|
| N1 | No DWG ingestion in V1 | DWG is closed binary; RealDWG and APS are enterprise licensing, LibreDWG is beta, ODA automated-use terms are unverified. Save As DXF is one click. Sample availability is a testing problem, not a customer problem. Revisit only when a paying customer blocks on it. |
| N2 | No live rate feed or scraping | Studios supply their own books; published schedules are import-only. |
| N3 | No headline accuracy percentage | Category-level deltas only; a single number on a synthetic corpus is an unsupported claim. |

---

## DONE

### Frontend rebuild

| # | Work | Shipped |
|---|---|---|
| F1-F5 | Single store, one API client, real router, data-driven views, build guard | public/js modules |
| F6 | Raster/OCR ported behind the state boundary | public/js/raster.mjs |
| F7 | Frontend state and API-client tests | test/frontend-*.test.js |
| F8 | Browser tests on the real navigation contract | test/operator-navigation.test.js |
| F9 | Build-freshness guard | GET /api/build |
| D35 | Interactive drawing viewer | public/js/drawing-viewer.mjs |

### Engine and pipeline

| # | Work | Shipped |
|---|---|---|
| D1 | R2 unified provenance | src/provenance.js |
| D2 | Block geometry for INSERT references | bounds 8/15 to 0 degenerate |
| D3 | R1 SQLite persistence behind a repository | 4-query rollup, append-only audit |
| D4 | #6 versioned rulesets, deductions, assumptions | wall_plaster 157.2 to 143.79 |
| D5 | #18 conformance corpus, four-outcome ledger | 63 observations, 0 unflagged errors |
| D6 | #10/#11 server-side vision, label-only contract | key in server config |
| D7 | #12/#13 exception queue, grouping, append-only approval | 12 to 1 grouping |
| D8 | #15/#16 rate books, vendor offers | Q8 answered |
| D9 | #24/#17 catalogue, reproducible exports | Q9 answered, byte-identical |
| D10 | #14 workspace evidence API, signed breakdown | 4 queries |
| D11 | E0/E1 validation harness | proven on synthetic corpus |

### Real-drawing ingestion

| # | Work | Shipped |
|---|---|---|
| D12 | Accept real DXF group-code padding | every AutoCAD file was rejected |
| D13 | unsupported is not malformed | 67/68 AutoCAD corpus parses |
| D14 | LINE entities no longer discarded | walls-as-lines measured nothing |
| D20 | Graceful external references | Floorplan (1).dxf ingests |

### Measurement coverage

| # | Work | Shipped |
|---|---|---|
| D16 | T1 walls from LINE and LWPOLYLINE | Gplus2 wall_plan 0 to 64.584 |
| D17 | T2 floor from wall boundary, flagged | Gplus2 floor 0 to 120, LOW confidence |

### Pricing and export

| # | Work | Shipped |
|---|---|---|
| D18 | T4/T10 HTTP export CSV XLSX PDF plus sidecar and UI download | end-to-end export |
| D19 | Default catalogue | residual_test 9 blocking to 0 |
| D26 | Default indicative rate book | exports carry amounts |
| D27 | Export rates and amounts | CSV XLSX PDF all priced |

### Operator workflow

| # | Work | Shipped |
|---|---|---|
| D21 | T3 unit asked only when resolution fails | verified in-browser |
| D22 | T5 project list plus restore on reload | refresh no longer strands work |
| D23 | T6 empty sections dimmed and labelled | |
| D24 | T7 optional project name, Start working | |
| D25 | T11/T12/T13 terminology, 10 MB limit, auto-select | |
| D32 | Approval failures show their reason | was a silent TypeError |
| D33 | Vercel serverless entry, valid config | api/index.js |
| D34 | Vercel first-paint fix | lazy OCR, critical CSS, CDN assets |
| D36 | boqVersionId wired into the UI | Approve and Export reachable |

---

## The phase roadmap

NOW: Phase 1 Drawing intelligence (T24-T30)
  then Phase 2 Raster and OCR (T8, T9, T31-T34, T17)
  then Phase 3 Professional UX (T35-T40)
  then Phase 4 Real pricing (T15, T16, T18, T19, T41, T42)
  then Phase 5 Production (T14, T43, T44, T45, T23)
  then Phase 6 Real studio validation (B1-B5)
  then Final polish (T20, T21, T22, T46)

---

## Standing rules

- Commit directly to main. No PRs, no GitHub issues.
- Test-first at public behavioural seams.
- Never fabricate results; unimplemented is reported as unavailable.
- Run the nine-question merge gate on anything touching quantities or provenance.
- A user-facing ticket is DONE only when it works end to end in the real UI.
- Add new limitations to OPEN-ITEMS.md, not to report prose.
- Batch related tickets, but never mark one done half-way.
