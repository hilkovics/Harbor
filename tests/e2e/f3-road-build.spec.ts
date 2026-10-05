import { expect, test, type Locator, type Page } from '@playwright/test';

// F3 e2e (T03-20): hráč si v BuildBare (Landside) vyberie typ cesty a ťahom postaví jednosmerný úsek. Overuje sa výber
// položky (aria-pressed, cena za bunku), mód ciest, šípky smeru na ghoste, štítok pri kurzore, výsledok v gride
// (`cell.roadKind === 'one_way'`, smery `roadDir` z ťahu: rovno, roh), cena, `B` s naposledy použitým typom, prestavba
// typu (štítok „Prestavba“, refundácia v hotovosti) a Esc / opakovaný klik. Screenshoty: `f3-road-build.png` (ghost
// jednosmerky so šípkami a štítkom uprostred ťahu), `f3-road-rebuild.png` (štítok prestavby).
// Súradnice pre myš dáva `window.__sim.cellToScreen` (stred bunky v súradniciach stránky, dev hook).

test.describe.configure({ timeout: 120_000 });

/** Ťah 1 (rovno + roh): (32,20) → (38,20) na východ, potom (38,20) → (38,23) na juh. Riadky 20–23 sú na starter parcele voľné. */
const STROKE_A = { from: { x: 32, y: 20 }, corner: { x: 38, y: 20 }, to: { x: 38, y: 23 } } as const;
/** Ťah 2 (na západ, rovno) o riadok 25 nižšie; drží sa počas snímky. */
const STROKE_B = { from: { x: 40, y: 25 }, to: { x: 35, y: 25 } } as const;
/** Kroky `mouse.move` medzi bodmi ťahu — viac udalostí ako buniek, ako pri skutočnej myši. */
const DRAG_STEPS = 12;

const ONE_WAY_PRICE = '$1,500 / bunka';

const map = (page: Page): Locator => page.locator('.app__map');
const bar = (page: Page): Locator => page.getByRole('contentinfo', { name: 'Stavba' });
const tip = (page: Page): Locator => page.locator('[data-field="build-tip"]');
const cash = (page: Page): Promise<number> => page.evaluate(() => window.__sim!.world.cashCents);

async function openGame(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.cellToScreen !== undefined && window.__sim.rendered !== undefined && window.__sim.centerOn !== undefined);
  return errors;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function screen(page: Page, cell: { readonly x: number; readonly y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]) => window.__sim!.cellToScreen!(x, y), [cell.x, cell.y] as const);
}

