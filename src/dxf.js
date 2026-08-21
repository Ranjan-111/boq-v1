const { createSourceObject, createContribution, buildProvenance, measurementStatusFor, signedSum } = require('./provenance');
const { getRuleset, getRule, normalizeAssumptions, checkPlausibility, DEFAULT_RULESET_VERSION, DEFAULT_ASSUMPTIONS } = require('./rules');

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

/** Measure one normalized document under a named ruleset.

    Quantities are the signed sum of the contributions the rules produced, so a
    line always reconciles to its own evidence by construction rather than by a
    separate calculation that could drift from it. */
function measureDxf(sourceDocument, units, parsedDocument, {
  versions = DXF_VERSIONS, typicalMultiplier = 1, runId = null,
  rulesetVersion = DEFAULT_RULESET_VERSION, assumptions = DEFAULT_ASSUMPTIONS
} = {}) {
  const document = parsedDocument || parseDxf(sourceDocument.content);
  const ruleset = getRuleset(rulesetVersion);
  const resolvedAssumptions = normalizeAssumptions(assumptions);
  const toMetres = units.toMetres;
  const walls = [];
  const rooms = [];
  const byCategory = { door: [], window: [], furniture: [] };
  for (const entity of document.entities) {
    const category = layerCategory(entity.layer) || blockCategory(entity.block);
    if (entity.type === 'HATCH' && category === 'wall' && entity.points.length >= 3) walls.push(entity);
    if (entity.type === 'LWPOLYLINE' && category === 'room' && entity.points.length >= 3) rooms.push(entity);
    if (entity.type === 'INSERT' && category && byCategory[category]) byCategory[category].push(entity);
  }

  const sourceObjects = new Map();
  const objectByEntity = new Map();
  const register = (entity) => {
    if (objectByEntity.has(entity)) return objectByEntity.get(entity);
    /* A block reference carries only its insertion point. Expanding the block
       definition gives the real footprint, which is what a viewer needs to fit
       a selection -- and what sizes an opening. An undefined block keeps the
       point and says so, rather than inventing an extent. */
    const placed = entity.type === 'INSERT' ? placeBlockGeometry(document.blocks?.[entity.block], entity) : null;
    const geometry = placed || entity.points;
    const geometryResolution = entity.type !== 'INSERT' ? 'native' : placed ? 'block-definition' : 'insertion-point';
    const object = createSourceObject({
      sourceDocumentId: sourceDocument.id,
      sourceDocumentVersion: sourceDocument.version,
      buildingId: sourceDocument.buildingId ?? null,
      storeyId: sourceDocument.storeyId ?? null,
      sheetId: sourceDocument.sourceSheet || sourceDocument.filename || null,
      geometrySource: 'dxf-entity',
      coordinateSpace: 'dxf',
      geometry,
      geometryResolution,
      nativeHandle: entity.handle
    });
    sourceObjects.set(object.sourceObjectId, object);
    objectByEntity.set(entity, object);
    return object;
  };
  // openings are sized from resolved block geometry, so register them up front
  for (const entity of [...walls, ...rooms, ...byCategory.door, ...byCategory.window, ...byCategory.furniture]) register(entity);

  const context = {
    walls, rooms, doors: byCategory.door, windows: byCategory.window, furniture: byCategory.furniture,
    toMetres, typicalMultiplier, assumptions: resolvedAssumptions, settings: ruleset.settings,
    objectFor: (entity) => objectByEntity.get(entity),
    areaOf: (entity) => polygonArea(entity.points) * toMetres * toMetres * typicalMultiplier,
    perimeterOf: (entity) => polygonPerimeter(entity.points) * toMetres * typicalMultiplier
  };

  const consumed = new Set();
  const lines = ruleset.ruleIds.map((ruleId) => {
    const rule = getRule(ruleId);
    const contributions = rule.compute(context).map((intent) => {
      consumed.add(intent.entity);
      return createContribution({
      sourceObjectId: register(intent.entity).sourceObjectId,
      measurement: rule.measurement,
      sign: intent.sign,
      quantity: intent.quantity,
      unit: rule.unit,
      ruleId: rule.id,
      rulesetVersion: ruleset.version,
      runId,
      typicalMultiplier,
      ruleInputs: { assumptions: resolvedAssumptions, settings: ruleset.settings }
    });
    });
    return line(rule.measurement, rule.label, quantity(signedSum(contributions)), rule.unit, rule.evidence, contributions);
  });

  /* Geometry no rule could use is reported rather than dropped. A drawing whose
     furniture has been exploded to bare polylines, or whose layer names carry no
     meaning, still contains that geometry -- silently discarding it is how a BOQ
     ends up confidently short. */
  const unclassified = [];
  for (const entity of document.entities) {
    if (!['HATCH', 'LWPOLYLINE', 'INSERT'].includes(entity.type)) continue;
    if (consumed.has(entity)) continue;
    const category = layerCategory(entity.layer) || blockCategory(entity.block);
    const object = register(entity);
    unclassified.push({
      sourceObjectId: object.sourceObjectId,
      handle: entity.handle,
      type: entity.type,
      layer: entity.layer,
      block: entity.block || null,
      category: category || null,
      reason: category
        ? `Recognised as ${category} but no rule in ${ruleset.version} measures a ${entity.type} for it; it may be exploded or drawn as bare geometry.`
        : 'Neither the layer name nor a block name identifies what this is, so no rule could measure it.'
    });
  }

  return {
    versions: { ...versions, ruleset: ruleset.version },
    ruleset: ruleset.version,
    assumptions: resolvedAssumptions,
    sourceObjects: [...sourceObjects.values()],
    aggregation: { scope: 'source_document', scopeId: sourceDocument.id },
    unclassified,
    lines
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
  const blocks = {};
  let currentBlock = null;
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
      const header = groups.slice(index + 1, end);
      inspectBlock(header);
      currentBlock = readBlockHeader(header);
      if (currentBlock) blocks[currentBlock.name] = currentBlock;
      index = end;
      continue;
    }
    if (section === 'BLOCKS' && code === 0 && value === 'ENDBLK') {
      currentBlock = null;
      index += 1;
      continue;
    }
    if (section === 'BLOCKS' && code === 0 && currentBlock) {
      /* Block bodies are read leniently: their geometry only ever sets bounds,
         never a quantity, so an entity type the measurement rules do not accept
         must not fail the whole drawing. Unknown types simply contribute no
         points. */
      let end = index + 1;
      while (end < groups.length && groups[end][0] !== 0) end += 1;
      currentBlock.points.push(...readBlockGeometry(value, groups.slice(index + 1, end)));
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
  return { format: 'dxf', insunits, insunitsInvalid, entities, blocks };
}

function readBlockHeader(groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const name = group(2) || group(3);
  if (!name) return null;
  const baseX = Number(group(10));
  const baseY = Number(group(20));
  return { name, base: [Number.isFinite(baseX) ? baseX : 0, Number.isFinite(baseY) ? baseY : 0], points: [] };
}

/** Every 10/20 pair, plus a LINE's 11/21 endpoint. Deliberately tolerant. */
function readBlockGeometry(type, groups) {
  const points = [];
  let x = null;
  for (const [code, value] of groups) {
    if (code === 10) { const parsed = Number(value); x = Number.isFinite(parsed) ? parsed : null; }
    else if (code === 20 && x !== null) { const y = Number(value); if (Number.isFinite(y)) points.push([x, y]); x = null; }
  }
  if (type === 'LINE') {
    const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1];
    const endX = Number(group(11));
    const endY = Number(group(21));
    if (Number.isFinite(endX) && Number.isFinite(endY)) points.push([endX, endY]);
  }
  return points;
}

