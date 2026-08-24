/* Drawing viewer - an interactive canvas for the geometry behind the BOQ.

   Every source object already carries its real geometry (3a), bounds and
   identity. This module draws those objects on a dark technical canvas with
   smooth zoom/pan, glowing selection outlines, and per-contribution tier
   colouring, so selecting a BOQ line shows exactly what was measured and
   what was skipped.

   Read-only over run.boq.sourceObjects: no fetching, no state, no parallel
   measurement system. */

export const STATES = Object.freeze({
  idle:      { stroke: '#3a3f4b', fill: 'rgba(255,255,255,0.03)', width: 1 },
  related:   { stroke: '#4d7cfe', fill: 'rgba(77,124,254,0.10)', width: 1.5 },
  selected:  { stroke: '#e22718', fill: 'rgba(226,39,24,0.20)',  width: 2.5 },
  unresolved:{ stroke: '#8a6d00', fill: 'rgba(255,193,7,0.06)',  width: 1, dash: [4, 4] },
  excluded:  { stroke: '#2e3440', fill: 'rgba(0,0,0,0)',         width: 0.75 }
});
export function createDrawingViewer(canvasElement, { margin = 40 } = {}) {
  const canvas = canvasElement;
  const ctx = canvas.getContext('2d');

  let objects = [];
  let objectsById = new Map();
  let selectedIds = new Set();
  let relatedIds = new Set();
  let unresolvedIds = new Set();
  let view = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  let targetView = null;   // for animated transitions
  let animStart = null;    // animation start time
  let animFrom = null;     // view before animation started
  let panState = null;     // active drag state
  let hoverPoint = null;   // mouse position in world coords
  let raf = null;
  const listeners = { select: [], hover: [] };

  function on(event, callback) {
    (listeners[event] || (listeners[event] = [])).push(callback);
    return () => { const i = listeners[event].indexOf(callback); if (i >= 0) listeners[event].splice(i, 1); };
  }
  function emit(event, data) { (listeners[event] || []).forEach((cb) => cb(data)); }

  /* Load a set of source objects and fit the view to their bounds. */
  function load(newObjects) {
    objects = (newObjects || []).filter((o) => Array.isArray(o.geometry) && o.geometry.length > 0);
    objectsById = new Map(objects.map((o) => [o.sourceObjectId, o]));
    selectedIds.clear(); relatedIds.clear(); unresolvedIds.clear();
    for (const o of objects) {
      if (o.geometryResolution === 'insertion-point') unresolvedIds.add(o.sourceObjectId);
    }
    fitAll();
  }

  function boundsOf(objects) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const o of objects) {
      if (!Array.isArray(o.bounds) || o.bounds.length !== 4) continue;
      const [a, b, c, d] = o.bounds;
      if (![a, b, c, d].every(Number.isFinite)) continue;
      minX = Math.min(minX, a); minY = Math.min(minY, b);
      maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
      any = true;
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  function setView(v) { view = { ...v }; }

  function animateTo(target) {
    animFrom = { ...view };
    targetView = target;
    animStart = performance.now();
    startLoop();
  }

  function fitAll() {
    const b = boundsOf(objects);
    if (b) { expand(b, margin * 2 / Math.max(canvas.clientWidth, canvas.clientHeight, 1)); animateTo(b); }
  }

  function focusOn(ids, { margin: m = margin } = {}) {
    selectedIds = new Set(); relatedIds = new Set();
    for (const id of ids) selectedIds.add(id);
    const chosen = [...ids].map((id) => objectsById.get(id)).filter(Boolean);
    const b = boundsOf(chosen);
    if (!b) return;
    expand(b, m * 2 / Math.max(canvas.clientWidth, canvas.clientHeight, 1));
    animateTo(b);
  }

  function expand(b, fraction) {
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    const dx = w * fraction || 1, dy = h * fraction || 1;
    return { minX: b.minX - dx, minY: b.minY - dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
  }

  /* Coordinate transforms between world space and canvas space. */
  function worldToScreen(x, y) {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const sx = W / (view.maxX - view.minX), sy = H / (view.maxY - view.minY);
    const s = Math.min(sx, sy);
    const cx = (view.minX + view.maxX) / 2, cy = (view.minY + view.maxY) / 2;
    return { x: (x - cx) * s + W / 2, y: H / 2 - (y - cy) * s };
  }

  function screenToWorld(px, py) {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const sx = W / (view.maxX - view.minX), sy = H / (view.maxY - view.minY);
    const s = Math.min(sx, sy);
    const cx = (view.minX + view.maxX) / 2, cy = (view.minY + view.maxY) / 2;
    return { x: (px - W / 2) / s + cx, y: (H / 2 - py) / s + cy };
  }

  /* Draw the full scene: grid, then each entity in its visual state. */
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    drawGrid();

    for (const o of objects) {
      const state = stateFor(o);
      const style = STATES[state];
      drawEntity(o, style);
    }

    if (hoverPoint) drawHover();
  }

  function stateFor(o) {
    if (selectedIds.has(o.sourceObjectId)) return 'selected';
    if (unresolvedIds.has(o.sourceObjectId)) return 'unresolved';
    if (relatedIds.has(o.sourceObjectId)) return 'related';
    return 'idle';
  }

  function drawEntity(o, style) {
    const pts = o.geometry;
    if (!Array.isArray(pts) || !pts.length) return;

    ctx.lineWidth = style.width;
    ctx.strokeStyle = style.stroke;
    ctx.fillStyle = style.fill;
    if (style.dash) ctx.setLineDash(style.dash);
    else ctx.setLineDash([]);

    if (o.geometryResolution === 'insertion-point' && pts.length === 1) {
      const p = worldToScreen(pts[0][0], pts[0][1]);
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = style.stroke; ctx.fill();
      return;
    }

    if (pts.length === 2 && o.geometryResolution === 'native') {
      const a = worldToScreen(pts[0][0], pts[0][1]);
      const b = worldToScreen(pts[1][0], pts[1][1]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      return;
    }

    /* Polygon: closed or open path. */
    const screenPts = pts.map(([x, y]) => worldToScreen(x, y));
    ctx.beginPath();
    screenPts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    if (o.geometryResolution !== 'insertion-point' && o.closed !== false) ctx.closePath();
    if (style.fill && style.fill !== 'rgba(0,0,0,0)') ctx.fill();
    ctx.stroke();

    /* Glow on selected. */
    if (selectedIds.has(o.sourceObjectId)) {
      ctx.save();
      ctx.shadowColor = style.stroke;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.width + 0.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* Subtle engineering grid, scaled to current view. */
  function drawGrid() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const worldW = view.maxX - view.minX;
    const step = niceStep(worldW / 12);
    if (!Number.isFinite(step) || step <= 0) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;

    const startGridX = Math.floor(view.minX / step) * step;
    for (let gx = startGridX; gx <= view.maxX; gx += step) {
      const p = worldToScreen(gx, 0);
      ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, H); ctx.stroke();
    }
    const startGridY = Math.floor(view.minY / step) * step;
    for (let gy = startGridY; gy <= view.maxY; gy += step) {
      const p = worldToScreen(0, gy);
      ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(W, p.y); ctx.stroke();
    }

    /* Origin crosshair. */
    const o = worldToScreen(0, 0);
    if (o.x > 0 && o.x < W && o.y > 0 && o.y < H) {
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath(); ctx.moveTo(o.x - 8, o.y); ctx.lineTo(o.x + 8, o.y);
      ctx.moveTo(o.x, o.y - 8); ctx.lineTo(o.x, o.y + 8); ctx.stroke();
    }
  }

  function niceStep(raw) {
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / mag;
    if (norm < 1.5) return mag;
    if (norm < 3) return 2 * mag;
    if (norm < 7) return 5 * mag;
    return 10 * mag;
  }

  function drawHover() {
    /* Draw a small crosshair at the cursor position in world space. */
    const p = worldToScreen(hoverPoint.x, hoverPoint.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.stroke();
  }

  /* Animation loop for smooth view transitions. */
  function startLoop() {
    if (raf) return;
    const step = (now) => {
      if (!animStart || !animFrom || !targetView) { raf = null; return; }
      const t = Math.min(1, (now - animStart) / 300); // 300ms ease-out
      const ease = 1 - Math.pow(1 - t, 3);
      view = {
        minX: animFrom.minX + (targetView.minX - animFrom.minX) * ease,
        minY: animFrom.minY + (targetView.minY - animFrom.minY) * ease,
        maxX: animFrom.maxX + (targetView.maxX - animFrom.maxX) * ease,
        maxY: animFrom.maxY + (targetView.maxY - animFrom.maxY) * ease
      };
      render();
      if (t >= 1) { raf = null; animStart = null; animFrom = null; targetView = null; }
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  /* Pan (drag) and zoom (wheel). */
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    panState = { startX: e.clientX - rect.left, startY: e.clientY - rect.top, startView: { ...view } };
  });
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    hoverPoint = screenToWorld(px, py);
    if (!panState) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const sx = W / (view.maxX - view.minX), sy = H / (view.maxY - view.minY);
    const s = Math.min(sx, sy);
    const dx = (px - panState.startX) / s;
    const dy = (py - panState.startY) / s;
    view = {
      minX: panState.startView.minX - dx, maxX: panState.startView.maxX - dx,
      minY: panState.startView.minY + dy, maxY: panState.startView.maxY + dy
    };
  });
  window.addEventListener('mouseup', () => { panState = null; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const before = screenToWorld(px, py);
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    view = { minX: before.x + (view.minX - before.x) * factor, minY: before.y + (view.minY - before.y) * factor, maxX: before.x + (view.maxX - before.x) * factor, maxY: before.y + (view.maxY - before.y) * factor };
    render();
  }, { passive: false });
const fs = require('fs');
const NL = String.fromCharCode(10);
const L = [];
const push = (s) => L.push(s);
push("");
push("  /* Click: find nearest source object and emit. */");
push("  canvas.addEventListener('click', (e) => {");
push("    const rect = canvas.getBoundingClientRect();");
push("    const px = e.clientX - rect.left, py = e.clientY - rect.top;");
push("    let best = null; let bestDist = Infinity;");
push("    for (const o of objects) {");
push("      if (!Array.isArray(o.bounds)) continue;");
push("      const [a, b, c, d] = o.bounds;");
push("      const cx = (a + c) / 2, cy = (b + d) / 2;");
push("      const p = worldToScreen(cx, cy);");
push("      const dist = Math.hypot(p.x - px, p.y - py);");
push("      if (dist < 24 && dist < bestDist) { best = o; bestDist = dist; }");
push("    }");
push("    if (best) emit('select', best);");
push("  });");
push("");
push("  /* Resize handling. */");
push("  window.addEventListener('resize', () => render());");
push("");
push("  return {");
push("    load, focusOn, setView, fitAll, render, on,");
push("    setRelated(ids) { relatedIds = new Set([...ids]); },");
push("    setSelected(ids) { selectedIds = new Set([...ids]); },");
push("    setUnresolved(ids) { unresolvedIds = new Set([...ids]); },");
push("    get view() { return { ...view }; },");
push("    get objectCount() { return objects.length; }");
push("  };");
push("}");
}
