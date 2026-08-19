const { createHash } = require('node:crypto');

const VERSIONS = Object.freeze({ parser: 'dxf-v1', ruleset: 'clean-plan-v1' });
const UNIT_TO_METRES = Object.freeze({ 4: 0.001, 5: 0.01, 6: 1 });
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
        run.boq = measureCleanDxf(document);
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

function failRun(run, error) {
  run.status = 'failed';
  run.error = error.message;
  setStage(run, 'measurement', 'failed');
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
    error: run.error
  };
}

function measureCleanDxf(sourceDocument) {
  const document = parseDxf(sourceDocument.content);
  const toMetres = UNIT_TO_METRES[document.insunits];
  if (!toMetres) throw new InputError('A supported $INSUNITS declaration is required before measurement.');

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
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (!Number.isNaN(code)) groups.push([code, lines[index + 1].trim()]);
  }

  let insunits = null;
  const entities = [];
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
      const unit = groups.slice(index + 1, index + 7).find(([groupCode]) => groupCode === 70);
      insunits = unit ? Number.parseInt(unit[1], 10) : null;
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
  return { insunits, entities };
}

function readEntity(type, groups) {
  const group = (code) => groups.find(([groupCode]) => groupCode === code)?.[1] || '';
  const entity = { type, handle: group(5), layer: group(8), block: group(2), points: [] };
  if (type === 'LWPOLYLINE' || type === 'HATCH') {
    let x = null;
    for (const [code, value] of groups) {
      if (code === 10) x = Number(value);
      if (code === 20 && x !== null) {
        entity.points.push([x, Number(value)]);
        x = null;
      }
    }
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