/** Roh a smer buniek zo živej mriežky sveta. */
function cellsOf(page: Page, cells: readonly { x: number; y: number }[]) {
  return page.evaluate(
    (list) =>
      list.map(({ x, y }) => {
        const cell = window.__sim!.world.grid.at(x, y);
        return { road: cell.road, kind: cell.roadKind, dir: cell.roadDir };
      }),
    cells,
  );
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const rendered = (page: Page) => page.evaluate(() => window.__sim!.rendered!());

/** Ťah ľavým tlačidlom po zadaných bodoch; `release: false` nechá tlačidlo stlačené (na snímku uprostred ťahu). */
async function dragThrough(page: Page, points: readonly { x: number; y: number }[], release = true): Promise<void> {
  const [first, ...rest] = points;
  const start = await screen(page, first!);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(map(page)).toHaveAttribute('data-input-state', 'build_place');
  for (const point of rest) {
    const target = await screen(page, point);
    await page.mouse.move(target.x, target.y, { steps: DRAG_STEPS });
  }
  if (release) await page.mouse.up();
}

test.describe('F3: výber typu cesty a jednosmerný ťah (T03-20)', () => {
  test('Landside: výber jednosmerky, ťah po rovine a rohu, šípky a štítok na ghoste, smery v gride, B, prestavba, Esc', async ({ page }) => {
    const errors = await openGame(page);
    await page.evaluate(() => window.__sim!.centerOn!(37, 23, 1));
    await settle(page);

    // 1) BuildBar: Landside je povolená; tri typy ciest s cenou za bunku, potom moduly z defov (F4: brána, stojisko, rampa)
    await bar(page).locator('[data-category="landside"]').click();
    await expect(bar(page).locator('[data-category="landside"]')).toBeEnabled();
    const item = (defId: string): Locator => bar(page).locator(`[data-def-id="${defId}"]`);
    // R1 (ADR-037 bod 12): BuildBar ponúka len jednosmerku, dvojpruhová a jednopruhová cesta v ňom nie sú
    await expect(item('road_two_lane')).toHaveCount(0);
    await expect(item('road_one_lane')).toHaveCount(0);
    await expect(item('road_one_way')).toContainText('Jednosmerná cesta');
    await expect(item('road_one_way')).toContainText(ONE_WAY_PRICE);
    // F4 (T04-08): brána, stojisko a rampa sú skutočné položky z defov (nie zástupné „čoskoro (F4)“)
    for (const [defId, name, price] of [
      ['truck_gate', 'Brána kamiónov', '$80,000'],
      ['truck_waiting_area', 'Čakacia plocha', '$60,000'],
      ['loading_ramp_container', 'Rampa · kontajnery', '$100,000'],
    ] as const) {
      await expect(item(defId)).toHaveAttribute('data-status', 'available');
      await expect(item(defId)).toContainText(name);
      await expect(item(defId)).toContainText(price);
      await expect(item(defId)).not.toContainText('čoskoro');
    }
    for (const placeholderId of ['gate', 'waiting_area', 'ramp']) await expect(item(placeholderId)).toHaveCount(0);
    await expect(map(page)).toHaveAttribute('data-input-state', 'idle');

    // 2) klik na „Jednosmerná cesta“ zapne build mód ciest; položka svieti; opakovaný klik ho vypne
    await item('road_one_way').click();
    await expect(map(page)).toHaveAttribute('data-input-state', 'build');
    await expect(item('road_one_way')).toHaveAttribute('aria-pressed', 'true');
    await item('road_one_way').click();
    await expect(map(page)).toHaveAttribute('data-input-state', 'idle');
    await expect(item('road_one_way')).toHaveAttribute('aria-pressed', 'false');
    await item('road_one_way').click();
    await expect(map(page)).toHaveAttribute('data-input-state', 'build');

    // 3) ťah 1: rovno na východ, potom roh na juh; uprostred ťahu ghost so šípkami a štítok s typom, počtom a cenou
    const cashBefore = await cash(page);
    const corner = await screen(page, STROKE_A.corner);
    const start = await screen(page, STROKE_A.from);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(corner.x, corner.y, { steps: DRAG_STEPS });
    await expect(tip(page)).toHaveText('Jednosmerná cesta · 7 buniek · $10,500 · → východ');
    expect((await rendered(page)).ghostArrows).toBe(7);
    const end = await screen(page, STROKE_A.to);
    await page.mouse.move(end.x, end.y, { steps: DRAG_STEPS });
    await expect(tip(page)).toHaveText('Jednosmerná cesta · 10 buniek · $15,000 · ↓ juh');
    expect((await rendered(page)).ghostArrows).toBe(10);
    expect((await rendered(page)).ghostCells).toBe(10);
    await page.mouse.up();

    // po pustení: validate → dispatch; sim príkaz použije v ďalšom ticku
    await expect.poll(() => cash(page)).toBe(cashBefore - 10 * 150_000);
    const rowA = range(STROKE_A.from.x, STROKE_A.corner.x).map((x) => ({ x, y: STROKE_A.from.y }));
    const colA = range(STROKE_A.from.y + 1, STROKE_A.to.y).map((y) => ({ x: STROKE_A.corner.x, y }));
    const cellsA = await cellsOf(page, [...rowA, ...colA]);
    expect(cellsA.every((cell) => cell.road === 'road' && cell.kind === 'one_way')).toBe(true);
    // rovno: smer E; v rohu (38,20) smer do ďalšej bunky = S; zvyšok stĺpca S
    expect(cellsA.map((cell) => cell.dir)).toEqual(['E', 'E', 'E', 'E', 'E', 'E', 'S', 'S', 'S', 'S']);

    // 4) ghost po pustení už šípky nemá; Esc ukončí mód; B spustí naposledy použitý typ (jednosmerka), svieti položka
    await page.mouse.move(0, 0);
    await settle(page);
    expect((await rendered(page)).ghostArrows).toBe(0);
    await page.keyboard.press('Escape');
    await expect(map(page)).toHaveAttribute('data-input-state', 'idle');
    await expect(item('road_one_way')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('KeyB');
    await expect(map(page)).toHaveAttribute('data-input-state', 'build');
    await expect(item('road_one_way')).toHaveAttribute('aria-pressed', 'true');

    // 5) ťah 2 na západ: ghost so šípkami W a štítkom drží stlačené tlačidlo počas snímky
    await dragThrough(page, [STROKE_B.from, STROKE_B.to], false);
    await expect(tip(page)).toHaveText('Jednosmerná cesta · 6 buniek · $9,000 · ← západ');
    expect((await rendered(page)).ghostArrows).toBe(6);
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-build.png', fullPage: true });
    await page.mouse.up();
    const rowB = range(STROKE_B.to.x, STROKE_B.from.x).map((x) => ({ x, y: STROKE_B.from.y }));
    await expect.poll(async () => (await cellsOf(page, rowB)).every((cell) => cell.kind === 'one_way')).toBe(true);
    expect((await cellsOf(page, rowB)).map((cell) => cell.dir)).toEqual(Array<string>(rowB.length).fill('W'));

    // 6) R otočí smer 1-bunkového ťahu: posledný smer ťahu bol W, R → N; jediná bunka dostane N
    await page.keyboard.press('KeyR');
    const single = { x: 44, y: 20 };
    const singlePoint = await screen(page, single);
    await page.mouse.move(singlePoint.x, singlePoint.y);
    await expect(tip(page)).toHaveText('Jednosmerná cesta · 1 bunka · $1,500 · ↑ sever (R otočí)');
    await page.mouse.click(singlePoint.x, singlePoint.y);
    await expect.poll(async () => (await cellsOf(page, [single]))[0]?.kind).toBe('one_way');
    expect((await cellsOf(page, [single]))[0]?.dir).toBe('N');

    // 7) prestavba: jednosmerka v opačnom smere cez časť ťahu 1 (E → W) — štítok „Prestavba“, cena = stavba − refundácia
    await page.keyboard.press('Escape');
    await item('road_one_way').click();
    await expect(item('road_one_way')).toHaveAttribute('aria-pressed', 'true');
    const rebuildCash = await cash(page);
    await page.mouse.move((await screen(page, { x: 35, y: 20 })).x, (await screen(page, { x: 35, y: 20 })).y);
    await page.mouse.down();
    await page.mouse.move((await screen(page, { x: 32, y: 20 })).x, (await screen(page, { x: 32, y: 20 })).y, { steps: DRAG_STEPS });
    // 4 bunky: stavba 4 × $1,500 = $6,000; refundácia 50 % z 4 × $1,500 = $3,000; čisto $3,000
    await expect(tip(page)).toHaveText('Jednosmerná cesta · 4 bunky · Prestavba: $6,000, vrátené $3,000 (čisto $3,000) · ← západ');
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f3-road-rebuild.png', fullPage: true });
    await page.mouse.up();
    await expect.poll(() => cash(page)).toBe(rebuildCash - (4 * 150_000 - 300_000));
    const rebuilt = await cellsOf(page, range(32, 35).map((x) => ({ x, y: 20 })));
    expect(rebuilt.every((cell) => cell.kind === 'one_way' && cell.dir === 'W')).toBe(true);
    // zvyšok ťahu 1 ostal v pôvodnom smere
    expect((await cellsOf(page, [{ x: 36, y: 20 }]))[0]).toMatchObject({ kind: 'one_way', dir: 'E' });

    // 8) Esc ukončí mód a zhasne položku
    await page.keyboard.press('Escape');
    await expect(map(page)).toHaveAttribute('data-input-state', 'idle');
    await expect(item('road_one_way')).toHaveAttribute('aria-pressed', 'false');

    expect(errors).toEqual([]);
  });
});
