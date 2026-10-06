import { expect, test, type Locator, type Page } from '@playwright/test';

// F3 app (T03-10): napojenie simu na render a UI. Cesty, dvory a depo sa postavia serializovanými príkazmi
// (`window.__sim.dispatchJSON`), vozidlá sa kúpia klikom v BuildBare (Logistika → Straddle carrier), dvor a depo sa
// otvoria v inšpektore, nepripojený dvor dá toast „Nepripojené“ s akciou „Ukázať“ a po DEV spawne lode vozidlá jazdia
// po ceste a dvor sa zapĺňa. Finálny e2e celého toku (loď → apron → vozidlá → dvor) prinesie T03-12.
//
// Rozloženie = scenár `apron_to_yard`: cesty od výjazdov Root kotviska (41,17) a (46,17) k dvorom a depu.
// Root berth (id 1) = x 40–47, y 14–16; depo (id 3) x 46–48, y 27–29; dvor (id 4) x 42–45, y 18–21; dvor (id 5) x 49–52, y 26–29.

const WAIT_LIMIT_MS = 60_000;
test.describe.configure({ timeout: 4 * WAIT_LIMIT_MS });

const DEPOT_ID = 3;
const YARD_ID = 4;
const YARD_2_ID = 5;
/**
 * Nepripojený dvor (bez cesty) — dá toast „Nepripojené“. Stred footprintu 4×4 je bod (38, 22) v bunkách; `cellToScreen`
 * vracia STRED bunky (+0,5), preto sa ako argument dáva (37,5; 21,5).
 */
const STRAY_YARD = { x: 36, y: 20 } as const;
const STRAY_YARD_CENTER = { x: 37.5, y: 21.5 } as const;

const CARRIER_COST_CENTS = 4_800_000;
const UNITS = 24;

/** Pohľad na celé rozloženie: zoom 0,5 (bunka 32 px); stred posunutý o pás HUD a BuildBaru, aby nič nezakrývali. */
const OVERVIEW = { x: 45, y: 24.5, zoom: 0.5 } as const;

const ROADS: readonly (readonly [number, number, number, number])[] = [
  [41, 17, 41, 22],
  [46, 17, 46, 22],
  [42, 22, 45, 22],
  [42, 17, 45, 17],
  [44, 23, 44, 30],
  [45, 30, 50, 30],
];

function roadCells([x0, y0, x1, y1]: readonly [number, number, number, number]): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  for (let x = x0, y = y0; ; x += dx, y += dy) {
    cells.push({ x, y });
    if (x === x1 && y === y1) return cells;
  }
}

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined);
  return errors;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function parkMouse(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await settle(page);
}

async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

async function view(page: Page, x: number, y: number, zoom: number): Promise<void> {
  await page.evaluate(([cx, cy, z]) => window.__sim!.centerOn!(cx, cy, z), [x, y, zoom] as const);
  await settle(page);
}

const entities = (page: Page) => page.evaluate(() => window.__sim!.entities());
const rendered = (page: Page) => page.evaluate(() => window.__sim!.rendered!());
const cashCents = (page: Page) => page.evaluate(() => window.__sim!.world.cashCents);
const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Inšpektor modulu' });
/** Toasty okrem „Nové ponuky kontraktov“ (pool ponúk ich dopĺňa na štarte a pri každej uzávierke dňa; F5). */
const toasts = (page: Page): Locator => page.locator('.toasts .toast').filter({ hasNotText: 'Nové ponuky kontraktov' });

async function waitInPage(page: Page, condition: () => boolean): Promise<void> {
  await page.waitForFunction(condition, undefined, { timeout: WAIT_LIMIT_MS });
}

async function clickCell(page: Page, cell: { readonly x: number; readonly y: number }): Promise<void> {
  const point = await page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [cell.x, cell.y] as const);
  await page.mouse.click(point.x, point.y);
}

