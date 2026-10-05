import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// F6d e2e (T6D-02, dodatok ADR-033): žeriav odovzdáva kontajner priamo vozidlu, ktoré stojí pod ním. Prístav zo scenára `live_terminal` (cesty,
// moduly, dve vozidlá straddle carrier + empty handler), prijatý import kontajnerov → loď vykladá. Hra sa posúva po jednom ticku, kým:
//   1. vozidlo čaká v stave `loading` presne v bunke pod hákom (stred pevninského riadku footprintu žeriava, `CraneVM.hook`) a žeriav nad ním drží
//      kontajner v `placing` — kontajner sa spúšťa na vozidlo (`f6d-hook-lowering.png`, `f6d-hook-placed.png`);
//   2. jednotka prejde `in_crane → in_vehicle` a vozidlo s kontajnerom vyráža pod hákom preč (`f6d-hook-loaded.png`).
// Čo sa medzitým stalo, overuje počítadlo udalostí simu: žiadna vykládka cez apron (`in_crane → on_apron`), predvolený buffer 0.
// Screenshoty (gitignorované, `tests/e2e/__screenshots__`): pozri sa na ne — vozidlo je v portáli žeriava, kontajner z vozíka leží na ňom.

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 4 * 60_000 });

const SCENARIO = JSON.parse(readFileSync('data/scenarios/live_terminal.json', 'utf8')) as { commands: { atTick: number; command: Record<string, unknown> }[] };
const BUILD = SCENARIO.commands.filter((entry) => entry.atTick === 0).map((entry) => entry.command);
const PLACEMENTS = BUILD.filter((command) => command['type'] !== 'BuyVehicle');
const PURCHASES = BUILD.filter((command) => command['type'] === 'BuyVehicle');

/** Žeriav na root kotvisku (43, 14 · 2 × 3), bunka pod hákom (43,5; 16,5): výrez s cestou pod kotviskom a lodou nad ním. */
const HOOK_VIEW = { x: 43.5, y: 15, zoom: 2.4 } as const;

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined && window.__sim.advance !== undefined);
  return errors;
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

/**
 * Posúva hru po `step` tickoch, kým `condition()` (vyhodnotená v stránke po každom kroku) neplatí; pri zhode hru pozastaví, aby screenshot videl presne
 * ten stav. Podmienka je funkcia z tohto súboru (stránke sa pošle jej zdrojový text), preto nesmie používať premenné zvonku.
 */
async function advanceUntil(page: Page, condition: () => boolean, maxTicks = 120_000): Promise<void> {
  const runner = new Function(
    'args',
    `const sim = window.__sim;
     const condition = ${condition.toString()};
     if (args.limit === null) args.limit = sim.world.clock.tick + args.maxTicks;
     if (sim.world.clock.speed === 0) sim.world.clock.setSpeed(1);
     for (let i = 0; i < args.batch; i += 1) {
       if (condition()) { sim.world.clock.setSpeed(0); return true; }
       if (sim.world.clock.tick > args.limit) throw new Error('advanceUntil: strop ' + args.maxTicks + ' tickov bez splnenia podmienky');
       sim.advance(args.step);
     }
     return false;`,
  ) as (args: { step: number; maxTicks: number; batch: number; limit: number | null }) => boolean;
  await page.waitForFunction(runner, { step: 1, maxTicks, batch: 200, limit: null }, { polling: 'raf', timeout: 3 * 60_000 });
}

