const EXTERNAL_REFERENCE_ENTITY_TYPES = Object.freeze(['XREF', 'IMAGE', 'PDFUNDERLAY', 'DGNUNDERLAY']);
const EXTERNAL_REFERENCE_BLOCK_FLAGS = 4 | 8;
const VALIDATED_ENTITY_TYPES = Object.freeze(['HATCH', 'LWPOLYLINE', 'INSERT', 'LINE']);
const UNIT_DEFINITIONS = Object.freeze({
  4: Object.freeze({ code: 4, name: 'millimetres', symbol: 'mm', toMetres: 0.001 }),
  5: Object.freeze({ code: 5, name: 'centimetres', symbol: 'cm', toMetres: 0.01 }),
  6: Object.freeze({ code: 6, name: 'metres', symbol: 'm', toMetres: 1 })
});
const DXF_VERSIONS = Object.freeze({ parser: 'dxf-v1', ruleset: 'clean-plan-v1', unitResolution: 'unit-resolution-v1' });

/**
 * Stable normalized-document interface used by the application and future
 * PDF/raster adapters. It deliberately exposes no parser-specific groups.
 */
function inspectDxf(sourceDocument, { versions = DXF_VERSIONS } = {}) {
  let document;
  try {
    document = parseDxf(sourceDocument.content);
  } catch (error) {
    throw sourceInputError(sourceDocument, error.message);
  }
  return { document, units: resolveUnits(document, sourceDocument, versions.unitResolution), versions };
}

/** Measure one normalized document; all source handles remain attached. */
function measureDxf(sourceDocument, units, parsedDocument, { versions = DXF_VERSIONS, typicalMultiplier = 1 } = {}) {
  const document = parsedDocument || parseDxf(sourceDocument.content);
  const toMetres = units.toMetres;
  const wallHandles = [];
  const roomHandles = [];
  const handlesByCategory = { door: [], window: [], furniture: [] };
  let wallArea = 0;
  let floorArea = 0;
  let roomPerimeter = 0;
  for (const entity of document.entities) {
    const category = layerCategory(entity.layer) || blockCategory(entity.block);
    if (entity.type === 'HATCH' && category === 'wall' && entity.points.length >= 3) {
      wallArea += polygonArea(entity.points);
      wallHandles.push(entity.handle);
    }
    if (entity.type === 'LWPOLYLINE' && category === 'room' && entity.points.length >= 3) {
      floorArea += polygonArea(entity.points);
      roomPerimeter += polygonPerimeter(entity.points);
      roomHandles.push(entity.handle);
    }
    if (entity.type === 'INSERT' && category && handlesByCategory[category]) handlesByCategory[category].push(entity.handle);
  }
  const wallPlan = quantity(wallArea * toMetres * toMetres * typicalMultiplier);
  const floor = quantity(floorArea * toMetres * toMetres * typicalMultiplier);
  const wallHeight = 3;
  const wallThickness = 0.23;
  const wallCentreLength = wallPlan / wallThickness;
  const source = {
    sourceDocumentId: sourceDocument.id,
    sourceDocumentVersion: sourceDocument.version,
    sourceSheet: sourceDocument.sourceSheet || sourceDocument.filename,
    typicalMultiplier
  };
  return {
    versions,
    ruleset: versions.ruleset,
    lines: [
      line('wall_plan', 'Wall footprint (plan)', wallPlan, 'm²', wallHandles, ['layer', 'hatch'], source),
      line('wall_masonry', 'Wall masonry volume', quantity(wallPlan * wallHeight), 'm³', wallHandles, ['layer', 'hatch'], source),
      line('wall_plaster', 'Wall plaster (both faces)', quantity(wallCentreLength * 2 * wallHeight), 'm²', wallHandles, ['layer', 'hatch'], source),
      line('floor_area', 'Floor finish area', floor, 'm²', roomHandles, ['layer', 'geometry'], source),
      line('skirting', 'Skirting length', quantity(roomPerimeter * toMetres * typicalMultiplier), 'm', roomHandles, ['layer', 'geometry'], source),
      line('room_count', 'Room count', roomHandles.length * typicalMultiplier, 'nos', roomHandles, ['layer', 'geometry'], source),
      line('door_count', 'Doors', handlesByCategory.door.length * typicalMultiplier, 'nos', handlesByCategory.door, ['layer', 'block'], source),
      line('window_count', 'Windows', handlesByCategory.window.length * typicalMultiplier, 'nos', handlesByCategory.window, ['layer', 'block'], source),
      line('furniture_count', 'Furniture items', handlesByCategory.furniture.length * typicalMultiplier, 'nos', handlesByCategory.furniture, ['layer', 'block'], source)
    ]
  };
}

