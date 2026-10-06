import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatMoney, formatMoneyDelta } from '../../src/ui/format';

// F5 e2e (T05-09): míľnik M1 z pohľadu hráča — nová hra → prijatie kontraktu v UI → loď príde sama → vykládka → export
// → výplata. Rozloženie F4 (cesty, depo, dva dvory, brána, stojisko, rampa, dve vozidlá) ide cez `dispatchJSON`
// (príkazy zo `data/scenarios/vertical_slice.json`), kontrakt sa prijíma klikom na „Prijať“ v ContractsPanel. Loď
// nevytvára žiadny DEV príkaz: vygeneruje ju sám prijatý kontrakt (`ship_en_route`). Na stavy kontraktu sa čaká cez
// `window.__sim.contracts()` (vzorkovanie v rAF stránky, aby test videl každý prechod) pri rýchlosti 8×; po
// `completed` sa hra zastaví, aby toast výplaty nezmizol pred kontrolou.
//
// Screenshoty: `f5-contracts.png` (panel s ponukami pred prijatím), `f5-payout.png` (po výplate: toast, HUD, História).
//
// Moduly majú id v poradí stavby: Root berth 1, žeriav 2, depo 3 (viď f4-export-chain.spec.ts).

/** Loď príde o 0,5–2 herného dňa (pri 8× ≈ 108 s reálneho času na deň) a potom sa vykladá a exportuje. */
const WAIT_LIMIT_MS = 6.5 * 60_000;
test.describe.configure({ timeout: 8 * 60_000 });

const DEPOT_ID = 3;
const VEHICLES = 2;
const SHIP_PATH = ['accepted', 'ship_en_route', 'unloading', 'exporting', 'completed'] as const;

type Cell = { readonly x: number; readonly y: number };

/** Cesty F3 + pozemnej časti F4 ako úseky `[x0, y0, x1, y1]` (rovnaké ako vo `vertical_slice.json`). */
const ROAD_SEGMENTS: readonly (readonly [number, number, number, number])[] = [
  [41, 17, 41, 22],
  [46, 17, 46, 22],
  [42, 22, 45, 22],
  [42, 17, 45, 17],
  [44, 23, 44, 30],
  [45, 30, 50, 30],
  [44, 33, 44, 33],
  [47, 33, 48, 33],
  [53, 31, 53, 33],
  [51, 30, 55, 30],
];

/** Moduly rozloženia v poradí stavby (id 2 = žeriav berthu, preto depo dostane id 3). */
const MODULES: readonly { readonly defId: string; readonly x: number; readonly y: number; readonly rotation: number }[] = [
  { defId: 'vehicle_depot', x: 46, y: 27, rotation: 0 },
  { defId: 'container_yard_small', x: 42, y: 18, rotation: 0 },
  { defId: 'container_yard_small', x: 49, y: 26, rotation: 0 },
  { defId: 'truck_gate', x: 45, y: 32, rotation: 270 },
  { defId: 'truck_waiting_area', x: 49, y: 31, rotation: 0 },
  { defId: 'loading_ramp_container', x: 53, y: 28, rotation: 0 },
];

/** Pohľad na celý prístav: zoom 0,5 (bunka 32 px), stred posunutý doľava od pravého panelu kontraktov. */
const OVERVIEW = { x: 49, y: 23.5, zoom: 0.5 } as const;

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
    () => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined && window.__sim.contracts().length > 0,
  );
  return errors;
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta a UI. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function view(page: Page, x: number, y: number, zoom: number): Promise<void> {
  await page.evaluate(([cx, cy, z]) => window.__sim!.centerOn!(cx, cy, z), [x, y, zoom] as const);
  await settle(page);
}

/** Kliknutie na tlačidlo rýchlosti v HUD (skutočný klik myšou). */
async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function dispatch(page: Page, command: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  return page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
}

const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'Kontrakty' });
const cashCents = (page: Page) => page.evaluate(() => window.__sim!.world.cashCents);

