# Drawing-to-BOQ — Handoff

**Owner:** Harsh Yadav, Outlrs Labs · **Prepared:** 19 Aug 2026
**Purpose:** complete context transfer. Read this first in a new session; everything else is detail.

---

## 1. What this is

An AI-native system that turns an architectural drawing into a reviewable, priced Bill of Quantities where **every number traces back to the exact entities that produced it**.

Modelled on 360 Labs' Drawing-to-BOQ for Nozer Wadia Associates, with ideas borrowed from their Sterling & Wilson BOQ platform — but built on a different architecture, because theirs has a structural flaw (below).

**Status:** planning complete · Phase 0 partially passed · working prototype built and tested · **not launch-ready**, because two feasibility tests remain impossible without real studio drawings.

---

## 2. The one decision everything hangs off

> **The AI never produces a number.**

360 Labs' portfolio lists "Gemini Vision" and "Hatch Classification." A DXF is *already* exact vector data — every wall hatch has a computable boundary area, every sofa is an `INSERT` with a name and position. Running vision over it re-derives numbers from pixels that were already precise in the file. That is why vision-first tools plateau around 80–95% and why their outputs still need re-keying.

**Split enforced in code:**

| Engine | Owns | Failure mode |
|---|---|---|
| Geometry (deterministic) | every area, length, count | crashes loudly, never guesses |
| Semantic (rules → vision) | what a thing *is* | guesses wrong, caught in review |

A wrong classification is one dropdown to fix and everything recomputes. A wrong measurement is money, and nobody notices until the client is billed.

### The tier-dependent form of the rule
- **Tier A (DXF):** model may return a **label only**. Exact geometry already exists.
- **Tier C (raster):** no geometry exists, so the model may propose a **boundary** — but **scale is always human-supplied**. Pixels become metres only through a figure a person typed. Remove that number and every quantity is undefined, so no model output can independently become a quantity.

---

## 3. Frozen architecture (changing these means a rewrite)

1. Two-engine split — geometry owns numbers, AI owns labels
2. Label-only response contract from the vision model on Tier A
3. Four separable layers: **geometry → rules → items → rates**
4. Entity immutability; classifications and human overrides append-only with `supersedes`
5. Provenance handles stored on every measurement
6. Scale gate reads **raw file text**, never a library's default
7. Three-state measurements: `measured` / `measured_zero` / `not_measurable`
8. `BLOCK` severity tier that gates export
9. Category-vs-item residuals are different unknowns (§6)
10. Scale is human-supplied on every tier

**Deliberately not frozen:** ontology, ruleset content, sanity thresholds, review weighting, all UI, vendor matching scores.

---

## 4. Input tiering

| Tier | Format | Geometry | Semantics | Status |
|---|---|---|---|---|
| **A** | DXF | exact | full (layers, blocks, hatch) | ✅ built |
| **B** | vector PDF | exact | **none** — PDF has no layers/blocks/hatch | ✅ built |
| **C** | raster PNG/JPG | none | none | ✅ built (calibrate + trace/confirm) |
| — | **DWG** | — | — | ❌ **refused, with measured evidence** |

**DWG refusal is a finding, not a gap.** Tested on 6 real DWG files with the only free reader installable:
- 4 of 6 hard-failed
- The 2 that "converted successfully" were **silently corrupted**: unit code rewritten inches → metres (**39× scale error**), every entity's layer link severed, block definitions gone, 77 hatch boundaries across a 2,707,406 sq-unit plan collapsed to **16.7 sq units**
- Nothing threw. Files opened. Numbers looked like numbers.

**Real success rate: 0 of 6.** Had we run classification on the "successful" pair we'd have reported "0% classify from layer names" — a fact about the converter, not about drawings.

The paid routes (Autodesk RealDWG / APS) are right for a funded team and wrong here. **DXF-only stands.** "Save As → DXF" is one click, and under the service model you receive files yourself.

---

## 5. Pipeline as built

```
upload → sniff bytes → tier route
  A: DXF parse (entities, layers, blocks, hatch)
  B: PDF inflate + content-stream walk (re/m/l/c/h/cm/q/Q with CTM)
  C: raster → operator picks 2 points + real distance → px per metre
        ↓
  scale gate  (HALTS if $INSUNITS absent — parser defaults are not evidence)
        ↓
  four-signal rule classify (layer · hatch · block name · geometry)
        ↓
  residuals only → tight crop → Gemini → LABEL ONLY
        ↓
  fusion, confidence = signal agreement (never model self-report)
        ↓
  deterministic measurement + provenance handles + explanation strings
        ↓
  sanity checks + ABSENCE checks (a zero is not a measurement)
        ↓
  risk-routed review: confidence × money at risk
        ↓
  human: accept / edit assumption / override qty / reject  (append-only audit)
        ↓
  export gated on: no BLOCK flags · no unresolved reviews · no unconfirmed
                   proposals · named approver
```

