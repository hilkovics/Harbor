import { expect, test, type Page } from '@playwright/test';

// T6C-05: demo stránka s ContractsPanel (repositioning prázdnych, prekládka loď A → loď B), inšpektormi (depo prázdnych, sklad a loď
// so štyrmi smermi) a toastmi nových udalostí. Nespúšťa hru ani simuláciu — dev server servíruje statické demo
// src/ui/__demo__/f6c-ui-demo.html. Screenshoty slúžia na vizuálnu kontrolu voči prototypu design/ui/game-ui.source.html
// (`contracts`, `insp_yard`, toasty); prototyp nemá linky, prázdne ani prekládku — karty a inšpektor depa sú odvodené od jeho kariet.
const DEMO_URL = '/src/ui/__demo__/f6c-ui-demo.html';
const SCREENSHOTS = 'tests/e2e/__screenshots__';

/** Farba tokenu (alebo jeho náhrady) v tvare `rgb(...)` — farba linky nesmie byť pevná, preto sa porovnáva s tokenom z tokens.css. */
async function tokenColor(page: Page, token: string, fallback: string): Promise<string> {
  return page.evaluate(
    ([name, fallbackName]) => {
      const css = getComputedStyle(document.documentElement);
      const value = css.getPropertyValue(`--${String(name)}`).trim() || css.getPropertyValue(`--${String(fallbackName)}`).trim();
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    },
    [token, fallback],
  );
}

