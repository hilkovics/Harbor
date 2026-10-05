import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// F6c e2e (T6C-06b, míľnik M2 „živý terminál“): nová hra → prístav s depom prázdnych, dvoma kontajnerovými dvormi a empty handlerom
// (rozloženie scenára `live_terminal`, cez `dispatchJSON`) → import prijatý v paneli Kontrakty (jeho kontajnery odídu kamiónmi a vrátia sa ako prázdne)
// → prekládka loď A → sklad → loď B prijatá v paneli Kontrakty → čas sa posúva cez `window.__sim.advance`:
//   1. loď A privezie prekládku (na palube `import`, žeriav ju vykladá), jednotky ležia v skladoch (dvoch dvoroch; spec zistí, do ktorého sa
//      uložili, a nezávisle na tom overí súčet) a čakajú na loď B (karta „Čaká na loď B“, inšpektor dvora s väčšinou prekládky ukáže segment
//      Tranship s počtom z ledgera), prekládka nikdy neprejde bránou;
//   2. loď B ju naloží (na palube `export`) a odpláva: `ExportShipped` 36 TEU, kontrakt `completed`, výplata;
//   3. prázdne kontajnery importu sa vrátia kamiónmi cez bránu do depa prázdnych (`EmptyReturned` → `EmptyStored`), inšpektor depa ich
//      ukáže podľa linky; jedna prázdna sa poškodí (kontrola v depe je náhodná, 8 % — spec ju poškodí cez ledger, aby sa oprava
//      overila vždy), dostane opravárenské miesto, po `repairHours` je opäť dostupná, poplatok `maintenance_repair` a toast „Oprava hotová“;
//   4. nič sa nestratilo (`assertConservation`, vytvorené = živé + vyvezené po súši + odplávané), žiadna chyba v konzole.
// Loading prázdnych na loď (repositioning) spec neprijíma: pool ponúka repositioning pri polovici ponúk spolu s exportom a linka ponuky je
// náhodná, takže by prijatie závisel od náhody; ten pokrývajú `tests/app/f6c-live-terminal.test.ts` (VM lode, karty) a `f6c-render-demo`.
//
// Časovanie sa medzi behmi mierne líši (klik na „Prijať“ je v reálnom čase), preto spec nespolieha na konkrétne id ani objemy: číta ich
// zo sveta a podmienky screenshotov majú záložné vetvy. Čo sa medzitým stalo, overuje počítadlo udalostí simu (`__tally`).
//
// Screenshoty (gitignorované): `f6c-depot.png` (inšpektor depa počas opravy), `f6c-tranship.png` (loď A vykladá prekládku, karta v paneli),
// `f6c-tranship-yard.png` (prekládka čaká v dvoroch na loď B, inšpektor dvora s jej väčšinou), `f6c-loaded.png` (loď B s naloženou prekládkou).

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 8 * 60_000 });

const SCENARIO = JSON.parse(readFileSync('data/scenarios/live_terminal.json', 'utf8')) as { commands: { atTick: number; command: Record<string, unknown> }[] };
/** Príkazy tick 0 scenára: cesty, moduly (depo vozidiel, depo prázdnych, dva dvory, brána, stojisko, rampa) a tri vozidlá (2 × straddle, empty handler). */
const BUILD = SCENARIO.commands.filter((entry) => entry.atTick === 0).map((entry) => entry.command);
const PLACEMENTS = BUILD.filter((command) => command['type'] !== 'BuyVehicle');
const PURCHASES = BUILD.filter((command) => command['type'] === 'BuyVehicle');
const MODULE_COUNT = 1 + PLACEMENTS.filter((command) => command['type'] === 'PlaceModule').length; // + Root berth
const YARD_COUNT = PLACEMENTS.filter((command) => command['type'] === 'PlaceModule' && command['defId'] === 'container_yard_small').length;

