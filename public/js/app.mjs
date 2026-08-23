/* ═══════════════════════════════════════════════════════════════════════════
   Shell — wiring only.

   Reads the server through `api`, writes the result into `store`, and lets the
   renderers draw whatever the store now says. No renderer fetches; no handler
   remembers. The old frontend had four places that each held part of the
   truth, and every bug in it was two of them disagreeing.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, ApiError } from './api.mjs';
import { createStore, reachability, approvalState, boqLines as selectBoqLines, boqVersionId, contributingRunIds } from './store.mjs';
import { renderRunSummary, renderBoq, renderQueue, renderRollup } from './render.mjs';
import { initRouter, renderView } from './router.mjs';
import * as raster from './raster.mjs';

const store = createStore();

/* ── DOM ─────────────────────────────────────────────────────────────────── */
const el = (id) => document.querySelector(id);
const form = el('#upload-form');
const message = el('#message');
const runSection = el('#run');
const reviewSection = el('#review');
const rollupSection = el('#rollup');
const reprocess = el('#reprocess');
const projectForm = el('#project-form');
const projectStatus = el('#project-status');
const projectControls = el('#project-controls');
const buildingSelect = el('#building-select');
const storeySelect = el('#storey-select');
const sourceDocumentSelect = el('#source-document-select');
const reassignmentScope = el('#reassignment-scope');
const reassignSource = el('#reassign-source');
const approvalStateEl = el('#approval-state');
const approvalError = el('#approval-error');
const approvalBanner = el('#approval-banner');
const approveButton = el('#approve-boq');
const exportControls = el('#export-controls');
const toastContainer = el('#toast-container');
const pdfSetupSection = el('#pdf-setup');
const pdfSetupForm = el('#pdf-setup-form');
const pdfPages = el('#pdf-pages');
const rasterWorkflow = el('#raster-workflow');

let currentRunId = null;
let currentSourceDocumentId = null;
let pollTimer = null;

/* ── Notifications ───────────────────────────────────────────────────────── */

function toast(text, type = 'info', duration = 4000) {
  if (!toastContainer || !text) return;
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.textContent = text;
  toastContainer.append(node);
  setTimeout(() => node.remove(), duration);
}

function say(text, tone = 'info') {
  message.textContent = text;
  message.className = `mt-4 text-sm ${tone === 'error' ? 'error' : `status-msg ${tone}`}`;
}

/* Every failure reaches here. The single most damaging habit in the old code
   was `if (!response.ok) return;` -- a refusal the operator never saw, on a
   button that then looked dead. A refusal is information; show it. */
function fail(error, fallback = 'Something went wrong.') {
  const text = error instanceof ApiError ? error.message : (error?.message || fallback);
  say(text, 'error');
  toast(text, 'error');
  return text;
}

/* A failure in the project view must be readable in the project view. Writing
   it to the upload view's status line -- which is what a single shared message
   element amounted to -- puts the explanation on a screen the operator is not
   looking at. */
function failProject(error, context) {
  /* Name the action and give the reason. "The server could not be reached"
     alone does not say what was being attempted; "Building creation failed"
     alone does not say why. */
  const detail = error instanceof ApiError ? error.message : (error?.message || '');
  const text = detail ? `${context} ${detail}` : context;
  store.dispatch('project:error', { message: text });
  toast(text, 'error');
  return text;
}

/* ── Render ──────────────────────────────────────────────────────────────── */

/* Each panel is drawn in isolation. A renderer that throws reports itself and
   costs only its own panel -- previously one bad field ended the whole render
   silently, leaving a populated header above an empty page. */
function panel(name, draw) {
  try { draw(); }
  catch (error) { console.error(`Failed to render ${name}`, error); toast(`The ${name} panel could not be drawn: ${error.message}`, 'error'); }
}

