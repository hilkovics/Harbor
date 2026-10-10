import { expect, test, type Page } from '@playwright/test';
import type { ModuleDecor } from '../../src/render/module-decor';

// R1 / TR1-06 render demo (`src/render/__demo__/r1-traffic.html`): pevné view-modely so stopou nosičov bez simu. Scény:
// `queue` (kolóna kamiónov pred bránou cez zákrutu), `crane` (carriery pod žeriavom), `depot` (zaparkované vozidlá v depe),
// `jam` (zápcha na križovatke), `hairpin` (otočka na slepej ceste). Test kontroluje, že sa sprity nosičov neprekrývajú
// (otočené obdĺžniky tela vozidla), brzdové svetlá, depo a zvýraznenie zápchy; screenshoty idú do `tests/e2e/__screenshots__/`.

const DEMO_URL = '/src/render/__demo__/r1-traffic.html';

async function openDemo(page: Page, scene: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${DEMO_URL}?scene=${scene}`);
  await page.waitForSelector('body[data-demo-ready="true"]');
  return errors;
}

/**
 * Telo nosiča v bunkách: šírka × dĺžka obsahu spritu pri 64 px bunke. Kamión (TR1-06b) = kabína po točnicu 54 px + náves od čapu 124 px
 * (27 px široký), straddle carrier 52 × 102 px (`STRADDLE_BODY_PX`).
 */
const TRUCK_BODY = { w: 27 / 64, h: (54 + 124) / 64 };
const CARRIER_BODY = { w: 52 / 64, h: 102 / 64 };

interface Pose {
  id: number;
  x: number;
  y: number;
  angle: number;
  lights: boolean;
  w: number;
  h: number;
}

/** Pózy zobrazených kamiónov a vozidiel scény v bunkách (stred spritu, uhol v stupňoch). */
async function poses(page: Page): Promise<{ trucks: Pose[]; vehicles: Pose[] }> {
  return page.evaluate(
    ({ truckBody, carrierBody }) => {
      const { renderer, scene } = window.__r1Demo!;
      const cellPx = renderer.palette.cellPx;
      const trucks = (scene.trucks ?? []).map((vm) => {
        const view = renderer.entities.truckView(vm.id)!;
        return { id: vm.id, x: view.view.x / cellPx, y: view.view.y / cellPx, angle: view.view.angle, lights: view.brakeLightsOn, ...truckBody };
      });
      const vehicles = (scene.vehicles ?? [])
        .filter((vm) => renderer.entities.vehicleView(vm.id) !== undefined)
        .map((vm) => {
          const view = renderer.entities.vehicleView(vm.id)!;
          return { id: vm.id, x: view.view.x / cellPx, y: view.view.y / cellPx, angle: view.view.angle, lights: view.brakeLightsOn, ...carrierBody };
        });
      return { trucks, vehicles };
    },
    { truckBody: TRUCK_BODY, carrierBody: CARRIER_BODY },
  );
}

type Corner = [number, number];

/** Rohy otočeného obdĺžnika: dlhá os v smere kurzu (0° = sever hore, v smere hodinových ručičiek). */
function corners(pose: Pose): Corner[] {
  const radians = (pose.angle * Math.PI) / 180;
  const forward: Corner = [Math.sin(radians), -Math.cos(radians)];
  const right: Corner = [Math.cos(radians), Math.sin(radians)];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => [pose.x + (right[0] * sx * pose.w) / 2 + forward[0] * sy * (pose.h / 2), pose.y + (right[1] * sx * pose.w) / 2 + forward[1] * sy * (pose.h / 2)] as Corner);
}

/** Hĺbka prieniku dvoch telies (SAT): najmenší presah cez osi oboch obdĺžnikov; ≤ 0 = sa nedotýkajú. */
function penetration(a: Pose, b: Pose): number {
  const rectA = corners(a);
  const rectB = corners(b);
  let least = Number.POSITIVE_INFINITY;
  for (const rect of [rectA, rectB]) {
    for (let i = 0; i < 2; i++) {
      const edge: Corner = [rect[i + 1][0] - rect[i][0], rect[i + 1][1] - rect[i][1]];
      const length = Math.hypot(edge[0], edge[1]);
      const axis: Corner = [-edge[1] / length, edge[0] / length];
      const project = (points: Corner[]): [number, number] => {
        const values = points.map((p) => p[0] * axis[0] + p[1] * axis[1]);
        return [Math.min(...values), Math.max(...values)];
      };
      const [minA, maxA] = project(rectA);
      const [minB, maxB] = project(rectB);
      least = Math.min(least, Math.min(maxA, maxB) - Math.max(minA, minB));
    }
  }
  return least;
}

/**
 * Žiadne dve telesá sa neprekrývajú. Kĺbový kamión v zákrute je v teste jeden rovný obdĺžnik (kabína zalomená voči návesu sa v ňom nevidí),
 * preto sa toleruje presah do 10 % bunky (≈ 6 px); skutočný obrys si pozri na screenshote.
 */
function expectNoOverlap(all: Pose[]): void {
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      expect(penetration(all[i], all[j]), `nosiče ${String(all[i].id)} a ${String(all[j].id)} sa prekrývajú`).toBeLessThan(0.1);
    }
  }
}

function angleDistance(a: number, b: number): number {
  const delta = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(delta, 360 - delta);
}

test('queue: kolóna štyroch kamiónov pred bránou cez zákrutu — návesy sledujú cestu, nič sa neprekrýva, stojace majú brzdové svetlá', async ({ page }) => {
  const errors = await openDemo(page, 'queue');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r1-queue.png' });
  const { trucks } = await poses(page);
  expect(trucks.map((truck) => truck.id)).toEqual([101, 102, 103, 104]);
  expectNoOverlap(trucks);
  const byId = (id: number): Pose => trucks.find((truck) => truck.id === id)!;
  // tri kamióny na rovnej ceste x = 44: kurz sever, stred o polovicu rozpätia (kabína + náves) za hlavou v pravom pruhu
  for (const [id, head] of [[101, 34.5], [102, 37.5], [103, 40.5]] as const) {
    expect(angleDistance(byId(id).angle, 0), `kamión ${String(id)}`).toBeLessThan(0.01);
    expect(byId(id).y).toBeCloseTo(head + TRUCK_BODY.h / 2, 6);
    expect(byId(id).x).toBeCloseTo(44.5 + 13 / 64, 6);
  }
  // posledný práve zatáča: tetiva medzi severom a západom (zákruta (44; 44) → ide na sever, chvost na východnom ramene)
  expect(angleDistance(byId(104).angle, 315)).toBeLessThan(0.01);
  expect(byId(104).y).toBeGreaterThan(43.5); // stred je za hlavou, v zákrute
  // brzdové svetlá: stoja 102 a 103, čelo fronty (gate_queue) a idúci kamión nie
  expect(trucks.map((truck) => [truck.id, truck.lights])).toEqual([[101, false], [102, true], [103, true], [104, false]]);
  expect(errors).toEqual([]);
});

test('queue: detail zákruty a brzdových svetiel', async ({ page }) => {
  const errors = await openDemo(page, 'queue');
  await page.evaluate(() => {
    const demo = window.__r1Demo!;
    return demo.focus(demo.scene, 45, 41.5, 2.4);
  });
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r1-queue-turn.png' });
  expect(errors).toEqual([]);
});

test('crane: dva straddle carriery za sebou pod žeriavom sa neprekrývajú, druhý čaká s brzdovými svetlami', async ({ page }) => {
  const errors = await openDemo(page, 'crane');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r1-crane.png' });
  const { vehicles } = await poses(page);
  expect(vehicles.map((vehicle) => vehicle.id)).toEqual([11, 12]);
  expectNoOverlap(vehicles);
  expect(vehicles.map((vehicle) => vehicle.lights)).toEqual([false, true]);
  expect(errors).toEqual([]);
});

test('depot: päť zaparkovaných vozidiel je v depe ako mriežka, na mape sa nekreslia ako vozidlá', async ({ page }) => {
  const errors = await openDemo(page, 'depot');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r1-depot.png' });
  const result = await page.evaluate(() => {
    const { renderer, scene } = window.__r1Demo!;
    const decor = renderer.modules.moduleView(5)?.decor<ModuleDecor & { count: number }>('parked_vehicles');
    return {
      drawn: (scene.vehicles ?? []).filter((vm) => renderer.entities.vehicleView(vm.id) !== undefined).map((vm) => vm.id),
      parkedViews: [21, 22, 23, 24, 25].filter((id) => renderer.entities.vehicleView(id) !== undefined),
      count: decor?.count ?? -1,
    };
  });
  expect(result.parkedViews).toEqual([]);
  expect(result.drawn).toEqual([30, 31, 32]);
  expect(result.count).toBe(5);
  const { vehicles } = await poses(page);
  expectNoOverlap(vehicles);
  expect(errors).toEqual([]);
});

test('jam: zaseknutý kamión na križovatke má červené bunky pod hlavou a stopou a odznak, kamióny sa neprekrývajú', async ({ page }) => {
  const errors = await openDemo(page, 'jam');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r1-jam.png' });
  const { trucks } = await poses(page);
  expectNoOverlap(trucks);
  expect(trucks.every((truck) => truck.lights)).toBe(true);
  const jam = await page.evaluate(() => {
    const { renderer } = window.__r1Demo!;
    return { cells: renderer.jams.cellCount, badges: renderer.jams.badgeCount };
  });
  expect(jam).toEqual({ cells: 3, badges: 1 });
  expect(errors).toEqual([]);
});

test('hairpin: kamión na slepej ceste sa otáča plynulo — vjazd na východ, uprostred otočky kolmo, výjazd na západ', async ({ page }) => {
  const errors = await openDemo(page, 'hairpin');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r1-hairpin.png' });
  const { trucks } = await poses(page);
  const byId = (id: number): Pose => trucks.find((truck) => truck.id === id)!;
  expect(angleDistance(byId(301).angle, 90)).toBeLessThan(0.01);
  expect(angleDistance(byId(302).angle, 0)).toBeLessThan(0.01);
  expect(angleDistance(byId(303).angle, 270)).toBeLessThan(0.01);
  expectNoOverlap(trucks);
  expect(errors).toEqual([]);
});
