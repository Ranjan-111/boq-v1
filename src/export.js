/* Reproducible approved exports (#17).

   An export is a reproducible artefact, not a render. Re-exporting the same
   approved BOQ version must produce byte-identical content at any later date,
   whatever has since been published to rulesets, rate books, catalogues or
   assumptions. That is why the artefact is built from the snapshot frozen at
   approval rather than from current state -- every version this system has been
   snapshotting exists for this moment.

   Nothing here reads the clock or the current project. Given the same frozen
   snapshot it produces the same bytes. */

const { roundMoney } = require('./rates');
const { deflateRawSync, crc32 } = require('node:zlib');

class ExportError extends Error {}

const FORMATS = Object.freeze(['csv', 'xlsx']);

/* Tier honesty must survive into the delivered document. This is the last point
   at which a traced estimate could come to look like a measured quantity, and
   not letting that happen is the product's core promise. */
const TIERS = Object.freeze({
  A: { tier: 'A', label: 'Measured (CAD)', note: 'Measured from exact CAD geometry.' },
  B: { tier: 'B', label: 'Measured (vector PDF)', note: 'Measured from vector PDF geometry at an operator-supplied scale.' },
  C: { tier: 'C', label: 'Traced estimate', note: 'Traced by hand or from a confirmed proposal on an image; an estimate, not measured geometry.' },
  unknown: { tier: '-', label: 'No source', note: 'No source geometry resolved for this line.' }
});

const SPACE_TO_TIER = Object.freeze({ dxf: 'A', 'pdf-page': 'B', 'raster-pixel': 'C' });
const WEAKEST_FIRST = ['C', 'B', 'A'];

/** A line mixing tiers is reported at its weakest: a total containing a traced
    estimate is not a measured quantity. */
function tierOf(line, sourceObjects = []) {
  const byId = new Map(sourceObjects.map((object) => [object.sourceObjectId, object]));
  const tiers = new Set();
  for (const contribution of line.provenance?.contributions || []) {
    const object = byId.get(contribution.sourceObjectId);
    const tier = object && SPACE_TO_TIER[object.coordinateSpace];
    if (tier) tiers.add(tier);
  }
  if (!tiers.size) return TIERS.unknown;
  const weakest = WEAKEST_FIRST.find((tier) => tiers.has(tier));
  return { ...TIERS[weakest], mixed: tiers.size > 1 };
}

/**
 * Build the artefact from a frozen approval snapshot. Pure: same input, same
 * output, no clock, no current-state lookup.
 */
function buildArtefact(snapshot) {
  const { boqVersionId, projectName, stamp, lines, sourceObjects, catalogue } = snapshot;
  const rows = [];
  for (const line of lines) {
    const tier = tierOf(line, sourceObjects);
    rows.push({
      itemCode: line.itemCode,
      description: line.description,
      unit: line.unit,
      quantity: Number.isFinite(line.quantity) ? line.quantity : null,
      rate: Number.isFinite(line.rate) ? line.rate : null,
      amount: Number.isFinite(line.amount) ? line.amount : null,
      tier: tier.tier,
      tierLabel: tier.label,
      basis: tier.note,
      measurementStatus: line.measurementStatus,
      pricingStatus: line.pricingStatus,
      sortOrder: line.sortOrder ?? 1000
    });
  }
  rows.sort((left, right) => left.sortOrder - right.sortOrder || String(left.itemCode).localeCompare(String(right.itemCode)));

  /* The printed total is the sum of the printed row amounts, so an estimator can
     tie the column by hand. "The total doesn't add up" is indefensible to a
     contractor, and a document nobody can check is not trusted.

     This overrules #15's accumulate-exact rule at the presentation boundary and
     nowhere else: the exact figure is computed alongside and carried in the
     provenance sidecar, and every internal total still accumulates exact. */
  const priced = rows.filter((row) => Number.isFinite(row.amount));
  const exact = priced.reduce((sum, row) => sum + row.amount, 0);
  const printed = priced.reduce((sum, row) => sum + roundMoney(row.amount), 0);
  const total = {
    currency: stamp.currency,
    exactAmount: exact,
    exactRounded: roundMoney(exact),
    amount: roundMoney(printed),
    pricedLines: priced.length,
    unpricedLines: rows.length - priced.length,
    complete: rows.length > 0 && priced.length === rows.length
  };
  return { boqVersionId, projectName, stamp, rows, total, catalogue };
}

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function stampRows(artefact) {
  const { stamp, total } = artefact;
  return [
    ['Bill of Quantities', artefact.projectName],
    ['BOQ version', artefact.boqVersionId],
    ['Approved by', stamp.approvedBy],
    ['Approved at', stamp.approvedAt],
    ['Ruleset version', stamp.rulesetVersion],
    ['Assumptions version', String(stamp.assumptionsVersion)],
    ['Rate book version', String(stamp.rateBookVersion)],
    ['Catalogue version', String(stamp.catalogueVersion)],
    ['Parser version', stamp.parserVersion],
    ['Input tiers', stamp.tiers.join(', ')],
    ['Currency', stamp.currency],
    ['Totals', total.complete
      ? `${total.amount} ${total.currency}`
      : `${total.amount} ${total.currency} — INCOMPLETE: ${total.unpricedLines} of ${total.pricedLines + total.unpricedLines} lines have no amount. This is not a whole-project total.`]
  ];
}

