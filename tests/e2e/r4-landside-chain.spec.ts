import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatMoney } from '../../src/ui/format';
import { scenarioLayout } from './layout';

// R4 e2e (TR4-05, nahrádza F4 „loď → rampa → kamión“): celý reťazec pozemnej časti z pohľadu hráča — loď → apron → vozidlá → dvor → kamión na TP dvora → výstupný pruh → export.
// Rozloženie (jednosmerný okruh, vstupný a výstupný pruh brány, depo, dva dvory) ide cez `dispatchJSON` zo scenára `full_import_chain` (`layout.ts`); BuildBar Landside ponúka len
// pruhy brány, predbránovú plochu a odstavnú plochu (rampa, stojisko a `truck_gate` zanikli, ADR-041). Potom DEV loď s 24 TEU (`SpawnShipDebug`) a na stav sa čaká cez
// `window.__sim` (polling v rAF stránky), nie pevnými timeoutmi:
//   1) kamión vo fronte vstupného pruhu a ďalší už na TP dvora (alebo aspoň jeden z nich po 12 exportoch) → screenshot `r4-chain-gate.png`,
//   2) všetkých 24 jednotiek je `exported`, na mape nie je žiadny kamión → screenshot `r4-chain-exported.png`.
// Moduly majú id v poradí stavby: Root berth 1, žeriav 2, depo 3, dvory 4 a 5, vstupný pruh 6, výstupný pruh 7.

const WAIT_LIMIT_MS = 60_000;
test.describe.configure({ timeout: 5 * WAIT_LIMIT_MS });

const LAYOUT = scenarioLayout('full_import_chain');
const GATE_IN_ID = 6;
const GATE_OUT_ID = 7;
/** Scenár nesie aj DEV loď s 120 TEU; test si spawnuje vlastnú s 24 TEU: každá jednotka = jeden kamión. */
const UNITS = 24;
/** Po toľkých exportoch sa screenshot fronty zoberie aj bez súbehu kamióna vo fronte a na TP. */
const FALLBACK_EXPORTED = 12;

/** Pohľad na celé rozloženie pri stavbe: zoom 0,5 (bunka 32 px), stred posunutý o pás HUD a BuildBaru. */
const OVERVIEW = { x: 47, y: 28, zoom: 0.5 } as const;
/** Pohľad na pozemnú časť (oba screenshoty): zoom 0,75 (bunka 48 px), pruhy brány (44–45 × 30–33), dvory a okruh nad nimi. */
const LANDSIDE_VIEW = { x: 45.5, y: 28, zoom: 0.75 } as const;

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(
    () => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined && window.__sim.cellToScreen !== undefined,
  );
  return errors;
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta a UI. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Myš do rohu stránky (mimo mapy aj UI prvkov: žiadny ghost ani hover tooltip), potom počkať na prekreslenie. */
async function parkMouse(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await settle(page);
}

/** Kliknutie na tlačidlo rýchlosti v HUD (skutočný klik myšou, nie zápis do simu). */
async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function view(page: Page, x: number, y: number, zoom: number): Promise<void> {
  await page.evaluate(([cx, cy, z]) => window.__sim!.centerOn!(cx, cy, z), [x, y, zoom] as const);
  await settle(page);
}

const bar = (page: Page): Locator => page.getByRole('contentinfo', { name: 'Stavba' });
const entities = (page: Page) => page.evaluate(() => window.__sim!.entities());
const rendered = (page: Page) => page.evaluate(() => window.__sim!.rendered!());
const cashCents = (page: Page) => page.evaluate(() => window.__sim!.world.cashCents);

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

const WAIT_OPTIONS = { timeout: WAIT_LIMIT_MS } as const;

