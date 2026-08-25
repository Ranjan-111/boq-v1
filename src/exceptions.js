/* The exception queue (#12).

   The product's stated weakness is asking an architect for too many decisions
   across too many screens. The fix is not fewer checks -- it is fewer
   interruptions for the same checks. Every signal the pipeline can raise gets
   one shape, one list, one ordering.

   No exception type may exist only in its originating module: if a check can
   stop an operator, it belongs here. */

const { isAnnotationLayer } = require('./dxf');

const SEVERITIES = Object.freeze({
  impossible_quantity: { severity: 'blocking', blocks: ['measurement', 'approval', 'export'] },
  not_measurable: { severity: 'blocking', blocks: ['approval', 'export'] },
  implausible_magnitude: { severity: 'blocking', blocks: ['approval'] },
  classification_conflict: { severity: 'blocking', blocks: ['approval'] },
  unconfirmed_proposal: { severity: 'blocking', blocks: ['measurement', 'approval'] },
  rectangular_proposal: { severity: 'blocking', blocks: ['approval'] },
  /* The count is already correct -- the layer voted. What is missing is the
     identity needed to price it, so this blocks pricing, not measurement. */
  unidentified_symbol: { severity: 'advisory', blocks: ['pricing'] },
  unclassified_geometry: { severity: 'advisory', blocks: ['completeness'] },
  /* Geometry the parser could not measure at all. A circle on a wall layer may
     be a column; a BOQ that ignored it would be short, so this blocks. An
     annotation is reported as unclassified_geometry instead, because a label
     cannot change a quantity. */
  unmeasured_geometry: { severity: 'blocking', blocks: ['approval', 'export'] },
  low_confidence: { severity: 'advisory', blocks: ['review'] },
  /* A floor read off the wall boundary because no room was tagged. It is a real
     number but an inferred one, so it is surfaced for confirmation. */
  inferred_floor: { severity: 'blocking', blocks: ['approval'] },
  /* Raised by the pricing layer rather than by a run: a rate outside its
     validity window must never quietly price a BOQ. */
  stale_rate: { severity: 'blocking', blocks: ['approval', 'export'] },
  /* A measurement with no catalogue entry is a real gap in the studio's setup.
     Falling back to the raw measurement name would export a row saying
     "floor_area", which is not a BOQ anyone can send a client. */
  unmapped_measurement: { severity: 'blocking', blocks: ['approval', 'export'] }
});

const EXCEPTION_TYPES = Object.freeze(Object.keys(SEVERITIES));

/* An axis-aligned rectangle has four corners and every edge parallel to an
   axis. coerceBoxes can only produce those, so a confirmed model proposal that
   is one may be describing a room that is not. */
function rectangularityOf(points = []) {
  const pts = points.map((point) => (Array.isArray(point) ? { x: point[0], y: point[1] } : point));
  if (pts.length !== 4) return { isAxisAlignedRectangle: false, corners: pts.length };
  const xs = new Set(pts.map((point) => Math.round(point.x * 1e6) / 1e6));
  const ys = new Set(pts.map((point) => Math.round(point.y * 1e6) / 1e6));
  return { isAxisAlignedRectangle: xs.size === 2 && ys.size === 2, corners: pts.length };
}

function makeException(fields) {
  const { severity, blocks } = SEVERITIES[fields.type];
  return {
    id: `${fields.type}:${fields.runId}:${fields.anchor}`,
    severity, blocks: [...blocks],
    resolutionOptions: [], impact: { quantity: null, unit: null },
    ...fields
  };
}

