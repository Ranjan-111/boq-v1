/* Vision fallback.
   Runs ONLY on entities the deterministic rules could not classify.
   Contract: the model returns a LABEL. It never returns, and this module
   never accepts, a quantity, dimension, area or price. */
(function (root) {
  'use strict';

  const ONTOLOGY = ['SOFA', 'BED', 'TABLE', 'CHAIR', 'CABINET', 'WARDROBE',
    'WC', 'BASIN', 'DOOR', 'WINDOW', 'STAIR', 'KITCHEN_UNIT', 'UNKNOWN'];

  const CATEGORY_OF = {
    SOFA: 'furniture', BED: 'furniture', TABLE: 'furniture', CHAIR: 'furniture',
    CABINET: 'furniture', WARDROBE: 'furniture', KITCHEN_UNIT: 'furniture',
    WC: 'fixture', BASIN: 'fixture', DOOR: 'door', WINDOW: 'window',
    STAIR: 'stair', UNKNOWN: null
  };

  /* ---------------------------------------------------- residual finder */
  /* Two different things can be unresolved, and conflating them is a mistake:

     CATEGORY  - "is this furniture at all?"  Layer name can answer this.
     ITEM      - "which furniture is it?"     Only the block name answers this.

     A drawing with a clean A-FURN layer and a block called Block_17 gives you
     a correct COUNT (the layer voted) but no ITEM identity - so it cannot be
     priced or matched to a vendor product. That is still a residual, and it is
     the common case in real drawings. */
  function residuals(doc, layerCategory, blockCategory) {
    const out = [];
    for (const e of doc.entities) {
      if (e.type === 'INSERT') {
        const lcRaw = layerCategory(e.layer);
        const lc = (lcRaw === 'ignore') ? null : lcRaw;
        const bc = blockCategory(e.block);
        if (bc === null) {
          out.push({
            ref: e, kind: 'block', label: e.block, layer: e.layer,
            categoryKnown: lc,                       // may be non-null from the layer
            missing: lc ? 'item' : 'category+item'
          });
        }
      } else if (e.unclassified && e.pts && e.pts.length > 2) {
        out.push({
          ref: e, kind: 'region', label: 'region ' + e.handle, layer: e.layer,
          categoryKnown: null, missing: 'category+item'
        });
      }
    }
    return out;
  }

  /* ------------------------------------------------------- crop render */
  function geometryFor(doc, item) {
    if (item.kind === 'region') return [item.ref.pts];
    const b = (doc.blocks || {})[item.ref.block];
    if (!b) return [];
    const [ox, oy] = item.ref.pos;
    const [bx, by] = b.base || [0, 0];
    const polys = [];
    for (const e of b.entities) {
      if (e.pts && e.pts.length > 1) polys.push(e.pts.map(p => [p[0] - bx + ox, p[1] - by + oy]));
    }
    return polys;
  }

  /* Renders ONLY the object, tightly cropped, at fixed pixel size.
     No dimensions, no annotation, no scale bar - nothing the model could
     read a number off and echo back. */
  function renderCrop(doc, item, size) {
    size = size || 256;
    const polys = geometryFor(doc, item);
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
    if (!polys.length) return { dataUrl: cv.toDataURL('image/png'), empty: true };

    let xs = [], ys = [];
    for (const p of polys) for (const q of p) { xs.push(q[0]); ys.push(q[1]); }
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = size * 0.12;
    const s = Math.min((size - pad * 2) / ((maxX - minX) || 1), (size - pad * 2) / ((maxY - minY) || 1));
    const ox = (size - (maxX - minX) * s) / 2, oy = (size - (maxY - minY) * s) / 2;
    g.strokeStyle = '#000'; g.lineWidth = 2; g.lineJoin = 'round';
    for (const p of polys) {
      g.beginPath();
      p.forEach((q, i) => {
        const X = ox + (q[0] - minX) * s, Y = size - (oy + (q[1] - minY) * s);
        i ? g.lineTo(X, Y) : g.moveTo(X, Y);
      });
      g.stroke();
    }
    return { dataUrl: cv.toDataURL('image/png'), empty: false };
  }

  /* ------------------------------------------------------- the API call */
  const PROMPT =
    'You are looking at a single symbol cropped from an architectural floor plan, drawn in plan view (from above).\n' +
    'Identify what the symbol represents.\n' +
    'Reply with EXACTLY ONE word from this list and nothing else:\n' +
    ONTOLOGY.join(' | ') + '\n' +
    'If you are not confident, reply UNKNOWN. Do not explain. Do not give dimensions, ' +
    'quantities, areas or prices - those are computed elsewhere and any number you supply will be discarded.';

  /* Structural guarantee: whatever comes back, we keep only a label that
     exists in the ontology. Numbers cannot survive this function. */
  function coerceLabel(raw) {
    const up = String(raw || '').trim().toUpperCase();
    return ONTOLOGY.includes(up) ? up : 'UNKNOWN';
  }

  const BASE = 'https://generativelanguage.googleapis.com/v1beta';

  /* Preference order, newest first. This is a FALLBACK CHAIN, not a hardcoded
     model: listModels() is authoritative when a key is present. Hardcoding one
     name is what broke this integration the first time - gemini-2.0-flash was
     retired on 31 March 2026 and every call 404'd. */
  const PREFERRED = [
    'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
    'gemini-3-flash', 'gemini-2.5-flash'
  ];

  /* Ask the API what actually exists rather than guessing. */
  async function listModels(apiKey) {
    if (!apiKey) return { models: [], note: 'No key - cannot query available models.' };
    try {
      const r = await fetch(BASE + '/models', { headers: { 'x-goog-api-key': apiKey } });
      if (!r.ok) return { models: [], note: 'models list failed: HTTP ' + r.status };
      const j = await r.json();
      const usable = (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(n => !/embedding|aqa|imagen|tts|veo|robotics|native-audio/i.test(n));
      // rank by preference, then newest-looking version number, then name
      const ver = n => { const m = /(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
      usable.sort((a, b) => {
        const pa = PREFERRED.indexOf(a), pb = PREFERRED.indexOf(b);
        if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
        if (ver(b) !== ver(a)) return ver(b) - ver(a);
        return a.localeCompare(b);
      });
      return { models: usable, note: usable.length + ' model(s) support generateContent' };
    } catch (e) {
      return { models: [], note: String(e.message || e) };
    }
  }

  async function classify(dataUrl, context, apiKey, model) {
    const t0 = performance.now();
    if (!apiKey) {
      return {
        label: 'UNKNOWN', source: 'stub', ms: 0,
        note: 'No API key set - vision is stubbed. The pipeline runs without it; every residual simply routes to a human.'
      };
    }
    const b64 = dataUrl.split(',')[1];
    const ctx = 'Drawing context (for disambiguation only): block name "' +
      (context.label || '?') + '", layer "' + (context.layer || '?') + '".';
    // key travels in a header, never in the URL query string
    const candidates = model ? [model] : PREFERRED;
    let lastErr = null;
    for (const cand of candidates) {
      const out = await callOne(cand, b64, ctx, apiKey, t0);
      if (out.source !== 'error') return out;
      lastErr = out;
      // only walk the chain on "model does not exist" style failures
      if (!/404|not found|not available|NOT_FOUND|unsupported/i.test(out.note || '')) break;
    }
    return lastErr || { label: 'UNKNOWN', source: 'error', ms: 0, note: 'no candidate model succeeded' };
  }

  async function callOne(model, b64, ctx, apiKey, t0) {
    const url = BASE + '/models/' + model + ':generateContent';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: PROMPT + '\n' + ctx },
              { inline_data: { mime_type: 'image/png', data: b64 } }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 16 }
        })
      });
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) {
        const t = await r.text();
        return { label: 'UNKNOWN', source: 'error', ms, model,
                 note: 'API ' + r.status + ' on ' + model + ': ' + t.slice(0, 160) };
      }
      const j = await r.json();
      const raw = (((j.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || '';
      const label = coerceLabel(raw);
      return {
        label, source: 'gemini', ms, raw: raw.trim(), model,
        note: label === 'UNKNOWN' ? 'Model was not confident, or replied outside the ontology.' : ''
      };
    } catch (e) {
      return { label: 'UNKNOWN', source: 'error', model, ms: Math.round(performance.now() - t0), note: String(e.message || e) };
    }
  }

  /* ------------------------------------------------- raster region detect */
  /* Tier C only. There is no geometry in a raster, so a proposal is the only
     way a machine can contribute. Two hard limits keep this honest:
       1. The model proposes BOUNDARIES, never a scale. Pixels become metres
          only through a figure a human typed, so no quantity can originate here.
       2. Every proposed region is marked 'proposed' and must be confirmed by a
          human before it can enter a BOQ line. */
  const RASTER_CLASSES = ['ROOM', 'WALL', 'DOOR', 'WINDOW', 'SOFA', 'BED', 'TABLE',
    'CHAIR', 'WARDROBE', 'CABINET', 'WC', 'BASIN', 'KITCHEN_UNIT', 'STAIR'];

  const RASTER_PROMPT =
    'This is an architectural floor plan drawing (plan view, from above).\n' +
    'Detect the 2D bounding boxes of the rooms and the fixed/loose furniture items you can identify.\n' +
    'Return ONLY a JSON array. Each entry must have exactly two keys:\n' +
    '  "box_2d": [ymin, xmin, ymax, xmax] normalized to 0-1000\n' +
    '  "label" : one of ' + RASTER_CLASSES.join(', ') + '\n' +
    'Never return masks. Limit to 25 objects. Do not output areas, dimensions, ' +
    'scales, quantities or prices - any such value will be discarded. ' +
    'Do not guess the drawing scale; a human supplies it.';

  function parseBoxes(raw, imgW, imgH) {
    let arr;
    try { arr = JSON.parse(String(raw || '').trim()); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const keys = Object.keys(it);
      if (keys.length !== 2 || !keys.includes('box_2d') || !keys.includes('label')) continue;
      const b = it.box_2d;
      if (!Array.isArray(b) || b.length !== 4 || b.some(v => typeof v !== 'number' || !Number.isFinite(v))) continue;
      const [y0, x0, y1, x1] = b;
      if (!(0 <= y0 && y0 < y1 && y1 <= 1000 && 0 <= x0 && x0 < x1 && x1 <= 1000)) continue;
      // normalized 0-1000, y first, top-left origin
      const X0 = x0 / 1000 * imgW, X1 = x1 / 1000 * imgW;
      const Y0 = y0 / 1000 * imgH, Y1 = y1 / 1000 * imgH;
      // drop degenerate slivers: a real room or fixture is never a handful of pixels.
      // absolute pixel floors are useless across image sizes, so scale the test.
      if ((X1 - X0) < imgW * 0.01 || (Y1 - Y0) < imgH * 0.01) continue;
      if ((X1 - X0) * (Y1 - Y0) < imgW * imgH * 0.0005) continue;
      const label = coerceRasterLabel(it.label);
      if (label === 'UNKNOWN') continue;
      out.push({ label, box: [X0, Y0, X1, Y1] });
    }
    return out;
  }

  function coerceRasterLabel(raw) {
    const up = String(raw || '').trim().toUpperCase().replace(/[^A-Z_ ]/g, ' ').replace(/\s+/g, ' ');
    for (const t of RASTER_CLASSES) {
      if (up === t || up === t.replace('_', ' ')) return t;
    }
    if (/^(LIVING|BEDROOM|KITCHEN|BATH|TOILET|HALL|DINING|BALCON)( ROOM)?$/.test(up)) return 'ROOM';
    return 'UNKNOWN';
  }

  async function detectRegions(dataUrl, imgW, imgH, apiKey, model) {
    const t = performance.now();
    if (!apiKey) return { boxes: [], ms: 0, source: 'stub', note: 'No API key - raster detection stubbed. Trace regions manually instead.' };
    const b64 = dataUrl.split(',')[1];
    const candidates = model ? [model] : PREFERRED;
    let last = null;
    for (const cand of candidates) {
      try {
        const r = await fetch(BASE + '/models/' + cand + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: RASTER_PROMPT }, { inline_data: { mime_type: 'image/png', data: b64 } }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' }
          })
        });
        const ms = Math.round(performance.now() - t);
        if (!r.ok) {
          const e = await r.text();
          last = { boxes: [], ms, source: 'error', model: cand, note: 'API ' + r.status + ' on ' + cand + ': ' + e.slice(0, 150) };
          if (/404|NOT_FOUND|not found|not available|unsupported/i.test(e) || r.status === 404) continue;
          return last;
        }
        const j = await r.json();
        const raw = (((j.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || '';
        const boxes = parseBoxes(raw, imgW, imgH);
        return { boxes, ms, source: 'gemini', model: cand, raw: raw.slice(0, 400),
                 note: boxes.length ? '' : 'Model replied but no usable boxes were parsed.' };
      } catch (e) {
        last = { boxes: [], ms: Math.round(performance.now() - t), source: 'error', model: cand, note: String(e.message || e) };
      }
    }
    return last || { boxes: [], ms: 0, source: 'error', note: 'no candidate model succeeded' };
  }

  const API = { ONTOLOGY, CATEGORY_OF, residuals, detectRegions, parseBoxes, coerceRasterLabel, RASTER_CLASSES, RASTER_PROMPT, renderCrop, geometryFor, classify, coerceLabel, PROMPT, listModels, PREFERRED, BASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.VISION = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