---

## 6. Findings that changed the design

Each of these came from a test, not from reasoning.

**Silent zero (A6).** Adversarial case returned floor area 0.00, wall 0.00, rooms 0 — with only a MED flag. Sanity checks validated ratios *between numbers that existed* and said nothing when a category came back empty. **A zero is the most dangerous number in the system**: indistinguishable from a real measurement of nothing, calm-looking in a spreadsheet, silently deletes a cost line. → Added absence checks and the `BLOCK` tier.

**Parser defaults masquerading as data.** `ezdxf` reported `$INSUNITS = 6` (metres) for a file containing **no header section at all**. Trusting it turned a 20×15 plan into 300 m² of two 150 m² bedrooms. → Scale gate reads raw file text.

**Category ≠ item.** Renaming `SOFA_3S` → `Block_17` produced **zero** residuals, because layer `A-FURN` still voted furniture. Technically right, practically wrong: you get the correct **count** but no **item identity**, so the line cannot be priced or vendor-matched. Real drawings are full of this case. → Residuals now split `ITEM UNKNOWN · counts OK` vs `CATEGORY + ITEM UNKNOWN`.

**Geometry can't resolve counts.** Two window lines on opposite walls: one window or two? Lengths are exact and unarguable; the count is semantic, and zero blocks existed to answer it. → Ambiguous counts are flagged, never heuristically guessed.

**Edit the cause, not the number.** Typing `18.08 → 19.20` over a quantity severs provenance. Two paths now: *edit assumption* (wall height 3.0 → 3.2 m recomputes masonry 18.08 → 19.28 m³, plaster 157.20 → 167.68 m², provenance intact) and *override* (allowed, demands a reason, tags the line `PROVENANCE BROKEN`, CSV says "not traceable to drawing").

**Stale approvals.** Changing a parameter after accepting a dependent line invalidates that acceptance — the line goes `STALE` and re-gates export. You approved 18.08, not 19.28.

**Hardcoded model names rot.** `gemini-2.0-flash` was retired **31 March 2026** (not 1 June, as circulated). `gemini-3.5-flash` is already two releases behind — **3.7-flash is current**. → Model names are now discovered from `GET /v1beta/models`, with a preference chain as fallback. Key moved to an `x-goog-api-key` header, out of the URL.

**Bounding boxes.** Gemini returns `box_2d` as `[ymin, xmin, ymax, xmax]` normalized 0–1000 — **y first**, easy to invert. Google's own reference instructs "never return masks." A 2px absolute degenerate-box filter let a 6×4px sliver through and inflated room count 2 → 3; thresholds are now relative to image size.

**Sanity band mis-calibration.** Plaster:floor ratio flagged small units falsely — a 12 m² studio legitimately has more wall per m² of floor. Widened to 1.5–9 below 25 m² and tagged `CALIBRATION: band needs real drawings` rather than tuned until flags disappeared.

---

## 7. Test results

| Suite | Result |
|---|---|
| Python engine vs synthetic ground truth | **30/30 exact** on 5 clean plans |
| JS engine vs same ground truth | **51/60** — identical to Python, same 9 expected degradations |
| Adversarial variants (6) | correct behaviour on all after the A6 fix |
| `residual_test.dxf` measurement | **6/6** vs spec-derived truth |
| Residual detection | 3 unnamed blocks flagged, 3 named blocks correctly not flagged |
| PDF vector extraction | rectangles recovered at **162000 / 115200 pt² exactly**, CTM applied |
| Label contract (8 adversarial replies) | **no number survived**, incl. prompt injection |
| Raster box parser | survives fenced JSON, `{boxes:[]}` wrappers, junk fields, garbage |
| Tier C headless simulation | scale → confirm → measure verified; 0 AUTO lines on Tier C |

Ground truth is computed **arithmetically from spec dicts** and never read back from emitted files — generator and grader share no code path.

---

## 8. Still open — read this before claiming anything

| Item | Why it matters |
|---|---|
| **E0 — human error floor** | Never run. Needs one studio's past BOQ for a drawing they also give you. Until then "≤2% accuracy" is a number with no denominator — two QSs disagree with each other by some unknown amount. |
| **E1 — classification %** | Never run. **This decides the product shape.** >70% → build as planned · 40–70% → the Drawing Standard Profile *is* the product · <40% → change segment. |
| Live Gemini call | Everything around it is tested; the call itself needs a key to verify end to end. |
| Sanity band calibration | Placeholder thresholds; needs real drawings. |
| Rates | Placeholders, labelled as such in the UI. |

**The honest line for any deck:** this proves the architecture is sound and the engine is exact on geometry it can read. It does **not** prove real Indian architectural drawings will classify well enough to be commercially accurate. That needs a pilot.