/** Every signal this run can raise, in one shape. */
function exceptionsForRun(run) {
  const out = [];
  const base = { runId: run.id, projectId: run.projectId ?? null, sourceDocumentId: run.sourceDocumentId ?? null };
  const firstObject = (line) => line.provenance?.contributions?.[0]?.sourceObjectId ?? null;

  for (const line of run.boq?.lines || []) {
    const impact = { quantity: line.quantity ?? null, unit: line.unit ?? null };
    if (line.provenance?.floorBasis === 'wall-boundary') {
      out.push(makeException({ ...base, type: 'inferred_floor', anchor: line.measurement, measurement: line.measurement,
        sourceObjectId: firstObject(line), groupKey: `inferred_floor:${line.measurement}`, impact,
        title: `${line.label || line.measurement} was inferred from the walls`,
        raisedBecause: 'No room or floor polygon was tagged, so the floor area was taken as the gross area inside the outer wall boundary. Confirm it, or draw the room outline for an exact figure.',
        resolutionOptions: [
          { action: 'confirm_inferred_floor', label: 'Accept the inferred gross floor area' },
          { action: 'draw_room', label: 'Draw the room outline for an exact floor area' }
        ] }));
    }
    if (line.provenance?.impossible) {
      out.push(makeException({ ...base, type: 'impossible_quantity', anchor: line.measurement, measurement: line.measurement,
        sourceObjectId: firstObject(line), groupKey: `impossible_quantity:${line.measurement}`, impact,
        title: `${line.label || line.measurement} cannot be measured as specified`,
        raisedBecause: line.provenance.impossible.reason,
        resolutionOptions: [
          { action: 'adjust_assumptions', label: 'Change the opening assumptions so deductions fit the geometry' },
          { action: 'select_ruleset', label: 'Select a ruleset that does not deduct openings here' }
        ] }));
    } else if (line.measurementStatus === 'not_measurable') {
      out.push(makeException({ ...base, type: 'not_measurable', anchor: line.measurement, measurement: line.measurement,
        sourceObjectId: firstObject(line), groupKey: `not_measurable:${line.measurement}`, impact,
        title: `${line.label || line.measurement} could not be measured`,
        raisedBecause: 'No geometry resolved for this measurement, so it has no quantity. A zero here would silently delete a cost line.',
        resolutionOptions: [
          { action: 'supply_geometry', label: 'Re-export the drawing with the missing geometry' },
          { action: 'mark_not_applicable', label: 'Record that this measurement does not apply to this drawing' }
        ] }));
    }
    if (line.provenance?.plausibility?.flagged) {
      out.push(makeException({ ...base, type: 'implausible_magnitude', anchor: `${line.measurement}:magnitude`, measurement: line.measurement,
        sourceObjectId: firstObject(line), groupKey: `implausible_magnitude:${line.measurement}`, impact,
        title: `${line.label || line.measurement} is an implausible size`,
        raisedBecause: line.provenance.plausibility.reasons?.[0] || 'The magnitude is outside a plausible range for a single object.',
        resolutionOptions: [
          { action: 'confirm_magnitude', label: 'Confirm the drawing really is this size' },
          { action: 'correct_scale', label: 'Re-export or re-scale the drawing' }
        ] }));
    }
    for (const conflict of line.provenance?.classificationConflicts || []) {
      out.push(makeException({ ...base, type: 'classification_conflict', anchor: `${line.measurement}:${conflict}`, measurement: line.measurement,
        sourceObjectId: firstObject(line), groupKey: `classification_conflict:${conflict}`, impact,
        title: `Conflicting classification affects ${line.label || line.measurement}`,
        raisedBecause: `Evidence disagrees about what these objects are (${conflict}), so the quantity rests on an unresolved identity.`,
        resolutionOptions: [{ action: 'resolve_conflict', label: 'Choose the correct classification for this group' }] }));
    }
    if (line.confidence && line.confidence.level !== 'HIGH' && !line.provenance?.plausibility?.flagged && line.measurementStatus === 'measured') {
      out.push(makeException({ ...base, type: 'low_confidence', anchor: `${line.measurement}:confidence`, measurement: line.measurement,
        sourceObjectId: firstObject(line), groupKey: `low_confidence:${line.measurement}`, impact,
        title: `${line.label || line.measurement} rests on thin evidence`,
        raisedBecause: `Confidence is ${line.confidence.level} because only ${(line.confidence.evidence || []).join(' and ') || 'one signal'} supported it.`,
        resolutionOptions: [{ action: 'spot_check', label: 'Spot-check this quantity against the drawing' }] }));
    }
  }

  for (const entry of run.boq?.unclassified || []) {
    /* Split on whether the omission could have carried a quantity. */
    /* Annotation-layer geometry and xref entities cannot change a quantity:
       a note leader is not a wall, and an xref lives outside the file. Both
       are surfaced but advisory. Real geometry on a measured layer still
       blocks, because a BOQ that ignored it could be short. */
    const onAnnotationLayer = entry.layer ? isAnnotationLayer(entry.layer) : false;
    const isXref = entry.block ? /xref/i.test(entry.block) : false;
    const isUnmeasurable = ['unmeasured-geometry', 'external-reference'].includes(entry.kind);
    const type = (isUnmeasurable && !onAnnotationLayer && !isXref)
      ? 'unmeasured_geometry'
      : 'unclassified_geometry';
    /* Xref entities share one group: the geometry lives outside the file, so
       each block name is equally opaque and the resolution is the same. */
    const groupScope = isXref ? 'xref-references' : (entry.block || entry.layer || 'unknown');
    out.push(makeException({ ...base, type, anchor: entry.handle || entry.sourceObjectId,
      sourceObjectId: entry.sourceObjectId, measurement: null,
      groupKey: `${type}:${groupScope}:${entry.type || 'geometry'}`,
      impact: { quantity: null, unit: null },
      title: entry.kind === 'annotation'
        ? `${entry.type || 'An annotation'} on ${entry.layer || 'an unnamed layer'} was not measured`
        : `${entry.type || 'Geometry'} on ${entry.layer || 'an unnamed layer'} could not be measured`,
      raisedBecause: entry.reason || 'No rule could measure this geometry, so it contributes nothing to the BOQ.',
      resolutionOptions: [
        { action: 'classify_geometry', label: 'Say what this geometry is so a rule can measure it' },
        { action: 'ignore_geometry', label: 'Record that this geometry is intentionally not measured' }
      ] }));
  }

  for (const residual of run.residuals || []) {
    if (residual.status !== 'awaiting_human') continue;
    const itemOnly = residual.missing === 'item';
    out.push(makeException({ ...base, type: 'unidentified_symbol', anchor: residual.id,
      sourceObjectId: residual.sourceObjectId, measurement: null, residualId: residual.id,
      groupKey: `unidentified_symbol:${residual.blockName || residual.sourceObjectId}`,
      impact: { quantity: null, unit: null },
      title: `${residual.blockName || 'A symbol'} is not identified`,
      raisedBecause: itemOnly
        ? `The layer says this is ${residual.categoryKnown}, so the count is already correct, but ${residual.blockName} does not say which item it is - it cannot be priced.`
        : `Neither the layer nor the block name identifies ${residual.blockName || 'this symbol'}, so neither its category nor its item is known.`,
      resolutionOptions: [{ action: 'confirm_item', label: 'Name the item this symbol represents (remembered for this studio)' }] }));
  }

  for (const page of run.pages || []) {
    if (page.route !== 'raster') continue;
    for (const region of page.regions || []) {
      if (region.lifecycle === 'deleted') continue;
      if (region.lifecycle !== 'confirmed') {
        out.push(makeException({ ...base, type: 'unconfirmed_proposal', anchor: `${page.sourcePageId}:${region.id}`,
          sourceObjectId: region.id, measurement: region.category || null, pageId: page.sourcePageId, regionId: region.id,
          groupKey: `unconfirmed_proposal:${page.sourcePageId}`, impact: { quantity: null, unit: null },
          title: region.origin === 'model-proposed' ? 'A model-proposed region is unconfirmed' : 'A traced region is unconfirmed',
          raisedBecause: 'An unconfirmed region contributes nothing to any quantity, so measurement cannot complete while it is open.',
          resolutionOptions: [
            { action: 'confirm_region', label: 'Confirm this region' },
            { action: 'delete_region', label: 'Discard this region' }
          ] }));
        continue;
      }
      /* A confirmed model proposal that is a plain rectangle: coerceBoxes can
         only emit rectangles, so an L-shaped room would have been squared off
         and its area overstated. The overlay makes it visible, but noticing it
         should not depend on the operator happening to look. */
      if (region.origin === 'model-proposed' && rectangularityOf(region.points).isAxisAlignedRectangle) {
        out.push(makeException({ ...base, type: 'rectangular_proposal', anchor: `${page.sourcePageId}:${region.id}:shape`,
          sourceObjectId: region.id, measurement: region.category || null, pageId: page.sourcePageId, regionId: region.id,
          groupKey: `rectangular_proposal:${page.sourcePageId}`, impact: { quantity: null, unit: null },
          title: 'A model-proposed region is a plain rectangle',
          raisedBecause: 'Boundary proposals can only be axis-aligned rectangles. If this region is really L-shaped or irregular, the rectangle overstates its area.',
          resolutionOptions: [
            { action: 'confirm_shape', label: 'Confirm the region really is rectangular' },
            { action: 'retrace_polygon', label: 'Re-trace the true outline as a polygon' }
          ] }));
      }
    }
  }
  return out;
}

