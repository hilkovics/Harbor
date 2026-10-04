import { expect, test, type Page } from '@playwright/test';
import { DOCK_LEAVE_MS, DOCK_REVERSE_MS, DOCK_STOP_MS } from '../../src/render/dock-maneuver';
import type { HoldDecor } from '../../src/render/hold-decor';

// T6A-06 render demo (`src/render/__demo__/f6a-render.html`): export a booking na syntetických snímkach (živé dáta dodá T6A-04/05),
// riadené hodiny animácií, takže screenshoty sú deterministické. Scény:
//  - `ships`: náklad na palube podľa počtu (import oranžovo, export modro), lashing lode (prstenec postupu), žeriav pri nakládke
//    (opačný smer vozíka), jednotka vo VGM hold na slote apronu;
//  - `dock`: exportný kamión prichádza naložený, cúva do docku rovnakým manévrom ako pri nakládke, po vykládke odchádza prázdny
//    (alebo ostane v doku a nakladá import — dual transaction); odznak hold pri doku;
//  - `hold`: sklad, rampa a berth s jednotkami vo VGM hold.

const DEMO_URL = '/src/render/__demo__/f6a-render.html';
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

test('ships: náklad na palube podľa počtu (import / export farebne), lashing a nakládka žeriavom', async ({ page }) => {
  const errors = await openDemo(page, 'ships');
  await page.screenshot({ path: `${SHOTS}/f6a-ships-overview.png` });

  // paluba: pomer jednotiek → obsadené miesta; import od predku, export od zadku
  const decks = await page.evaluate(() => {
    const { renderer } = window.__f6aDemo!;
    const fill = (id: number) => renderer.entities.shipView(id)?.deckCargo?.currentFill ?? null;
    return { docked: fill(31), lashing: fill(32), empty: fill(41), importOnly: fill(42), exportOnly: fill(43), mixed: fill(44) };
  });
  expect(decks.docked).toEqual({ importSlots: 2, exportSlots: 1, emptySlots: 0 }); // 40 + 20 z 120 → 3 z 6 miest
  expect(decks.lashing).toEqual({ importSlots: 0, exportSlots: 10, emptySlots: 0 }); // 200 z 300 → 10 zo 14 miest
  expect(decks.empty).toEqual({ importSlots: 0, exportSlots: 0, emptySlots: 0 });
  expect(decks.importOnly).toEqual({ importSlots: 5, exportSlots: 0, emptySlots: 0 });
  expect(decks.exportOnly).toEqual({ importSlots: 0, exportSlots: 5, emptySlots: 0 });
  expect(decks.mixed).toEqual({ importSlots: 3, exportSlots: 3, emptySlots: 0 });

  // lashing: odznak len na lodi v stave lashing, postup z lashingTicksLeft
  const badges = await page.evaluate(() => {
    const { renderer } = window.__f6aDemo!;
    const ship = (id: number) => renderer.entities.shipView(id);
    return { lashing: ship(32)?.lashingVisible, docked: ship(31)?.lashingVisible, step: ship(32)?.lashing?.drawnStep };
  });
  expect(badges).toEqual({ lashing: true, docked: false, step: 63 }); // 1 − 150/400 = 0,625 → 63 z 100 krokov

  // detail: loď pri berthe s apronom, žeriavom pri nakládke a jednotkou v hold na slote
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 43, 13.5, 1.7);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-ships-berth-load.png` });

  // opačný smer: vozík pri nakládke `grabbing` ide k aprone (vzďaľuje sa od mora), pri vykládke k lodi
  const trolley = await page.evaluate(async () => {
    const demo = window.__f6aDemo!;
    const { craneAt } = demo.fixtures;
    const sample = async (state: 'grabbing' | 'placing', progress: number, cycle: 'unload' | 'load' | 'dual_load' | 'dual_unload') => {
      await demo.show({ ...demo.scene, cranes: [craneAt(state, progress, cycle, state === 'placing')] });
      return demo.renderer.cranes.craneView(2)?.trolleyOffsetY ?? Number.NaN;
    };
    return {
      loadEarly: await sample('grabbing', 0.2, 'load'),
      loadLate: await sample('grabbing', 0.8, 'load'),
      unloadEarly: await sample('grabbing', 0.2, 'unload'),
      unloadLate: await sample('grabbing', 0.8, 'unload'),
      loadPlacingEarly: await sample('placing', 0.2, 'load'),
      loadPlacingLate: await sample('placing', 0.8, 'load'),
    };
  });
  expect(trolley.loadLate).toBeGreaterThan(trolley.loadEarly); // záporné = k moru: od mora preč, k aprone
  expect(trolley.unloadLate).toBeLessThan(trolley.unloadEarly); // vykládka: k lodi
  expect(trolley.loadPlacingLate).toBeLessThan(trolley.loadPlacingEarly); // nakládka: so zdvihnutým kontajnerom k lodi

  await page.evaluate(async () => {
    const demo = window.__f6aDemo!;
    await demo.show({ ...demo.scene, cranes: [demo.fixtures.craneAt('grabbing', 0.7, 'load')] });
  });
  await page.screenshot({ path: `${SHOTS}/f6a-crane-load-grabbing.png` });
  await page.evaluate(async () => {
    const demo = window.__f6aDemo!;
    await demo.show({ ...demo.scene, cranes: [demo.fixtures.craneAt('placing', 0.7, 'load', true)] });
  });
  await page.screenshot({ path: `${SHOTS}/f6a-crane-load-placing.png` });

  // detail lashingu: prstenec na 62,5 % a na začiatku / konci
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 54, 12, 1.4);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-ships-lashing.png` });
  for (const [ticksLeft, name] of [
    [380, 'f6a-lashing-start'],
    [40, 'f6a-lashing-end'],
  ] as const) {
    await page.evaluate(async (left) => {
      const demo = window.__f6aDemo!;
      const ships = demo.scene.ships.map((ship) => (ship.id === 32 && ship.lashing !== undefined ? { ...ship, lashing: { ...ship.lashing, ticksLeft: left } } : ship));
      await demo.show({ ...demo.scene, ships });
    }, ticksLeft);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }

  // rad lodí s rôznym zaplnením paluby
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 48, 6, 0.9);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-ships-deck-row.png` });
  expect(errors).toEqual([]);
});

test('dock: exportný kamión prichádza naložený, cúva do docku, po vykládke odchádza prázdny; dual transaction ostáva v doku', async ({ page }) => {
  const errors = await openDemo(page, 'dock');
  const side = { x: 31, y: 25, heading: 270 } as const;
  const straight = { x: 32, y: 25, heading: 0 } as const;
  await page.screenshot({ path: `${SHOTS}/f6a-dock-arriving.png` });

  /** Zobrazí kamióny (kópia fixtúr) pre čas `at` a vráti stav view: fáza manévru, či má textúru z príchodu a poloha v bunkách. */
  const probe = async (at: number, kind: 'arriving' | 'unloading' | 'unloaded' | 'leaving' | 'dual' | 'dual_loaded') => {
    return page.evaluate(
      async ({ at, kind, side, straight }) => {
        const demo = window.__f6aDemo!;
        const f = demo.fixtures;
        demo.clock.set(at);
        const trucks =
          kind === 'arriving'
            ? [f.exportTruckArriving(f.EXPORT_TRUCK_SIDE, side.x, side.y, side.heading), f.exportTruckArriving(f.EXPORT_TRUCK_STRAIGHT, straight.x, straight.y, straight.heading)]
            : kind === 'unloading' || kind === 'unloaded'
              ? [
                  f.exportTruckUnloading(f.EXPORT_TRUCK_SIDE, side.x, side.y, side.heading, 0, kind === 'unloading'),
                  f.exportTruckUnloading(f.EXPORT_TRUCK_STRAIGHT, straight.x, straight.y, straight.heading, 1, kind === 'unloading'),
                ]
              : kind === 'leaving'
                ? [f.exportTruckLeaving(f.EXPORT_TRUCK_SIDE, side.x + 0.5, side.y + 0.5, 90), f.exportTruckLeaving(f.EXPORT_TRUCK_STRAIGHT, straight.x + 0.5, straight.y + 0.5, 90)]
                : [
                    f.exportTruckLeaving(f.EXPORT_TRUCK_SIDE, side.x + 0.5, side.y + 0.5, 90),
                    f.exportTruckDual(f.EXPORT_TRUCK_STRAIGHT, straight.x, straight.y, straight.heading, 1, kind === 'dual_loaded'),
                  ];
        // dok 0 drží jednotku v hold; vyložený export sa na doku zjaví ako pripravená jednotka (at_ramp), import z doku 1 odíde s kamiónom
        const staged: readonly [number, number] =
          kind === 'unloaded' || kind === 'leaving' || kind === 'dual' ? [2, 1] : kind === 'dual_loaded' ? [2, 0] : [1, 0];
        const modules = demo.scene.modules.map((module) => (module.kind === 'ramp' && module.id === f.DOCK_RAMP.id ? f.dockRamp(staged) : module));
        await demo.show({ ...demo.scene, modules, trucks });
        const view = (id: number) => demo.renderer.entities.truckView(id);
        const textureOf = (id: number) => view(id)?.texture ?? null;
        return {
          sidePhase: view(f.EXPORT_TRUCK_SIDE)?.dockPhase,
          straightPhase: view(f.EXPORT_TRUCK_STRAIGHT)?.dockPhase,
          x: (view(f.EXPORT_TRUCK_SIDE)?.view.x ?? Number.NaN) / demo.renderer.palette.cellPx,
          y: (view(f.EXPORT_TRUCK_SIDE)?.view.y ?? Number.NaN) / demo.renderer.palette.cellPx,
          sideTexture: textureOf(f.EXPORT_TRUCK_SIDE)?.label ?? 'bez textúry',
          sameTexture: textureOf(f.EXPORT_TRUCK_SIDE) === textureOf(f.EXPORT_TRUCK_STRAIGHT),
          straightX: (view(f.EXPORT_TRUCK_STRAIGHT)?.view.x ?? Number.NaN) / demo.renderer.palette.cellPx,
          straightY: (view(f.EXPORT_TRUCK_STRAIGHT)?.view.y ?? Number.NaN) / demo.renderer.palette.cellPx,
        };
      },
      { at, kind, side, straight },
    );
  };

  // príchod: obaja stoja na vonkajších bunkách, fáza `free`, naložení (rovnaká textúra)
  const arriving = await probe(0, 'arriving');
  expect(arriving.sidePhase).toBe('free');
  expect(arriving.straightPhase).toBe('free');
  expect(arriving.sameTexture).toBe(true);
  const loadedLabel = arriving.sideTexture;

  // vykládka začala (sim: `unloading`, jednotka ešte v návese): kamión najprv stojí
  const start = await probe(1000, 'unloading');
  expect(start.sidePhase).toBe('entering');
  expect(start.straightPhase).toBe('entering');
  expect(start.x).toBeCloseTo(arriving.x, 6);
  expect(start.sideTexture).toBe(loadedLabel);

  // cúvanie do docku (sim už jednotku vyložil: loaded = false), kamión ostáva naložený, kým nie je v doku
  const reversing = await probe(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS / 2, 'unloaded');
  expect(reversing.sidePhase).toBe('entering');
  expect(Math.hypot(reversing.x - start.x, reversing.y - start.y)).toBeGreaterThan(0.05);
  expect(reversing.sideTexture).toBe(loadedLabel);
  await page.screenshot({ path: `${SHOTS}/f6a-dock-reversing.png` });

  // v doku: vyložený → prázdny sprite
  const docked = await probe(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS + 200, 'unloaded');
  expect(docked.sidePhase).toBe('docked');
  expect(docked.straightPhase).toBe('docked');
  expect(docked.sideTexture).not.toBe(loadedLabel);
  expect(docked.x).toBeCloseTo(31.5, 6);
  await page.screenshot({ path: `${SHOTS}/f6a-dock-unloaded.png` });

  // odchod: prázdny z docku, plynulo do pohybu zo simu
  const leaving = await probe(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS + 200, 'leaving');
  expect(leaving.sidePhase).toBe('leaving');
  expect(leaving.sideTexture).not.toBe(loadedLabel);
  const gone = await probe(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS + 200 + DOCK_LEAVE_MS + 100, 'leaving');
  expect(gone.sidePhase).toBe('free');
  await page.screenshot({ path: `${SHOTS}/f6a-dock-leaving.png` });

  // dual transaction: druhý kamión ostane v doku 1 a nakladá import
  await probe(0, 'arriving');
  await probe(1000, 'unloading');
  await probe(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS + 200, 'unloaded');
  const dualEmpty = await probe(8000, 'dual');
  expect(dualEmpty.straightPhase).toBe('docked');
  const dualPose = { x: dualEmpty.straightX, y: dualEmpty.straightY };
  const dualLoaded = await probe(8500, 'dual_loaded');
  expect(dualLoaded.straightPhase).toBe('docked');
  expect(dualLoaded.straightX).toBeCloseTo(dualPose.x, 9);
  expect(dualLoaded.straightY).toBeCloseTo(dualPose.y, 9);
  await page.screenshot({ path: `${SHOTS}/f6a-dock-dual.png` });
  expect(errors).toEqual([]);
});

test('hold: jednotky vo VGM hold v sklade, na rampe a na aprone majú odznak upozornenia s počtom', async ({ page }) => {
  const errors = await openDemo(page, 'hold');
  await page.screenshot({ path: `${SHOTS}/f6a-hold-overview.png` });
  const badges = await page.evaluate(() => {
    const { renderer } = window.__f6aDemo!;
    const decor = (id: number) => renderer.modules.moduleView(id)?.decor<HoldDecor>('hold');
    return {
      yard: { count: decor(3)?.badgeCount, text: decor(3)?.badge('module')?.shownText },
      ramp: { count: decor(4)?.badgeCount, dock0: decor(4)?.badge('dock-0')?.shownText, dock1: decor(4)?.badge('dock-1')?.shownText },
      berth: { count: decor(1)?.badgeCount, slot: decor(1)?.badge('slot-2')?.shownText },
    };
  });
  expect(badges.yard).toEqual({ count: 1, text: '3' });
  expect(badges.ramp).toEqual({ count: 2, dock0: '2', dock1: '' });
  expect(badges.berth).toEqual({ count: 1, slot: '' });
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 46, 21, 2.0);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-hold-yard.png` });
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 52, 25, 2.4);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-hold-ramp.png` });
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 43.5, 16, 2.4);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-hold-apron.png` });
  expect(errors).toEqual([]);
});
