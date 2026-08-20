const form = document.querySelector('#upload-form');
const message = document.querySelector('#message');
const runSection = document.querySelector('#run');
const reviewSection = document.querySelector('#review');
const runSummary = document.querySelector('#run-summary');
const boqLines = document.querySelector('#boq-lines');
const reprocess = document.querySelector('#reprocess');
const rollupSection = document.querySelector('#rollup');
const rollupSummary = document.querySelector('#rollup-summary');
const rollupLines = document.querySelector('#rollup-lines');
const classificationReview = document.querySelector('#classification-review');
const projectForm = document.querySelector('#project-form');
const projectStatus = document.querySelector('#project-status');
const projectControls = document.querySelector('#project-controls');
const buildingForm = document.querySelector('#building-form');
const storeyForm = document.querySelector('#storey-form');
const buildingSelect = document.querySelector('#building-select');
const storeySelect = document.querySelector('#storey-select');
const sourceDocumentSelect = document.querySelector('#source-document-select');
const reassignmentScope = document.querySelector('#reassignment-scope');
const reassignSource = document.querySelector('#reassign-source');
let currentProject = null;
let currentSourceDocumentId = null;
let rollupRenderSequence = 0;

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = projectForm.querySelector('button');
  button.disabled = true;
  projectStatus.textContent = 'Creating project…';
  try {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#project-name').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Project creation failed.');
    currentProject = result.project;
    projectControls.hidden = false;
    projectStatus.textContent = `${currentProject.name} (${currentProject.id}) ready for building and storey assignments.`;
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = '0';
    renderProjectControls();
  } catch (error) {
    projectStatus.textContent = `Project creation failed: ${error.message}`;
    projectStatus.className = 'error';
  } finally {
    button.disabled = false;
  }
});

buildingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentProject) return;
  projectStatus.dataset.ready = 'false';
  buildingForm.querySelector('button').disabled = true;
  try {
    const response = await fetch(`/api/projects/${currentProject.id}/buildings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#building-name').value }) });
    if (!response.ok) { projectStatus.textContent = (await response.json()).error || 'Building creation failed.'; return; }
    currentProject = (await fetch(`/api/projects/${currentProject.id}`).then((result) => result.json())).project;
    document.querySelector('#building-name').value = '';
    renderProjectControls();
    projectStatus.textContent = `${currentProject.name} workspace synchronized.`;
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = String(Number(projectStatus.dataset.revision || 0) + 1);
  } catch (error) { projectStatus.textContent = `Building creation failed: ${error.message}`; }
  finally { buildingForm.querySelector('button').disabled = false; }
});

storeyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const buildingId = buildingSelect.value;
  if (!buildingId) { projectStatus.textContent = 'Select a building before adding a storey.'; return; }
  projectStatus.dataset.ready = 'false';
  storeyForm.querySelector('button').disabled = true;
  try {
    const response = await fetch(`/api/buildings/${buildingId}/storeys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#storey-name').value }) });
    if (!response.ok) { projectStatus.textContent = (await response.json()).error || 'Storey creation failed.'; return; }
    document.querySelector('#storey-name').value = '';
    await refreshProject();
    projectStatus.textContent = `${currentProject.name} workspace synchronized.`;
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.revision = String(Number(projectStatus.dataset.revision || 0) + 1);
  }
  catch (error) { projectStatus.textContent = `Storey creation failed: ${error.message}`; }
  finally { storeyForm.querySelector('button').disabled = false; }
});

buildingSelect.addEventListener('change', () => renderStoreys());
sourceDocumentSelect.addEventListener('change', updateReassignAvailability);
reassignmentScope.addEventListener('change', updateReassignAvailability);

