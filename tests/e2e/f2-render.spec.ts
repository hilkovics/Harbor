import { expect, test, type Page } from '@playwright/test';

// F2 render demo (T02-07): pevné view-modely bez simu (`src/render/__demo__/f2-render.html`). Screenshoty slúžia na
// vizuálnu kontrolu: orientácia lode, výložník nad vodou, kontajnery na aprone, ghost + konektory, rotácie 90°/180°.

const DEMO_URL = '/src/render/__demo__/f2-render.html';

async function openDemo(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${DEMO_URL}?${query}`);
  await page.waitForSelector('body[data-demo-ready="true"]');
  return errors;
}

test.describe('F2: render entít (demo s pevnými view-modelmi)', () => {
  test('berth + žeriav (grabbing 0,5) + loď docked + 2 kontajnery + ghost berthu s konektormi', async ({ page }) => {
    const errors = await openDemo(page, 'scene=main&ghost=valid');

    const counts = await page.evaluate(() => {
      const { renderer } = window.__f2RenderDemo!;
      return {
        modules: renderer.modules.moduleCount,
        cranes: renderer.cranes.craneCount,
        ships: renderer.ships.shipCount,
        cargoOnApron: renderer.modules.moduleView(1)?.cargoCount,
        ghostCells: renderer.build.shownCount,
        connectorMarkers: renderer.build.markerCount,
      };
    });
    expect(counts).toEqual({ modules: 1, cranes: 1, ships: 1, cargoOnApron: 2, ghostCells: 32, connectorMarkers: 8 });

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-render-demo.png' });
    expect(errors).toEqual([]);
  });

  test('neplatný ghost berthu: červená výplň so šrafou a konektormi', async ({ page }) => {
    const errors = await openDemo(page, 'scene=main&ghost=invalid');
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-render-demo-invalid.png' });
    expect(errors).toEqual([]);
  });

  test('rotácie: berth 90° so žeriavom (placing, kontajner v spreaderi) a loďou, berth 180° so zablokovaným žeriavom', async ({ page }) => {
    const errors = await openDemo(page, 'scene=rotated');
    const counts = await page.evaluate(() => {
      const { renderer } = window.__f2RenderDemo!;
      return {
        modules: renderer.modules.moduleCount,
        cranes: renderer.cranes.craneCount,
        ships: renderer.ships.shipCount,
        blockedBadge: renderer.cranes.anyView(22)?.badgeVisible,
        holding: renderer.cranes.anyView(21)?.heldCargo?.unitId,
      };
    });
    expect(counts).toEqual({ modules: 2, cranes: 2, ships: 2, blockedBadge: true, holding: 900 });
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-render-demo-rotated.png' });
    expect(errors).toEqual([]);
  });
});
