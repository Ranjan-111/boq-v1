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

  assert.equal(await page.locator('#boq-lines tr').count(), 9);
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
