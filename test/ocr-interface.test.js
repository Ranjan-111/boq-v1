const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');
const { startOperatorApp } = require('../test-support/operator-app');

let app;
let browser;

before(async () => {
  app = await startOperatorApp();
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
  await app.close();
});

async function openRasterPage(engineScript) {
  const page = await browser.newPage();
  await page.addInitScript(engineScript);
  await page.goto(app.baseUrl);
  await page.waitForLoadState('networkidle');
  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/source-documents'));
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'raster-200x100.png'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  const submission = await (await uploadResponse).json();
  await page.waitForFunction(() => document.querySelector('#ocr-workflow').hidden === false);
  return { page, submission };
}

test('operator sees OCR progress and stores evidence without changing the drawing gate', async () => {
  const { page, submission } = await openRasterPage(() => {
    window.__BOQ_OCR_ENGINE__ = {
      id: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng', assetHash: 'fixture-hash',
      async prepare({ onProgress }) {
        onProgress({ loaded: 25, total: 100, percent: 25, message: 'Downloading fixture model…' });
        await new Promise((resolve) => setTimeout(resolve, 30));
        onProgress({ loaded: 100, total: 100, percent: 100, message: 'Fixture model ready.' });
        return { assetHash: 'fixture-hash', totalBytes: 100 };
      },
      async recognize() { return { observations: [{ text: '1200 mm', score: 0.94, poly: [[5, 5], [75, 5], [75, 20], [5, 20]] }] }; },
      async dispose() {}
    };
  });
  await page.evaluate(() => {
    window.__ocrStates = [];
    const status = document.querySelector('#ocr-status');
    new MutationObserver(() => window.__ocrStates.push(status.dataset.state)).observe(status, { attributes: true, childList: true, subtree: true });
  });
  const resultResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/ocr-results'));
  await page.getByRole('button', { name: 'Recognize selected crop' }).click();
  const saved = await (await resultResponse).json();
  await page.waitForFunction(() => document.querySelector('#ocr-status').dataset.state === 'completed');
  assert.ok((await page.evaluate(() => window.__ocrStates)).includes('downloading'));
  assert.match(await page.locator('#ocr-results').textContent(), /1200 mm.*94\.0%.*observed/i);
  assert.equal(saved.observations[0].semanticEvidence[0].state, 'needs_review');
  assert.equal(saved.processingRun.status, 'awaiting_calibration');
  assert.equal(saved.processingRun.exportable, false);
  assert.equal(saved.processingRun.boq, null);
  assert.equal(saved.processingRun.id, submission.processingRun.id);
  await page.close();
});

test('operator sees OCR failure while the non-OCR drawing workflow remains available', async () => {
  const { page, submission } = await openRasterPage(() => {
    window.__BOQ_OCR_ENGINE__ = {
      id: 'fake', engineVersion: 'fake-1', modelVersion: 'fixture-1', language: 'eng', assetHash: 'fixture-hash',
      async prepare() { return { assetHash: 'fixture-hash', totalBytes: 1 }; },
      async recognize() { throw Object.assign(new Error('worker stopped'), { code: 'failed' }); },
      async dispose() {}
    };
  });
  await page.getByRole('button', { name: 'Recognize selected crop' }).click();
  await page.waitForFunction(() => document.querySelector('#ocr-status').dataset.state === 'failed');
  assert.match(await page.locator('#ocr-status').textContent(), /worker stopped/i);
  assert.equal(await page.locator('#raster-workflow').isVisible(), true);
  const run = await (await fetch(`${app.baseUrl}/api/runs/${submission.processingRun.id}`)).json();
  assert.equal(run.status, 'awaiting_calibration');
  assert.equal(run.ocr.status, 'idle');
  await page.close();
});

test('operator can OCR a born-digital PDF page while native positioned text remains canonical', async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__BOQ_OCR_ENGINE__ = {
      id: 'fake', engineVersion: 'fake-pdf-1', modelVersion: 'fixture-pdf-1', language: 'eng', assetHash: 'fixture-pdf-hash',
      async prepare() { return { assetHash: 'fixture-pdf-hash', totalBytes: 1 }; }, async smoke() {},
      async recognize() { return { observations: [{ text: 'ROOM 101', score: .99, poly: [[10, 10], [22, 10], [22, 70], [10, 70]] }] }; }, async dispose() {}
    };
  });
  await page.goto(app.baseUrl); await page.waitForLoadState('networkidle');
  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/source-documents'));
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'vector-plan.pdf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  const submission = await (await uploadResponse).json();
  await page.waitForFunction(() => document.querySelector('#ocr-workflow').hidden === false && Boolean(document.querySelector('#raster-pdf-canvas').style.width));
  assert.match(await page.locator('#raster-workflow-title').textContent(), /PDF page preview/i);
  const resultResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/ocr-results'));
  await page.getByRole('button', { name: 'Recognize selected crop' }).click();
  const saved = await (await resultResponse).json();
  assert.equal(saved.observations[0].status, 'suppressed_by_native');
  assert.equal(saved.observations[0].nativeMatchId, 'pdf:p1:text:0001');
  assert.equal(saved.processingRun.id, submission.processingRun.id);
  assert.equal(saved.processingRun.status, 'awaiting_setup');
  assert.equal(saved.processingRun.boq, null);
  await page.close();
});

test('hybrid PDF keeps its pages available to OCR while deterministic BOQ export stays blocked', async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__BOQ_OCR_ENGINE__ = {
      id: 'fake', engineVersion: 'fake-mixed-1', modelVersion: 'fixture-mixed-1', language: 'eng', assetHash: 'fixture-mixed-hash',
      async prepare() { return { assetHash: 'fixture-mixed-hash', totalBytes: 1 }; }, async smoke() {},
      async recognize() { return { observations: [{ text: 'raster note', score: .9, poly: [[1, 1], [8, 1], [8, 6], [1, 6]] }] }; }, async dispose() {}
    };
  });
  await page.goto(app.baseUrl); await page.waitForLoadState('networkidle');
  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/source-documents'));
  await page.locator('#drawing').setInputFiles(join(__dirname, 'fixtures', 'mixed-plan.pdf'));
  await page.getByRole('button', { name: 'Create processing run' }).click();
  const submission = await (await uploadResponse).json();
  await page.waitForFunction(() => document.querySelector('#message').classList.contains('error') && document.querySelector('#ocr-workflow').hidden === false && Boolean(document.querySelector('#raster-pdf-canvas').style.width));
  assert.match(await page.locator('#message').textContent(), /mixed|hybrid/i);
  const resultResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/ocr-results'));
  await page.getByRole('button', { name: 'Recognize selected crop' }).click();
  const saved = await (await resultResponse).json();
  assert.equal(saved.processingRun.id, submission.processingRun.id);
  assert.equal(saved.processingRun.status, 'failed');
  assert.equal(saved.processingRun.exportable, false);
  assert.equal(saved.processingRun.boq, null);
  await page.close();
});
