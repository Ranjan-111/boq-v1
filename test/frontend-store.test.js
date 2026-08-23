const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const storeModule = import(pathToFileURL(join(__dirname, '..', 'public', 'js', 'store.mjs')).href);

/* Every frontend bug in this system's history was a state disagreement, and
   none of them were visible to the suite: the tests either called the backend
   directly or drove a whole browser, with nothing in between. These assert the
   transitions themselves. Each one names the defect it would have caught. */

test('the BOQ version id follows the project, so a control can never read one that was never written', async () => {
  const { initialState, reduce, boqVersionId } = await storeModule;
  let state = initialState();
  assert.equal(boqVersionId(state), null);

  state = reduce(state, 'project:loaded', { project: { id: 'project_0001', currentBoqVersionId: 'boqv_0001' } });
  assert.equal(boqVersionId(state), 'boqv_0001');

  /* The original defect: six call sites read `dataset.boqVersionId` and nothing
     ever wrote it, so approve and every download button silently did nothing.
     Derived from the project, that is not expressible. */
  state = reduce(state, 'project:loaded', { project: { id: 'project_0002', currentBoqVersionId: 'boqv_0002' } });
  assert.equal(boqVersionId(state), 'boqv_0002');
});

test('a BOQ version cannot outlive the project it belonged to', async () => {
  const { initialState, reduce } = await storeModule;
  let state = initialState();
  state = reduce(state, 'project:loaded', { project: { id: 'project_0001', currentBoqVersionId: 'boqv_0001' } });
  state = reduce(state, 'boqVersion:loaded', { boqVersion: { id: 'boqv_0001', projectId: 'project_0001', status: 'approved', approvedBy: 'operator' } });
  assert.equal(state.boqVersion.status, 'approved');

  state = reduce(state, 'project:loaded', { project: { id: 'project_0002', currentBoqVersionId: 'boqv_0002' } });
  assert.equal(state.boqVersion, null, 'the previous project’s approval does not carry over');
});

test('a reopened project shows its quantities, not an empty table over a live approval panel', async () => {
  const { initialState, reduce, boqLines, reachability } = await storeModule;
  let state = initialState();
  /* Reopening produces no processing run -- the measured lines arrive on the
     rollup. The old interface rendered the table only from a run, so a
     reopened project showed nine measured quantities as an empty page. */
  state = reduce(state, 'project:loaded', {
    project: { id: 'project_0001', currentBoqVersionId: 'boqv_0001', rollup: { lines: [{ measurement: 'floor_area', quantity: 24.48 }] } }
  });
  assert.equal(boqLines(state).length, 1);
  assert.equal(reachability(state).review.reachable, true);
  assert.equal(reachability(state).rollup.reachable, true);
});

test('a run BOQ takes precedence over the rollup for the same project', async () => {
  const { initialState, reduce, boqLines } = await storeModule;
  let state = initialState();
  state = reduce(state, 'project:loaded', { project: { id: 'p', currentBoqVersionId: 'v', rollup: { lines: [{ measurement: 'a' }] } } });
  state = reduce(state, 'run:updated', { run: { id: 'run_1', status: 'completed', boq: { lines: [{ measurement: 'a' }, { measurement: 'b' }] } } });
  assert.equal(boqLines(state).length, 2);
});

test('approval is refused while anything blocks, and the refusal states the count', async () => {
  const { initialState, reduce, approvalState } = await storeModule;
  let state = initialState();
  state = reduce(state, 'project:loaded', { project: { id: 'p', currentBoqVersionId: 'boqv_0001', rollup: { lines: [{ measurement: 'a' }] } } });
  state = reduce(state, 'queue:loaded', { queue: { counts: { total: 3, blocking: 1, advisory: 2, groups: 2 }, groups: [] } });

  const blocked = approvalState(state);
  assert.equal(blocked.canApprove, false);
  assert.equal(blocked.canExport, false);
  /* The gate exists in order to refuse. A refusal the operator cannot read is
     indistinguishable from a broken button, which is exactly how it was
     reported. */
  assert.match(blocked.label, /1 blocking exception must be resolved/);

  state = reduce(state, 'queue:loaded', { queue: { counts: { total: 2, blocking: 0, advisory: 2, groups: 1 }, groups: [] } });
  assert.equal(approvalState(state).canApprove, true);
});

test('an empty BOQ cannot be approved even though its version exists', async () => {
  const { initialState, reduce, approvalState } = await storeModule;
  let state = initialState();
  /* A project is given a BOQ version the moment it is created. Treating that
     as "ready to approve" would export a document with no quantities in it. */
  state = reduce(state, 'project:loaded', { project: { id: 'p', currentBoqVersionId: 'boqv_0001', rollup: { lines: [] } } });
  const approval = approvalState(state);
  assert.equal(approval.status, 'empty');
  assert.equal(approval.canApprove, false);
  assert.match(approval.label, /Nothing has been measured yet/);
});

