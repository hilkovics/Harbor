import { expect, test, type Locator, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';
import { formatMoney, formatMoneyDelta } from '../../src/ui/format';

// F6a e2e (T6A-10): export booking z pohľadu hráča — nová hra → minimálny prístav pre export → prijatie roundtripu v paneli
// Kontrakty → export prichádza kamiónmi, uloží sa do skladov → loď prinesie import, žeriav ho vykladá a súčasne nakladá export
// (dual cycle, odovzdávanie pod hákom, ADR-033) → lashing → odchod lode → booking `completed` a výplata.
//
// Prístav (rovnaké rozloženie ako `export_roundtrip`, f5-vertical-slice): cesty, depo (id 3) s tromi vozidlami, dva dvory (4, 5),
// brána (6), stojisko (7) a rampa (8) idú cez `dispatchJSON`. Čas sa posúva cez `window.__sim.advance` v krokoch (`advanceUntil`):
// kontrakt dostane loď až o ~2,2 herného dňa a pri 8× by to trvalo minúty. Podmienka sa vyhodnocuje po každom kroku priamo
// v stránke a pri zhode sa hra pozastaví, takže screenshot ukazuje presne overený stav. Čo sa medzitým stalo, overuje počítadlo
// udalostí simu (`__tally`), nie vzorkovanie stavov — kroky `advance` môžu krátke stavy preskočiť.
//
// Časovanie sa medzi behmi mierne líši (kontrakt sa prijíma klikom v reálnom čase), preto spec nespolieha na konkrétne id, objemy
// ani na náhodné súbehy: číta ich z prijatej voyage a podmienky screenshotov majú záložnú vetvu.
// Booking ponuky vznikajú až pri uzávierke prvého herného dňa (ADR-032), takže prvá hra čaká na `DayClosed`.
//
// Screenshoty: `f6a-export-arrivals.png` (naložený kamión vo fronte brány / vykladajúci export na rampe), `f6a-export-loading.png`
// (nakladanie: náklad na palube import / export), `f6a-export-lashing.png` (odznak lashingu na lodi + inšpektor kotviska),
// `f6a-export-done.png` (loď odplávala, booking splnený: toasty, panel Kontrakty), `f6a-export-payout.png` (celá voyage splnená
// v História, výplata).

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 4 * 60_000 });

const DEPOT_ID = 3;
const RAMP_ID = 8;
const VEHICLES = 3;

type Cell = { readonly x: number; readonly y: number };

/** Cesty F3 + pozemnej časti F4 po úsekoch `[x0, y0, x1, y1]` (rovnaké ako `export_roundtrip.json`). */
const ROAD_SEGMENTS: readonly (readonly [number, number, number, number])[] = [
  [41, 18, 41, 22],
  [46, 18, 46, 22],
  [42, 22, 45, 22],
  [44, 23, 44, 30],
  [45, 30, 50, 30],
  [44, 33, 44, 33],
  [47, 33, 48, 33],
  [53, 31, 53, 33],
  [51, 30, 55, 30],
];

/** Moduly v poradí stavby (id 2 = žeriav Root berthu, preto depo dostane id 3). */
const MODULES: readonly { readonly defId: string; readonly x: number; readonly y: number; readonly rotation: number }[] = [
  { defId: 'vehicle_depot', x: 46, y: 27, rotation: 0 },
  { defId: 'container_yard_small', x: 42, y: 18, rotation: 0 },
  { defId: 'container_yard_small', x: 49, y: 26, rotation: 0 },
  { defId: 'truck_gate', x: 45, y: 32, rotation: 270 },
  { defId: 'truck_waiting_area', x: 49, y: 31, rotation: 0 },
  { defId: 'loading_ramp_container', x: 53, y: 28, rotation: 0 },
];

