# Drawing-to-BOQ — Pre-Build Plan (v2)

**Status:** planning only, no execution
**Owner:** Harsh Yadav, Outlrs Labs
**Updated:** 13 Aug 2026 — v2 folds in competitor mechanics + pivots from the GPT session

---

## 1. The one architectural decision everything else hangs off

**The AI never produces a number.**

| Engine | Owns | Tech | Failure mode |
|---|---|---|---|
| **Geometry engine** | Every area, length, count, coordinate | `ezdxf` + `shapely`, deterministic | Crashes loudly. Never guesses. |
| **Semantic engine** | What a thing *is* — "this block is a 2-seater sofa" | Rules first, vision as fallback | Guesses wrong. Caught in review. |

A wrong classification is one dropdown to fix and everything recomputes. A wrong measurement is money, and nobody notices until the client is billed.

This also gives you what vision-first tools can't do cleanly: **click a BOQ line → the exact DXF entity handles that produced it highlight in the viewer.** Full provenance. That's the trust mechanism.

### Input tiers — make them visible to the user
- **Tier A — DWG/DXF.** Deterministic geometry. Uncertainty only in classification. *This is v1.*
- **Tier B — vector PDF.** Geometry near-exact, layer/block semantics lost.
- **Tier C — scanned/raster.** Every number is an estimate. Flag throughout; block export without full review.

Competitors average their accuracy across all three. Showing the tier is honest and it's a differentiator.

### How the vision call is actually made — crop-and-ask
**Pivot from the GPT session, adopted.** Don't render the whole drawing. After rule-based classification, you're left with a residual set of unidentified entities. For each, render a tight crop and ask a **closed-set** question:

> "Which of these is this object? SOFA | BED | TABLE | CHAIR | CABINET | WC | BASIN | DOOR | WINDOW | UNKNOWN"

Three consequences: vision cost scales with drawing messiness rather than drawing size; the model can't invent categories outside your ontology; and `UNKNOWN` is a valid, useful answer that routes straight to a human.

**Two hard rules on this call:**

1. **The model's output schema has no numeric field.** It returns a category label and nothing else. You may send it dimensions as *context* for disambiguation ("200mm thick, layer A-WALL") — but the fusion layer structurally cannot accept a number back. This closes the back door where a hallucinated dimension re-enters the pipeline. Your GPT doc was right that context helps; it was one step short of enforcing that the return trip is label-only.
2. **Confidence comes from signal agreement, not from the model.** A self-reported `0.94` is not a calibrated probability — your GPT session flagged this correctly. Compute confidence from how many of your four signals (layer / hatch / block name / geometry) agreed. Four agreeing = high. One signal plus a vision guess = low. This number is auditable; the model's isn't.

---

## 2. What to change from the 360 Labs approach

| What their page shows | What you do instead | Why |
|---|---|---|
| Gemini Vision as the reader | Vision demoted to crop-and-ask on residuals | Numbers come from geometry, not pixels |
| "Hatch Classification" as *the* feature | Hatch is one of **four** signals, ensemble-voted | Single-signal classification breaks on the next studio |
| Vendor Matching (implied auto) | **Match-and-memorise** — human confirms first occurrence per studio, stored forever | Review effort becomes an asset, not a recurring tax |
| "Under two minutes" as the pitch | "Two minutes to a *reviewable* draft, signed by an architect" | Speed is commoditised. Auditability isn't. |
| Demo on one 2-bedroom flat | **Drawing Standard Profile** per studio, learned once | Generalising past the demo file is the real problem |

### Stolen from their Sterling & Wilson build
That system reportedly applies **engineering thumb rules**, **historical pricing**, **bid-justification analysis**, and keeps **human sign-off**. Three of those four transplant directly into interiors, and they're cheap:

- **Thumb rules → sanity checks.** Before anything reaches a human: *plaster area should be roughly 3–4× floor area. This drawing says 8×.* That single check catches the catastrophic class of error — wrong unit, missing wall layer, double-counted hatch — that a reviewer scrolling 400 line items will never spot. Highest value-per-line-of-code in the whole system.
- **Historical pricing → your own rate library.** See §3.
- **Bid justification → per-line "why this number".** Each line explains itself: *"48.2 m² = sum of 6 hatch regions on A-WALL-INT, minus 3 door openings per rule IS1200-P12-a."* This is what turns a spreadsheet into a defensible document.

