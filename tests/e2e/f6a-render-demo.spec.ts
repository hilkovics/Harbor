import { expect, test, type Page } from '@playwright/test';
import type { HoldDecor } from '../../src/render/hold-decor';

// T6A-06 render demo (`src/render/__demo__/f6a-render.html`): export a booking na syntetických snímkach (živé dáta dodá T6A-04/05),
// riadené hodiny animácií, takže screenshoty sú deterministické. Scény:
//  - `ships`: náklad na palube podľa počtu (import oranžovo, export modro), lashing lode (prstenec postupu), žeriav pri nakládke
//    (opačný smer vozíka), jednotka vo VGM hold na slote apronu;
//  - `hold`: sklad a berth s jednotkami vo VGM hold.

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

test('hold: jednotky vo VGM hold v sklade a na aprone majú odznak upozornenia s počtom', async ({ page }) => {
  const errors = await openDemo(page, 'hold');
  await page.screenshot({ path: `${SHOTS}/f6a-hold-overview.png` });
  const badges = await page.evaluate(() => {
    const { renderer } = window.__f6aDemo!;
    const decor = (id: number) => renderer.modules.moduleView(id)?.decor<HoldDecor>('hold');
    return {
      yard: { count: decor(3)?.badgeCount, text: decor(3)?.badge('module')?.shownText },
      berth: { count: decor(1)?.badgeCount, slot: decor(1)?.badge('slot-2')?.shownText },
    };
  });
  expect(badges.yard).toEqual({ count: 1, text: '3' });
  expect(badges.berth).toEqual({ count: 1, slot: '' });
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 46, 21, 2.0);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-hold-yard.png` });
  await page.evaluate(() => {
    const demo = window.__f6aDemo!;
    return demo.focus(demo.scene, 43.5, 16, 2.4);
  });
  await page.screenshot({ path: `${SHOTS}/f6a-hold-apron.png` });
  expect(errors).toEqual([]);
});