const OVERVIEW = { x: 47, y: 25, zoom: 0.5 } as const;
/** Root berth s apronom a vozidlami pod hákom (loď nad nábrežím). */
const BERTH_VIEW = { x: 44, y: 14.3, zoom: 1 } as const;
/** Depo prázdnych (42–45 × 18–21) s cestami okolo; pravý panel (inšpektor) zakrýva len pravý okraj mapy. */
const DEPOT_VIEW = { x: 44, y: 21, zoom: 0.8 } as const;
/** Zoom pohľadu na dvory: stred pohľadu sa odvodí z ich footprintov (`yardsView`), aby boli oba vľavo od panela. */
const YARD_ZOOM = 0.8;

/** Bunka vo vnútri depa prázdnych (footprint 4 × 4 od [42, 18]). */
const DEPOT_CELL = { x: 43, y: 19 } as const;

type Cell = { readonly x: number; readonly y: number };
/** Modul zo `window.__sim.entities()`: ľavý horný roh a rozmery footprintu PO rotácii (bunky). */
type Footprint = { readonly id: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** Bunka v strede footprintu (vždy vo vnútri modulu, aj pri rotácii 90 / 270). */
const centerCellOf = (module: Footprint): Cell => ({ x: module.x + Math.floor(module.w / 2), y: module.y + Math.floor(module.h / 2) });

/** Pohľad na všetky dvory naraz: stred obálky ich footprintov (obe majú byť na obrazovke vedľa seba, kým pravý panel zakrýva len okraj). */
function yardsView(yards: readonly Footprint[]): { readonly x: number; readonly y: number; readonly zoom: number } {
  const minX = Math.min(...yards.map((yard) => yard.x));
  const minY = Math.min(...yards.map((yard) => yard.y));
  const maxX = Math.max(...yards.map((yard) => yard.x + yard.w));
  const maxY = Math.max(...yards.map((yard) => yard.y + yard.h));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: YARD_ZOOM };
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

/**
 * Posúva hru cez `window.__sim.advance` po `step` tickoch, kým `condition(arg)` (vyhodnotená v stránke po každom kroku) neplatí; pri zhode
 * hru pozastaví (`clock.setSpeed(0)`), aby ďalšie kontroly a screenshot videli presne ten stav. Strop `maxTicks` zachytí zaseknutý tok.
 */
async function advanceUntil<T extends ConditionArg>(page: Page, condition: (arg: T) => boolean, arg: T, options: { readonly step?: number; readonly maxTicks?: number } = {}): Promise<void> {
  const { step = 10, maxTicks = 90_000 } = options;
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
  await page.waitForFunction(runner, { arg, step, maxTicks, batch: Math.ceil(BATCH_TICKS / step), limit: null }, { polling: 'raf', timeout: 5 * 60_000 });
}

const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'Kontrakty' });
const inspector = (page: Page): Locator => page.getByRole('complementary', { name: 'Inšpektor modulu' });
const toasts = (page: Page): Locator => page.locator('.toasts .toast');
type Tally = Record<string, number>;
const tallyOf = (page: Page): Promise<Tally> => page.evaluate(() => ({ ...(window as unknown as { __tally: Tally }).__tally }));

/** Klik na bunku, ktorý vyberie modul: zavrie toasty, hover + prekreslenie a až potom klik; inšpektor sa musí ukázať hneď (pozri `dismissToasts`). */
async function selectModuleAt(page: Page, cell: Cell): Promise<void> {
  await dismissToasts(page);
  const point = await page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [cell.x, cell.y] as const);
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await page.mouse.click(point.x, point.y);
  await expect(inspector(page)).toBeVisible();
}

/** Otvorí panel Kontrakty (ak nie je otvorený) na záložke. */
async function openPanel(page: Page, tab: RegExp): Promise<void> {
  await dismissToasts(page);
  if ((await panel(page).count()) === 0) await page.locator('[data-field="panel-contracts"]').click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('tab', { name: tab }).click();
}

