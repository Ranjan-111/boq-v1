/* Vision service (#10).

   Optional by construction. With no key configured the service reports itself
   unavailable and every residual routes to a human -- degraded, not broken.
   Nothing downstream may treat a model answer as required. */

const { createVisionProvider, VisionAuthError, VisionUnavailableError } = require('./provider');
const { renderCrop } = require('./crop');
const { coerceLabel, ONTOLOGY, CATEGORY_OF, LABEL_PROMPT } = require('./contract');
const { residualsFor, splitCounts } = require('./residuals');

/** The key is read from server config only. It is never returned to a caller. */
function readApiKey(env = process.env) {
  const key = env.BOQ_VISION_API_KEY || env.VISION_API_KEY || '';
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

function createVisionService({ apiKey = readApiKey(), fetch, base, provider } = {}) {
  const resolved = provider || (apiKey ? createVisionProvider({ apiKey, fetch, base }) : null);
  const available = Boolean(resolved);

  async function proposeLabel(residual) {
    if (!available) {
      return { status: 'unavailable', reason: 'No vision model is configured; this residual needs a human.', label: null, category: null, model: null };
    }
    const crop = renderCrop(residual.geometry);
    try {
      const result = await resolved.classify({ imageBase64: crop.base64, mediaType: crop.mediaType, prompt: LABEL_PROMPT });
      /* Belt and braces: the provider already ran the contract, run it again on
         whatever it returned so nothing numeric can enter from this direction. */
      const contracted = coerceLabel(result.label);
      return {
        status: contracted.label === 'UNKNOWN' ? 'unresolved' : 'proposed',
        label: contracted.label, category: contracted.category,
        model: result.model, prompt: LABEL_PROMPT, rawReply: result.rawReply ?? null
      };
    } catch (error) {
      if (error instanceof VisionAuthError) return { status: 'error', reason: 'The configured vision key was rejected.', label: null, category: null, model: null };
      if (error instanceof VisionUnavailableError) return { status: 'unavailable', reason: error.message, label: null, category: null, model: null };
      return { status: 'error', reason: error.message, label: null, category: null, model: null };
    }
  }

  /* Raster boundary proposals. The image itself is supplied by the caller,
     which holds the page bytes; this module never fetches source content. */
  async function proposeRegions({ imageBase64, mediaType = 'image/png', imageWidth, imageHeight }) {
    if (!available) return { status: 'unavailable', reason: 'No vision model is configured; trace the regions by hand.', boxes: [], model: null };
    if (!imageBase64) return { status: 'unavailable', reason: 'No page image was available to propose from.', boxes: [], model: null };
    try {
      const result = await resolved.detectRegions({ imageBase64, mediaType, imageWidth, imageHeight });
      return { status: 'proposed', boxes: result.boxes, dropped: result.dropped, model: result.model };
    } catch (error) {
      if (error instanceof VisionAuthError) return { status: 'error', reason: 'The configured vision key was rejected.', boxes: [], model: null };
      return { status: 'unavailable', reason: error.message, boxes: [], model: null };
    }
  }

  return { available, proposeLabel, proposeRegions, ONTOLOGY, CATEGORY_OF };
}

module.exports = { createVisionService, readApiKey, residualsFor, splitCounts, renderCrop, coerceLabel, ONTOLOGY, CATEGORY_OF, LABEL_PROMPT };
