# Tickets

One chart. Merges the pre-frontend plan (`chat handoff reference/HANDOFF.md` §12 and the
build plan §6–7) with everything found since the frontend landed, plus the carried
limitations in `OPEN-ITEMS.md`.

**Status key** — `DONE` shipped · `NOW` next up · `NEXT` after that · `LATER` real work,
not yet · `BLOCKED` waiting on something outside the code · `DECIDED-NO` deliberately
not doing.

Ordering within a status is by value, not by effort.

---

## NOW — these are what stand between you and a BOQ from a real drawing

| # | Ticket | Why it matters | Depends on |
|---|---|---|---|
| ~~T1~~ | **DONE — measure walls drawn as LWPOLYLINE and LINE** | Rules only measure walls from `HATCH`. Real plans draw walls as closed polylines or line pairs, so a drawing ingests and the BOQ comes back nearly empty. `Gplus2` measures 3 of 9 lines for exactly this reason. Needs a centre-line-plus-thickness rule using the existing `wallThickness` assumption. | — |
| ~~T2~~ | **DONE — floor inferred from wall boundary (flagged) + broader floor layers** | Rooms are only found as `LWPOLYLINE` on a room-named layer. Most drawings have no room layer at all; the room is implied by the walls enclosing it. Without this, `floor_area` is 0 on most real files. | T1 |
| ~~T3~~ | **DONE** — Ask for the fallback unit *when* units are missing, not upfront | The backend already accepts `fallbackUnit` and completes correctly — verified. The frontend shows the selector from the start, so it reads as a required field nobody understands, and the failure that needs it looks like a dead end. Pure UX wiring. | — |
| ~~T4~~ | **DONE — export over HTTP (CSV/XLSX/PDF + sidecar), buttons in UI** | `exportBoq` is built, tested and reproducible, but has no server route. The "Approve & Export" nav item has nothing behind it. Q9 is closed in the engine and unreachable in the product. | — |
| ~~T5~~ | **DONE** — `GET /api/projects` + restore the workspace on reload | No list endpoint exists and the frontend keeps no project id, so refreshing the page strands an existing project permanently. On a demo this reads as data loss. | — |

## NEXT

| # | Ticket | Why it matters | Depends on |
|---|---|---|---|
| ~~F1–F9~~ | **DONE — frontend rebuilt** | The interface had no state model: the same fact lived in a `dataset` attribute, a module variable, `localStorage` and DOM text, and every reported bug was two of them disagreeing. The sidebar did not navigate — `showView` only scrolled — so every section rendered at once. Rebuilt around one store, one API client, and a real router. See `FRONTEND-REBUILD.md`. | — |
| ~~T6~~ | **DONE** — Progressive disclosure: hide sections until they have content | Every section renders as an empty heading before anything is uploaded. Makes a working system look broken. | — |
| ~~T7~~ | **DONE** — Landing → upload → work, in that order | Project name is demanded before anything can happen. Make it optional: let someone upload and look, and name the project only if they are keeping it. | T6 |
| T8 | **Draw the OCR crop on the image** | The crop is specified by typing x/y/width/height. Unusable in practice — 40 attempts, 0 successes — and a mis-typed crop returns "Malformed OCR polygon or empty text" with no guidance. | — |
| T9 | **OCR-first raster flow** | On upload, run OCR before asking anything: read the scale bar, the units and the dimension strings, propose regions, then show the human what was found for confirmation. Today the operator is asked for two points and a distance even when the sheet states its scale. | T8 |
| ~~T10~~ | **DONE — deterministic PDF export** | The artefact is already format-agnostic, so this is a new encoder rather than a new pipeline. A client-facing BOQ is expected as PDF. | T4 |
| ~~T11~~ | **DONE** — Rename "Create processing run" | Internal vocabulary on the primary button. | — |
| ~~T12~~ | **DONE** — Reconcile the upload limit | UI promises 50 MB, backend enforces 10 MB. | — |
| ~~T13~~ | **DONE** — Auto-select a newly created building | Creating a building then failing with "Select a building before adding a storey" is needless friction. | — |

## LATER

| # | Ticket | Why it matters | Depends on |
|---|---|---|---|
| T14 | **Persistent host, or Postgres** | The store is in-memory, so on Vercel a cold start returns "Project not found". `src/repository.js` was deliberately kept narrow so this is a one-file swap. | — |
| T15 | **Catalogue mapping for real rate books** | Rates are matched on `itemCode` equal to the measurement name, so a studio must author its rate book as `floor_area`. Real books will not. | — |
| T16 | **Vendor selection should re-price the line** | A selection is recorded and audited but does not change an exported amount. | T4 |
| T17 | **Polygon raster proposals** | `coerceBoxes` accepts axis-aligned rectangles only, so an L-shaped room is squared off. Mitigated by the `rectangular_proposal` exception, not fixed. | — |
| T18 | **Split one measurement across several items** | Internal vs external plaster needs an apportionment rule that does not exist. | T15 |
| T19 | **Style the XLSX** | One sheet, inline strings, no formatting. | T10 |
| T20 | **Tune the exception tiers on real drawings** | `implausible_magnitude` blocks approval and `low_confidence` fires on any non-HIGH line. Both are guesses until real drawings go through. | BLOCKED-1 |
| T21 | **Queue traversal by cursor, not index** | Resolving an exception reorders the queue, so a held index can land on a different item. | — |
| T22 | **Locality hierarchy** | Aliases are a fixed table; "Karnataka" will not match "Mysuru". | — |
| T23 | **Bounded `hydrate` window tuning** | Constant at 200 runs, never tuned against real history. | T14 |