function render() {
  const state = store.state;
  const reach = reachability(state);
  renderView(state, reach);

  /* Locked views explain themselves rather than showing a bare heading. */
  for (const [name, status] of Object.entries(reach)) {
    const view = document.querySelector(`.view[data-view="${name}"]`);
    if (!view) continue;
    let note = view.querySelector('.view-locked');
    if (!status.reachable) {
      if (!note) { note = document.createElement('p'); note.className = 'view-locked'; view.append(note); }
      note.textContent = status.reason;
    } else if (note) note.remove();
  }

  if (state.projectError) {
    projectStatus.textContent = state.projectError;
    projectStatus.className = 'mt-4 text-sm error';
  } else if (state.project) {
    projectControls.hidden = false;
    projectStatus.textContent = `${state.project.name} (${state.project.id}) ready.`;
    projectStatus.className = 'mt-4 text-sm status-msg success';
    projectStatus.dataset.ready = 'true';
    projectStatus.dataset.projectId = state.project.id;
    /* Mirrored for the browser tests that read it. It is a projection of the
       store, never a place state lives -- that inversion is what left this
       attribute read by six call sites and written by none. */
    projectStatus.dataset.boqVersionId = boqVersionId(state) || '';
    projectStatus.dataset.revision = String(state.structureRevision);
    el('#header-project-name').textContent = state.project.name;
    el('#header-project-id').textContent = state.project.id;
  }

  panel('run', () => { if (state.run) renderRunSummary(state.run); });

  const lines = selectBoqLines(state);
  if (lines.length) {
    /* A run carries its own BOQ; a reopened project carries the same lines on
       its rollup. Rendering from whichever exists is the fix for a reopened
       project showing a live approval panel above an empty quantity table. */
    const carrier = state.run?.boq?.lines?.length ? state.run.boq : state.rollup;
    panel('BOQ', () => renderBoq(carrier, state.classifications));
  } else {
    reviewSection.hidden = true;
  }

  /* Reopening a project must populate the workspace picker too. The old code
     only ever filled it from a live run, so a reopened project offered an
     evidence probe with nothing to probe. */
  panel('workspace', () => renderWorkspaceLines(state.run));
  panel('exception queue', () => renderQueue(state.queue, resolveException));
  panel('rollup', () => renderRollup(state.project));

  const approval = approvalState(state);
  approvalStateEl.textContent = approval.label;
  approvalStateEl.dataset.status = approval.status;
  approvalStateEl.dataset.versionId = approval.versionId || '';
  approvalStateEl.dataset.blocking = String(state.queue.counts.blocking);
  if (approvalBanner) approvalBanner.className = `approval-banner ${approval.canApprove ? 'can-approve' : 'blocked'}`;
  approveButton.hidden = approval.status === 'approved';
  approveButton.disabled = !approval.canApprove;
  exportControls.hidden = !approval.canExport;
  if (approval.canExport) exportControls.dataset.versionId = approval.versionId;

  const unit = el('#unit-prompt');
  if (unit) unit.hidden = !state.unitPrompt;
  if (state.unitPrompt) el('#unit-prompt-text').textContent = state.unitPrompt.reason;
}

store.subscribe(render);

/* ── Projects ────────────────────────────────────────────────────────────── */

async function loadProjects() {
  try {
    const payload = await api.get('/api/projects');
    store.dispatch('projects:loaded', { projects: payload.projects || [], uploadLimitBytes: payload.limits?.uploadBytes });
    const picker = el('#project-picker');
    const resume = el('#project-resume');
    const limitLabel = el('#upload-limit');
    if (limitLabel && payload.limits?.uploadBytes) {
      limitLabel.textContent = ` — up to ${Math.round(payload.limits.uploadBytes / 1024 / 1024)} MB`;
    }
    const projects = payload.projects || [];
    if (resume) resume.hidden = projects.length === 0;
    if (picker) {
      picker.replaceChildren(...projects.map((project) => {
        const option = document.createElement('option');
        option.value = project.id;
        const count = project.sourceDocumentCount;
        option.textContent = `${project.name}${count ? ` — ${count} drawing${count === 1 ? '' : 's'}` : ' — empty'}`;
        return option;
      }));
    }
    return projects;
  } catch (error) { fail(error, 'The project list could not be loaded.'); return []; }
}

async function refreshProject(projectId = store.state.project?.id) {
  if (!projectId) return;
  const { project } = await api.get(`/api/projects/${projectId}`);
  store.dispatch('project:loaded', { project });
  try { localStorage.setItem('boq.activeProject', project.id); } catch { /* private mode */ }
  await Promise.all([refreshQueue(projectId), refreshBoqVersion(), restoreRun()]);
  renderProjectControls();
}

async function refreshQueue(projectId = store.state.project?.id) {
  if (!projectId) return;
  try {
    const queue = await api.get(`/api/projects/${projectId}/exceptions`);
    store.dispatch('queue:loaded', { queue });
  } catch (error) { fail(error, 'The exception queue could not be read.'); }
}

