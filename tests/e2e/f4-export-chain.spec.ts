import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatMoney } from '../../src/ui/format';

// F4 e2e (T04-10): celý reťazec fázy 4 z pohľadu hráča — loď → apron → vozidlá → dvor → rampa → kamión → export.
// Cesty, depo a dva dvory idú cez `dispatchJSON` (ako vo F3), pozemnú časť exportu — bránu, čakaciu plochu (stojiská)
// a rampu — stavia hráč cez UI: BuildBar → Landside → položka, klávesa R (brána rot 270), klik na bunku. Vozidlá sa
// kupujú klikom v BuildBare (Logistika → Straddle carrier). Potom DEV loď s 24 TEU (`SpawnShipDebug`) a na stav sa čaká
// cez `window.__sim` (polling v rAF stránky), nie pevnými timeoutmi:
//   1) kamión vo fronte brány (odznak fronty) a ďalší už v stojisku → screenshot `f4-trucks-gate.png`,
//   2) všetkých 24 jednotiek je `exported`, na mape nie je žiadny kamión → screenshot `f4-exported.png`.
//
// Rozloženie = scenár `full_import_chain` (tests/sim/helpers/f4-layout.ts, data/scenarios/full_import_chain.json).
// Moduly majú id v poradí stavby: Root berth 1, žeriav 2, depo 3, dvory 4 a 5, brána 6, stojisko 7, rampa 8.
// Brána (45, 32) rot 270 (konektory (45, 33) a (46, 33)), stojisko (49, 31) rot 0, rampa (53, 28) rot 0.
// Kamión vstupuje z portálu (44, 63) po verejnej ceste x = 44 na sever, bránou na východ, stojiskom na východ a po
// x = 53 na sever k dokom rampy na vetve y = 30.

const WAIT_LIMIT_MS = 60_000;
test.describe.configure({ timeout: 5 * WAIT_LIMIT_MS });

const DEPOT_ID = 3;
const NEAR_YARD_ID = 4;
const FAR_YARD_ID = 5;
const GATE_ID = 6;
const WAITING_AREA_ID = 7;
const RAMP_ID = 8;

/** Loď s 24 TEU: každá jednotka = jeden kamión (`truck_container.capacityUnits` = 1). */
const UNITS = 24;
const VEHICLES = 3;
/** Po toľkých exportoch sa screenshot fronty zoberie aj bez súbehu kamióna vo fronte a v stojisku (pozri krok 5). */
const FALLBACK_EXPORTED = 12;

/** Ceny z defov (BuildBar ich ukazuje ako $/kus); cesta dvojpruhová $2,000 za bunku. */
const ROAD_COST_CENTS = 200_000;
const DEPOT_COST_CENTS = 9_000_000;
const YARD_COST_CENTS = 15_000_000;
const GATE_COST_CENTS = 8_000_000;
const WAITING_AREA_COST_CENTS = 6_000_000;
const RAMP_COST_CENTS = 10_000_000;
const CARRIER_COST_CENTS = 4_800_000;
/**
 * Denná údržba a mzdy postaveného prístavu (ADR-025), strhnuté pri každom uzavretí herného dňa: údržba Root berth 120 000
 * + žeriav 90 000 + depo 15 000 + 2 dvory 60 000 + brána 15 000 + stojisko 10 000 + rampa 20 000 = 330 000, mzdy žeriav
 * 25 000 + 3 vozidlá 54 000 = 79 000. Všetko stojí skôr, než uplynie prvý herný deň.
 */
const DAILY_UPKEEP_CENTS = 409_000;

type Cell = { readonly x: number; readonly y: number };

/** Cesty F3 (34 buniek) a pozemnej časti F4 (11 buniek), po úsekoch `[x0, y0, x1, y1]` ako `PlaceRoad` v scenári. */
const ROAD_SEGMENTS: readonly (readonly [number, number, number, number])[] = [
  // F3: okruh pri Root berthe, chrbtica k depu a vetva k ďalekému dvoru
  [41, 17, 41, 22],
  [46, 17, 46, 22],
  [42, 22, 45, 22],
  [42, 17, 45, 17],
  [44, 23, 44, 30],
  [45, 30, 50, 30],
  // F4: vstup brány, výstup brány + západ stojiska, východ stojiska → sever, predĺženie vetvy k dokom rampy
  [44, 33, 44, 33],
  [47, 33, 48, 33],
  [53, 31, 53, 33],
  [51, 30, 55, 30],
];
const ROAD_CELL_COUNT = 34 + 11;

