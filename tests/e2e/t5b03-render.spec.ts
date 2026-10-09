import { expect, test, type Page } from '@playwright/test';
import type { YardCraneDecor } from '../../src/render/yard-crane-decor';

// T5B-03 render demo (`src/render/__demo__/t5b03-render.html`): pevné view-modely bez simu a riadené hodiny animácií, takže
// screenshoty sú deterministické. Scény: `scale` (audit mierky, napojenie ciest na konektory), `lanes` (protismerné vozidlá na
// dvojpruhovej ceste), `connect` (pruhy brány a odstavná plocha prepojené cestami), `yard` (portálový žeriav dvora).

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

test('lanes: protismerné vozidlá v pravých pruhoch dvojpruhovej cesty sa míňajú s prekrytím najviac o pár px', async ({ page }) => {
  const errors = await openDemo(page, 'lanes');
  const poses = await page.evaluate(() => {
    const { renderer, scene } = window.__t5b03Demo!;
    const cellPx = renderer.palette.cellPx;
    const pose = (view: { view: { x: number; y: number; angle: number } } | undefined) => ({ x: (view?.view.x ?? Number.NaN) / cellPx, y: (view?.view.y ?? Number.NaN) / cellPx, angle: view?.view.angle ?? Number.NaN });
    return {
      vehicles: (scene.vehicles ?? []).map((vehicle) => ({ id: vehicle.id, heading: vehicle.heading, ...pose(renderer.entities.vehicleView(vehicle.id)) })),
      trucks: (scene.trucks ?? []).map((truck) => ({ id: truck.id, heading: truck.heading, ...pose(renderer.entities.truckView(truck.id)) })),
    };
  });
  const all = [...poses.vehicles, ...poses.trucks];
  // východ (90°) jazdí v južnom pruhu (+13/64 od osi y = 23,5), západ (270°) v severnom (−13/64)
  for (const vehicle of all) {
    const expected = 23.5 + (vehicle.heading === 90 ? 13 / 64 : -13 / 64);
    expect(vehicle.y, `vozidlo ${String(vehicle.id)}`).toBeCloseTo(expected, 6);
  }
  const byId = (id: number) => all.find((vehicle) => vehicle.id === id)!;
  // protismerné dvojice: stredy od seba práve jeden pruh (26/64 bunky) a v rovnakom x
  for (const [a, b] of [
    [51, 52],
    [61, 62],
    [53, 63],
  ] as const) {
    expect(Math.abs(byId(a).y - byId(b).y), `dvojica ${String(a)}/${String(b)}`).toBeCloseTo(26 / 64, 6);
    expect(byId(a).x).toBeCloseTo(byId(b).x, 6);
  }
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-lanes.png' });
  expect(errors).toEqual([]);
});

test('connect: cesty napojené na pruhy brány a odstavnú plochu', async ({ page }) => {
  const errors = await openDemo(page, 'connect');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/t5b03-roads-connected.png' });
  await page.evaluate(() => {
    const demo = window.__t5b03Demo!;
    return demo.focus(demo.scene, 38, 28, 1.4);
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