---

## 3. What's actually profitable in what the others built

Features are easy to copy. These are the *business mechanics* worth taking.

**a) The rate library is the moat — not the parser.**
Handoff's pitch isn't its AI, it's its cost data: 100,000+ completed estimates, supplier-backed pricing from real distributors, priced by ZIP code rather than national averages — and users report estimates landing within about $100 of their manual numbers on typical residential jobs. The parser is a commodity within 18 months. **A current, localised Bangalore interiors rate library is not.** Nobody has one. Every project you process feeds it. Build the system so this accumulates from day one, even if v1 ships without pricing at all.

**b) Go narrow enough to be the best at one thing.**
Countfire owns electrical symbol counting and nothing else — quote-based pricing that scales with users and drawing volume, no published rate card, and reviewers say the cost is high but justified by time saved. They didn't win by covering 60 trades. Your equivalent wedge: **residential interior fit-out, architectural only.** Be undeniably the best at that before touching MEP.

**c) Sell the outcome, not the seat. This is your unlock.**
Per-seat AI takeoff runs roughly $175–$299 per user per month — irrelevant to an Indian boutique studio, and it forces you into a feature race you cannot win from a hostel room. The other model: hybrid services, where AI does the first pass and human experts QA before delivery, priced per trade per year rather than per seat, targeting within ±1% of the client's in-house numbers.

**You are in India and the human reviewer can be you.** So don't sell software an architect has to learn. Sell **a finished, signed BOQ, per project.** ₹X per drawing set, 24-hour turnaround.

Why this is the right call for your constraints:
- Revenue from project one. No SaaS ramp, no free tier, no ₹0-to-₹0 for eight months.
- You need zero UI polish to start — the deliverable is an XLSX and a PDF.
- Every project delivered feeds the rate library **and** the block mappings **and** your ground-truth corpus. The three things that compound.
- The tool starts as your internal margin lever. It becomes a product only when the same studios ask for direct access — which is the correct time to build a UI, because they're already paying.

The service is the business. The software is how you keep the margin.

**d) Reframe who the buyer is.**
Handoff's observation: in residential work clients read speed as competence, and the first contractor back with a polished proposal has a real advantage. So the pitch to a studio principal isn't "your estimator saves four hours." It's **"you quote in a day, not a week, and you win work you're currently losing on response time."** That's a revenue argument, not a cost argument, and it's what gets you priced on value.

**e) Revision diff — underserved, and nearly free for you.**
Countfire markets handling revised drawings without starting over, and every buyer's guide names revision tracking as a top manual pain. Once you store geometry with stable entity identity, diffing rev A → rev B costs you almost nothing, and only changed items re-enter review. For a service business this is pure margin: rev B takes ten minutes instead of a full re-run.

---

## 4. The four hard problems

### Problem 1 — Unit and scale ambiguity
360 Labs' own demo screenshot is flagged **"unitless."** That's the industry's dirty secret. Read `$INSUNITS`; if unset or implausible, infer from known objects (doors at 750/800/900/1000 mm, WC pans, beds), then ask **one** confirmation: *"We read this as millimetres — a typical door here is 900mm. Correct?"* Store on the drawing record, never re-ask. This gate blocks the pipeline.

### Problem 2 — Every studio draws differently
Layer names vary (`A-WALL` / `WALLS` / `0-Wall-Int` / `PARTITION`). Block names are frequently garbage (`Block_17`, `FURN_07`). Furniture is sometimes loose lines, not blocks.

**The Drawing Standard Profile.** On first upload, propose a mapping:
```
layer   "A-WALL-*"   → category: wall
hatch   "ANSI31"     → material: brick_masonry_230
block   "SOFA-2S-*"  → item: furniture.seating.sofa_2seat
block   "Block_17"   → (unmapped — needs human)
```
Human approves it **once**, in its own screen. Reused on every later drawing from that studio, improving each time an unmapped entity is resolved. This is your accuracy fix, retention hook and switching cost in one object. Competitors re-infer per file. Countfire's "estimates that learn how you work" is the same insight — validate that it works and it's worth the build.

