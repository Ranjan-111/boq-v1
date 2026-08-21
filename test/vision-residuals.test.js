const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createApplication } = require('../src/application');
const { createRepository } = require('../src/repository');
const { readApiKey, createVisionService } = require('../src/vision');

const residualPlan = readFileSync(`${__dirname}/fixtures/residual-blocks.dxf`);
const cleanPlan = readFileSync(`${__dirname}/fixtures/clean-plan.dxf`);
const sync = (options = {}) => createApplication({ schedule: (callback) => callback(), ...options });
function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'boq-vision-'));
  return { file: join(directory, 'v.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function seed(application, { content = residualPlan, studioId = 'studio_alpha', sheet = 'A-PLAN' } = {}) {
  const project = application.createProject({ name: 'Residual project' });
  const source = application.createSourceDocument({ filename: 'plan.dxf', content, projectId: project.id, sourceSheet: sheet, studioId });
  return { project, run: application.getRun(application.startProcessing(source.id).id) };
}

test('the key is read from server config and never handed back to a caller', () => {
  assert.equal(readApiKey({}), null);
  assert.equal(readApiKey({ BOQ_VISION_API_KEY: '  ' }), null);
  assert.equal(readApiKey({ BOQ_VISION_API_KEY: 'abc' }), 'abc');
  const service = createVisionService({ apiKey: 'super-secret' });
  assert.equal(service.apiKey, undefined, 'the service exposes no key property');
  assert.equal(JSON.stringify(service).includes('super-secret'), false);
});

test('with no key configured the pipeline still completes and routes residuals to a human', async () => {
  const application = sync();
  assert.equal(application.visionAvailable(), false);
  const { run } = seed(application);
  assert.equal(run.status, 'completed', 'the drawing still measured end to end');
  assert.equal(run.boq.lines.find((line) => line.measurement === 'floor_area').quantity, 27.72, 'quantities are unaffected by vision being absent');
  assert.equal(run.residualSummary.total, 3);
  const after = await application.proposeResidualLabels(run.id);
  for (const residual of after.residuals) {
    assert.equal(residual.status, 'awaiting_human', 'every residual routes to a person');
    assert.equal(residual.proposal.status, 'unavailable');
    assert.equal(residual.proposal.label, null, 'no label is invented');
  }
});

test('residuals split into item-unknown and category-unknown', () => {
  const { run } = seed(sync());
  assert.deepEqual(run.residualSummary, { total: 3, itemUnknown: 2, categoryUnknown: 1, resolvedFromMemory: 0 });
  const itemUnknown = run.residuals.filter((residual) => residual.missing === 'item');
  assert.deepEqual(itemUnknown.map((residual) => residual.blockName).sort(), ['Block_17', 'Block_18']);
  for (const residual of itemUnknown) assert.equal(residual.categoryKnown, 'furniture', 'the layer already gave us the category');
  const unknown = run.residuals.find((residual) => residual.missing === 'category+item');
  assert.equal(unknown.blockName, 'Block_22');
  assert.equal(unknown.categoryKnown, null);
});

test('an item-unknown residual still counts correctly - only its identity is missing', () => {
  const { run } = seed(sync());
  assert.equal(run.boq.lines.find((line) => line.measurement === 'furniture_count').quantity, 3,
    'the layer voted, so the count is right even though two items are unidentified');
});

test('a model label is a proposal, and the human decision supersedes it on the trail', async () => {
  const repository = createRepository({});
  const application = sync({
    repository,
    vision: { available: true, async proposeLabel() { return { status: 'proposed', label: 'TABLE', category: 'furniture', model: 'stub-1', prompt: 'label-only' }; } }
  });
  const { run } = seed(application);
  const proposed = await application.proposeResidualLabels(run.id);
  const target = proposed.residuals.find((residual) => residual.blockName === 'Block_17');
  assert.equal(target.proposal.label, 'TABLE');
  assert.equal(target.status, 'awaiting_human', 'a proposal does not resolve anything on its own');

  application.confirmResidual(run.id, target.id, { item: 'three seat sofa', category: 'furniture', confirmedBy: 'lead' });
  const events = repository.listAudit();
  const proposal = events.find((event) => event.kind === 'vision_label_proposed');
  const confirmation = events.find((event) => event.kind === 'residual_confirmed');
  assert.equal(proposal.payload.model, 'stub-1', 'which model answered is recorded');
  assert.equal(confirmation.payload.confirmedBy, 'lead');
  assert.equal(confirmation.payload.supersededProposal.label, 'TABLE', 'the human decision records what it overrode');
  assert.equal(confirmation.payload.item, 'three seat sofa');
  repository.close();
});

test('a confirmed residual is never asked again for that studio, across a restart', () => {
  const { file, cleanup } = tempFile();
  try {
    const first = sync({ file });
    const { project, run } = seed(first);
    const target = run.residuals.find((residual) => residual.blockName === 'Block_17');
    first.confirmResidual(run.id, target.id, { item: 'three seat sofa', category: 'furniture', confirmedBy: 'lead' });

    const second = sync({ file });
    const source = second.createSourceDocument({ filename: 'next.dxf', content: residualPlan, projectId: project.id, sourceSheet: 'A-NEXT', studioId: 'studio_alpha' });
    const nextRun = second.getRun(second.startProcessing(source.id).id);
    const remembered = nextRun.residuals.find((residual) => residual.blockName === 'Block_17');
    assert.equal(remembered.status, 'resolved_from_memory', 'the same symbol is not asked twice');
    assert.equal(remembered.resolution.source, 'studio_mapping');
    assert.equal(nextRun.residualSummary.resolvedFromMemory, 1);
    assert.equal(nextRun.residuals.find((residual) => residual.blockName === 'Block_18').status, 'awaiting_human',
      'an unconfirmed symbol is still asked');
  } finally { cleanup(); }
});

test('memory is scoped to the studio that confirmed it', () => {
  const { file, cleanup } = tempFile();
  try {
    const application = sync({ file });
    const { project, run } = seed(application);
    const target = run.residuals.find((residual) => residual.blockName === 'Block_17');
    application.confirmResidual(run.id, target.id, { item: 'three seat sofa', confirmedBy: 'lead' });

    const otherStudio = application.createSourceDocument({ filename: 'other.dxf', content: residualPlan, projectId: project.id, sourceSheet: 'A-OTHER', studioId: 'studio_beta' });
    const otherRun = application.getRun(application.startProcessing(otherStudio.id).id);
    assert.equal(otherRun.residuals.find((residual) => residual.blockName === 'Block_17').status, 'awaiting_human',
      'another studio does not inherit a confirmation it did not make');
  } finally { cleanup(); }
});

test('a clean drawing produces no residuals at all', () => {
  const { run } = seed(sync(), { content: cleanPlan });
  assert.equal(run.residualSummary.total, 0);
  assert.deepEqual(run.residuals, []);
});

test('confirming requires an item and refuses to memorise nothing', () => {
  const application = sync();
  const { run } = seed(application);
  const target = run.residuals[0];
  assert.throws(() => application.confirmResidual(run.id, target.id, { item: '' }), /requires the item/i);
  assert.throws(() => application.confirmResidual(run.id, 'residual_nope', { item: 'x' }), /not found/i);
});