## BLOCKED — not solvable by writing code

| # | Ticket | What unblocks it |
|---|---|---|
| B1 | **#19 real-project validation** | 10–15 real DXFs from 2–3 studios, saved from AutoCAD rather than downloaded. The E0/E1 harness is built and proven; it has never seen an architectural drawing. |
| B2 | **E0 ground truth** | One studio's past BOQ for a drawing they also give you. |
| B3 | **Live vision call** | A `VISION_API_KEY` and one run against `residual_test.dxf`. Discovery and error handling are verified against stubs only. |
| B4 | **Service vs SaaS** | A business decision that changes what gets built. |

## DECIDED-NO

| # | Decision | Reasoning |
|---|---|---|
| N1 | **Do not build DWG ingestion** | Already decided in the build plan §6 and it still holds. DWG is closed binary; RealDWG and Autodesk Platform Services are enterprise licensing, LibreDWG is self-described beta, and ODA File Converter's terms for automated server use are unverified. "Save As → DXF" is one click for an architect. **The sample-files-are-all-DWG problem is a testing problem, not a customer problem** — convert them locally with the free ODA converter to build a corpus. Revisit only when a paying customer's workflow genuinely blocks on it. |
| N2 | **No live rate feed, no scraping** | V1 imports a studio's own book plus optional dated published schedules. |
| N3 | **No headline accuracy percentage** | Per-category deltas only. A single number on a synthetic corpus is a claim the evidence cannot support. |

## DONE

| # | Ticket | Shipped |
|---|---|---|
| D26 | Frontend rebuild: single store, one API client, real router (F1–F5) | `public/js/{store,api,router,render,app}.mjs` |
| D27 | Raster/OCR ported behind the new state boundary, behaviour unchanged (F6) | `public/js/raster.mjs` |
| D28 | Frontend state and API-client tests — a layer that could not be tested before (F7) | `test/frontend-store.test.js`, `test/frontend-api.test.js` |
| D29 | Browser tests moved to the real navigation contract (F8) | `test-support/operator-page.js`, `test/operator-navigation.test.js` |
| D30 | Build-freshness guard: a stale server announces itself (F9) | `GET /api/build`, `#build-stale` |
| D31 | Reopening a project restores its run, so the graded BOQ comes back | `restoreRun()` in `public/js/app.mjs` |
| D1 | R2 unified provenance (SourceObject / Contribution) | `src/provenance.js` |
| D2 | Block geometry for INSERT references | degenerate bounds 8/15 → 0 |
| D3 | R1 SQLite persistence behind a repository | 4-query rollup, append-only audit |
| D4 | #6 versioned rulesets, opening deductions, project assumptions | `wall_plaster` 157.2 → 143.79 |
| D5 | #18 conformance corpus + four-outcome ledger | 63 observations, 0 unflagged financial errors |
| D6 | #10/#11 server-side vision, label-only contract, confirmed raster proposals | key in server config, never in a URL |
| D7 | #12/#13 one exception queue, grouping, append-only approval | 12 → 1 group on repeated symbols |
| D8 | #15/#16 versioned rate books, vendor offers | Q8 answered |
| D9 | #24/#17 item catalogue, reproducible approved exports | Q9 answered, byte-identical re-export |
| D10 | #14 workspace evidence API, signed breakdown | gross − deductions = net, 4 queries |
| D11 | E0/E1 validation harness | read-only tooling, proven on synthetic corpus |
| D12 | Accept real DXF files (group-code padding) | every AutoCAD/ezdxf file was being rejected |
| D13 | Ingest real DXF instead of refusing entity by entity | unsupported ≠ malformed; 67/68 AutoCAD corpus parses |
| D14 | Stop discarding LINE entities silently | validated then thrown away; walls-as-lines measured nothing |
| D15 | Vercel serverless entry point | `api/index.js`; the deployment boots |
| D16 | T1 — walls from LINE / LWPOLYLINE | centre-line length; HATCH byte-identical; Gplus2 wall_plan 0 → 64.584 m² |
| D17 | T2 — floor from wall boundary when no room, flagged | Gplus2 floor 0 → 120 m² at LOW confidence + review exception |
| D18 | T4/T10 — HTTP export (CSV/XLSX/PDF) + provenance sidecar + UI download | residual_test now exports end to end |
| D19 | Default catalogue so approve/export is reachable without authoring one | residual_test 9 blocking → 0, approves |
| D20 | Graceful external references (xref INSERT skipped + flagged, not fatal) | Floorplan (1).dxf ingests, missing furniture library flagged |
| D21 | T3 — unit asked only when resolution fails, at the moment it matters | verified in-browser |
| D22 | T5 — `GET /api/projects`, picker, and auto-restore on reload | refresh no longer strands a project |
| D23 | T6 — empty sections dimmed in nav and labelled, not blank headings | |
| D24 | T7 — project name optional, "Start working" | upload is no longer gated on naming |
| D25 | T11/T12/T13 — "Measure this drawing", real 10 MB limit, auto-select new building/storey | |

---

## Corpus note

`jscad/sample-files` (68 AutoCAD-authored DXFs) is now a useful **parser** regression
corpus — 67 parse cleanly. It is **not** an architectural corpus: they are geometry
primitives on layer `0`, so E1 classification reads 0.0% and the harness correctly
reports a category collapse rather than inventing a number. It proves the parser and the
harness; it cannot answer the E1 question. Only B1 can.
