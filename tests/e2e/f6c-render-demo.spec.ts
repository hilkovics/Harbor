import { expect, test, type Page } from '@playwright/test';
import type { DepotDecor } from '../../src/render/depot-decor';
import type { YardCraneDecor } from '../../src/render/yard-crane-decor';

// T6C-04 render demo (`src/render/__demo__/f6c-render.html`): prázdne kontajnery, depo prázdnych a empty handler na syntetických
// snímkach (živé dáta dodajú T6C-02 / T6C-03). Scény:
//  - `ships`: prázdne kontajnery na aprone (sivé s pásikom farby linky), žeriav nakladá prázdny, loď s tromi blokmi na palube
//    (import od predku, prázdne tesne pred exportom, export od zadku) a rad lodí s rôznymi kombináciami;
//  - `depot`: depo prázdnych (sivé kontajnery na svetlej ploche, odznaky poškodených a opráv) vedľa dvora (oranžové), empty handler,
//    straddle carrier a kamión s prázdnym kontajnerom;
//  - `gate`: kamióny s prázdnym a s plným kontajnerom pri pruhu brány.

const DEMO_URL = '/src/render/__demo__/f6c-render.html';
const SHOTS = 'tests/e2e/__screenshots__';

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

test('ships: prázdne kontajnery na aprone, pod žeriavom a na palube majú sivú farbu, prázdne tesne pred exportom', async ({ page }) => {
  const errors = await openDemo(page, 'ships');
  await page.screenshot({ path: `${SHOTS}/f6c-ships-overview.png` });

  // paluba: import od predku, export od zadku, prázdne tesne pred exportom
  const decks = await page.evaluate(() => {
    const { renderer } = window.__f6cDemo!;
    const deck = (id: number) => {
      const cargo = renderer.entities.shipView(id)?.deckCargo;
      return cargo === null || cargo === undefined ? null : { fill: cargo.currentFill, directions: cargo.directions };
    };
    return { docked: deck(31), importEmpty: deck(51), exportEmpty: deck(52), emptyOnly: deck(53), all: deck(54) };
  });
  expect(decks.docked?.fill).toEqual({ importSlots: 2, exportSlots: 1, emptySlots: 1 });
  expect(decks.docked?.directions).toEqual(['import', 'import', null, null, 'empty', 'export']);
  expect(decks.importEmpty?.fill).toEqual({ importSlots: 3, exportSlots: 0, emptySlots: 2 });
  expect(decks.exportEmpty?.fill).toEqual({ importSlots: 0, exportSlots: 2, emptySlots: 3 });
  expect(decks.emptyOnly?.fill).toEqual({ importSlots: 0, exportSlots: 0, emptySlots: 4 });
  expect(decks.all?.fill).toEqual({ importSlots: 2, exportSlots: 2, emptySlots: 2 });
  expect(decks.all?.directions).toEqual(['import', 'import', 'empty', 'empty', 'export', 'export']);

  // apron: prázdne jednotky sú sivé a nesú farbu linky, plné ostávajú oranžové
  const apron = await page.evaluate(() => {
    const view = window.__f6cDemo!.renderer.modules.moduleView(1);
    const look = (slot: number) => {
      const cargo = view?.cargoAt(slot);
      return cargo === undefined ? null : { empty: cargo.look.empty === true, band: cargo.look.lineColor !== undefined };
    };
    return { full0: look(0), empty1: look(1), full2: look(2), empty4: look(4), empty5: look(5) };
  });
  expect(apron.full0).toEqual({ empty: false, band: false });
  expect(apron.empty1).toEqual({ empty: true, band: true });
  expect(apron.full2).toEqual({ empty: false, band: false });
  expect(apron.empty4).toEqual({ empty: true, band: true });
  expect(apron.empty5).toEqual({ empty: true, band: true });

  // detail: žeriav drží prázdny kontajner (sivý), potom plný (oranžový)
  await page.evaluate(() => {
    const demo = window.__f6cDemo!;
    return demo.focus(demo.scene, 43.5, 13.5, 1.9);
  });
  await page.screenshot({ path: `${SHOTS}/f6c-ships-berth-empty.png` });
  const held = await page.evaluate(async () => {
    const demo = window.__f6cDemo!;
    const holdingEmpty = demo.renderer.cranes.craneView(2)?.heldCargo?.look.empty === true;
    await demo.show({ ...demo.scene, cranes: [demo.fixtures.craneLoadingFull()] });
    const holdingFull = demo.renderer.cranes.craneView(2)?.heldCargo?.look.empty === true;
    return { holdingEmpty, holdingFull };
  });
  expect(held).toEqual({ holdingEmpty: true, holdingFull: false });
  await page.screenshot({ path: `${SHOTS}/f6c-ships-berth-full.png` });

  // rad lodí s rôznou kombináciou smerov na palube
  await page.evaluate(() => {
    const demo = window.__f6cDemo!;
    return demo.focus(demo.scene, 48, 6, 0.9);
  });
  await page.screenshot({ path: `${SHOTS}/f6c-ships-deck-row.png` });
  expect(errors).toEqual([]);
});

