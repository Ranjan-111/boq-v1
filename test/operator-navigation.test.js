const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
const { startOperatorApp } = require('../test-support/operator-app');
const { show, press } = require('../test-support/operator-page');

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

test('exactly one view is on screen at a time', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  /* Before the rebuild the sidebar only scrolled: every section rendered at
     once, so a page dump ran to nine headings and a refusal notice on the
     approval panel read as a stray line of text far below the fold. */
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('.view[data-view]')].filter((view) => !view.hidden).map((view) => view.dataset.view));
  assert.deepEqual(visible, ['project']);

  await show(page, 'export');
  const afterNavigation = await page.evaluate(() =>
    [...document.querySelectorAll('.view[data-view]')].filter((view) => !view.hidden).map((view) => view.dataset.view));
  assert.deepEqual(afterNavigation, ['export']);
  await page.close();
});

test('a step that is not reachable yet says why, in the nav and on the view', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  const locked = await page.evaluate(() =>
    [...document.querySelectorAll('.nav-item[data-view]')]
      .filter((item) => item.dataset.reachable === 'false')
      .map((item) => ({ view: item.dataset.view, reason: item.title })));
  assert.ok(locked.length > 0, 'a fresh page has steps that are not reachable yet');
  for (const item of locked) {
    assert.ok(item.reason && item.reason.length > 0, `${item.view} must explain why it is locked`);
  }

  await show(page, 'review');
  assert.match(await page.locator('#view-review .view-locked').textContent(), /Measure a drawing/);
  await page.close();
});

test('a view can be linked to directly', async () => {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}#exceptions`);
  await page.waitForFunction(() => !document.querySelector('.view[data-view="exceptions"]').hidden);
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll('.view[data-view]')].filter((view) => !view.hidden).map((view) => view.dataset.view));
  assert.deepEqual(visible, ['exceptions']);
  await page.close();
});

test('measuring a drawing unlocks the steps it makes reachable and none it does not', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await show(page, 'upload');
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'clean-plan.dxf'));
  await press(page, 'Measure this drawing');
  await page.waitForFunction(() => document.querySelectorAll('#boq-lines tr').length === 9);

  const reachable = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.nav-item[data-view]')].map((item) => [item.dataset.view, item.dataset.reachable === 'true'])));
  assert.equal(reachable.review, true);
  assert.equal(reachable.workspace, true);
  /* This drawing was measured without a project, which the server allows. A
     project rollup aggregates across buildings and storeys, so with no project
     there is nothing to roll up -- the step stays locked and says so, rather
     than showing an empty table as though something had gone wrong. */
  assert.equal(reachable.rollup, false);
  /* A vector DXF never needs calibration, so that step stays locked rather
     than presenting an empty canvas as if something were expected. */
  assert.equal(reachable.raster, false);
  await page.close();
});

test('a page served by a different build than the server says so', async () => {
  const page = await browser.newPage();
  /* Three days were lost to a running server that predated the feature being
     tested. A stale process must announce itself rather than looking like a
     broken feature. */
  await page.route('**/api/build', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ buildId: 'deadbeefcafe' })
  }));
  await page.goto(baseUrl);
  await page.waitForSelector('#build-stale');
  assert.match(await page.locator('#build-stale').textContent(), /different build/i);
  await page.close();
});

test('a matching build raises no warning', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#build-stale').count(), 0);
  await page.close();
});