### Problem 3 — Measurement rules are not measurement
Deducting door openings from plaster area is a **rule**, not a measurement.
```
Geometry (facts) → Rules (versioned) → Items → Rates → Priced BOQ
```
Change a rule, re-run without re-parsing. Diff revisions properly. Later swap in an IS 1200 / CPWD DSR ruleset over the same geometry engine to reach government tender work without a rewrite. In India this isn't optional: IS 1200 is the referenced method of measurement in Indian contracts, and CPWD tender BOQs require item descriptions matching DSR nomenclature exactly.

> Implement the rules; don't redistribute IS 1200 text (BIS copyright). DSR reuse terms: `UNVERIFIED`.

### Problem 4 — Review that doesn't destroy the time saving
Every line carries **confidence** and **money at risk** (qty × rate).

| Confidence | ₹ at risk | Action |
|---|---|---|
| High | Low | Auto-accept, collapsed |
| High | High | One-click spot check |
| Low | Any | Mandatory, blocks export |
| Any | Top 10 by ₹ | Always surfaced |

Sort the queue by **rupee impact**, not drawing order. Then gate export on a named approval, stamped into the file: *"Reviewed and approved by [Name], [Date], ruleset v1.3, parser v0.9."* That line is what makes it usable in a contract.

---

## 5. Database structure

Postgres + **PostGIS** + **pgvector** + **pg_trgm**. All free, runs on your existing OCI instance.

Principles: raw entities immutable; everything derived is recomputable; classifications and human overrides append-only; rates time-versioned; provenance arrays everywhere.

```
-- Tenancy
organisations / users
studios
drawing_standard_profiles (studio_id, version, mappings JSONB, approved_by, approved_at)

-- Files
projects           (studio_id, name, default_ruleset_id)
drawings           (project_id, name, discipline)
drawing_revisions  (drawing_id, rev_label, file_hash, storage_uri, source_format,
                    tier CHECK IN ('A','B','C'), resolved_unit, unit_confidence,
                    scale_confirmed_by, uploaded_at)

-- Parsing (the fact table — immutable)
parse_runs  (revision_id, parser_version, profile_version, status, error)
entities    (parse_run_id, dxf_handle, dxf_type, layer, block_name, space,
             geom GEOMETRY, attribs JSONB, area_raw, length_raw)
             -- GIST(geom), INDEX(parse_run_id, layer)

-- Semantics (append-only)
classifications (entity_id, category, subcategory, material_code, confidence,
                 source CHECK IN ('rule','vision','human','profile'),
                 signals JSONB,        -- which of the 4 agreed, and how
                 supersedes_id, created_by, created_at)

-- Rules & measurement
rulesets     (name, version, standard CHECK IN ('studio','IS1200','custom'))
rules        (ruleset_id, code, applies_to_category, expression, unit)
sanity_rules (code, expression, severity)   -- the thumb-rule checks from §2
measurements (parse_run_id, rule_id, category, value, unit,
              entity_handles TEXT[],        -- provenance
              explanation TEXT)             -- the "why this number" string

-- BOQ
item_catalog (studio_id, code, description, unit)
boq_versions (project_id, ruleset_id, parse_run_id, status, approved_by, approved_at)
boq_lines    (boq_version_id, item_code, description, quantity, unit, rate, amount,
              rate_source_id, rate_as_of DATE, confidence, money_at_risk,
              status CHECK IN ('auto','pending_review','approved','overridden'),
              measurement_ids INT[])

-- Vendors + the rate library (§3a — this is the asset)
vendors          (studio_id, name, contact)
vendor_products  (vendor_id, sku, name, description, embedding VECTOR(768), unit)
vendor_rates     (vendor_product_id, rate, valid_from, valid_to, city, source)
historical_rates (item_code, city, rate, project_id, observed_on)  -- accrues per project
match_candidates (boq_line_id, vendor_product_id, score, method, chosen BOOL)
studio_item_map  (studio_id, block_name, vendor_product_id, confirmed_by)
                 -- THE memory table. First confirmation is permanent.

-- Trust
review_events (boq_line_id, actor_id, action, before JSONB, after JSONB, at)
exports       (boq_version_id, format, generated_by, at, signature_text)
```

