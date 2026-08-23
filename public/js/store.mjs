/* ═══════════════════════════════════════════════════════════════════════════
   Store — the single source of truth for the operator interface.

   Everything here is pure: no DOM, no fetch, no timers. That is the point.
   The bugs this rebuild replaces were all disagreements between two places
   that each held a piece of the truth (a dataset attribute, a module
   variable, localStorage, and the text content of a div). There is now one
   place, and it can be tested in node without a browser.
   ═══════════════════════════════════════════════════════════════════════════ */

export const VIEWS = ['project', 'upload', 'review', 'exceptions', 'workspace', 'raster', 'rollup', 'export'];

export function initialState() {
  return {
    buildId: null,
    serverBuildId: null,
    projects: [],
    project: null,
    /* Counts structural edits (buildings, storeys) so the interface -- and the
       browser tests -- can wait for one to have landed. */
    structureRevision: 0,
    projectError: null,
    run: null,
    classifications: [],
    queue: { counts: { total: 0, blocking: 0, advisory: 0, groups: 0 }, groups: [] },
    boqVersion: null,
    rollup: null,
    view: 'project',
    selectedFile: null,
    uploadLimitBytes: null,
    unitPrompt: null,
    busy: {},
    error: null,
    notices: []
  };
}

/* ── Reducers ───────────────────────────────────────────────────────────── */

const reducers = {
  'projects:loaded': (state, { projects, uploadLimitBytes }) => ({
    ...state,
    projects,
    uploadLimitBytes: uploadLimitBytes ?? state.uploadLimitBytes
  }),

  /* One reducer for "we have a project payload", used by creation, refresh and
     reopen alike. Previously each of those three paths wrote a different
     subset of the state, which is precisely why reopening a project showed an
     approval panel with no BOQ behind it. */
  'project:loaded': (state, { project }) => ({
    ...state,
    project,
    rollup: project?.rollup ?? null,
    /* A BOQ version already held for this project stays; otherwise it is
       cleared, so a stale version id can never outlive its project. */
    boqVersion: state.boqVersion && state.boqVersion.projectId === project?.id ? state.boqVersion : null
  }),

  'project:structureChanged': (state) => ({ ...state, structureRevision: state.structureRevision + 1 }),

  'project:error': (state, { message }) => ({ ...state, projectError: message }),

  'project:cleared': (state) => ({ ...initialState(), projects: state.projects, uploadLimitBytes: state.uploadLimitBytes, buildId: state.buildId, serverBuildId: state.serverBuildId }),

  'file:selected': (state, { file }) => ({ ...state, selectedFile: file, unitPrompt: null }),

  'run:updated': (state, { run }) => ({ ...state, run }),

  'run:failed': (state, { run }) => ({ ...state, run }),

  'classifications:loaded': (state, { classifications }) => ({ ...state, classifications }),

  'queue:loaded': (state, { queue }) => ({ ...state, queue: normalizeQueue(queue) }),

  'boqVersion:loaded': (state, { boqVersion }) => ({ ...state, boqVersion }),

  'unit:required': (state, { reason }) => ({ ...state, unitPrompt: { reason } }),
  'unit:dismissed': (state) => ({ ...state, unitPrompt: null }),

  'view:changed': (state, { view }) => (VIEWS.includes(view) ? { ...state, view } : state),

  'busy:set': (state, { key, value }) => ({ ...state, busy: { ...state.busy, [key]: value } }),

  'error:raised': (state, { message, code }) => ({ ...state, error: { message, code: code || null } }),
  'error:cleared': (state) => ({ ...state, error: null }),

  'notice:added': (state, { message, tone }) => ({ ...state, notices: [...state.notices, { id: `n${state.notices.length + 1}_${Date.now()}`, message, tone: tone || 'info' }] }),
  'notice:removed': (state, { id }) => ({ ...state, notices: state.notices.filter((n) => n.id !== id) }),

  'build:checked': (state, { serverBuildId }) => ({ ...state, serverBuildId })
};

function normalizeQueue(queue) {
  const counts = queue?.counts || {};
  return {
    counts: {
      total: counts.total ?? 0,
      blocking: counts.blocking ?? 0,
      advisory: counts.advisory ?? 0,
      groups: counts.groups ?? (queue?.groups?.length ?? 0)
    },
    groups: queue?.groups || []
  };
}

export function reduce(state, type, payload = {}) {
  const reducer = reducers[type];
  if (!reducer) throw new Error(`Unknown action: ${type}`);
  return reducer(state, payload);
}