test.describe('F5: nová hra → kontrakt → loď → vykládka → export → výplata (T05-09, M1)', () => {
  test('kontrakt prijatý v UI prejde ship_en_route → unloading → exporting → completed, HUD ukáže výplatu a XP', async ({ page }) => {
    const errors = await openGame(page);
    await view(page, OVERVIEW.x, OVERVIEW.y, OVERVIEW.zoom);
    const cashStart = await cashCents(page);

    // 1) rozloženie F4 cez dispatchJSON (bez lode: tú prinesie až kontrakt)
    for (const segment of ROAD_SEGMENTS) {
      expect(await dispatch(page, { type: 'PlaceRoad', cells: segmentCells(segment) })).toMatchObject({ ok: true });
    }
    // R1 (ADR-037): obojsmerný úsek (44, 34–36) k bráne a bez (45, 34–35), ako v scenári `full_import_chain` (jednosmerná slučka verejnej cesty)
    expect(await dispatch(page, { type: 'PlaceRoad', kind: 'two_lane', cells: [{ x: 44, y: 34 }, { x: 44, y: 35 }, { x: 44, y: 36 }] })).toMatchObject({ ok: true });
    expect(await dispatch(page, { type: 'RemoveRoad', cells: [{ x: 45, y: 34 }, { x: 45, y: 35 }] })).toMatchObject({ ok: true });
    await page.waitForFunction(() => window.__sim!.world.grid.at(44, 36).roadKind === 'two_lane' && window.__sim!.world.grid.at(45, 34).road !== 'road' && window.__sim!.world.grid.at(45, 35).road !== 'road');
    for (const module of MODULES) expect(await dispatch(page, { type: 'PlaceModule', ...module })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => window.__sim!.entities().modules.length)).toBe(1 + MODULES.length);
    for (let bought = 1; bought <= VEHICLES; bought += 1) {
      expect(await dispatch(page, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID })).toMatchObject({ ok: true });
    }
    await expect.poll(() => page.evaluate(() => window.__sim!.world.vehicles.size)).toBe(VEHICLES);
    expect(await cashCents(page)).toBeLessThan(cashStart);
    // nie je žiadna loď ani kontrakt v behu: loď príde až po prijatí
    expect(await page.evaluate(() => window.__sim!.entities().ships.length)).toBe(0);
    expect(await page.evaluate(() => window.__sim!.contracts().every((contract) => contract.state === 'offered'))).toBe(true);

    // 2) panel kontraktov cez ikonu v TopHUD; ponuka s najmenším objemom (krátky test)
    await page.locator('[data-field="panel-contracts"]').click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: /Ponuky/ })).toHaveAttribute('aria-selected', 'true');
    const offers = await page.evaluate(() => window.__sim!.contracts().filter((contract) => contract.state === 'offered'));
    expect(offers.length).toBeGreaterThan(0);
    await expect(panel(page).locator('article.contract-card')).toHaveCount(offers.length);
    const smallest = offers.reduce((best, offer) => (offer.volumeUnits < best.volumeUnits ? offer : best));
    const card = panel(page).locator(`article.contract-card[data-contract-id="${String(smallest.id)}"]`);
    await expect(card).toHaveAttribute('data-state', 'offered');
    // R2: karta ukazuje objem v TEU a rozdelenie na 20′/40′ (`12 TEU (2× 20′, 5× 40′)`), nie počet kontajnerov
    const smallestTeu = smallest.volumeTeu;
    const count40 = smallestTeu - smallest.volumeUnits;
    await expect(card.locator('[data-field="volume"]')).toContainText(`${String(smallestTeu)} TEU (${String(smallest.volumeUnits - count40)}× 20′, ${String(count40)}× 40′)`);
    await expect(card.locator('[data-field="reward"]')).toContainText(formatMoney(smallest.rewardCents).replace(/^\+/, ''));

    // screenshot: hra s panelom ponúk pred prijatím
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f5-contracts.png', fullPage: true });

    // 3) vzorkovanie stavov kontraktu v každom rAF stránky (test sa nesmie spoliehať na pevné timeouty)
    await page.evaluate((id) => {
      const seen = new Set<string>();
      (window as unknown as { __contractStatesSeen: Set<string> }).__contractStatesSeen = seen;
      const sample = (): void => {
        const contract = window.__sim!.contracts().find((candidate) => candidate.id === id);
        if (contract !== undefined) seen.add(contract.state);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, smallest.id);

    // 4) Prijať cez UI: kontrakt je v sime `accepted` (alebo už `ship_en_route`), karta sa presunie do Aktívnych
    await card.locator('[data-action="accept"]').click();
    await expect
      .poll(() => page.evaluate((id) => window.__sim!.contracts().find((contract) => contract.id === id)?.state, smallest.id))
      .toMatch(/^(accepted|ship_en_route)$/);
    await expect(page.locator('.toasts .toast').filter({ hasText: 'Kontrakt prijatý' })).toHaveCount(1);
    await expect(panel(page).getByRole('tab', { name: /Aktívne/ })).toHaveText('Aktívne · 1');
    await expect(card).toHaveCount(0); // záložka Ponuky už kartu nemá
    await panel(page).getByRole('tab', { name: /Aktívne/ }).click();
    const active = panel(page).locator(`article.contract-card[data-contract-id="${String(smallest.id)}"]`);
    await expect(active).toHaveAttribute('data-tab', 'active');
    await expect(active.locator('[data-field="status"]')).toHaveText(/Prijaté|Loď na ceste/);
    const { cashAccepted, entriesAtAccept } = await page.evaluate(() => ({ cashAccepted: window.__sim!.world.cashCents, entriesAtAccept: window.__sim!.world.economy.entries.length }));

    // 5) 8×; čaká sa na `completed` (hra sa v tom istom rAF zastaví, aby toast výplaty nezmizol)
    await setSpeed(page, 8);
    await page.waitForFunction(
      (id) => {
        const contract = window.__sim!.contracts().find((candidate) => candidate.id === id);
        const done = contract?.state === 'completed' || contract?.state === 'failed';
        if (done) window.__sim!.world.clock.setSpeed(0);
        return done;
      },
      smallest.id,
      { timeout: WAIT_LIMIT_MS, polling: 'raf' },
    );

    // 5b) hneď po zastavení (toast sa po `TOAST_AUTO_CLOSE_MS` reálneho času zavrie sám): História s kartou „Splnené“,
    //     toast „Kontrakt splnený“ s výplatou a XP a screenshot po výplate
    await panel(page).getByRole('tab', { name: /História/ }).click();
    const history = panel(page).locator(`article.contract-card[data-contract-id="${String(smallest.id)}"]`);
    await expect(history).toHaveAttribute('data-state', 'completed');
    await expect(history).toHaveAttribute('data-tab', 'history');
    await expect(history.locator('[data-field="status"]')).toHaveText(/Splnené/);
    const payoutToast = page.locator('.toasts .toast').filter({ hasText: 'Kontrakt splnený' });
    await expect(payoutToast).toHaveCount(1);
    const settled = await page.evaluate((id) => window.__sim!.contracts().find((contract) => contract.id === id)!, smallest.id);
    const paid = settled.rewardCents - settled.penaltiesCents;
    await expect(payoutToast.locator('[data-field="toast-text"]')).toContainText(formatMoneyDelta(paid));
    await expect(payoutToast.locator('[data-field="toast-text"]')).toContainText('XP');
    await page.mouse.move(0, 0);
    await settle(page);
    await page.screenshot({ path: 'tests/e2e/__screenshots__/f5-payout.png', fullPage: true });

    // 6) kontrakt prešiel celým životným cyklom a skončil `completed` (nie `failed`)
    const end = await page.evaluate(([id, entriesAtAccept]) => {
      const { world } = window.__sim!;
      world.cargo.assertConservation();
      return {
        contract: window.__sim!.contracts().find((candidate) => candidate.id === id)!,
        seen: [...(window as unknown as { __contractStatesSeen: Set<string> }).__contractStatesSeen],
        cashCents: world.cashCents,
        revenue: world.economy.entries.filter((entry) => entry.category === 'contract_revenue').map((entry) => entry.amountCents),
        netSinceAccept: world.economy.entries.slice(entriesAtAccept).reduce((sum, entry) => sum + entry.amountCents, 0),
        xp: world.xp,
        created: world.cargo.createdCount,
        exported: world.cargo.exportedCount,
        live: world.cargo.liveCount,
        ships: window.__sim!.entities().ships.length,
        trucks: window.__sim!.entities().trucks.length,
      };
    }, [smallest.id, entriesAtAccept] as const);
    expect(end.contract.state).toBe('completed');
    for (const state of SHIP_PATH) expect(end.seen, `kontrakt prešiel stavom ${state}`).toContain(state);
    expect(end.seen).not.toContain('failed');
    // žiadna stratená jednotka: všetko, čo loď priniesla, bolo vyložené aj exportované (lostUnits = 0)
    expect(end.contract.unitsUnloaded).toBe(smallest.volumeUnits);
    expect(end.contract.unitsExported).toBe(smallest.volumeUnits);
    expect(end.created).toBe(smallest.volumeUnits);
    expect(end.exported).toBe(smallest.volumeUnits);
    expect(end.live).toBe(0);
    expect(end.created - end.exported - end.live).toBe(0);
    // výplata a XP sú v svete
    expect(end.xp).toBeGreaterThan(0);
    expect(paid).toBeGreaterThan(0);
    // výplata je v účtovnej knihe práve raz ako `contract_revenue` a hotovosť svetu stúpla o ňu (údržba a mzdy idú inou kategóriou)
    expect(end.revenue).toEqual([end.contract.rewardCents]);
    expect(end.cashCents).toBe(cashAccepted + end.netSinceAccept);

    // 7) HUD = svet: hotovosť ako formatMoney(world.cashCents), XP > 0
    await expect(page.locator('[data-field="cash"]')).toHaveText(formatMoney(end.cashCents));
    const hudXp = await page.locator('[data-field="xp"]').innerText();
    expect(hudXp).toMatch(/^[1-9][\d\s.,]* XP$/);

    // sim v DEV hlási porušenie konzervácie do konzoly — nesmie byť žiadna chyba ani výnimka
    expect(errors).toEqual([]);
  });
});