test.describe('F6c: prázdne kontajnery a prekládka v jednom prístave (T6C-06b, M2)', () => {
  test('import → prázdne sa vrátia do depa, poškodená sa opraví; prekládka loď A → sklad → loď B; nič sa nestratilo', async ({ page }) => {
    const errors = await openGame(page);
    await page.evaluate(() => {
      const tally: Tally = {};
      (window as unknown as { __tally: Tally }).__tally = tally;
      window.__sim!.bridge.onEvents((events) => {
        for (const event of events) tally[event.type] = (tally[event.type] ?? 0) + 1;
      });
    });
    await view(page, OVERVIEW);

    // 1) prístav zo scenára `live_terminal`: cesty, moduly (vrátane depa prázdnych) a vozidlá (2 × straddle, empty handler)
    for (const command of PLACEMENTS) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().modules.length)).toBe(MODULE_COUNT);
    for (const command of PURCHASES) expect(await dispatch(page, command), JSON.stringify(command)).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(PURCHASES.length);
    const port = await page.evaluate(() => {
      const { modules, vehicles } = window.__sim!.entities();
      const depot = modules.find((module) => module.defId === 'empty_depot');
      return {
        connected: modules.filter((module) => module.connected !== undefined).every((module) => module.connected === true),
        depot: depot === undefined ? null : { id: depot.id, vm: depot.depot },
        yards: modules.filter((module) => module.defId === 'container_yard_small').map((module) => ({ id: module.id, x: module.x, y: module.y, w: module.w, h: module.h })),
        vehicles: (vehicles ?? []).map((vehicle) => vehicle.defId).sort(),
        ramp: modules.find((module) => module.defId === 'loading_ramp_container')?.ramp?.operational,
      };
    });
    expect(port.connected).toBe(true);
    expect(port.ramp).toBe(true);
    expect(port.yards).toHaveLength(YARD_COUNT); // prístav má dva kontajnerové dvory (druhý otočený o 90°), prekládka sa uloží do ktoréhokoľvek
    expect(YARD_COUNT).toBe(2);
    expect(port.vehicles).toEqual(['empty_handler', 'straddle_carrier', 'straddle_carrier']);
    expect(port.depot?.vm).toEqual({ available: 0, damaged: 0, inRepair: 0, repairBays: 2 }); // prázdne depo, dve opravárenské miesta
    const depotId = port.depot!.id;
    const yards = port.yards;
    const yardIds = yards.map((yard) => yard.id);

    // 2) import prijatý v paneli Kontrakty: jeho kontajnery odídu kamiónmi a po pobyte vo vnútrozemí sa vrátia ako prázdne
    const imported = await page.evaluate(() => {
      const offers = window
        .__sim!.bridge.snapshot()
        .contracts.filter((card) => card.kind === 'import' && card.state === 'offered' && card.cargoCategory === 'container' && card.disabledReason === undefined)
        .sort((a, b) => a.volumeUnits - b.volumeUnits);
      const chosen = offers.find((card) => card.volumeUnits >= 36) ?? offers[offers.length - 1];
      return chosen === undefined ? null : { id: chosen.id as number, volume: chosen.volumeUnits, line: chosen.line?.id ?? '' };
    });
    expect(imported, 'v poole je prijateľná importná ponuka kontajnerov').not.toBeNull();
    await openPanel(page, /Ponuky/);
    const importCard = panel(page).locator(`article.contract-card[data-contract-id="${String(imported!.id)}"]`);
    await expect(importCard).toBeVisible();
    await importCard.locator('[data-action="accept"]').click();
    await expect(toasts(page).filter({ hasText: 'Kontrakt prijatý' })).toHaveCount(1);
    expect(await page.evaluate((id) => window.__sim!.world.contracts.get(id as never)?.state, imported!.id)).toBe('accepted');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);

    // 3) prvá uzávierka dňa: ponuky F6c vznikajú len v prístave s depom prázdnych → prekládka je v Ponukách; prijmeme ju
    await advanceUntil(page, () => [...window.__sim!.world.contracts.values()].some((contract) => contract.kind === 'tranship' && contract.state === 'offered'), null);
    const offer = await page.evaluate(() => {
      const contract = [...window.__sim!.world.contracts.values()].find((candidate) => candidate.kind === 'tranship' && candidate.state === 'offered')!;
      return { id: contract.id as number, volume: contract.volumeUnits, destination: contract.booking!.destinationPort, line: contract.lineId, outVoyage: contract.tranship!.outVoyageId as number };
    });
    expect(offer.volume).toBeGreaterThan(0);
    await openPanel(page, /Ponuky/);
    const offerCard = panel(page).locator(`article.contract-card[data-contract-id="${String(offer.id)}"]`);
    await expect(offerCard).toHaveAttribute('data-kind', 'tranship');
    await expect(offerCard.locator('[data-field="cargo"]')).toHaveText('Tranship · Kontajnery');
    await expect(offerCard.locator('[data-field="destination"]')).toHaveText(offer.destination);
    await expect(offerCard.locator('[data-field="leg-a"]')).toContainText('Loď A');
    await expect(offerCard.locator('[data-field="leg-b"]')).toHaveText(`Loď B · plavba #${String(offer.outVoyage)}`);
    await expect(offerCard.locator('[data-field="leg-a-time"]')).toHaveText('príde po prijatí');
    await expect(offerCard.locator('[data-field="leg-b-time"]')).toContainText('po lodi A'); // „o 1 deň – 2 dni po lodi A“ (transhipGapDaysRange)
    await expect(offerCard.locator('[data-action="accept"]')).not.toHaveAttribute('aria-disabled', 'true');
    await offerCard.locator('[data-action="accept"]').click();
    await expect(toasts(page).filter({ hasText: 'Kontrakt prijatý' }).filter({ hasText: `#${String(offer.id)} · Tranship` })).toHaveCount(1);
    const accepted = await page.evaluate((id) => {
      const contract = window.__sim!.world.contracts.get(id as never)!;
      return { state: contract.state, outArrival: contract.tranship!.outArrivalTick ?? null, shipArrival: contract.shipArrivalTick ?? null, gap: window.__sim!.world.defs.economy.transhipGapDaysRange, perDay: window.__sim!.world.clock.ticksPerDay };
    }, offer.id);
    expect(accepted.state).toBe('accepted');
    // loď B príde `transhipGapDaysRange` po lodi A (jeden ťah Rng pri prijatí)
    const gapTicks = accepted.outArrival! - accepted.shipArrival!;
    expect(gapTicks).toBeGreaterThanOrEqual(Math.round(accepted.gap[0] * accepted.perDay));
    expect(gapTicks).toBeLessThanOrEqual(Math.round(accepted.gap[1] * accepted.perDay) + 1);
    await panel(page).getByRole('tab', { name: /Aktívne/ }).click();
    const activeCard = panel(page).locator(`article.contract-card[data-contract-id="${String(offer.id)}"]`);
    await expect(activeCard).toHaveAttribute('data-tab', 'active');
    await expect(activeCard.locator('[data-field="leg-a-time"]')).toContainText('príde o');
    await expect(activeCard.locator('[data-field="leg-b-time"]')).toContainText('príde o');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);

    // 4) loď A privezie prekládku: na palube `import` (smer jednotiek je `tranship`), žeriav ju vykladá; screenshot s kartou v paneli
    await advanceUntil(
      page,
      (id: number) => {
        const contract = window.__sim!.world.contracts.get(id as never)!;
        const ship = window.__sim!.entities().ships.find((candidate) => candidate.id === contract.shipId);
        return ship?.state === 'docked' && contract.unitsUnloaded >= 6 && (ship.cargoSplit?.import ?? 0) >= 6;
      },
      offer.id,
      { step: 5 },
    );
    const unloading = await page.evaluate((id) => {
      const { world } = window.__sim!;
      const contract = world.contracts.get(id as never)!;
      const ship = window.__sim!.entities().ships.find((candidate) => candidate.id === contract.shipId)!;
      const directions: Record<string, number> = {};
      for (let i = 0; i < world.cargo.countAt('on_ship', ship.id as never); i += 1) {
        const unit = world.cargo.get(world.cargo.unitAtIndex('on_ship', ship.id as never, i)!)!;
        directions[unit.direction] = (directions[unit.direction] ?? 0) + 1;
      }
      return { split: ship.cargoSplit, onBoard: ship.unitsOnBoard, directions, unloaded: contract.unitsUnloaded, booking: contract.booking!.arrivedUnits };
    }, offer.id);
    // loď A: všetko, čo nesie, je prekládka a VM ju ráta ako prichádzajúci náklad (import), nie ako export
    expect(unloading.directions).toEqual({ tranship: unloading.onBoard });
    expect(unloading.split).toEqual({ import: unloading.onBoard, export: 0 });
    expect(unloading.unloaded).toBe(unloading.booking);
    await dismissToasts(page);
    await view(page, BERTH_VIEW);
    await openPanel(page, /Aktívne/);
    const unloadingCard = panel(page).locator(`article.contract-card[data-contract-id="${String(offer.id)}"]`);
    await expect(unloadingCard.locator('[data-field="status"]')).toBeVisible();
    await expect(unloadingCard.locator('[data-field="unloaded-value"]')).toContainText(` / ${String(offer.volume)} TEU`);
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6c-tranship.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);

    // 5) loď A je vyložená a odplávala; všetka prekládka leží v dvoroch (nikdy nešla bránou) a čaká na loď B: karta „Čaká na loď B“,
    //    inšpektor dvora s väčšinou prekládky ukáže segment Tranship s počtom z ledgera
    await advanceUntil(
      page,
      (id: number) => {
        const { world } = window.__sim!;
        const contract = world.contracts.get(id as never)!;
        return contract.unitsUnloaded === contract.volumeUnits && contract.state === 'exporting' && world.cargo.countByKind('on_ship') + world.cargo.countByKind('in_crane') === 0;
      },
      offer.id,
      { step: 5 },
    );
    const waiting = await page.evaluate((id) => {
      const { world } = window.__sim!;
      const contract = world.contracts.get(id as never)!;
      const locations: Record<string, number> = {};
      for (const unit of world.cargo.liveUnits()) if (unit.direction === 'tranship') locations[unit.location.kind] = (locations[unit.location.kind] ?? 0) + 1;
      return { locations, loaded: contract.booking!.loadedUnits };
    }, offer.id);
    // jednotky sú v sklade alebo na ceste doň (vozidlá ich odvážajú z apronu / pod hákom), nikdy na rampe ani v kamióne; loď B ich ešte nenaložila
    // (môže už čakať na kotvisku — príchod lode B nezávisí od konca vykládky lode A)
    expect(waiting.loaded).toBe(0);
    expect(Object.keys(waiting.locations).filter((kind) => kind === 'at_ramp' || kind === 'in_truck' || kind === 'on_ship')).toEqual([]);
    await advanceUntil(page, (id: number) => window.__sim!.world.cargo.countByKind('in_storage') >= 1 && [...window.__sim!.world.cargo.liveUnits()].filter((unit) => unit.direction === 'tranship').every((unit) => unit.location.kind === 'in_storage') && window.__sim!.world.contracts.get(id as never)!.unitsUnloaded > 0, offer.id, { step: 5 });
    // prekládka sa rozdelí medzi dvory podľa toho, kam ju dispečer vozidlám pridelil: súčet cez dvory = objem kontraktu, inšpektor otvoríme
    // nad dvorom s väčšinou (pri rovnosti nad prvým), ktorý musí niesť aspoň jednu jednotku
    const split = await page.evaluate((ids) => {
      const { cargo } = window.__sim!.world;
      return ids.map((id) => {
        let count = 0;
        for (let i = 0; i < cargo.countAt('in_storage', id as never); i += 1) if (cargo.get(cargo.unitAtIndex('in_storage', id as never, i)!)?.direction === 'tranship') count += 1;
        return count;
      });
    }, yardIds);
    expect(split.reduce((sum, count) => sum + count, 0)).toBe(offer.volume); // ledger: všetka prekládka leží v dvoroch
    const tranYard = split.indexOf(Math.max(...split));
    const tranYardId = yardIds[tranYard]!;
    const tranCount = split[tranYard]!;
    expect(tranCount).toBeGreaterThan(0);
    await dismissToasts(page);
    await view(page, yardsView(yards));
    await selectModuleAt(page, centerCellOf(yards[tranYard]!));
    await expect(inspector(page)).toHaveAttribute('data-module-id', String(tranYardId)); // klik trafil dvor s prekládkou, nie druhý
    await expect(inspector(page).locator('[data-field="title"]')).toContainText('Kontajnerový dvor');
    await expect(inspector(page).locator('[data-section="storage-split"]')).toContainText('Tranship');
    // inšpektor ukazuje ledger: počet segmentu Tranship = jednotky prekládky v tomto dvore
    await expect(inspector(page).locator('[data-section="storage-split"] [data-field="storage-split-tranship"]')).toHaveText(new RegExp(`^${String(tranCount)}( |$)`));
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6c-tranship-yard.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);
    await openPanel(page, /Aktívne/);
    await expect(panel(page).locator(`article.contract-card[data-contract-id="${String(offer.id)}"] [data-field="status"]`)).toHaveText(/^(Čaká na loď B|Ohrozené)$/);
    await page.keyboard.press('Escape');

    // 6) loď B priplávala a nakladá prekládku: na palube `export` (jednotky majú smer `tranship` a voyage lode A, loď B je iná než A)
    await advanceUntil(
      page,
      (id: number) => {
        const contract = window.__sim!.world.contracts.get(id as never)!;
        const ship = window.__sim!.entities().ships.find((candidate) => candidate.id === contract.tranship!.outShipId);
        return ship?.state === 'docked' && (ship.cargoSplit?.export ?? 0) >= Math.min(contract.volumeUnits, 12);
      },
      offer.id,
      { step: 5 },
    );
    const loading = await page.evaluate((id) => {
      const { world } = window.__sim!;
      const contract = world.contracts.get(id as never)!;
      const ship = window.__sim!.entities().ships.find((candidate) => candidate.id === contract.tranship!.outShipId)!;
      const directions: Record<string, number> = {};
      for (let i = 0; i < world.cargo.countAt('on_ship', ship.id as never); i += 1) {
        const unit = world.cargo.get(world.cargo.unitAtIndex('on_ship', ship.id as never, i)!)!;
        directions[unit.direction] = (directions[unit.direction] ?? 0) + 1;
      }
      return { shipId: ship.id as number, shipA: contract.shipId as number, split: ship.cargoSplit, onBoard: ship.unitsOnBoard, directions, loaded: contract.booking!.loadedUnits, state: contract.state };
    }, offer.id);
    expect(loading.shipId).not.toBe(loading.shipA);
    expect(loading.directions).toEqual({ tranship: loading.onBoard });
    expect(loading.split).toEqual({ import: 0, export: loading.onBoard }); // na lodi B je prekládka odchádzajúci náklad (export)
    expect(loading.loaded).toBe(loading.onBoard);
    expect(loading.state).toBe('exporting');
    await dismissToasts(page);
    await view(page, BERTH_VIEW);
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6c-loaded.png`, fullPage: true });

    // 7) odchod lode B: `ExportShipped` so všetkou prekládkou, kontrakt `completed` s výplatou, žiadna penalizácia, nič neprešlo bránou
    await advanceUntil(
      page,
      (id: number) => window.__sim!.world.contracts.get(id as never)!.state === 'completed' && ((window as unknown as { __tally: Tally }).__tally['ExportShipped'] ?? 0) >= 1,
      offer.id,
      { step: 5 },
    );
    const done = await page.evaluate((id) => {
      const { world } = window.__sim!;
      const contract = world.contracts.get(id as never)!;
      const tally = (window as unknown as { __tally: Tally }).__tally;
      return {
        loaded: contract.booking!.loadedUnits,
        penalties: contract.penaltiesCents,
        unloaded: contract.unitsUnloaded,
        exported: contract.unitsExported,
        reward: contract.rewardCents,
        revenue: world.economy.entries.filter((entry) => entry.category === 'contract_revenue').map((entry) => entry.amountCents),
        missed: tally['TranshipMissed'] ?? 0,
        shippedEvents: tally['ExportShipped'] ?? 0,
        tranship: [...world.cargo.liveUnits()].filter((unit) => unit.direction === 'tranship').length,
      };
    }, offer.id);
    expect(done).toMatchObject({ loaded: offer.volume, unloaded: offer.volume, exported: 0, penalties: 0, missed: 0, tranship: 0 });
    expect(done.shippedEvents).toBeGreaterThanOrEqual(1);
    expect(done.revenue).toContain(done.reward);
    await expect(toasts(page).filter({ hasText: 'Loď odplávala s exportom' })).toContainText(`${String(offer.volume)} TEU → ${offer.destination}`);
    await expect(toasts(page).filter({ hasText: 'Kontrakt splnený' }).filter({ hasText: `Tranship ${String(offer.volume)} TEU → ${offer.destination}` })).toHaveCount(1);

    // 8) prázdne kontajnery importu sa vrátia kamiónmi cez bránu do depa prázdnych (aj keď sa to stalo skôr, počítadlo udalostí to ukáže)
    await advanceUntil(
      page,
      () => {
        const tally = (window as unknown as { __tally: Tally }).__tally;
        const depot = window.__sim!.entities().modules.find((module) => module.defId === 'empty_depot')?.depot;
        return (tally['EmptyStored'] ?? 0) >= 3 && (depot?.available ?? 0) >= 2;
      },
      null,
      { step: 10 },
    );
    const returned = await tallyOf(page);
    expect(returned['EmptyReturned']).toBeGreaterThanOrEqual(3);
    expect(returned['EmptyStored']).toBeGreaterThanOrEqual(3);
    // prázdne prišli kamiónom `in_truck → at_ramp → in_vehicle → in_storage` a uložili sa do depa (nie do bežného dvora): dvory majú len import / export
    const stored = await page.evaluate(
      ([depot, yardList]) => {
        const { world } = window.__sim!;
        const inStorage = (moduleId: number) => {
          const directions: Record<string, number> = {};
          for (let i = 0; i < world.cargo.countAt('in_storage', moduleId as never); i += 1) {
            const unit = world.cargo.get(world.cargo.unitAtIndex('in_storage', moduleId as never, i)!)!;
            directions[unit.direction] = (directions[unit.direction] ?? 0) + 1;
          }
          return directions;
        };
        return { depot: inStorage(depot as number), yards: (yardList as number[]).map((yard) => inStorage(yard)), fallback: (window as unknown as { __tally: Tally }).__tally['EmptyStored'] };
      },
      [depotId, yardIds] as const,
    );
    expect(Object.keys(stored.depot)).toEqual(['empty']);
    expect(stored.yards).toHaveLength(YARD_COUNT);
    for (const yard of stored.yards) expect(yard['empty'] ?? 0).toBe(0);
    await dismissToasts(page);
    await view(page, DEPOT_VIEW);
    await selectModuleAt(page, DEPOT_CELL);
    await expect(inspector(page).locator('[data-field="title"]')).toHaveText('Depo prázdnych kontajnerov');
    await expect(inspector(page).locator('[data-section="empty-lines"]')).toBeVisible();
    const lineRows = inspector(page).locator('[data-section="empty-lines"] li[data-line]');
    await expect(lineRows).toHaveCount(3);
    const emptyNow = await page.evaluate((depot) => window.__sim!.bridge.snapshot().modules.find((module) => module.id === depot)?.depot, depotId);
    expect(emptyNow!.available + emptyNow!.damaged + emptyNow!.inRepair).toBeGreaterThanOrEqual(2);
    await expect(inspector(page).locator('[data-field="stat-available"]')).toHaveText(String(emptyNow!.available));

    // 9) kontrola a oprava (M&R): kontrola v depe je náhodná (8 %), preto spec poškodí jednu dostupnú prázdnu cez ledger (rovnaké API ako sim);
    //    oprava sa začne sama (miesto opravy), jednotka je `in_repair` a po `repairHours` opäť `available`, poplatok a toast „Oprava hotová“
    const victim = await page.evaluate((depot) => {
      const { world } = window.__sim!;
      for (let i = 0; i < world.cargo.countAt('in_storage', depot as never); i += 1) {
        const id = world.cargo.unitAtIndex('in_storage', depot as never, i)!;
        const unit = world.cargo.get(id)!;
        if (unit.status !== 'available') continue;
        world.cargo.setStatus(id, 'damaged', null);
        return { id: id as number, line: unit.lineId ?? '' };
      }
      return null;
    }, depotId);
    expect(victim, 'v depe je dostupná prázdna na poškodenie').not.toBeNull();
    const repairedBefore = (await tallyOf(page))['EmptyRepaired'] ?? 0;
    await advanceUntil(page, (id: number) => window.__sim!.world.cargo.get(id as never)?.status === 'in_repair', victim!.id, { step: 2, maxTicks: 30_000 });
    await dismissToasts(page);
    // inšpektor depa počas opravy: poškodená jednotka je v riadku svojej linky pri „V oprave“, obsadené opravárenské miesto
    const row = inspector(page).locator(`[data-section="empty-lines"] li[data-line="${victim!.line}"]`);
    await expect(row.locator('[data-field="line-repair"]')).not.toHaveText('0');
    await expect(inspector(page).locator('[data-section="repair-bays"] [data-state="occupied"]')).not.toHaveCount(0);
    await expect(inspector(page).locator('[data-field="repair-count"]')).toContainText('/ 2');
    await parkMouse(page);
    await page.screenshot({ path: `${SHOTS}/f6c-depot.png`, fullPage: true });
    const cashBefore = await page.evaluate(() => window.__sim!.world.cashCents);

    await advanceUntil(page, (id: number) => window.__sim!.world.cargo.get(id as never)?.status === 'available', victim!.id, { step: 10, maxTicks: 30_000 });
    const repaired = await page.evaluate((id) => {
      const { world } = window.__sim!;
      return {
        status: world.cargo.get(id as never)?.status,
        repairCost: world.defs.economy.repairCostCents,
        entries: world.economy.entries.filter((entry) => entry.category === 'maintenance_repair').map((entry) => ({ amount: entry.amountCents, ref: entry.refId })),
        tally: (window as unknown as { __tally: Tally }).__tally['EmptyRepaired'] ?? 0,
        cash: world.cashCents,
      };
    }, victim!.id);
    expect(repaired.status).toBe('available');
    expect(repaired.tally).toBeGreaterThan(repairedBefore);
    expect(repaired.entries.some((entry) => entry.amount === -repaired.repairCost && entry.ref === `unit:${String(victim!.id)}`)).toBe(true);
    expect(repaired.cash).toBeLessThanOrEqual(cashBefore);
    await expect(toasts(page).filter({ hasText: 'Oprava hotová' }).first()).toBeVisible({ timeout: 30_000 });

    // 10) nič sa nestratilo: konzervácia, vytvorené = živé + vyvezené po súši + odplávané; žiadna chyba v konzole
    const end = await page.evaluate(() => {
      const { cargo } = window.__sim!.world;
      cargo.assertConservation();
      return { created: cargo.createdCount, live: cargo.liveCount, exported: cargo.exportedCount, shipped: cargo.shippedCount };
    });
    expect(end.created - end.live - end.exported - end.shipped).toBe(0);
    expect(end.shipped).toBeGreaterThanOrEqual(offer.volume);
    expect(await page.evaluate(() => (window as unknown as { __tally: Tally }).__tally['TranshipMissed'] ?? 0)).toBe(0);
    expect(errors).toEqual([]);
  });
});
