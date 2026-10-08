import { expect, test, type Locator, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// F2 e2e (IMPLEMENTATION_PLAN, Fáza 2; T02-12): hráč vidí loď doplávať, zakotviť, žeriav vykladá a po vyložení loď odpláva;
// v build móde postaví kotvisko (ghost, R, dôvody v tooltipe, cena) a klikom vyberie modul do inšpektora (živé dáta,
// odstránenie). Na stav sa čaká cez `window.__sim` (polling v rAF stránky), nie pevnými timeoutmi — test rýchlosti hodín F1
// bol citlivý na záťaž.
//
// Predvolený režim odovzdávania kotviska je od F6a `under_hook` (ADR-033): žeriav bez vozidla pod hákom drží jednotku v háku
// (predvolený buffer 0 od T6D-02, apron ostáva prázdny) a čaká, takže loď neodpláva, kým nemá kam vykladať. Testy vykládky preto pred spawnom lode
// postavia sklad, cesty a depo a kúpia vozidlo (rozloženie F3, `buildUnloadLogistics`); test „bez vozidla“ overí samotné
// čakanie (inšpektor „Čaká na vozidlo“) a že vykládka pokračuje, keď logistika pribudne.
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
const FREE_QUAY_CURSOR = { x: 52, y: 16 } as const;
const FREE_QUAY_ORIGIN = { x: 48, y: 14 } as const;
/** Ďalšie voľné miesto na západ od Root berthu (roh (32, 14)). */
const WEST_QUAY_CURSOR = { x: 36, y: 16 } as const;
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

/** Cesty rozloženia F3 (okruh pri Root berthe, chrbtica k depu) po úsekoch `[x0, y0, x1, y1]`; 34 buniek. */
const LOGISTICS_ROADS: readonly (readonly [number, number, number, number])[] = [
  [41, 18, 41, 22],
  [46, 18, 46, 22],
  [42, 22, 45, 22],
  [44, 23, 44, 30],
  [45, 30, 50, 30],
];

function segmentCells([x0, y0, x1, y1]: readonly [number, number, number, number]): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  for (let x = x0, y = y0; ; x += dx, y += dy) {
    cells.push({ x, y });
    if (x === x1 && y === y1) return cells;
  }
}

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

/**
 * Logistika pre vykládku pod hákom (rozloženie F3 cez `dispatchJSON`): cesty, depo, blízky dvor a jedno vozidlo (straddle
 * carrier). Depo nájde podľa defu — id entít sú spoločná postupnosť, takže po lodi nemá id 3.
 */
async function buildUnloadLogistics(page: Page): Promise<void> {
  for (const segment of LOGISTICS_ROADS) expect(await dispatch(page, { type: 'PlaceRoad', cells: segmentCells(segment) })).toMatchObject({ ok: true });
  expect(await dispatch(page, { type: 'PlaceModule', defId: 'vehicle_depot', x: 46, y: 27, rotation: 0 })).toMatchObject({ ok: true });
  expect(await dispatch(page, { type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 })).toMatchObject({ ok: true });
  await expect.poll(() => page.evaluate(() => window.__sim!.entities().modules.some((module) => module.defId === 'vehicle_depot'))).toBe(true);
  const depotId = await page.evaluate(() => window.__sim!.entities().modules.find((module) => module.defId === 'vehicle_depot')!.id);
  expect(await dispatch(page, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId })).toMatchObject({ ok: true });
  await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(1);
}

/**
 * Klik na bunku, ktorý vyberie modul: hover + prekreslenie a až potom klik; inšpektor sa musí ukázať hneď. Bez opakovania:
 * opakovaný klik by zakryl zlyhanie vstupu (pozri `dismissToasts`, prerušený `locator.click` spolkne ďalšie kliky myši).
 */
async function selectModuleAt(page: Page, cell: { readonly x: number; readonly y: number }): Promise<void> {
  await hoverCell(page, cell);
  await settle(page);
  await clickCell(page, cell);
  await expect(inspector(page)).toBeVisible();
}

/** Počet uložených jednotiek vo všetkých skladoch (ledger) — vykladaný náklad končí vo dvore, nie na aprone. */
const storedUnits = (page: Page) => page.evaluate(() => window.__sim!.world.cargo.countByKind('in_storage'));