/* ── Selectors ──────────────────────────────────────────────────────────── */

export function boqVersionId(state) {
  return state.project?.currentBoqVersionId || null;
}

export function hasMeasuredRun(state) {
  return Boolean(state.run && state.run.status === 'completed' && state.run.boq?.lines?.length);
}

export function boqLines(state) {
  if (state.run?.boq?.lines?.length) return state.run.boq.lines;
  /* Reopening a project has no run, but the rollup carries the same measured
     lines. The old code rendered the table only from `run`, so a reopened
     project showed an empty BOQ over a live approval panel. */
  return state.rollup?.lines || [];
}

/* The runs that produced the current rollup, newest last. Reopening a project
   has no run of its own, but the rollup's provenance names the runs that made
   it -- which is how a reopened project can show the same graded BOQ the
   operator saw when they measured it. */
export function contributingRunIds(state) {
  const ids = [];
  for (const line of state.rollup?.lines || []) {
    for (const contribution of line.provenance?.contributions || []) {
      if (contribution.runId && !ids.includes(contribution.runId)) ids.push(contribution.runId);
    }
  }
  return ids;
}

export function isRaster(state) {
  return Boolean(state.run?.pages?.some((page) => page.kind === 'raster' || page.calibration !== undefined));
}

/* What the operator may do next, and -- when they may not -- why not.
   A locked step that explains itself reads as designed; one that is merely
   empty reads as broken. */
export function reachability(state) {
  const project = Boolean(state.project);
  const lines = boqLines(state).length > 0;
  const queueHas = state.queue.counts.total > 0;
  const version = boqVersionId(state);
  return {
    project: { reachable: true },
    /* Uploading without a project is legal -- a one-off takeoff should not
       require ceremony -- so this step is never locked. */
    upload: { reachable: true },
    review: lines
      ? { reachable: true }
      : { reachable: false, reason: 'Measure a drawing to see its quantities.' },
    exceptions: queueHas
      ? { reachable: true }
      : { reachable: false, reason: 'No exceptions have been raised.' },
    workspace: lines
      ? { reachable: true }
      : { reachable: false, reason: 'Measure a drawing to trace its evidence.' },
    raster: isRaster(state)
      ? { reachable: true }
      : { reachable: false, reason: 'Only images and scanned PDFs need calibration.' },
    rollup: (state.rollup?.lines?.length || 0) > 0
      ? { reachable: true }
      : { reachable: false, reason: 'Measure a drawing to build a rollup.' },
    export: version
      ? { reachable: true }
      : { reachable: false, reason: 'Measure a drawing to produce a BOQ version.' }
  };
}

/* The approval panel's entire truth, computed in one place from state.
   The old panel carried a static string in the HTML that no code path
   updated, so it said "No BOQ version ready for approval" forever. */
export function approvalState(state) {
  const versionId = boqVersionId(state);
  const blocking = state.queue.counts.blocking;
  if (!versionId) {
    return { status: 'none', versionId: null, canApprove: false, canExport: false, label: 'No BOQ version exists yet. Measure a drawing first.' };
  }
  /* A project gets a BOQ version the moment it is created, so a version id
     alone does not mean there is anything to approve. Approving an empty BOQ
     would produce an export with no quantities in it. */
  if (boqLines(state).length === 0 && state.boqVersion?.status !== 'approved') {
    return { status: 'empty', versionId, canApprove: false, canExport: false, label: 'Nothing has been measured yet. Upload a drawing to produce quantities.' };
  }
  const version = state.boqVersion && state.boqVersion.id === versionId ? state.boqVersion : null;
  if (version?.status === 'approved') {
    return {
      status: 'approved',
      versionId,
      canApprove: false,
      canExport: true,
      label: `Approved by ${version.approvedBy}. The documents below reproduce that snapshot exactly.`
    };
  }
  if (blocking > 0) {
    return {
      status: 'blocked',
      versionId,
      canApprove: false,
      canExport: false,
      blocking,
      label: `${blocking} blocking exception${blocking === 1 ? '' : 's'} must be resolved before this BOQ can be approved.`
    };
  }
  return { status: 'open', versionId, canApprove: true, canExport: false, label: `BOQ version ${versionId} is ready to approve.` };
}

/* ── Store instance ─────────────────────────────────────────────────────── */

export function createStore(state = initialState()) {
  let current = state;
  const listeners = new Set();
  return {
    get state() { return current; },
    dispatch(type, payload) {
      current = reduce(current, type, payload);
      for (const listener of listeners) listener(current);
      return current;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