E0 and E1 block the **launch claim**, not the build.

---

## 9. Product and business decisions

**Segment:** boutique residential / interior fit-out studios, Bangalore first. The only segment v1's scope genuinely serves, and one person wears all three hats (operator, signer, buyer).

**Model — recommendation: done-for-you service first, not SaaS.** Per-seat AI takeoff runs ~$175–299/user/month, meaningless for an Indian boutique studio and a feature race you can't win bootstrapped. Instead: receive a DXF, run your pipeline, review it yourself, deliver a signed XLSX + PDF, ₹X per drawing set, 24h turnaround. Revenue from project one, no UI needed, and every job feeds the three compounding assets. *This decision changes what gets built — settle it before writing module contracts.*

**The four mechanics worth stealing from the market:**
- **Rate library is the moat, not the parser.** Handoff's asset is 100k+ estimates and supplier-backed pricing localised by ZIP. Your parser is commoditised in 18 months; a current localised Bangalore interiors rate library is not, and nobody has one. Schema accrues `historical_rates` from day one even if v1 ships without pricing.
- **Narrow wedge.** Countfire owns electrical symbol counting and nothing else.
- **Sell outcome, not seat.** See above.
- **Pitch revenue, not cost.** Not "your estimator saves four hours" — "you quote in a day and win work you're losing on response time."

**Drawing Standard Profile** — learn a studio's layer/block conventions once, human-approve once, reuse forever. Accuracy fix, retention hook and switching cost in one object. Competitors re-infer per file.

**Borrowed from Sterling & Wilson:** engineering thumb rules → sanity checks · historical pricing → rate library · bid justification → per-line "why this number" explanation strings.

**Still undecided:** project name · price per drawing set · service vs SaaS (recommendation above).

---

## 10. Artifacts

**Planning**
- `HANDOFF.md` — this file
- `drawing-to-boq-build-plan.md` — v2 narrative plan, competitor mechanics
- `drawing-to-boq-15-phase-plan.md` — the 15 phases (problem → validation)
- `drawing-to-boq-master-build-plan.md` — Phase 0 gate, build sequence, test matrix, launch criteria

**Results**
- `phase-0-poc-results.md` — real DWG/DXF findings (the converter corruption)
- `phase-0-results-v2.md` — synthetic corpus results

**Prototype**
- `drawing-to-boq-prototype.html` — self-contained, no external scripts, no localStorage, works offline. BMW M design system.

**Test data**
- `residual_test.dxf` + `residual_test.ground_truth.json` — clean layers, three meaningless block names (`Block_17` sofa, `Block_18` WC, `Block_19` round table + 4 chairs) with legible plan geometry
- `sample_vector_plan.pdf` — known geometry for Tier B

**Code** (`poc/`)
- `boq-engine.js` — DXF parse, geometry, classify, measure, sanity, BOQ
- `ingest.js` — format router, DWG refusal, PDF vector extraction
- `vision.js` — residuals, crop render, model discovery, label contract, raster detect
- `engine.py`, `generate.py`, `run_tests.py` — Python reference + synthetic corpus generator
- `verify.js`, `test_ingest.js`, `test_raster.js`, `final_check.js` — test suites
- `data/synthetic/` — 11 cases with ground truth

---

## 11. Build order when you resume

**Do not start the real build until E1 has a number.** Everything before the freeze costs ₹0; everything after is expensive to undo.

Sequence: ingest + scale gate → parser → geometry primitives → rule classifier → fusion + confidence → rules engine → sanity + absence checks → review queue → BOQ + export → provenance viewer. **Modules 3 (geometry) and 7 (rules) written test-first** — that's where a silent error becomes a wrong invoice.

Vision fallback last, interface built, call stubbed — the A3 adversarial case proved the system is useful at zero vision spend.

**One-shot vs controlled:** one-shot is fine where a mistake is visible (export formatting, UI shell, internal scripts). Controlled and test-gated where it's silent (measurement, rules, fusion, review logic). Roughly 30% of the codebase can be loosely generated; 70% cannot.

**Launch gate:** per-category accuracy against the E0 band (not aggregate — 98% overall can hide furniture at 70%) · **zero unflagged errors above ₹X** · byte-identical reproducibility from the same inputs · two real projects delivered · corruption tests all fire · signed in writing.

---

## 12. Immediate next actions

1. **Get 10–15 real DXFs** from 2–3 Bangalore studios — saved from AutoCAD, not converted, not downloaded. Cold outreach, offer free takeoffs. ₹0 and it unblocks everything.
2. **Get one studio's past BOQ** for a drawing they also give you → unblocks E0.
3. **Run E1** — the harness already exists, so it's a day's work once real files land.
4. **Settle service vs SaaS** — it changes the build.
5. Test the live Gemini call with `residual_test.dxf` and a key.
