const { createHash } = require('node:crypto');

const VERSIONS = Object.freeze({ parser: 'dxf-v1', ruleset: 'clean-plan-v1', unitResolution: 'unit-resolution-v1' });
const UNIT_DEFINITIONS = Object.freeze({
  4: Object.freeze({ code: 4, name: 'millimetres', symbol: 'mm', toMetres: 0.001 }),
  5: Object.freeze({ code: 5, name: 'centimetres', symbol: 'cm', toMetres: 0.01 }),
  6: Object.freeze({ code: 6, name: 'metres', symbol: 'm', toMetres: 1 })
});
const EXTERNAL_REFERENCE_ENTITY_TYPES = Object.freeze(['XREF', 'IMAGE', 'PDFUNDERLAY', 'DGNUNDERLAY']);
const EXTERNAL_REFERENCE_BLOCK_FLAGS = 4 | 8;
const VALIDATED_ENTITY_TYPES = Object.freeze(['HATCH', 'LWPOLYLINE', 'INSERT', 'LINE']);
const PROCESSING_STAGE_DELAY_MS = 150;

function createApplication({ schedule = setTimeout } = {}) {
  const sourceDocuments = new Map();
  const runs = new Map();
  let sourceSequence = 0;
  let runSequence = 0;

  function createSourceDocument({ filename, content, fallbackUnit }) {
    if (isDwg(filename, content)) {
      throw new InputError('DWG files are refused. Use a native DXF export from the authoring CAD application; no automatic conversion is performed.');
    }
    if (!/\.dxf$/i.test(filename || '')) throw new InputError('Only DXF files can be submitted.');

    const explicitUnit = normalizeUnit(fallbackUnit);
    if (fallbackUnit !== undefined && fallbackUnit !== null && fallbackUnit !== '' && !explicitUnit) {
      throw new InputError('Choose a supported fallback unit: millimetres, centimetres, or metres.');
    }

    const sourceDocument = {
      id: `src_${String(++sourceSequence).padStart(4, '0')}`,
      filename,
      version: 1,
      content,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      fallbackUnit: explicitUnit
    };
    sourceDocuments.set(sourceDocument.id, sourceDocument);
    return presentSourceDocument(sourceDocument);
  }

  function startProcessing(sourceDocumentId) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');

    const run = {
      id: `run_${String(++runSequence).padStart(4, '0')}`,
      sourceDocumentId,
      versions: VERSIONS,
      status: 'ingestion',
      stages: stageState('ingestion', 'running'),
      units: null,
      boq: null,
      error: null
    };
    runs.set(run.id, run);
    schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
    return presentRun(run, sourceDocument);
  }

  function advance(run) {
    if (run.status === 'ingestion') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        const inspection = inspectDxf(document);
        run.parsedDocument = inspection.document;
        run.units = inspection.units;
        completeStage(run, 'ingestion');
        run.status = 'measurement';
        setStage(run, 'measurement', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error, 'ingestion');
      }
      return;
    }

    if (run.status === 'measurement') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        run.boq = measureCleanDxf(document, run.units, run.parsedDocument);
        completeStage(run, 'measurement');
        run.status = 'boq';
        setStage(run, 'boq', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error, 'measurement');
      }
      return;
    }

    if (run.status === 'boq') {
      completeStage(run, 'boq');
      run.status = 'completed';
    }
  }

  function getRun(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return presentRun(run, sourceDocuments.get(run.sourceDocumentId));
  }

  function reprocess(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return startProcessing(run.sourceDocumentId);
  }

  return { createSourceDocument, startProcessing, getRun, reprocess };
}

function stageState(name, status) {
  return ['ingestion', 'measurement', 'boq'].map((stage) => ({
    name: stage,
    status: stage === name ? status : 'pending'
  }));
}

function setStage(run, name, status) {
  run.stages.find((stage) => stage.name === name).status = status;
}

function completeStage(run, name) {
  setStage(run, name, 'completed');
}

function failRun(run, error, stageName) {
  run.status = 'failed';
  run.error = error.message;
  setStage(run, stageName, 'failed');
}

function presentSourceDocument(sourceDocument) {
  return {
    id: sourceDocument.id,
    filename: sourceDocument.filename,
    version: sourceDocument.version,
    contentSha256: sourceDocument.contentSha256,
    fallbackUnit: sourceDocument.fallbackUnit ? sourceDocument.fallbackUnit.name : null
  };
}

function presentRun(run, sourceDocument) {
  return {
    id: run.id,
    status: run.status,
    sourceDocument: presentSourceDocument(sourceDocument),
    versions: run.versions,
    units: run.units,
    stages: run.stages,
    boq: run.boq,
    error: run.error
  };
}

