import { expect, test, type Locator, type Page } from '@playwright/test';

// F3 e2e (T03-12): celý tok fázy 3 z pohľadu hráča — loď → apron → vozidlá → dvor. Hráč cez UI postaví cesty ťahom myši
// (BuildBar Landside → „Jednosmerná cesta“), depo a dva dvory (BuildBar: klik na položku, klik na mapu), kúpi dve vozidlá
// (Logistika → Straddle carrier) a spawnne loď (`SpawnShipDebug`, 4 TEU; ďalších 24 TEU, aby sa dvor
// zaplnil viditeľne). Na stav sa čaká cez `window.__sim` (polling v rAF stránky), nie pevnými timeoutmi:
//   1) počas jazdy aspoň jedno vozidlo vezie kontajner → screenshot `f3-vehicles.png` (kamera na vozidlách a dvore),
//   2) potom je všetko `in_storage`, loď odplávala, vozidlá stoja → screenshot `f3-yard-filled.png` (dvor so zaplnením > 0).
//
// Rozloženie = scenár `apron_to_yard` (tests/sim/helpers/f3-layout.ts, data/scenarios/apron_to_yard.json). Moduly majú id
// v poradí stavby: Root berth 1, žeriav 2, depo 3, blízky dvor 4, ďaleký dvor 5; vozidlá 6 a 7.
// Root berth = x 40–47, y 14–16 (výjazdy (41,17) a (46,17)); blízky dvor x 42–45, y 18–21; depo x 46–48, y 27–29;
// ďaleký dvor x 49–52, y 26–29.

const WAIT_LIMIT_MS = 60_000;
test.describe.configure({ timeout: 6 * WAIT_LIMIT_MS });

const DEPOT_ID = 3;
const NEAR_YARD_ID = 4;
const FAR_YARD_ID = 5;
const FIRST_VEHICLE_ID = 6;

/** Prvá ladiaca loď má 4 TEU, ďalšia 24 TEU (oboje `SpawnShipDebug`); dohromady musí skončiť v dvoroch 28 jednotiek. */
const FIRST_SHIP_UNITS = 4;
const EXTRA_UNITS = 24;
const TOTAL_UNITS = FIRST_SHIP_UNITS + EXTRA_UNITS;

/** Pohľad na celé rozloženie pri stavbe: zoom 0,5 (bunka 32 px), stred posunutý o pás HUD a BuildBaru. */
const OVERVIEW = { x: 45, y: 24.5, zoom: 0.5 } as const;
/**
 * Pohľad na jazdu a blízky dvor: zoom 1 (bunka 64 px). Stred y 19,2 posúva mapu tak, aby pod pásom HUD bol apron berthu
 * (y 14–16), pod ním okruh ciest (y 17–22) a dvor; BuildBar dole zakrýva až y ≥ 23.
 */
const DRIVE_VIEW = { x: 44, y: 19.2, zoom: 1 } as const;

/** Vozidlo s nákladom sa zachytí, až keď je na nohe okruhu ciest (y 19–22), nie ešte v rohu pri berthe — pruh je tam dobre vidieť. */
const DRIVING_Y_RANGE = { fromY: 19, toY: 22 } as const;

type Cell = { readonly x: number; readonly y: number };

/**
 * Ťah myšou (BuildBar → jednosmerná cesta, R1: ADR-037 bod 12): jedna lomená čiara z bodov, ktorými myš prejde, je uzavretý
 * jednosmerný okruh (50 buniek): západná noha berthu dole, chrbtica k depu a ďalekému dvoru, návrat po severnej strane
 * ďalekého dvora a po východnej strane blízkeho dvora hore a horná spojka späť k (41,17). Bez križovatiek, takže sa
 * vozidlá nezablokujú.
 */
const ROAD_STROKES: readonly (readonly Cell[])[] = [
  [
    { x: 41, y: 17 },
    { x: 41, y: 22 },
    { x: 44, y: 22 },
    { x: 44, y: 30 },
    { x: 53, y: 30 },
    { x: 53, y: 25 },
    { x: 46, y: 25 },
    { x: 46, y: 17 },
    { x: 42, y: 17 },
  ],
];
const ROAD_CELL_COUNT = 50;
/** Kroky `mouse.move` medzi bodmi ťahu — viac udalostí ako buniek, ako pri skutočnej myši. */
const DRAG_STEPS = 12;
const ROAD_COST_CENTS = 150_000;

/** Bunka pod kurzorom je stredom footprintu (pri párnom rozmere `floor(rozmer / 2)` od rohu): depo 3×3 (roh 46,27), dvory 4×4 (rohy 42,18 a 49,26). */
const DEPOT_CURSOR: Cell = { x: 47, y: 28 };
const NEAR_YARD_CURSOR: Cell = { x: 44, y: 20 };
const FAR_YARD_CURSOR: Cell = { x: 51, y: 28 };

const CARRIER_COST_CENTS = 4_800_000;

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

async function clickCell(page: Page, cell: Cell): Promise<void> {
  const point = await screenOf(page, cell);
  await page.mouse.click(point.x, point.y);
}