reassignSource.addEventListener('click', async () => {
  const sourceDocumentId = sourceDocumentSelect.value;
  const scope = reassignmentScope.value;
  const targetReady = scope === 'project' || (scope === 'building' && buildingSelect.value) || (scope === 'storey' && buildingSelect.value && storeySelect.value);
  if (!sourceDocumentId || !currentProject || !targetReady) return;
  reassignSource.disabled = true;
  reassignSource.dataset.state = 'running';
  message.textContent = 'Reassigning source and recomputing rollups…';
  try {
    const assignment = {
      projectId: currentProject.id,
      buildingId: scope === 'project' ? null : buildingSelect.value,
      storeyId: scope === 'storey' ? storeySelect.value : null,
      typicalMultiplier: scope === 'storey' ? (document.querySelector('#typical-multiplier').value || '1') : 1
    };
    const response = await fetch(`/api/source-documents/${sourceDocumentId}/assignment`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(assignment)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (!result.processingRun) {
      currentSourceDocumentId = sourceDocumentId;
      await refreshProject();
      message.textContent = 'Source assignment is already up to date.';
      reassignSource.dataset.state = 'completed';
      return;
    }
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    runSection.hidden = false;
    reviewSection.hidden = true;
    rollupSection.hidden = true;
    await pollRun();
    reassignSource.dataset.state = 'completed';
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
    reassignSource.dataset.state = 'failed';
  } finally {
    reassignSource.disabled = false;
  }
});

async function refreshProject() {
  if (!currentProject) return;
  currentProject = (await fetch(`/api/projects/${currentProject.id}`).then((result) => result.json())).project;
  renderProjectControls();
}

function renderProjectControls() {
  const selectedBuildingId = buildingSelect.value;
  const selectedSourceDocumentId = sourceDocumentSelect.value || currentSourceDocumentId || '';
  buildingSelect.replaceChildren(new Option('Select a building…', ''), ...currentProject.buildings.map((building) => new Option(building.name, building.id)));
  buildingSelect.value = currentProject.buildings.some((building) => building.id === selectedBuildingId) ? selectedBuildingId : '';
  renderStoreys(storeySelect.value);
  renderSourceDocuments(selectedSourceDocumentId);
}

function renderStoreys(preferredStoreyId = '') {
  const building = currentProject?.buildings.find((candidate) => candidate.id === buildingSelect.value);
  storeySelect.replaceChildren(new Option('Select a storey…', ''), ...(building?.storeys || []).map((storey) => new Option(storey.name, storey.id)));
  storeySelect.value = building?.storeys.some((storey) => storey.id === preferredStoreyId) ? preferredStoreyId : '';
  updateReassignAvailability();
}

storeySelect.addEventListener('change', updateReassignAvailability);

function renderSourceDocuments(preferredSourceDocumentId = '') {
  const documents = currentProject?.documentVersions || [];
  sourceDocumentSelect.replaceChildren(
    new Option('Select a source document…', ''),
    ...documents.map((document) => new Option(
      `${document.sourceSheet} · v${document.version} · ${document.storeyId ? 'storey' : document.buildingId ? 'building' : 'project'}`,
      document.id
    ))
  );
  sourceDocumentSelect.value = documents.some((document) => document.id === preferredSourceDocumentId) ? preferredSourceDocumentId : '';
  updateReassignAvailability();
}

function updateReassignAvailability() {
  const scope = reassignmentScope.value;
  const targetReady = scope === 'project' || (scope === 'building' && buildingSelect.value) || (scope === 'storey' && buildingSelect.value && storeySelect.value);
  reassignSource.hidden = !currentProject || !sourceDocumentSelect.value || !targetReady;
}
let currentRunId = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit('/api/source-documents', new FormData(form));
});

reprocess.addEventListener('click', async () => {
  await submit(`/api/runs/${currentRunId}/reprocess`);
});