function measureCleanDxf(sourceDocument, units, parsedDocument = parseDxf(sourceDocument.content)) {
  const document = parsedDocument;
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
    if (entity.type === 'INSERT' && category && handlesByCategory[category]) {
      handlesByCategory[category].push(entity.handle);
    }
  }

  const wallPlan = quantity(wallArea * toMetres * toMetres);
  const floor = quantity(floorArea * toMetres * toMetres);
  const wallHeight = 3;
  const wallThickness = 0.23;
  const wallCentreLength = wallPlan / wallThickness;
  const source = { sourceDocumentId: sourceDocument.id, sourceDocumentVersion: sourceDocument.version };

  return {
    lines: [
      line('wall_plan', 'Wall footprint (plan)', wallPlan, 'm²', wallHandles, ['layer', 'hatch'], source),
      line('wall_masonry', 'Wall masonry volume', quantity(wallPlan * wallHeight), 'm³', wallHandles, ['layer', 'hatch'], source),
      line('wall_plaster', 'Wall plaster (both faces)', quantity(wallCentreLength * 2 * wallHeight), 'm²', wallHandles, ['layer', 'hatch'], source),
      line('floor_area', 'Floor finish area', floor, 'm²', roomHandles, ['layer', 'geometry'], source),
      line('skirting', 'Skirting length', quantity(roomPerimeter * toMetres), 'm', roomHandles, ['layer', 'geometry'], source),
      line('room_count', 'Room count', roomHandles.length, 'nos', roomHandles, ['layer', 'geometry'], source),
      line('door_count', 'Doors', handlesByCategory.door.length, 'nos', handlesByCategory.door, ['layer', 'block'], source),
      line('window_count', 'Windows', handlesByCategory.window.length, 'nos', handlesByCategory.window, ['layer', 'block'], source),
      line('furniture_count', 'Furniture items', handlesByCategory.furniture.length, 'nos', handlesByCategory.furniture, ['layer', 'block'], source)
    ]
  };
}

function inspectDxf(sourceDocument) {
  let document;
  try {
    document = parseDxf(sourceDocument.content);
  } catch (error) {
    throw sourceInputError(sourceDocument, error.message);
  }

  const units = resolveUnits(document, sourceDocument);
  return { document, units };
}

function resolveUnits(document, sourceDocument) {
  const declared = UNIT_DEFINITIONS[document.insunits];
  if (declared) {
    return {
      ...declared,
      source: 'dxf-header',
      evidence: '$INSUNITS',
      version: VERSIONS.unitResolution,
      recorded: true,
      audit: {
        sourceDocumentId: sourceDocument.id,
        sourceDocumentVersion: sourceDocument.version,
        decision: 'Unit read from the DXF $INSUNITS header.'
      }
    };
  }

  if (sourceDocument.fallbackUnit) {
    const fallback = sourceDocument.fallbackUnit;
    return {
      ...fallback,
      source: 'operator-assumption',
      evidence: 'explicit fallback selected at upload',
      version: VERSIONS.unitResolution,
      recorded: true,
      audit: {
        sourceDocumentId: sourceDocument.id,
        sourceDocumentVersion: sourceDocument.version,
        decision: `Operator explicitly selected ${fallback.name} as the fallback drawing unit.`
      }
    };
  }

  const detail = document.insunitsInvalid !== null
    ? `The DXF $INSUNITS value must be a complete integer; it contains "${document.insunitsInvalid}".`
    : document.insunits === null
      ? 'The DXF has no $INSUNITS declaration.'
      : `The DXF declares unsupported $INSUNITS code ${document.insunits}.`;
  throw sourceInputError(sourceDocument, `We cannot tell which drawing unit was used. ${detail} Select an explicit fallback unit or re-export the DXF with a supported $INSUNITS declaration.`);
}

function normalizeUnit(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  const aliases = {
    '4': 4, mm: 4, millimetre: 4, millimetres: 4, millimeter: 4, millimeters: 4,
    '5': 5, cm: 5, centimetre: 5, centimetres: 5, centimeter: 5, centimeters: 5,
    '6': 6, m: 6, metre: 6, metres: 6, meter: 6, meters: 6
  };
  const code = aliases[normalized];
  return code ? UNIT_DEFINITIONS[code] : null;
}

function sourceInputError(sourceDocument, detail) {
  return new InputError(`${detail} Affected source: ${sourceDocument.filename} (${sourceDocument.id}, v${sourceDocument.version}).`);
}

function externalReferenceError(reference) {
  const detail = reference ? ` (${reference})` : '';
  return new InputError(`The DXF contains a missing external reference${detail}; re-export the affected drawing with external references bound or embedded.`);
}

function malformedEntityError(type, handle, detail = '') {
  const suffix = detail ? `; ${detail}` : '';
  return new InputError(`Malformed ${type} entity ${handle || '(unknown handle)'}${suffix}; re-export the affected drawing as a native DXF.`);
}

