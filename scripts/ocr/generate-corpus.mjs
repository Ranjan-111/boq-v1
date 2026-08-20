import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('../..', import.meta.url).pathname);
const outDir = join(repo, 'test', 'fixtures', 'ocr-corpus');
const generationVersion = 'ocr-corpus-v1';

const specs = [
  {
    id: 'title-storey', width: 1800, height: 1000, background: '#ffffff',
    records: [
      rec('title', 'DRAWING TO BOQ', 120, 130, 64, 720, 90, 'title'),
      rec('project', 'PROJECT: KORAMANGALA RESIDENCE', 120, 260, 38, 660, 56, 'project'),
      rec('storey', 'STOREY: GROUND FLOOR', 120, 365, 42, 560, 58, 'storey'),
      rec('sheet', 'SHEET: A-101', 120, 470, 38, 300, 52, 'sheet'),
      rec('scale', 'SCALE 1:50', 120, 575, 38, 260, 52, 'scale'),
      rec('note', 'NOTES: VERIFY ON SITE', 120, 800, 34, 500, 48, 'note')
    ]
  },
  {
    id: 'numeric-units', width: 1800, height: 1100, background: '#ffffff',
    records: [
      rec('dim-4500', '4500 mm', 120, 150, 54, 270, 70, 'dimension'),
      rec('dim-325', '3.25 m', 120, 290, 54, 210, 70, 'decimal'),
      rec('dim-120', '1.20 m', 120, 430, 54, 210, 70, 'decimal'),
      rec('dim-075', '0.75 m', 120, 570, 54, 210, 70, 'decimal'),
      rec('unit', 'UNITS: MILLIMETRES', 850, 150, 42, 450, 58, 'unit'),
      rec('level', 'LEVEL +3.60 m', 850, 290, 48, 390, 64, 'level'),
      rec('wall', 'WALL THICKNESS 230 mm', 850, 430, 42, 550, 58, 'dimension'),
      rec('suspicious', 'CHECK DIMENSION 999.99 mm', 850, 570, 38, 600, 52, 'suspicious-dimension')
    ]
  },
  ...[0, 90, 180, 270].map((rotation) => ({
    id: `rotated-${rotation}`, width: 1200, height: 800, background: '#ffffff', rotation,
    records: [
      rec('rot-storey', 'STOREY 02', 180, 330, 58, 330, 76, 'storey'),
      rec('rot-dim', '2.75 m', 180, 440, 58, 260, 76, 'decimal'),
      rec('rot-north', 'NORTH', 180, 550, 58, 220, 76, 'orientation')
    ]
  })),
  {
    id: 'large-sheet', width: 4000, height: 3000, background: '#ffffff',
    records: [
      rec('large-title', 'LARGE SHEET OCR BENCHMARK', 140, 130, 60, 1200, 80, 'title'),
      rec('large-storey', 'STOREY: THIRD FLOOR', 140, 240, 42, 560, 58, 'storey'),
      ...Array.from({ length: 48 }, (_, index) => {
        const row = index % 12;
        const col = Math.floor(index / 12);
        const area = (8.25 + index * 0.37).toFixed(2);
        return rec(`room-${String(index + 1).padStart(2, '0')}`, `ROOM ${String(index + 1).padStart(2, '0')} AREA ${area} m2`, 140 + col * 960, 520 + row * 170, 34, 730, 48, 'large-sheet-row');
      })
    ]
  }
];

function rec(id, text, x, y, fontSize, boxWidth, boxHeight, role) {
  return { id, text, x, y, fontSize, boxWidth, boxHeight, role, polygon: [[x, y - boxHeight], [x + boxWidth, y - boxHeight], [x + boxWidth, y], [x, y]] };
}

function svgFor(spec) {
  const transform = spec.rotation ? `transform="rotate(${spec.rotation} ${spec.width / 2} ${spec.height / 2})"` : '';
  const style = 'font-family:Arial,Helvetica,sans-serif;font-weight:700;letter-spacing:1px;';
  const text = spec.records.map((r) => `<text x="${r.x}" y="${r.y}" font-size="${r.fontSize}" fill="#111111" style="${style}">${escapeXml(r.text)}</text>`).join('');
  const rules = spec.id === 'large-sheet'
    ? '<path d="M120 300 H3880 M120 450 H3880" stroke="#777" stroke-width="3" fill="none"/>'
    : '<rect x="70" y="70" width="1660" height="820" fill="none" stroke="#222" stroke-width="4"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}"><rect width="100%" height="100%" fill="${spec.background}"/><g ${transform}>${rules}${text}</g></svg>`;
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const groundTruth = { schemaVersion: 'ocr-ground-truth-v1', generationVersion, assets: {} };

  for (const spec of specs) {
    await page.setViewportSize({ width: spec.width, height: spec.height });
    const svg = svgFor(spec);
    await page.setContent(svg);
    await page.screenshot({ path: join(outDir, `${spec.id}.png`), animations: 'disabled' });
    groundTruth.assets[spec.id] = {
      width: spec.width,
      height: spec.height,
      rotation: spec.rotation || 0,
      records: spec.records.map(({ id, text, role, polygon }) => ({ id, text, role, polygon: transformPolygon(polygon, spec.rotation || 0, spec.width, spec.height), tokens: tokenise(text) }))
    };
  }
  await browser.close();

  const manifest = {
    schemaVersion: 'ocr-corpus-manifest-v1',
    generationVersion,
    generatedAt: '2026-08-20',
    language: 'eng',
    assets: {}
  };
  for (const id of Object.keys(groundTruth.assets)) {
    const file = join(outDir, `${id}.png`);
    const bytes = await readFile(file);
    manifest.assets[id] = {
      file: `${id}.png`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      width: groundTruth.assets[id].width,
      height: groundTruth.assets[id].height,
      rotation: groundTruth.assets[id].rotation,
      recordCount: groundTruth.assets[id].records.length,
      roles: [...new Set(groundTruth.assets[id].records.map((record) => record.role))].sort()
    };
  }
  await writeFile(join(outDir, 'ground_truth.json'), `${JSON.stringify(groundTruth, null, 2)}\n`);
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ outDir, assets: manifest.assets }, null, 2));
}

function tokenise(text) {
  return text.toUpperCase().match(/[A-Z0-9]+(?:\.[0-9]+)?/g) || [];
}

function transformPolygon(polygon, rotation, width, height) {
  return polygon.map(([x, y]) => {
    const centerX = width / 2;
    const centerY = height / 2;
    if (rotation === 90) return [centerX + centerY - y, centerY - centerX + x];
    if (rotation === 180) return [width - x, height - y];
    if (rotation === 270) return [centerX - centerY + y, centerX + centerY - x];
    return [x, y];
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
