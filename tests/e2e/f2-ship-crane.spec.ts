import { expect, test, type Locator, type Page } from '@playwright/test';

// F2 e2e (IMPLEMENTATION_PLAN, Fáza 2; T02-12): hráč vidí loď doplávať, zakotviť, žeriav presúva kontajnery na apron
// a po vyložení loď odpláva; v build móde postaví kotvisko (ghost, R, dôvody v tooltipe, cena) a klikom vyberie modul
// do inšpektora (živé dáta, odstránenie). Na stav sa čaká cez `window.__sim` (polling v rAF stránky), nie pevnými
// timeoutmi — test rýchlosti hodín F1 bol citlivý na záťaž.
//
// Súradnice pre myš dáva `window.__sim.cellToScreen` (stred bunky v súradniciach stránky), pohľad na Root berth
// `window.__sim.centerOn`. Root berth (id 1) = x 40–47, y 14–16; Root žeriav (id 2) = x 43–44, y 14–16.

const WAIT_LIMIT_MS = 60_000;

// Flow trvá ~20 s (loď dopláva ~3 s a vykládka ~2 s reálneho času pri 4× + pomalé WebGL v SwiftShader); strop musí
// obsiahnuť dvojnásobok čakania na loď (docked aj odplávanie) aj pri zaťaženom stroji.
test.describe.configure({ timeout: 3 * WAIT_LIMIT_MS });

/**
 * Pohľad na Root berth: stred (44, 14.5) so zoomom 1 (bunka 64 px) — nad berthom je more s loďou, pod ním apron; HUD hore
 * ani BuildBar dole ho nezakrývajú. Pri 1280×720 je vidno x 34–54, y 9–20 (BuildBar zakrýva y ≥ 18,6, pravý panel x ≥ 48,2).
 */
const ROOT_BERTH_VIEW = { x: 44, y: 14.5, zoom: 1 } as const;

/** Bunka kotviska s ľavým horným rohom (48, 14): bunka pod kurzorom je stredom footprintu 8×3 (roh + (4, 1)). */
const FREE_QUAY_CURSOR = { x: 52, y: 15 } as const;
const FREE_QUAY_ORIGIN = { x: 48, y: 14 } as const;
/** Ďalšie voľné miesto na západ od Root berthu (roh (32, 14)). */
const WEST_QUAY_CURSOR = { x: 36, y: 15 } as const;
/** Pevnina na starter parcele, ďaleko od vody (viditeľná v pohľade na Root berth nad BuildBarom; štítok pri kurzore ostane nad ním). */
const INLAND_CURSOR = { x: 36, y: 17 } as const;

const BERTH_COST_CENTS = 40_000_000;
const START_CASH_CENTS = 120_000_000;

interface GameSession {
  readonly errors: string[];
}

async function openGame(page: Page): Promise<GameSession> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.cellToScreen !== undefined && window.__sim.centerOn !== undefined);
  await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [ROOT_BERTH_VIEW.x, ROOT_BERTH_VIEW.y, ROOT_BERTH_VIEW.zoom] as const);
  return { errors };
}

/** Kliknutie na tlačidlo rýchlosti v HUD (skutočný klik myšou, nie zápis do simu). */
async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Ladiaca loď (feeder, 4 TEU) cez `SpawnShipDebug`; DEV tlačidlo v UI už nie je (kontrakty, T05-07). */
async function spawnDevShip(page: Page): Promise<void> {
  const result = await page.evaluate(() =>
    window.__sim!.dispatchJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }),
  );
  expect(result.ok).toBe(true);
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta a UI. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Myš do rohu stránky (mimo mapy aj UI prvkov: žiadny ghost ani hover tooltip), potom počkať na prekreslenie. */
async function parkMouse(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await settle(page);
}

async function cellToPage(page: Page, cell: { readonly x: number; readonly y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [cell.x, cell.y] as const);
}

async function hoverCell(page: Page, cell: { readonly x: number; readonly y: number }): Promise<void> {
  const point = await cellToPage(page, cell);
  await page.mouse.move(point.x, point.y);
}

async function clickCell(page: Page, cell: { readonly x: number; readonly y: number }): Promise<void> {
  const point = await cellToPage(page, cell);
  await page.mouse.click(point.x, point.y);
}