test.describe('R4: loď → apron → vozidlá → dvor → kamión na TP → výstupný pruh → export (TR4-05)', () => {
  test('BuildBar bez rampy a stojiska; 24 TEU z lode → kamióny prejdú pruhmi brány, nakladajú sa na TP dvora a opustia mapu', async ({ page }) => {
    const errors = await openGame(page);
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);

    // 1) BuildBar Landside: pruhy brány, predbránová plocha a odstavná plocha; rampa, stojisko a stará brána nie sú
    await bar(page).locator('[data-category="landside"]').click();
    for (const defId of ['gate_in_lane', 'gate_out_lane', 'pre_gate_buffer', 'truck_holding']) {
      await expect(bar(page).locator(`[data-def-id="${defId}"]`)).toHaveAttribute('data-status', 'available');
    }
    for (const defId of ['truck_gate', 'truck_waiting_area', 'loading_ramp_container', 'loading_ramp_bulk']) await expect(bar(page).locator(`[data-def-id="${defId}"]`)).toHaveCount(0);

    // 2) rozloženie zo scenára: cesty, depo, dvory, pruhy brány a vozidlá
    const cashStart = await cashCents(page);
    for (const command of LAYOUT.roads) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    for (const command of LAYOUT.modules) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().modules.length)).toBe(1 + LAYOUT.modules.length);
    for (const command of LAYOUT.vehicles) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(LAYOUT.vehicles.length);
    expect(await cashCents(page)).toBeLessThan(cashStart);

    const modules = (await entities(page)).modules;
    expect(modules.find((module) => module.id === GATE_IN_ID)).toMatchObject({ defId: 'gate_in_lane', x: 44, y: 30, rotation: 0, gateLane: { kind: 'in', mode: 'standard', roofPart: 'single' } });
    expect(modules.find((module) => module.id === GATE_OUT_ID)).toMatchObject({ defId: 'gate_out_lane', x: 45, y: 30, rotation: 180, gateLane: { kind: 'out' } });
    expect(modules.filter((module) => module.connected !== undefined).every((module) => module.connected === true)).toBe(true);
    // dvory nesú TP pre kamióny (vonkajšia bunka konektora), žiadne nie je obsadené
    for (const yard of modules.filter((module) => module.defId === 'container_yard_small')) {
      expect(yard.tpCells?.length).toBeGreaterThan(0);
      expect(yard.tpCells?.every((cell) => !cell.busy)).toBe(true);
    }
    // kúpené vozidlá vznikajú zaparkované v depe a na mape sa nekreslia
    expect((await entities(page)).vehicles.filter((vehicle) => vehicle.state === 'parked')).toHaveLength(LAYOUT.vehicles.length);
    await expect.poll(async () => (await rendered(page)).vehicles).toBe(0);

    // 3) DEV loď s 24 TEU; stavy FSM, ktorými kamióny prešli (vzorka v každom rAF stránky), hra na 8×
    expect(await dispatch(page, { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: UNITS })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().ships.length)).toBe(1);
    await view(page, LANDSIDE_VIEW.x, LANDSIDE_VIEW.y, LANDSIDE_VIEW.zoom);
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { __truckStatesSeen: Set<string> }).__truckStatesSeen = seen;
      const sample = (): void => {
        for (const truck of window.__sim!.entities().trucks) seen.add(truck.state);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await setSpeed(page, 8);

    // 4) kamión vo fronte vstupného pruhu a ďalší na TP dvora naraz (hra sa v tom istom rAF zastaví), záloha po `FALLBACK_EXPORTED` exportoch
    await page.waitForFunction(
      (fallbackExported) => {
        const states: Record<string, number> = window.__sim!.rendered!().truckStates;
        const queued = (states['gate_queue'] ?? 0) > 0;
        const atTp = (states['at_edge_tp'] ?? 0) + (states['at_tp'] ?? 0) > 0;
        const hit = (queued && atTp) || (window.__sim!.world.cargo.exportedCount >= fallbackExported && (queued || atTp));
        if (hit) window.__sim!.world.clock.setSpeed(0);
        return hit;
      },
      FALLBACK_EXPORTED,
      WAIT_OPTIONS,
    );
    await view(page, LANDSIDE_VIEW.x, LANDSIDE_VIEW.y, LANDSIDE_VIEW.zoom);
    const queueing = await page.evaluate(() => ({ entities: window.__sim!.entities(), rendered: window.__sim!.rendered!() }));
    const queueStates = queueing.rendered.truckStates;
    expect((queueStates['gate_queue'] ?? 0) + (queueStates['at_edge_tp'] ?? 0) + (queueStates['at_tp'] ?? 0)).toBeGreaterThan(0);
    expect(queueing.rendered.trucks).toBe(queueing.entities.trucks.length);
    expect(queueing.entities.trucks.every((truck) => truck.state !== 'no_path')).toBe(true);
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/r4-chain-gate.png', fullPage: true });

    // 5) export: všetkých 24 jednotiek `exported`, žiadny kamión na mape
    await setSpeed(page, 8);
    await page.waitForFunction(
      (total) => {
        const done = window.__sim!.world.cargo.exportedCount === total && window.__sim!.entities().trucks.length === 0;
        if (done) window.__sim!.world.clock.setSpeed(0);
        return done;
      },
      UNITS,
      WAIT_OPTIONS,
    );
    await view(page, LANDSIDE_VIEW.x, LANDSIDE_VIEW.y, LANDSIDE_VIEW.zoom);
    const end = await page.evaluate(
      ([gateInId, gateOutId]) => {
        const { world } = window.__sim!;
        const { cargo } = world;
        cargo.assertConservation();
        const processed = (id: number) => (world.modules.get(id as never) as unknown as { readonly trucksProcessed: number }).trucksProcessed;
        return {
          created: cargo.createdCount,
          exported: cargo.exportedCount,
          live: cargo.liveCount,
          inStorage: cargo.countByKind('in_storage'),
          inVehicle: cargo.countByKind('in_vehicle'),
          onApron: cargo.countByKind('on_apron'),
          inTruck: cargo.countByKind('in_truck'),
          onShip: cargo.countByKind('on_ship'),
          processedIn: processed(gateInId!),
          processedOut: processed(gateOutId!),
          cashCents: world.cashCents,
          closedDays: world.clock.gameDay,
          entities: window.__sim!.entities(),
          rendered: window.__sim!.rendered!(),
          seen: [...(window as unknown as { __truckStatesSeen: Set<string> }).__truckStatesSeen].sort(),
        };
      },
      [GATE_IN_ID, GATE_OUT_ID] as const,
    );
    // nič sa nestratilo ani neostalo na mape: vytvorených 24, všetky exportované, ledger je prázdny
    expect(end).toMatchObject({ created: UNITS, exported: UNITS, live: 0, inStorage: 0, inVehicle: 0, onApron: 0, inTruck: 0, onShip: 0 });
    expect(end.entities.trucks).toEqual([]);
    expect(end.entities.ships).toEqual([]);
    expect(end.rendered).toMatchObject({ trucks: 0, truckStates: {} });
    // kamióny prešli celým životným cyklom: vstupný pruh (prechod = `gate_pass`), TP dvora, výstupný pruh, portál
    for (const state of ['to_gate', 'gate_queue', 'gate_pass', 'to_tp', 'at_edge_tp', 'gate_queue_out', 'to_portal']) expect(end.seen, `kamióny prešli stavom ${state}`).toContain(state);
    expect(end.seen).not.toContain('waiting');
    expect(end.seen).not.toContain('loading');
    expect(end.processedIn).toBe(UNITS);
    expect(end.processedOut).toBe(UNITS);
    // pruhy sú voľné a TP dvorov neobsadené
    expect(end.entities.modules.find((module) => module.id === GATE_IN_ID)!.gateLane?.step).toBeUndefined();
    for (const yard of end.entities.modules.filter((module) => module.defId === 'container_yard_small')) expect(yard.tpCells?.every((cell) => !cell.busy)).toBe(true);
    await expect(page.locator('[data-field="cash"]')).toHaveText(formatMoney(end.cashCents));
    await parkMouse(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/r4-chain-exported.png', fullPage: true });

    // sim v DEV hlási porušenie konzervácie do konzoly (každý tick) — nesmie byť žiadna chyba ani výnimka
    expect(errors).toEqual([]);
  });
});