/* Reopening a project should show what measuring it showed. The rollup carries
   the quantities but not the confidence grading -- that lives on the run, and
   the rollup's provenance names it. Without this a reopened BOQ reported every
   row as ungraded, which is true of the rollup but misleading about the work. */
async function restoreRun() {
  if (store.state.run) return;
  const runId = contributingRunIds(store.state).at(-1);
  if (!runId) return;
  try {
    const run = await api.get(`/api/runs/${runId}`);
    if (run.status !== 'completed') return;
    currentRunId = run.id;
    currentSourceDocumentId = run.sourceDocument?.id || currentSourceDocumentId;
    store.dispatch('run:updated', { run });
    store.dispatch('classifications:loaded', { classifications: run.classifications || [] });
    reprocess.hidden = false;
  } catch { /* an older run may no longer be readable; the rollup still is */ }
}

async function refreshBoqVersion() {
  const versionId = boqVersionId(store.state);
  if (!versionId) return;
  try {
    const { boqVersion } = await api.get(`/api/boq-versions/${versionId}`);
    store.dispatch('boqVersion:loaded', { boqVersion });
  } catch (error) { fail(error, 'The BOQ version could not be read.'); }
}

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { project } = await api.post('/api/projects', { name: el('#project-name').value || undefined });
    store.dispatch('project:error', { message: null });
    store.dispatch('project:loaded', { project });
    try { localStorage.setItem('boq.activeProject', project.id); } catch { /* private mode */ }
    renderProjectControls();
    say(`${project.name} (${project.id}) ready.`, 'success');
    await loadProjects();
    await refreshBoqVersion();
  } catch (error) { failProject(error, 'Project creation failed.'); }
});

el('#building-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const project = store.state.project;
  if (!project) return;
  try {
    await api.post(`/api/projects/${project.id}/buildings`, { name: el('#building-name').value });
    await refreshProject(project.id);
    store.dispatch('project:structureChanged');
    autoSelectLatest();
  } catch (error) { failProject(error, 'Building creation failed.'); }
});

el('#storey-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const buildingId = buildingSelect.value;
  if (!buildingId) { say('Add a building before adding a storey.', 'warning'); return; }
  try {
    await api.post(`/api/buildings/${buildingId}/storeys`, { name: el('#storey-name').value });
    await refreshProject();
    store.dispatch('project:structureChanged');
    autoSelectLatest();
  } catch (error) { failProject(error, 'Storey creation failed.'); }
});

el('#project-resume-button')?.addEventListener('click', async () => {
  const id = el('#project-picker')?.value;
  if (!id) return;
  try { await refreshProject(id); toast('Project reopened', 'success'); }
  catch (error) { fail(error, 'That project could not be reopened.'); }
});

/* T13: select what was just created instead of asking for it again. */
function autoSelectLatest() {
  if (buildingSelect && !buildingSelect.value && buildingSelect.options.length > 1) buildingSelect.selectedIndex = buildingSelect.options.length - 1;
  if (storeySelect && !storeySelect.value && storeySelect.options.length > 1) storeySelect.selectedIndex = storeySelect.options.length - 1;
}

function renderProjectControls() {
  const project = store.state.project;
  if (!project) return;
  const chosen = buildingSelect.value;
  buildingSelect.replaceChildren(new Option('Select building…', ''), ...(project.buildings || []).map((building) => new Option(building.name, building.id)));
  if ((project.buildings || []).some((building) => building.id === chosen)) buildingSelect.value = chosen;
  renderStoreys();
  renderSourceDocuments();
  updateReassignAvailability();
}

function renderStoreys(preferred = '') {
  const project = store.state.project;
  const building = (project?.buildings || []).find((candidate) => candidate.id === buildingSelect.value);
  const chosen = preferred || storeySelect.value;
  storeySelect.replaceChildren(new Option('Select storey…', ''), ...((building?.storeys) || []).map((storey) => new Option(storey.name, storey.id)));
  if (((building?.storeys) || []).some((storey) => storey.id === chosen)) storeySelect.value = chosen;
}

