import { expect, test, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// R3 v skutočnej hre: kontajnerový žeriav `crane_container_gantry` (modul 2 × 3 na (43; 14)) sa kreslí novým STS rámom 3 × 10 (nie starým výložníkom).
// Loď zakotví, žeriav pracuje; screenshot `sts-in-game.png`.

test.describe.configure({ timeout: 3 * 60_000 });

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


async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('STS v hre: žeriav harbor_01 je kreslený STS rámom, loď zakotvená, žeriav vykladá', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.cellToScreen !== undefined && window.__sim.centerOn !== undefined);
  await page.evaluate(() => window.__sim!.centerOn!(44, 12, 0.9));
  await buildUnloadLogistics(page);
  const spawned = await page.evaluate(() => window.__sim!.dispatchJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
  expect(spawned.ok).toBe(true);
  await page.evaluate(() => window.__sim!.world.clock.setSpeed(4));
  await page.waitForFunction(
    () => {
      const { ships, cranes } = window.__sim!.entities();
      const crane = cranes[0];
      const working = ships[0]?.state === 'docked' && crane?.cargo != null && (crane.state === 'swinging' || crane.state === 'placing' || crane.state === 'grabbing');
      if (working) window.__sim!.world.clock.setSpeed(1);
      return working;
    },
    undefined,
    { timeout: 120_000 },
  );
  await dismissToasts(page);
  await page.mouse.move(0, 0);
  await settle(page);
  await page.screenshot({ path: 'tests/e2e/__screenshots__/sts-in-game.png', fullPage: true });
  expect(errors).toEqual([]);
});