async function submit(url, body) {
  message.textContent = 'Submitting drawing…';
  message.className = '';
  form.querySelector('button').disabled = true;
  try {
    if (body instanceof FormData && currentProject) {
      if (currentProject.id) body.set('projectId', currentProject.id);
      if (buildingSelect.value) body.set('buildingId', buildingSelect.value);
      if (storeySelect.value) body.set('storeyId', storeySelect.value);
      const sourceSheet = document.querySelector('#source-sheet').value.trim();
      if (sourceSheet) body.set('sourceSheet', sourceSheet);
      body.set('typicalMultiplier', document.querySelector('#typical-multiplier').value || '1');
    }
    const response = await fetch(url, { method: 'POST', body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    message.textContent = `Source ${result.processingRun.sourceDocument.id} v${result.processingRun.sourceDocument.version} accepted.`;
    runSection.hidden = false;
    reviewSection.hidden = true;
    reprocess.hidden = true;
    updateReassignAvailability();
    await pollRun();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
  } finally {
    form.querySelector('button').disabled = false;
  }
}

async function pollRun() {
  const response = await fetch(`/api/runs/${currentRunId}`);
  const run = await response.json();
  renderRun(run);
  if (run.status === 'completed') {
    renderBoq(run.boq.lines, run.classifications || []);
    await refreshProject();
    await renderProjectRollup(run);
    reprocess.hidden = false;
    return;
  }
  if (run.status === 'failed') {
    message.textContent = run.error;
    message.className = 'error';
    return;
  }
  setTimeout(pollRun, 50);
}

async function renderProjectRollup(run) {
  if (!run.projectId) return;
  const renderSequence = ++rollupRenderSequence;
  const versionQuery = run.boqVersionId ? `?boqVersionId=${encodeURIComponent(run.boqVersionId)}` : '';
  const response = await fetch(`/api/projects/${run.projectId}${versionQuery}`);
  if (!response.ok) return;
  const project = (await response.json()).project;
  if (renderSequence !== rollupRenderSequence) return;
  rollupSummary.textContent = `${project.name} (${project.id}) — BOQ ${project.rollup.boqVersionId || project.currentBoqVersionId}; quantities are drilled down by building, storey, and source provenance.`;
  rollupLines.replaceChildren(...project.rollup.lines.map((line) => {
    const row = document.createElement('tr');
    const projectQuantity = line.provenance.sourceContributions
      .filter((contribution) => !contribution.buildingId)
      .reduce((total, contribution) => total + contribution.quantity, 0);
    const projectScope = projectQuantity ? [`Project scope: ${Number(projectQuantity.toFixed(6))} ${line.unit}`] : [];
    const drilldown = [...projectScope, ...project.buildings.flatMap((building) => {
      const buildingLine = building.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
      const directQuantity = buildingLine?.provenance.sourceContributions
        .filter((contribution) => !contribution.storeyId)
        .reduce((total, contribution) => total + contribution.quantity, 0);
      const direct = directQuantity ? [`${building.name}: ${Number(directQuantity.toFixed(6))} ${buildingLine.unit}`] : [];
      const floors = building.storeys.map((storey) => {
        const storeyLine = storey.rollup.lines.find((candidate) => candidate.measurement === line.measurement);
        return storeyLine ? `${building.name} / ${storey.name}: ${storeyLine.quantity} ${storeyLine.unit}` : null;
      }).filter(Boolean);
      return [...direct, ...floors];
    })].join('\n');
    const provenance = line.provenance.sourceContributions.map((contribution) => `${contribution.sourceDocumentId} v${contribution.sourceDocumentVersion} (${contribution.sourceSheet}; ${contribution.storeyId || 'project'}; typical-storey multiplier: ×${contribution.typicalMultiplier}) handles: ${contribution.sourceHandles.join(', ')}`).join('\n');
    for (const value of [line.label, String(line.quantity), drilldown, provenance]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  rollupSection.hidden = false;
}

function renderRun(run) {
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

function renderBoq(lines, classifications = []) {
  classificationReview.replaceChildren();
  const conflicts = classifications.flatMap((classification) => classification.conflicts || []).filter((conflict, index, all) => all.findIndex((candidate) => candidate.groupKey === conflict.groupKey) === index);
  if (classifications.length) {
    const summary = document.createElement('p');
    summary.textContent = `${classifications.length} source objects classified; category and exact catalog item are tracked separately.`;
    classificationReview.append(summary);
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
    classificationReview.append(table);
  }
  for (const conflict of conflicts) {
    const alert = document.createElement('p');
    alert.className = 'error';
    alert.textContent = `Grouped classification conflict (${conflict.groupKey}): ${conflict.candidateValues.join(' vs ')} — exact item remains unresolved.`;
    classificationReview.append(alert);
  }
  boqLines.replaceChildren(...lines.map((line) => {
    const row = document.createElement('tr');
    const provenance = `${line.provenance.sourceDocumentId} v${line.provenance.sourceDocumentVersion}\n${line.provenance.sourceHandles.join(', ')}`;
    for (const value of [
      line.label,
      String(line.quantity),
      line.unit,
      `${line.confidence.level}: ${line.confidence.evidence.join(', ')}`,
      line.measurementStatus,
      provenance
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  reviewSection.hidden = false;
}