function renderSourceDocuments(preferred = '') {
  const project = store.state.project;
  if (!sourceDocumentSelect) return;
  const documents = project?.documentVersions || [];
  /* The source you just measured, the one already chosen, or -- failing both --
     the most recent one. Asking an operator to re-pick the drawing they just
     uploaded from a dropdown is friction with no purpose; reassignment still
     only happens when the button is pressed. */
  const chosen = [preferred, currentSourceDocumentId, sourceDocumentSelect.value, documents.at(-1)?.id]
    .find((candidate) => candidate && documents.some((document_) => document_.id === candidate)) || '';
  sourceDocumentSelect.replaceChildren(
    new Option('Select a source document…', ''),
    ...documents.map((document_) => new Option(
      `${document_.sourceSheet || document_.filename} · v${document_.version} · ${document_.storeyId ? 'storey' : document_.buildingId ? 'building' : 'project'}`,
      document_.id
    ))
  );
  sourceDocumentSelect.value = chosen;
  updateReassignAvailability();
}

function updateReassignAvailability() {
  if (!reassignSource) return;
  const scope = reassignmentScope?.value;
  const missing = !sourceDocumentSelect?.value ? 'Choose the source document to reassign.'
    : scope === 'building' && !buildingSelect.value ? 'Choose the building to reassign it to.'
    : scope === 'storey' && !buildingSelect.value ? 'Choose the building to reassign it to.'
    : scope === 'storey' && !storeySelect.value ? 'Choose the storey to reassign it to.'
    : null;
  /* Visible but disabled, with the missing piece named. The control used to
     disappear entirely, which tells the operator nothing about what to do. */
  reassignSource.hidden = !store.state.project;
  reassignSource.disabled = Boolean(missing);
  if (missing) reassignSource.title = missing; else reassignSource.removeAttribute('title');
}

buildingSelect.addEventListener('change', () => { renderStoreys(); updateReassignAvailability(); });
storeySelect.addEventListener('change', updateReassignAvailability);
sourceDocumentSelect?.addEventListener('change', updateReassignAvailability);
reassignmentScope?.addEventListener('change', updateReassignAvailability);

reassignSource?.addEventListener('click', async () => {
  const sourceDocumentId = sourceDocumentSelect.value;
  const scope = reassignmentScope.value;
  const project = store.state.project;
  if (!sourceDocumentId || !project) return;
  reassignSource.disabled = true;
  reassignSource.dataset.state = 'running';
  say('Reassigning source and recomputing rollups…');
  try {
    const result = await api.patch(`/api/source-documents/${sourceDocumentId}/assignment`, {
      projectId: project.id,
      buildingId: scope === 'project' ? null : buildingSelect.value,
      storeyId: scope === 'storey' ? storeySelect.value : null,
      typicalMultiplier: scope === 'storey' ? (el('#typical-multiplier').value || '1') : 1
    });
    if (!result.processingRun) {
      currentSourceDocumentId = sourceDocumentId;
      await refreshProject();
      say('Source assignment is already up to date.');
      reassignSource.dataset.state = 'completed';
      return;
    }
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    runSection.hidden = false;
    go('upload');
    await pollRun();
    reassignSource.dataset.state = 'completed';
    toast('Source reassigned', 'success');
  } catch (error) {
    fail(error, 'Reassignment failed.');
    reassignSource.dataset.state = 'failed';
  } finally { updateReassignAvailability(); }
});

/* ── Upload and processing ───────────────────────────────────────────────── */

