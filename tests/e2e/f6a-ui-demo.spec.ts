import { expect, test } from '@playwright/test';

// T6A-07: demo stránka s ContractsPanel (export booking, spoločná karta roundtripu), inšpektormi (sklad import / export, loď
// s nákladom podľa smeru a lashingom) a toastmi nových udalostí exportu. Nespúšťa hru ani simuláciu — dev server servíruje
// statické demo src/ui/__demo__/f6a-ui-demo.html. Screenshoty slúžia na vizuálnu kontrolu voči prototypu
// design/ui/game-ui.source.html (`contracts`, `insp_yard`, toasty).
const DEMO_URL = '/src/ui/__demo__/f6a-ui-demo.html';
const SCREENSHOTS = 'tests/e2e/__screenshots__';

test('F6a UI demo: export booking, roundtrip, inšpektory a toasty sa vykreslia a reagujú', async ({ page }) => {
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
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // --- Panel v hre: Ponuky — roundtrip je jedna karta, počty záložiek sú počty kariet --------------------------------------
  const panel = stage.getByRole('complementary', { name: 'Kontrakty' });
  await expect(panel.getByRole('tab')).toHaveText(['Ponuky · 3', 'Aktívne · 4', 'História']);
  await expect(panel.locator('article.contract-card')).toHaveCount(3);
  const roundtrip = panel.locator('article[data-voyage-id="111"]');
  await expect(roundtrip).toHaveAttribute('data-kind', 'roundtrip');
  await expect(roundtrip.locator('[data-field="cargo"]')).toHaveText('Import + export · Kontajnery');
  await expect(roundtrip.locator('[data-field="volume"]')).toHaveText('72 TEU');
  await expect(roundtrip.locator('[data-field="reward"]')).toHaveText('+$276,000');
  await expect(roundtrip.locator('[data-field="reward"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(roundtrip.locator('section.contract-card__part')).toHaveCount(2);
  await expect(roundtrip.locator('[data-field="import-title"]')).toHaveText('Import');
  await expect(roundtrip.locator('[data-field="export-title"]')).toHaveText('Export → Rotterdam');
  await expect(roundtrip.locator('[data-field="import-reward"]')).toHaveText('+$180,000');
  await expect(roundtrip.locator('[data-field="export-reward"]')).toHaveText('+$96,000');
  await expect(roundtrip.locator('[data-field="import-sla"]')).toHaveText('4 dni');
  await expect(roundtrip.locator('[data-field="export-sla"]')).toHaveText('3 dni');
  await expect(roundtrip.locator('[data-field="export-cutoff"]')).toHaveText('Cut-off 12 h pred príchodom lode');
  await expect(roundtrip.locator('[data-field="expiry"]')).toHaveText('Expiruje o 1 d 4 h');

  // „Prijať oba“ / „Odmietnuť oba“: jeden pár tlačidiel, callback dostane id prvého kontraktu skupiny (import)
  const stageLabel = stage.locator('.f6a-demo__map-label');
  await expect(roundtrip.locator('[data-action="accept"]')).toHaveCount(1);
  await expect(roundtrip.locator('[data-action="accept"]')).toHaveText('Prijať oba');
  await expect(roundtrip.locator('[data-action="decline"]')).toHaveText('Odmietnuť oba');
  await roundtrip.locator('[data-action="accept"]').click();
  await expect(stageLabel).toContainText('onAccept(111)');
  await roundtrip.locator('[data-action="decline"]').click();
  await expect(stageLabel).toContainText('onDecline(111)');

  // Export-only ponuka s dôvodom odmietnutia: tlačidlo zablokované, dôvod v title aj pod tlačidlami
  const blocked = panel.locator('[data-contract-id="113"]');
  await expect(blocked).toHaveAttribute('data-kind', 'export');
  await expect(blocked.locator('[data-field="cargo"]')).toHaveText('Export · Kontajnery');
  await expect(blocked.locator('[data-field="destination"]')).toHaveText('Hamburg');
  await expect(blocked.locator('[data-field="cutoff"]')).toHaveText('Cut-off 12 h pred príchodom lode');
  await expect(blocked.locator('[data-action="accept"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(blocked.locator('[data-action="accept"]')).toHaveAttribute('title', 'Pri kotvisku pre loď chýba žeriav na tento náklad');
  await expect(blocked.locator('[data-field="accept-reason"]')).toHaveText('Pri kotvisku pre loď chýba žeriav na tento náklad');
  await blocked.locator('[data-action="accept"]').click({ force: true });
  await expect(stageLabel).not.toContainText('onAccept(113)');
  // import ponuka ostala v pôvodnom tvare (bez booking sekcie)
  await expect(panel.locator('[data-contract-id="114"]')).toHaveAttribute('data-kind', 'import');
  await expect(panel.locator('[data-contract-id="114"] .contract-card__booking')).toHaveCount(0);

  // --- Toasty nových udalostí: cut-off, rolled, VGM hold, loď odplávala s exportom ------------------------------------------------
  const toasts = stage.getByRole('region', { name: 'Oznámenia' });
  await expect(toasts.locator('.toast')).toHaveCount(4);
  await expect(toasts.locator('[data-field="toast-title"]')).toHaveText([
    'Cut-off exportu o 6 h',
    '3 jednotky po cut-off (rolled)',
    'Chýba VGM',
    'Loď odplávala s exportom',
  ]);
  await expect(toasts.locator('[data-tone="success"] .toast__icon use')).toHaveAttribute('href', /#ic_ship$/);
  await expect(toasts.locator('.toast').nth(2).locator('.toast__icon use')).toHaveAttribute('href', /#ic_lock$/);
  await expect(toasts.locator('.toast').nth(0).locator('[data-field="toast-text"]')).toHaveText('#213 · Export 36 TEU → Gdańsk · dovezené 25 / 36 TEU');

  // --- Aktívne záložka v hre: 4 karty (roundtrip + tri export bookingy) --------------------------------------------------------------
  await panel.getByRole('tab', { name: /Aktívne/ }).click();
  await expect(stageLabel).toContainText('onTabChange(active)');
  await expect(panel.locator('article.contract-card')).toHaveCount(4);
  await expect(panel.locator('[data-action="accept"]')).toHaveCount(0);
  await panel.getByRole('tab', { name: /Ponuky/ }).click();
  await stage.screenshot({ path: `${SCREENSHOTS}/f6a-ui-demo-stage.png` });

  // --- Aktívne: roundtrip uprostred, export pred / po cut-off, prijatý ---------------------------------------------------------------
  const active = page.getByTestId('panel-active');
  await expect(active.getByRole('tab', { name: /Aktívne/ })).toHaveAttribute('aria-selected', 'true');
  const live = active.locator('article[data-voyage-id="211"]');
  await expect(live.locator('[data-field="import-status"]')).toHaveText('Vykladá sa');
  await expect(live.locator('[data-field="export-status"]')).toHaveText('Nakladá sa');
  await expect(live.locator('[data-field="import-unloaded-value"]')).toHaveText('30 / 48 TEU');
  await expect(live.locator('[data-field="import-exported-value"]')).toHaveText('11 / 48 TEU');
  await expect(live.locator('[data-field="export-arrived-value"]')).toHaveText('24 / 24 TEU');
  await expect(live.locator('[data-field="export-loaded-value"]')).toHaveText('9 / 24 TEU');
  await expect(live.locator('[data-field="export-cutoff"]')).toHaveText('Cut-off uplynul');
  await expect(live.locator('[data-field="export-counter-held"]')).toContainText('Zadržané (VGM)');
  await expect(live.locator('[data-field="export-counter-held"] .contract-card__counter-value')).toHaveText('1');
  await expect(live.locator('[data-field="export-counter-rolled"]')).toHaveCount(0);

  const before = active.locator('[data-contract-id="213"]');
  await expect(before.locator('[data-field="cargo"]')).toHaveText('Export · Kontajnery');
  await expect(before.locator('[data-field="destination"]')).toHaveText('Gdańsk');
  await expect(before.locator('[data-field="cutoff"]')).toHaveText('Cut-off o 5 h');
  await expect(before.locator('[data-field="cutoff"]')).toHaveAttribute('data-tone', 'warn');
  await expect(before.locator('[data-field="pending"]')).toHaveText('Ešte príde 9 TEU');
  await expect(before.locator('[data-field="arrived-value"]')).toHaveText('25 / 36 TEU');
  await expect(before.locator('[data-field="loaded-value"]')).toHaveText('0 / 36 TEU');
  await expect(before.locator('[data-field="status"]')).toHaveText('Loď na ceste');
  await expect(before.locator('[data-field="counter-held"] .contract-card__counter-value')).toHaveText('2');

  const after = active.locator('[data-contract-id="214"]');
  await expect(after.locator('[data-field="cutoff"]')).toHaveText('Cut-off uplynul');
  await expect(after.locator('[data-field="status"]')).toHaveText('Nakladá sa');
  await expect(after.locator('[data-field="counter-rolled"] .contract-card__counter-value')).toHaveText('3');
  await expect(after.locator('[data-field="counter-returned"] .contract-card__counter-value')).toHaveText('1');
  await expect(after.locator('[data-field="counter-last-minute"] .contract-card__counter-value')).toHaveText('1');
  await expect(after.locator('[data-field="counter-held"]')).toHaveCount(0);
  await expect(after.locator('[data-field="penalties-value"]')).toHaveText('−$1,920');
  await expect(after.locator('[data-field="counter-rolled"] .contract-card__counter-value')).toHaveCSS('font-variant-numeric', 'tabular-nums');

  await expect(active.locator('[data-contract-id="215"] [data-field="pending"]')).toHaveText('Ešte príde 12 TEU');
  await active.screenshot({ path: `${SCREENSHOTS}/f6a-panel-active.png` });

  // --- História: výplata exportu pomerne k naloženým, zlyhaný booking, uzavretý roundtrip -----------------------------------------
  const history = page.getByTestId('panel-history');
  await expect(history.getByRole('tab', { name: 'História' })).toHaveAttribute('aria-selected', 'true');
  const done = history.locator('[data-contract-id="311"]');
  await expect(done.locator('[data-field="loaded-summary"]')).toHaveText('Naložené 22 / 24 TEU');
  await expect(done.locator('[data-field="reward"]')).toHaveText('+$85,600');
  await expect(done.locator('[data-field="penalties-value"]')).toHaveText('−$2,400');
  await expect(done.locator('[data-field="sla"]')).toHaveText('včas');
  await expect(done.locator('[data-field="cutoff"]')).toHaveCount(0);
  const failed = history.locator('[data-contract-id="312"]');
  await expect(failed.locator('[data-field="status"]')).toHaveText('Zlyhané');
  await expect(failed.locator('[data-field="reward"]')).toHaveText('−$7,200');
  const closed = history.locator('article[data-voyage-id="313"]');
  await expect(closed.locator('section.contract-card__part')).toHaveCount(2);
  await expect(closed.locator('[data-field="reward"]')).toHaveText('+$196,000');
  await expect(closed.locator('[data-field="import-status"]')).toHaveText('Splnené');
  await expect(closed.locator('[data-field="export-status"]')).toHaveText('Splnené');
  await history.screenshot({ path: `${SCREENSHOTS}/f6a-panel-history.png` });

  // --- Inšpektor skladu: rozdelenie import / export ------------------------------------------------------------------------------------
  const yard = page.getByTestId('inspector-yard');
  await expect(yard.locator('[data-section="storage-split"]')).toBeVisible();
  await expect(yard.locator('[data-field="storage-split-count"]')).toHaveText('46 TEU');
  await expect(yard.locator('[data-field="storage-split-import"]')).toHaveText('30 TEU');
  await expect(yard.locator('[data-field="storage-split-export"]')).toHaveText('16 TEU');
  await expect(yard.locator('[data-section="storage-split"] .module-inspector__bar-fill--import')).toHaveAttribute('style', /width:\s*65%/);
  await expect(yard.locator('[data-section="storage-split"] .module-inspector__bar-fill--export')).toHaveAttribute('style', /width:\s*35%/);
  await expect(yard.locator('[data-field="storage-split-import"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await yard.screenshot({ path: `${SCREENSHOTS}/f6a-inspector-yard.png` });

  // --- Inšpektor lode: náklad podľa smeru a lashing s progresom -------------------------------------------------------------------
  const loading = page.getByTestId('inspector-loading');
  await expect(loading.locator('[data-field="ship-class"]')).toHaveText('Feeder');
  await expect(loading.locator('[data-field="ship-units"]')).toHaveText('12 / 40 TEU');
  await expect(loading.locator('[data-field="ship-split-import"]')).toHaveText('4 TEU');
  await expect(loading.locator('[data-field="ship-split-export"]')).toHaveText('8 TEU');
  await expect(loading.locator('[data-section="lashing"]')).toHaveCount(0);
  await loading.screenshot({ path: `${SCREENSHOTS}/f6a-inspector-loading.png` });

  const lashing = page.getByTestId('inspector-lashing');
  await expect(lashing.locator('[data-field="ship-split-export"]')).toHaveText('24 TEU');
  await expect(lashing.locator('[data-field="ship-split-import"]')).toHaveText('0 TEU');
  await expect(lashing.locator('[data-field="lashing-text"]')).toHaveText('Lashing a papiere · zostáva 2 h');
  await expect(lashing.locator('[data-field="lashing-progress"]')).toHaveText('62 %');
  await expect(lashing.getByRole('progressbar', { name: 'Priebeh lashingu' })).toHaveAttribute('aria-valuenow', '62');
  await lashing.screenshot({ path: `${SCREENSHOTS}/f6a-inspector-lashing.png` });

  // --- Galéria export kariet a toasty penalizácií --------------------------------------------------------------------------------------
  const gallery = page.getByTestId('gallery');
  await expect(gallery.locator('article.contract-card')).toHaveCount(6);
  await gallery.screenshot({ path: `${SCREENSHOTS}/f6a-card-gallery.png` });
  const penalties = page.getByTestId('penalty-toasts');
  await expect(penalties.locator('[data-field="toast-title"]')).toHaveText([
    'Penalizácia: last minute nakládka',
    'Penalizácia: vrátené jednotky (rolled)',
    'Penalizácia: nesplnený booking',
  ]);
  await expect(penalties.locator('.toast').first().locator('[data-field="toast-text"]')).toHaveText('#214 · Export 24 TEU → Rotterdam · 1 jednotka · −$1,920');
  await penalties.screenshot({ path: `${SCREENSHOTS}/f6a-penalty-toasts.png` });

  await page.screenshot({ path: `${SCREENSHOTS}/f6a-ui-demo-page.png`, fullPage: true });
  expect(errors).toEqual([]);
});
