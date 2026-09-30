import { expect, test, type Page } from '@playwright/test';

// F3 render demo (T03-08): pevné view-modely bez simu (`src/render/__demo__/f3-render.html`). Screenshoty slúžia na
// vizuálnu kontrolu: fill stavy dvorov, vozidlá (empty / loaded, kurzy), pripojené a odpojené depo s odznakom.

const DEMO_URL = '/src/render/__demo__/f3-render.html';

async function openDemo(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(DEMO_URL);
  await page.waitForSelector('body[data-demo-ready="true"]');
  return errors;
}

test.describe('F3: render skladov, vozidiel a odznaku „nepripojené“ (demo s pevnými view-modelmi)', () => {
  test('2 dvory (fill 0 a 75), pripojené depo, 3 vozidlá a odpojené depo s odznakom', async ({ page }) => {
    const errors = await openDemo(page);

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f3RenderDemo!;
      const modules = scene.modules.map((module) => {
        const view = renderer.modules.moduleView(module.id);
        return { id: module.id, defId: module.defId, fill: view?.fill ?? null, badge: view?.badgeVisible ?? null };
      });
      const vehicles = (scene.vehicles ?? []).map((vehicle) => {
        const view = renderer.entities.vehicleView(vehicle.id);
        const angle = view?.view.angle ?? 0;
        return { id: vehicle.id, angle: Math.round(((angle % 360) + 360) % 360), textured: view?.texture !== null };
      });
      return { modules, vehicles, moduleCount: renderer.modules.moduleCount, vehicleCount: renderer.entities.vehicleCount };
    });

    expect(state.moduleCount).toBe(4);
    expect(state.vehicleCount).toBe(3);
    expect(state.modules).toEqual([
      { id: 1, defId: 'container_yard_small', fill: 0, badge: false },
      { id: 2, defId: 'container_yard_small', fill: 75, badge: false },
      { id: 3, defId: 'vehicle_depot', fill: null, badge: false },
      { id: 4, defId: 'vehicle_depot', fill: null, badge: true },
    ]);
    // sprity (nie fallback) a kurzy 90° / 270° / 0°
    expect(state.vehicles.map((vehicle) => vehicle.textured)).toEqual([true, true, true]);
    expect(state.vehicles.map((vehicle) => vehicle.angle)).toEqual([90, 270, 0]);

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-render-demo.png' });
    expect(errors).toEqual([]);
  });

  test('aktualizácia za behu: dvor sa zaplní na 100, depo sa pripojí (odznak zmizne), vozidlo sa posunie', async ({ page }) => {
    const errors = await openDemo(page);

    const after = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f3RenderDemo!;
      const modules = scene.modules.map((module) => {
        if (module.id === 2 && module.storage) return { ...module, storage: { ...module.storage, stored: module.storage.capacity } };
        if (module.id === 4) return { ...module, connected: true };
        return module;
      });
      const vehicles = (scene.vehicles ?? []).map((vehicle) =>
        vehicle.id === 11 ? { ...vehicle, prevX: vehicle.x, x: vehicle.x + 1, loaded: true } : vehicle,
      );
      await show({ ...scene, modules, vehicles }, 0.5);
      const moved = renderer.entities.vehicleView(11);
      return {
        fill: renderer.modules.moduleView(2)?.fill,
        badge: renderer.modules.moduleView(4)?.badgeVisible,
        moduleViews: renderer.modules.moduleCount,
        movedX: moved?.view.x,
        expectedX: 37 * renderer.palette.cellPx, // lerp(36,5 → 37,5; 0,5) = 37 bunky
        loadedTexture: moved?.texture === renderer.entities.vehicleView(12)?.texture,
      };
    });

    expect(after.fill).toBe(100);
    expect(after.badge).toBe(false);
    expect(after.moduleViews).toBe(4); // zmena zaplnenia a pripojenia nevytvorila views nanovo
    expect(after.movedX).toBe(after.expectedX);
    expect(after.loadedTexture).toBe(true); // vozidlo 11 je teraz naložené ako vozidlo 12 (rovnaká textúra)
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-render-demo-updated.png' });
    expect(errors).toEqual([]);
  });
});