/**
 * Bunka pod kurzorom je stredom footprintu po rotácii (pri párnom rozmere `floor(rozmer / 2)` od rohu): brána 2×2
 * rot 270 (roh 45,32), stojisko 4×3 rot 0 (roh 49,31), rampa 4×2 rot 0 (roh 53,28).
 */
const GATE_CURSOR: Cell = { x: 46, y: 33 };
const WAITING_AREA_CURSOR: Cell = { x: 51, y: 32 };
const RAMP_CURSOR: Cell = { x: 55, y: 29 };

/** Pohľad na celé rozloženie pri stavbe: zoom 0,5 (bunka 32 px), stred posunutý o pás HUD a BuildBaru. */
const OVERVIEW = { x: 47, y: 28, zoom: 0.5 } as const;
/**
 * Pohľad na pozemnú časť exportu (oba screenshoty): zoom 1 (bunka 64 px), mapa je viditeľná medzi pásom HUD (48 px) a
 * BuildBarom (od y = 624), preto je stred posunutý na y 32,4. Vidno bránu (45–46, 32–33) so závorou a vstupnú bunku
 * (44, 33) s odznakom fronty, stojisko (49–52, 31–33), rampu (53–56, 28–29) a cesty medzi nimi.
 */
const LANDSIDE_VIEW = { x: 50.5, y: 32.4, zoom: 1 } as const;

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(
    () => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined && window.__sim.cellToScreen !== undefined,
  );
  return errors;
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

/** Kliknutie na tlačidlo rýchlosti v HUD (skutočný klik myšou, nie zápis do simu). */
async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function view(page: Page, x: number, y: number, zoom: number): Promise<void> {
  await page.evaluate(([cx, cy, z]) => window.__sim!.centerOn!(cx, cy, z), [x, y, zoom] as const);
  await settle(page);
}

async function screenOf(page: Page, cell: Cell): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [cell.x, cell.y] as const);
}

const map = (page: Page): Locator => page.locator('.app__map');
const bar = (page: Page): Locator => page.getByRole('contentinfo', { name: 'Stavba' });
const entities = (page: Page) => page.evaluate(() => window.__sim!.entities());
const rendered = (page: Page) => page.evaluate(() => window.__sim!.rendered!());
const cashCents = (page: Page) => page.evaluate(() => window.__sim!.world.cashCents);
const moduleCount = (page: Page) => page.evaluate(() => window.__sim!.entities().modules.length);
const vehicleCount = (page: Page) => page.evaluate(() => window.__sim!.world.vehicles.size);

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

