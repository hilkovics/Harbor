import { expect, test } from '@playwright/test';

// Boot smoke: hra sa načíta — canvas mapy, HUD s hotovosťou a (vizuálne skrytý) nadpis; screenshot slúži na
// vizuálnu kontrolu (pobrežie, starter parcela, HUD).
test('hra sa načíta a zobrazí mapu a HUD', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Modular Harbor' })).toBeAttached();
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await expect(page.getByRole('banner', { name: 'Stav prístavu' })).toBeVisible();
  await expect(page.locator('[data-field="cash"]')).toHaveText('$1,200,000');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/boot.png', fullPage: true });

  expect(errors).toEqual([]);
});