/** Pohľad na celý prístav pri stavbe: zoom 0,5 (bunka 32 px). */
const OVERVIEW = { x: 47, y: 25, zoom: 0.5 } as const;
/** Pozemná časť exportu (brána 45–46 × 32–33, stojisko, rampa 53–56 × 28–29): zoom 1, mapa medzi pásom HUD a BuildBarom. */
const LANDSIDE_VIEW = { x: 49.5, y: 31, zoom: 1 } as const;
/** Root berth s apronom a vozidlami pod hákom: loď nad nábrežím (y ≤ 13), apron a okruh ciest pod ním. */
const BERTH_VIEW = { x: 44, y: 14.3, zoom: 1 } as const;

function segmentCells([x0, y0, x1, y1]: readonly [number, number, number, number]): Cell[] {
  const cells: Cell[] = [];
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  for (let x = x0, y = y0; ; x += dx, y += dy) {
    cells.push({ x, y });
    if (x === x1 && y === y1) return cells;
  }
}

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(
    () =>
      window.__sim?.rendered !== undefined &&
      window.__sim.dispatchJSON !== undefined &&
      window.__sim.centerOn !== undefined &&
      window.__sim.cellToScreen !== undefined &&
      window.__sim.advance !== undefined,
  );
  return errors;
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta a UI. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function view(page: Page, v: { readonly x: number; readonly y: number; readonly zoom: number }): Promise<void> {
  await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [v.x, v.y, v.zoom] as const);
  await settle(page);
}

/** Myš do rohu stránky (žiadny ghost ani hover tooltip), potom počkať na prekreslenie. */
async function parkMouse(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await settle(page);
}

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

/**
 * Posúva hru cez `window.__sim.advance` po `step` tickoch, kým `condition(arg)` (vyhodnotená v stránke po každom kroku) neplatí;
 * pri zhode hru pozastaví (`clock.setSpeed(0)`), aby ďalšie kontroly a screenshot videli presne ten stav. Beží v dávkach po
 * `BATCH_TICKS` tickoch na jedno vyhodnotenie `waitForFunction`, aby stránka medzitým vykresľovala. Strop `maxTicks` zachytí zaseknutý tok.
 */
/** Tickov na jedno vyhodnotenie `waitForFunction` (medzi nimi stránka vykresľuje): dávka krokov = `BATCH_TICKS / step`. */
const BATCH_TICKS = 400;
/** Argument podmienky: číslo, zoznam čísel, alebo `null` (serializuje sa do stránky). */
type ConditionArg = number | readonly number[] | null;
interface AdvanceArgs {
  readonly arg: ConditionArg;
  readonly step: number;
  readonly maxTicks: number;
  readonly batch: number;
  limit: number | null;
}
async function advanceUntil<T extends ConditionArg>(page: Page, condition: (arg: T) => boolean, arg: T, options: { readonly step?: number; readonly maxTicks?: number } = {}): Promise<void> {
  const { step = 10, maxTicks = 80_000 } = options;
  // Podmienka je funkcia z tohto súboru; stránke sa pošle jej zdrojový text (ako pri `waitForFunction`), preto nesmie používať premenné zvonku.
  const runner = new Function(
    'args',
    `const sim = window.__sim;
     const condition = ${condition.toString()};
     if (args.limit === null) args.limit = sim.world.clock.tick + args.maxTicks;
     if (sim.world.clock.speed === 0) sim.world.clock.setSpeed(1);
     for (let i = 0; i < args.batch; i += 1) {
       if (condition(args.arg)) { sim.world.clock.setSpeed(0); return true; }
       if (sim.world.clock.tick > args.limit) throw new Error('advanceUntil: strop ' + args.maxTicks + ' tickov bez splnenia podmienky');
       sim.advance(args.step);
     }
     return false;`,
  ) as (args: AdvanceArgs) => boolean;
  await page.waitForFunction(runner, { arg, step, maxTicks, batch: Math.ceil(BATCH_TICKS / step), limit: null }, { polling: 'raf', timeout: 3 * 60_000 });
}

const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'Kontrakty' });
const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Inšpektor modulu' });
const toasts = (page: Page): Locator => page.locator('.toasts .toast');

