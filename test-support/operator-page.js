/* The operator interface now has real views: exactly one is on screen at a
   time, and the sidebar navigates between them. Before the rebuild every
   section was rendered at once -- the sidebar only scrolled -- so a test could
   click any control from anywhere. It cannot any more, and that is the point:
   the operator could not find anything on a page nine sections long.

   `show` puts the page on the view that owns a control, the way a person
   would, and waits for it to actually be on screen. */

const VIEW_OF_BUTTON = {
  'Start working': 'project',
  'Open': 'project',
  'Add building': 'project',
  'Add storey': 'project',
  'Reassign current source': 'project',
  'Measure this drawing': 'upload',
  'Reprocess this source': 'upload',
  'Confirm PDF scale and regions': 'upload',
  'Confirm calibration': 'raster',
  'Correct calibration': 'raster',
  'Close traced region': 'raster',
  'Confirm region': 'raster',
  'Add point': 'raster',
  'Clear points': 'raster',
  'Recognize selected crop': 'raster',
  'Stop OCR': 'raster',
  'Approve BOQ version': 'export'
};

async function show(page, view) {
  await page.evaluate((name) => {
    const item = document.querySelector(`.nav-item[data-view="${name}"]`);
    if (item) item.click();
  }, view);
  await page.waitForFunction(
    (name) => !document.querySelector(`.view[data-view="${name}"]`)?.hidden,
    view
  );
}

/* Click a named button, navigating to its view first. */
async function press(page, name) {
  const view = VIEW_OF_BUTTON[name];
  if (view) await show(page, view);
  await page.getByRole('button', { name, exact: true }).click();
}

module.exports = { show, press, VIEW_OF_BUTTON };
