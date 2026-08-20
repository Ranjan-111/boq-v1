const PDF_HEADER = Buffer.from('%PDF-');
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff]);

function asBytes(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(String(content || ''), 'utf8');
}

function sniffContent(content) {
  const bytes = asBytes(content);
  if (bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) return { format: 'pdf', mediaType: 'application/pdf' };
  if (bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return { format: 'png', mediaType: 'image/png' };
  if (bytes.subarray(0, JPEG_HEADER.length).equals(JPEG_HEADER)) return { format: 'jpeg', mediaType: 'image/jpeg' };
  const prefix = bytes.subarray(0, 64 * 1024).toString('latin1');
  if (/^AC10\d{2}/.test(prefix)) return { format: 'dwg', mediaType: 'application/acad' };
  if (/(?:^|\r?\n)0\r?\nSECTION\r?\n2\r?\n[A-Z]+/i.test(prefix)) return { format: 'dxf', mediaType: 'application/dxf' };
  return { format: 'unknown', mediaType: 'application/octet-stream' };
}

module.exports = { asBytes, sniffContent };
