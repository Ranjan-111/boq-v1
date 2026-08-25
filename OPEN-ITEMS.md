# Open items

Known limitations, carried deliberately. Each says what is missing, why it was left,
and what would close it. Anything discovered during a batch belongs here rather than
in report prose, where it is lost after one reading.

Merge-gate questions that remain unanswerable are listed as such — a vacuous gate must
never be reported as a satisfied one.

## Merge gate

| # | Question | State |
|---|---|---|
| Q8 | Can a stale rate or vendor reach an export? | **Answered** by #15/#16: a rate outside its validity window raises a blocking exception and cannot be approved. No export surface exists yet, so the export half is covered by the approval gate. |
| Q9 | Can an unresolved BOQ be exported? | **Answered** by #17: export is refused for anything that is not an approved BOQ version, and approval is already blocked by open exceptions, stale rates and unmapped measurements. Demonstrated, not asserted. |

## Carried limitations

- **T28 (human verification on the drawing) is partially implemented.** The
  exception queue's resolve buttons clear exceptions and re-measure, which
  covers the "confirm/reject" part. But the full canvas-interaction workflow
  (drawing a room outline, adjusting a boundary by dragging vertices) is
  genuinely remaining and needs a dedicated interaction design pass.
- **The drawing viewer is read-only over existing provenance data.** It does
  not fetch, does not create measurements, and has no state of its own beyond
  what is currently displayed. Clicking an object emits an event; the
  workspace listens and shows the reverse lookup. A full "click to edit"
  workflow would need new API surface.

- **Walls are only measured from HATCH entities.** Many real drawings draw walls as
  closed LWPOLYLINEs or as pairs of LINEs, so a drawing can now ingest cleanly and still
  measure almost nothing -- `Gplus2_combined_layers_fixed.dxf` ingests and measures 3 of
  9 lines for exactly this reason. This is the next blocker after ingestion and is a
  measurement-rule question, not a parser one.
- **DWG is not supported and is what most sample drawings are.** DWG is a closed binary
  format; reading it needs a third-party library (LibreDWG, ODA File Converter) or a
  server-side conversion step. Nothing in this repository reads it.
- **The OCR crop is specified by typing x/y/width/height.** There is no way to draw the
  crop on the image, which makes the feature effectively unusable, and a mis-typed crop
  returns "Malformed OCR polygon or empty text" with no guidance.
- **Raster calibration always asks for two points and a distance**, even when the sheet
  carries a printed scale bar or a dimension string that OCR could read first.

- **Serverless hosting loses state between instances.** The application keeps its
  SQLite database in memory (`file: ':memory:'`) and its working set in the process, so
  on Vercel a warm function instance behaves correctly and a cold start or a second
  concurrent instance sees an empty system -- an existing project returns "Project not
  found". `api/index.js` makes the deployment boot and run a drawing end to end, which
  is enough to demonstrate, but this is a long-lived stateful server and a persistent
  host (Render, Railway, Fly, a VPS) is the correct home for it. Moving the store to
  Postgres is the alternative; `src/repository.js` was kept narrow for exactly that
  swap.
- **Background stage advancement does not survive a frozen function.** The serverless
  entry therefore schedules stages synchronously, so a DXF upload completes inside the
  request. PDF and raster runs still gate on operator input across requests and are not
  proven on serverless.

- **#19 is not closed and cannot be.** The E0/E1 harness is built and proven against
  synthetic fixtures, but every figure the product has ever produced is measured against
  fixtures we wrote. No real studio drawing has been through it. The harness removes the
  engineering delay, not the evidence gap.
- **E1 counts classification, not measurability.** `exploded-furniture.dxf` classifies
  100% -- the polylines sit on a furniture layer -- while `furniture_count` is
  `not_measurable`, because no rule measures a furniture polyline. A high E1 percentage
  does not by itself mean a drawing will produce a BOQ.
