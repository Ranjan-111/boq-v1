/* Workspace API (#14), backend half.

   The acceptance criteria: selecting a BOQ line switches to the correct
   building, storey and sheet and fits its source objects in view; selecting a
   drawing object reveals the lines it affects; positive contributions and
   deductions are distinguishable.

   Every field this needs already exists -- `bounds` is precomputed (3a), `sign`
   is required (R2), the navigation tree is on the SourceObject. This assembles
   them so the client needs no geometry logic of its own. */

const { TIERS } = require('./export');

const SPACE_TO_TIER = Object.freeze({ dxf: 'A', 'pdf-page': 'B', 'raster-pixel': 'C' });
const WEAKEST_FIRST = ['C', 'B', 'A'];

/* A point-bounds object -- an INSERT whose block had no definition -- has no
   extent. Fitting to it would give a zero-area rectangle the viewer cannot use,
   so a viewing extent is invented and flagged as invented. It is a display
   affordance, never a measurement. */
const MIN_EXTENT = 1000;
const MARGIN_FRACTION = 0.1;

function fitViewport(objects = [], { margin = MARGIN_FRACTION, minExtent = MIN_EXTENT } = {}) {
  const withBounds = objects.filter((object) => Array.isArray(object?.bounds) && object.bounds.length === 4 && object.bounds.every(Number.isFinite));
  if (!withBounds.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const object of withBounds) {
    minX = Math.min(minX, object.bounds[0]); minY = Math.min(minY, object.bounds[1]);
    maxX = Math.max(maxX, object.bounds[2]); maxY = Math.max(maxY, object.bounds[3]);
  }
  const rawWidth = maxX - minX;
  const rawHeight = maxY - minY;
  const degenerate = rawWidth <= 0 || rawHeight <= 0;
  const width = Math.max(rawWidth, minExtent);
  const height = Math.max(rawHeight, minExtent);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const padX = width * margin;
  const padY = height * margin;
  return {
    minX: centreX - width / 2 - padX, minY: centreY - height / 2 - padY,
    maxX: centreX + width / 2 + padX, maxY: centreY + height / 2 + padY,
    width: width + padX * 2, height: height + padY * 2,
    objectCount: withBounds.length,
    degenerate,
    note: degenerate ? 'These objects have no measurable extent (an unresolved block reference). The viewing rectangle is an affordance, not a measurement.' : null
  };
}

function tierOfContribution(contribution, objectsById) {
  const object = objectsById.get(contribution.sourceObjectId);
  return (object && SPACE_TO_TIER[object.coordinateSpace]) || null;
}

/* Gross, the deductions itemised, and net. Today the BOQ shows 143.79 with no
   indication that anything was subtracted; this is the number an architect will
   want to check, and it is nearly free from what contributions already carry. */
function signedBreakdown(line) {
  const contributions = line.provenance?.contributions || [];
  const additions = contributions.filter((contribution) => contribution.sign === 'add');
  const deductions = contributions.filter((contribution) => contribution.sign === 'deduct');
  const gross = additions.reduce((sum, contribution) => sum + contribution.quantity, 0);
  const deductionTotal = deductions.reduce((sum, contribution) => sum + contribution.quantity, 0);
  const round = (value) => Number(value.toFixed(6));
  return {
    measurement: line.measurement,
    unit: line.unit,
    gross: round(gross),
    deductionTotal: round(deductionTotal),
    net: round(gross - deductionTotal),
    additions: additions.map((contribution) => ({
      sourceObjectId: contribution.sourceObjectId, quantity: round(contribution.quantity),
      ruleId: contribution.ruleId, ruleInputs: contribution.ruleInputs ?? null
    })),
    deductions: deductions.map((contribution) => ({
      sourceObjectId: contribution.sourceObjectId, quantity: round(contribution.quantity),
      ruleId: contribution.ruleId, ruleInputs: contribution.ruleInputs ?? null
    })),
    /* Stated in the shape an estimator checks it in. */
    summary: deductions.length
      ? `Gross ${round(gross)} ${line.unit}, less ${deductions.length} opening${deductions.length === 1 ? '' : 's'} totalling ${round(deductionTotal)} ${line.unit}, net ${round(gross - deductionTotal)} ${line.unit}.`
      : `${round(gross)} ${line.unit}, with nothing deducted.`
  };
}

/**
 * Everything the viewer needs for one line, from an already-loaded rollup.
 * Pure, so it costs no queries of its own -- the caller loads the tree once.
 */
