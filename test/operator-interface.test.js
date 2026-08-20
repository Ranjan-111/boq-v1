const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
const { startOperatorApp } = require('../test-support/operator-app');

let app;
let browser;
let baseUrl;

before(async () => {
  app = await startOperatorApp();
  baseUrl = app.baseUrl;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
  await app.close();
});

test('operator browser flow uploads a clean DXF and renders its completed BOQ', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');

  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'clean-plan.dxf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#run-summary').textContent.includes('measurement: running'));
  await page.waitForFunction(() => document.querySelector('#run-summary').textContent.includes('boq: running'));
  await page.waitForFunction(() => document.querySelector('#run-summary').textContent.includes(': completed'));
  await page.waitForFunction(() => document.querySelectorAll('#boq-lines tr').length === 9);
  await page.waitForFunction(() => document.querySelector('#classification-review').textContent.includes('source objects classified'));

  assert.equal(await page.locator('#boq-lines tr').count(), 9);
  assert.match(await page.locator('#classification-review').textContent(), /Category.*Exact catalog item/s);
  const floorRow = page.locator('#boq-lines tr').filter({ hasText: 'Floor finish area' });
  assert.match(await floorRow.textContent(), /27\.72/);
  assert.match(await floorRow.textContent(), /measured/);
  assert.match(await floorRow.textContent(), /src_0001 v1/);
  assert.match(await floorRow.textContent(), /10A, 10C/);

  await page.getByRole('button', { name: 'Reprocess this source' }).click();
  await page.waitForFunction(() => document.querySelector('#run-summary').textContent.includes('run_0002: completed'));
  await page.waitForFunction(() => document.querySelectorAll('#boq-lines tr').length === 9);
  assert.match(await floorRow.textContent(), /27\.72/);
  await page.close();
});

test('operator interface explains an unsafe unit input and offers an explicit fallback', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');

  assert.equal(await page.locator('#fallback-unit').count(), 1);
  assert.match(await page.locator('#fallback-unit').textContent(), /Millimetres/);

  const clean = await readFile(join(__dirname, 'fixtures', 'clean-plan.dxf'), 'utf8');
  await page.locator('#drawing').setInputFiles({
    name: 'missing-units.dxf',
    mimeType: 'application/dxf',
    buffer: Buffer.from(clean.replace('9\n$INSUNITS\n70\n4\n', ''))
  });
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#run-summary').textContent.includes('failed'));

  assert.match(await page.locator('#message').textContent(), /We cannot tell which drawing unit was used/);
  assert.match(await page.locator('#message').textContent(), /missing-units\.dxf/);
  assert.equal(await page.locator('#boq-lines tr').count(), 0);
  await page.close();
});

test('operator can inspect and configure a vector PDF before reviewing its BOQ', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.locator('#drawing').setInputFiles({ name: 'vector-plan.dat', mimeType: 'application/octet-stream', buffer: await readFile(join(__dirname, 'fixtures', 'vector-plan.pdf')) });
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#pdf-setup').hidden === false);
  assert.match(await page.locator('#pdf-setup').textContent(), /ROOM 101/);
  await page.locator('#pdf-scale-page-1').fill('72');
  await page.locator('#pdf-region-pdf-p1-path-0001').check();
  await page.getByRole('button', { name: 'Confirm PDF scale and regions' }).click();
  await page.waitForFunction(() => document.querySelector('#boq-lines').textContent.includes('0.5'));
  assert.match(await page.locator('#boq-lines').textContent(), /pdf:p1:path:0001/);
  await page.close();
});

test('operator stops at the raster handoff for a mixed PDF and explains the blocked state', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.locator('#drawing').setInputFiles({ name: 'mixed-plan.pdf', mimeType: 'application/pdf', buffer: await readFile(join(__dirname, 'fixtures', 'mixed-plan.pdf')) });
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#message').textContent.match(/raster calibration|tracing/i));
  assert.equal(await page.locator('#pdf-setup').isHidden(), true);
  assert.equal(await page.locator('#boq-lines tr').count(), 0);
  await page.close();
});

