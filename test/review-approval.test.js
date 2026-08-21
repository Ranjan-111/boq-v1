const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { createApplication } = require('../src/application');
const { createRepository } = require('../src/repository');

const residualPlan = readFileSync(`${__dirname}/fixtures/residual-blocks.dxf`);
const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });
/* Approval now requires every measurement to map to a catalogue item (#24):
   a BOQ whose rows have no client-facing description cannot be approved. */
const FULL_CATALOGUE = { studioId: 'studio_alpha', items: [
  { code: 'STR-WP-001', description: 'Wall footprint, plan area', unit: 'm\u00b2', measurement: 'wall_plan' },
  { code: 'STR-WL-001', description: 'Brick masonry in cement mortar 1:6', unit: 'm\u00b3', measurement: 'wall_masonry' },
  { code: 'FIN-WL-002', description: 'Cement plaster 12mm to internal walls', unit: 'm\u00b2', measurement: 'wall_plaster' },
  { code: 'FIN-FL-001', description: 'Vitrified tile flooring 600x600', unit: 'm\u00b2', measurement: 'floor_area' },
  { code: 'FIN-SK-001', description: 'Skirting, 100mm', unit: 'm', measurement: 'skirting' },
  { code: 'GEN-RM-001', description: 'Rooms enumerated', unit: 'nos', measurement: 'room_count' },
  { code: 'GEN-DR-001', description: 'Door openings enumerated', unit: 'nos', measurement: 'door_count' },
  { code: 'GEN-WN-001', description: 'Window openings enumerated', unit: 'nos', measurement: 'window_count' },
  { code: 'GEN-FR-001', description: 'Loose furniture enumerated', unit: 'nos', measurement: 'furniture_count' }
] };


function workspace({ content = residualPlan, ...options } = {}) {
  const application = sync(options);
  const project = application.createProject({ name: 'Review project' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content, projectId: project.id, sourceSheet: 'A-PLAN', studioId: 'studio_alpha' });
  const run = application.getRun(application.startProcessing(source.id).id);
  application.publishCatalogue(project.id, FULL_CATALOGUE);
  return { application, project, source, run };
}

test('the queue reaches the operator through the application, not through a module', () => {
  const { application, project } = workspace();
  const queue = application.getExceptionQueue(project.id);
  assert.ok(queue.groups.length > 0);
  assert.ok(queue.exceptions.length > 0);
  assert.ok(queue.rankedBy, 'the ordering is labelled');
  assert.equal(queue.rankedBy, 'quantity-proxy');
  assert.ok(queue.caveat, 'and carries its caveat');
  assert.equal(queue.counts.blocking >= 0, true);
});

test('twelve instances of one symbol are one decision, and one resolution clears them', () => {
  const { application, project, run } = workspace();
  const before = application.getExceptionQueue(project.id);
  const group = before.groups.find((candidate) => candidate.groupKey.startsWith('unidentified_symbol:Block_17'));
  assert.ok(group, 'the symbol is grouped');
  const clearedCount = group.count;

  application.resolveExceptionGroup(project.id, group.groupKey, { action: 'confirm_item', item: 'three seat sofa', category: 'furniture', resolvedBy: 'lead' });
  const after = application.getExceptionQueue(project.id);
  assert.equal(after.groups.some((candidate) => candidate.groupKey === group.groupKey), false, 'the whole group is gone');
  assert.equal(before.exceptions.length - after.exceptions.length >= clearedCount, true, `at least ${clearedCount} exceptions cleared by one decision`);
});

test('approval is refused while a blocking exception is open', () => {
  const { application, project } = workspace({ content: readFileSync(`${__dirname}/fixtures/adversarial/garbage-layers.dxf`) });
  const queue = application.getExceptionQueue(project.id);
  assert.ok(queue.counts.blocking > 0, 'this drawing has blocking exceptions');
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  assert.throws(() => application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' }), /blocking exception/i);
  assert.equal(application.getBoqVersion(boqVersionId).status, 'open', 'and nothing was approved');
});

test('approval succeeds when nothing blocks, and records what it approved', () => {
  const { application, project } = workspace({ content: cleanPlan });
  const queue = application.getExceptionQueue(project.id);
  assert.equal(queue.counts.blocking, 0, 'a clean drawing blocks nothing');
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  const approved = application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedRulesetVersion, 'clean-plan-v2');
  assert.equal(approved.approvedAssumptionsVersion, 1);
  assert.ok(Array.isArray(approved.approvedRunIds) && approved.approvedRunIds.length > 0, 'the run set is recorded');
});