test('export unlocks only once the version is approved', async () => {
  const { initialState, reduce, approvalState } = await storeModule;
  let state = initialState();
  state = reduce(state, 'project:loaded', { project: { id: 'p', currentBoqVersionId: 'boqv_0001', rollup: { lines: [{ measurement: 'a' }] } } });
  state = reduce(state, 'queue:loaded', { queue: { counts: { total: 0, blocking: 0, advisory: 0, groups: 0 }, groups: [] } });
  assert.equal(approvalState(state).canExport, false);

  state = reduce(state, 'boqVersion:loaded', { boqVersion: { id: 'boqv_0001', projectId: 'p', status: 'approved', approvedBy: 'operator' } });
  const approved = approvalState(state);
  assert.equal(approved.canExport, true);
  assert.equal(approved.canApprove, false, 'an approved version is not approved twice');
  assert.match(approved.label, /Approved by operator/);
});

test('every step that is not yet reachable says why', async () => {
  const { initialState, reachability } = await storeModule;
  const reach = reachability(initialState());
  for (const [name, status] of Object.entries(reach)) {
    if (status.reachable) continue;
    assert.ok(status.reason && status.reason.length > 0, `${name} must explain why it is locked`);
  }
  /* Uploading without a project is legal on the server, so it is never gated. */
  assert.equal(reach.upload.reachable, true);
  assert.equal(reach.project.reachable, true);
});

test('the unit question is asked only once unit resolution has failed', async () => {
  const { initialState, reduce } = await storeModule;
  let state = initialState();
  assert.equal(state.unitPrompt, null, 'not asked before it matters');
  state = reduce(state, 'unit:required', { reason: 'This drawing does not state its units.' });
  assert.match(state.unitPrompt.reason, /does not state its units/);
  state = reduce(state, 'unit:dismissed');
  assert.equal(state.unitPrompt, null);
});

test('queue counts are normalised so a missing field never reads as zero blocking', async () => {
  const { initialState, reduce } = await storeModule;
  let state = initialState();
  state = reduce(state, 'queue:loaded', { queue: { groups: [{ groupKey: 'a' }, { groupKey: 'b' }] } });
  assert.equal(state.queue.counts.groups, 2, 'a group count is derived when the server omits it');
  assert.equal(state.queue.groups.length, 2);
});

test('the view only changes to a view that exists', async () => {
  const { initialState, reduce, VIEWS } = await storeModule;
  let state = initialState();
  state = reduce(state, 'view:changed', { view: 'export' });
  assert.equal(state.view, 'export');
  state = reduce(state, 'view:changed', { view: 'not-a-view' });
  assert.equal(state.view, 'export', 'an unknown view is ignored rather than blanking the page');
  assert.ok(VIEWS.includes('export'));
});

test('an unknown action is a programming error, not a silent no-op', async () => {
  const { initialState, reduce } = await storeModule;
  assert.throws(() => reduce(initialState(), 'nonsense:action'), /Unknown action/);
});

test('structural edits are counted so the interface can wait for one to land', async () => {
  const { initialState, reduce } = await storeModule;
  let state = initialState();
  assert.equal(state.structureRevision, 0);
  state = reduce(state, 'project:structureChanged');
  state = reduce(state, 'project:structureChanged');
  assert.equal(state.structureRevision, 2);
});

test('subscribers see every change, which is what keeps two panels from disagreeing', async () => {
  const { createStore } = await storeModule;
  const store = createStore();
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.view));
  store.dispatch('view:changed', { view: 'review' });
  store.dispatch('view:changed', { view: 'export' });
  unsubscribe();
  store.dispatch('view:changed', { view: 'project' });
  assert.deepEqual(seen, ['review', 'export']);
  assert.equal(store.state.view, 'project');
});

test('a project is always present once a drawing has been measured', async () => {
  const { initialState, reduce, reachability, approvalState } = await storeModule;
  /* Uploading without a project used to leave the operator stranded on Review
     BOQ: the queue, the rollup and the BOQ version are all project-scoped, so
     none of the following steps existed. The shell now gives the drawing a
     project before sending it; this pins what that must produce. */
  let state = initialState();
  state = reduce(state, 'project:loaded', { project: { id: 'project_0001', currentBoqVersionId: 'boqv_0001', rollup: { lines: [{ measurement: 'floor_area', quantity: 24.48 }] } } });
  state = reduce(state, 'queue:loaded', { queue: { counts: { total: 4, blocking: 0, advisory: 4, groups: 4 }, groups: [{ groupKey: 'a' }] } });

  const reach = reachability(state);
  assert.equal(reach.review.reachable, true);
  assert.equal(reach.exceptions.reachable, true, 'the queue is reachable');
  assert.equal(reach.rollup.reachable, true, 'the rollup is reachable');
  assert.equal(reach.export.reachable, true, 'approve and export is reachable');
  assert.equal(approvalState(state).canApprove, true, 'and the BOQ can actually be approved');
});