function resolveUnits(document, sourceDocument, version = 'unit-resolution-v1') {
  const declared = UNIT_DEFINITIONS[document.insunits];
  if (declared) return unitDecision(declared, 'dxf-header', '$INSUNITS', version, sourceDocument, 'Unit read from the DXF $INSUNITS header.');
  if (sourceDocument.fallbackUnit) {
    const fallback = sourceDocument.fallbackUnit;
    return unitDecision(fallback, 'operator-assumption', 'explicit fallback selected at upload', version, sourceDocument, `Operator explicitly selected ${fallback.name} as the fallback drawing unit.`);
  }
  const detail = document.insunitsInvalid !== null
    ? `The DXF $INSUNITS value must be a complete integer; it contains "${document.insunitsInvalid}".`
    : document.insunits === null
      ? 'The DXF has no $INSUNITS declaration.'
      : `The DXF declares unsupported $INSUNITS code ${document.insunits}.`;
  throw sourceInputError(sourceDocument, `We cannot tell which drawing unit was used. ${detail} Select an explicit fallback unit or re-export the DXF with a supported $INSUNITS declaration.`);
}

function unitDecision(unit, source, evidence, version, sourceDocument, decision) {
  return { ...unit, source, evidence, version, recorded: true, audit: {
    sourceDocumentId: sourceDocument.id, sourceDocumentVersion: sourceDocument.version, decision
  }};
}

function parseDxf(content) {
  const groups = [];
  const lines = String(content).split(/\r\n|\r|\n/);
  while (lines.at(-1) === '') lines.pop();
  if (lines.length % 2 !== 0) throw new InputError('Malformed DXF group structure; re-export the affected drawing as a native DXF.');
  for (let index = 0; index < lines.length; index += 2) {
    const rawCode = lines[index].trim();
    if (!/^[+-]?\d+$/.test(rawCode)) throw new InputError(`Malformed DXF group code "${rawCode}"; re-export the affected drawing as a native DXF.`);
    groups.push([Number.parseInt(rawCode, 10), lines[index + 1].trim()]);
  }
  let insunits = null;
  let insunitsInvalid = null;
  let insunitsPresent = false;
  const entities = [];
  let section = null;
  let sawHeader = false;
  let sawEntities = false;
  let sawEndsec = false;
  for (let index = 0; index < groups.length;) {
    const [code, value] = groups[index];
    if (code === 0 && EXTERNAL_REFERENCE_ENTITY_TYPES.includes(value)) throw externalReferenceError(value);
    if (code === 0 && value === 'SECTION') {
      if (section) throw new InputError('Malformed DXF sections: a SECTION started before the previous section ended; re-export the affected drawing as a native DXF.');
      section = groups[index + 1]?.[1] || null;
      if (section === 'HEADER') sawHeader = true;
      if (section === 'ENTITIES') sawEntities = true;
      index += 2;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      if (!section) throw new InputError('Malformed DXF section boundary; re-export the affected drawing as a native DXF.');
      sawEndsec = true;
      section = null;
      index += 1;
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS') {
      insunitsPresent = true;
      const unit = groups[index + 1]?.[0] === 70 ? groups[index + 1] : null;
      const rawUnit = unit?.[1] ?? null;
      if (rawUnit === null || !/^[+-]?\d+$/.test(rawUnit)) { insunits = null; insunitsInvalid = rawUnit === null ? '(missing value)' : rawUnit; }
      else { insunits = Number.parseInt(rawUnit, 10); insunitsInvalid = null; }
    }
    if (section === 'BLOCKS' && code === 0 && value === 'BLOCK') {
      let end = index + 1;
      while (end < groups.length && groups[end][0] !== 0) end += 1;
      inspectBlock(groups.slice(index + 1, end));
      index = end;
      continue;
    }
    if (section === 'ENTITIES' && code === 0) {
      let end = index + 1;
      while (end < groups.length && groups[end][0] !== 0) end += 1;
      const entity = readEntity(value, groups.slice(index + 1, end));
      if (entity) entities.push(entity);
      index = end;
      continue;
    }
    index += 1;
  }
  if (section || !sawEntities || !sawEndsec) throw new InputError('Malformed DXF sections; re-export the affected drawing as a native DXF.');
  if (!sawHeader || !insunitsPresent) { insunits = null; insunitsInvalid = null; }
  return { format: 'dxf', insunits, insunitsInvalid, entities };
}

function inspectBlock(groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const name = group(2) || group(3) || '(unnamed block)';
  const flags = Number(group(70));
  if (Number.isInteger(flags) && (flags & EXTERNAL_REFERENCE_BLOCK_FLAGS)) throw externalReferenceError(`block ${name}, flags ${flags}`);
}