test('resolutions are append-only and carry supersedes', () => {
  const repository = createRepository({});
  const { application, project, run } = workspace({ repository });
  const group = application.getExceptionQueue(project.id).groups.find((candidate) => candidate.groupKey.startsWith('unidentified_symbol:Block_17'));
  const first = application.resolveExceptionGroup(project.id, group.groupKey, { action: 'confirm_item', item: 'two seat sofa', resolvedBy: 'lead' });
  assert.equal(first.resolution.supersedes, null, 'the first decision supersedes nothing');

  const second = application.resolveExceptionGroup(project.id, group.groupKey, { action: 'confirm_item', item: 'three seat sofa', resolvedBy: 'lead' });
  assert.equal(second.resolution.supersedes, first.resolution.id, 'the correction points at what it replaced');

  const history = application.getResolutions(project.id);
  assert.equal(history.length, 2, 'both decisions are on the record');
  assert.equal(history[0].item, 'two seat sofa', 'the original is not overwritten');
  repository.close();
});

test('no source file issues an UPDATE or DELETE against resolutions', () => {
  const directory = `${__dirname}/../src`;
  for (const name of readdirSync(directory, { recursive: true }).filter((entry) => String(entry).endsWith('.js'))) {
    const source = readFileSync(`${directory}/${name}`, 'utf8');
    assert.deepEqual(source.match(/(?:UPDATE|DELETE\s+FROM)\s+resolutions/gi) || [], [], `${name} mutates resolutions`);
  }
});

test('a resolution that changes a quantity re-measures and invalidates a prior approval', () => {
  const { application, project } = workspace({ content: cleanPlan });
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  assert.equal(application.getBoqVersion(boqVersionId).status, 'approved');

  const before = application.getProjectRollup(project.id).lines.find((line) => line.measurement === 'wall_plaster').quantity;
  application.recordQuantityAffectingResolution(project.id, { action: 'adjust_assumptions', values: { wallHeight: 3.4 }, reason: 'site survey', resolvedBy: 'lead' });
  const after = application.getProjectRollup(project.id).lines.find((line) => line.measurement === 'wall_plaster').quantity;

  assert.notEqual(after, before, 'the quantity moved');
  assert.equal(application.getBoqVersion(boqVersionId).status, 'stale', 'the approval did not survive it');
  assert.match(application.getBoqVersion(boqVersionId).staleReason, /assumption|resolution/i);
});

test('an approved version cannot be quietly re-approved to hide a change', () => {
  const { application, project } = workspace({ content: cleanPlan });
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  assert.throws(() => application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' }), /already approved/i);
});

test('a stale approval can be re-approved only once nothing blocks again', () => {
  const { application, project } = workspace({ content: cleanPlan });
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  application.recordQuantityAffectingResolution(project.id, { action: 'adjust_assumptions', values: { wallHeight: 3.4 }, reason: 'r', resolvedBy: 'lead' });
  assert.equal(application.getBoqVersion(boqVersionId).status, 'stale');
  const reapproved = application.approveBoqVersion(boqVersionId, { approvedBy: 'qs', reason: 're-checked after the survey' });
  assert.equal(reapproved.status, 'approved');
  assert.equal(reapproved.approvedAssumptionsVersion, 2, 'it records the assumptions it actually approved this time');
});

test('the audit trail records the resolution and the approval it invalidated', () => {
  const repository = createRepository({});
  const { application, project } = workspace({ repository, content: cleanPlan });
  const boqVersionId = application.getProjectAssumptions(project.id).currentBoqVersionId;
  application.approveBoqVersion(boqVersionId, { approvedBy: 'qs' });
  application.recordQuantityAffectingResolution(project.id, { action: 'adjust_assumptions', values: { wallHeight: 3.4 }, reason: 'r', resolvedBy: 'lead' });
  const kinds = repository.listAudit().map((event) => event.kind);
  assert.ok(kinds.includes('boq_version_approved'));
  assert.ok(kinds.includes('exception_resolved'));
  assert.ok(kinds.includes('boq_version_approval_invalidated'));
  repository.close();
});
