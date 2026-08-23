/* ═══════════════════════════════════════════════════════════════════════════
   Renderers — state in, DOM out.

   Nothing here fetches, and nothing here remembers. A renderer that keeps no
   state cannot disagree with another renderer, which is the failure mode this
   rebuild exists to remove.
   ═══════════════════════════════════════════════════════════════════════════ */

const runSummary = document.querySelector('#run-summary');
const runSection = document.querySelector('#run');
const reviewSection = document.querySelector('#review');
const boqLines = document.querySelector('#boq-lines');
const classificationReview = document.querySelector('#classification-review');
const exceptionSection = document.querySelector('#exception-review');
const queueOrdering = document.querySelector('#queue-ordering');
const queueCounts = document.querySelector('#queue-counts');
const queueRows = document.querySelector('#queue-rows');
const queueCards = document.querySelector('#queue-cards');
const navExceptionCount = document.querySelector('#nav-exception-count');

export function renderRunSummary(run) {
  if (!run) { runSection.hidden = true; return; }
  runSection.hidden = false;
  const unitStatus = run.units
    ? Object.assign(document.createElement('span'), {
      className: `stage ${run.units.source === 'operator-assumption' ? 'running' : 'completed'}`,
      textContent: `units: ${run.units.name} (${run.units.source})`
    })
    : null;
  runSummary.replaceChildren(...[
    Object.assign(document.createElement('strong'), { textContent: `${run.id}: ${run.status}` }),
    ...(unitStatus ? [unitStatus] : []),
    ...(run.projectId ? [Object.assign(document.createElement('span'), { className: 'stage completed', textContent: `project: ${run.projectId}${run.storeyId ? ` / ${run.storeyId}` : ''}` })] : []),
    ...(run.typicalMultiplier > 1 ? [Object.assign(document.createElement('span'), { className: 'stage running', textContent: `typical-storey multiplier: ×${run.typicalMultiplier}` })] : []),
    ...run.stages.map((stage) => {
      const element = document.createElement('span');
      element.className = `stage ${stage.status}`;
      element.textContent = `${stage.name}: ${stage.status}`;
      return element;
    })
  ]);
}


/* Provenance helpers */
function sourceObjectFor(carrier, contribution) {
  return (carrier?.sourceObjects || []).find((object) => object.sourceObjectId === contribution.sourceObjectId) || {};
}
function signedQuantity(carrier, line, predicate = () => true) {
  return (line.provenance?.contributions || [])
    .filter((contribution) => predicate(sourceObjectFor(carrier, contribution)))
    .reduce((total, contribution) => total + (contribution.sign === 'deduct' ? -contribution.quantity : contribution.quantity), 0);
}
function describeContributions(carrier, line) {
  return (line.provenance?.contributions || []).map((contribution) => {
    const object = sourceObjectFor(carrier, contribution);
    const scope = object.storeyId ? `storey ${object.storeyId}` : object.buildingId ? `building ${object.buildingId}` : 'project';
    const where = object.nativeHandle || object.regionId || 'n/a';
    const scale = contribution.ruleInputs?.scale?.drawingUnitsPerMetre ?? contribution.ruleInputs?.pixelsPerMetre ?? 'n/a';
    return `${object.sourceDocumentId} v${object.sourceDocumentVersion} (run ${contribution.runId}; ${object.sheetId || 'n/a'}; ${scope}; page ${object.pageId || 'n/a'}; ${where}; ${contribution.sign} ${contribution.quantity} ${contribution.unit}; ${object.geometrySource} in ${object.coordinateSpace}; bounds ${(object.bounds || []).join(',') || 'n/a'}; scale ${scale}; rule ${contribution.ruleId}@${contribution.rulesetVersion}; typical-storey multiplier: \u00d7${contribution.typicalMultiplier})`;
  });
}

function confidenceBadge(level) {
  const map = { HIGH: 'badge-green', MEDIUM: 'badge-amber', LOW: 'badge-red' };
  return map[level] || 'badge-gray';
}

function statusBadge(status) {
  const map = { measured: 'badge-green', measured_zero: 'badge-amber', not_measurable: 'badge-red' };
  return map[status] || 'badge-gray';
}