function lineEvidence(line, sourceObjects, { margin } = {}) {
  const objectsById = new Map(sourceObjects.map((object) => [object.sourceObjectId, object]));
  const contributions = (line.provenance?.contributions || []).map((contribution) => ({
    sourceObjectId: contribution.sourceObjectId,
    sign: contribution.sign,
    quantity: contribution.quantity,
    unit: contribution.unit,
    ruleId: contribution.ruleId,
    tier: tierOfContribution(contribution, objectsById)
  }));
  const referenced = [...new Set(contributions.map((contribution) => contribution.sourceObjectId))]
    .map((id) => objectsById.get(id)).filter(Boolean);

  const buildingIds = [...new Set(referenced.map((object) => object.buildingId).filter(Boolean))];
  const storeyIds = [...new Set(referenced.map((object) => object.storeyId).filter(Boolean))];
  const sheetIds = [...new Set(referenced.map((object) => object.sheetId).filter(Boolean))];
  /* Objects may span more than one sheet or storey. Say so rather than silently
     picking the first -- navigating to one of several is a wrong answer that
     looks like a right one. */
  const spansMultiple = buildingIds.length > 1 || storeyIds.length > 1 || sheetIds.length > 1;

  const tierCounts = {};
  for (const contribution of contributions) {
    const tier = contribution.tier || 'unknown';
    tierCounts[tier] = tierCounts[tier] || { count: 0, quantity: 0 };
    tierCounts[tier].count += 1;
    tierCounts[tier].quantity += contribution.sign === 'deduct' ? -contribution.quantity : contribution.quantity;
  }
  for (const entry of Object.values(tierCounts)) entry.quantity = Number(entry.quantity.toFixed(6));
  const present = Object.keys(tierCounts).filter((tier) => tier !== 'unknown');
  const weakest = WEAKEST_FIRST.find((tier) => present.includes(tier));

  /* One rectangle cannot span two storeys, so a spanning line gets one per
     storey as well as the overall extent. */
  const viewportsByStorey = storeyIds.map((storeyId) => ({
    storeyId,
    sheetIds: [...new Set(referenced.filter((object) => object.storeyId === storeyId).map((object) => object.sheetId).filter(Boolean))],
    viewport: fitViewport(referenced.filter((object) => object.storeyId === storeyId), { margin })
  }));

  return {
    measurement: line.measurement,
    label: line.label ?? null,
    quantity: line.quantity,
    unit: line.unit,
    measurementStatus: line.measurementStatus,
    navigate: {
      buildingId: buildingIds.length === 1 ? buildingIds[0] : null,
      storeyId: storeyIds.length === 1 ? storeyIds[0] : null,
      sheetId: sheetIds.length === 1 ? sheetIds[0] : null
    },
    spansMultiple,
    spans: {
      buildingIds, storeyIds, sheetIds,
      note: spansMultiple
        ? 'This line draws on objects in more than one sheet or storey; no single target was chosen. Use viewportsByStorey.'
        : null
    },
    sourceObjects: referenced,
    contributions,
    viewport: fitViewport(referenced, { margin }),
    viewportsByStorey,
    tier: weakest ? { ...TIERS[weakest], mixed: present.length > 1 } : TIERS.unknown,
    tierBreakdown: tierCounts,
    breakdown: signedBreakdown(line)
  };
}

/** The reverse: which lines does this object contribute to, and with what sign. */
function objectLines(sourceObjectId, lines, sourceObjects) {
  const object = sourceObjects.find((candidate) => candidate.sourceObjectId === sourceObjectId) || null;
  const affected = [];
  for (const line of lines) {
    const contributions = (line.provenance?.contributions || [])
      .filter((contribution) => contribution.sourceObjectId === sourceObjectId)
      .map((contribution) => ({ sign: contribution.sign, quantity: contribution.quantity, unit: contribution.unit, ruleId: contribution.ruleId }));
    if (!contributions.length) continue;
    const net = contributions.reduce((sum, contribution) => sum + (contribution.sign === 'deduct' ? -contribution.quantity : contribution.quantity), 0);
    affected.push({
      measurement: line.measurement, label: line.label ?? null, unit: line.unit,
      lineQuantity: line.quantity, contributions,
      netContribution: Number(net.toFixed(6)),
      shareOfLine: Number.isFinite(line.quantity) && line.quantity !== 0 ? Number((net / line.quantity).toFixed(6)) : null
    });
  }
  return { object, lines: affected };
}

module.exports = { fitViewport, signedBreakdown, lineEvidence, objectLines, tierOfContribution, SPACE_TO_TIER };
