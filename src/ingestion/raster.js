const { LIMITS, LimitError } = require('./limits');

const RASTER_VERSIONS = Object.freeze({ parser: 'raster-native-v1', normalization: 'image-space-v1', ruleset: 'raster-area-v1' });

function inspectRaster(content, sourceDocument, { limits = LIMITS } = {}) {
  const dimensions = sourceDocument.format === 'png' ? inspectPng(content, limits) : inspectJpeg(content, limits);
  return {
    format: sourceDocument.format,
    ingestVersion: RASTER_VERSIONS.parser,
    versions: RASTER_VERSIONS,
    pages: [{
      sourcePageId: 'page_1', pageNumber: 1, kind: 'raster', width: dimensions.width, height: dimensions.height,
      pixelWidth: dimensions.width, pixelHeight: dimensions.height, coordinateSpace: 'image', rotation: 0,
      transform: [1, 0, 0, 1, 0, 0], route: 'raster', nativeTextIds: [], nativeRegionIds: [],
      rasterRegionIds: [], rasterRegions: [], calibration: null, regions: []
    }]
  };
}

function inspectPng(bytes, limits) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) throw rasterError('Malformed PNG: missing signature.');
  let offset = 8;
  let dimensions;
  let hasIdat = false;
  let seenIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw rasterError('Malformed PNG: truncated chunk header.');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type)) throw rasterError('Malformed PNG: invalid chunk type.');
    if (!Number.isSafeInteger(end) || end > bytes.length) throw rasterError(`Malformed PNG: truncated ${type || 'image'} chunk.`);
    if (seenIend) throw rasterError('Malformed PNG: chunks found after IEND.');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
    if (actualCrc !== expectedCrc) throw rasterError(`Malformed PNG: CRC mismatch in ${type} chunk.`);
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw rasterError('Malformed PNG: IHDR must be the first 13-byte chunk.');
      if (dimensions) throw rasterError('Malformed PNG: duplicate IHDR chunk.');
      dimensions = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      const compressionMethod = bytes[offset + 18];
      const filterMethod = bytes[offset + 19];
      const interlaceMethod = bytes[offset + 20];
      const legalBitDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16]
      };
      if (!legalBitDepths[colorType]?.includes(bitDepth)) throw rasterError('Malformed PNG: unsupported color type and bit depth combination.');
      if (compressionMethod !== 0 || filterMethod !== 0 || ![0, 1].includes(interlaceMethod)) throw rasterError('Malformed PNG: unsupported compression, filter, or interlace method.');
      validateDimensions(dimensions.width, dimensions.height, 'PNG', limits);
    } else if (!dimensions) {
      throw rasterError(`Malformed PNG: ${type} appears before IHDR.`);
    } else if (type === 'IDAT') hasIdat = true;
    else if (type === 'IEND') {
      if (length !== 0) throw rasterError('Malformed PNG: IEND must be empty.');
      if (!hasIdat) throw rasterError('Malformed PNG: IEND appears before image data.');
      seenIend = true;
      if (end !== bytes.length) throw rasterError('Malformed PNG: trailing bytes after IEND.');
    }
    offset = end;
  }
  if (!dimensions) throw rasterError('Malformed PNG: missing IHDR dimensions.');
  if (!hasIdat || !seenIend) throw rasterError('Malformed PNG: missing image data or IEND.');
  return dimensions;
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
}));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectJpeg(bytes, limits) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw rasterError('Malformed JPEG: missing SOI marker.');
  let offset = 2;
  let dimensions;
  let hasScan = false;
  let hasEoi = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw rasterError('Malformed JPEG: expected a marker.');
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) { hasEoi = true; break; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xda) { hasScan = true; break; }
    if (offset + 2 > bytes.length) throw rasterError('Malformed JPEG: truncated marker length.');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw rasterError('Malformed JPEG: truncated marker payload.');
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      validateDimensions(width, height, 'JPEG', limits);
      dimensions ||= { width, height };
    }
    offset += length;
  }
  if (hasScan) {
    const scanEnd = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
    hasEoi = scanEnd >= 0;
  }
  if (!dimensions || !hasScan || !hasEoi) throw rasterError('Malformed JPEG: no complete frame or end marker found.');
  return dimensions;
}

function validateDimensions(width, height, label, limits) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw rasterError(`Malformed ${label}: dimensions must be positive integers.`);
  if (width > limits.rasterWidth) throw new LimitError(`${label} width exceeds the safe limit.`, { limitName: 'rasterWidth', observed: width, maximum: limits.rasterWidth, stage: 'ingestion' });
  if (height > limits.rasterHeight) throw new LimitError(`${label} height exceeds the safe limit.`, { limitName: 'rasterHeight', observed: height, maximum: limits.rasterHeight, stage: 'ingestion' });
  if (width * height > limits.rasterPixels) throw new LimitError(`${label} pixel area exceeds the safe limit.`, { limitName: 'rasterPixels', observed: width * height, maximum: limits.rasterPixels, stage: 'ingestion' });
}

function rasterError(message) {
  const error = new Error(message);
  error.code = 'malformed_raster';
  error.stage = 'ingestion';
  error.retryable = false;
  return error;
}

module.exports = { inspectRaster, RASTER_VERSIONS };