/** Klik na bunku, ktorý vyberie modul: zavrie toasty, hover + prekreslenie a až potom klik; inšpektor sa musí ukázať hneď (bez opakovania, pozri `dismissToasts`). */
async function selectModuleAt(page: Page, cell: Cell): Promise<void> {
  await dismissToasts(page);
  const point = await page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [cell.x, cell.y] as const);
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await page.mouse.click(point.x, point.y);
  await expect(inspector(page)).toBeVisible();
}

/** Export jednotky podľa polohy v ledgeri (`in_truck`, `at_ramp`, `in_storage`, `in_vehicle`, `on_ship`, …) — a počet živých jednotiek exportu. */
const exportByLocation = (page: Page) =>
  page.evaluate(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const unit of window.__sim!.world.cargo.liveUnits()) {
      if (unit.direction !== 'export') continue;
      total += 1;
      counts[unit.location.kind] = (counts[unit.location.kind] ?? 0) + 1;
    }
    return { total, counts };
  });

interface Voyage {
  readonly importId: number;
  readonly exportId: number;
  readonly voyageId: number;
  readonly importUnits: number;
  readonly bookedUnits: number;
  readonly importReward: number;
  readonly exportReward: number;
  readonly destination: string;
}

test.describe('F6a: export booking → kamióny → sklad → nakládka → lashing → odchod → výplata (T6A-10)', () => {
  test('roundtrip prijatý v UI: export príde kamiónmi, loď ho naloží, prejde lashingom a odpláva; booking completed, nič sa nestratilo', async ({ page }) => {
    const errors = await openGame(page);
    // počítadlo udalostí simu v stránke (typ → počet): spec ním overí, čo sa naozaj stalo, aj keď to trvá kratšie než krok `advance`
    await page.evaluate(() => {
      const tally: Record<string, number> = {};
      (window as unknown as { __tally: Record<string, number> }).__tally = tally;
      window.__sim!.bridge.onEvents((events) => {
        for (const event of events) tally[event.type] = (tally[event.type] ?? 0) + 1;
      });
    });
    await view(page, OVERVIEW);

    // 1) minimálny prístav pre export cez dispatchJSON: cesty, depo, dva dvory, brána, stojisko, rampa a tri vozidlá
    for (const segment of ROAD_SEGMENTS) expect(await dispatch(page, { type: 'PlaceRoad', cells: segmentCells(segment) })).toMatchObject({ ok: true });
    // R1 (ADR-037): obojsmerný úsek (44, 34–36) k bráne a bez (45, 34–35), ako v scenári `full_import_chain` (jednosmerná slučka verejnej cesty)
    expect(await dispatch(page, { type: 'PlaceRoad', kind: 'two_lane', cells: [{ x: 44, y: 34 }, { x: 44, y: 35 }, { x: 44, y: 36 }] })).toMatchObject({ ok: true });
    expect(await dispatch(page, { type: 'RemoveRoad', cells: [{ x: 45, y: 34 }, { x: 45, y: 35 }] })).toMatchObject({ ok: true });
    await page.waitForFunction(() => window.__sim!.world.grid.at(44, 36).roadKind === 'two_lane' && window.__sim!.world.grid.at(45, 34).road !== 'road' && window.__sim!.world.grid.at(45, 35).road !== 'road');
    for (const module of MODULES) expect(await dispatch(page, { type: 'PlaceModule', ...module })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().modules.length)).toBe(1 + MODULES.length);
    expect(await page.evaluate((id) => window.__sim!.entities().modules.find((module) => module.id === id)?.defId, DEPOT_ID)).toBe('vehicle_depot');
    for (let bought = 1; bought <= VEHICLES; bought += 1) {
      expect(await dispatch(page, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID })).toMatchObject({ ok: true });
    }
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(VEHICLES);
    const port = await page.evaluate((rampId) => {
      const { modules } = window.__sim!.entities();
      return { connected: modules.filter((module) => module.connected !== undefined).every((module) => module.connected === true), ramp: modules.find((module) => module.id === rampId)?.ramp };
    }, RAMP_ID);
    expect(port.connected).toBe(true);
    expect(port.ramp).toMatchObject({ docks: 2, operational: true });
    // žiadna loď ani booking v hre; export ponuky vznikajú až pri uzávierke dňa
    expect(await page.evaluate(() => window.__sim!.entities().ships.length)).toBe(0);
    expect(await page.evaluate(() => [...window.__sim!.world.contracts.values()].some((contract) => contract.kind === 'export'))).toBe(false);

    // 2) uzávierka prvého dňa prinesie booking ponuky (roundtrip / export); hra sa pozastaví a panel Kontrakty ich ukáže
    await advanceUntil(page, () => [...window.__sim!.world.contracts.values()].some((contract) => contract.kind === 'export' && contract.state === 'offered'), null);
    await dismissToasts(page);
    await page.locator('[data-field="panel-contracts"]').click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: /Ponuky/ })).toHaveAttribute('aria-selected', 'true');

    const card = panel(page).locator('article.contract-card[data-kind="roundtrip"]').first();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-field="cargo"]')).toHaveText('Import + export · Kontajnery');
    await expect(card.locator('section.contract-card__part')).toHaveCount(2);
    await expect(card.locator('[data-field="import-title"]')).toHaveText('Import');
    await expect(card.locator('[data-field="export-title"]')).toContainText('Export → ');
    await expect(card.locator('[data-field="export-cutoff"]')).toContainText('Cut-off');
    await expect(card.locator('[data-action="accept"]')).toHaveText('Prijať oba');
    const voyageId = Number(await card.getAttribute('data-voyage-id'));
    const voyage: Voyage = await page.evaluate((id) => {
      const contracts = [...window.__sim!.world.contracts.values()].filter((contract) => contract.voyageId === id);
      const imported = contracts.find((contract) => contract.kind === 'import')!;
      const exported = contracts.find((contract) => contract.kind === 'export')!;
      return {
        importId: imported.id,
        exportId: exported.id,
        voyageId: id,
        importUnits: imported.volumeUnits,
        bookedUnits: exported.volumeUnits,
        importReward: imported.rewardCents,
        exportReward: exported.rewardCents,
        destination: exported.booking!.destinationPort,
      };
    }, voyageId);
    expect(voyage.bookedUnits).toBeGreaterThan(0);
    await expect(card.locator('[data-field="export-title"]')).toHaveText(`Export → ${voyage.destination}`);

    // 3) „Prijať oba“: oba kontrakty voyage prijaté, toast, karta prejde do Aktívnych s plánom príchodov a cut-off
    await card.locator('[data-action="accept"]').click();
    await expect(toasts(page).filter({ hasText: 'Kontrakt prijatý' })).toHaveCount(1);
    await expect(panel(page).getByRole('tab', { name: /Aktívne/ })).toHaveText('Aktívne · 1');
    const accepted = await page.evaluate(
      ([importId, exportId]) => {
        const imported = window.__sim!.world.contracts.get(importId as never)!;
        const exported = window.__sim!.world.contracts.get(exportId as never)!;
        return {
          states: [imported.state, exported.state],
          plan: exported.booking!.arrivalPlan.length,
          cutoff: exported.booking!.cutoffTick ?? null,
          shipArrival: exported.shipArrivalTick ?? null,
          tick: window.__sim!.world.clock.tick,
        };
      },
      [voyage.importId, voyage.exportId] as const,
    );
    expect(accepted.states).toEqual(['accepted', 'accepted']);
    expect(accepted.plan).toBe(voyage.bookedUnits); // jeden plánovaný príchod kamióna na každú bookovanú jednotku
    expect(accepted.cutoff).not.toBeNull();
    expect(accepted.cutoff!).toBeLessThan(accepted.shipArrival!);
    await panel(page).getByRole('tab', { name: /Aktívne/ }).click();
    const active = panel(page).locator(`article.contract-card[data-voyage-id="${String(voyage.voyageId)}"]`);
    await expect(active).toHaveAttribute('data-tab', 'active');
    await expect(active.locator('[data-field="export-pending"]')).toContainText(`Ešte príde ${String(voyage.bookedUnits)}`);
    await expect(active.locator('[data-field="export-arrived-value"]')).toContainText(`0 / ${String(voyage.bookedUnits)}`);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);

    // 4) príchod exportu: kamióny prichádzajú naložené; ideálne naraz kamión vo fronte brány a kamión vykladajúci na rampe. Časovanie
    //    príchodov závisí od ticku prijatia (klik v reálnom čase), preto ak sa tá náhoda nepodarí, stačí naložený kamión po 12 príchodoch.
    await view(page, LANDSIDE_VIEW);
    await advanceUntil(
      page,
      () => {
        const { trucks } = window.__sim!.entities();
        const arrived = (window as unknown as { __tally: Record<string, number> }).__tally['ExportArrived'] ?? 0;
        const both = trucks.some((truck) => truck.state === 'unloading' && truck.loaded) && trucks.some((truck) => truck.state === 'gate_queue' && truck.loaded);
        return both || (arrived >= 12 && trucks.some((truck) => truck.loaded));
      },
      null,
      { step: 3 },
    );
    await dismissToasts(page); // toasty (autosave, nové ponuky) by zakrývali spodok mapy
    await view(page, LANDSIDE_VIEW);
    const arriving = await page.evaluate(() => ({
      entities: window.__sim!.entities(),
      rendered: window.__sim!.rendered!(),
      exports: [...window.__sim!.world.contracts.values()]
        .filter((contract) => contract.kind === 'export' && contract.state !== 'offered')
        .map((contract) => ({ state: contract.state, arrived: contract.booking!.arrivedUnits })),
    }));
    expect(arriving.entities.trucks.length).toBeGreaterThanOrEqual(1);
    expect(arriving.entities.trucks.some((truck) => truck.loaded)).toBe(true); // exportný kamión prichádza naložený
    expect(arriving.rendered.trucks).toBe(arriving.entities.trucks.length);
    expect(arriving.entities.trucks.every((truck) => truck.state !== 'no_path')).toBe(true);
    expect(arriving.exports).toHaveLength(1);
    expect(arriving.exports[0]).toMatchObject({ state: 'accepted' }); // loď ešte nie je na ceste, export sa zbiera v prístave
    expect(arriving.exports[0]!.arrived).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => window.__sim!.entities().ships.length)).toBe(0);
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6a-export-arrivals.png`, fullPage: true });

    // 5) všetok export dorazil (posledný kamión je vyložený): nič nie je v kamióne, nič nezmizlo, jednotky ležia na rampe / v sklade
    await advanceUntil(
      page,
      (booked: number) =>
        window.__sim!.world.cargo.countByKind('in_truck') === 0 &&
        [...window.__sim!.world.contracts.values()].some((contract) => contract.kind === 'export' && contract.state !== 'offered' && contract.booking!.arrivedUnits >= booked),
      voyage.bookedUnits,
    );
    const arrived = await exportByLocation(page);
    expect(arrived.total).toBe(voyage.bookedUnits);
    expect(arrived.counts['in_truck'] ?? 0).toBe(0);
    expect((arrived.counts['in_storage'] ?? 0) + (arrived.counts['at_ramp'] ?? 0) + (arrived.counts['in_vehicle'] ?? 0)).toBe(voyage.bookedUnits);

    // 6) loď doplávala: všetok export je v sklade (vozidlá ho z rampy odviezli), nič sa ešte nenaložilo
    await advanceUntil(page, () => window.__sim!.entities().ships.length === 1, null);
    expect(await exportByLocation(page)).toEqual({ total: voyage.bookedUnits, counts: { in_storage: voyage.bookedUnits } });
    expect(await page.evaluate((ids) => ids.map((id) => window.__sim!.world.contracts.get(id as never)!.state), [voyage.importId, voyage.exportId])).toEqual(['ship_en_route', 'ship_en_route']);

    // 7) nakladanie: loď zakotvila, žeriav vykladá import a nakladá export z vozidiel pod hákom; na palube sú import aj export
    //    (náklad na palube rozlíšený farbou), pri kotvisku je vozidlo
    await advanceUntil(
      page,
      () => {
        const { ships, cranes, vehicles } = window.__sim!.entities();
        const ship = ships[0];
        const atBerth = (vehicles ?? []).some((vehicle) => vehicle.y <= 18.5 && vehicle.x >= 39 && vehicle.x <= 48);
        const { import: imported = 0, export: exported = 0 } = ship?.cargoSplit ?? {};
        // ideálne zmiešaná paluba (import aj export); dual cykly sú v pod-hákovom režime vzácne, preto aj paluba s exportom po vykládke importu
        const mixed = imported >= 6 && exported >= 5;
        const exportOnly = imported === 0 && exported >= 10;
        return ship?.state === 'docked' && cranes[0]?.state !== 'idle' && atBerth && (mixed || exportOnly);
      },
      null,
    );
    await dismissToasts(page);
    await view(page, BERTH_VIEW);
    const loading = await page.evaluate(() => {
      const { ships, cranes, vehicles } = window.__sim!.entities();
      return { ship: ships[0]!, crane: cranes[0]!, vehicles: vehicles ?? [], rendered: window.__sim!.rendered!() };
    });
    expect(loading.ship.state).toBe('docked');
    expect(loading.ship.cargoSplit!.export).toBeGreaterThan(0);
    expect(loading.ship.unitsOnBoard).toBe(loading.ship.cargoSplit!.import + loading.ship.cargoSplit!.export);
    expect(loading.ship).not.toHaveProperty('lashing');
    expect(loading.rendered).toMatchObject({ ships: 1, cranes: 1, vehicles: VEHICLES });
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6a-export-loading.png`, fullPage: true });

    // 8) lashing po poslednej naloženej jednotke: na palube len export, odznak lashingu na lodi aj v inšpektore kotviska
    await advanceUntil(page, () => window.__sim!.entities().ships[0]?.state === 'lashing', null);
    await dismissToasts(page);
    await view(page, BERTH_VIEW);
    const lashing = await page.evaluate(
      ([importId, exportId]) => ({
        ship: window.__sim!.entities().ships[0]!,
        crane: window.__sim!.entities().cranes[0]!,
        states: [importId, exportId].map((id) => window.__sim!.world.contracts.get(id as never)!.state),
        loaded: window.__sim!.world.contracts.get(exportId as never)!.booking!.loadedUnits,
      }),
      [voyage.importId, voyage.exportId] as const,
    );
    expect(lashing.ship.cargoSplit).toEqual({ import: 0, export: lashing.loaded });
    expect(lashing.loaded).toBeGreaterThan(0);
    expect(lashing.ship.lashing!.ticksTotal).toBeGreaterThan(0);
    expect(lashing.ship.lashing!.ticksLeft).toBeLessThanOrEqual(lashing.ship.lashing!.ticksTotal);
    expect(lashing.crane.state).toBe('idle');
    expect(lashing.states).toEqual(['exporting', 'exporting']);
    await selectModuleAt(page, { x: 41, y: 15 }); // kotvisko (žeriav stojí na x 43–44)
    await expect(inspector(page).locator('[data-field="title"]')).toHaveText('Kotvisko');
    await expect(inspector(page).locator('[data-field="badge"]')).toHaveText('Loď lashuje');
    await expect(inspector(page).locator('[data-section="lashing"]')).toBeVisible();
    await expect(inspector(page).locator('[data-field="lashing-text"]')).toContainText('Lashing a papiere · zostáva');
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6a-export-lashing.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);

    // 9) odchod lode s exportom: booking `completed`, toasty „Loď odplávala s exportom“ a výplata, História ukáže splnený export
    await advanceUntil(
      page,
      (exportId: number) => window.__sim!.world.contracts.get(exportId as never)!.state === 'completed' && ((window as unknown as { __tally: Record<string, number> }).__tally['ExportShipped'] ?? 0) >= 1,
      voyage.exportId,
    );
    const shipped = await page.evaluate(
      ([importId, exportId]) => ({
        states: [importId, exportId].map((id) => window.__sim!.world.contracts.get(id as never)!.state),
        shipped: window.__sim!.world.cargo.shippedCount,
        loaded: window.__sim!.world.contracts.get(exportId as never)!.booking!.loadedUnits,
        ships: window.__sim!.entities().ships.length,
      }),
      [voyage.importId, voyage.exportId] as const,
    );
    expect(shipped).toMatchObject({ ships: 0 });
    expect(shipped.states[1]).toBe('completed');
    expect(shipped.shipped).toBe(shipped.loaded);
    await expect(toasts(page).filter({ hasText: 'Loď odplávala s exportom' })).toHaveCount(1);
    await expect(toasts(page).filter({ hasText: 'Loď odplávala s exportom' })).toContainText(`${String(shipped.loaded)} TEU → ${voyage.destination}`);
    await expect(toasts(page).filter({ hasText: 'Kontrakt splnený' }).first()).toContainText(`Export ${String(voyage.bookedUnits)} TEU → ${voyage.destination}`);
    // karta voyage ostáva v Aktívnych, kým sa nedovezie aj import (kamiónmi von z mapy): export časť je už splnená a vyplatená
    await page.locator('[data-field="panel-contracts"]').click();
    await panel(page).getByRole('tab', { name: /Aktívne/ }).click();
    const voyageCard = panel(page).locator(`article.contract-card[data-voyage-id="${String(voyage.voyageId)}"]`);
    await expect(voyageCard).toHaveAttribute('data-tab', 'active');
    await expect(voyageCard.locator('[data-part="export"]')).toHaveAttribute('data-state', 'completed');
    await expect(voyageCard.locator('[data-part="import"]')).toHaveAttribute('data-state', 'exporting');
    await expect(voyageCard.locator('[data-field="export-loaded-summary"]')).toHaveText(`Naložené ${String(shipped.loaded)} / ${String(voyage.bookedUnits)} TEU`);
    await expect(voyageCard.locator('[data-field="export-reward"]')).toHaveText(formatMoneyDelta(voyage.exportReward));
    await view(page, BERTH_VIEW);
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6a-export-done.png`, fullPage: true });

    // 10) import roundtripu sa dovezie kamiónmi von z mapy: obe časti `completed`, výplata práve raz za každú, nič sa nestratilo
    await page.keyboard.press('Escape');
    await advanceUntil(page, (voyageIds: readonly number[]) => voyageIds.every((id) => window.__sim!.world.contracts.get(id as never)!.state === 'completed'), [voyage.importId, voyage.exportId]);
    const end = await page.evaluate(() => {
      const { world } = window.__sim!;
      world.cargo.assertConservation(); // každá jednotka má presne jednu polohu a počty sedia
      const { cargo } = world;
      return {
        created: cargo.createdCount,
        exported: cargo.exportedCount,
        shipped: cargo.shippedCount,
        live: cargo.liveCount,
        onMap: ['on_ship', 'in_crane', 'on_apron', 'in_vehicle', 'in_storage', 'at_ramp', 'in_truck'].reduce((sum, kind) => sum + cargo.countByKind(kind as never), 0),
        cash: world.cashCents,
        xp: world.xp,
        revenue: world.economy.entries.filter((entry) => entry.category === 'contract_revenue').map((entry) => entry.amountCents),
        ships: window.__sim!.entities().ships.length,
        trucks: window.__sim!.entities().trucks.length,
        crane: window.__sim!.entities().cranes[0]!.state,
        tally: (window as unknown as { __tally: Record<string, number> }).__tally,
        voyage: [...world.contracts.values()].filter((contract) => contract.voyageId > 0 && contract.state !== 'offered' && contract.state !== 'expired').map((contract) => ({ id: contract.id, state: contract.state, penalties: contract.penaltiesCents, xp: contract.xpReward })),
      };
    });
    const rolled = end.tally['UnitRolled'] ?? 0;
    const loaded = shipped.loaded;
    // stratené jednotky = vytvorené − živé − vyvezené po súši − odplávané: 0 (vytvorené = import + bookované kamiónmi)
    expect(end.created - end.live - end.exported - end.shipped).toBe(0);
    expect(end.created).toBe(voyage.importUnits + voyage.bookedUnits);
    expect(end.shipped).toBe(loaded);
    expect(loaded + rolled).toBe(voyage.bookedUnits); // naložené + rolled (vrátené odosielateľovi) = bookované
    expect(end.exported).toBe(voyage.importUnits + rolled); // import odišiel kamiónmi, rolled export sa vrátil po súši
    expect(end).toMatchObject({ live: 0, onMap: 0, ships: 0, trucks: 0, crane: 'idle' });
    expect(end.voyage.map((contract) => contract.state)).toEqual(['completed', 'completed']);
    expect(end.voyage.every((contract) => contract.penalties === 0)).toBe(true);
    // výplata: export aj import práve raz ako `contract_revenue`, XP z oboch kontraktov
    expect([...end.revenue].sort((a, b) => a - b)).toEqual([voyage.importReward, voyage.exportReward].sort((a, b) => a - b));
    expect(end.xp).toBe(end.voyage.reduce((sum, contract) => sum + contract.xp, 0));
    expect(end.xp).toBeGreaterThan(0);
    // čo sa stalo (počítadlo udalostí): export prišiel a bol vyložený z kamiónov, naložený na loď, dual cykly, lashing, odchod
    expect(end.tally).toMatchObject({
      ExportArrived: voyage.bookedUnits,
      TruckUnloaded: voyage.bookedUnits,
      UnitLoaded: loaded,
      CraneCycleDone: voyage.importUnits,
      ShipDocked: 1,
      ShipLashingStarted: 1,
      ExportShipped: 1,
      ShipDeparted: 1,
      CutoffPassed: 1,
      ContractCompleted: 2,
    });
    expect(end.tally['DualCycle']).toBeGreaterThanOrEqual(1);
    expect(end.tally['VgmHoldReleased'] ?? 0).toBe(end.tally['VgmHoldStarted'] ?? 0);
    expect(end.tally['ContractFailed'] ?? 0).toBe(0);
    // HUD = svet; panel História ukáže celú voyage ako splnenú
    await expect(page.locator('[data-field="cash"]')).toHaveText(formatMoney(end.cash));
    await expect(page.locator('[data-field="xp"]')).toHaveText(`${String(end.xp)} XP`);
    await page.locator('[data-field="panel-contracts"]').click();
    await panel(page).getByRole('tab', { name: /História/ }).click();
    const history = panel(page).locator(`article.contract-card[data-voyage-id="${String(voyage.voyageId)}"]`);
    await expect(history).toHaveAttribute('data-tab', 'history');
    await expect(history.locator('[data-part="import"]')).toHaveAttribute('data-state', 'completed');
    await expect(history.locator('[data-part="export"]')).toHaveAttribute('data-state', 'completed');
    await expect(history.locator('[data-field="export-loaded-summary"]')).toHaveText(`Naložené ${String(loaded)} / ${String(voyage.bookedUnits)} TEU`);
    await expect(history.locator('[data-field="reward"]')).toHaveText(formatMoneyDelta(voyage.importReward + voyage.exportReward));
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6a-export-payout.png`, fullPage: true });

    // sim v DEV hlási porušenie konzervácie do konzoly (každý tick) — nesmie byť žiadna chyba ani výnimka
    expect(errors).toEqual([]);
  });
});
