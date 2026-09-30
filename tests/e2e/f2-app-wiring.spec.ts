import { expect, test, type Page } from '@playwright/test';

// T02-09 e2e: napojenie simu na render a UI. Root berth + žeriav sú na nábreží hneď po štarte (bez udalosti
// ModulePlaced), BuildBar dole ukazuje kategóriu Terminál z defov a DEV tlačidlo „Spawn feeder (DEV)“ pošle
// SpawnShipDebug: loď pripláva, zakotví, žeriav vykladá 4 kontajnery na apron a loď odpláva. Kompletný flow
// s build módom je v T02-12 (f2-ship-crane.spec.ts) — tu je zameranie na wiring (snapshot → renderer, BuildBar, HUD).

const WAIT_LIMIT_MS = 60_000;

// Flow trvá ~20 s (loď dopláva ~3 s a vykládka ~2 s reálneho času pri 4× + pomalé WebGL v SwiftShader); strop musí
// obsiahnuť dvojnásobok čakania na loď (docked aj odplávanie) aj pri zaťaženom stroji.
test.describe.configure({ timeout: 3 * WAIT_LIMIT_MS });

/** Kliknutie na tlačidlo rýchlosti v HUD (skutočný klik myšou, nie zápis do simu). */
async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

test.describe('F2: napojenie simu na render a UI (T02-09)', () => {
  test('Root modul na nábreží, BuildBar dole, DEV spawn → loď zakotví, žeriav vykladá, loď odpláva', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto('/');
    await expect(page.locator('.app__map canvas')).toBeVisible();
    await page.waitForFunction(() => window.__sim?.rendered !== undefined);

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
    expect(start.rendered).toEqual({ modules: 1, cranes: 1, ships: 0 });

    // 2) BuildBar dole: kategória Terminál z defs.modules, ceny, ostatné kategórie zamknuté; výber len nastaví selectedDefId
    const bar = page.getByRole('contentinfo', { name: 'Stavba' });
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-def-id]')).toHaveCount(2);
    const berthItem = bar.locator('[data-def-id="berth_standard"]');
    await expect(berthItem).toContainText('Kotvisko');
    await expect(berthItem).toContainText('$400,000');
    await expect(bar.locator('[data-def-id="crane_container_gantry"]')).toContainText('$600,000');
    await expect(bar.locator('[data-category="storage"]')).toBeDisabled();
    await expect(berthItem).toHaveAttribute('aria-pressed', 'false');
    await berthItem.click();
    await expect(berthItem).toHaveAttribute('aria-pressed', 'true');
    await berthItem.click();
    await expect(berthItem).toHaveAttribute('aria-pressed', 'false');

    // 3) HUD: rýchlosti zo snapshotu
    await expect(page.locator('[data-field="speed"] button')).toHaveCount(5);

    // 4) DEV spawn + 4×: loď doplaví a zakotví; žeriav vykladá a prvé kontajnery sú na aprone
    await page.getByRole('button', { name: 'Spawn feeder (DEV)' }).click();
    await setSpeed(page, 4);
    await page.waitForFunction(() => window.__sim!.entities().ships.length === 1);
    await expect.poll(() => page.evaluate(() => window.__sim!.rendered!().ships)).toBe(1);

    // Podmienka sa vyhodnotí v rAF stránky a pri zhode hneď spomalí hru na 1× (v tom istom kroku): vykládka pri 4× trvá
    // ~1 s reálneho času, kým by klik na tlačidlo stihol prebehnúť, loď by už odplávala.
    await page.waitForFunction(
      () => {
        const { ships, cranes, modules } = window.__sim!.entities();
        const ship = ships[0];
        const onApron = modules[0]?.apron?.units.length ?? 0;
        const working = ship?.state === 'docked' && ship.unitsOnBoard > 0 && onApron >= 1 && cranes[0]?.state !== 'idle';
        if (working) window.__sim!.world.clock.setSpeed(1);
        return working;
      },
      undefined,
      { timeout: WAIT_LIMIT_MS },
    );
    await expect(page.locator('[data-field="speed"] button[data-speed="1"]')).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const docked = await page.evaluate(() => {
      const { ships, cranes, modules } = window.__sim!.entities();
      return { ship: ships[0], crane: cranes[0], apron: modules[0]?.apron?.units.length, rendered: window.__sim!.rendered!() };
    });
    expect(docked.ship).toMatchObject({ classId: 'feeder', cargoCategory: 'container', state: 'docked' });
    expect(docked.ship?.unitsOnBoard).toBeGreaterThan(0);
    expect(docked.apron).toBeGreaterThanOrEqual(1);
    expect(docked.rendered).toEqual({ modules: 1, cranes: 1, ships: 1 });
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-app-docked.png', fullPage: true });

    // 5) po vyložení: loď preč (view zaniklo), na aprone 4 jednotky, žeriav opäť nečinný
    await setSpeed(page, 4);
    await page.waitForFunction(
      () => {
        const { ships, modules } = window.__sim!.entities();
        return ships.length === 0 && modules[0]?.apron?.units.length === 4;
      },
      undefined,
      { timeout: WAIT_LIMIT_MS },
    );
    await expect.poll(() => page.evaluate(() => window.__sim!.rendered!().ships)).toBe(0);
    const done = await page.evaluate(() => {
      const { cranes, modules } = window.__sim!.entities();
      return { crane: cranes[0]?.state, slots: modules[0]?.apron?.units.map((unit) => unit.slot), types: modules[0]?.apron?.units.map((unit) => unit.typeId) };
    });
    expect(done.crane).toBe('idle');
    expect(done.slots).toEqual([0, 1, 2, 3]);
    expect(done.types).toEqual(Array<string>(4).fill('container_teu'));
    await setSpeed(page, 1);
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-app-unloaded.png', fullPage: true });

    expect(errors).toEqual([]);
  });
});
