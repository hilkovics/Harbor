import { expect, test, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// R4 e2e (TR4-05): kamióny stoja vedľa seba v predbránovej ploche a kamión na TP v pruhu RTG bloku je práve obsluhovaný strojom (kontajner visí na RTG nad ním).
// Rozloženie na `harbor_01` (jednosmerný okruh, bez lode a vozidiel; export prichádza kamiónmi, RTG ho ukladá do bloku):
//
//   verejná cesta x = 44 sever → (44, 33) západ po y = 33 → vjazd predbránovej plochy (34, 33) → plocha (34, 25) 8 × 8 → výjazd (41, 24) → vstupný pruh (41, 20)
//   → (41, 18) východ po y = 18 → (52, 18) obojsmerná bunka, juh do pruhu RTG bloku (48, 19) [pruh x = 52, TP v každom bayi] → (52, 31) západ po y = 31 → (47, 31) sever → (47, 29)
//   západ → (45, 29) juh → výstupný pruh (45, 30) rot 180 → verejná cesta x = 45 na juh k portálu.
//
// Export prichádza po prijatí ponuky (booking vzniká pri uzávierke prvého dňa, ADR-032); čas sa posúva cez `window.__sim.advance` a hra sa zastaví, keď platí podmienka: aspoň dva
// kamióny v `pre_gate`, kamión v `at_tp` a RTG drží kontajner nad kamiónom na TP. Screenshot: `r4-tp-rtg.png`.

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 4 * 60_000 });

type Cell = { readonly x: number; readonly y: number };
const row = (y: number, x0: number, x1: number): Cell[] => Array.from({ length: x1 - x0 + 1 }, (_unused, i) => ({ x: x0 + i, y }));
const oneWay = (cells: readonly Cell[], dirs: readonly string[]) => ({ type: 'PlaceRoad', kind: 'one_way', cells, dirs });

/** Cesty a moduly rozloženia v poradí stavby (id modulov: Root berth 1, žeriav 2, plocha 3, vstupný pruh 4, RTG blok 5, výstupný pruh 7 — RTG blok si berie aj id stroja). */
const COMMANDS: readonly Record<string, unknown>[] = [
  oneWay([{ x: 44, y: 34 }], ['N']),
  oneWay([...row(33, 35, 44).reverse(), { x: 34, y: 33 }], [...Array<string>(10).fill('W'), 'N']),
  oneWay([{ x: 41, y: 24 }], ['N']),
  oneWay([{ x: 41, y: 19 }, { x: 41, y: 18 }, ...row(18, 42, 51)], ['N', ...Array<string>(11).fill('E')]),
  // vjazd RTG bloku je obojsmerná bunka: jednosmerná cesta by mu vjazd odmietla ako slepú (`connector_blocked`, TR5-02b); do pruhu bloku sa z nej ide na juh
  { type: 'PlaceRoad', cells: [{ x: 52, y: 18 }] },
  oneWay(
    [...row(31, 48, 52).reverse(), { x: 47, y: 31 }, { x: 47, y: 30 }, { x: 47, y: 29 }, { x: 46, y: 29 }, { x: 45, y: 29 }],
    [...Array<string>(5).fill('W'), 'N', 'N', 'W', 'W', 'S'],
  ),
  { type: 'PlaceModule', defId: 'pre_gate_buffer', x: 34, y: 25, rotation: 0 },
  { type: 'PlaceModule', defId: 'gate_in_lane', x: 41, y: 20, rotation: 0 },
  { type: 'PlaceModule', defId: 'rtg_block', x: 48, y: 19, rotation: 0 },
  { type: 'PlaceModule', defId: 'gate_out_lane', x: 45, y: 30, rotation: 180 },
];
const MODULE_DEFS = ['pre_gate_buffer', 'gate_in_lane', 'rtg_block', 'gate_out_lane'];

/** Pohľad: predbránová plocha (34–41 × 25–32) aj RTG blok (48–52 × 19–30) naraz, zoom 0,6 (bunka 38 px). */
const VIEW = { x: 43.5, y: 26, zoom: 0.6 } as const;

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(
    () => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined && window.__sim.advance !== undefined,
  );
  return errors;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

interface AdvanceArgs {
  readonly maxTicks: number;
  limit: number | null;
}

/**
 * Posúva hru po 5 tickoch (`window.__sim.advance`), kým `condition` neplatí, potom hru zastaví. Podmienka je funkcia z tohto súboru (posiela sa jej zdrojový text) a čítať smie len
 * `window.__sim.world` (lacné dopyty); strop `maxTicks` chráni pred nekonečným behom.
 */
async function advanceUntil(page: Page, condition: () => boolean, maxTicks = 200_000): Promise<void> {
  const runner = new Function(
    'args',
    `const sim = window.__sim;
     const condition = ${condition.toString()};
     if (args.limit === null) args.limit = sim.world.clock.tick + args.maxTicks;
     if (sim.world.clock.speed === 0) sim.world.clock.setSpeed(1);
     for (let i = 0; i < 120; i += 1) {
       if (condition()) { sim.world.clock.setSpeed(0); return true; }
       if (sim.world.clock.tick > args.limit) throw new Error('advanceUntil: strop ' + args.maxTicks + ' tickov bez splnenia podmienky');
       sim.advance(5);
     }
     return false;`,
  ) as (args: AdvanceArgs) => boolean;
  await page.waitForFunction(runner, { maxTicks, limit: null }, { polling: 'raf', timeout: 3 * 60_000 });
}