- **E0 matches ground truth by internal measurement name.** A studio's takeoff will be
  worded their way, so someone must map their rows to ours when filling the template.
  The catalogue (#24) is where that mapping belongs once real books exist.
- **One ground truth covers one drawing.** Comparing a folder against a multi-drawing
  takeoff needs a per-file key the format does not yet have.

- **A viewport for point-bounds objects is an invented extent.** An unresolved block
  reference has no measurable size, so the workspace widens to a minimum and flags
  `degenerate: true`. Resolving block extents properly (the `BLOCKS` expansion 3a
  already does for defined blocks) is the real fix for drawings whose blocks are
  missing.
- **`viewportsByStorey` gives one rectangle per storey, with no cross-storey view.**
  A line spanning storeys cannot be shown in a single viewport; deciding what a
  multi-storey selection should actually display is a frontend design question.
- **Queue traversal is by index.** Resolving an exception re-orders the queue, so an
  index held across a resolution may land on a different item. A cursor keyed on
  `groupKey` would be steadier once the frontend defines the interaction.

- **No live rate feed, by design.** V1 imports a studio's own rate book and, optionally,
  a dated published schedule. No scraping, no market feed. Published schedules are
  import-only: none is embedded in this repository because the licensing is unverified.
- **Plausibility bands are judgement thresholds.** The only non-derived, non-operator
  numbers in the codebase. Sized to catch a 10× scale error; a genuinely large building
  could trip them. They need real drawings to calibrate.
- **`low_confidence` fires on any non-HIGH line.** Grouped by measurement so it cannot
  flood the group count, but on a drawing with thin evidence throughout it will fill the
  advisory tier. Worth re-tuning once real drawings go through.
- **`implausible_magnitude` blocks approval.** Defensible, but it will be irritating on a
  genuinely large building. One line to reclassify to advisory if real use says so.
- **Raster boundary proposals are axis-aligned rectangles only.** `coerceBoxes` cannot
  express an L-shaped room. Mitigated by the `rectangular_proposal` exception rather than
  fixed; polygon proposals would need a different reply contract.
- **`detectRegions` has never run against a live provider.** Discovery and error
  classification are verified against stubs. The first real key is the actual test.
- **`hydrate()` loads a bounded window of 200 runs.** Older runs load on demand. Fine at
  current scale; the window size has not been tuned against a real project's history.
- **Vendor offers are not deduplicated across studios.** Two studios importing the same
  supplier list hold separate rows. Correct for scoping, wasteful at scale.
- **No published schedule of rates is bundled.** Import path only; licensing for any
  government schedule is unverified, so none is embedded in the repository.
- **Locality aliases are a fixed table, not a hierarchy.** Bengaluru/Bangalore and
  friends normalise, but there is no state or region containment, so a rate scoped to
  "Karnataka" will not match a project in "Mysuru".
- **Resolved (B8):** the printed total is now the sum of the printed row amounts, so an
  estimator can tie the column. The exact figure is carried in the provenance sidecar as
  `exactAmount`. #15's accumulate-exact rule still governs every internal total; this is
  a presentation-boundary exception only.
- **One measurement maps to at most one item per unit.** The catalogue holds several
  items per measurement, but `applyCatalogue` takes the first whose unit matches.
  Splitting a measured quantity across internal and external plaster needs an
  apportionment rule that does not exist.
- **The XLSX writer is minimal.** One sheet, inline strings, no styling or number
  formats. Valid and deterministic, but a client-facing document will want formatting.
- **Exports price from the rate book, not from a selected vendor offer.** A vendor
  selection is recorded and audited but does not change an exported amount.
- **`getPricedBoq` prices the project rollup only.** There is no per-storey or
  per-building priced view yet.
- **Vendor offers do not feed the priced total.** They are surfaced for a human to
  choose; a selection is recorded but does not currently re-price the BOQ line. That
  wiring belongs with the export batch, where the chosen price actually has to appear.

## Frontend rebuild (F1–F9)

Carried limitations after replacing the generated frontend:

- **Rollup lines have no confidence grading.** The grading lives on the run,
  not the rollup. Reopening a project now restores the contributing run so the
  grading comes back; if that run can no longer be read, the confidence column
  reads "not graded in this view" rather than inventing a level.
- **Only the most recent contributing run is restored on reopen.** A project
  fed by several drawings shows the last one's classifications. The rollup
  quantities are complete either way; the classification table is not.
- **The build-freshness guard compares a hash of the frontend modules only.**
  A backend-only change does not shift the build id, so a server stale in its
  API but current in its assets will not be flagged.
- **No frontend rendering tests.** Reducers and the API client are unit-tested,
  and flows are covered in a real browser; the renderers in between are
  exercised only through the browser tests.