/** Bunky úseku `[x0, y0, x1, y1]` (vodorovného alebo zvislého) pre `PlaceRoad`. */
function segmentCells([x0, y0, x1, y1]: readonly [number, number, number, number]): Cell[] {
  const cells: Cell[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  for (let x = x0, y = y0; ; x += dx, y += dy) {
    cells.push({ x, y });
    if (x === x1 && y === y1) return cells;
  }
}

/**
 * Zavrie všetky toasty. Od F5 pool ponúk hneď na štarte (a pri každej uzávierke dňa) ohlási „Nové ponuky kontraktov“ —
 * toast leží nad strednou časťou mapy a prekrýva kurzor aj klik pri stavbe (ghost sa nezobrazí), preto ho spec pred
 * zameraním bunky zavrie. Zavretie ostatných toastov nevadí: spec ich nekontroluje.
 */
async function dismissToasts(page: Page): Promise<void> {
  const closers = page.locator('.toasts .toast [data-action="close"]');
  // Toast sa zatvára aj sám (8 s od zobrazenia) a test sa k prvému zavretiu dostane po ~6–8 s od načítania, takže zavretie
  // sa môže minúť s automatickým zánikom. Klik bez limitu by potom čakal na zaniknutý prvok až do konca testu (5 min,
  // `actionTimeout` je predvolene 0), preto má každý pokus krátky limit a výsledok rozhoduje až kontrola prázdneho zásobníka.
  await expect(async () => {
    if ((await closers.count()) > 0) await closers.first().click({ timeout: 1_000 });
    await expect(page.locator('.toasts .toast')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * Postaví modul cez UI: BuildBar kategória, klik na položku, `rotations`× klávesa R, presun myši na bunku, počkať na
 * platný ghost s očakávaným rohom a rotáciou, klik. Vráti sa až keď modul pribudol do sveta; Esc ukončí build mód.
 */
async function buildViaBar(
  page: Page,
  options: { readonly category: string; readonly defId: string; readonly cursor: Cell; readonly rotations: number; readonly expectGhost: { x: number; y: number; rotation: number } },
): Promise<void> {
  const before = await moduleCount(page);
  await bar(page).locator(`[data-category="${options.category}"]`).click();
  const item = bar(page).locator(`[data-def-id="${options.defId}"]`);
  await expect(item).toHaveAttribute('data-action', 'build');
  await expect(item).toHaveAttribute('data-status', 'available');
  await item.click();
  await expect(map(page)).toHaveAttribute('data-input-state', 'build_module');
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  for (let i = 0; i < options.rotations; i += 1) await page.keyboard.press('KeyR');
  await dismissToasts(page); // toast nesmie ležať nad cieľovou bunkou (pozri `dismissToasts`)
  const point = await screenOf(page, options.cursor);
  await page.mouse.move(point.x, point.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ghost = window.__sim!.moduleGhost!();
        return ghost === null ? null : { x: ghost.x, y: ghost.y, rotation: ghost.rotation, valid: ghost.valid };
      }),
    )
    .toEqual({ ...options.expectGhost, valid: true });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => moduleCount(page)).toBe(before + 1);
  await page.keyboard.press('Escape');
  await expect(map(page)).toHaveAttribute('data-input-state', 'idle');
}

const WAIT_OPTIONS = { timeout: WAIT_LIMIT_MS } as const;

test.describe('F4: loď → apron → vozidlá → dvor → rampa → kamión → export (T04-10)', () => {
  test('brána, stojisko a rampa v BuildBare, 24 TEU z lode → kamióny prejdú bránou a stojiskom, naložia na rampe a opustia mapu', async ({ page }) => {
    const errors = await openGame(page);
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);
    const cashStart = await cashCents(page);

    // 1) základ z F3 a cesty pozemnej časti cez dispatchJSON: cesty, depo a dva dvory
    for (const segment of ROAD_SEGMENTS) {
      expect(await dispatch(page, { type: 'PlaceRoad', cells: segmentCells(segment) })).toMatchObject({ ok: true });
    }
    expect(await dispatch(page, { type: 'PlaceModule', defId: 'vehicle_depot', x: 46, y: 27, rotation: 0 })).toMatchObject({ ok: true });
    expect(await dispatch(page, { type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 })).toMatchObject({ ok: true });
    expect(await dispatch(page, { type: 'PlaceModule', defId: 'container_yard_small', x: 49, y: 26, rotation: 0 })).toMatchObject({ ok: true });
    await expect.poll(() => moduleCount(page)).toBe(4);
    const cashBase = cashStart - ROAD_CELL_COUNT * ROAD_COST_CENTS - DEPOT_COST_CENTS - 2 * YARD_COST_CENTS;
    await expect.poll(() => cashCents(page)).toBe(cashBase);

    // 2) UI: brána (rot 270 = trikrát R), čakacia plocha a rampa; každý modul stojí presne tam, kde ho ukázal ghost
    await buildViaBar(page, { category: 'landside', defId: 'truck_gate', cursor: GATE_CURSOR, rotations: 3, expectGhost: { x: 45, y: 32, rotation: 270 } });
    await buildViaBar(page, { category: 'landside', defId: 'truck_waiting_area', cursor: WAITING_AREA_CURSOR, rotations: 0, expectGhost: { x: 49, y: 31, rotation: 0 } });
    await buildViaBar(page, { category: 'landside', defId: 'loading_ramp_container', cursor: RAMP_CURSOR, rotations: 0, expectGhost: { x: 53, y: 28, rotation: 0 } });
    const cashBuilt = cashBase - GATE_COST_CENTS - WAITING_AREA_COST_CENTS - RAMP_COST_CENTS;
    await expect.poll(() => cashCents(page)).toBe(cashBuilt);

    const modules = (await entities(page)).modules;
    expect(modules.map((module) => [module.id, module.defId, module.x, module.y, module.rotation])).toEqual([
      [1, 'berth_standard', 40, 14, 0],
      [DEPOT_ID, 'vehicle_depot', 46, 27, 0],
      [NEAR_YARD_ID, 'container_yard_small', 42, 18, 0],
      [FAR_YARD_ID, 'container_yard_small', 49, 26, 0],
      [GATE_ID, 'truck_gate', 45, 32, 270],
      [WAITING_AREA_ID, 'truck_waiting_area', 49, 31, 0],
      [RAMP_ID, 'loading_ramp_container', 53, 28, 0],
    ]);
    // všetky moduly s cestným konektorom sú pripojené; rampa je prevádzková (brána aj stojisko ležia na ceste od portálu)
    expect(modules.filter((module) => module.connected !== undefined).every((module) => module.connected === true)).toBe(true);
    expect(modules.find((module) => module.id === RAMP_ID)!.ramp).toMatchObject({ docks: 2, operational: true });
    expect(modules.find((module) => module.id === GATE_ID)!.gate).toMatchObject({ queueLength: 0, open: false });
    expect(modules.find((module) => module.id === WAITING_AREA_ID)!.waitingArea).toMatchObject({ bays: 6 });

    // 3) Logistika: tri nákupy „Straddle carrier“ (vozidlá v depe 3)
    await bar(page).locator('[data-category="logistics"]').click();
    const carrier = bar(page).locator('[data-def-id="straddle_carrier"]');
    await expect(carrier).toHaveAttribute('data-status', 'available');
    for (let bought = 1; bought <= VEHICLES; bought += 1) {
      await carrier.click();
      await expect.poll(() => vehicleCount(page)).toBe(bought);
    }
    expect(await cashCents(page)).toBe(cashBuilt - VEHICLES * CARRIER_COST_CENTS);
    await expect.poll(async () => (await rendered(page)).vehicles).toBe(VEHICLES);

    // 4) DEV loď s 24 TEU cez SpawnShipDebug; BuildBar na Landside (ostane v screenshotoch), hra na 8×
    expect(await dispatch(page, { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: UNITS })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().ships.length)).toBe(1);
    await bar(page).locator('[data-category="landside"]').click();
    await view(page, LANDSIDE_VIEW.x, LANDSIDE_VIEW.y, LANDSIDE_VIEW.zoom);
    // stavy FSM, ktorými kamióny prešli (vzorka v každom rAF stránky): celý životný cyklus musí byť vidieť
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { __truckStatesSeen: Set<string> }).__truckStatesSeen = seen;
      const sample = (): void => {
        for (const truck of window.__sim!.entities().trucks) seen.add(truck.state);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await setSpeed(page, 8);

    // 5) kamión vo fronte brány (odznak fronty) a ďalší v stojisku naraz: hra sa v tom istom rAF zastaví. Fronta pred
    //    bránou je krátka (brána prepúšťa kamión za `processTicks`, kamióny vznikajú po jednom podľa toho, ako vozidlá
    //    stíhajú dovážať na rampu), preto sa po `FALLBACK_EXPORTED` exportoch vezme aj samotný kamión vo fronte či v stojisku
    await page.waitForFunction(
      (fallbackExported) => {
        const states: Record<string, number> = window.__sim!.rendered!().truckStates;
        const queued = (states['gate_queue'] ?? 0) > 0;
        const waiting = (states['waiting'] ?? 0) > 0;
        const hit = (queued && waiting) || (window.__sim!.world.cargo.exportedCount >= fallbackExported && (queued || waiting));
        if (hit) window.__sim!.world.clock.setSpeed(0);
        return hit;
      },
      FALLBACK_EXPORTED,
      WAIT_OPTIONS,
    );
    await view(page, LANDSIDE_VIEW.x, LANDSIDE_VIEW.y, LANDSIDE_VIEW.zoom);
    const queueing = await page.evaluate(() => ({ entities: window.__sim!.entities(), rendered: window.__sim!.rendered!() }));
    const queueStates = queueing.rendered.truckStates;
    expect((queueStates['gate_queue'] ?? 0) + (queueStates['waiting'] ?? 0)).toBeGreaterThan(0);
    expect(queueing.rendered.trucks).toBe(queueing.entities.trucks.length);
    expect(queueing.entities.trucks.every((truck) => truck.state !== 'no_path')).toBe(true);
    expect(queueing.entities.modules.find((module) => module.id === RAMP_ID)!.ramp).toMatchObject({ operational: true });
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-trucks-gate.png', fullPage: true });

    // 6) export: všetkých 24 jednotiek `exported`, žiadny kamión na mape
    await setSpeed(page, 8);
    await page.waitForFunction(
      (total) => {
        const done = window.__sim!.world.cargo.exportedCount === total && window.__sim!.entities().trucks.length === 0;
        if (done) window.__sim!.world.clock.setSpeed(0);
        return done;
      },
      UNITS,
      WAIT_OPTIONS,
    );
    await view(page, LANDSIDE_VIEW.x, LANDSIDE_VIEW.y, LANDSIDE_VIEW.zoom);
    const end = await page.evaluate((gateId) => {
      const { world } = window.__sim!;
      const { cargo } = world;
      cargo.assertConservation();
      const gate = world.modules.get(gateId as never) as unknown as { readonly trucksProcessed: number };
      return {
        created: cargo.createdCount,
        exported: cargo.exportedCount,
        live: cargo.liveCount,
        inStorage: cargo.countByKind('in_storage'),
        inVehicle: cargo.countByKind('in_vehicle'),
        onApron: cargo.countByKind('on_apron'),
        atRamp: cargo.countByKind('at_ramp'),
        inTruck: cargo.countByKind('in_truck'),
        onShip: cargo.countByKind('on_ship'),
        gateProcessed: gate.trucksProcessed,
        cashCents: world.cashCents,
        closedDays: world.clock.gameDay,
        entities: window.__sim!.entities(),
        rendered: window.__sim!.rendered!(),
        seen: [...(window as unknown as { __truckStatesSeen: Set<string> }).__truckStatesSeen].sort(),
      };
    }, GATE_ID);
    // nič sa nestratilo ani neostalo na mape: vytvorených 24, všetky exportované, ledger je prázdny
    expect(end).toMatchObject({ created: UNITS, exported: UNITS, live: 0, inStorage: 0, inVehicle: 0, onApron: 0, atRamp: 0, inTruck: 0, onShip: 0 });
    expect(end.entities.trucks).toEqual([]);
    expect(end.entities.ships).toEqual([]);
    expect(end.rendered).toMatchObject({ trucks: 0, truckStates: {} });
    // kamióny prešli celým životným cyklom a brána prepustila každý dvakrát (dnu a von)
    for (const state of ['to_gate', 'gate_queue', 'waiting', 'loading', 'gate_queue_out', 'to_portal']) expect(end.seen, `kamióny prešli stavom ${state}`).toContain(state);
    expect(end.gateProcessed).toBe(2 * UNITS);
    // brána, stojisko aj rampa sú prázdne
    expect(end.entities.modules.find((module) => module.id === GATE_ID)!.gate).toMatchObject({ queueLength: 0, open: false });
    expect(end.entities.modules.find((module) => module.id === WAITING_AREA_ID)!.waitingArea!.occupied.every((occupied) => !occupied)).toBe(true);
    expect(end.entities.modules.find((module) => module.id === RAMP_ID)!.ramp).toMatchObject({ staged: [0, 0], operational: true });
    // Bez kontraktov nie sú príjmy: po nákupoch ubúda hotovosť len údržbou a mzdami za každý uzavretý deň (ADR-025)
    // a HUD ukazuje presne hotovosť sveta
    expect(end.cashCents).toBe(cashBuilt - VEHICLES * CARRIER_COST_CENTS - end.closedDays * DAILY_UPKEEP_CENTS);
    await expect(page.locator('[data-field="cash"]')).toHaveText(formatMoney(end.cashCents));
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-exported.png', fullPage: true });

    // sim v DEV hlási porušenie konzervácie do konzoly (každý tick) — nesmie byť žiadna chyba ani výnimka
    expect(errors).toEqual([]);
  });
});
