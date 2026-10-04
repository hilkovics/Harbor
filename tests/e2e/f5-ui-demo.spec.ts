import { expect, test } from '@playwright/test';

// Predstih F5 (T05-06): demo stránka s ContractsPanel (Ponuky / Aktívne / História, prázdny stav, karty všetkých stavov),
// TopHUD s kladným aj záporným denným delta a XP, GameOverModal „Bankrot" a toasty kontraktov. Nespúšťa hru ani simuláciu —
// dev server servíruje statické demo src/ui/__demo__/f5-ui-demo.html. Screenshot slúži na vizuálnu kontrolu voči prototypu
// design/ui/game-ui.source.html (`contracts`, `contracts_empty`, overlay `gameover`, toasty).
const DEMO_URL = '/src/ui/__demo__/f5-ui-demo.html';
const SCREENSHOTS = 'tests/e2e/__screenshots__';

test('F5 UI demo: panel kontraktov, HUD delta + XP, bankrot a toasty sa vykreslia a reagujú', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(DEMO_URL);
  const stage = page.getByTestId('stage');
  await expect(stage.getByRole('complementary', { name: 'Kontrakty' })).toBeVisible();
  // Písma (Inter, JetBrains Mono) musia byť načítané, inak sa screenshot líši šírkami textu.
  await page.evaluate(() => document.fonts.ready);
  // Modál Bankrot si po zobrazení vezme fokus na „Nová hra" (bez posunu stránky).
  await expect(page.getByTestId('game-over').locator('[data-action="new-game"]')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // --- Panel v hre: záložka Ponuky, 3 karty, popisky záložiek s počtami -------------------------------------------------
  const panel = stage.getByRole('complementary', { name: 'Kontrakty' });
  await expect(panel.getByRole('tab')).toHaveText(['Ponuky · 3', 'Aktívne · 6', 'História']);
  await expect(panel.getByRole('tab', { name: /Ponuky/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('article.contract-card')).toHaveCount(3);
  const offer = panel.locator('[data-contract-id="101"]');
  await expect(offer.locator('[data-field="cargo"]')).toHaveText('Kontajnery');
  await expect(offer.locator('[data-field="volume"]')).toHaveText('1,200 TEU');
  await expect(offer.locator('[data-field="reward"]')).toHaveText('+$184,000');
  await expect(offer.locator('[data-field="sla"]')).toHaveText('6 dní');
  await expect(offer.locator('[data-field="ship"]')).toHaveText('Panamax');
  await expect(offer.locator('[data-field="status"]')).toHaveText('Ponuka');
  await expect(offer.locator('[data-field="expiry"]')).toHaveText('Expiruje o 1 d 4 h');
  // čísla majú tabular-nums (dedí od panelu)
  await expect(offer.locator('[data-field="reward"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');

  // --- Zablokované „Prijať" s dôvodom; „Odmietnuť" funguje ---------------------------------------------------------------------
  const blocked = panel.locator('[data-contract-id="102"]');
  await expect(blocked.locator('[data-action="accept"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(blocked.locator('[data-action="accept"]')).toHaveAttribute('title', 'Chýba sklad pre sypký náklad.');
  await expect(blocked.locator('[data-field="accept-reason"]')).toHaveText('Chýba sklad pre sypký náklad.');
  const stageLabel = stage.locator('.f5-demo__map-label');
  await blocked.locator('[data-action="accept"]').click({ force: true });
  await expect(stageLabel).toContainText('Posledná akcia: —');
  await offer.locator('[data-action="accept"]').click();
  await expect(stageLabel).toContainText('onAccept(101)');
  await offer.locator('[data-action="decline"]').click();
  await expect(stageLabel).toContainText('onDecline(101)');
  await expect(panel.locator('[data-contract-id="103"] [data-field="expiry"]')).toHaveText('Expiruje o 5 h');
  await expect(panel.locator('[data-contract-id="103"] [data-field="expiry"]')).toHaveClass(/contract-card__expiry--soon/);

  // --- HUD v hre: kladná delta so znamienkom a XP ---------------------------------------------------------------------------------
  await expect(stage.locator('[data-field="cash"]')).toHaveText('$1,234,560');
  await expect(stage.locator('[data-field="cash-delta"]')).toHaveText('+$12,300/deň');
  await expect(stage.locator('[data-field="cash-delta"]')).toHaveClass(/top-hud__delta--pos/);
  await expect(stage.locator('[data-field="xp"]')).toHaveText('340 XP');

  // --- Toasty: výplata (success), penalizácia (warning), fail (danger) -------------------------------------------------------------
  const toasts = stage.getByRole('region', { name: 'Oznámenia' });
  await expect(toasts.locator('.toast')).toHaveCount(3);
  await expect(toasts.locator('[data-tone="success"] .toast__icon use')).toHaveAttribute('href', /#ic_check$/);
  await expect(toasts.locator('[data-tone="warning"] .toast__icon use')).toHaveAttribute('href', /#ic_warning$/);
  await expect(toasts.locator('[data-tone="danger"] .toast__icon use')).toHaveAttribute('href', /#ic_blocked$/);

  // --- Prepnutie záložky v hre volá onTabChange; História nemá tlačidlá Prijať/Odmietnuť ---------------------------------------
  await panel.getByRole('tab', { name: /Aktívne/ }).click();
  await expect(stageLabel).toContainText('onTabChange(active)');
  await expect(panel.getByRole('tab', { name: /Aktívne/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('article.contract-card')).toHaveCount(6);
  await expect(panel.locator('[data-action="accept"]')).toHaveCount(0);
  await panel.getByRole('tab', { name: /Ponuky/ }).click();
  await stage.screenshot({ path: `${SCREENSHOTS}/f5-ui-demo-stage.png` });

  // --- Aktívne: progres unloaded / exported, penalizácie, ohrozené, po termíne --------------------------------------------------------
  const active = page.getByTestId('panel-active');
  const unloading = active.locator('[data-contract-id="203"]');
  await expect(unloading.locator('[data-field="status"]')).toHaveText('Vykladá sa');
  await expect(unloading.locator('[data-field="unloaded-value"]')).toHaveText('1,820 / 2,400 TEU');
  await expect(unloading.locator('[data-field="exported-value"]')).toHaveText('640 / 2,400 TEU');
  await expect(unloading.locator('[data-field="unloaded"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '76');
  await expect(unloading.locator('[data-field="exported"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '27');
  await expect(unloading.locator('[data-field="penalties-value"]')).toHaveText('−$8,800');
  await expect(active.locator('[data-contract-id="205"] [data-field="status"]')).toHaveText('Ohrozené');
  await expect(active.locator('[data-contract-id="205"] [data-field="sla"]')).toHaveText('8 h');
  await expect(active.locator('[data-contract-id="205"] [data-field="sla"]')).toHaveAttribute('data-tone', 'danger');
  await expect(active.locator('[data-contract-id="204"] [data-field="sla"]')).toHaveAttribute('data-tone', 'ok');
  await expect(active.locator('[data-contract-id="206"] [data-field="status"]')).toHaveText('Po termíne');
  await expect(active.locator('[data-contract-id="202"] [data-field="ship"]')).toHaveText('Feeder · o 5 h');

  // --- História: výplata po penalizáciách, zlyhaný kontrakt so záporným výsledkom -------------------------------------------------
  const history = page.getByTestId('panel-history');
  await expect(history.locator('[data-contract-id="301"] [data-field="reward"]')).toHaveText('+$74,000');
  await expect(history.locator('[data-contract-id="301"] [data-field="sla"]')).toHaveText('včas');
  await expect(history.locator('[data-contract-id="302"] [data-field="reward"]')).toHaveText('+$44,400');
  await expect(history.locator('[data-contract-id="302"] [data-field="sla"]')).toContainText('neskôr');
  await expect(history.locator('[data-contract-id="303"] [data-field="reward"]')).toHaveText('−$24,000');
  await expect(history.locator('[data-contract-id="303"] [data-field="status"]')).toHaveText('Zlyhané');
  await expect(history.locator('[data-contract-id="304"] [data-field="status"]')).toHaveText('Expirovaná');
  await expect(history.locator('[data-contract-id="304"] [data-field="sla"]')).toHaveCount(0);

  // --- Prázdny stav (vzor contracts_empty) -------------------------------------------------------------------------------------------
  const empty = page.getByTestId('panel-empty');
  await expect(empty.getByRole('tab')).toHaveText(['Ponuky · 0', 'Aktívne · 6', 'História']);
  await expect(empty.locator('[data-field="empty-title"]')).toHaveText('Žiadne ponuky');
  await expect(empty.locator('[data-field="empty-text"]')).toHaveText('Ďalšia ponuka príde o 2 dni.');
  await expect(empty.locator('article.contract-card')).toHaveCount(0);

  // --- Galéria: každý stav karty aspoň raz -------------------------------------------------------------------------------------------------
  const gallery = page.getByTestId('gallery');
  await expect(gallery.locator('article.contract-card')).toHaveCount(13);
  for (const state of ['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed', 'failed', 'expired']) {
    await expect(gallery.locator(`[data-state="${state}"]`).first()).toBeVisible();
  }

  // --- HUD: kladná delta, záporná delta pri cash < 0, zástupné hodnoty ----------------------------------------------------------------------
  const positive = page.getByTestId('hud-positive');
  await expect(positive.locator('[data-field="cash-delta"]')).toHaveText('+$12,300/deň');
  await expect(positive.locator('[data-field="cash-delta"]')).toHaveCSS('color', 'rgb(53, 194, 122)');
  const negative = page.getByTestId('hud-negative');
  await expect(negative.locator('[data-field="cash"]')).toHaveText('−$48,200');
  await expect(negative.locator('[data-field="cash-delta"]')).toHaveText('−$6,400/deň');
  await expect(negative.locator('[data-field="cash-delta"]')).toHaveClass(/top-hud__delta--neg/);
  await expect(negative.locator('.top-hud')).toHaveAttribute('data-debt', 'true');
  const placeholder = page.getByTestId('hud-placeholder');
  await expect(placeholder.locator('[data-field="cash-delta"]')).toHaveText('—/deň');
  await expect(placeholder.locator('[data-field="xp"]')).toHaveText('— XP');

  // --- GameOver „Bankrot" ----------------------------------------------------------------------------------------------------------------------
  const gameOver = page.getByTestId('game-over');
  const dialog = gameOver.getByRole('alertdialog', { name: 'Bankrot' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-field="text"]')).toHaveText('Hotovosť zostala záporná 30 dní po sebe. Banka zablokovala účet prístavu.');
  await expect(dialog.locator('[data-field="days"]')).toHaveText('142');
  await expect(dialog.locator('[data-field="contracts"]')).toHaveText('87');
  await expect(dialog.locator('[data-field="xp"]')).toHaveText('12,340 XP');
  await expect(dialog.locator('[data-field="days"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await dialog.locator('[data-action="new-game"]').click();
  await expect(gameOver.locator('[data-field="last-action"]')).toHaveText('Posledná akcia: onNewGame()');
  await dialog.locator('[data-action="load"]').click();
  await expect(gameOver.locator('[data-field="last-action"]')).toHaveText('Posledná akcia: onLoadGame()');

  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${SCREENSHOTS}/f5-ui-demo.png`, fullPage: true });

  expect(errors).toEqual([]);
});
