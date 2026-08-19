const { createHash } = require('node:crypto');

const VERSIONS = Object.freeze({ parser: 'dxf-v1', ruleset: 'clean-plan-v1' });
const UNIT_NAME = Object.freeze({ 1: 'inches', 2: 'feet', 4: 'millimetres', 5: 'centimetres', 6: 'metres' });
const UNIT_TO_METRES = Object.freeze({ 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 });
const PROCESSING_STAGE_DELAY_MS = 150;

function createApplication({ schedule = setTimeout } = {}) {
  const sourceDocuments = new Map();
  const runs = new Map();
  let sourceSequence = 0;
  let runSequence = 0;

  function createSourceDocument({ filename, content }) {
    if (!/\.dxf$/i.test(filename || '')) throw new InputError('Only DXF files can be submitted.');

    const sourceDocument = {
      id: `src_${String(++sourceSequence).padStart(4, '0')}`,
      filename,
      version: 1,
      content,
      contentSha256: createHash('sha256').update(content).digest('hex')
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
      boq: null,
      diagnostics: { scaleGate: null, flags: [], unresolvedLayers: [], exploded: { n: 0, handles: [] }, assumptions: [] },
      error: null
    };
    runs.set(run.id, run);
    schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
    return presentRun(run, sourceDocument);
  }

  function advance(run) {
    if (run.status === 'ingestion') {
      completeStage(run, 'ingestion');
      run.status = 'measurement';
      setStage(run, 'measurement', 'running');
      schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      return;
    }

    if (run.status === 'measurement') {
      try {
        const document = sourceDocuments.get(run.sourceDocumentId);
        const measured = measureCleanDxf(document);
        run.boq = { lines: measured.lines };
        run.diagnostics = measured.diagnostics;
        completeStage(run, 'measurement');
        run.status = 'boq';
        setStage(run, 'boq', 'running');
        schedule(() => advance(run), PROCESSING_STAGE_DELAY_MS);
      } catch (error) {
        failRun(run, error);
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

  function getSourceDocument(sourceDocumentId) {
    const sourceDocument = sourceDocuments.get(sourceDocumentId);
    if (!sourceDocument) throw new NotFoundError('Source document not found.');
    const document = parseDxf(sourceDocument.content);
    return {
      ...presentSourceDocument(sourceDocument),
      objects: document.entities.map((entity) => ({
        handle: entity.handle,
        type: entity.type,
        layer: entity.layer,
        ...(entity.block ? { block: entity.block } : {})
      }))
    };
  }

  function exportRun(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    const requiredMeasurements = new Set(['wall_plan', 'floor_area', 'room_count']);
    const blockedLines = run.boq?.lines.filter((line) => requiredMeasurements.has(line.measurement) && line.measurementStatus !== 'measured') || [];
    const flags = run.diagnostics?.flags || [];
    if (run.status !== 'completed' || blockedLines.length || flags.some((flag) => flag.severity === 'BLOCK')) {
      throw new ExportBlockedError('Export blocked until every required measurement is resolved.', {
        blockedLines,
        flags
      });
    }
    return {
      exportable: true,
      runId: run.id,
      sourceDocument: presentSourceDocument(sourceDocuments.get(run.sourceDocumentId)),
      lines: run.boq.lines
    };
  }

  function reprocess(runId) {
    const run = runs.get(runId);
    if (!run) throw new NotFoundError('Processing run not found.');
    return startProcessing(run.sourceDocumentId);
  }

  return { createSourceDocument, startProcessing, getRun, getSourceDocument, exportRun, reprocess };
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

function failRun(run, error) {
  run.status = 'failed';
  run.error = error.message;
  setStage(run, 'measurement', 'failed');
  if (error.scaleGate) run.diagnostics.scaleGate = error.scaleGate;
}

function presentSourceDocument(sourceDocument) {
  return {
    id: sourceDocument.id,
    filename: sourceDocument.filename,
    version: sourceDocument.version,
    contentSha256: sourceDocument.contentSha256
  };
}

function presentRun(run, sourceDocument) {
  return {
    id: run.id,
    status: run.status,
    sourceDocument: presentSourceDocument(sourceDocument),
    versions: run.versions,
    stages: run.stages,
    boq: run.boq,
    diagnostics: run.diagnostics,
    error: run.error
  };
}

function measureCleanDxf(sourceDocument) {
  const document = parseDxf(sourceDocument.content);
  const scaleGate = getScaleGate(document);
  if (!scaleGate.ok) {
    const error = new InputError(scaleGate.reason);
    error.scaleGate = scaleGate;
    throw error;
  }
  const toMetres = scaleGate.toM;

  const wallHandles = [];
  const roomHandles = [];
  const handlesByCategory = { door: [], window: [], furniture: [] };
  let wallArea = 0;
  let floorArea = 0;
  let roomPerimeter = 0;

  for (const entity of document.entities) {
    const category = entity.type === 'INSERT'
      ? (blockCategory(entity.block) || layerCategory(entity.layer))
      : layerCategory(entity.layer);
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

  const lines = [
    line('wall_plan', 'Wall footprint (plan)', wallPlan, 'm²', wallHandles, wallHandles.length ? ['layer', 'hatch'] : [], source),
    line('wall_masonry', 'Wall masonry volume', quantity(wallPlan * wallHeight), 'm³', wallHandles, wallHandles.length ? ['layer', 'hatch'] : [], source),
    line('wall_plaster', 'Wall plaster (both faces)', quantity(wallCentreLength * 2 * wallHeight), 'm²', wallHandles, wallHandles.length ? ['layer', 'hatch'] : [], source),
    line('floor_area', 'Floor finish area', floor, 'm²', roomHandles, roomHandles.length ? ['layer', 'geometry'] : [], source),
    line('skirting', 'Skirting length', quantity(roomPerimeter * toMetres), 'm', roomHandles, roomHandles.length ? ['layer', 'geometry'] : [], source),
    line('room_count', 'Room count', roomHandles.length, 'nos', roomHandles, roomHandles.length ? ['layer', 'geometry'] : [], source),
    line('door_count', 'Doors', handlesByCategory.door.length, 'nos', handlesByCategory.door, handlesByCategory.door.length ? ['layer', 'block'] : [], source),
    line('window_count', 'Windows', handlesByCategory.window.length, 'nos', handlesByCategory.window, handlesByCategory.window.length ? ['layer', 'block'] : [], source),
    line('furniture_count', 'Furniture items', handlesByCategory.furniture.length, 'nos', handlesByCategory.furniture, handlesByCategory.furniture.length ? ['layer', 'block'] : [], source)
  ];

  const unresolvedLayers = document.layers.filter((layer) => !layerCategory(layer) && layer.toUpperCase() !== '0' && layer.toUpperCase() !== 'DEFPOINTS');
  const explodedHandles = document.entities
    .filter((entity) => layerCategory(entity.layer) === 'furniture' && entity.type === 'LWPOLYLINE')
    .map((entity) => entity.handle);
  const flags = [];
  for (const required of ['wall_plan', 'floor_area', 'room_count']) {
    const measured = lines.find((lineItem) => lineItem.measurement === required);
    if (measured.measurementStatus !== 'measured') {
      flags.push({ severity: 'BLOCK', message: `${measured.label} returned ${measured.quantity}; not measured.`, code: 'required_not_measurable' });
    }
  }
  if (!wallHandles.length) flags.push({ severity: 'BLOCK', message: 'No wall hatch found; wall area cannot be measured.', code: 'missing_wall_hatch' });
  if (explodedHandles.length) flags.push({ severity: 'MED', message: `${explodedHandles.length} unclassifiable region(s) on a furniture layer.`, code: 'exploded_furniture' });
  if (unresolvedLayers.length) flags.push({ severity: 'MED', message: `${unresolvedLayers.length} layer(s) unresolved by rules.`, code: 'unresolved_layers' });

  return {
    lines,
    diagnostics: {
      scaleGate,
      flags,
      unresolvedLayers,
      exploded: { n: explodedHandles.length, handles: explodedHandles },
      assumptions: ['Wall height 3.00 m (operator parameter).', 'Wall thickness 0.23 m (operator parameter).']
    }
  };
}

function line(measurement, label, value, unit, sourceHandles, evidence, source) {
  return {
    measurement,
    label,
    quantity: value,
    unit,
    confidence: { level: evidence.length === 2 ? 'HIGH' : evidence.length === 1 ? 'MEDIUM' : 'NONE', evidence },
    measurementStatus: value > 0 ? 'measured' : (sourceHandles.length ? 'measured_zero' : 'not_measurable'),
    provenance: { ...source, sourceHandles }
  };
}

function parseDxf(content) {
  const groups = [];
  const lines = String(content).split(/\r\n|\r|\n/);
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (!Number.isNaN(code)) groups.push([code, lines[index + 1].trim()]);
  }

  let insunits = null;
  let insunitsInFile = false;
  const entities = [];
  const layers = [];
  let section = null;
  for (let index = 0; index < groups.length;) {
    const [code, value] = groups[index];
    if (code === 0 && value === 'SECTION') {
      section = groups[index + 1]?.[1] || null;
      index += 2;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      section = null;
      index += 1;
      continue;
    }
    if (section === 'HEADER' && code === 9 && value === '$INSUNITS') {
      insunitsInFile = true;
      const unit = groups.slice(index + 1, index + 7).find(([groupCode]) => groupCode === 70);
      const rawUnit = unit?.[1]?.trim() || '';
      insunits = /^\d+$/.test(rawUnit) ? Number(rawUnit) : null;
    }
    if (section === 'TABLES' && code === 0 && value === 'LAYER') {
      const layer = groups.slice(index + 1).find(([groupCode]) => groupCode === 2);
      if (layer) layers.push(layer[1]);
      index += 1;
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
  return { insunitsInFile, insunits, layers, entities };
}

function readEntity(type, groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const entity = { type, handle: group(5), layer: group(8), block: group(2), points: [] };
  if (type === 'LWPOLYLINE' || type === 'HATCH') {
    let x = null;
    let boundaryStarted = type !== 'HATCH';
    for (const [code, value] of groups) {
      if (type === 'HATCH' && code === 92) {
        boundaryStarted = true;
        continue;
      }
      if (!boundaryStarted) continue;
      if (code === 10) x = Number(value);
      if (code === 20 && x !== null) {
        entity.points.push([x, Number(value)]);
        x = null;
      }
    }
  }
  return ['HATCH', 'LWPOLYLINE', 'INSERT'].includes(type) ? entity : null;
}

function getScaleGate(document) {
  if (!document.insunitsInFile) return { ok: false, code: null, reason: 'No $INSUNITS present in file; a parser default is not evidence.' };
  if (!document.insunits) return { ok: false, code: 0, reason: '$INSUNITS is 0 (unitless).' };
  if (!UNIT_TO_METRES[document.insunits]) return { ok: false, code: document.insunits, reason: `Unsupported unit code ${document.insunits}.` };
  return { ok: true, code: document.insunits, unit: UNIT_NAME[document.insunits], toM: UNIT_TO_METRES[document.insunits], reason: 'Declared in file.' };
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
class ExportBlockedError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

module.exports = { createApplication, InputError, NotFoundError, ExportBlockedError };
