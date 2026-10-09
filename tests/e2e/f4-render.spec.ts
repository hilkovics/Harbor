import { expect, test, type Page } from '@playwright/test';
import type { GateLaneDecor } from '../../src/render/gate-lane-decor';
import type { HoldingSlotsDecor } from '../../src/render/tp-holding-decor';

// F4 render demo (T04-06, po R4 prerobené): pevné view-modely bez simu (`src/render/__demo__/f4-render.html`). Screenshoty slúžia na
// vizuálnu kontrolu: pruhy brány (závora, štítok kroku), odstavná plocha s obsadenými miestami a kamióny na ceste, v zákrute,
// v pruhu a na odstavnej ploche.

const DEMO_URL = '/src/render/__demo__/f4-render.html';

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

test.describe('F4: render pruhov brány, odstavnej plochy a kamiónov (demo s pevnými view-modelmi)', () => {
  test('vstupný pruh so závorou dole a krokom, voľný výstupný pruh so závorou hore, odstavná plocha 2/4, kamióny na ceste a v zákrute', async ({ page }) => {
    const errors = await openDemo(page);

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f4RenderDemo!;
      const module = (id: number) => renderer.modules.moduleView(id);
      const inLane = module(1)?.decor<GateLaneDecor>('gate-lane');
      const outLane = module(2)?.decor<GateLaneDecor>('gate-lane');
      const holding = module(3)?.decor<HoldingSlotsDecor>('holding-slots');
      const trucks = (scene.trucks ?? []).map((truck) => {
        const view = renderer.entities.truckView(truck.id);
        const sprite = view?.trailerView?.children[0] ?? view?.view.children[0]; // R1: kamión je z častí, rozmer berieme z návesu (1×2)
        return {
          id: truck.id,
          textured: view?.textured === true,
          angle: Math.round((((view?.view.angle ?? 0) % 360) + 360) % 360),
          width: sprite?.width ?? Number.NaN,
          height: sprite?.height ?? Number.NaN,
        };
      });
      return {
        cellPx: renderer.palette.cellPx,
        moduleCount: renderer.modules.moduleCount,
        truckCount: renderer.entities.truckCount,
        inBarrierOpen: inLane?.barrierOpen,
        inLabel: inLane?.labelText,
        outBarrierOpen: outLane?.barrierOpen,
        outLabel: outLane?.labelText,
        occupied: holding?.occupied,
        trucks,
      };
    });

    expect(state.moduleCount).toBe(3);
    expect(state.truckCount).toBe(7);
    expect(state.inBarrierOpen).toBe(false); // vstupný pruh spracúva krok → závora dole
    expect(state.inLabel).not.toBe('');
    expect(state.outBarrierOpen).toBe(true); // voľný pruh → závora hore
    expect(state.outLabel).toBe('');
    expect(state.occupied).toBe(2);
    // sprity (nie fallback), plátno 1×2 bunky v jednotnej mierke vozidiel (VEHICLE_SCALE = 1; náves 1×2)
    expect(state.trucks.every((truck) => truck.textured)).toBe(true);
    for (const truck of state.trucks) {
      expect(truck.width / state.cellPx, `šírka kamióna ${String(truck.id)}`).toBeCloseTo(1, 6);
      expect(truck.height / truck.width, `pomer kamióna ${String(truck.id)}`).toBeCloseTo(2, 6);
    }
    // kurz 0° / 180° a kamión v zákrute (id 104) otočený plynule medzi severom a západom
    const angle = (id: number): number => state.trucks.find((truck) => truck.id === id)!.angle;
    expect([angle(101), angle(103), angle(110)]).toEqual([0, 180, 0]);
    expect(angle(104)).toBeGreaterThan(270);
    expect(angle(104)).toBeLessThan(360);

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-demo.png' });
    expect(errors).toEqual([]);
  });

  test('závora vstupného pruhu sa po skončení kroku zdvihne a štítok zmizne (priblíženie na pruhy)', async ({ page }) => {
    const errors = await openDemo(page);

    await page.evaluate(() => window.__f4RenderDemo!.focus(45, 32, 2));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-gate-closed.png' });

    const opened = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f4RenderDemo!;
      const modules = scene.modules.map((module) =>
        module.id === 1 && module.gateLane ? { ...module, gateLane: { kind: module.gateLane.kind, mode: module.gateLane.mode, roofPart: module.gateLane.roofPart } } : module,
      );
      await show({ ...scene, modules });
      await new Promise((resolve) => setTimeout(resolve, 300)); // trvanie prechodu závory je pod 200 ms
      await show({ ...scene, modules });
      const lane = renderer.modules.moduleView(1)?.decor<GateLaneDecor>('gate-lane');
      return { open: lane?.barrierOpen, label: lane?.labelText, moduleViews: renderer.modules.moduleCount };
    });
    expect(opened).toEqual({ open: true, label: '', moduleViews: 3 }); // zmena kroku nevytvorila views nanovo
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-gate-open.png' });
    expect(errors).toEqual([]);
  });

  test('priblíženie: odstavná plocha s obsadenými miestami a zákruta kamióna', async ({ page }) => {
    const errors = await openDemo(page);

    await page.evaluate(() => window.__f4RenderDemo!.focus(36, 28, 2));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-holding.png' });
    await page.evaluate(() => window.__f4RenderDemo!.focus(44.5, 29.5, 2));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-turn.png' });
    expect(errors).toEqual([]);
  });
});