test.describe('F2: loď, žeriav, apron (T02-12)', () => {
  test('Root modul na nábreží, BuildBar dole, DEV spawn → loď zakotví, žeriav vykladá do vozidla, loď odpláva, náklad je vo dvore', async ({ page }) => {
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

    // 4) Logistika (ADR-033): cesty, depo, dvor a vozidlo ešte pred lodou, inak by žeriav s jednotkou v háku čakal na
    // vozidlo. Potom SpawnShipDebug + 4×: loď doplaví a zakotví (podmienka sa vyhodnotí v rAF stránky a pri zhode hneď spomalí
    // hru na 1×, aby vykládka nepreletela medzi dvoma snímkami)
    await buildUnloadLogistics(page);
    await spawnDevShip(page);
    await setSpeed(page, 4);
    await page.waitForFunction(() => window.__sim!.entities().ships.length === 1);
    await expect.poll(() => page.evaluate(() => window.__sim!.rendered!().ships)).toBe(1);
    await waitInPage(page, () => {
      const docked = window.__sim!.entities().ships[0]?.state === 'docked';
      if (docked) window.__sim!.world.clock.setSpeed(1);
      return docked;
    });

    // Žeriav v grabbing|placing pri zakotvenej lodi: hra sa v tom istom kroku pozastaví, aby screenshot ukazoval presne
    // overený stav (loď docked, výložník uprostred cyklu).
    await waitInPage(page, () => {
      const { ships, cranes } = window.__sim!.entities();
      const crane = cranes[0];
      const working = ships[0]?.state === 'docked' && (crane?.state === 'grabbing' || crane?.state === 'placing');
      if (working) window.__sim!.world.clock.setSpeed(0);
      return working;
    });
    await parkMouse(page);

    const docked = await page.evaluate(() => {
      const { ships, cranes, modules, vehicles } = window.__sim!.entities();
      return { ship: ships[0], crane: cranes[0], vehicles: vehicles?.length, rendered: window.__sim!.rendered!(), modules: modules.map((module) => module.defId) };
    });
    expect(docked.ship).toMatchObject({ classId: 'feeder', cargoCategory: 'container', state: 'docked' });
    expect(docked.ship?.unitsOnBoard).toBeGreaterThan(0);
    expect(['grabbing', 'placing']).toContain(docked.crane?.state);
    expect(docked.modules).toEqual(['berth_standard', 'vehicle_depot', 'container_yard_small']);
    expect(docked.vehicles).toBe(1);
    expect(docked.rendered).toMatchObject({ modules: 3, cranes: 1, ships: 1, vehicles: 1 });
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-docked.png', fullPage: true });

    // 5) po vyložení: loď preč (view zaniklo), všetky 4 jednotky prešli žeriav → vozidlo → dvor (apron je prázdny), žeriav opäť nečinný
    await setSpeed(page, 4);
    await waitInPage(page, () => window.__sim!.entities().ships.length === 0 && window.__sim!.world.cargo.countByKind('in_storage') === 4);
    await expect.poll(() => page.evaluate(() => window.__sim!.rendered!().ships)).toBe(0);
    const done = await page.evaluate(() => {
      const { cranes, modules } = window.__sim!.entities();
      const yard = modules.find((module) => module.defId === 'container_yard_small');
      return { crane: cranes[0]?.state, apron: modules[0]?.apron?.units.length, stored: yard?.storage?.stored, onApron: window.__sim!.world.cargo.countByKind('on_apron') };
    });
    expect(done.crane).toBe('idle');
    expect(done).toMatchObject({ apron: 0, onApron: 0, stored: 4 });
    expect(await storedUnits(page)).toBe(4);
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
    await expect.poll(() => moduleGhost(page)).toMatchObject({ defId: 'berth_standard', w: 8, h: 4, valid: false });
    await expect(buildTip(page)).toHaveAttribute('data-ok', 'false');
    await expect(buildTip(page)).toContainText('Kotvisko · $400,000');
    await expect(buildTip(page)).toContainText('Dlhá hrana musí byť pri vode');
    expect(await rendered(page)).toMatchObject({ ghostCells: 32, ghostConnectors: 8 });
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-build-invalid.png', fullPage: true });

    // 3) na voľnom nábreží (roh (48, 14)) je ghost platný: zelený, s konektormi na južnej hrane
    await hoverCell(page, FREE_QUAY_CURSOR);
    await expect.poll(() => moduleGhost(page)).toMatchObject({ x: FREE_QUAY_ORIGIN.x, y: FREE_QUAY_ORIGIN.y, rotation: 0, valid: true });
    // kotvisko 8×4: dva južné konektory (riadok pri pevnine) + pruhové w/e v riadkoch 1–3 (ADR-040 dodatok)
    const ghostConnectors = (await moduleGhost(page))?.connectors ?? [];
    expect(ghostConnectors).toHaveLength(8);
    expect(ghostConnectors.filter((connector) => connector.side === 's')).toEqual([
      { x: 49, y: 17, side: 's' },
      { x: 54, y: 17, side: 's' },
    ]);
    await expect(buildTip(page)).toHaveAttribute('data-ok', 'true');
    await expect(buildTip(page)).toHaveText('Kotvisko · $400,000');
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-build-valid.png', fullPage: true });

    // 4) R otočí ghost o 90° (dlhá hrana už nie je pri vode → neplatný); po štyroch stlačeniach je späť platný
    await page.keyboard.press('KeyR');
    await expect.poll(() => moduleGhost(page)).toMatchObject({ rotation: 90, w: 4, h: 8, valid: false });
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

    // logistika pred lodou (ADR-033); loď zakotví a žeriav vykladá (hra sa v tom istom kroku pozastaví, aby bol stav stabilný).
    // Čaká sa na `grabbing`: v `placing` môže žeriav (kým vozidlo nepríde pod hák) len čakať a inšpektor by ukázal „Čaká na vozidlo“.
    await buildUnloadLogistics(page);
    await spawnDevShip(page);
    await setSpeed(page, 4);
    await waitInPage(page, () => {
      const docked = window.__sim!.entities().ships[0]?.state === 'docked';
      if (docked) window.__sim!.world.clock.setSpeed(1);
      return docked;
    });
    await waitInPage(page, () => {
      const working = window.__sim!.entities().cranes[0]?.state === 'grabbing';
      if (working) window.__sim!.world.clock.setSpeed(0);
      return working;
    });

    // klik na bunku Root žeriavu (x 43–44) — žeriav má prednosť pred kotviskom pod ním; toasty (ponuky, sklad) ju nesmú prekrývať
    await dismissToasts(page);
    await selectModuleAt(page, { x: 43, y: 15 });
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
    await waitInPage(page, () => window.__sim!.entities().ships.length === 0 && window.__sim!.world.cargo.countByKind('in_storage') === 4);
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

  test('bez vozidla (ADR-033, buffer 0 od T6D-02): žeriav drží prvú jednotku v háku a čaká, apron ostáva prázdny, inšpektor „Čaká na vozidlo“; po dodaní logistiky vykládka dokončí', async ({ page }) => {
    const { errors } = await openGame(page);

    // loď bez skladu, ciest a vozidiel: predvolený buffer 0 — žeriav nemá kam odložiť, prvú jednotku drží v háku a apron ostáva prázdny
    await spawnDevShip(page);
    await setSpeed(page, 4);
    await waitInPage(page, () => {
      const { ships, cranes, modules } = window.__sim!.entities();
      const crane = window.__sim!.world.modules.get(2 as never) as unknown as { readonly waitForVehicleTicks: number };
      const waiting =
        ships[0]?.state === 'docked' && cranes[0]?.state === 'placing' && cranes[0].holding !== null && (modules[0]?.apron?.units.length ?? 0) === 0 && crane.waitForVehicleTicks > 5;
      if (waiting) window.__sim!.world.clock.setSpeed(0);
      return waiting;
    });
    const waitingAt = await page.evaluate(() => {
      const { ships, cranes, modules } = window.__sim!.entities();
      return { held: cranes[0]?.holding?.unitId, onBoard: ships[0]?.unitsOnBoard, apron: modules[0]?.apron?.units.length, tick: window.__sim!.world.clock.tick };
    });
    expect(waitingAt.apron).toBe(0);
    expect(waitingAt.onBoard).toBe(3); // 4 TEU: jedna v háku, tri ešte na lodi

    // inšpektor žeriavu: „Čaká na vozidlo“ (žltý badge + banner), nie „Vykladá“; Odstrániť ostáva zablokované (žeriav drží jednotku)
    await dismissToasts(page);
    await selectModuleAt(page, { x: 43, y: 15 });
    await expect(inspector(page)).toHaveAttribute('data-module-id', '2');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Čaká na vozidlo');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'false');
    await expect(inspector(page).locator('[data-section="waiting"]')).toContainText('pokračuje, keď vozidlo príde pod hák');
    await expect(inspector(page).locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'true');
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-crane-waiting.png', fullPage: true });

    // žeriav naozaj čaká: po ďalších tickoch drží tú istú jednotku a na lodi ostali tri (nič sa nevyloží bez vozidla)
    await setSpeed(page, 4);
    await page.waitForFunction((tick) => window.__sim!.world.clock.tick >= tick + 200, waitingAt.tick);
    const later = await page.evaluate(() => {
      const { ships, cranes, modules } = window.__sim!.entities();
      return { held: cranes[0]?.holding?.unitId, onBoard: ships[0]?.unitsOnBoard, apron: modules[0]?.apron?.units.length, state: cranes[0]?.state, shipState: ships[0]?.state };
    });
    expect(later).toMatchObject({ held: waitingAt.held, onBoard: 3, apron: 0, state: 'placing', shipState: 'docked' });
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Čaká na vozidlo');

    // dodanie logistiky (cesty, depo, dvor, vozidlo) uvoľní čakanie: všetky 4 jednotky skončia vo dvore, loď odpláva, žeriav je nečinný
    await buildUnloadLogistics(page);
    await waitInPage(page, () => window.__sim!.entities().ships.length === 0 && window.__sim!.world.cargo.countByKind('in_storage') === 4);
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Nečinný');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'true');
    await expect(inspector(page).locator('[data-section="waiting"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__sim!.world.cargo.countByKind('on_apron'))).toBe(0);
    expect(await page.evaluate(() => window.__sim!.world.modules.get(2 as never) !== undefined && (window.__sim!.world.modules.get(2 as never) as unknown as { waitForVehicleTicks: number }).waitForVehicleTicks)).toBeGreaterThan(5);

    expect(errors).toEqual([]);
  });
});