test.describe('F3: napojenie vozidiel, skladov a notifikácií (T03-10)', () => {
  test('cesty + dvory + depo, nákup 2 vozidiel v BuildBare, toast Nepripojené, jazda pri 4× a plnenie dvora', async ({ page }) => {
    const errors = await openGame(page);
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);

    // 1) cesty, potom depo a dva dvory; všetko cez validate (dispatchJSON vráti výsledok validácie)
    for (const road of ROADS) expect(await dispatch(page, { type: 'PlaceRoad', cells: roadCells(road) })).toMatchObject({ ok: true });
    await waitInPage(page, () => window.__sim!.world.grid.at(44, 30).road === 'road');
    for (const [defId, x, y] of [
      ['vehicle_depot', 46, 27],
      ['container_yard_small', 42, 18],
      ['container_yard_small', 49, 26],
    ] as const) {
      expect(await dispatch(page, { type: 'PlaceModule', defId, x, y, rotation: 0 })).toMatchObject({ ok: true });
    }
    await waitInPage(page, () => window.__sim!.entities().modules.length === 4);
    const modules = (await entities(page)).modules;
    expect(modules.map((module) => [module.id, module.defId, module.connected])).toEqual([
      [1, 'berth_standard', true],
      [DEPOT_ID, 'vehicle_depot', true],
      [YARD_ID, 'container_yard_small', true],
      [YARD_2_ID, 'container_yard_small', true],
    ]);
    expect(modules.find((module) => module.id === YARD_ID)?.storage).toEqual({ capacity: 48, stored: 0, reserved: 0 }); // R2: blok 4 bays × 4 rows × 3 tiers = 48 TEU (nie 64 slotov)
    await expect(toasts(page)).toHaveCount(0); // všetko pripojené → žiadne „Nepripojené“

    // 2) BuildBar Logistika: vozidlo je nákup (kúpiť), depo je pripojené → dostupné; dva kliky = dve vozidlá
    const bar = page.getByRole('contentinfo', { name: 'Stavba' });
    await bar.locator('[data-category="logistics"]').click();
    const carrier = bar.locator('[data-def-id="straddle_carrier"]');
    await expect(carrier).toHaveAttribute('data-action', 'buy');
    await expect(carrier).toHaveAttribute('data-status', 'available');
    await expect(carrier).toContainText('$48,000');
    await expect(carrier).toContainText('kúpiť');
    const cashBefore = await cashCents(page);
    await carrier.click();
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(1);
    await carrier.click();
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(2);
    expect(await cashCents(page)).toBe(cashBefore - 2 * CARRIER_COST_CENTS);
    // kúpené vozidlo vzniká zaparkované v depe (R1): na mape sa nekreslí, kreslí ho depo
    expect((await entities(page)).vehicles.every((vehicle) => vehicle.state === 'parked')).toBe(true);
    await expect.poll(async () => (await rendered(page)).vehicles).toBe(0);
    await expect(bar.locator('[data-def-id="vehicle_depot"]')).toHaveAttribute('data-action', 'build');

    // 3) inšpektor depa: dve nečinné vozidlá, kúpiť je dostupné; inšpektor dvora (blok): 0 / 48 TEU
    await clickCell(page, { x: 47, y: 28 });
    await expect(inspector(page)).toHaveAttribute('data-module-id', String(DEPOT_ID));
    await expect(inspector(page).locator('[data-vehicle-id][data-state]')).toHaveCount(2);
    await expect(inspector(page).locator('[data-action="buy-vehicle"]')).toHaveAttribute('aria-disabled', 'false');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('V prevádzke');
    await clickCell(page, { x: 43, y: 19 });
    await expect(inspector(page)).toHaveAttribute('data-module-id', String(YARD_ID));
    await expect(inspector(page).locator('[data-field="block-teu"]')).toContainText('0 / 48'); // R2: blok ukazuje obsadenosť v TEU
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);

    // 4) nepripojený dvor (bez cesty): toast „Nepripojené“ s akciou „Ukázať“ (centruje kameru) a odznak na dvore
    expect(await dispatch(page, { type: 'PlaceModule', defId: 'container_yard_small', ...STRAY_YARD, rotation: 0 })).toMatchObject({ ok: true });
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).first()).toHaveAttribute('data-tone', 'info');
    await expect(toasts(page).first().locator('[data-field="toast-title"]')).toHaveText('Nepripojené');
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);
    await toasts(page).first().locator('[data-action="show"]').click();
    await settle(page);
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const centered = await page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [STRAY_YARD_CENTER.x, STRAY_YARD_CENTER.y] as const);
    expect(Math.abs(centered.x - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(centered.y - viewport.height / 2)).toBeLessThan(2);
    const stray = (await entities(page)).modules.find((module) => module.x === STRAY_YARD.x && module.y === STRAY_YARD.y);
    expect(stray).toMatchObject({ defId: 'container_yard_small', connected: false });

    // inšpektor nepripojeného dvora: žltý badge „Nepripojené“ a banner; toast ostáva viditeľný vedľa neho
    await clickCell(page, { x: STRAY_YARD_CENTER.x, y: STRAY_YARD_CENTER.y });
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Nepripojené');
    await expect(inspector(page).locator('[data-section="disconnected"]')).toBeVisible();
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-app-toast-inspector.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);

    // toast sa zavrie sám po TOAST_AUTO_CLOSE_MS (8 s); tlačidlo × pokrýva unit test (tu by bol závod s časovačom)
    await expect(toasts(page)).toHaveCount(0, { timeout: 15_000 });
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);

    // 5) loď (DEV spawn, 24 TEU) a jazda pri 4×: vozidlá jazdia po ceste, aspoň jedno vezie kontajner
    expect(await dispatch(page, { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: UNITS })).toMatchObject({ ok: true });
    await setSpeed(page, 4);
    await waitInPage(page, () => {
      const loaded = window.__sim!.entities().vehicles.some((vehicle) => vehicle.loaded && vehicle.state === 'to_dropoff');
      if (loaded) window.__sim!.world.clock.setSpeed(0);
      return loaded;
    });
    await settle(page);
    const driving = (await entities(page)).vehicles;
    expect(driving.length).toBe(2);
    expect(driving.some((vehicle) => vehicle.loaded && vehicle.state === 'to_dropoff')).toBe(true);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-app-driving.png', fullPage: true });

    // detail jazdy: zoom 1 na prvom nesúcom vozidle (pravý pruh, odznak nepripojeného dvora je v prehľade)
    const target = driving.find((vehicle) => vehicle.loaded) ?? driving[0];
    await view(page, target?.x ?? OVERVIEW.x, target?.y ?? OVERVIEW.y, 1);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-app-lane-detail.png', fullPage: true });
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);

    // 6) dvor sa zapĺňa: pri 8× sa celá loď uloží do dvorov (konzervácia hlási sim v DEV každý tick)
    await setSpeed(page, 8);
    await waitInPage(page, () => {
      const stored = window.__sim!.entities().modules.reduce((sum, module) => sum + (module.storage?.stored ?? 0), 0);
      if (stored >= 16) window.__sim!.world.clock.setSpeed(0);
      return stored >= 16;
    });
    await settle(page);
    const filling = (await entities(page)).modules.filter((module) => module.storage !== undefined && module.connected === true);
    expect(filling.reduce((sum, module) => sum + (module.storage?.stored ?? 0), 0)).toBeGreaterThanOrEqual(16);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-app-yard-filling.png', fullPage: true });

    // 7) do konca: všetko uložené, nič sa nestratilo, vozidlá znova zaparkované v depe
    await setSpeed(page, 8);
    await waitInPage(page, () => window.__sim!.world.cargo.countByKind('in_storage') === 24 && window.__sim!.entities().vehicles.every((vehicle) => vehicle.state === 'parked'));
    const end = await page.evaluate(() => ({
      inStorage: window.__sim!.world.cargo.countByKind('in_storage'),
      stored: window.__sim!.entities().modules.map((module) => module.storage?.stored ?? 0),
    }));
    expect(end.inStorage).toBe(UNITS);
    expect(end.stored.reduce((sum, stored) => sum + stored, 0)).toBe(UNITS);

    expect(errors).toEqual([]);
  });
});
