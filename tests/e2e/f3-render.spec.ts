import { expect, test, type Page } from '@playwright/test';

// F3 render demo (T03-08): pevné view-modely bez simu (`src/render/__demo__/f3-render.html`). Screenshoty slúžia na
// vizuálnu kontrolu: fill stavy dvorov, vozidlá (empty / loaded, kurzy), pripojené a odpojené depo s odznakom.
// Scéna `lanes` (T03-17, `?scene=lanes`): vozidlá jazdia v pravom pruhu, protismerné sa nekrížia (`f3-lanes.png`).

const DEMO_URL = '/src/render/__demo__/f3-render.html';

async function openDemo(page: Page, scene?: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(scene === undefined ? DEMO_URL : `${DEMO_URL}?scene=${scene}`);
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

test.describe('F3: vozidlá v pravom pruhu (scéna lanes)', () => {
  /** Posun stredu vozidla od osi cesty (bunky) vpravo od smeru jazdy: 13 px z 64 px bunky. */
  const LANE = 13 / 64;
  const RIGHT_OF_HEADING: Record<number, readonly [number, number]> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

  test('priama cesta, protismer vedľa seba, T-križovatka a zákruty: každé vozidlo v pravom pruhu', async ({ page }) => {
    const errors = await openDemo(page, 'lanes');

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f3RenderDemo!;
      const cellPx = renderer.palette.cellPx;
      const vehicles = (scene.vehicles ?? []).map((vehicle) => {
        const view = renderer.entities.vehicleView(vehicle.id);
        const sprite = view?.view.children[0];
        return {
          id: vehicle.id,
          x: view?.view.x ?? Number.NaN,
          y: view?.view.y ?? Number.NaN,
          angle: Math.round((((view?.view.angle ?? 0) % 360) + 360) % 360),
          spriteWidth: sprite?.width ?? Number.NaN,
          textured: view?.texture !== null,
        };
      });
      return { cellPx, vehicles, vehicleCount: renderer.entities.vehicleCount, modules: renderer.modules.moduleCount };
    });
    const scene = await page.evaluate(() => window.__f3RenderDemo!.scene.vehicles ?? []);

    expect(state.vehicleCount).toBe(scene.length);
    expect(state.modules).toBe(0);
    expect(state.vehicles.every((vehicle) => vehicle.textured)).toBe(true);

    for (const vehicle of state.vehicles) {
      const vm = scene.find((candidate) => candidate.id === vehicle.id)!;
      const [rx, ry] = RIGHT_OF_HEADING[vm.heading];
      // stred vozidla = poloha z VM + posun o 13/64 bunky doprava od smeru jazdy (zákruta: alpha 1 = aktuálny úsek)
      expect(vehicle.x / state.cellPx, `x vozidla ${String(vehicle.id)}`).toBeCloseTo(vm.x + rx * LANE, 6);
      expect(vehicle.y / state.cellPx, `y vozidla ${String(vehicle.id)}`).toBeCloseTo(vm.y + ry * LANE, 6);
      expect(vehicle.angle).toBe(vm.heading);
      // sprite je zmenšený na šírku pruhu: obsah 56 z 64 px → 26 px pruh
      expect(vehicle.spriteWidth / state.cellPx).toBeCloseTo(26 / 56, 6);
    }

    // protismerná dvojica v jednej bunke: stredy sú od seba práve jeden pruh (26/64 bunky) kolmo na cestu
    const at = (id: number): { x: number; y: number } => state.vehicles.find((vehicle) => vehicle.id === id)!;
    expect(Math.abs(at(21).y - at(22).y) / state.cellPx).toBeCloseTo(26 / 64, 6);
    expect(at(21).x).toBeCloseTo(at(22).x, 6);
    expect(Math.abs(at(25).x - at(26).x) / state.cellPx).toBeCloseTo(26 / 64, 6);
    expect(at(25).y).toBeCloseTo(at(26).y, 6);

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-lanes.png' });
    expect(errors).toEqual([]);
  });

  test('zákruta za behu: pruh sa interpoluje medzi predchádzajúcim a aktuálnym úsekom (alpha 0, 0,5 a 1)', async ({ page }) => {
    const errors = await openDemo(page, 'lanes');

    const poses = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f3RenderDemo!;
      const cellPx = renderer.palette.cellPx;
      const result: { alpha: number; x: number; y: number }[] = [];
      for (const alpha of [0, 0.5, 1]) {
        await show(scene, alpha);
        const view = renderer.entities.vehicleView(31)!;
        result.push({ alpha, x: view.view.x / cellPx, y: view.view.y / cellPx });
      }
      return result;
    });

    // vozidlo 31: prev (47,95; 24,5) kurz 90° → aktuálna (48,5; 24,62) kurz 180°
    const LANE_CELLS = 13 / 64;
    const start = { x: 47.95, y: 24.5 + LANE_CELLS }; // južný pruh východnej jazdy
    const end = { x: 48.5 - LANE_CELLS, y: 24.62 }; // západný pruh južnej jazdy
    expect(poses[0].x).toBeCloseTo(start.x, 6);
    expect(poses[0].y).toBeCloseTo(start.y, 6);
    expect(poses[1].x).toBeCloseTo((start.x + end.x) / 2, 6);
    expect(poses[1].y).toBeCloseTo((start.y + end.y) / 2, 6);
    expect(poses[2].x).toBeCloseTo(end.x, 6);
    expect(poses[2].y).toBeCloseTo(end.y, 6);
    expect(errors).toEqual([]);
  });
});