test.describe('R4: predbránová plocha vedľa seba a kamión na TP obsluhovaný RTG (TR4-05)', () => {
  test('export prichádza kamiónmi: rady predbránovej plochy, vstupný pruh, TP v pruhu RTG bloku s kontajnerom na stroji', async ({ page }) => {
    const errors = await openGame(page);
    await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [VIEW.x, VIEW.y, VIEW.zoom] as const);
    await settle(page);

    // 1) rozloženie cez dispatchJSON; všetky moduly s cestným konektorom sú pripojené
    for (const command of COMMANDS) expect(await dispatch(page, command), JSON.stringify(command).slice(0, 120)).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().modules.length)).toBe(1 + MODULE_DEFS.length);
    const modules = (await page.evaluate(() => window.__sim!.entities())).modules;
    expect(MODULE_DEFS.every((defId) => modules.some((module) => module.defId === defId))).toBe(true);
    expect(modules.filter((module) => module.connected !== undefined).every((module) => module.connected === true)).toBe(true);
    const rtgVm = modules.find((module) => module.defId === 'rtg_block')!;
    expect(rtgVm.tpCells?.length).toBeGreaterThan(0);
    expect(rtgVm.tpCells?.every((cell) => cell.x === 52)).toBe(true); // TP v pruhu bloku (stĺpec x = 52)
    expect(modules.find((module) => module.defId === 'pre_gate_buffer')!.connected).toBe(true);

    // 2) uzávierka prvého dňa prinesie booking ponuky; prijme sa export (ponuka roundtrip prijme aj import)
    await advanceUntil(page, () => [...window.__sim!.world.contracts.values()].some((contract) => contract.kind === 'export' && contract.state === 'offered'), 30_000);
    const accepted = await page.evaluate(() => {
      const offer = [...window.__sim!.world.contracts.values()].find((contract) => contract.kind === 'export' && contract.state === 'offered')!;
      return window.__sim!.dispatchJSON!({ type: 'AcceptContract', contractId: offer.id } as never).ok;
    });
    expect(accepted).toBe(true);

    // 3) kamióny prichádzajú: aspoň dva v `pre_gate`, jeden v `at_tp` a RTG drží kontajner (kontajner sa pohybuje medzi kamiónom a blokom)
    await advanceUntil(page, () => {
      const { world } = window.__sim!;
      let pre = 0;
      let atTp = 0;
      for (const truck of world.trucks.values()) {
        if (truck.state === 'pre_gate') pre += 1;
        else if (truck.state === 'at_tp') atTp += 1;
      }
      if (pre < 2 || atTp < 1) return false;
      // RTG drží kontajner a jeho rám stojí v bayi TP, na ktorom kamión stojí (stroj je práve nad kamiónom)
      for (const truck of world.trucks.values()) {
        if (truck.state !== 'at_tp' || truck.tpCell === null) continue;
        const bay = Math.floor(truck.tpCell / world.grid.width) - 19;
        for (const machine of world.machines.values()) {
          if (world.cargo.countAt('in_handler', machine.id) > 0 && Math.abs(machine.poseNow().gantry - bay) < 0.6) return true;
        }
      }
      return false;
    });
    await dismissToasts(page);
    await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [VIEW.x, VIEW.y, VIEW.zoom] as const);
    await settle(page);
    const snapshot = await page.evaluate(() => ({ entities: window.__sim!.entities(), rendered: window.__sim!.rendered!() }));
    const trucks = snapshot.entities.trucks;
    const inPre = trucks.filter((truck) => truck.state === 'pre_gate');
    const atTp = trucks.filter((truck) => truck.state === 'at_tp');
    expect(inPre.length).toBeGreaterThanOrEqual(2);
    // vedľa seba: kamióny sú v rôznych radoch plochy (rôzne stĺpce), každý vo footprinte plochy 34–41 × 25–32
    expect(new Set(inPre.map((truck) => Math.floor(truck.x))).size).toBeGreaterThanOrEqual(2);
    for (const truck of inPre) {
      expect(truck.x).toBeGreaterThanOrEqual(34);
      expect(truck.x).toBeLessThan(42);
      expect(truck.y).toBeGreaterThanOrEqual(25);
      expect(truck.y).toBeLessThan(33);
    }
    // kamión na TP stojí v pruhu RTG bloku (stĺpec 52) a stroj nad ním drží kontajner
    expect(atTp.length).toBeGreaterThanOrEqual(1);
    expect(Math.floor(atTp[0]!.x)).toBe(52);
    const machine = snapshot.entities.machines?.find((candidate) => candidate.cargo !== null);
    expect(machine).toBeDefined();
    const busy = snapshot.entities.modules.find((module) => module.defId === 'rtg_block')!.tpCells!.filter((cell) => cell.busy);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.rendered.trucks).toBe(trucks.length);
    expect(trucks.every((truck) => truck.state !== 'no_path')).toBe(true);
    await page.mouse.move(0, 0);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/r4-tp-rtg.png`, fullPage: true });

    // sim v DEV hlási porušenie konzervácie do konzoly (každý tick) — nesmie byť žiadna chyba ani výnimka
    expect(errors).toEqual([]);
  });
});
