import { expect, test } from '@playwright/test';

// R5 / TR5-03 render demo (`src/render/__demo__/r5-types.html`): typy kontajnerov (reefer, open top, flat rack, tank, OOG), reefer rack so zásuvkami
// on/off/alarm/empty a reach stacker s OOG flat rackom. Test kontroluje, že sa demo načíta bez chýb; screenshot ide do `tests/e2e/__screenshots__/`.

test('R5 demo: typy kontajnerov, reefer rack, reach stacker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/src/render/__demo__/r5-types.html?scene=types');
  await page.waitForSelector('body[data-demo-ready="true"]');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r5-types-demo.png' });
  expect(errors).toEqual([]);
});
