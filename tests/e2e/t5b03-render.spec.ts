import { expect, test, type Page } from '@playwright/test';
import type { TruckVM } from '../../src/render/view-models';
import type { YardCraneDecor } from '../../src/render/yard-crane-decor';

// T5B-03 render demo (`src/render/__demo__/t5b03-render.html`): pevné view-modely bez simu a riadené hodiny animácií, takže
// screenshoty sú deterministické. Scény: `scale` (audit mierky, napojenie ciest na konektory), `connect` (brána, stojisko
// a rampy prepojené cestami), `yard` (portálový žeriav dvora), `dock` (kamión cúva do docku).

const DEMO_URL = '/src/render/__demo__/t5b03-render.html';

async function openDemo(page: Page, scene: string, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${DEMO_URL}?scene=${scene}${extra}`);
  await page.waitForSelector('body[data-demo-ready="true"]');
  return errors;
}

test('scale: celá scéna a detail vozidiel vedľa kontajnerov', async ({ page }) => {
  const errors = await openDemo(page, 'scale');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-scale-overview.png' });
  await page.evaluate(() => {
    const demo = window.__t5b03Demo!;
    return demo.focus(demo.scene, 41.5, 17.5, 2.4);
  });
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-scale-carriers.png' });
  await page.evaluate(() => {
    const demo = window.__t5b03Demo!;
    return demo.focus(demo.scene, 51, 22, 2.0);
  });
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-scale-trucks.png' });
  expect(errors).toEqual([]);
});

test('connect: cesty napojené na bránu, stojisko a rampy', async ({ page }) => {
  const errors = await openDemo(page, 'connect');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-roads-connected.png' });
  await page.evaluate(() => {
    const demo = window.__t5b03Demo!;
    return demo.focus(demo.scene, 35, 26, 1.4);
  });
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-roads-connected-zoom.png' });
  expect(errors).toEqual([]);
});

test('yard: portálový žeriav dvora sa presunie nad slot, spustí a zdvihne kontajner (put) a pri take ho vezme a zdvihne', async ({ page }) => {
  const errors = await openDemo(page, 'yard');
  const sample = async (ms: number, name: string | null): Promise<{ phase: string; hoist: number; gantryY: number; trolleyX: number; cargo: boolean; alpha: number }> => {
    const pose = await page.evaluate(async (at) => {
      const { clock, renderer, scene } = window.__t5b03Demo!;
      clock.set(at);
      // operácie dvora: put slotu 13 od času 2000, take slotu 20 od času 4000
      const op = at >= 4000 ? { slot: 20, tick: 60, kind: 'take' as const } : at >= 2000 ? { slot: 13, tick: 50, kind: 'put' as const } : undefined;
      const modules = scene.modules.map((module) => (op !== undefined && module.id === 3 ? { ...module, lastStorageOp: op } : module));
      await window.__t5b03Demo!.show({ ...scene, modules });
      const decor = renderer.modules.moduleView(3)?.decor<YardCraneDecor>('yard_crane');
      const p = decor!.pose;
      return { phase: p.phase, hoist: p.hoist, gantryY: p.gantryY, trolleyX: p.trolleyX, cargo: p.cargo !== null, alpha: p.cargo?.alpha ?? 0 };
    }, ms);
    if (name !== null) await page.screenshot({ path: `tests/e2e/__screenshots__/${name}.png` });
    return pose;
  };

  // pokoj: žeriav stojí v domovskej polohe a nemá spreader
  await page.evaluate(() => {
    window.__t5b03Demo!.clock.set(1000);
  });
  const idle = await sample(1000, 't5b03-yard-idle');
  expect(idle.phase).toBe('idle');

  // vozidlo uložilo kontajner na slot 13 (put): nová operácia spustí žeriav v čase 2000
  await page.evaluate(async () => {
    const demo = window.__t5b03Demo!;
    demo.clock.set(2000);
    const modules = demo.scene.modules.map((module) => (module.id === 3 ? { ...module, lastStorageOp: { slot: 13, tick: 50, kind: 'put' as const } } : module));
    await demo.show({ ...demo.scene, modules });
  });
  const travel = await sample(2070, 't5b03-yard-travel');
  expect(travel.phase).toBe('travel');
  expect(travel.cargo).toBe(true); // kontajner visí na spreaderi
  expect(travel.gantryY).toBeGreaterThan(idle.gantryY);
  const lower = await sample(2250, 't5b03-yard-lower');
  expect(lower.phase).toBe('lower');
  expect(lower.hoist).toBeGreaterThan(0);
  const lift = await sample(2480, 't5b03-yard-lift');
  expect(lift.phase).toBe('lift');
  expect(lift.hoist).toBeLessThan(1);
  const done = await sample(3200, null);
  expect(done.phase).toBe('idle'); // operácia skončila, žeriav stojí nad posledným slotom
  expect(done.gantryY).toBeCloseTo(lift.gantryY, 6);

  // vozidlo vzalo kontajner zo slotu 20 (take): prázdny spreader ide nad slot, uchopí, zdvihne a odovzdá
  await page.evaluate(() => {
    window.__t5b03Demo!.clock.set(3500);
  });
  const takeTravel = await sample(4100, 't5b03-yard-take-travel');
  expect(takeTravel.phase).toBe('travel');
  expect(takeTravel.cargo).toBe(false); // spreader ide prázdny
  const takeGrab = await sample(4470, 't5b03-yard-take-grab'); // operácia začala pri prvom zobrazení (4100): presun 150, spustenie 180, uchopenie 80
  expect(takeGrab.phase).toBe('hold');
  expect(takeGrab.hoist).toBe(1);
  expect(takeGrab.cargo).toBe(true); // kontajner uchopený
  const takeLift = await sample(4600, 't5b03-yard-take-lift');
  expect(takeLift.phase).toBe('lift');
  expect(takeLift.alpha).toBe(1);
  expect(takeLift.hoist).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test('yard: s prefers-reduced-motion žeriav nad slot preskočí bez animácie', async ({ page }) => {
  const errors = await openDemo(page, 'yard', '&reducedMotion=1');
  const result = await page.evaluate(async () => {
    const demo = window.__t5b03Demo!;
    demo.clock.set(1000);
    const modules = demo.scene.modules.map((module) => (module.id === 3 ? { ...module, lastStorageOp: { slot: 13, tick: 50, kind: 'put' as const } } : module));
    await demo.show({ ...demo.scene, modules });
    const decor = demo.renderer.modules.moduleView(3)?.decor<YardCraneDecor>('yard_crane');
    return { phase: decor!.pose.phase, busy: decor!.busy, y: decor!.pose.gantryY };
  });
  expect(result.phase).toBe('idle');
  expect(result.busy).toBe(false);
  expect(result.y).toBeGreaterThan(-1.4875); // už nie v domovskej polohe
  expect(errors).toEqual([]);
});

test.describe('dock: kamión cúva do docku a odchádza predkom', () => {
  /** Dok 0 (príjazd popri rampe z východu) a dok 1 (príjazd zo juhu priamo na modul) rampy A (30; 23): stredy docku z manifestu. */
  const DOCK_Y = 24 + (60 + 62 / 2) / 64 - 1;
  const loading = (id: number, x: number, arrival: 0 | 270): TruckVM => ({
    id,
    defId: 'truck_container',
    x,
    y: DOCK_Y,
    prevX: x,
    prevY: DOCK_Y,
    heading: 180,
    loaded: false,
    state: 'loading',
    prevState: 'to_dock',
    approach: { x, y: 25.5, heading: arrival },
  });

  interface Sample {
    t: number;
    trucks: { x: number; y: number; angle: number; phase: string }[];
  }

  /** Kroky animácie v jednom behu stránky: pre každý čas nastaví hodiny, zobrazí kamióny a zaznamená ich pózy. */
  async function run(page: Page, frames: { t: number; trucks: TruckVM[] }[], shots: Record<number, string> = {}): Promise<Sample[]> {
    const samples: Sample[] = [];
    for (const frame of frames) {
      samples.push(
        await page.evaluate(async ({ frame }) => {
          const demo = window.__t5b03Demo!;
          demo.clock.set(frame.t);
          if (frame.shot) await demo.show({ ...demo.scene, trucks: frame.trucks });
          else demo.sync({ ...demo.scene, trucks: frame.trucks });
          const cellPx = demo.renderer.palette.cellPx;
          return {
            t: frame.t,
            trucks: frame.trucks.map((truck) => {
              const view = demo.renderer.entities.truckView(truck.id)!;
              return { x: view.view.x / cellPx, y: view.view.y / cellPx, angle: ((view.view.angle % 360) + 360) % 360, phase: view.dockPhase };
            }),
          };
        }, { frame: { ...frame, shot: shots[frame.t] !== undefined } }),
      );
      const shot = shots[frame.t];
      if (shot !== undefined) await page.screenshot({ path: `tests/e2e/__screenshots__/${shot}.png` });
    }
    return samples;
  }

  /** Najväčší krok polohy (bunky) a otočenia (°) medzi susednými vzorkami; otočenie bez posunu sa hlási zvlášť. */
  function smoothness(samples: Sample[], truck: number): { step: number; turn: number; spin: number } {
    let step = 0;
    let turn = 0;
    let spin = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].trucks[truck];
      const b = samples[i].trucks[truck];
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      let rotated = Math.abs(b.angle - a.angle);
      if (rotated > 180) rotated = 360 - rotated;
      step = Math.max(step, moved);
      turn = Math.max(turn, rotated);
      if (moved < 0.002 && rotated > 3) spin = Math.max(spin, rotated); // otáča sa na mieste
    }
    return { step, turn, spin };
  }

  test('bočný príjazd (dok 0) a príjazd priamo na modul (dok 1): zastavenie, cúvanie po krivke bez skoku, nakládka, výjazd', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await openDemo(page, 'dock');
    const side = loading(201, 31.5, 270);
    const straight = loading(202, 32.5, 0);
    const arrived = [
      { ...side, state: 'to_dock', x: 31.5, y: 25.5, prevX: 31.5, prevY: 25.5, heading: 270 as const, approach: undefined },
      { ...straight, state: 'to_dock', x: 32.5, y: 25.5, prevX: 32.5, prevY: 25.5, heading: 0 as const, approach: undefined },
    ];

    // 1) príjazd: kamióny stoja na vonkajších bunkách konektorov (to_dock), potom sa v čase 1000 začne nakládka
    const times = [1000, 1150, 1300, 1500, 1800, 2100, 2400, 2700, 3000];
    const entering = await run(
      page,
      [{ t: 500, trucks: arrived }, ...times.map((t) => ({ t, trucks: [side, straight] }))],
      { 500: 't5b03-dock-1-arrived', 1150: 't5b03-dock-2-stopped', 1800: 't5b03-dock-3-reversing', 2400: 't5b03-dock-4-reversing-late', 3000: 't5b03-dock-5-docked' },
    );
    const at = (t: number): Sample => entering.find((sample) => sample.t === t)!;
    // zastavenie: prvých 300 ms sa kamióny nehýbu, potom cúvajú; v doku kabína von z rampy (juh 180°) v strede docku
    expect(at(1000).trucks.map((truck) => truck.phase)).toEqual(['entering', 'entering']);
    for (const truck of [0, 1]) {
      expect(at(1150).trucks[truck].y).toBeCloseTo(at(1000).trucks[truck].y, 6);
      expect(Math.hypot(at(1800).trucks[truck].x - at(1000).trucks[truck].x, at(1800).trucks[truck].y - at(1000).trucks[truck].y)).toBeGreaterThan(0.1);
      expect(at(3000).trucks[truck].phase).toBe('docked');
      expect(at(3000).trucks[truck].angle).toBeCloseTo(180, 6);
    }
    expect(at(3000).trucks[0].x).toBeCloseTo(31.5, 6);
    expect(at(3000).trucks[1].x).toBeCloseTo(32.5, 6);
    expect(at(3000).trucks[0].y).toBeCloseTo(DOCK_Y, 6);
    // kurz sa mení plynule spolu s pohybom: prvý kamión stojí v zákrute (45° medzi západom a severom = 315°) a cúva na 180°
    expect(at(1000).trucks[0].angle).toBeCloseTo(315, 6);
    expect(at(1800).trucks[0].angle).toBeLessThan(315);
    expect(at(1800).trucks[0].angle).toBeGreaterThan(180);

    // 2) cúvanie je spojité: hustejší záznam bez skoku a bez otáčania na mieste
    const dense = await run(page, Array.from({ length: 27 }, (_, i) => ({ t: 1000 + i * 75, trucks: [side, straight] })));
    for (const truck of [0, 1]) {
      const { step, turn, spin } = smoothness(dense, truck);
      expect(step, `kamión ${String(truck)}: skok`).toBeLessThan(0.3);
      expect(turn, `kamión ${String(truck)}: uhol za 75 ms`).toBeLessThan(40);
      expect(spin, `kamión ${String(truck)}: otáčanie na mieste`).toBe(0);
    }

    // 3) výjazd predkom: po nakládke (to_gate_out) sa sim kamióny rozbehnú po ceste, zobrazená póza ich plynule dobieha
    const leavingFrames = Array.from({ length: 17 }, (_, i) => {
      const t = 4000 + i * 75;
      const travelled = (i * 75) / 1000 * 0.5;
      return {
        t,
        trucks: [
          { ...side, state: 'to_gate_out', prevState: 'loading', approach: undefined, loaded: true, x: 31.5 + travelled, y: 25.5, prevX: 31.5 + travelled, prevY: 25.5, heading: 90 as const },
          { ...straight, state: 'to_gate_out', prevState: 'loading', approach: undefined, loaded: true, x: 32.5, y: 25.5 + travelled, prevX: 32.5, prevY: 25.5 + travelled, heading: 180 as const },
        ],
      };
    });
    const leaving = await run(page, [{ t: 3500, trucks: [side, straight] }, ...leavingFrames], { 4300: 't5b03-dock-6-leaving' });
    expect(leaving[1].trucks[0].phase).toBe('leaving');
    expect(leaving[leaving.length - 1].trucks[0].phase).toBe('free');
    expect(leaving[leaving.length - 1].trucks[1].phase).toBe('free');
    for (const truck of [0, 1]) {
      const { step, turn } = smoothness(leaving.slice(1), truck);
      expect(step, `kamión ${String(truck)}: skok pri výjazde`).toBeLessThan(0.4);
      expect(turn, `kamión ${String(truck)}: uhol pri výjazde`).toBeLessThan(40);
    }
    // výjazd začína v doku (nie na vonkajšej bunke), končí na pohyblivej póze zo simu
    expect(leaving[1].trucks[0].y).toBeCloseTo(DOCK_Y, 1);
    expect(errors).toEqual([]);
  });
});