/** Equivalent causes collapse to one decision. This is the main lever on workload. */
function groupExceptions(exceptions = []) {
  const groups = new Map();
  for (const exception of exceptions) {
    const existing = groups.get(exception.groupKey);
    if (existing) { existing.members.push(exception); continue; }
    groups.set(exception.groupKey, { groupKey: exception.groupKey, type: exception.type, severity: exception.severity,
      title: exception.title, raisedBecause: exception.raisedBecause, blocks: exception.blocks,
      resolutionOptions: exception.resolutionOptions, members: [exception] });
  }
  return [...groups.values()].map((group) => ({
    ...group, count: group.members.length,
    sourceObjectIds: group.members.map((member) => member.sourceObjectId).filter(Boolean)
  }));
}

/* Ordering is by money at risk once a rate book exists (#15). Until then a
   documented proxy is used and labelled as one: an operator who believes they
   are working highest-value-first when they are not is worse off than one who
   knows the ordering is provisional.

   The proxy's honest limit: share is computed within a measurement class,
   because 100 m2 of floor and 5 m of skirting are not comparable without a
   rate. Sole members of different classes therefore tie rather than being
   ordered on a comparison the proxy cannot justify. A rate source removes the
   limit, which is the point of making the ranker pluggable. */
function createImpactRanker({ rateSource = null } = {}) {
  const rankedBy = rateSource ? 'money-at-risk' : 'quantity-proxy';
  const caveat = rateSource ? null
    : 'Provisional ordering: no rate book exists yet, so items are ranked by share of total quantity within their measurement class, not by money at risk.';
  function score(exception, totalsByMeasurement) {
    const quantity = Number(exception.impact?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    if (rateSource) return quantity * (Number(rateSource.rateFor(exception.measurement)) || 0);
    const total = totalsByMeasurement.get(exception.measurement) || quantity;
    return total > 0 ? quantity / total : 0;
  }
  function order(exceptions = []) {
    const totals = new Map();
    for (const exception of exceptions) {
      const quantity = Number(exception.impact?.quantity);
      if (Number.isFinite(quantity) && quantity > 0) totals.set(exception.measurement, (totals.get(exception.measurement) || 0) + quantity);
    }
    const severityRank = (exception) => (exception.severity === 'blocking' ? 0 : 1);
    return [...exceptions]
      .map((exception) => ({ ...exception, rankedBy, impactScore: score(exception, totals) }))
      .sort((left, right) => severityRank(left) - severityRank(right) || right.impactScore - left.impactScore || String(left.id).localeCompare(String(right.id)));
  }
  return { rankedBy, caveat, order, score };
}

module.exports = { EXCEPTION_TYPES, SEVERITIES, exceptionsForRun, groupExceptions, createImpactRanker, rectangularityOf };
