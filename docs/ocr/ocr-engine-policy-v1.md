# OCR engine policy v1

Status: `conditional-selection`, frozen 2026-08-20.

Primary: `tesseract.js@7.0.0` with `eng` traineddata. Alternative: `@paddleocr/paddleocr-js@0.4.2`, PP-OCRv5 mobile, WASM backend. Exact package/model hashes, corpus hashes, measurements and selection rationale are in the adjacent JSON policy and full run in `benchmark-results-2026-08-20.json`.

The deployed `eng-4.0.0_best_int` gzip asset is 2,952,873 bytes with SHA-256 `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`; the server verifies that hash before serving the pinned model.

## Selection

Tesseract is the conditional v1 primary: it matched all title/storey, decimal/unit, upright-rotation and large-sheet lines in this corpus, while preparing and processing substantially faster and using fewer deployed bytes. Paddle remains the alternative because it returns native polygons and had better raw 90° token recall.

This is not a launch claim. Both engines fail the uncorrected 90°/180°/270° rotation fixtures, so the selected runtime exposes an explicit quarter-turn correction and maps resulting polygons back to canonical page coordinates. Real studio drawings and a benchmark of that orientation-normalized path remain open promotion gates. Required browser tests cover exact warm-cache reuse, byte-integrity eviction, offline behavior, unsupported inference, and native-PDF overlap precedence.

## Non-negotiable boundary

OCR produces positioned text observations only. It cannot create source geometry, scale, measurements, quantities, rates or export approval. Suspicious dimensions, units and decimals are review evidence. Where native PDF text overlaps OCR, native text wins and OCR is retained as suppressed/conflict evidence.

The required observation envelope is page, polygon, text, confidence, engine/model versions and processing-run identity. Model assets are cached by exact engine/model/language/hash; a missing or evicted cache produces a visible non-OCR workflow rather than a failed drawing run.

See `docs/ocr/README.md` for commands and limitations; update this policy by creating `ocr-engine-policy-v2`, never by mutating v1.