function readEntity(type, groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const entity = { type, handle: group(5), layer: group(8), block: group(2), points: [] };
  if (EXTERNAL_REFERENCE_ENTITY_TYPES.includes(type)) throw externalReferenceError(type);
  if (!VALIDATED_ENTITY_TYPES.includes(type)) throw unsupportedEntityError(type);
  for (const [code, value] of groups) if (code >= 10 && code <= 59 && value !== '' && !Number.isFinite(Number(value))) throw malformedEntityError(type, entity.handle);
  if (type === 'LINE') {
    const requiredCoordinates = [10, 20, 11, 21];
    if (!entity.handle || !entity.layer || requiredCoordinates.some((code) => { const value = group(code); return value === '' || !Number.isFinite(Number(value)); })) throw malformedEntityError(type, entity.handle, 'complete finite start/end coordinates, handle, and layer are required');
  }
  if (type === 'LWPOLYLINE' || type === 'HATCH') {
    let x = null;
    for (const [code, value] of groups) {
      if (code === 10) { if (x !== null) throw malformedEntityError(type, entity.handle); x = Number(value); if (!Number.isFinite(x)) throw malformedEntityError(type, entity.handle); }
      if (code === 20) { const y = Number(value); if (x === null || !Number.isFinite(y)) throw malformedEntityError(type, entity.handle); entity.points.push([x, y]); x = null; }
    }
    if (x !== null || entity.points.length < 3) throw malformedEntityError(type, entity.handle);
  }
  if (['HATCH', 'LWPOLYLINE', 'INSERT'].includes(type) && (!entity.handle || !entity.layer)) throw malformedEntityError(type, entity.handle);
  if (type === 'INSERT' && !entity.block) throw malformedEntityError(type, entity.handle, 'its block reference is missing');
  if (type === 'INSERT' && /XREF|EXTERNAL|REFERENCE/i.test(entity.block)) throw externalReferenceError(entity.block);
  return ['HATCH', 'LWPOLYLINE', 'INSERT'].includes(type) ? entity : null;
}

function layerCategory(layer = '') {
  const name = layer.toUpperCase();
  if (name.includes('WALL')) return 'wall';
  if (name.includes('ROOM')) return 'room';
  if (name.includes('DOOR')) return 'door';
  if (name.includes('GLAZ') || name.includes('WIN')) return 'window';
  if (name.includes('FURN')) return 'furniture';
  return null;
}
function blockCategory(block = '') {
  const name = block.toUpperCase();
  if (name.startsWith('DOOR')) return 'door';
  if (name.startsWith('WIN')) return 'window';
  if (['SOFA', 'BED', 'TABLE', 'WARDROBE', 'CHAIR', 'DESK'].some((prefix) => name.startsWith(prefix))) return 'furniture';
  return null;
}
function polygonArea(points) { return Math.abs(points.reduce((area, point, index) => { const next = points[(index + 1) % points.length]; return area + point[0] * next[1] - next[0] * point[1]; }, 0) / 2); }
function polygonPerimeter(points) { return points.reduce((perimeter, point, index) => { const next = points[(index + 1) % points.length]; return perimeter + Math.hypot(next[0] - point[0], next[1] - point[1]); }, 0); }
function quantity(value) { return Number(value.toFixed(6)); }
function line(measurement, label, value, unit, sourceHandles, evidence, source) {
  return { measurement, label, quantity: value, unit, confidence: { level: evidence.length === 2 ? 'HIGH' : 'MEDIUM', evidence }, measurementStatus: value > 0 ? 'measured' : (sourceHandles.length ? 'measured_zero' : 'not_measurable'), provenance: { ...source, sourceHandles } };
}
function sourceInputError(sourceDocument, detail) { return new InputError(`${detail} Affected source: ${sourceDocument.filename} (${sourceDocument.id}, v${sourceDocument.version}).`); }
function externalReferenceError(reference) { return new InputError(`The DXF contains a missing external reference${reference ? ` (${reference})` : ''}; re-export the affected drawing with external references bound or embedded.`); }
function malformedEntityError(type, handle, detail = '') { return new InputError(`Malformed ${type} entity ${handle || '(unknown handle)'}${detail ? `; ${detail}` : ''}; re-export the affected drawing as a native DXF.`); }
function unsupportedEntityError(type) { return new InputError(`Unsupported or unvalidated ${type} entity; use a native DXF re-export or simplify the drawing before processing.`); }
class InputError extends Error {}

module.exports = { DXF_VERSIONS, UNIT_DEFINITIONS, inspectDxf, measureDxf, parseDxf, resolveUnits, InputError };
