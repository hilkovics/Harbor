import { expect, test } from '@playwright/test';

// F7 / TF7-02 render demo (`src/render/__demo__/f7-parcels.html`): parcely vlastnená / prenajatá / na predaj s cenovkou + hover.
test.use({ viewport: { width: 1920, height: 1080 } });

test('F7 demo: stavy parciel, cenovky, hover', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/src/render/__demo__/f7-parcels.html');
  await page.waitForSelector('body[data-demo-ready="true"]');
  const report = await page.evaluate(() => {
    const { parcels } = window.__f7Demo!.renderer;
    return {
      hovered: parcels.hovered,
      west: parcels.priceLabelOf('west_quay'),
      starter: parcels.priceLabelOf('starter') ?? null,
      at: parcels.parcelAt({ x: 10, y: 20 }) ?? null,
      outside: parcels.parcelAt({ x: 0, y: 0 }) ?? null,
    };
  });
  expect(report).toEqual({ hovered: 'west_quay', west: '$320K', starter: null, at: 'west_quay', outside: null });
  await page.screenshot({ path: 'tests/e2e/__screenshots__/f7-parcels-demo.png' });
  expect(errors).toEqual([]);
});
