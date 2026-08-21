/* Residual crops (#10).

   A crop is rendered from the residual's real footprint -- 3a made block
   geometry available, so an INSERT is drawn as its transformed outline rather
   than as a dot.

   This renderer has no text primitive. Not "we chose not to draw dimensions":
   there is no code path here that can put a glyph on the canvas, so a crop
   cannot carry a number for a model to read off and echo back as a quantity. */

const { deflateSync } = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 8-bit greyscale PNG from a width*height pixel buffer. */
function encodePng(pixels, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 0;  // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function fillPolygon(pixels, width, height, points, value) {
  if (points.length < 3) return;
  let minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  let maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    const crossings = [];
    for (let index = 0; index < points.length; index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[(index + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil(crossings[pair]));
      const to = Math.min(width - 1, Math.floor(crossings[pair + 1]));
      for (let x = from; x <= to; x += 1) pixels[y * width + x] = value;
    }
  }
}

const BACKGROUND = 0xff;
const INK = 0x20;

/**
 * Render one residual's footprint, fitted to the canvas with a small margin.
 * @returns {{png: Buffer, base64: string, mediaType: string, width: number, height: number}}
 */
function renderCrop(geometry, { size = 224, margin = 0.12 } = {}) {
  const points = (geometry || []).filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  const pixels = Buffer.alloc(size * size, BACKGROUND);
  if (points.length >= 3) {
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const usable = size * (1 - margin * 2);
    const scale = usable / span;
    const offsetX = (size - (maxX - minX) * scale) / 2;
    const offsetY = (size - (maxY - minY) * scale) / 2;
    /* y is flipped: drawing space is y-up, image space is y-down. */
    const projected = points.map(([x, y]) => [
      offsetX + (x - minX) * scale,
      size - (offsetY + (y - minY) * scale)
    ]);
    fillPolygon(pixels, size, size, projected, INK);
  }
  const png = encodePng(pixels, size, size);
  return { png, base64: png.toString('base64'), mediaType: 'image/png', width: size, height: size };
}

module.exports = { renderCrop, encodePng };
