import { expect, test } from '@playwright/test';

// T04-07: demo stránka s ModuleInspector (brána, čakacia plocha, rampa vrátane „Neprevádzková") a BuildBar Landside
// so skutočnými položkami brána / čakacia plocha / rampa. Nespúšťa hru ani simuláciu — dev server servíruje statické
// demo src/ui/__demo__/f4-ui-demo.html. Screenshot slúži na vizuálnu kontrolu voči prototypu design/ui/game-ui.source.html
// (`insp_gate`, BuildBar `landside`).
const DEMO_URL = '/src/ui/__demo__/f4-ui-demo.html';
const SCREENSHOTS = 'tests/e2e/__screenshots__';

test('F4 UI demo: brána, čakacia plocha, rampa (aj neprevádzková) a BuildBar Landside sa vykreslia a reagujú', async ({ page }) => {
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

  // --- BuildBar Landside v hre: 4 povolené kategórie, 6 položiek, brána vybratá, ceny z defov a rozmery ----------------
  await expect(stageBar.getByRole('tab')).toHaveCount(6);
  await expect(stageBar.getByRole('tab', { name: /Landside/ })).toHaveAttribute('aria-selected', 'true');
  await expect(stageBar.locator('.build-bar__tab:disabled')).toHaveCount(2);
  await expect(stageBar.locator('[data-def-id]')).toHaveCount(6);
  const gateItem = stageBar.locator('[data-def-id="truck_gate"]');
  const waitingItem = stageBar.locator('[data-def-id="truck_waiting_area"]');
  const rampItem = stageBar.locator('[data-def-id="loading_ramp_container"]');
  await expect(gateItem).toHaveAttribute('aria-pressed', 'true');
  await expect(gateItem).toHaveAttribute('data-action', 'build');
  await expect(gateItem.locator('.build-bar__item-name')).toHaveText('Brána kamiónov');
  await expect(gateItem.locator('[data-field="item-cost"]')).toHaveText('$80,000');
  await expect(gateItem.locator('[data-field="item-size"]')).toHaveText('· 2×2');
  await expect(waitingItem.locator('.build-bar__item-name')).toHaveText('Čakacia plocha');
  await expect(waitingItem.locator('[data-field="item-cost"]')).toHaveText('$60,000');
  await expect(waitingItem.locator('[data-field="item-size"]')).toHaveText('· 4×3');
  await expect(rampItem.locator('.build-bar__item-name')).toHaveText('Rampa · kontajnery');
  await expect(rampItem.locator('[data-field="item-cost"]')).toHaveText('$100,000');
  await expect(rampItem.locator('[data-field="item-size"]')).toHaveText('· 4×2');
  // ikony z ikonovej sady (ic_gate / ic_waiting / ic_ramp), nie prázdny symbol
  for (const [item, icon] of [[gateItem, 'ic_gate'], [waitingItem, 'ic_waiting'], [rampItem, 'ic_ramp']] as const) {
    await expect(item.locator('svg.build-bar__item-icon use')).toHaveAttribute('href', new RegExp(`#${icon}$`));
  }
  // žiadna položka nepretečie svoj obal (názov „Rampa · kontajnery" sa zmestí aj pri 6 položkách v 1280 px)
  for (const item of [gateItem, waitingItem, rampItem]) {
    const box = (await item.boundingBox())!;
    const name = (await item.locator('.build-bar__item-name').boundingBox())!;
    expect(name.x + name.width).toBeLessThanOrEqual(box.x + box.width);
  }

  // --- Inšpektor brány v hre: fronta 3, 20 / h, 18 tickov --------------------------------------------------------------
  const inspector = stage.getByRole('complementary', { name: 'Inšpektor modulu' });
  await expect(inspector.locator('[data-field="title"]')).toHaveText('Brána kamiónov');
  await expect(inspector.locator('[data-field="sub"]')).toHaveText('GTE-01 · 2×2');
  await expect(inspector.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'true');
  await expect(inspector.locator('[data-field="stat-queue"]')).toHaveText('3');
  await expect(inspector.locator('[data-field="stat-throughput"]')).toHaveText('20 / h');
  await expect(inspector.locator('[data-field="stat-process"]')).toHaveText('18');
  await expect(inspector.locator('[data-section="disconnected"]')).toHaveCount(0);
  await expect(inspector.locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'false');
  // čísla dlaždíc majú tabular-nums (dedí od panelu)
  await expect(inspector.locator('[data-field="stat-throughput"]')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await stage.screenshot({ path: `${SCREENSHOTS}/f4-ui-demo-stage.png` });

  // --- Kontrolný pás BuildBar: brána bez peňazí (tooltip „Chýba $30,000") a zamknutá rampa pre sypký náklad -----------------
  const states = page.getByTestId('states');
  const poorGate = states.locator('[data-def-id="truck_gate"]');
  await expect(poorGate).toHaveAttribute('data-status', 'unaffordable');
  await expect(poorGate.locator('[data-field="item-cost"]')).toHaveText('$80,000');
  const lockedRamp = states.locator('[data-def-id="loading_ramp_bulk"]');
  await expect(lockedRamp).toHaveAttribute('data-status', 'locked');
  await expect(states.locator('[data-def-id="loading_ramp_container"]')).toHaveAttribute('aria-pressed', 'true');
  await lockedRamp.hover();
  await expect(lockedRamp.getByRole('tooltip')).toContainText('Zamknuté');
  await expect(lockedRamp.getByRole('tooltip')).toContainText('Vyžaduje technológiu Sypké terminály · 90 XP');
  // tooltip sa zobrazuje prechodom opacity (120 ms) — screenshot až po jeho dokončení
  await expect(lockedRamp.getByRole('tooltip')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: `${SCREENSHOTS}/f4-ui-demo.png`, fullPage: true });

  // --- Brána bez cesty (vzor insp_gate): žltý badge „Nepripojené", banner, 0 / h ---------------------------------------------
  const gateOff = page.getByTestId('gate-disconnected');
  await expect(gateOff.locator('[data-field="badge"]')).toHaveText('Nepripojené');
  await expect(gateOff.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'false');
  await expect(gateOff.locator('[data-section="disconnected"]')).toContainText('Nepripojené k ceste');
  await expect(gateOff.locator('[data-field="stat-queue"]')).toHaveText('0');
  await expect(gateOff.locator('[data-field="stat-throughput"]')).toHaveText('0 / h');

  // --- Čakacia plocha 3 + 1 rezervované z 6: dlaždice a rad stojísk -----------------------------------------------------------
  const waiting = page.getByTestId('waiting-3');
  await expect(waiting.locator('[data-field="sub"]')).toHaveText('WAI-03 · 4×3');
  await expect(waiting.locator('[data-field="stat-used"]')).toHaveText('3');
  await expect(waiting.locator('[data-field="stat-reserved"]')).toHaveText('1');
  await expect(waiting.locator('[data-field="stat-free"]')).toHaveText('2');
  await expect(waiting.locator('[data-field="bays-count"]')).toHaveText('3 / 6 stojísk');
  await expect(waiting.locator('li[data-bay]')).toHaveCount(6);
  await expect(waiting.locator('li[data-state="occupied"]')).toHaveCount(3);
  await expect(waiting.locator('li[data-state="reserved"]')).toHaveCount(1);
  await expect(waiting.locator('li[data-state="free"]')).toHaveCount(2);
  await expect(waiting.locator('li[data-bay="3"]')).toHaveAttribute('title', 'Stojisko 4 · rezervované');
  await expect(waiting.locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(waiting.locator('[data-field="remove-reason"]')).toHaveText('Stojisko používa kamión.');

  // --- Plná čakacia plocha: voľné 0 = žltá dlaždica -------------------------------------------------------------------------------
  const waitingFull = page.getByTestId('waiting-full');
  await expect(waitingFull.locator('[data-field="stat-free"]')).toHaveText('0');
  await expect(waitingFull.locator('[data-field="stat-free"]')).toHaveClass(/module-inspector__stat-value--warn/);
  await expect(waitingFull.locator('li[data-state="free"]')).toHaveCount(0);

  // --- Rampa v prevádzke: dlaždice, docky so staging slotmi a kamiónom ----------------------------------------------------------
  const ramp = page.getByTestId('ramp-ok');
  await expect(ramp.locator('[data-field="sub"]')).toHaveText('RMP-05 · 4×2');
  await expect(ramp.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'true');
  await expect(ramp.locator('[data-field="stat-docks"]')).toHaveText('2');
  await expect(ramp.locator('[data-field="stat-staged"]')).toHaveText('3 / 4');
  await expect(ramp.locator('[data-field="stat-trucks"]')).toHaveText('1');
  await expect(ramp.locator('[data-section="inoperative"]')).toHaveCount(0);
  await expect(ramp.locator('li[data-dock]')).toHaveCount(2);
  const dock1 = ramp.locator('li[data-dock="0"]');
  const dock2 = ramp.locator('li[data-dock="1"]');
  await expect(dock1.locator('[data-field="dock-name"]')).toHaveText('Dock 1');
  await expect(dock1.locator('[data-field="dock-staged"]')).toHaveText('2 / 2');
  await expect(dock1.locator('.module-inspector__pip--filled')).toHaveCount(2);
  await expect(dock1.locator('[data-field="dock-truck"]')).toHaveText('Kamión');
  await expect(dock1.locator('[data-field="dock-truck"] use')).toHaveAttribute('href', /#ic_truck$/);
  await expect(dock2.locator('[data-field="dock-staged"]')).toHaveText('1 / 2');
  await expect(dock2.locator('.module-inspector__pip')).toHaveCount(2);
  await expect(dock2.locator('.module-inspector__pip--filled')).toHaveCount(1);
  await expect(dock2.locator('[data-field="dock-truck"]')).toHaveText('Bez kamióna');

  // --- Neprevádzková rampa: žltý badge „Neprevádzková", banner s dôvodom (vzor „Nepripojené") -------------------------------------
  const inoperative = page.getByTestId('ramp-inoperative');
  const badge = inoperative.locator('[data-field="badge"]');
  await expect(badge).toHaveText('Neprevádzková');
  await expect(badge).toHaveAttribute('data-ok', 'false');
  await expect(badge).toHaveClass(/module-inspector__badge--warn/);
  await expect(badge).toHaveAttribute('title', 'Neprevádzková — Chýba brána na ceste.');
  await expect(inoperative.locator('[data-section="inoperative"]')).toContainText('Rampa je neprevádzková');
  await expect(inoperative.locator('[data-field="inoperative-reason"]')).toHaveText('Chýba brána na ceste.');
  await expect(inoperative.locator('[data-section="disconnected"]')).toHaveCount(0);
  await expect(inoperative.locator('[data-field="stat-staged"]')).toHaveText('0 / 4');
  await expect(inoperative.locator('[data-field="dock-truck"]')).toHaveText(['Bez kamióna', 'Bez kamióna']);
  await expect(inoperative.locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'false');
  const inoperativeLog = inoperative.locator('[data-field="last-action"]');
  await inoperative.locator('[data-action="remove"]').click();
  await expect(inoperativeLog).toHaveText('Posledná akcia: onRemove(6)');

  // --- BuildBar: výber položky Landside volá onSelect, opakovaný klik ruší -----------------------------------------------------------
  const stageLabel = stage.locator('.f4-demo__map-label');
  await rampItem.click();
  await expect(rampItem).toHaveAttribute('aria-pressed', 'true');
  await expect(gateItem).toHaveAttribute('aria-pressed', 'false');
  await expect(stageLabel).toContainText('onSelect(loading_ramp_container)');
  await rampItem.click();
  await expect(rampItem).toHaveAttribute('aria-pressed', 'false');
  await expect(stageLabel).toContainText('onSelect(null)');

  // kontrolný pás: zamknutá položka sa nevyberie (aria-disabled → klik vynútime), drahá brána áno (ghost s ikonou $)
  const statesCaption = states.locator('.f4-demo__caption');
  await lockedRamp.click({ force: true });
  await expect(statesCaption).toContainText('Posledná akcia: —');
  await poorGate.click();
  await expect(poorGate).toHaveAttribute('aria-pressed', 'true');
  await expect(statesCaption).toContainText('onSelect(truck_gate)');
  await expect(states.locator('[data-def-id="loading_ramp_container"]')).toHaveAttribute('aria-pressed', 'false');

  expect(errors).toEqual([]);
});