function unsupportedEntityError(type) {
  return new InputError(`Unsupported or unvalidated ${type} entity; use a native DXF re-export or simplify the drawing before processing.`);
}

function isDwg(filename, content) {
  if (/\.dwg$/i.test(filename || '')) return true;
  return /^AC10\d{2}/.test(String(content || '').slice(0, 6));
}

function line(measurement, label, value, unit, sourceHandles, evidence, source) {
  return {
    measurement,
    label,
    quantity: value,
    unit,
    confidence: { level: evidence.length === 2 ? 'HIGH' : 'MEDIUM', evidence },
    measurementStatus: value > 0 ? 'measured' : (sourceHandles.length ? 'measured_zero' : 'not_measurable'),
    provenance: { ...source, sourceHandles }
  };
}

function parseDxf(content) {
  const groups = [];
  const lines = String(content).split(/\r\n|\r|\n/);
  while (lines.at(-1) === '') lines.pop();
  if (lines.length % 2 !== 0) throw new InputError('Malformed DXF group structure; re-export the affected drawing as a native DXF.');
  for (let index = 0; index + 1 < lines.length; index += 2) {
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
    if (code === 0 && EXTERNAL_REFERENCE_ENTITY_TYPES.includes(value)) {
      throw externalReferenceError(value);
    }
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
      if (rawUnit === null || !/^[+-]?\d+$/.test(rawUnit)) {
        insunits = null;
        insunitsInvalid = rawUnit === null ? '(missing value)' : rawUnit;
      } else {
        insunits = Number.parseInt(rawUnit, 10);
        insunitsInvalid = null;
      }
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
  if (!sawHeader || !insunitsPresent) {
    insunits = null;
    insunitsInvalid = null;
  }
  return { insunits, insunitsInvalid, entities };
}

function inspectBlock(groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const name = group(2) || group(3) || '(unnamed block)';
  const rawFlags = group(70);
  const flags = Number(rawFlags);
  if (Number.isInteger(flags) && (flags & EXTERNAL_REFERENCE_BLOCK_FLAGS)) {
    throw externalReferenceError(`block ${name}, flags ${flags}`);
  }
}

function readEntity(type, groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const entity = { type, handle: group(5), layer: group(8), block: group(2), points: [] };
  if (EXTERNAL_REFERENCE_ENTITY_TYPES.includes(type)) {
    throw externalReferenceError(type);
  }
  if (!VALIDATED_ENTITY_TYPES.includes(type)) {
    throw unsupportedEntityError(type);
  }
  for (const [code, value] of groups) {
    if (code >= 10 && code <= 59 && value !== '' && !Number.isFinite(Number(value))) {
      throw malformedEntityError(type, entity.handle);
    }
  }
  if (type === 'LINE') {
    const requiredCoordinates = [10, 20, 11, 21];
    if (!entity.handle || !entity.layer || requiredCoordinates.some((code) => {
      const value = group(code);
      return value === '' || !Number.isFinite(Number(value));
    })) {
      throw malformedEntityError(type, entity.handle, 'complete finite start/end coordinates, handle, and layer are required');
    }
  }
  if (type === 'LWPOLYLINE' || type === 'HATCH') {
    let x = null;
    for (const [code, value] of groups) {
      if (code === 10) {
        if (x !== null) throw malformedEntityError(type, entity.handle);
        x = Number(value);
        if (!Number.isFinite(x)) throw malformedEntityError(type, entity.handle);
      }
      if (code === 20) {
        const y = Number(value);
        if (x === null || !Number.isFinite(y)) throw malformedEntityError(type, entity.handle);
        entity.points.push([x, y]);
        x = null;
      }
    }
    if (x !== null || entity.points.length < 3) throw malformedEntityError(type, entity.handle);
  }
  if (['HATCH', 'LWPOLYLINE', 'INSERT'].includes(type) && (!entity.handle || !entity.layer)) {
    throw malformedEntityError(type, entity.handle);
  }
  if (type === 'INSERT' && !entity.block) {
    throw malformedEntityError(type, entity.handle, 'its block reference is missing');
  }
  if (type === 'INSERT' && /XREF|EXTERNAL|REFERENCE/i.test(entity.block)) {
    throw externalReferenceError(entity.block);
  }
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

function polygonArea(points) {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

function polygonPerimeter(points) {
  return points.reduce((perimeter, point, index) => {
    const next = points[(index + 1) % points.length];
    return perimeter + Math.hypot(next[0] - point[0], next[1] - point[1]);
  }, 0);
}

function quantity(value) {
  return Number(value.toFixed(6));
}

class InputError extends Error {}
class NotFoundError extends Error {}

module.exports = { createApplication, InputError, NotFoundError };