/** Ťah ľavým tlačidlom po zadaných bodoch (cesta sa postaví po pustení). */
async function dragThrough(page: Page, points: readonly Cell[]): Promise<void> {
  const [first, ...rest] = points;
  const start = await screenOf(page, first!);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(map(page)).toHaveAttribute('data-input-state', 'build_place');
  for (const point of rest) {
    const target = await screenOf(page, point);
    await page.mouse.move(target.x, target.y, { steps: DRAG_STEPS });
  }
  await page.mouse.up();
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

const WAIT_OPTIONS = { timeout: WAIT_LIMIT_MS } as const;

test.describe('F3: loď → apron → vozidlá → dvor (T03-12)', () => {
  test('cesty ťahom, depo a dva dvory v BuildBare, 2 straddle carriers, DEV loď → vozidlá vezú a dvor sa zapĺňa', async ({ page }) => {
    const errors = await openGame(page);
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);
    const cashStart = await cashCents(page);

    // 1) cesty: BuildBar Landside → „Jednosmerná cesta“ (build mód ciest), jeden ťah myšou po okruhu; Esc ukončí mód
    await bar(page).locator('[data-category="landside"]').click();
    const roadItem = bar(page).locator('[data-def-id="road_one_way"]');
    await expect(roadItem).toContainText('Jednosmerná cesta');
    await roadItem.click();
    await expect(map(page)).toHaveAttribute('data-input-state', 'build');
    await expect(roadItem).toHaveAttribute('aria-pressed', 'true');
    for (const stroke of ROAD_STROKES) await dragThrough(page, stroke);
    await page.keyboard.press('Escape');
    await expect(map(page)).toHaveAttribute('data-input-state', 'idle');
    await expect.poll(() => cashCents(page)).toBe(cashStart - ROAD_CELL_COUNT * ROAD_COST_CENTS);
    // každá bunka ťahov (bez duplicít v rohoch lomenej čiary) je jednosmerná cesta v mriežke sveta
    const roadCells = await page.evaluate((strokes) => {
      const unique = new Set<string>();
      for (const stroke of strokes) {
        for (let i = 1; i < stroke.length; i += 1) {
          const a = stroke[i - 1]!;
          const b = stroke[i]!;
          const dx = Math.sign(b.x - a.x);
          const dy = Math.sign(b.y - a.y);
          for (let x = a.x, y = a.y; ; x += dx, y += dy) {
            const cell = window.__sim!.world.grid.at(x, y);
            if (cell.road === 'road' && cell.roadKind === 'one_way') unique.add(`${String(x)},${String(y)}`);
            if (x === b.x && y === b.y) break;
          }
        }
      }
      return unique.size;
    }, ROAD_STROKES.map((stroke) => [...stroke]));
    expect(roadCells).toBe(ROAD_CELL_COUNT);

    // 2) depo (Logistika) a dva dvory (Sklady): klik na položku, klik na mapu v bunke; ghost musí prejsť validate
    await bar(page).locator('[data-category="logistics"]').click();
    const depotItem = bar(page).locator('[data-def-id="vehicle_depot"]');
    await depotItem.click();
    await expect(map(page)).toHaveAttribute('data-input-state', 'build_module');
    await expect.poll(async () => {
      const point = await screenOf(page, DEPOT_CURSOR);
      await page.mouse.move(point.x, point.y);
      return page.evaluate(() => window.__sim!.moduleGhost!()?.valid ?? null);
    }).toBe(true);
    await clickCell(page, DEPOT_CURSOR);
    await expect.poll(() => moduleCount(page)).toBe(2);
    await page.keyboard.press('Escape');

    await bar(page).locator('[data-category="storage"]').click();
    const yardItem = bar(page).locator('[data-def-id="container_yard_small"]');
    await yardItem.click();
    await expect(map(page)).toHaveAttribute('data-input-state', 'build_module');
    for (const [cursor, expected] of [
      [NEAR_YARD_CURSOR, 3],
      [FAR_YARD_CURSOR, 4],
    ] as const) {
      const point = await screenOf(page, cursor);
      await page.mouse.move(point.x, point.y);
      await expect.poll(() => page.evaluate(() => window.__sim!.moduleGhost!()?.valid ?? null)).toBe(true);
      await page.mouse.click(point.x, point.y);
      await expect.poll(() => moduleCount(page)).toBe(expected);
    }
    await page.keyboard.press('Escape');
    await expect(map(page)).toHaveAttribute('data-input-state', 'idle');

    const modules = (await entities(page)).modules;
    expect(modules.map((module) => [module.id, module.defId, module.x, module.y, module.connected])).toEqual([
      [1, 'berth_standard', 40, 14, true],
      [DEPOT_ID, 'vehicle_depot', 46, 27, true],
      [NEAR_YARD_ID, 'container_yard_small', 42, 18, true],
      [FAR_YARD_ID, 'container_yard_small', 49, 26, true],
    ]);

    // 3) Logistika: dva nákupy „Straddle carrier“ (vozidlá 6 a 7 v depe 3)
    await bar(page).locator('[data-category="logistics"]').click();
    const carrier = bar(page).locator('[data-def-id="straddle_carrier"]');
    await expect(carrier).toHaveAttribute('data-action', 'buy');
    await expect(carrier).toHaveAttribute('data-status', 'available');
    const cashBeforeBuy = await cashCents(page);
    await carrier.click();
    await expect.poll(() => vehicleCount(page)).toBe(1);
    await carrier.click();
    await expect.poll(() => vehicleCount(page)).toBe(2);
    expect(await cashCents(page)).toBe(cashBeforeBuy - 2 * CARRIER_COST_CENTS);
    await expect.poll(async () => (await rendered(page)).vehicles).toBe(0);
    const bought = (await entities(page)).vehicles;
    expect(bought.map((vehicle) => vehicle.id)).toEqual([FIRST_VEHICLE_ID, FIRST_VEHICLE_ID + 1]);
    // kúpené vozidlo vzniká zaparkované v depe (R1) a na mape sa nekreslí
    expect(bought.every((vehicle) => vehicle.state === 'parked' && !vehicle.loaded)).toBe(true);

    // 4) ladiaca loď 4 TEU + ďalšia loď 24 TEU, obe cez `SpawnShipDebug` (dvor sa má zaplniť viditeľne)
    expect(await dispatch(page, { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().ships.length)).toBe(1);
    expect(await dispatch(page, { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: EXTRA_UNITS })).toMatchObject({ ok: true });
    await setSpeed(page, 4);

    // 5) jazda: hra sa v tom istom rAF zastaví, keď vozidlo vezie kontajner po ceste dvora (nie v koncovej bunke berthu)
    await view(page, DRIVE_VIEW.x, DRIVE_VIEW.y, DRIVE_VIEW.zoom);
    // podmienka sa vyhodnocuje v každom rAF stránky; pri zhode sa hra v tom istom kroku pozastaví
    await page.waitForFunction(
      (lane) => {
        const loaded = window.__sim!.entities().vehicles.some((vehicle) => vehicle.loaded && vehicle.state === 'to_dropoff' && vehicle.y >= lane.fromY && vehicle.y <= lane.toY);
        if (loaded) window.__sim!.world.clock.setSpeed(0);
        return loaded;
      },
      DRIVING_Y_RANGE,
      WAIT_OPTIONS,
    );
    await settle(page);
    const driving = await page.evaluate(() => ({ entities: window.__sim!.entities(), rendered: window.__sim!.rendered!() }));
    expect(driving.rendered.vehicles).toBeGreaterThanOrEqual(1); // zaparkované vozidlo sa nekreslí
    expect(driving.entities.vehicles.some((vehicle) => vehicle.loaded && vehicle.state === 'to_dropoff')).toBe(true);
    expect(driving.entities.vehicles.every((vehicle) => vehicle.state !== 'no_path')).toBe(true);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-vehicles.png', fullPage: true });

    // 6) všetko `in_storage`, lode preč, vozidlá znova zaparkované v depe; hotovosť dvora > 0
    await setSpeed(page, 8);
    await page.waitForFunction(
      (total) => {
        const { ships, vehicles } = window.__sim!.entities();
        return (
          window.__sim!.world.cargo.countByKind('in_storage') === total &&
          window.__sim!.world.cargo.countByKind('on_apron') === 0 &&
          ships.length === 0 &&
          vehicles.every((vehicle) => vehicle.state === 'parked')
        );
      },
      TOTAL_UNITS,
      WAIT_OPTIONS,
    );
    await settle(page);
    const end = await page.evaluate(() => ({
      inStorage: window.__sim!.world.cargo.countByKind('in_storage'),
      onApron: window.__sim!.world.cargo.countByKind('on_apron'),
      inVehicle: window.__sim!.world.cargo.countByKind('in_vehicle'),
      onShip: window.__sim!.world.cargo.countByKind('on_ship'),
      storage: window.__sim!.entities().modules.filter((module) => module.storage !== undefined).map((module) => [module.id, module.storage]),
      vehicles: window.__sim!.entities().vehicles.map((vehicle) => [vehicle.id, vehicle.state, vehicle.loaded]),
    }));
    expect(end).toMatchObject({ inStorage: TOTAL_UNITS, onApron: 0, inVehicle: 0, onShip: 0 });
    const stored = end.storage.map(([, storage]) => (storage as { stored: number }).stored);
    expect(stored.reduce((sum, count) => sum + count, 0)).toBe(TOTAL_UNITS);
    const nearYard = end.storage.find(([id]) => id === NEAR_YARD_ID)?.[1] as { capacity: number; stored: number; reserved: number };
    expect(nearYard.stored).toBeGreaterThan(0);
    expect(nearYard.reserved).toBe(0);
    expect(end.vehicles.every(([, state, loaded]) => state === 'parked' && loaded === false)).toBe(true);

    await view(page, DRIVE_VIEW.x, DRIVE_VIEW.y, DRIVE_VIEW.zoom);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-yard-filled.png', fullPage: true });

    // sim v DEV hlási porušenie konzervácie do konzoly (každý tick) — nesmie byť žiadna chyba ani výnimka
    expect(errors).toEqual([]);
  });
});
