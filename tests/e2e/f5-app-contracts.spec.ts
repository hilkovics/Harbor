import { expect, test, type Page } from '@playwright/test';

// F5 e2e (T05-07): kontrakty v skutočnej hre. Ikona kontraktov v TopHUD otvorí ContractsPanel (Esc / × / skratka C ho
// zavrie), ponuky sú karty z `world.contracts`, „Prijať“ pošle AcceptContract (karta prejde do Aktívnych, toast
// „Kontrakt prijatý“), prvý deň prinesie toast „Nové ponuky kontraktov“ s akciou „Zobraziť“. Screenshot
// `f5-app-contracts.png` ukazuje hru s otvoreným panelom.
//
// Celá vertikála (loď → vykládka → export → výplata) je v `f5-vertical-slice.spec.ts` (T05-09).

const SCREENSHOT = 'tests/e2e/__screenshots__/f5-app-contracts.png';
const OFFERS = 6;

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.contracts().length > 0);
  return errors;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Kontrakty' });
const contractsButton = (page: Page) => page.locator('[data-field="panel-contracts"]');

test('F5 app: ikona kontraktov otvorí panel s ponukami, prijatie cez UI, Esc a C ho zavrú / otvoria', async ({ page }) => {
  const errors = await openGame(page);

  // štart: toast „Nové ponuky“ (zlúčený), panel zatvorený, HUD ukazuje XP a deltu dňa (nie zástupné `—`)
  const offersToast = page.locator('.toasts .toast').filter({ hasText: 'Nové ponuky kontraktov' });
  await expect(offersToast).toHaveCount(1);
  await expect(offersToast.locator('[data-field="toast-text"]')).toHaveText(`${String(OFFERS)} nových ponúk`);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('[data-field="xp"]')).toHaveText('0 XP');
  await expect(page.locator('[data-field="cash-delta"]')).toContainText('/deň');
  await expect(page.locator('[data-field="cash-delta"]')).not.toHaveAttribute('data-placeholder', 'true');

  // akcia „Zobraziť“ v toaste otvorí panel; ikona je stlačená
  await offersToast.locator('[data-action="show"]').click();
  await expect(panel(page)).toBeVisible();
  await expect(contractsButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).locator('article.contract-card')).toHaveCount(OFFERS);
  await expect(panel(page).getByRole('tab')).toHaveText([`Ponuky · ${String(OFFERS)}`, /^Aktívne/, /^História/]);

  // karta ponuky: názov, objem s jednotkou, odmena, loď z defov
  const first = panel(page).locator('article.contract-card').first();
  await expect(first.locator('[data-field="cargo"]')).toHaveText('Kontajnery');
  await expect(first.locator('[data-field="volume"]')).toContainText('TEU');
  await expect(first.locator('[data-field="reward"]')).toContainText('$');
  await expect(first.locator('[data-field="ship"]')).toHaveText(/Feeder|Handysize/);
  await expect(first.locator('[data-action="accept"]')).not.toHaveAttribute('aria-disabled', 'true');

  // screenshot: hra s otvoreným panelom kontraktov
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: SCREENSHOT, fullPage: true });

  // Prijať cez UI: karta zmizne z ponúk, pribudne medzi aktívne, toast „Kontrakt prijatý“, sim má kontrakt `accepted`
  const firstId = await page.evaluate(() => window.__sim!.contracts()[0]!.id);
  await first.locator('[data-action="accept"]').click();
  await expect(panel(page).getByRole('tab', { name: /Ponuky/ })).toHaveText(`Ponuky · ${String(OFFERS - 1)}`);
  await expect(panel(page).getByRole('tab', { name: /Aktívne/ })).toHaveText('Aktívne · 1');
  await expect.poll(() => page.evaluate((id) => window.__sim!.contracts().find((contract) => contract.id === id)?.state, firstId)).toMatch(/^(accepted|ship_en_route)$/);
  await expect(page.locator('.toasts .toast').filter({ hasText: 'Kontrakt prijatý' })).toHaveCount(1);
  await panel(page).getByRole('tab', { name: /Aktívne/ }).click();
  await expect(panel(page).locator('article.contract-card')).toHaveCount(1);
  await expect(panel(page).locator('article.contract-card [data-field="status"]')).toHaveText(/Prijaté|Loď na ceste/);

  // Odmietnuť: ponuka zanikne
  await panel(page).getByRole('tab', { name: /Ponuky/ }).click();
  await panel(page).locator('article.contract-card [data-action="decline"]').first().click();
  await expect(panel(page).locator('article.contract-card')).toHaveCount(OFFERS - 2);

  // Esc zavrie, C otvorí, × zavrie
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(contractsButton(page)).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('KeyC');
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Zavrieť kontrakty' }).click();
  await expect(panel(page)).toHaveCount(0);
  await contractsButton(page).click();
  await expect(panel(page)).toBeVisible();

  expect(errors).toEqual([]);
});

test('F5 app: dev hook prijme prvú ponuku a `contracts()` ukáže jej stav; DEV tlačidlo spawnu lode v hre nie je', async ({ page }) => {
  const errors = await openGame(page);
  await expect(page.getByRole('button', { name: /Spawn .*\(DEV\)/ })).toHaveCount(0);
  const accepted = await page.evaluate(() => window.__sim!.acceptFirstOffer());
  expect(accepted).not.toBeNull();
  await expect
    .poll(() => page.evaluate((id) => window.__sim!.contracts().find((contract) => contract.id === id)?.state, accepted))
    .toMatch(/^(accepted|ship_en_route)$/);
  expect(errors).toEqual([]);
});
