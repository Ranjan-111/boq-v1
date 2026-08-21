/* Server-side vision provider (#10).

   The key lives in server config and is sent as an auth header. It is never
   placed in a URL: query strings end up in proxy logs, browser history and
   error reports, and a leaked key is a billing incident.

   Model names are discovered from the provider's list endpoint rather than
   hardcoded -- a previously hardcoded name broke when the provider retired it.
   The ordered preference chain is only a fallback for when discovery returns
   nothing usable. */

const { coerceLabel, LABEL_PROMPT, RASTER_PROMPT, coerceBoxes } = require('./contract');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/* Ordered fallback, used only when discovery yields nothing. Names here are
   allowed to go stale; discovery is the primary path precisely for that reason. */
const PREFERENCE_CHAIN = Object.freeze(['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']);

class VisionAuthError extends Error {}
class VisionUnavailableError extends Error {}

/* A retired or mistyped model is worth retrying with the next candidate. A
   rejected key is not: walking the chain would turn one clear auth failure into
   several confusing ones and hide the real cause. */
function classifyProviderError(status, message = '') {
  const text = String(message).toLowerCase();
  if (status === 401 || status === 403 || /api key|unauthorized|permission|credential/.test(text)) return { kind: 'auth', status, message };
  if (status === 404 || /not found|not supported|unsupported|does not exist/.test(text)) return { kind: 'model_not_found', status, message };
  return { kind: 'unavailable', status, message };
}

function createVisionProvider({ apiKey, fetch: fetchImpl = globalThis.fetch, base = DEFAULT_BASE, preferenceChain = PREFERENCE_CHAIN } = {}) {
  if (!apiKey) throw new VisionAuthError('A vision provider needs an API key.');
  const headers = () => ({ 'x-goog-api-key': apiKey, 'content-type': 'application/json' });
  let discovered = null;

  async function listModels() {
    if (discovered) return discovered;
    let payload = null;
    try {
      const response = await fetchImpl(`${base}/models`, { method: 'GET', headers: headers() });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const classified = classifyProviderError(response.status, body?.error?.message);
        if (classified.kind === 'auth') throw new VisionAuthError(`Vision provider rejected the configured key: ${classified.message}`);
        payload = null;
      } else {
        payload = await response.json();
      }
    } catch (error) {
      if (error instanceof VisionAuthError) throw error;
      payload = null;
    }
    const usable = (payload?.models || [])
      .filter((model) => (model.supportedGenerationMethods || []).includes('generateContent'))
      .map((model) => String(model.name).replace(/^models\//, ''));
    /* Preferred names first when the provider offers them, then whatever else it
       advertises, then the static chain if discovery gave us nothing. */
    const ordered = [
      ...preferenceChain.filter((name) => usable.includes(name)),
      ...usable.filter((name) => !preferenceChain.includes(name))
    ];
    discovered = ordered.length ? ordered : [...preferenceChain];
    return discovered;
  }

  async function classify({ imageBase64, mediaType = 'image/png', prompt = LABEL_PROMPT }) {
    const candidates = await listModels();
    let lastMessage = 'no candidate model succeeded';
    for (const model of candidates) {
      const response = await fetchImpl(`${base}/models/${model}:generateContent`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mediaType, data: imageBase64 } }] }]
        })
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text).join(' ') ?? '';
        /* Everything the provider said passes through the contract. Only a label
           and its category can come out the other side. */
        return { ...coerceLabel(text), model, rawReply: String(text).slice(0, 500) };
      }
      const body = await response.json().catch(() => ({}));
      const classified = classifyProviderError(response.status, body?.error?.message);
      if (classified.kind === 'auth') throw new VisionAuthError(`Vision provider rejected the configured key: ${classified.message}`);
      if (classified.kind === 'unavailable') throw new VisionUnavailableError(`Vision provider unavailable (${classified.status}): ${classified.message}`);
      lastMessage = classified.message || lastMessage;
    }
    throw new VisionUnavailableError(`No usable vision model: ${lastMessage}`);
  }

  /* Boundaries only. The reply passes through coerceBoxes, whose box type has
     five fields and no room for a scale. */
  async function detectRegions({ imageBase64, mediaType = 'image/png', imageWidth, imageHeight, prompt = RASTER_PROMPT }) {
    const candidates = await listModels();
    let lastMessage = 'no candidate model succeeded';
    for (const model of candidates) {
      const response = await fetchImpl(`${base}/models/${model}:generateContent`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mediaType, data: imageBase64 } }] }] })
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text).join(' ') ?? '';
        const { boxes, dropped } = coerceBoxes(text, { imageWidth, imageHeight });
        return { boxes, dropped, model };
      }
      const body = await response.json().catch(() => ({}));
      const classified = classifyProviderError(response.status, body?.error?.message);
      if (classified.kind === 'auth') throw new VisionAuthError(`Vision provider rejected the configured key: ${classified.message}`);
      if (classified.kind === 'unavailable') throw new VisionUnavailableError(`Vision provider unavailable (${classified.status}): ${classified.message}`);
      lastMessage = classified.message || lastMessage;
    }
    throw new VisionUnavailableError(`No usable vision model: ${lastMessage}`);
  }

  return { classify, detectRegions, listModels, get discoveredModels() { return discovered ? [...discovered] : null; } };
}

module.exports = { createVisionProvider, classifyProviderError, VisionAuthError, VisionUnavailableError, PREFERENCE_CHAIN, DEFAULT_BASE };
