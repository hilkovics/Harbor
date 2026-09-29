import { expect, test, type Page } from '@playwright/test';

// F1 e2e (IMPLEMENTATION_PLAN, Fáza 1): hráč v build móde ťahom myši postaví cestu na starter parcele — počet ciest
// v gride vzrastie o počet buniek ťahu a hotovosť klesne o cenu — a rýchlosť 4× zrýchli hodiny sim aj HUD.
// Súradnice pre myš dáva `window.__sim.cellToScreen` (stred bunky v súradniciach stránky, dev hook).

/** Ťah po riadku y=20 na starter parcele (x 30–57, voľná pevnina): 10 buniek. */
const ROAD_ROW = 20;
const ROAD_FROM_X = 32;
const ROAD_TO_X = 41;
const ROAD_CELLS = ROAD_TO_X - ROAD_FROM_X + 1;

/** Kroky `mouse.move` medzi krajmi ťahu — viac udalostí ako buniek, ako pri skutočnej myši. */
const DRAG_STEPS = 24;

/** Dĺžka merania rýchlosti hodín v ms (reálny čas). */
const SPEED_WINDOW_MS = 2000;

/** Cesta 4× musí za rovnaký čas stihnúť aspoň toľkokrát viac tickov ako 1× (teoreticky 4×; rezerva na jitter). */
const MIN_SPEEDUP_RATIO = 3;

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}`;
}

/** Počet buniek s cestou (`road !== 'none'`) v živej mriežke sveta. */
function countRoadCells(page: Page): Promise<number> {
  return page.evaluate(() => {
    const { grid } = window.__sim!.world;
    let count = 0;
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        if (grid.at(x, y).road !== 'none') count += 1;
      }
    }
    return count;
  });
}

/** Tick sim a reálny čas stránky v jednom okamihu (rýchlosť = Δtick / Δčas, nezávisle od jitteru `waitForTimeout`). */
function sampleClock(page: Page): Promise<{ tick: number; realMs: number }> {
  return page.evaluate(() => ({ tick: window.__sim!.world.clock.tick, realMs: performance.now() }));
}

/** Zmeria rýchlosť hodín sim v tickoch za reálnu sekundu počas `SPEED_WINDOW_MS`. */
async function measureTicksPerSecond(page: Page): Promise<{ ticks: number; perSecond: number }> {
  const before = await sampleClock(page);
  await page.waitForTimeout(SPEED_WINDOW_MS);
  const after = await sampleClock(page);
  const ticks = after.tick - before.tick;
  return { ticks, perSecond: (ticks * 1000) / (after.realMs - before.realMs) };
}

test.describe('F1: cesty a rýchlosť', () => {
  test('ťah myšou postaví cestu, screenshot ukáže pobrežie a cestu, 4× zrýchli hodiny', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    // 1) načítanie: mapa, HUD, štartovná hotovosť
    await page.goto('/');
    await expect(page.locator('.app__map canvas')).toBeVisible();
    await expect(page.getByRole('banner', { name: 'Stav prístavu' })).toBeVisible();
    await expect(page.locator('[data-field="cash"]')).toHaveText('$1,200,000');
    await page.waitForFunction(() => window.__sim?.cellToScreen !== undefined);

    const startCash = await page.evaluate(() => window.__sim!.world.cashCents);
    const costPerCell = await page.evaluate(() => window.__sim!.world.defs.infrastructure.road.costPerCellCents);
    const roadsBefore = await countRoadCells(page);
    // Riadok ťahu je pred ťahom voľný (inak by počet nerástol o počet buniek ťahu).
    const occupied = await page.evaluate(
      ([y, fromX, toX]) => {
        const { grid } = window.__sim!.world;
        const cells: number[] = [];
        for (let x = fromX; x <= toX; x += 1) if (grid.at(x, y).road !== 'none') cells.push(x);
        return cells;
      },
      [ROAD_ROW, ROAD_FROM_X, ROAD_TO_X] as const,
    );
    expect(occupied).toEqual([]);

    // 2) build mód (B) a ťah ľavým tlačidlom po riadku
    await page.keyboard.press('KeyB');
    await expect(page.locator('.app__map')).toHaveAttribute('data-input-state', 'build');

    const start = await page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [ROAD_FROM_X, ROAD_ROW] as const);
    const end = await page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [ROAD_TO_X, ROAD_ROW] as const);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await expect(page.locator('.app__map')).toHaveAttribute('data-input-state', 'build_place');
    await page.mouse.move(end.x, end.y, { steps: DRAG_STEPS });
    await page.mouse.up();

    // po pustení: validate → dispatch; sim príkaz použije v ďalšom ticku
    await expect.poll(() => countRoadCells(page)).toBe(roadsBefore + ROAD_CELLS);
    const expectedCash = startCash - ROAD_CELLS * costPerCell;
    expect(await page.evaluate(() => window.__sim!.world.cashCents)).toBe(expectedCash);
    await expect(page.locator('[data-field="cash"]')).toHaveText(formatUsd(expectedCash));

    // každá bunka ťahu má cestu (súvislý pás bez dier)
    const placed = await page.evaluate(
      ([y, fromX, toX]) => {
        const { grid } = window.__sim!.world;
        const roads: string[] = [];
        for (let x = fromX; x <= toX; x += 1) roads.push(grid.at(x, y).road);
        return roads;
      },
      [ROAD_ROW, ROAD_FROM_X, ROAD_TO_X] as const,
    );
    expect(placed).toEqual(Array<string>(ROAD_CELLS).fill('road'));

    // 3) screenshot: build mód vypnúť (bez ghostu), počkať na prekreslenie ciest a presunúť myš mimo mapy
    await page.keyboard.press('KeyB');
    await expect(page.locator('.app__map')).toHaveAttribute('data-input-state', 'idle');
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f1-road.png', fullPage: true });

    // 4) rýchlosť: 1× vs 4× za rovnaký reálny čas
    const speedButton = (speed: number) => page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
    await speedButton(1).click();
    await expect(speedButton(1)).toHaveAttribute('aria-pressed', 'true');
    const normal = await measureTicksPerSecond(page);

    await speedButton(4).click();
    await expect(speedButton(4)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.__sim!.world.clock.speed)).toBe(4);
    const timeBeforeFast = await page.locator('[data-field="time"]').textContent();
    const fast = await measureTicksPerSecond(page);
    // HUD číta snapshot s odstupom 100 ms — čas sa po 2 s pri 4× (≈ 80 tickov) musí zmeniť
    await expect(page.locator('[data-field="time"]')).not.toHaveText(timeBeforeFast ?? '');

    console.log(
      `rýchlosť hodín: 1× = ${String(normal.ticks)} tickov / ${String(SPEED_WINDOW_MS)} ms (${normal.perSecond.toFixed(1)}/s), ` +
        `4× = ${String(fast.ticks)} tickov (${fast.perSecond.toFixed(1)}/s), pomer ${(fast.perSecond / normal.perSecond).toFixed(2)}`,
    );
    expect(normal.ticks).toBeGreaterThan(0);
    expect(fast.perSecond / normal.perSecond).toBeGreaterThanOrEqual(MIN_SPEEDUP_RATIO);

    expect(errors).toEqual([]);
  });
});