export function renderBoq(boq, classifications = []) {
  classificationReview.replaceChildren();
  const conflicts = classifications.flatMap((classification) => classification.conflicts || []).filter((conflict, index, all) => all.findIndex((candidate) => candidate.groupKey === conflict.groupKey) === index);
  if (classifications.length) {
    const summary = document.createElement('p');
    summary.className = 'text-sm text-secondary mb-4';
    summary.textContent = `${classifications.length} source objects classified; category and exact catalog item are tracked separately.`;
    classificationReview.append(summary);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap card-compact mb-4';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Source object</th><th>Category</th><th>Exact catalog item</th></tr></thead><tbody></tbody>';
    const body = table.querySelector('tbody');
    for (const classification of classifications) {
      const row = document.createElement('tr');
      for (const value of [classification.sourceObjectId, `${classification.category.value || 'Unresolved'} (${classification.category.state})`, `${classification.catalogItem.value || 'Unresolved'} (${classification.catalogItem.state})`]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    wrap.append(table);
    classificationReview.append(wrap);
  }
  for (const conflict of conflicts) {
    const alert = document.createElement('p');
    alert.className = 'error mt-2';
    alert.textContent = `Grouped classification conflict (${conflict.groupKey}): ${conflict.candidateValues.join(' vs ')} — exact item remains unresolved.`;
    classificationReview.append(alert);
  }
  boqLines.replaceChildren(...(boq.lines || []).map((line) => {
    const row = document.createElement('tr');
    const contributions = line.provenance?.contributions || [];
    const first = sourceObjectFor(boq, contributions[0] || {});
    const header = contributions.length
      ? `${first.sourceDocumentId} v${first.sourceDocumentVersion}`
      : 'no source object resolved';
    const provenance = [header, ...describeContributions(boq, line)].join('\n');

    /* Measurement */
    const nameCell = document.createElement('td');
    nameCell.innerHTML = `<strong>${line.label}</strong>`;
    row.append(nameCell);

    /* Quantity */
    const qtyCell = document.createElement('td');
    qtyCell.innerHTML = `<code>${String(line.quantity)}</code>`;
    row.append(qtyCell);

    /* Unit */
    const unitCell = document.createElement('td');
    unitCell.textContent = line.unit;
    row.append(unitCell);

    /* Confidence. A rollup line carries quantities and provenance but no
       confidence grading -- that lives on the run's own BOQ. Report the
       absence as an absence; inventing a level here would be a number the
       system never measured. */
    const confCell = document.createElement('td');
    if (line.confidence) {
      const badge = document.createElement('span');
      badge.className = `badge ${confidenceBadge(line.confidence.level)}`;
      badge.textContent = line.confidence.level;
      confCell.append(badge);
      const evidenceText = document.createElement('span');
      evidenceText.className = 'text-xs text-muted';
      evidenceText.textContent = ` ${(line.confidence.evidence || []).join(', ')}`;
      confCell.append(evidenceText);
    } else {
      confCell.className = 'text-muted';
      confCell.textContent = 'not graded in this view';
    }
    row.append(confCell);

    /* Status */
    const statusCell = document.createElement('td');
    if (line.measurementStatus) {
      const statusEl = document.createElement('span');
      statusEl.className = `badge ${statusBadge(line.measurementStatus)}`;
      statusEl.textContent = line.measurementStatus;
      statusCell.append(statusEl);
    } else {
      statusCell.className = 'text-muted';
      statusCell.textContent = '—';
    }
    row.append(statusCell);

    /* Provenance (expandable) */
    const provCell = document.createElement('td');
    provCell.className = 'provenance-cell expandable';
    const provSummary = document.createElement('span');
    provSummary.textContent = header;
    provSummary.className = 'text-xs';
    const provDetail = document.createElement('div');
    provDetail.className = 'expand-content';
    provDetail.textContent = provenance;
    provCell.append(provSummary, provDetail);
    provCell.addEventListener('click', () => provCell.classList.toggle('open'));
    row.append(provCell);

    return row;
  }));
  reviewSection.hidden = false;
}


/* ── Exception queue ─────────────────────────────────────────────────────── */

function resolutionButton(group, option, onResolve, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = option.label;
  button.dataset.action = option.action;
  button.addEventListener('click', async () => {
    const body = { groupKey: group.groupKey, action: option.action, resolvedBy: 'operator' };
    if (option.action === 'confirm_item') {
      const item = window.prompt(`What item is ${group.title}?`);
      if (!item) return;
      body.item = item;
    }
    button.disabled = true;
    await onResolve(body);
  });
  return button;
}

export function renderQueue(queue, onResolve) {
  if (!exceptionSection) return;
  const groups = queue.groups || [];
  exceptionSection.hidden = groups.length === 0;
  queueOrdering.textContent = `Ordered by: ${queue.rankedBy || 'rupee impact'}${queue.caveat ? ` — ${queue.caveat}` : ''}`;
  if (queue.rankedBy) queueOrdering.dataset.rankedBy = queue.rankedBy;
  queueCounts.textContent = `${queue.counts.total} exceptions · ${queue.counts.groups} groups · ${queue.counts.blocking} blocking · ${queue.counts.advisory} advisory`;

  if (navExceptionCount) {
    const badge = queue.counts.blocking > 0
      ? { count: queue.counts.blocking, className: 'nav-badge blocking' }
      : queue.counts.advisory > 0
        ? { count: queue.counts.advisory, className: 'nav-badge advisory' }
        : null;
    navExceptionCount.hidden = !badge;
    if (badge) { navExceptionCount.textContent = String(badge.count); navExceptionCount.className = badge.className; }
  }

  queueCards.replaceChildren(...groups.map((group) => {
    const card = document.createElement('div');
    card.className = 'exception-group';
    card.dataset.groupKey = group.groupKey;
    card.dataset.severity = group.severity;

    const title = document.createElement('div');
    title.className = 'exception-title';
    const severityBadge = document.createElement('span');
    severityBadge.className = `badge ${group.severity === 'BLOCK' ? 'badge-red' : 'badge-amber'}`;
    severityBadge.textContent = group.severity;
    title.append(severityBadge, ` ${group.title}`);
    if (group.count > 1) {
      const countBadge = document.createElement('span');
      countBadge.className = 'badge badge-gray';
      countBadge.textContent = `×${group.count}`;
      title.append(' ', countBadge);
    }
    card.append(title);

    const reason = document.createElement('div');
    reason.className = 'exception-reason';
    reason.textContent = group.raisedBecause;
    if (group.blocks?.length) reason.textContent += ` — blocks: ${group.blocks.join(', ')}`;
    card.append(reason);

    const actions = document.createElement('div');
    actions.className = 'exception-actions';
    for (const option of group.resolutionOptions || []) {
      /* Resolving an exception offers equal choices, not a call to action, so
         none of them takes the reserved blue fill: the system allows it at most
         twice per viewport, and a queue of twenty would drown in it. */
      actions.append(resolutionButton(group, option, onResolve, option.action === 'dismiss' ? 'btn-sm' : 'btn-sm btn-outline'));
    }
    card.append(actions);
    return card;
  }));

  /* A table carrying the same groups, kept because the browser tests assert
     against rows. It is generated from the same data as the cards -- the old
     code populated the two independently, and an empty-state check that read
     the table while the cards held four groups is what made a queue full of
     explanations report "nothing to show yet". */
  queueRows.replaceChildren(...groups.map((group) => {
    const row = document.createElement('tr');
    row.dataset.groupKey = group.groupKey;
    row.dataset.severity = group.severity;
    for (const value of [group.severity, group.title, group.raisedBecause, (group.blocks || []).join(', '), String(group.count)]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const actions = document.createElement('td');
    for (const option of group.resolutionOptions || []) {
      actions.append(resolutionButton(group, option, onResolve, 'btn-sm'));
    }
    row.append(actions);
    return row;
  }));
}

/* ── Project rollup ──────────────────────────────────────────────────────── */

const rollupSection = document.querySelector('#rollup');
const rollupSummary = document.querySelector('#rollup-summary');
const rollupLines = document.querySelector('#rollup-lines');

export function renderRollup(project) {
  if (!project?.rollup?.lines?.length) { rollupSection.hidden = true; return; }
  rollupSummary.textContent = `${project.name} (${project.id}) — BOQ ${project.rollup.boqVersionId || project.currentBoqVersionId}; quantities are drilled down by building, storey, and source provenance.`;
  rollupLines.replaceChildren(...project.rollup.lines.map((line) => {
    const row = document.createElement('tr');
    const projectQuantity = signedQuantity(project.rollup, line, (object) => !object.buildingId);
    const projectScope = projectQuantity ? [`Project scope: ${Number(projectQuantity.toFixed(6))} ${line.unit}`] : [];
    const drilldown = [...projectScope, ...(project.buildings || []).flatMap((building) => {
      const buildingLine = building.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
      const directQuantity = buildingLine ? signedQuantity(building.rollup, buildingLine, (object) => !object.storeyId) : 0;
      const direct = directQuantity ? [`${building.name}: ${Number(directQuantity.toFixed(6))} ${buildingLine.unit}`] : [];
      const floors = building.storeys.map((storey) => {
        const storeyLine = storey.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
        return storeyLine ? `${building.name} / ${storey.name}: ${storeyLine.quantity} ${storeyLine.unit}` : null;
      }).filter(Boolean);
      return [...direct, ...floors];
    })].join('\n');
    const provenance = describeContributions(project.rollup, line).join('\n');
    for (const value of [line.label, String(line.quantity), drilldown, provenance]) {
      const cell = document.createElement('td');
      if (value === provenance) cell.className = 'provenance-cell';
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  rollupSection.hidden = false;
}