test.describe('F6d: žeriav spúšťa kontajner priamo na vozidlo pod hákom (T6D-02)', () => {
  test('vozidlo stojí pod žeriavom v bunke pod hákom, kontajner sa naň spúšťa z vozíka a vozidlo s ním odíde; apron sa pri vykládke nepoužije', async ({ page }) => {
    const errors = await openGame(page);
    await page.evaluate(() => {
      const tally: Record<string, number> = {};
      (window as unknown as { __tally: Record<string, number> }).__tally = tally;
      window.__sim!.bridge.onEvents((events) => {
        for (const event of events) {
          const key = event.type === 'CargoMoved' ? `CargoMoved ${event.from.kind}>${event.to.kind}` : event.type;
          tally[key] = (tally[key] ?? 0) + 1;
        }
      });
    });
    for (const command of PLACEMENTS) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    for (const command of PURCHASES) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(PURCHASES.length);

    // import kontajnerov (prvá prijateľná ponuka s dostatočným objemom) → loď privezie jednotky a žeriav ich vykladá
    const offerId = await page.evaluate(() => {
      const offers = window
        .__sim!.bridge.snapshot()
        .contracts.filter((card) => card.kind === 'import' && card.state === 'offered' && card.cargoCategory === 'container' && card.disabledReason === undefined)
        .sort((a, b) => b.volumeUnits - a.volumeUnits);
      return offers[0]?.id ?? null;
    });
    expect(offerId, 'v poole je prijateľná importná ponuka kontajnerov').not.toBeNull();
    expect(await dispatch(page, { type: 'AcceptContract', contractId: offerId })).toMatchObject({ ok: true });
    await dismissToasts(page);
    await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [HOOK_VIEW.x, HOOK_VIEW.y, HOOK_VIEW.zoom] as const);

    // 1) kontajner sa spúšťa na vozidlo: vozidlo `loading` presne v bunke pod hákom, žeriav v `placing` s kontajnerom v polovici spúšťania
    await advanceUntil(page, () => {
      const { cranes, vehicles = [] } = window.__sim!.entities();
      const crane = cranes[0];
      if (crane === undefined || crane.hook === undefined || crane.state !== 'placing' || crane.holding === null || crane.progress < 0.6 || crane.progress > 0.75) return false;
      const { x, y } = crane.hook;
      return vehicles.some((vehicle) => vehicle.state === 'loading' && !vehicle.loaded && Math.abs(vehicle.x - x) < 0.01 && Math.abs(vehicle.y - y) < 0.01);
    });
    await dismissToasts(page);
    await page.mouse.move(0, 0);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/f6d-hook-lowering.png` });
    const lowering = await page.evaluate(() => {
      const { cranes, vehicles = [] } = window.__sim!.entities();
      return { crane: cranes[0], vehicle: vehicles.find((candidate) => candidate.state === 'loading') };
    });
    // vozidlo stojí v bunke pod hákom (cez VM; sim ho tam vedie ako carrier v strede bunky) a žeriav ho obsluhuje
    expect(lowering.crane?.hook).toEqual({ x: 43.5, y: 16.5 });
    expect(lowering.vehicle).toMatchObject({ x: 43.5, y: 16.5, loaded: false });

    // 2) kontajner je na vozidle: žeriav čaká na koniec fázy (alebo ju práve dokončil), vozidlo je pod ním
    await advanceUntil(page, () => {
      const { cranes, vehicles = [] } = window.__sim!.entities();
      const crane = cranes[0];
      if (crane === undefined || crane.hook === undefined || crane.state !== 'placing' || crane.holding === null || crane.progress < 0.8) return false;
      const { x, y } = crane.hook;
      return vehicles.some((vehicle) => vehicle.state === 'loading' && Math.abs(vehicle.x - x) < 0.01 && Math.abs(vehicle.y - y) < 0.01);
    });
    await page.mouse.move(0, 0);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/f6d-hook-placed.png` });

    // 3) odovzdanie: `in_crane → in_vehicle`, vozidlo s kontajnerom vyráža (`to_dropoff`) a žeriav je bez nákladu
    await advanceUntil(page, () => {
      const { vehicles = [] } = window.__sim!.entities();
      return vehicles.some((vehicle) => vehicle.state === 'to_dropoff' && vehicle.loaded);
    });
    await page.mouse.move(0, 0);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/f6d-hook-loaded.png` });

    // ďalej vykladá aj druhá jednotka: do konca prvých ~10 jednotiek ide každá odovzdanie priamo vozidlu, nikdy cez apron
    await advanceUntil(page, () => ((window as unknown as { __tally: Record<string, number> }).__tally['CargoMoved in_crane>in_vehicle'] ?? 0) >= 10);
    const tally = await page.evaluate(() => ({ ...(window as unknown as { __tally: Record<string, number> }).__tally }));
    expect(tally['CargoMoved in_crane>in_vehicle']).toBeGreaterThanOrEqual(10);
    expect(tally['CargoMoved in_crane>on_apron'] ?? 0).toBe(0);
    expect(errors).toEqual([]);
  });
});
