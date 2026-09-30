import { expect, test } from '@playwright/test';

// T03-09: demo stránka s BuildBar (Sklady / Logistika s položkou „kúpiť"), ModuleInspector (dvor 72 %, depo, nepripojený
// dvor) a Toasts. Nespúšťa hru ani simuláciu — dev server servíruje statické demo src/ui/__demo__/f3-ui-demo.html.
// Screenshot slúži na vizuálnu kontrolu voči prototypu design/ui/game-ui.source.html.
const DEMO_URL = '/src/ui/__demo__/f3-ui-demo.html';
const SCREENSHOTS = 'tests/e2e/__screenshots__';

test('F3 UI demo: dvor, depo, nepripojený modul, BuildBar buy položky a toasty sa vykreslia a reagujú', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(DEMO_URL);
  const stage = page.getByTestId('stage');
  const stageBar = page.getByTestId('stage-bar');
  await expect(stageBar.getByRole('tablist', { name: 'Kategórie stavby' })).toBeVisible();
  // Písma (Inter, JetBrains Mono) musia byť načítané, inak sa screenshot líši šírkami textu.
  await page.evaluate(() => document.fonts.ready);

  // --- BuildBar v hre: Logistika aktívna, tri povolené kategórie, straddle carrier = kúpiť, depo vybraté --------------
  await expect(stageBar.getByRole('tab')).toHaveCount(6);
  await expect(stageBar.getByRole('tab', { name: /Logistika/ })).toHaveAttribute('aria-selected', 'true');
  await expect(stageBar.locator('.build-bar__tab:disabled')).toHaveCount(3);
  const carrier = stageBar.locator('[data-def-id="straddle_carrier"]');
  const depotItem = stageBar.locator('[data-def-id="vehicle_depot"]');
  await expect(carrier).toHaveAttribute('data-action', 'buy');
  await expect(carrier.locator('[data-field="item-cost"]')).toHaveText('$48,000');
  await expect(carrier.locator('[data-field="item-size"]')).toHaveText('· kúpiť');
  await expect(carrier).not.toHaveAttribute('aria-pressed', /.*/);
  await expect(depotItem).toHaveAttribute('data-action', 'build');
  await expect(depotItem.locator('[data-field="item-cost"]')).toHaveText('$90,000');
  await expect(depotItem.locator('[data-field="item-size"]')).toHaveText('· 3×3');
  await expect(depotItem).toHaveAttribute('aria-pressed', 'true');

  // --- Inšpektor dvora v hre: zaplnenie 72 %, 46 / 64 TEU, prijaté / vydané ---------------------------------------------
  const inspector = stage.getByRole('complementary', { name: 'Inšpektor modulu' });
  await expect(inspector.locator('[data-field="title"]')).toHaveText('Kontajnerový dvor S');
  await expect(inspector.locator('[data-field="sub"]')).toHaveText('YRD-03 · 4×4');
  await expect(inspector.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'true');
  await expect(inspector.locator('[data-field="stat-fill"]')).toHaveText('72 %');
  await expect(inspector.locator('[data-field="stat-reserved"]')).toHaveText('3');
  await expect(inspector.locator('[data-field="stat-free"]')).toHaveText('15');
  await expect(inspector.locator('[data-field="storage-count"]')).toHaveText('46 / 64 TEU');
  await expect(inspector.locator('[data-field="units-in"]')).toHaveText('1,240 TEU');
  await expect(inspector.locator('[data-field="units-out"]')).toHaveText('12 TEU');
  await expect(inspector.locator('[data-section="disconnected"]')).toHaveCount(0);
  await expect(inspector.locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(inspector.locator('[data-field="remove-reason"]')).toHaveText('Sklad obsahuje náklad.');

  // --- Toasty v hre: „Chýba sklad" (warning) a „Nepripojené" (info s akciou „Ukázať"), vľavo od panelu -------------------
  const toasts = stage.getByRole('region', { name: 'Oznámenia' });
  await expect(toasts.getByRole('status')).toHaveCount(2);
  const noStorage = toasts.locator('[data-toast-id="no-storage"]');
  const disconnectedToast = toasts.locator('[data-toast-id="disconnected"]');
  await expect(noStorage).toHaveAttribute('data-tone', 'warning');
  await expect(noStorage.locator('[data-field="toast-title"]')).toHaveText('Chýba sklad');
  await expect(noStorage.locator('[data-action="show"]')).toHaveCount(0);
  await expect(disconnectedToast).toHaveAttribute('data-tone', 'info');
  await expect(disconnectedToast.locator('[data-field="toast-title"]')).toHaveText('Nepripojené');
  await expect(disconnectedToast.locator('[data-action="show"]')).toHaveText('Ukázať');
  // poloha: pravý okraj zásobníka je 12 px vľavo od panelu, spodný okraj 12 px nad BuildBarom (prototyp: 384 / 108 px)
  const stageBox = (await stage.boundingBox())!;
  const toastsBox = (await toasts.boundingBox())!;
  const panelBox = (await inspector.boundingBox())!;
  expect(Math.round(panelBox.x - (toastsBox.x + toastsBox.width))).toBe(12);
  expect(Math.round(stageBox.y + stageBox.height - (toastsBox.y + toastsBox.height))).toBe(108 + 1); // + 1 px orámovanie mapy
  expect(Math.round(toastsBox.width)).toBe(340);
  await stage.screenshot({ path: `${SCREENSHOTS}/f3-ui-demo-stage.png` });

  // --- Kontrolný pás BuildBar: tooltip zamknutého nákupu „Postav depo vozidiel" (screenshot ho ukáže) -------------------
  const states = page.getByTestId('states');
  const noDepot = states.locator('[data-def-id="straddle_carrier_no_depot"]');
  await expect(noDepot).toHaveAttribute('data-status', 'locked');
  await noDepot.hover();
  await expect(noDepot.getByRole('tooltip')).toContainText('Zamknuté');
  await expect(noDepot.getByRole('tooltip')).toContainText('Postav depo vozidiel');
  // tooltip sa zobrazuje prechodom opacity (120 ms) — screenshot až po jeho dokončení
  await expect(noDepot.getByRole('tooltip')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: `${SCREENSHOTS}/f3-ui-demo.png`, fullPage: true });

  // --- Depo s 2 vozidlami: dlaždice, zoznam, nákup a predaj ---------------------------------------------------------------
  const depot = page.getByTestId('depot-2');
  await expect(depot.locator('[data-field="sub"]')).toHaveText('DEP-01 · 3×3');
  await expect(depot.locator('[data-field="stat-vehicles"]')).toHaveText('2 / 6');
  await expect(depot.locator('[data-field="stat-busy"]')).toHaveText('1');
  await expect(depot.locator('[data-field="stat-idle"]')).toHaveText('1');
  await expect(depot.locator('li')).toHaveCount(2);
  await expect(depot.locator('[data-vehicle-id="11"][data-state="busy"] [data-field="vehicle-code"]')).toHaveText('SC-01');
  await expect(depot.locator('[data-vehicle-id="12"][data-state="idle"] [data-field="vehicle-state"]')).toHaveText('Nečinné');
  await expect(depot.locator('[data-vehicle-id="11"] [data-field="vehicle-state"]')).toHaveText('Pracuje');
  await depot.locator('.f3-demo__map--panel').screenshot({ path: `${SCREENSHOTS}/f3-ui-demo-depot.png` });
  const buy = depot.locator('[data-action="buy-vehicle"]');
  await expect(buy).toHaveAttribute('aria-disabled', 'false');
  await expect(buy.locator('[data-field="buy-price"]')).toHaveText('$48,000');
  await expect(buy).toContainText('Kúpiť vozidlo v depe');
  const depotLog = depot.locator('[data-field="last-action"]');
  await buy.click();
  await expect(depotLog).toHaveText('Posledná akcia: onBuyVehicle(1)');
  // predaj: pracujúce vozidlo sa nedá predať (aria-disabled, klik nič nezapíše), nečinné áno
  // (aria-disabled: Playwright ho berie ako nepovolený, klik preto vynútime)
  await expect(depot.locator('button[data-action="sell-vehicle"][data-vehicle-id="11"]')).toHaveAttribute('aria-disabled', 'true');
  await depot.locator('button[data-action="sell-vehicle"][data-vehicle-id="11"]').click({ force: true });
  await expect(depotLog).toHaveText('Posledná akcia: onBuyVehicle(1)');
  await depot.locator('button[data-action="sell-vehicle"][data-vehicle-id="12"]').click();
  await expect(depotLog).toHaveText('Posledná akcia: onSellVehicle(12)');

  // --- Plné depo: nákup zablokovaný s dôvodom, vozidlo bez cesty -----------------------------------------------------------
  const full = page.getByTestId('depot-full');
  await expect(full.locator('[data-field="stat-vehicles"]')).toHaveText('4 / 4');
  await expect(full.locator('li[data-vehicle-id="13"]')).toHaveAttribute('data-state', 'no_path');
  await expect(full.locator('li[data-vehicle-id="13"] [data-field="vehicle-state"]')).toHaveText('Bez cesty');
  await expect(full.locator('[data-action="buy-vehicle"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(full.locator('[data-field="buy-reason"]')).toHaveText('Depo je plné (4 / 4 stání).');
  await full.locator('[data-action="buy-vehicle"]').click({ force: true });
  await expect(full.locator('[data-field="last-action"]')).toHaveText('Posledná akcia: —');

  // --- Nepripojený dvor (vzor insp_gate): žltý badge „Nepripojené" + banner -----------------------------------------------
  const disconnected = page.getByTestId('yard-disconnected');
  await expect(disconnected.locator('[data-field="badge"]')).toHaveText('Nepripojené');
  await expect(disconnected.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'false');
  await expect(disconnected.locator('[data-section="disconnected"]')).toContainText('Nepripojené k ceste');
  await expect(disconnected.locator('[data-field="stat-fill"]')).toHaveText('0 %');

  // --- Takmer plný dvor: červené zaplnenie, žlté voľné ---------------------------------------------------------------------
  const yardFull = page.getByTestId('yard-full');
  await expect(yardFull.locator('[data-field="stat-fill"]')).toHaveText('91 %');
  await expect(yardFull.locator('[data-field="stat-fill"]')).toHaveClass(/module-inspector__stat-value--danger/);
  await expect(yardFull.locator('[data-field="stat-free"]')).toHaveText('0');
  await expect(yardFull.locator('[data-field="stat-free"]')).toHaveClass(/module-inspector__stat-value--warn/);

  // --- BuildBar: nákup volá onBuy, zamknutý a drahý nákup nie; stavba zostáva výberom ------------------------------------
  const stageLabel = stage.locator('.f3-demo__map-label');
  await carrier.click();
  await expect(stageLabel).toContainText('onBuy(straddle_carrier)');
  await expect(depotItem).toHaveAttribute('aria-pressed', 'true'); // nákup výber stavby nemení
  await stageBar.getByRole('tab', { name: /Sklady/ }).click();
  const yardItem = stageBar.locator('[data-def-id="container_yard_small"]');
  await expect(yardItem.locator('[data-field="item-cost"]')).toHaveText('$150,000');
  await expect(yardItem.locator('[data-field="item-size"]')).toHaveText('· 4×4');
  await yardItem.click();
  await expect(yardItem).toHaveAttribute('aria-pressed', 'true');
  await expect(stageLabel).toContainText('onSelect(container_yard_small)');

  // kontrolný pás: dostupný nákup zapíše onBuy, zamknutý (aria-disabled → klik vynútime) a drahý nákup nie
  const statesCaption = states.locator('.f3-demo__caption');
  const poor = states.locator('[data-def-id="straddle_carrier_poor"]');
  await expect(poor).toHaveAttribute('data-status', 'unaffordable');
  await poor.hover();
  await expect(poor.getByRole('tooltip')).toContainText('Nedostatok peňazí');
  await expect(poor.getByRole('tooltip')).toContainText('Chýba $38,000');
  await states.locator('[data-def-id="straddle_carrier"]').click();
  await expect(statesCaption).toContainText('Posledná akcia: onBuy(straddle_carrier)');
  await noDepot.click({ force: true });
  await poor.click();
  await expect(statesCaption).toContainText('Posledná akcia: onBuy(straddle_carrier)'); // bez zmeny
  await expect(statesCaption).not.toContainText('no_depot');
  await expect(statesCaption).not.toContainText('poor');

  // --- Toasty: „Ukázať" volá onShow, zavrieť odstráni toast ---------------------------------------------------------------
  await disconnectedToast.locator('[data-action="show"]').click();
  await expect(stageLabel).toContainText('onShow(disconnected)');
  await noStorage.locator('[data-action="close"]').click();
  await expect(toasts.getByRole('status')).toHaveCount(1);
  await expect(stageLabel).toContainText('onClose(no-storage)');

  // pás všetkých tónov: 4 toasty, zavretie prvého ich necháva 3
  const strip = page.getByTestId('toasts-strip');
  await expect(strip.getByRole('status')).toHaveCount(4);
  for (const tone of ['info', 'success', 'warning', 'danger']) {
    await expect(strip.locator(`[data-tone="${tone}"]`)).toHaveCount(1);
  }
  await strip.locator('[data-toast-id="offer"] [data-action="close"]').click();
  await expect(strip.getByRole('status')).toHaveCount(3);

  expect(errors).toEqual([]);
});