const moduleGhost = (page: Page) => page.evaluate(() => window.__sim!.moduleGhost!());
const rendered = (page: Page) => page.evaluate(() => window.__sim!.rendered!());
const cashCents = (page: Page) => page.evaluate(() => window.__sim!.world.cashCents);
const berthCount = (page: Page) => page.evaluate(() => window.__sim!.entities().modules.length);
const inputState = (page: Page): Locator => page.locator('.app__map');
const buildTip = (page: Page): Locator => page.locator('[data-field="build-tip"]');
const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Inšpektor modulu' });

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}`;
}

/** Čaká, kým `condition` (v stránke) neplatí; pri zhode spustí `onMatch` v tom istom rAF kroku (bez medzery na zmenu stavu). */
async function waitInPage(page: Page, condition: () => boolean): Promise<void> {
  await page.waitForFunction(condition, undefined, { timeout: WAIT_LIMIT_MS });
}

test.describe('F2: loď, žeriav, apron (T02-12)', () => {
  test('Root modul na nábreží, BuildBar dole, DEV spawn → loď zakotví, žeriav vykladá, loď odpláva', async ({ page }) => {
    const { errors } = await openGame(page);

    // 1) štart: Root berth a žeriav sú vo view-modeloch aj v rendereri (starter moduly nemajú udalosť ModulePlaced)
    const start = await page.evaluate(() => {
      const entities = window.__sim!.entities();
      return {
        modules: entities.modules.map((module) => [module.id, module.defId, module.x, module.y, module.apron?.units.length]),
        cranes: entities.cranes.map((crane) => [crane.id, crane.berthId, crane.state]),
        ships: entities.ships.length,
        rendered: window.__sim!.rendered!(),
      };
    });
    expect(start.modules).toEqual([[1, 'berth_standard', 40, 14, 0]]);
    expect(start.cranes).toEqual([[2, 1, 'idle']]);
    expect(start.ships).toBe(0);
    expect(start.rendered).toMatchObject({ modules: 1, cranes: 1, ships: 0, ghostCells: 0, ghostConnectors: 0, selectionRing: false });

    // 2) BuildBar dole: kategória Terminál z defs.modules, ceny, ostatné kategórie zamknuté; klávesy 1–4 sú rýchlosti,
    // preto taby nemajú číselné nápovedy; výber položky zapne build mód a opätovný klik ho vypne
    const bar = page.getByRole('contentinfo', { name: 'Stavba' });
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-def-id]')).toHaveCount(2);
    const berthItem = bar.locator('[data-def-id="berth_standard"]');
    await expect(berthItem).toContainText('Kotvisko');
    await expect(berthItem).toContainText('$400,000');
    await expect(bar.locator('[data-def-id="crane_container_gantry"]')).toContainText('$600,000');
    // F3 (T03-10, T03-20): Sklady, Logistika a Landside (typy ciest) sú povolené, kategórie ďalších fáz ostávajú zamknuté
    await expect(bar.locator('[data-category="storage"]')).toBeEnabled();
    await expect(bar.locator('[data-category="logistics"]')).toBeEnabled();
    await expect(bar.locator('[data-category="landside"]')).toBeEnabled();
    await expect(bar.locator('[data-category="rail"]')).toBeDisabled();
    await expect(bar.locator('[data-category="pipes"]')).toBeDisabled();
    await expect(bar.locator('.build-bar__tabs .build-bar__tab kbd')).toHaveCount(0);
    await expect(berthItem).toHaveAttribute('aria-pressed', 'false');
    await berthItem.click();
    await expect(berthItem).toHaveAttribute('aria-pressed', 'true');
    await expect(inputState(page)).toHaveAttribute('data-input-state', 'build_module');
    await berthItem.click();
    await expect(berthItem).toHaveAttribute('aria-pressed', 'false');
    await expect(inputState(page)).toHaveAttribute('data-input-state', 'idle');

    // 3) HUD: rýchlosti zo snapshotu
    await expect(page.locator('[data-field="speed"] button')).toHaveCount(5);

    // 4) SpawnShipDebug + 4×: loď doplaví a zakotví (podmienka sa vyhodnotí v rAF stránky a pri zhode hneď spomalí hru na 1×,
    // aby vykládka nepreletela medzi dvoma snímkami)
    await spawnDevShip(page);
    await setSpeed(page, 4);
    await page.waitForFunction(() => window.__sim!.entities().ships.length === 1);
    await expect.poll(() => page.evaluate(() => window.__sim!.rendered!().ships)).toBe(1);
    await waitInPage(page, () => {
      const docked = window.__sim!.entities().ships[0]?.state === 'docked';
      if (docked) window.__sim!.world.clock.setSpeed(1);
      return docked;
    });

    // Žeriav v grabbing|placing a aspoň jeden kontajner na aprone: hra sa v tom istom kroku pozastaví, aby screenshot
    // ukazoval presne overený stav (loď docked, výložník uprostred cyklu).
    await waitInPage(page, () => {
      const { ships, cranes, modules } = window.__sim!.entities();
      const crane = cranes[0];
      const working =
        ships[0]?.state === 'docked' && (crane?.state === 'grabbing' || crane?.state === 'placing') && (modules[0]?.apron?.units.length ?? 0) >= 1;
      if (working) window.__sim!.world.clock.setSpeed(0);
      return working;
    });
    await parkMouse(page);

    const docked = await page.evaluate(() => {
      const { ships, cranes, modules } = window.__sim!.entities();
      return { ship: ships[0], crane: cranes[0], apron: modules[0]?.apron?.units.length, rendered: window.__sim!.rendered!() };
    });
    expect(docked.ship).toMatchObject({ classId: 'feeder', cargoCategory: 'container', state: 'docked' });
    expect(docked.ship?.unitsOnBoard).toBeGreaterThan(0);
    expect(['grabbing', 'placing']).toContain(docked.crane?.state);
    expect(docked.apron).toBeGreaterThanOrEqual(1);
    expect(docked.rendered).toMatchObject({ modules: 1, cranes: 1, ships: 1 });
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-docked.png', fullPage: true });

    // 5) po vyložení: loď preč (view zaniklo), na aprone 4 jednotky, žeriav opäť nečinný
    await setSpeed(page, 4);
    await waitInPage(page, () => {
      const { ships, modules } = window.__sim!.entities();
      return ships.length === 0 && modules[0]?.apron?.units.length === 4;
    });
    await expect.poll(() => page.evaluate(() => window.__sim!.rendered!().ships)).toBe(0);
    const done = await page.evaluate(() => {
      const { cranes, modules } = window.__sim!.entities();
      return { crane: cranes[0]?.state, slots: modules[0]?.apron?.units.map((unit) => unit.slot), types: modules[0]?.apron?.units.map((unit) => unit.typeId) };
    });
    expect(done.crane).toBe('idle');
    expect(done.slots).toEqual([0, 1, 2, 3]);
    expect(done.types).toEqual(Array<string>(4).fill('container_teu'));
    await setSpeed(page, 1);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-departed.png', fullPage: true });

    expect(errors).toEqual([]);
  });

  test('build mód: ghost kotviska (dôvody, R, cena), postavenie, chýbajúce peniaze, Esc, výber a odstránenie', async ({ page }) => {
    const { errors } = await openGame(page);
    const berthItem = page.locator('[data-def-id="berth_standard"]');
    expect(await cashCents(page)).toBe(START_CASH_CENTS);
    expect(await berthCount(page)).toBe(1);

    // 1) klik na „Kotvisko“ v BuildBare zapne build mód modulu; kým kurzor nie je nad mapou, ghost nie je
    await berthItem.click();
    await expect(berthItem).toHaveAttribute('aria-pressed', 'true');
    await expect(inputState(page)).toHaveAttribute('data-input-state', 'build_module');
    expect(await moduleGhost(page)).toBeNull();

    // 2) nad pevninou je ghost neplatný a tooltip vypíše slovenské dôvody aj cenu
    await hoverCell(page, INLAND_CURSOR);
    await expect.poll(() => moduleGhost(page)).toMatchObject({ defId: 'berth_standard', w: 8, h: 3, valid: false });
    await expect(buildTip(page)).toHaveAttribute('data-ok', 'false');
    await expect(buildTip(page)).toContainText('Kotvisko · $400,000');
    await expect(buildTip(page)).toContainText('Nevhodný terén');
    await expect(buildTip(page)).toContainText('Dlhá hrana musí byť pri vode');
    expect(await rendered(page)).toMatchObject({ ghostCells: 24, ghostConnectors: 2 });
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-build-invalid.png', fullPage: true });

    // 3) na voľnom nábreží (roh (48, 14)) je ghost platný: zelený, s konektormi na južnej hrane
    await hoverCell(page, FREE_QUAY_CURSOR);
    await expect.poll(() => moduleGhost(page)).toMatchObject({ x: FREE_QUAY_ORIGIN.x, y: FREE_QUAY_ORIGIN.y, rotation: 0, valid: true });
    expect((await moduleGhost(page))?.connectors).toEqual([
      { x: 49, y: 16, side: 's' },
      { x: 54, y: 16, side: 's' },
    ]);
    await expect(buildTip(page)).toHaveAttribute('data-ok', 'true');
    await expect(buildTip(page)).toHaveText('Kotvisko · $400,000');
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-build-valid.png', fullPage: true });

    // 4) R otočí ghost o 90° (dlhá hrana už nie je pri vode → neplatný); po štyroch stlačeniach je späť platný
    await page.keyboard.press('KeyR');
    await expect.poll(() => moduleGhost(page)).toMatchObject({ rotation: 90, w: 3, h: 8, valid: false });
    await expect(buildTip(page)).toContainText('Dlhá hrana musí byť pri vode');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('KeyR');
    await expect.poll(() => moduleGhost(page)).toMatchObject({ rotation: 0, x: FREE_QUAY_ORIGIN.x, y: FREE_QUAY_ORIGIN.y, valid: true });

    // 5) klik postaví kotvisko: modules +1, hotovosť −$400,000 (aj v HUD); mód ostáva a ghost je na tom istom mieste neplatný
    await clickCell(page, FREE_QUAY_CURSOR);
    await expect.poll(() => berthCount(page)).toBe(2);
    expect(await cashCents(page)).toBe(START_CASH_CENTS - BERTH_COST_CENTS);
    await expect(page.locator('[data-field="cash"]')).toHaveText(formatUsd(START_CASH_CENTS - BERTH_COST_CENTS));
    expect(await rendered(page)).toMatchObject({ modules: 2 });
    await expect(inputState(page)).toHaveAttribute('data-input-state', 'build_module');
    await expect(berthItem).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => moduleGhost(page)).toMatchObject({ valid: false });
    await expect(buildTip(page)).toContainText('Obsadené');

    // 6) chýbajúce peniaze: ghost ostáva zelený s ikonou $, ale klik nič nepostaví (§8 bod 6); položka ide vybrať
    await page.evaluate((cents) => {
      // Hotovosť sa mení len cez Economy.post (ADR-025); úprava ide do knihy ako CAPEX.
      const { world } = window.__sim!;
      world.economy.post(cents - world.cashCents, 'module_capex');
    }, 1_000_000);
    await hoverCell(page, WEST_QUAY_CURSOR);
    await expect.poll(() => moduleGhost(page)).toMatchObject({ x: 32, y: 14, valid: true });
    await expect(buildTip(page)).toHaveAttribute('data-ok', 'false');
    await expect(buildTip(page)).toHaveAttribute('data-funds-short', 'true');
    await expect(buildTip(page)).toContainText('Nedostatok peňazí');
    await expect(buildTip(page).locator('use')).toHaveAttribute('href', /ic_cash/);
    await expect(berthItem).toHaveAttribute('data-status', 'unaffordable');
    await expect(berthItem).toHaveAttribute('aria-pressed', 'true');
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-build-funds.png', fullPage: true });
    const tickBefore = await page.evaluate(() => window.__sim!.world.clock.tick);
    await clickCell(page, WEST_QUAY_CURSOR);
    await page.waitForFunction((tick) => window.__sim!.world.clock.tick >= tick + 3, tickBefore);
    expect(await berthCount(page)).toBe(2);
    expect(await cashCents(page)).toBe(1_000_000);

    // 7) Esc zruší build mód: ghost, tooltip aj výber v BuildBare zmiznú
    await page.keyboard.press('Escape');
    await expect(inputState(page)).toHaveAttribute('data-input-state', 'idle');
    await expect(berthItem).toHaveAttribute('aria-pressed', 'false');
    await expect(buildTip(page)).toHaveCount(0);
    expect(await moduleGhost(page)).toBeNull();
    expect(await rendered(page)).toMatchObject({ ghostCells: 0, ghostConnectors: 0 });

    // 8) klik na postavené kotvisko ho vyberie: obrys výberu + inšpektor (Voľné, apron 0 / 8, vrátenie polovice ceny)
    await clickCell(page, { x: 50, y: 15 });
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page).locator('[data-field="title"]')).toHaveText('Kotvisko');
    // F3 (T03-10): kotvisko má cestné konektory a pri novom kotvisku ešte nevedie cesta → badge „Nepripojené“ (má prednosť pred „Voľné“)
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Nepripojené');
    await expect(inspector(page).locator('[data-field="apron-count"]')).toHaveText('0 / 8 slotov');
    await expect(inspector(page).locator('[data-field="refund"]')).toHaveText(formatUsd(BERTH_COST_CENTS / 2));
    await expect(inspector(page).locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'false');
    expect(await rendered(page)).toMatchObject({ selectionRing: true });

    // 9) Odstrániť: modul zmizne, hotovosť sa zvýši o refundáciu, inšpektor aj obrys zaniknú
    await inspector(page).locator('[data-action="remove"]').click();
    await expect.poll(() => berthCount(page)).toBe(1);
    expect(await cashCents(page)).toBe(1_000_000 + BERTH_COST_CENTS / 2);
    await expect(inspector(page)).toHaveCount(0);
    await expect.poll(() => rendered(page)).toMatchObject({ modules: 1, selectionRing: false });

    expect(errors).toEqual([]);
  });

  test('výber Root žeriavu počas vykládky: inšpektor „Vykladá“, Odstrániť zablokované s dôvodom; živé dáta po odchode lode', async ({ page }) => {
    const { errors } = await openGame(page);

    // loď zakotví a žeriav vykladá (hra sa v tom istom kroku pozastaví, aby bol stav stabilný)
    await spawnDevShip(page);
    await setSpeed(page, 4);
    await waitInPage(page, () => {
      const docked = window.__sim!.entities().ships[0]?.state === 'docked';
      if (docked) window.__sim!.world.clock.setSpeed(1);
      return docked;
    });
    await waitInPage(page, () => {
      const crane = window.__sim!.entities().cranes[0];
      const working = crane?.state === 'grabbing' || crane?.state === 'placing';
      if (working) window.__sim!.world.clock.setSpeed(0);
      return working;
    });

    // klik na bunku Root žeriavu (x 43–44) — žeriav má prednosť pred kotviskom pod ním
    await clickCell(page, { x: 43, y: 15 });
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page)).toHaveAttribute('data-module-id', '2');
    await expect(inspector(page).locator('[data-field="title"]')).toHaveText('Kontajnerový žeriav');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Vykladá');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'true');
    expect(await rendered(page)).toMatchObject({ selectionRing: true });

    // Odstrániť je zablokované a ukazuje dôvod (kotví loď, žeriav pracuje); násilný klik nič neodstráni
    const remove = inspector(page).locator('[data-action="remove"]');
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(inspector(page).locator('[data-field="remove-reason"]')).toContainText('Pri kotvisku kotví loď');
    await expect(inspector(page).locator('[data-field="remove-reason"]')).toContainText('Žeriav práve pracuje');
    await expect(remove).toHaveAttribute('title', /Pri kotvisku kotví loď/);
    await remove.click({ force: true });
    const tickBefore = await page.evaluate(() => window.__sim!.world.clock.tick);
    await setSpeed(page, 1);
    await page.waitForFunction((tick) => window.__sim!.world.clock.tick >= tick + 2, tickBefore);
    expect(await page.evaluate(() => window.__sim!.entities().cranes.length)).toBe(1);

    await setSpeed(page, 0);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-inspector.png', fullPage: true });

    // živé dáta: po vyložení a odchode lode sa inšpektor sám prepne na Nečinný a Odstrániť sa odblokuje
    await setSpeed(page, 4);
    await waitInPage(page, () => window.__sim!.entities().ships.length === 0);
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Nečinný');
    await expect(remove).toHaveAttribute('aria-disabled', 'false');
    await expect(inspector(page).locator('[data-field="remove-reason"]')).toHaveCount(0);
    // Root žeriav je starter modul: vrátenie $0
    await expect(inspector(page).locator('[data-field="refund"]')).toHaveText('$0');

    // Esc v pokoji zavrie inšpektor aj obrys výberu
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);
    await expect.poll(() => rendered(page)).toMatchObject({ selectionRing: false });

    expect(errors).toEqual([]);
  });
});
