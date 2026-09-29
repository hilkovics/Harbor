import { expect, test } from '@playwright/test';

// Boot smoke: hra sa načíta a zobrazí hlavičku; screenshot slúži na vizuálnu kontrolu.
test('hra sa načíta a zobrazí nadpis', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Modular Harbor' })).toBeVisible();
  await page.screenshot({ path: 'tests/e2e/__screenshots__/boot.png', fullPage: true });
});
