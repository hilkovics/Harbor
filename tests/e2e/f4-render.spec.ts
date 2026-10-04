import { expect, test, type Page } from '@playwright/test';
import type { GateDecor } from '../../src/render/gate-decor';
import type { RampDecor } from '../../src/render/ramp-decor';
import type { WaitingAreaDecor } from '../../src/render/waiting-area-decor';

// F4 render demo (T04-06): pevné view-modely bez simu (`src/render/__demo__/f4-render.html`). Screenshoty slúžia na
// vizuálnu kontrolu: brána so závorou a odznakom fronty, čakacia plocha s obsadenými stojiskami, rampa s pripravenými
// kontajnermi, neprevádzková rampa s odznakom a kamióny na ceste, v zákrute, na stojiskách a v doku.

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

test.describe('F4: render brány, čakacej plochy, rampy a kamiónov (demo s pevnými view-modelmi)', () => {
  test('brána s frontou 3 a zatvorenou závorou, stojisko 4/6, rampa so 2 pripravenými a kamiónom v doku, neprevádzková rampa, kamióny na ceste a v zákrute', async ({ page }) => {
    const errors = await openDemo(page);

    const state = await page.evaluate(() => {
      const { renderer, scene } = window.__f4RenderDemo!;
      const module = (id: number) => renderer.modules.moduleView(id);
      const gate = module(1)?.decor<GateDecor>('gate');
      const waiting = module(2)?.decor<WaitingAreaDecor>('waiting_area');
      const rampA = module(3)?.decor<RampDecor>('ramp');
      const trucks = (scene.trucks ?? []).map((truck) => {
        const view = renderer.entities.truckView(truck.id);
        const sprite = view?.view.children[0];
        return {
          id: truck.id,
          textured: view?.texture !== null,
          angle: Math.round((((view?.view.angle ?? 0) % 360) + 360) % 360),
          width: sprite?.width ?? Number.NaN,
          height: sprite?.height ?? Number.NaN,
        };
      });
      return {
        cellPx: renderer.palette.cellPx,
        moduleCount: renderer.modules.moduleCount,
        truckCount: renderer.entities.truckCount,
        barrierAngle: gate?.barrierAngle,
        queueVisible: gate?.queueBadgeVisible,
        queueText: gate?.queueBadge?.shownText,
        highlighted: waiting?.highlighted,
        staged: [rampA?.stagedDrawn(0), rampA?.stagedDrawn(1)],
        badges: [1, 2, 3, 4].map((id) => module(id)?.badgeVisible),
        trucks,
      };
    });

    expect(state.moduleCount).toBe(4);
    expect(state.truckCount).toBe(10);
    expect(state.barrierAngle).toBe(0); // závora zatvorená
    expect(state.queueVisible).toBe(true);
    expect(state.queueText).toBe('3');
    expect(state.highlighted).toEqual([0, 1, 3, 4]);
    expect(state.staged).toEqual([2, 0]);
    expect(state.badges).toEqual([false, false, false, true]); // odznak upozornenia iba na neprevádzkovej rampe B
    // sprity (nie fallback), plátno 1×2 bunky v jednotnej mierke vozidiel (VEHICLE_SCALE = 1; kamión v ňom 28 × 116 px, TEU v návese 64 × 26)
    expect(state.trucks.every((truck) => truck.textured)).toBe(true);
    for (const truck of state.trucks) {
      expect(truck.width / state.cellPx, `šírka kamióna ${String(truck.id)}`).toBeCloseTo(1, 6);
      expect(truck.height / truck.width, `pomer kamióna ${String(truck.id)}`).toBeCloseTo(2, 6);
    }
    // kurz 0° / 180° a kamión v zákrute (id 104) otočený plynule medzi severom a západom
    const angle = (id: number): number => state.trucks.find((truck) => truck.id === id)!.angle;
    expect([angle(101), angle(103), angle(110)]).toEqual([0, 180, 180]);
    expect(angle(104)).toBeGreaterThan(270);
    expect(angle(104)).toBeLessThan(360);

    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-demo.png' });
    expect(errors).toEqual([]);
  });

  test('závora sa otvorí a odznak fronty ukáže nové číslo; skryje sa pri prázdnej fronte (priblíženie na bránu)', async ({ page }) => {
    const errors = await openDemo(page);

    await page.evaluate(() => window.__f4RenderDemo!.focus(44.5, 32.5, 1.5));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-gate-closed.png' });

    const opened = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f4RenderDemo!;
      const modules = scene.modules.map((module) =>
        module.id === 1 && module.gate ? { ...module, gate: { ...module.gate, open: true, queueLength: 12 } } : module,
      );
      await show({ ...scene, modules });
      await new Promise((resolve) => setTimeout(resolve, 300)); // trvanie prechodu závory je pod 200 ms
      await show({ ...scene, modules });
      const gate = renderer.modules.moduleView(1)?.decor<GateDecor>('gate');
      return { angle: gate?.barrierAngle, text: gate?.queueBadge?.shownText, moduleViews: renderer.modules.moduleCount };
    });
    expect(opened.angle).toBe(-90);
    expect(opened.text).toBe('12');
    expect(opened.moduleViews).toBe(4); // zmena fronty a závory nevytvorila views nanovo
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-gate-open.png' });

    const emptied = await page.evaluate(async () => {
      const { renderer, scene, show } = window.__f4RenderDemo!;
      const modules = scene.modules.map((module) =>
        module.id === 1 && module.gate ? { ...module, gate: { ...module.gate, open: false, queueLength: 0 } } : module,
      );
      await show({ ...scene, modules });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await show({ ...scene, modules });
      const gate = renderer.modules.moduleView(1)?.decor<GateDecor>('gate');
      return { angle: gate?.barrierAngle, visible: gate?.queueBadgeVisible };
    });
    expect(emptied).toEqual({ angle: 0, visible: false });
    expect(errors).toEqual([]);
  });

  test('priblíženie: čakacia plocha so zvýraznenými stojiskami a rampy s kontajnermi, kamiónom v doku a odznakom', async ({ page }) => {
    const errors = await openDemo(page);

    await page.evaluate(() => window.__f4RenderDemo!.focus(35, 27, 2));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-waiting.png' });
    await page.evaluate(() => window.__f4RenderDemo!.focus(34.5, 24.5, 1.4));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-ramp.png' });
    await page.evaluate(() => window.__f4RenderDemo!.focus(44.5, 29.5, 2));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f4-render-turn.png' });
    expect(errors).toEqual([]);
  });
});