const dropzone = el('#upload-dropzone');
const drawingInput = el('#drawing');
if (dropzone && drawingInput) {
  dropzone.addEventListener('click', () => drawingInput.click());
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    if (event.dataTransfer.files.length) {
      drawingInput.files = event.dataTransfer.files;
      drawingInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  drawingInput.addEventListener('change', () => {
    const file = drawingInput.files[0];
    store.dispatch('file:selected', { file: file ? { name: file.name, size: file.size } : null });
    /* Write into the caption paragraph, never into the dropzone itself -- the
       file input lives inside it, and replacing its text removes the input. */
    const caption = dropzone.querySelector('p');
    if (file && caption) caption.innerHTML = `<strong>${file.name}</strong> selected`;
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit('/api/source-documents', new FormData(form));
});

reprocess.addEventListener('click', async () => {
  if (currentRunId) await submit(`/api/runs/${currentRunId}/reprocess`);
});

async function submit(url, body) {
  say('Submitting drawing…');
  const button = form.querySelector('button');
  button.disabled = true;
  store.dispatch('unit:dismissed');
  try {
    if (body instanceof FormData && store.state.project) {
      body.set('projectId', store.state.project.id);
      if (buildingSelect.value) body.set('buildingId', buildingSelect.value);
      if (storeySelect.value) body.set('storeyId', storeySelect.value);
      const sourceSheet = el('#source-sheet').value.trim();
      if (sourceSheet) body.set('sourceSheet', sourceSheet);
      body.set('typicalMultiplier', el('#typical-multiplier').value || '1');
      const fallbackUnit = el('#fallback-unit')?.value;
      if (fallbackUnit) body.set('fallbackUnit', fallbackUnit);
    }
    const result = body instanceof FormData ? await api.upload(url, body) : await api.post(url);
    currentRunId = result.processingRun.id;
    currentSourceDocumentId = result.processingRun.sourceDocument.id;
    say(`Source ${result.processingRun.sourceDocument.id} v${result.processingRun.sourceDocument.version} accepted.`, 'success');
    runSection.hidden = false;
    reviewSection.hidden = true;
    reprocess.hidden = true;
    rasterWorkflow.hidden = true;
    go('upload');
    await pollRun();
  } catch (error) { fail(error, 'The drawing could not be submitted.'); }
  finally { button.disabled = false; }
}

async function pollRun() {
  if (!currentRunId) return;
  clearTimeout(pollTimer);
  let run;
  try { run = await api.get(`/api/runs/${currentRunId}`); }
  catch (error) { fail(error, 'The processing run could not be read.'); return; }
  store.dispatch('run:updated', { run });

  if (run.status === 'completed') {
    pdfSetupSection.hidden = true;
    const isRasterRun = run.setup?.route === 'raster';
    rasterWorkflow.hidden = !isRasterRun;
    if (isRasterRun) { raster.renderRasterWorkflow(run); go('raster'); }
    else if (run.sourceDocument?.format === 'pdf') raster.renderPdfOcrWorkflow(run);
    store.dispatch('classifications:loaded', { classifications: run.classifications || [] });
    await refreshProject(run.projectId || store.state.project?.id);
    reprocess.hidden = false;
    toast('Drawing measured', 'success');
    return;
  }
  if (run.status === 'awaiting_setup') {
    raster.renderPdfSetup(run);
    raster.renderPdfOcrWorkflow(run);
    return;
  }
  if (['awaiting_calibration', 'awaiting_trace', 'awaiting_confirmation'].includes(run.status) && run.setup?.route === 'raster') {
    pdfSetupSection.hidden = true;
    pdfPages.replaceChildren();
    reviewSection.hidden = true;
    rollupSection.hidden = true;
    reprocess.hidden = true;
    raster.renderRasterWorkflow(run);
    go('raster');
    say(run.blockedReasons?.join(' ') || 'This source requires raster calibration before measurement.', 'warning');
    return;
  }
  if (run.status === 'failed') {
    if (run.sourceDocument?.format === 'pdf' && run.pages?.length) raster.renderPdfOcrWorkflow(run);
    /* T3: ask for the unit at the moment it is actually missing, not upfront. */
    if (/drawing unit|\$INSUNITS/i.test(String(run.error || ''))) {
      store.dispatch('unit:required', { reason: 'This drawing does not state its units, so nothing can be measured from it yet. Which unit was it drawn in?' });
      say('This drawing does not state its units. Choose the unit below and measure again.', 'error');
      el('#fallback-unit')?.focus();
      toast('Choose the drawing unit to continue', 'error');
    } else {
      say(run.error, 'error');
      toast('Processing failed', 'error');
    }
    return;
  }
  pollTimer = setTimeout(pollRun, 50);
}

pdfSetupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pages = [...pdfPages.querySelectorAll('[data-source-page-id]')].map((pageElement) => ({
    sourcePageId: pageElement.dataset.sourcePageId,
    scale: { drawingUnitsPerMetre: pageElement.querySelector('input[type="number"]').value },
    selectedRegions: [...pageElement.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value)
  }));
  const button = pdfSetupForm.querySelector('button');
  button.disabled = true;
  try {
    await api.post(`/api/runs/${currentRunId}/setup`, { pages });
    pdfSetupSection.hidden = true;
    await pollRun();
  } catch (error) { fail(error, 'The PDF setup could not be confirmed.'); }
  finally { button.disabled = false; }
});

