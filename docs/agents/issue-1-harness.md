# Issue #1 contract harness

Run the prototype-contract acceptance harness with:

```sh
npm run test:contract
```

The suite observes only public seams: the HTTP upload/run/reprocess/export and
source-object endpoints, plus the exported `vision.js` coercion, residual and
raster-box functions. It covers exact clean/scaled quantities, unit gates,
safe degradation, required measurement statuses, export blocking, provenance
round-tripping, and model-response safety.