const HEADER = ['Item code', 'Description', 'Unit', 'Quantity', 'Rate', 'Amount', 'Tier', 'Basis of quantity', 'Status'];

/* Amounts are presented rounded; the total is still accumulated from the exact
   values and rounded once. A BOQ row must never show 60391.799999999996. */
function tableRows(artefact) {
  return artefact.rows.map((row) => [
    row.itemCode, row.description, row.unit,
    row.quantity === null ? '' : row.quantity,
    row.rate === null ? '' : roundMoney(row.rate),
    row.amount === null ? '' : roundMoney(row.amount),
    `${row.tier} — ${row.tierLabel}`,
    row.basis,
    row.amount === null ? `No amount (${row.pricingStatus})` : row.measurementStatus
  ]);
}

function encodeCsv(artefact) {
  const lines = [
    ...stampRows(artefact).map((row) => row.map(csvCell).join(',')),
    '',
    HEADER.map(csvCell).join(','),
    ...tableRows(artefact).map((row) => row.map(csvCell).join(','))
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/* Minimal XLSX: a zip of the few parts Excel requires. Written by hand rather
   than pulling a dependency, and deterministic -- fixed timestamps, so the same
   artefact zips to the same bytes. */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const sum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x2100, 12); // fixed date/time
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x2100, 14);
    entry.writeUInt32LE(sum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28); entry.writeUInt32LE(0, 42 - 6);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), centralBuffer, end]);
}

const xmlEscape = (value) => String(value ?? '').replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));

function sheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function encodeXlsx(artefact) {
  const rows = [...stampRows(artefact), [], HEADER, ...tableRows(artefact)];
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="BOQ" sheetId="1" r:id="rId1"/></sheets></workbook>', 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(rows), 'utf8') }
  ]);
}

/** Machine-readable trace: a delivered number back to its source objects,
    without needing the application. */
function encodeProvenance(artefact, snapshot) {
  return Buffer.from(`${JSON.stringify({
    boqVersionId: artefact.boqVersionId,
    projectName: artefact.projectName,
    stamp: artefact.stamp,
    total: artefact.total,
    lines: snapshot.lines.map((line) => ({
      itemCode: line.itemCode, description: line.description, measurement: line.measurement,
      unit: line.unit, quantity: line.quantity, rate: line.rate, amount: line.amount,
      measurementStatus: line.measurementStatus, pricingStatus: line.pricingStatus,
      rateSource: line.rateSource ?? null,
      contributions: line.provenance?.contributions ?? []
    })),
    sourceObjects: snapshot.sourceObjects
  }, null, 2)}\n`, 'utf8');
}

function encode(artefact, format, snapshot) {
  if (!FORMATS.includes(format)) throw new ExportError(`Unsupported export format "${format}". Supported: ${FORMATS.join(', ')}.`);
  return format === 'csv' ? encodeCsv(artefact) : encodeXlsx(artefact);
}

module.exports = { buildArtefact, encode, encodeCsv, encodeXlsx, encodeProvenance, tierOf, TIERS, FORMATS, ExportError };