test('depot: sivé depo s odznakmi poškodených a opráv vedľa oranžového dvora, empty handler a vozidlá s prázdnym kontajnerom', async ({ page }) => {
  const errors = await openDemo(page, 'depot');
  await page.screenshot({ path: `${SHOTS}/f6c-depot-overview.png` });

  const depot = await page.evaluate(() => {
    const { renderer } = window.__f6cDemo!;
    const decor = (id: number) => renderer.modules.moduleView(id)?.decor<DepotDecor>('depot');
    const crane = (id: number) => renderer.modules.moduleView(id)?.decor<YardCraneDecor>('yard_crane');
    return {
      busy: { count: decor(5)?.badgeCount, damaged: decor(5)?.badge('damaged')?.shownText, repair: decor(5)?.badge('repair')?.shownText, fill: renderer.modules.moduleView(5)?.fill },
      clean: { decor: decor(6) !== undefined, count: decor(6)?.badgeCount, fill: renderer.modules.moduleView(6)?.fill },
      yard: { decor: decor(3) !== undefined },
      cranes: { depot: crane(5)?.carriesEmpty, cleanDepot: crane(6)?.carriesEmpty, yard: crane(3)?.carriesEmpty },
    };
  });
  expect(depot.busy).toEqual({ count: 2, damaged: '3', repair: '2/2', fill: 50 });
  expect(depot.clean).toEqual({ decor: true, count: 0, fill: 25 });
  expect(depot.yard).toEqual({ decor: false });
  expect(depot.cranes).toEqual({ depot: true, cleanDepot: true, yard: false });

  // sprity vozidiel: empty handler (od R2 sprite `ech` pre všetky stavy, kontajner pod spreaderom), straddle carrier a kamión s prázdnym kontajnerom ≠ s plným
  const vehicles = await page.evaluate(() => {
    const { renderer, fixtures } = window.__f6cDemo!;
    const vehicle = (id: number) => renderer.entities.vehicleView(id);
    return {
      states: {
        handlerEmpty: vehicle(fixtures.HANDLER_EMPTY)?.loadState,
        handlerLoaded: vehicle(fixtures.HANDLER_LOADED)?.loadState,
        carrierEmptyBox: vehicle(fixtures.CARRIER_EMPTY_BOX)?.loadState,
        carrierFullBox: vehicle(fixtures.CARRIER_FULL_BOX)?.loadState,
        truckEmptyBox: renderer.entities.truckView(fixtures.TRUCK_EMPTY_BOX)?.loadState,
      },
      textured: [fixtures.HANDLER_EMPTY, fixtures.HANDLER_LOADED, fixtures.CARRIER_EMPTY_BOX, fixtures.CARRIER_FULL_BOX].every((id) => vehicle(id)?.textured === true),
      handlerCargoDiffers: vehicle(fixtures.HANDLER_EMPTY)?.cargoState !== vehicle(fixtures.HANDLER_LOADED)?.cargoState, // ECH: jeden sprite rámu, líši sa kontajner pod spreaderom (žiadny / sivý)
      carrierTexturesDiffer: vehicle(fixtures.CARRIER_EMPTY_BOX)?.cargoState !== vehicle(fixtures.CARRIER_FULL_BOX)?.cargoState, // straddle: jeden sprite rámu, líši sa kontajner pod ním (sivý / plný)
    };
  });
  expect(vehicles.states).toEqual({
    handlerEmpty: 'empty',
    handlerLoaded: 'carries_empty',
    carrierEmptyBox: 'carries_empty',
    carrierFullBox: 'loaded',
    truckEmptyBox: 'carries_empty',
  });
  expect(vehicles).toMatchObject({ textured: true, handlerCargoDiffers: true, carrierTexturesDiffer: true });

  // detail depa: odznaky v rohu, sivé kontajnery na svetlej ploche; zdola dvor (oranžový) na porovnanie
  await page.evaluate(() => {
    const demo = window.__f6cDemo!;
    return demo.focus(demo.scene, 45.5, 21, 2.4);
  });
  await page.screenshot({ path: `${SHOTS}/f6c-depot-detail.png` });
  await page.evaluate(() => {
    const demo = window.__f6cDemo!;
    return demo.focus(demo.scene, 47.5, 21.4, 2.1);
  });
  await page.screenshot({ path: `${SHOTS}/f6c-depot-vs-yard.png` });

  // vozidlá po ceste: empty handler (s kontajnerom aj bez), straddle carrier s prázdnym / plným
  await page.evaluate(() => {
    const demo = window.__f6cDemo!;
    return demo.focus(demo.scene, 47.5, 23.5, 3.2);
  });
  await page.screenshot({ path: `${SHOTS}/f6c-depot-vehicles.png` });

  // poškodené po oprave: odznak poškodených zmizne, odznak opráv sa posunie na jeho miesto
  const healed = await page.evaluate(async () => {
    const demo = window.__f6cDemo!;
    const { DEPOT } = demo.fixtures;
    const modules = demo.scene.modules.map((module) => (module.id === DEPOT.id ? { ...module, depot: { available: 53, damaged: 0, inRepair: 2, repairBays: 2 } } : module));
    await demo.show({ ...demo.scene, modules });
    const decor = demo.renderer.modules.moduleView(DEPOT.id)?.decor<DepotDecor>('depot');
    return { count: decor?.badgeCount, damaged: decor?.badge('damaged') === undefined, repair: decor?.badge('repair')?.shownText };
  });
  expect(healed).toEqual({ count: 1, damaged: true, repair: '2/2' });
  expect(errors).toEqual([]);
});

test('gate: kamión s prázdnym kontajnerom prichádza k pruhu brány, kamión s plným odchádza', async ({ page }) => {
  const errors = await openDemo(page, 'gate');
  await page.screenshot({ path: `${SHOTS}/f6c-gate-overview.png` });
  const gate = await page.evaluate(() => {
    const { renderer } = window.__f6cDemo!;
    const state = (id: number) => renderer.entities.truckView(id)?.loadState;
    return {
      arriving: state(71),
      leaving: state(72),
      texturesDiffer: renderer.entities.truckView(71)?.cargoState !== renderer.entities.truckView(72)?.cargoState, // kamión: sivý (prázdny) vs plný kontajner na návese
    };
  });
  expect(gate.arriving).toBe('carries_empty');
  expect(gate.leaving).toBe('loaded');
  expect(gate.texturesDiffer).toBe(true);
  await page.evaluate(() => {
    const demo = window.__f6cDemo!;
    return demo.focus(demo.scene, 51, 22, 3.0);
  });
  await page.screenshot({ path: `${SHOTS}/f6c-gate-zoom.png` });
  expect(errors).toEqual([]);
});
