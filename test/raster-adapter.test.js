const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { inspectRaster } = require('../src/ingestion/raster');

const fixture = readFileSync(join(__dirname, 'fixtures', 'raster-200x100.png'));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withIhdr(changes) {
  const bytes = Buffer.from(fixture);
  Object.entries(changes).forEach(([offset, value]) => { bytes[Number(offset)] = value; });
  const ihdr = bytes.subarray(12, 29);
  bytes.writeUInt32BE(crc32(ihdr), 29);
  return bytes;
}

test('PNG adapter accepts only legal IHDR color/depth combinations', () => {
  assert.equal(inspectRaster(fixture, { format: 'png' }).pages[0].pixelWidth, 200);
  for (const [colorType, bitDepth] of [[2, 1], [3, 16], [4, 4], [6, 4]]) {
    assert.throws(() => inspectRaster(withIhdr({ 24: bitDepth, 25: colorType }), { format: 'png' }), /color type and bit depth/i);
  }
});

test('PNG adapter rejects unsupported IHDR compression, filter, and interlace methods', () => {
  for (const offset of [26, 27, 28]) {
    assert.throws(() => inspectRaster(withIhdr({ [offset]: 2 }), { format: 'png' }), /compression, filter, or interlace/i);
  }
});
