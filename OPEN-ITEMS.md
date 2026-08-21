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
| Q9 | Can an unresolved BOQ be exported? | **Open** — no export surface exists (#17). `exportable` and the approval gate are both honest today, but nothing consumes them. |

## Carried limitations

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
- **Rate lookup matches on `itemCode` equal to the measurement name.** There is no
  catalogue mapping between a measured item and a priced one, so a rate book must use
  the measurement names. Real rate books will not, and #17 or a later batch needs a
  mapping layer.
- **Locality matching is exact-string.** A rate scoped to "Bengaluru" does not match a
  project in "Bangalore". No locality hierarchy or aliasing exists.
- **`getPricedBoq` prices the project rollup only.** There is no per-storey or
  per-building priced view yet.
- **Vendor offers do not feed the priced total.** They are surfaced for a human to
  choose; a selection is recorded but does not currently re-price the BOQ line. That
  wiring belongs with the export batch, where the chosen price actually has to appear.
