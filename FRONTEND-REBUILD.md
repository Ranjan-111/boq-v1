# Frontend rebuild — plan and tickets

## Why

The operator interface was generated externally and never had a state model.
Three separately-reported bugs turned out to be one defect wearing three hats:
state is written in one place and read from another.

| Symptom reported | Underlying cause |
|---|---|
| "Approve button does nothing" | `dataset.boqVersionId` read by 6 sites, written by 0 |
| "No reason shown when approval refused" | `body.boqVersion.status` read without checking `response.ok` |
| "Exception queue says nothing to show, but has 4" | empty-check counted a hidden table, not the visible cards |
| "Everything dumps onto one page" | `showView()` only calls `scrollIntoView`; `.view.active` is an empty CSS rule |

None of these were visible to the test suite, because no test covers frontend
logic. All 357 tests either exercise the backend directly or drive the whole
browser end-to-end -- there is no layer in between where a state transition
can be asserted.

## Scope

Rewritten:
  - `public/app.js` (1686 lines, one file) -> `public/js/*.js` modules
  - the view router (currently decorative)
  - every data-driven view: project, upload, review, exceptions, workspace,
    rollup, approve/export

Kept:
  - `public/style.css` -- design tokens are sound; add real view show/hide
  - `public/index.html` markup -- structurally reasonable; adjust, don't replace
  - the raster/OCR canvas logic -- intricate, working, browser-tested.
    Ported behind the new state interface with behaviour unchanged.
  - the entire backend and its HTTP contract -- unchanged, no quantity moves

## Architecture

    server (sole source of truth)
      |
      v
    api.js        one fetch wrapper. Checks response.ok. Throws ApiError
                  carrying {status, code, message}. Nothing else calls fetch.
      |
      v
    store.js      one plain state object + pure reducers + subscribe().
                  No DOM reads. Testable in node with no browser.
      |
      v
    views/*.js    render(state) -> DOM. Pure of network. No local state.
      |
      v
    router.js     exactly one view visible; nav reflects reachability

Rules this enforces, which the current code cannot:
  - no component stores state in a `dataset` attribute or in DOM text
  - no `fetch` outside `api.js`, so no unchecked `response.ok` can exist
  - no silent `return` on failure; every error path reaches the error surface
  - a view renders from `state` only, so two paths cannot disagree

## Safety property

No quantity may change. The backend is untouched; quantities are snapshotted
before and after and diffed. Any movement is a bug in the rebuild, not a
finding.

## Tickets

### Core (blocking, done together -- they are one change)

- **F1 Real router.** One view visible at a time. Nav shows current location,
  and marks views unreachable-yet with the reason they are locked.
- **F2 Single store.** One state object, pure reducers, subscribe/render.
  Removes `dataset` as storage entirely.
- **F3 API client.** One wrapper; `response.ok` checked once, centrally;
  `ApiError` carries the server's own message and code.
- **F4 Error surface.** Every failure is displayed. A refusal shows its reason
  -- the approval gate exists to say no, so saying no must be legible.
- **F5 Progressive gating.** Steps unlock as prerequisites are met. A locked
  step states what is missing. Replaces T6's empty-section dimming with
  something that reads as designed rather than broken.

### Correctness

- **F6 Port raster/OCR canvas** behind the new state interface, behaviour
  unchanged, existing browser tests still passing.
- **F7 Frontend unit tests.** Reducers tested in node -- the layer that
  currently cannot be tested at all. Covers the exact transitions that broke:
  version id propagation, approval refusal, queue counts, run completion.
- **F8 Rewrite the 14 browser tests** against the new contract. Updated to the
  new behaviour, never weakened to match it.

### Prevents the last three days from recurring

- **F9 Build-freshness guard.** The server stamps a build id; the page checks
  it and says plainly when the running server is older than the code. A stale
  process must never again be mistaken for a broken feature.

### Carried over from TICKETS.md (frontend UI work already agreed)

- **T8 Draw the OCR crop on the image** instead of typing x/y/width/height.
- **T9 OCR-first raster flow** -- read the scale bar before asking the operator.

## Order

F3 -> F2 -> F1 -> F4/F5 -> F6 -> F7/F8 -> F9 -> T8 -> T9

## Status

F1-F9 are done. 382/382 tests pass (was 357: +25, all frontend).
T8 and T9 remain -- they are the OCR crop rework, unchanged in scope.

### What the rebuild found that the old code was hiding

Three further defects surfaced only once there was a single source of truth to
compare against. None were visible before, because each lived on a path the
old code never exercised:

1. A reopened project rendered nothing. The rollup carries the measured lines
   but no confidence grading, and the renderer read `line.confidence.level`
   unguarded. It threw inside a store subscriber, the exception was swallowed
   by an `await ... catch {}` in startup, and the operator got a populated
   header above a blank page with nothing in the console.
2. `Reassign current source` is `hidden` in the markup and the old code
   un-hid it. The rewrite only managed `disabled`, so it never appeared.
   It is now visible-but-disabled with the missing prerequisite named.
3. Hiding the sidebar below 768px was harmless when every section rendered on
   one scrolling page. With real views it strands the operator inside whatever
   view they are on, so the nav becomes a horizontal strip instead.

Two improvements came out of the same work:

- Reopening a project now restores the run behind the rollup, so the graded
  BOQ, the classifications and reprocess all come back -- reopening shows what
  measuring showed.
- The source document you just measured is preselected for reassignment.

### Safety property

Verified by diffing every rollup quantity for `residual_test.dxf` before the
rebuild and after it. Identical.
