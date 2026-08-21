# Open items — everything known-imperfect

**As of:** B4 complete · `main` @ 234 tests · 18 of 23 tickets done

Not a bug list. These are known, accepted or deferred limitations that live only in
batch-report prose today. Anything here can bite later; nothing here is a surprise.

---

## Tier 1 — would change what we can claim

**1. Nothing has ever been tested on a real drawing.**
234 tests, 63 corpus observations, ~20 fixtures — all synthetic, all written by us. A
fixture reflects what we *think* a drawing looks like. E1 (what fraction of entities
classify from layer + hatch + block name, across different studios) is still unrun, and
it decides the product's shape: >70% build as planned · 40–70% the studio profile *is*
the product · <40% wrong segment. **No amount of ticket completion substitutes for this.**

**2. No monetary or accuracy claim is currently supportable.**
Deliberately. #18 computes no accuracy percentage and a test asserts its absence,
because a synthetic corpus cannot support one. Keep it that way until E0/E1.

**3. The vision provider has never been called live.**
Discovery and error classification are verified against stubs — by construction, not
against real behaviour. You have a key from the prototype; one run against
`residual-blocks.dxf` closes this in ten minutes.

---

## Tier 2 — real modelling gaps

**4. No internal/external wall distinction.** ← *not previously raised*
`wall_plaster` is one line covering both faces of every wall. Real BOQs price internal
and external plaster as **separate items** — different specification, different rate,
often different thickness. A perimeter wall's outer face is not the same product as a
partition's face. It is geometrically derivable (perimeter vs interior wall) and will
surface the first time an output is compared against a studio's own BOQ. Belongs in a
`clean-plan-v3` ruleset.

**5. No minimum-opening-area threshold.**
Common practice does not deduct very small openings — they are treated as solid. Every
opening currently deducts regardless of size. Needs checking against IS 1200 before
implementing; flagged, not asserted.

**6. Rectangular proposals only (Tier C).**
`coerceBoxes` accepts axis-aligned rectangles, so a confirmed proposal over an L-shaped
room overstates area. Mitigated — the human sees the overlay, and #12 now raises a
`rectangular_proposal` exception — but not solved. Geometry field already holds
polygons, so no schema change when it is.

**7. PDF and raster cannot reach `not_measurable` end to end.**
Their setup gates refuse measurement without a region, which is the stronger guarantee.
For those tiers it is a defensive state covered at the derivation seam only.

---

## Tier 3 — uncalibrated judgement

**8. Plausibility bands.** The first judgement thresholds in the codebase — everything
else is derived or operator-supplied. Sized to catch a 10× scale error. A genuinely
large building may trip them. Only real drawings can calibrate this.

**9. `implausible_magnitude` blocks approval.** Defensible, and annoying on a large
building. One line to reclassify if real drawings say so.

**10. `low_confidence` fires on any non-HIGH line.** On a drawing with thin evidence
throughout this could flood the advisory tier. Grouped by measurement so the *group*
count won't flood, but watch it on a real drawing.

---

## Tier 4 — housekeeping and deferred

**11. `vision.js` is dead code and a hazard.** Prototype-only, browser-keyed, imported by
nothing since #10 replaced it. It still contains a live-looking API key field. Delete it
— dead code that looks operational is how a browser-keyed path gets revived by accident.

**12. `source_objects` navigation overlay** is a workaround over deduplicated rows
(assignment-as-first-observed, overlaid at read time). Works; revisit if it complicates
#14.

**13. Revision diffing** — deferred by choice. Schema supports document versions; the
feature waits. Don't let a batch preclude it.

**14. Auth, accounts, deployment** — F3/D1, nothing built, nothing designed.

**15. Q8 and Q9 remain vacuous** — no rate book, no export surface. #15 and #17 close
them. Do not let a report tick them before then.

---

## What has genuinely gone well

Worth recording, because the list above is one-sided. Every batch since integration has
found a real defect that the *previous* batch introduced or missed:

- #18 caught #6's multi-storey deduction error — an unflagged financial error
- #10/#11 caught studio mappings never persisting, and R2's enum guard being walked around
- #12/#13 caught its own dishonest cross-unit proxy ordering before it shipped
- 3b caught a stale storey surviving reassignment
- R2 caught a test that had become silently vacuous

That is the merge gate and the corpus doing their job. The process is working; the
validation gap at the top of this file is the part it cannot fix on its own.