test('operator browser flow displays project rollup and storey provenance', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByPlaceholder('Project name').fill('Browser multi-floor project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByPlaceholder('Building name').fill('Main building');
  await page.getByRole('button', { name: 'Add building' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '1');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.getByPlaceholder('Storey name').fill('Ground floor');
  await page.getByRole('button', { name: 'Add storey' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '2');
  assert.equal(await page.locator('#storey-select').inputValue(), '');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.selectOption('#storey-select', { label: 'Ground floor' });
  await page.locator('#typical-multiplier').fill('2');
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'clean-plan.dxf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#rollup-summary').textContent.includes('Browser multi-floor project'));
  await page.waitForFunction(() => document.querySelector('#rollup').hidden === false);
  const rollup = page.locator('#rollup');
  assert.match(await rollup.textContent(), /Main building \/ Ground floor/);
  assert.match(await rollup.textContent(), /src_\d+ v1/);
  assert.match(await rollup.textContent(), /Ground floor/);
  await page.close();
});

test('operator browser flow reassigns the current source and refreshes rollup provenance', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByPlaceholder('Project name').fill('Browser reassignment project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByPlaceholder('Building name').fill('Main building');
  await page.getByRole('button', { name: 'Add building' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '1');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.getByPlaceholder('Storey name').fill('Ground floor');
  await page.getByRole('button', { name: 'Add storey' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '2');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.getByPlaceholder('Storey name').fill('First floor');
  await page.getByRole('button', { name: 'Add storey' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '3');
  assert.equal(await page.locator('#storey-select').inputValue(), '');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.selectOption('#storey-select', { label: 'Ground floor' });
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'clean-plan.dxf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#rollup').hidden === false);
  await page.selectOption('#storey-select', { label: 'First floor' });
  await page.locator('#typical-multiplier').fill('2');
  await page.getByRole('button', { name: 'Reassign current source' }).click();
  await page.waitForFunction(() => document.querySelector('#run-summary').textContent.includes(': completed'));
  await page.waitForFunction(() => document.querySelector('#rollup').textContent.includes('First floor'));
  const rollup = page.locator('#rollup');
  assert.match(await rollup.textContent(), /First floor: 55.44 m²/);
  assert.match(await rollup.textContent(), /typical-storey multiplier: ×2/);
  await page.close();
});

test('operator surfaces building creation network failures', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByPlaceholder('Project name').fill('Browser error project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.route('**/api/projects/*/buildings', (route) => route.abort());
  await page.getByPlaceholder('Building name').fill('Main building');
  await page.getByRole('button', { name: 'Add building' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').textContent.includes('Building creation failed'));
  await page.close();
});

test('operator can select any source revision and reassign it to building or project scope', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByPlaceholder('Project name').fill('Browser source revision project');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByPlaceholder('Building name').fill('Main building');
  await page.getByRole('button', { name: 'Add building' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '1');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.getByPlaceholder('Storey name').fill('Ground floor');
  await page.getByRole('button', { name: 'Add storey' }).click();
  await page.waitForFunction(() => document.querySelector('#project-status').dataset.revision === '2');
  await page.selectOption('#building-select', { label: 'Main building' });
  await page.selectOption('#storey-select', { label: 'Ground floor' });
  await page.locator('#source-sheet').fill('A-GROUND');
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'clean-plan.dxf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelector('#rollup').hidden === false);

  await page.locator('#source-sheet').fill('A-SECOND');
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'clean-plan.dxf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#source-document-select option').length === 3);
  assert.match(await page.locator('#source-document-select').textContent(), /A-GROUND/);

  await page.locator('#source-document-select').selectOption({ index: 1 });
  await page.selectOption('#reassignment-scope', 'building');
  await page.locator('#typical-multiplier').fill('1');
  await page.getByRole('button', { name: 'Reassign current source' }).click();
  await page.waitForFunction(() => document.querySelector('#reassign-source').dataset.state === 'running');
  await page.waitForFunction(() => document.querySelector('#rollup').textContent.includes('Main building: 27.72 m²'));
  assert.match(await page.locator('#rollup').textContent(), /Main building: 27.72 m²/);

  await page.selectOption('#reassignment-scope', 'project');
  await page.getByRole('button', { name: 'Reassign current source' }).click();
  await page.waitForFunction(() => document.querySelector('#reassign-source').dataset.state === 'running');
  await page.waitForFunction(() => document.querySelector('#rollup').textContent.includes('Project scope: 27.72 m²'));
  assert.match(await page.locator('#rollup').textContent(), /Project scope: 27.72 m²/);
  await page.close();
});