**Vendor matching** — not free-form LLM:
```
normalise → pg_trgm (names/SKU) UNION pgvector (semantic) → rerank top 20 → threshold
→ if studio_item_map already has this block, use it and skip everything
→ else human confirms once → write to studio_item_map → never asked again
```

---

## 6. Scope for v1

**In:** single-storey residential / interior fit-out · architectural only · **DXF only** · outputs: wall areas by material, floor areas by finish, door & window schedule, furniture/fixture counts, vendor-matched priced BOQ, XLSX + PDF with signature block.

**Out — write these down so the team stops relitigating them:** MEP · structural rebar · scanned/raster PDF · 3D / BIM / IFC / Revit · multi-storey aggregation · government DSR tenders.

### On DWG ingestion — pivot away from the GPT recommendation
Your GPT session suggested Autodesk RealDWG or Autodesk Platform Services for DWG. Both are commercial enterprise licensing — that's the right answer for a funded team and the wrong one for you. The open alternatives are no better: GNU LibreDWG is self-described as beta and isn't packaged in current Ubuntu repos, so you build from source, and the ODA File Converter's licence terms for automated server use are `UNVERIFIED`.

**Decision: DXF only.** "File → Save As → DXF" is one action in AutoCAD. You delete an entire class of infrastructure, licensing and cost risk on day one, and an architect willing to try you will happily press Save As. If you're running this as a service (§3c) you're receiving the files yourself anyway — you can convert on your own Mac at zero cost and zero licensing exposure. Revisit only when a *paying* customer's workflow genuinely blocks on it.

---

## 7. How to run the next three weeks

Why nobody's nailed this: **they built the product before they had the corpus.** A demo tuned on one flat generalises to nothing. Invert it.

**Week 1 — Corpus, no code.** 10–15 real DWG/DXF files from 2–3 Bangalore studios. Cold outreach, offer free takeoffs in exchange. Highest-value week, costs ₹0.

**Week 2 — Ground truth.** Hand-take-off two of them in a spreadsheet, line by line. This is your accuracy benchmark. Every competitor's accuracy number is self-reported precisely because nobody does this.

**Week 3 — Ontology + parser spike.** Write the category ontology first. Then a throwaway `ezdxf` script over all 15 files answering one question: **what % of entities are auto-classifiable from layer + hatch + block name alone?**

That number decides the product shape:
- **>70%** → vision is a small fallback, review is light. Build as planned.
- **40–70%** → the Drawing Standard Profile *is* the product, not a setup step.
- **<40%** → this segment's CAD standards are too chaotic. Change segment before building anything.

Only then write the build spec.

---

## 8. Open risks

| Risk | Resolve by |
|---|---|
| DWG licensing `UNVERIFIED` | Sidestepped by DXF-only + service model |
| Liability — a BOQ prices a real contract | Named sign-off, immutable audit log, versions stamped on export |
| IS 1200 / DSR content licensing `UNVERIFIED` | Implement rules, don't redistribute text; verify before shipping rates |
| Chaotic studio CAD standards | The Week-3 percentage answers this pre-commitment |
| Furniture as loose lines, not blocks | Geometry-cluster fallback + explicit "unclassifiable region" flag. Never silently drop. |
| Unbound XRefs | Reject at upload with a clear message; don't parse a partial drawing |
| Service model doesn't scale past you | Correct — it isn't meant to. It funds the product and builds the rate library. |

---

## 9. Open decisions

1. **Segment** — boutique interior studios vs mid-size contractors. Recommendation: **interiors**, the only one v1's scope can serve.
2. **Model** — SaaS from day one vs done-for-you BOQ service first. Recommendation: **service first** (§3c). It's the only version that pays you before month eight.
3. **Positioning** — "faster takeoffs" or "defensible takeoffs"? Recommendation: **defensible**. Every tool claims speed; none can prove accuracy.
4. **Name.** Still unchosen.