test('F6c UI demo: repositioning, prekládka, depo prázdnych, štyri smery a toasty sa vykreslia a reagujú', async ({ page }) => {
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

  // --- Panel v hre: Ponuky — repositioning, repositioning bez depa, prekládka, export + prázdne v jednej plavbe ----------------
  const panel = stage.getByRole('complementary', { name: 'Kontrakty' });
  await expect(panel.getByRole('tab')).toHaveText(['Ponuky · 4', 'Aktívne · 5', 'História']);
  await expect(panel.locator('article.contract-card')).toHaveCount(4);

  const repo = panel.locator('[data-contract-id="411"]');
  await expect(repo).toHaveAttribute('data-kind', 'empty_repositioning');
  await expect(repo.locator('[data-field="cargo"]')).toHaveText('Prázdne · Kontajnery');
  await expect(repo.locator('[data-field="volume"]')).toHaveText('24 TEU prázdnych');
  await expect(repo.locator('[data-field="reward"]')).toHaveText('+$3,168');
  await expect(repo.locator('[data-field="reward"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(repo.locator('[data-field="line"]')).toHaveText('Blue Anchor Lines');
  await expect(repo.locator('[data-field="destination"]')).toHaveText('Rotterdam');
  await expect(repo.locator('[data-field="voyage"]')).toHaveText('Plavba #411');
  await expect(repo.locator('[data-field="stock"]')).toHaveText('Dostupné 17 / 24 TEU');
  await expect(repo.locator('[data-field="stock"]')).toHaveAttribute('data-tone', 'warn');
  await expect(repo.locator('[data-field="cutoff"]')).toHaveCount(0);
  await expect(repo.locator('[data-field="sla"]')).toHaveText('3 dni');
  await expect(repo.locator('[data-field="expiry"]')).toHaveText('Expiruje o 1 d 2 h');

  // Farba linky ide z tokenu (nie pevná): bodka má farbu `--line-blue` (alebo jeho náhrady) a tri linky sa líšia
  const dotColor = (testLocator: ReturnType<Page['locator']>) => testLocator.locator('[data-field="line"] .contract-card__line-dot');
  await expect(dotColor(repo)).toHaveCSS('background-color', await tokenColor(page, 'line-blue', 'ui-accent'));
  const amberDot = dotColor(panel.locator('[data-contract-id="412"]'));
  const tealDot = dotColor(panel.locator('[data-contract-id="413"]'));
  await expect(amberDot).toHaveCSS('background-color', await tokenColor(page, 'line-amber', 'ui-warning'));
  await expect(tealDot).toHaveCSS('background-color', await tokenColor(page, 'line-teal', 'cargo-gas'));
  const colors = new Set([
    await dotColor(repo).evaluate((element) => getComputedStyle(element).backgroundColor),
    await amberDot.evaluate((element) => getComputedStyle(element).backgroundColor),
    await tealDot.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(colors.size).toBe(3);

  const stageLabel = stage.locator('.f6c-demo__map-label');
  await repo.locator('[data-action="accept"]').click();
  await expect(stageLabel).toContainText('onAccept(411)');
  await repo.locator('[data-action="decline"]').click();
  await expect(stageLabel).toContainText('onDecline(411)');

  // Repositioning bez depa: „Prijať“ zablokované, dôvod v title aj pod tlačidlami
  const blocked = panel.locator('[data-contract-id="412"]');
  await expect(blocked.locator('[data-field="stock"]')).toHaveText('Dostupné 0 / 12 TEU');
  await expect(blocked.locator('[data-action="accept"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(blocked.locator('[data-action="accept"]')).toHaveAttribute('title', 'Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)');
  await expect(blocked.locator('[data-field="accept-reason"]')).toHaveText('Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)');
  await blocked.locator('[data-action="accept"]').click({ force: true });
  await expect(stageLabel).not.toContainText('onAccept(412)');

  // Prekládka: trasa A → B s rozstupom príchodu lode B po lodi A
  const offer = panel.locator('[data-contract-id="413"]');
  await expect(offer).toHaveAttribute('data-kind', 'tranship');
  await expect(offer.locator('[data-field="cargo"]')).toHaveText('Tranship · Kontajnery');
  await expect(offer.locator('[data-field="destination"]')).toHaveText('Hamburg');
  await expect(offer.getByRole('list', { name: /Trasa prekládky/ }).getByRole('listitem')).toHaveCount(2);
  await expect(offer.locator('[data-field="leg-a"]')).toHaveText('Loď A · plavba #413');
  await expect(offer.locator('[data-field="leg-b"]')).toHaveText('Loď B · plavba #414');
  await expect(offer.locator('[data-field="leg-a-time"]')).toHaveText('príde po prijatí');
  await expect(offer.locator('[data-field="leg-b-time"]')).toHaveText('o 1 deň – 2 dni po lodi A');
  await expect(offer.locator('[role="progressbar"]')).toHaveCount(0);

  // Export + prázdne jednej plavby: jedna spoločná karta s jedným „Prijať oba“ (id prvého kontraktu)
  const combined = panel.locator('article[data-voyage-id="415"]');
  await expect(combined).toHaveAttribute('data-kind', 'combined');
  await expect(combined.locator('[data-field="cargo"]')).toHaveText('Export + prázdne · Kontajnery');
  await expect(combined.locator('[data-field="volume"]')).toHaveText('36 TEU');
  await expect(combined.locator('section.contract-card__part')).toHaveCount(2);
  await expect(combined.locator('[data-field="export-title"]')).toHaveText('Export → Rotterdam');
  await expect(combined.locator('[data-field="empty_repositioning-title"]')).toHaveText('Prázdne → Rotterdam');
  await expect(combined.locator('[data-field="export-cutoff"]')).toHaveText('Cut-off 12 h pred príchodom lode');
  await expect(combined.locator('[data-field="empty_repositioning-cutoff"]')).toHaveCount(0);
  await expect(combined.locator('[data-field="line"]')).toHaveCount(1);
  await expect(combined.locator('[data-action="accept"]')).toHaveText('Prijať oba');
  await combined.locator('[data-action="accept"]').click();
  await expect(stageLabel).toContainText('onAccept(415)');

  // --- Toasty: návrat prázdnych (nenápadný, bez akcie), oprava hotová, výdaj zlyhal, tranship zmeškaný ---------------------------
  const toasts = stage.getByRole('region', { name: 'Oznámenia' });
  await expect(toasts.locator('.toast')).toHaveCount(4);
  await expect(toasts.locator('[data-field="toast-title"]')).toHaveText(['Návrat prázdnych', 'Oprava hotová', 'Výdaj prázdneho zlyhal', 'Tranship zmeškaný']);
  await expect(toasts.locator('.toast').nth(0).locator('[data-field="toast-text"]')).toHaveText('Blue Anchor Lines · 3 prázdne kontajnery z vnútrozemia');
  await expect(toasts.locator('.toast').nth(0).locator('.toast__action')).toHaveCount(0);
  await expect(toasts.locator('.toast').nth(1).locator('[data-field="toast-text"]')).toHaveText('YRD-09 · Northern Star Shipping · opravené: 1 · −$120');
  await expect(toasts.locator('.toast').nth(1).getByRole('button', { name: 'Ukázať' })).toBeVisible();
  await expect(toasts.locator('[data-tone="danger"] .toast__icon use')).toHaveAttribute('href', /#ic_warning$/);
  await expect(toasts.locator('[data-tone="info"] .toast__icon use')).toHaveAttribute('href', /#ic_truck$/);

  // --- Aktívne záložka v hre ------------------------------------------------------------------------------------------------------
  await panel.getByRole('tab', { name: /Aktívne/ }).click();
  await expect(stageLabel).toContainText('onTabChange(active)');
  await expect(panel.locator('article.contract-card')).toHaveCount(5);
  await expect(panel.locator('[data-action="accept"]')).toHaveCount(0);
  await panel.getByRole('tab', { name: /Ponuky/ }).click();
  await stage.screenshot({ path: `${SCREENSHOTS}/f6c-ui-demo-stage.png` });

  // --- Aktívne: prekládka čaká na loď B, vykladá sa, zmeškaná loď B, repositioning nakladá / prijatý ------------------------------
  const active = page.getByTestId('panel-active');
  await expect(active.getByRole('tab', { name: /Aktívne/ })).toHaveAttribute('aria-selected', 'true');

  const waiting = active.locator('[data-contract-id="511"]');
  await expect(waiting.locator('[data-field="status"]')).toHaveText('Čaká na loď B');
  await expect(waiting.locator('[data-field="leg-a-time"]')).toHaveText('prišla');
  await expect(waiting.locator('[data-field="leg-b-time"]')).toHaveText('príde o 1 d 4 h');
  await expect(waiting.locator('[data-field="unloaded-value"]')).toHaveText('36 / 36 TEU');
  await expect(waiting.locator('[data-field="loaded-value"]')).toHaveText('0 / 36 TEU');
  await expect(waiting.locator('[data-field="counter-waiting"]')).toContainText('Čakajú na loď B');
  await expect(waiting.locator('[data-field="counter-waiting"] .contract-card__counter-value')).toHaveText('36');
  await expect(waiting.locator('[data-field="counter-waiting"] .contract-card__counter-value')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(waiting.locator('[data-field="rescue"]')).toHaveCount(0);

  const unloading = active.locator('[data-contract-id="513"]');
  await expect(unloading.locator('[data-field="status"]')).toHaveText('Vykladá sa');
  await expect(unloading.locator('[data-field="unloaded-value"]')).toHaveText('14 / 36 TEU');
  await expect(unloading.locator('[data-field="leg-b-time"]')).toHaveText('príde o 2 dni');
  await expect(unloading.locator('[data-field="line"]')).toHaveText('Northern Star Shipping');

  const missed = active.locator('[data-contract-id="514"]');
  await expect(missed.locator('[data-field="leg-b-time"]')).toHaveText('odplávala bez jednotiek');
  await expect(missed.locator('[data-leg="b"]')).toHaveClass(/contract-card__leg--danger/);
  await expect(missed.locator('[data-field="rescue"]')).toHaveText('Na záchranu zostáva 2 d 3 h');
  await expect(missed.locator('[data-field="counter-missed"]')).toContainText('Zmeškané');
  await expect(missed.locator('[data-field="counter-missed"] .contract-card__counter-value')).toHaveText('24');
  await expect(missed.locator('[data-field="counter-waiting"]')).toHaveCount(0);
  await expect(missed.locator('[data-field="penalties-value"]')).toHaveText('−$1,680');

  const loading = active.locator('[data-contract-id="611"]');
  await expect(loading.locator('[data-field="status"]')).toHaveText('Nakladá sa');
  await expect(loading.locator('[data-field="loaded-value"]')).toHaveText('18 / 30 TEU');
  await expect(loading.getByRole('progressbar', { name: 'Naložené' })).toHaveAttribute('aria-valuenow', '60');
  await expect(loading.locator('[data-field="arrived"]')).toHaveCount(0);
  await expect(loading.locator('[data-field="stock"]')).toHaveText('Dostupné 9 / 12 TEU');
  await expect(loading.locator('[data-field="voyage"]')).toHaveText('Plavba #611');

  const accepted = active.locator('[data-contract-id="612"]');
  await expect(accepted.locator('[data-field="status"]')).toHaveText('Prijaté');
  await expect(accepted.locator('[data-field="stock"]')).toHaveAttribute('data-tone', 'ok');
  await active.screenshot({ path: `${SCREENSHOTS}/f6c-panel-active.png` });

  // --- História: repositioning splnený, prekládka s predanými, prekládka zlyhaná -----------------------------------------------------
  const history = page.getByTestId('panel-history');
  await expect(history.getByRole('tab', { name: 'História' })).toHaveAttribute('aria-selected', 'true');
  const done = history.locator('[data-contract-id="711"]');
  await expect(done.locator('[data-field="loaded-summary"]')).toHaveText('Naložené 24 / 24 TEU');
  await expect(done.locator('[data-field="reward"]')).toHaveText('+$3,168');
  await expect(done.locator('[data-field="sla"]')).toHaveText('včas');
  const sold = history.locator('[data-contract-id="712"]');
  await expect(sold.locator('[data-field="loaded-summary"]')).toHaveText('Naložené 30 / 36 TEU');
  await expect(sold.locator('[data-field="counter-sold"]')).toContainText('Predané');
  await expect(sold.locator('[data-field="counter-sold"] .contract-card__counter-value')).toHaveText('6');
  await expect(sold.locator('[data-field="reward"]')).toHaveText('+$7,140');
  await expect(sold.locator('[data-field="penalties-value"]')).toHaveText('−$2,520');
  await expect(sold.locator('[data-field="leg-a-time"]')).toHaveCount(0);
  const failed = history.locator('[data-contract-id="714"]');
  await expect(failed.locator('[data-field="status"]')).toHaveText('Zlyhané');
  await expect(failed.locator('[data-field="reward"]')).toHaveText('−$4,200');
  await history.screenshot({ path: `${SCREENSHOTS}/f6c-panel-history.png` });

  // --- Inšpektor depa prázdnych: poškodené čakajú na opravu -----------------------------------------------------------------------------
  const busy = page.getByTestId('inspector-depot-busy');
  await expect(busy.locator('[data-field="title"]')).toHaveText('Depo prázdnych kontajnerov');
  await expect(busy.locator('[data-field="stat-available"]')).toHaveText('37');
  await expect(busy.locator('[data-field="stat-damaged"]')).toHaveText('2');
  await expect(busy.locator('[data-field="stat-repair"]')).toHaveText('2');
  await expect(busy.locator('[data-field="stat-available"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(busy.locator('[data-field="storage-count"]')).toHaveText('41 / 96 TEU');
  await expect(busy.locator('[data-section="storage-split"]')).toHaveCount(0);
  const blueRow = busy.locator('[data-line="blue_anchor"]');
  await expect(blueRow.locator('[data-field="line-name"]')).toHaveText('Blue Anchor Lines');
  await expect(blueRow.locator('[data-field="line-total"]')).toHaveText('20');
  await expect(blueRow.locator('[data-field="line-available"]')).toHaveText('18');
  await expect(blueRow.locator('[data-field="line-damaged"]')).toHaveText('1');
  await expect(blueRow.locator('[data-field="line-repair"]')).toHaveText('1');
  await expect(blueRow.locator('[data-field="line-available"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(blueRow.locator('.module-inspector__line-dot')).toHaveCSS('background-color', await tokenColor(page, 'line-blue', 'ui-accent'));
  await expect(busy.locator('[data-line="northern_star"] [data-field="line-damaged"]')).toHaveText('0');
  await expect(busy.locator('[data-line="golden_wave"] [data-field="line-available"]')).toHaveText('7');
  await expect(busy.locator('[data-field="repair-count"]')).toHaveText('2 / 2 miest');
  await expect(busy.locator('[data-section="repair-bays"] .module-inspector__bay--occupied')).toHaveCount(2);
  await expect(busy.locator('[data-field="repair-waiting"]')).toHaveText('Čakajú na voľné miesto opravy: 2');
  await expect(busy.locator('[data-field="units-in"]')).toHaveText('212 TEU');
  await busy.screenshot({ path: `${SCREENSHOTS}/f6c-inspector-depot-busy.png` });

  const quiet = page.getByTestId('inspector-depot-quiet');
  await expect(quiet.locator('[data-field="stat-available"]')).toHaveText('26');
  await expect(quiet.locator('[data-field="stat-damaged"]')).toHaveText('0');
  await expect(quiet.locator('[data-field="repair-count"]')).toHaveText('0 / 2 miest');
  await expect(quiet.locator('[data-section="repair-bays"] .module-inspector__bay--free')).toHaveCount(2);
  await expect(quiet.locator('[data-field="repair-waiting"]')).toHaveCount(0);
  await expect(quiet.locator('[data-line="golden_wave"] [data-field="line-total"]')).toHaveText('0');
  await quiet.screenshot({ path: `${SCREENSHOTS}/f6c-inspector-depot-quiet.png` });

  // --- Dvor a loď: štyri smery ---------------------------------------------------------------------------------------------------------
  const yard = page.getByTestId('inspector-yard');
  await expect(yard.locator('[data-section="storage-split"] .module-inspector__meter-label')).toHaveText('Import / export / tranship / prázdne');
  await expect(yard.locator('[data-field="storage-split-count"]')).toHaveText('42 TEU');
  for (const [direction, text, percent] of [['import', '22 TEU', 52], ['export', '10 TEU', 24], ['tranship', '6 TEU', 14], ['empty', '4 TEU', 10]] as const) {
    await expect(yard.locator(`[data-field="storage-split-${direction}"]`)).toHaveText(text);
    await expect(yard.locator(`[data-section="storage-split"] .module-inspector__bar-fill--${direction}`)).toHaveAttribute('style', new RegExp(`width:\\s*${String(percent)}%`));
  }
  await expect(yard.locator('[data-field="storage-split-empty"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await yard.screenshot({ path: `${SCREENSHOTS}/f6c-inspector-yard.png` });

  const berth = page.getByTestId('inspector-berth');
  await expect(berth.locator('[data-field="ship-units"]')).toHaveText('22 / 40 TEU');
  await expect(berth.locator('[data-field="ship-split-export"]')).toHaveText('8 TEU');
  await expect(berth.locator('[data-field="ship-split-tranship"]')).toHaveText('6 TEU');
  await expect(berth.locator('[data-field="ship-split-empty"]')).toHaveText('8 TEU');
  await expect(berth.locator('.module-inspector__bar-fill--tranship')).toHaveAttribute('style', /width:\s*15%/);
  await expect(berth.locator('[data-section="lashing"]')).toHaveCount(0);
  await berth.screenshot({ path: `${SCREENSHOTS}/f6c-inspector-berth.png` });

  const lashing = page.getByTestId('inspector-lashing');
  await expect(lashing.locator('[data-field="ship-units"]')).toHaveText('36 / 40 TEU');
  await expect(lashing.locator('[data-field="ship-split-export"]')).toHaveText('12 TEU');
  await expect(lashing.locator('[data-field="ship-split-tranship"]')).toHaveText('12 TEU');
  await expect(lashing.locator('[data-field="ship-split-empty"]')).toHaveText('12 TEU');
  await expect(lashing.locator('[data-field="lashing-text"]')).toHaveText('Lashing a papiere · zostáva 4 h');
  await expect(lashing.locator('[data-field="lashing-progress"]')).toHaveText('40 %');
  await lashing.screenshot({ path: `${SCREENSHOTS}/f6c-inspector-lashing.png` });

  // --- Galéria kariet a toasty prekládky ------------------------------------------------------------------------------------------------
  const gallery = page.getByTestId('gallery');
  await expect(gallery.locator('article.contract-card')).toHaveCount(8);
  await expect(gallery.locator('article[data-kind="empty_repositioning"]')).toHaveCount(4);
  await expect(gallery.locator('article[data-kind="tranship"]')).toHaveCount(4);
  await expect(gallery.getByRole('article', { name: 'Prekládka: Kontajnery, 36 TEU' }).first()).toBeVisible();
  await gallery.screenshot({ path: `${SCREENSHOTS}/f6c-card-gallery.png` });
  const transhipToasts = page.getByTestId('tranship-toasts');
  await expect(transhipToasts.locator('[data-field="toast-title"]')).toHaveText(['Tranship zachránený', 'Tranship predaný']);
  await expect(transhipToasts.locator('.toast').first().locator('[data-field="toast-text"]')).toHaveText('#514 · Tranship 24 TEU → Hamburg · zachránené: 24 jednotiek, čakajú na plavbu #518');
  await transhipToasts.screenshot({ path: `${SCREENSHOTS}/f6c-tranship-toasts.png` });

  await page.screenshot({ path: `${SCREENSHOTS}/f6c-ui-demo-page.png`, fullPage: true });
  expect(errors).toEqual([]);
});