/* world = insertion + R(rotation) * S(scale) * (point - base) */
function placeBlockGeometry(block, insert) {
  if (!block || !block.points.length) return null;
  const [baseX, baseY] = block.base;
  const radians = (insert.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scaleX = Number.isFinite(insert.xScale) ? insert.xScale : 1;
  const scaleY = Number.isFinite(insert.yScale) ? insert.yScale : 1;
  const [originX, originY] = insert.points[0] || [0, 0];
  return block.points.map(([pointX, pointY]) => {
    const localX = (pointX - baseX) * scaleX;
    const localY = (pointY - baseY) * scaleY;
    return [originX + localX * cos - localY * sin, originY + localX * sin + localY * cos];
  });
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
  if (type === 'INSERT') {
    /* Insertion point (10/20) plus the placement transform: scale (41/42) and
       rotation (50). The block's own geometry is resolved separately, at
       measurement time, from the BLOCKS section. */
    const x = Number(group(10));
    const y = Number(group(20));
    if (Number.isFinite(x) && Number.isFinite(y) && group(10) !== '' && group(20) !== '') entity.points.push([x, y]);
    const xScale = Number(group(41));
    const yScale = Number(group(42));
    const rotation = Number(group(50));
    entity.xScale = group(41) !== '' && Number.isFinite(xScale) ? xScale : 1;
    entity.yScale = group(42) !== '' && Number.isFinite(yScale) ? yScale : 1;
    entity.rotation = group(50) !== '' && Number.isFinite(rotation) ? rotation : 0;
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
  if (['SOFA', 'BED', 'TABLE', 'WARDROBE', 'CHAIR', 'STOOL', 'DESK'].some((prefix) => name.startsWith(prefix))) return 'furniture';
  return null;
}
function polygonArea(points) { return Math.abs(points.reduce((area, point, index) => { const next = points[(index + 1) % points.length]; return area + point[0] * next[1] - next[0] * point[1]; }, 0) / 2); }
function polygonPerimeter(points) { return points.reduce((perimeter, point, index) => { const next = points[(index + 1) % points.length]; return perimeter + Math.hypot(next[0] - point[0], next[1] - point[1]); }, 0); }
function quantity(value) { return Number(value.toFixed(6)); }
function line(measurement, label, value, unit, evidence, contributions) {
  /* Deductions can, with the wrong assumptions, subtract more than the geometry
     holds. A negative area is not a small quantity -- it is a contradiction
     between the rules and the drawing, and letting it through would quietly
     reduce whatever total it rolls into. Report it as unmeasurable, keep the
     arithmetic that produced it, and never publish the negative number. */
  const impossible = value < 0
    ? { reason: 'Deductions exceed the measured geometry, so this cannot be a quantity. Check the opening assumptions against the drawing.', signedSum: value }
    : null;
  const quantity = impossible ? 0 : value;
  const plausibility = impossible ? null : checkPlausibility(measurement, contributions);
  return {
    measurement, label, quantity, unit,
    /* A magnitude we cannot believe is not presented as a confident number. */
    confidence: { level: plausibility ? 'LOW' : evidence.length === 2 ? 'HIGH' : 'MEDIUM', evidence },
    measurementStatus: impossible ? 'not_measurable' : measurementStatusFor(quantity, contributions),
    provenance: buildProvenance({
      contributions,
      quantity,
      measurementStatus: impossible ? 'not_measurable' : undefined,
      ...(impossible ? { impossible } : {}),
      ...(plausibility ? { plausibility } : {})
    })
  };
}
function sourceInputError(sourceDocument, detail) { return new InputError(`${detail} Affected source: ${sourceDocument.filename} (${sourceDocument.id}, v${sourceDocument.version}).`); }
function externalReferenceError(reference) { return new InputError(`The DXF contains a missing external reference${reference ? ` (${reference})` : ''}; re-export the affected drawing with external references bound or embedded.`); }
function malformedEntityError(type, handle, detail = '') { return new InputError(`Malformed ${type} entity ${handle || '(unknown handle)'}${detail ? `; ${detail}` : ''}; re-export the affected drawing as a native DXF.`); }
function unsupportedEntityError(type) { return new InputError(`Unsupported or unvalidated ${type} entity; use a native DXF re-export or simplify the drawing before processing.`); }
class InputError extends Error {}

module.exports = { DXF_VERSIONS, UNIT_DEFINITIONS, inspectDxf, measureDxf, parseDxf, resolveUnits, layerCategory, blockCategory, placeBlockGeometry, InputError };