/* ── Exceptions ──────────────────────────────────────────────────────────── */

async function resolveException(body) {
  const projectId = store.state.project?.id;
  if (!projectId) return;
  try {
    await api.post(`/api/projects/${projectId}/exceptions/resolve`, body);
    await refreshProject(projectId);
    toast('Exception resolved', 'success');
  } catch (error) { fail(error, 'That exception could not be resolved.'); }
}

/* ── Approval and export ─────────────────────────────────────────────────── */

approveButton.addEventListener('click', async () => {
  const versionId = boqVersionId(store.state);
  if (!versionId) return;
  approveButton.disabled = true;
  try {
    const { boqVersion } = await api.post(`/api/boq-versions/${versionId}/approve`, { approvedBy: 'operator' });
    store.dispatch('boqVersion:loaded', { boqVersion });
    approvalError.className = 'text-sm status-msg success mt-2';
    approvalError.textContent = `Approved: ruleset ${boqVersion.approvedRulesetVersion}, assumptions v${boqVersion.approvedAssumptionsVersion}`;
    toast('BOQ version approved', 'success');
    await refreshProject();
  } catch (error) {
    /* The gate exists in order to refuse. A refusal the operator cannot read is
       indistinguishable from a broken button -- which is exactly how this was
       reported. Show the server's own reason, verbatim. */
    approvalError.className = 'text-sm error mt-2';
    approvalError.textContent = error instanceof ApiError ? error.message : 'Approval failed.';
    toast(approvalError.textContent, 'error');
    approveButton.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-export]')) {
  button.addEventListener('click', async () => {
    const versionId = exportControls?.dataset.versionId || boqVersionId(store.state);
    if (!versionId) { toast('Approve the BOQ version first', 'error'); return; }
    const kind = button.dataset.export;
    const query = kind === 'sidecar' ? 'format=csv&sidecar=1' : `format=${kind}`;
    const name = kind === 'sidecar' ? `${versionId}-provenance.json` : `${versionId}-boq.${kind}`;
    try {
      await api.download(`/api/boq-versions/${versionId}/export?${query}`, name);
      toast(`Downloaded ${name}`, 'success');
    } catch (error) { fail(error, 'Export failed.'); }
  });
}

/* ── Workspace ───────────────────────────────────────────────────────────── */

const wsSection = el('#workspace');
const wsLine = el('#ws-line');
const wsNavigate = el('#ws-navigate');
const wsBreakdown = el('#ws-breakdown');
const wsTiers = el('#ws-tiers');
const wsViewport = el('#ws-viewport');
const wsContributions = el('#ws-contributions');
const wsPosition = el('#ws-position');
let wsQueueIndex = 0;

function renderWorkspaceLines(run) {
  const lines = run?.boq?.lines?.length ? run.boq.lines : selectBoqLines(store.state);
  if (!wsLine || !lines.length) return;
  const current = wsLine.value;
  wsLine.replaceChildren(new Option('Select a measurement…', ''), ...lines.map((line) => new Option(line.label, line.measurement)));
  if (lines.some((line) => line.measurement === current)) wsLine.value = current;
  wsSection.hidden = false;
}

async function renderLineEvidence(projectId, measurement) {
  let evidence;
  try { evidence = await api.get(`/api/projects/${projectId}/lines/${measurement}/evidence`); }
  catch (error) { fail(error, 'That line has no readable evidence.'); return; }
  wsSection.hidden = false;
  wsNavigate.textContent = evidence.spansMultiple
    ? `Spans ${evidence.spans.storeyIds.length} storeys / ${evidence.spans.sheetIds.length} sheets — ${evidence.spans.note}`
    : `Navigate to building ${evidence.navigate.buildingId} / storey ${evidence.navigate.storeyId} / sheet ${evidence.navigate.sheetId}`;
  wsNavigate.dataset.spansMultiple = String(evidence.spansMultiple);
  wsBreakdown.textContent = evidence.breakdown.summary;
  wsTiers.textContent = `Reported tier ${evidence.tier.tier} (${evidence.tier.label}) — ` + Object.entries(evidence.tierBreakdown)
    .map(([tier, entry]) => `${tier}: ${entry.count} contribution(s), ${entry.quantity}`).join('; ');
  wsViewport.textContent = evidence.viewport
    ? `Viewport ${Math.round(evidence.viewport.minX)},${Math.round(evidence.viewport.minY)} to ${Math.round(evidence.viewport.maxX)},${Math.round(evidence.viewport.maxY)}${evidence.viewport.degenerate ? ' (extent invented for viewing)' : ''}`
    : 'No viewport: this line resolved no geometry.';

  const objectsById = new Map(evidence.sourceObjects.map((object) => [object.sourceObjectId, object]));
  wsContributions.replaceChildren(...evidence.contributions.map((contribution) => {
    const row = document.createElement('tr');
    row.dataset.sign = contribution.sign;
    const object = objectsById.get(contribution.sourceObjectId) || {};
    for (const value of [contribution.sign, String(contribution.quantity), contribution.tier || '-', contribution.sourceObjectId, (object.bounds || []).map(Math.round).join(', ')]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const reverse = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-sm';
    button.textContent = 'what does this object affect?';
    button.addEventListener('click', async () => {
      try {
        const result = await api.get(`/api/projects/${projectId}/objects/${encodeURIComponent(contribution.sourceObjectId)}/lines`);
        reverse.textContent = result.lines.map((line) => `${line.measurement} ${line.contributions.map((entry) => `${entry.sign} ${entry.quantity}`).join(', ')}`).join(' | ');
      } catch (error) { fail(error, 'That object could not be traced.'); }
    });
    reverse.append(button);
    row.append(reverse);
    return row;
  }));
}

async function renderQueueStep(projectId, index) {
  try {
    const step = await api.get(`/api/projects/${projectId}/queue/step?index=${index}`);
    if (!step.total) { wsPosition.textContent = 'queue empty'; return; }
    wsQueueIndex = step.index;
    wsPosition.textContent = `exception ${step.index + 1} of ${step.total} — ${step.exception.title} (ordered by ${step.rankedBy})`;
    if (step.exception.measurement) await renderLineEvidence(projectId, step.exception.measurement);
  } catch (error) { fail(error, 'The queue could not be stepped.'); }
}

el('#ws-next')?.addEventListener('click', () => {
  const projectId = store.state.project?.id;
  if (projectId) renderQueueStep(projectId, wsQueueIndex + 1);
});
el('#ws-prev')?.addEventListener('click', () => {
  const projectId = store.state.project?.id;
  if (projectId) renderQueueStep(projectId, Math.max(0, wsQueueIndex - 1));
});
wsLine?.addEventListener('change', () => {
  const projectId = store.state.project?.id;
  if (projectId && wsLine.value) renderLineEvidence(projectId, wsLine.value);
});

/* ── Navigation ──────────────────────────────────────────────────────────── */

function go(view) {
  store.dispatch('view:changed', { view });
}

/* ── Build freshness (F9) ────────────────────────────────────────────────── */

/* Three days were spent believing a feature was broken when the running server
   simply predated it. A stale process must announce itself. */
async function checkBuild() {
  try {
    const { buildId } = await api.get('/api/build');
    const expected = document.documentElement.dataset.buildId;
    store.dispatch('build:checked', { serverBuildId: buildId });
    if (expected && buildId && expected !== buildId) {
      const banner = document.createElement('div');
      banner.className = 'build-stale';
      banner.id = 'build-stale';
      banner.textContent = `This page came from a different build than the server is running (page ${expected}, server ${buildId}). Restart the server and hard-refresh.`;
      document.body.prepend(banner);
    }
  } catch { /* an older server has no /api/build; that is not an error */ }
}

/* ── Init ────────────────────────────────────────────────────────────────── */

raster.initRaster({ toast, submit, pollRun, getRunId: () => currentRunId, setRunId: (id) => { currentRunId = id; } });

const initialView = initRouter(go);
store.dispatch('view:changed', { view: initialView });
render();

checkBuild();
loadProjects().then(async (projects) => {
  if (!projects.length) return;
  let last = null;
  try { last = localStorage.getItem('boq.activeProject'); } catch { /* private mode */ }
  if (last && projects.some((project) => project.id === last)) {
    /* Reported, never swallowed. A `catch {}` here is what turned a renderer
       throwing inside a store listener into a blank screen with no clue --
       the same silence this rebuild exists to remove. */
    await refreshProject(last).catch((error) => fail(error, 'That project could not be reopened.'));
  }
});
