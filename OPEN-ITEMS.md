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
