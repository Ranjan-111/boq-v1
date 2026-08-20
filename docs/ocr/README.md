# OCR corpus and benchmark artifacts

Issue #9 benchmark artifacts are pinned to 2026-08-20. The corpus is synthetic and deterministic; it is a gate for engine behavior, not evidence of accuracy on real studio drawings.

## Files

- `test/fixtures/ocr-corpus/*.png` — title/storey, decimal/unit, 0°/90°/180°/270° text, and 4000×3000 large-sheet fixtures.
- `test/fixtures/ocr-corpus/manifest.json` — dimensions, byte counts, SHA-256 hashes, roles and rotation metadata.
- `test/fixtures/ocr-corpus/ground_truth.json` — expected text, tokens and page-space polygons. Rotated polygons are transformed from the fixture coordinate system.
- `scripts/ocr/generate-corpus.mjs` — deterministic generator; uses Playwright only to rasterize fixed SVG specs.
- `scripts/ocr/benchmark.mjs` — verifies corpus hashes, runs real Tesseract.js and browser PaddleOCR.js, records package/model hashes, latency, numeric/line accuracy and memory proxies.
- `docs/ocr/benchmark-results-2026-08-20.json` — measured run.
- `docs/ocr/ocr-engine-policy-v1.json` / `.md` — immutable v1 selection and safety policy.

## Reproduce

The production browser runtime pins Tesseract.js and its English model in `package.json`. The comparison benchmark also used temporary pinned PaddleOCR.js and Vite packages:

```text
@paddleocr/paddleocr-js@0.4.2  # benchmark only
tesseract.js@7.0.0             # same version as production
vite@6.4.1                      # temporary browser harness only
```

With those packages installed under `/private/tmp/boq-ocr-runtime`:

```bash
node scripts/ocr/generate-corpus.mjs
OCR_RUNTIME_DIR=/private/tmp/boq-ocr-runtime node scripts/ocr/benchmark.mjs
```

The benchmark writes only `docs/ocr/benchmark-results-2026-08-20.json` after both engines complete and every pinned package/tarball/model hash matches; missing evidence, mismatches or a blocked engine exit nonzero without publishing a result. Tesseract worker data/cache is redirected to `/private/tmp`. Browser execution may require the local Playwright/Chromium permission profile.

## Measured run

| Engine | Cold / warm prepare | Title, numeric, 0° and large-sheet line exactness | 90° / 180° / 270° token recall | Large-sheet full latency |
| --- | ---: | --- | --- | ---: |
| Tesseract.js 7.0.0 | 1157 / 79 ms | 6/6, 8/8, 3/3, 50/50 | 1/5, 0/5, 0/5 | 1106 ms |
| PaddleOCR.js 0.4.2 + PP-OCRv5 mobile WASM | 17422 ms / not exposed | 6/6, 8/8, 3/3, 50/50 | 2/5, 0/5, 0/5 | 7088 ms |

Tesseract large-sheet 12-tile latency was 1726 ms with 246/247 tokens. Tesseract’s process-RSS proxy peaked at 478,887,936 bytes; Paddle’s browser `performance.memory` proxy reported 509,557,079 used / 515,272,351 total bytes. These are not directly comparable measurements and are retained as labeled proxies.

## Interpretation and limits

The v1 policy selects Tesseract.js as the conditional primary because it is materially smaller/faster on this corpus and returns positioned TSV observations; PaddleOCR.js remains the measured alternative and has stronger raw 90° token recall. Neither engine passes an uncorrected rotation gate because both fail 90°/180°/270° line matching. No engine is approved to create geometry, scale, quantities or rates.

Cache/IndexedDB eviction, offline reload, unsupported-worker/WASM UI states and native-PDF overlap precedence are not measurements from this engine-comparison benchmark; required browser and application tests cover them separately. Real studio drawings are not represented and remain a promotion gate.
