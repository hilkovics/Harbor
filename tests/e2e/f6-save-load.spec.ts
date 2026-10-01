import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// F6 e2e (T06-03b): ukladanie a načítanie v skutočnej hre. Nová hra → kontrakt prijatý v paneli Kontrakty → 8× kým loď
// nevykladá → pauza → Ctrl+S → reload stránky → Uložiť/načítať → Načítať slot 1 → HUD (hotovosť, deň a čas) aj celý stav
// sveta (`world.serialize()`) sú zhodné s tým pred uložením a hra je pozastavená; potom Nastavenia (zmena sa uloží do
// localStorage). Druhý test: export (stiahnutý súbor) → nová hra → import súboru → rovnaký HUD; chybný súbor svet nezmení.
// Aj tu je overené, že kým je overlay otvorený, herné klávesy (Space…) nič nerobia ani pri fokuse mimo dialógu a Esc ho zavrie.
//
// Screenshoty (gitignorované): `f6-saves-panel.png` (otvorený dialóg), `f6-settings-panel.png`, `f6-loaded.png`
// (načítaná pozastavená hra s toastom „Načítané“), `f6-import-error.png` (chybný import: toast nad dialógom).

const SHOTS = 'tests/e2e/__screenshots__';
/** Loď príde o 0,5–2 herného dňa (pri 8× ≈ 108 s reálneho času na deň), potom začne vykládka. */
const SHIP_WAIT_MS = 5.5 * 60_000;
test.describe.configure({ timeout: 8 * 60_000 });

/** Chyby stránky (pageerror, console.error) zbierané počas testu; test ich na konci vyžaduje prázdne. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** Počká na bežiacu hru: canvas, dev hook s rendererom a ponuky kontraktov. */
async function waitForGame(page: Page): Promise<void> {
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.contracts().length > 0);
}

/** Dva vykreslené snímky za sebou: renderer stihol prekresliť stav sveta a UI. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Skutočný klik na tlačidlo rýchlosti v HUD (0 = pauza). */
async function setSpeed(page: Page, speed: number): Promise<void> {
  const button = page.locator(`[data-field="speed"] button[data-speed="${String(speed)}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Hotovosť, deň a čas tak, ako ich ukazuje HUD. */
async function readHud(page: Page): Promise<{ readonly cash: string; readonly time: string }> {
  return {
    cash: (await page.locator('[data-field="cash"]').textContent()) ?? '',
    time: (await page.locator('[data-field="time"]').textContent()) ?? '',
  };
}

/** Pozastaví hru a počká, kým sa stav sveta aj HUD ustália (HUD sa prekresľuje po 100 ms). */
async function pauseAndSettle(page: Page): Promise<void> {
  await setSpeed(page, 0);
  await page.waitForFunction(() => window.__sim!.world.clock.speed === 0);
  await page.waitForTimeout(300);
  await settle(page);
}

/** Celý stav sveta ako text (`World.serialize()` je deterministický, zhoda textov = zhoda stavu). */
function worldJson(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify(window.__sim!.world.serialize()));
}

const saveDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Uložiť a načítať hru' });
const settingsDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Nastavenia' });
const toast = (page: Page, title: string): Locator => page.locator('.toasts .toast').filter({ hasText: title });
const slotRow = (page: Page, slot: string): Locator => saveDialog(page).locator(`li.save-slot[data-slot="${slot}"]`);
const slotLoad = (page: Page, slot: string): Locator => slotRow(page, slot).locator('[data-action="load"]');

async function openSaves(page: Page): Promise<void> {
  await page.locator('[data-field="panel-saves"]').click();
  await expect(saveDialog(page)).toBeVisible();
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Hra po načítaní: pozastavená (banner + aktívna pauza), HUD aj stav sveta zhodné s uloženými, overlay zmizol. */
async function expectLoaded(page: Page, expected: { readonly hud: { readonly cash: string; readonly time: string }; readonly world: string }): Promise<void> {
  await expect(toast(page, 'Načítané')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-field="paused-banner"]')).toBeVisible();
  await expect(page.locator('[data-field="speed"] button[data-speed="0"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-field="cash"]')).toHaveText(expected.hud.cash);
  await expect(page.locator('[data-field="time"]')).toHaveText(expected.hud.time);
  expect(await worldJson(page)).toBe(expected.world);
}

test('F6: uloženie počas vykládky (Ctrl+S) → reload → načítanie slotu 1 → rovnaký HUD a stav, hra pozastavená; nastavenia', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForGame(page);

  // 1) kontrakt prijatý klikom v paneli Kontrakty
  await page.locator('[data-field="panel-contracts"]').click();
  const contracts = page.getByRole('complementary', { name: 'Kontrakty' });
  await expect(contracts).toBeVisible();
  await contracts.locator('article.contract-card [data-action="accept"]').first().click();
  await expect(contracts.getByRole('tab', { name: /Aktívne/ })).toHaveText('Aktívne · 1');
  await page.keyboard.press('Escape');
  await expect(contracts).toHaveCount(0);

  // 2) 8× kým žeriav nevykladá loď (kontrakt `unloading`, žeriav v niektorej fáze zdvihu), potom pauza
  await setSpeed(page, 8);
  await page.waitForFunction(
    () => {
      const sim = window.__sim!;
      const unloading = sim.contracts().some((contract) => contract.state === 'unloading');
      return unloading && sim.entities().cranes.some((crane) => crane.state !== 'idle' && crane.state !== 'blocked');
    },
    null,
    { polling: 'raf', timeout: SHIP_WAIT_MS },
  );
  await pauseAndSettle(page);
  const hud = await readHud(page);
  const world = await worldJson(page);
  const saved = await page.evaluate(() => ({
    tick: window.__sim!.world.clock.tick,
    ships: window.__sim!.entities().ships.length,
    unloaded: window.__sim!.contracts().reduce((sum, contract) => sum + contract.unitsUnloaded, 0),
  }));
  expect(saved.ships).toBe(1);
  expect(hud.time).toMatch(/^Deň \d+ · \d\d:\d\d$/);

  // 3) Ctrl+S: rýchle uloženie do slotu 1 (toast, kľúč v localStorage); hra ostáva pozastavená
  await page.keyboard.press('Control+S');
  await expect(toast(page, 'Uložené')).toContainText('Slot 1');
  expect(await page.evaluate(() => localStorage.getItem('mh.save.1') !== null)).toBe(true);
  expect(await worldJson(page)).toBe(world); // uloženie stav sveta nemení

  // 4) reload = nová hra; „iná karta“ medzitým zapísala slot 2 (otvorenie panelu ho musí prečítať znova)
  await page.reload();
  await waitForGame(page);
  expect(await page.evaluate(() => window.__sim!.world.clock.tick)).toBeLessThan(saved.tick); // nová hra, nie uložená
  await page.evaluate(() => localStorage.setItem('mh.save.2', localStorage.getItem('mh.save.1')!));
  await openSaves(page);
  await expect(slotRow(page, '1').locator('[data-field="slot-time"]')).toContainText(hud.time);
  await expect(slotRow(page, '1').locator('[data-field="slot-cash"]')).toContainText(hud.cash);
  await expect(slotRow(page, '2')).toHaveAttribute('data-empty', 'false');
  await expect(slotRow(page, '3')).toHaveAttribute('data-empty', 'true');
  await expect(slotLoad(page, '1')).toBeEnabled();
  await expect(slotLoad(page, '3')).toBeDisabled();
  await screenshot(page, 'f6-saves-panel');

  // 5) pod otvoreným overlayom herné klávesy nič nerobia, ani keď fokus nie je v dialógu (klik na zásterku); Esc zavrie
  await page.waitForFunction(() => window.__sim!.world.clock.speed === 1);
  await page.mouse.click(8, 400); // zásterka mimo dialógu → fokus na body
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  for (const key of ['Space', 'Digit4', 'KeyB', 'KeyC']) await page.keyboard.press(key);
  await settle(page);
  expect(await page.evaluate(() => window.__sim!.world.clock.speed)).toBe(1);
  await expect(page.locator('[data-field="paused-banner"]')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Kontrakty' })).toHaveCount(0);
  await expect(page.locator('.app__map')).not.toHaveAttribute('data-input-state', /^build/);
  await page.keyboard.press('Escape');
  await expect(saveDialog(page)).toHaveCount(0);
  await openSaves(page);
  await page.keyboard.press('Escape'); // aj s fokusom v dialógu
  await expect(saveDialog(page)).toHaveCount(0);
  await openSaves(page);

  // 6) načítanie slotu 1: reštart v pauze, toast „Načítané“, HUD aj stav sveta zhodné s uloženými
  await slotLoad(page, '1').click();
  await expectLoaded(page, { hud, world });
  expect(await page.evaluate(() => window.__sim!.world.clock.tick)).toBe(saved.tick);
  expect(await page.evaluate(() => window.__sim!.entities().ships.length)).toBe(saved.ships);
  expect(await page.evaluate(() => window.__sim!.contracts().reduce((sum, contract) => sum + contract.unitsUnloaded, 0))).toBe(saved.unloaded);
  await screenshot(page, 'f6-loaded');

  // pauza sa dá zrušiť a loď pokračuje vo vykládke tam, kde skončila (načítaný svet žije ďalej)
  await setSpeed(page, 1);
  await page.waitForFunction((tick) => window.__sim!.world.clock.tick > tick + 20, saved.tick);

  // 7) Nastavenia: zmena predvolenej rýchlosti a autosave sa uloží do localStorage; Zrušiť nezmení nič
  await page.locator('[data-field="panel-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
  await settingsDialog(page).locator('[data-field="default-speed"] button[data-value="4"]').click();
  await settingsDialog(page).locator('[data-field="autosave"] button[data-value="3"]').click();
  await expect(settingsDialog(page).locator('[data-field="default-speed"] button[data-value="4"]')).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, 'f6-settings-panel');
  await settingsDialog(page).locator('[data-action="cancel"]').click();
  await expect(settingsDialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('mh.settings'))).toBeNull();
  await page.locator('[data-field="panel-settings"]').click();
  await settingsDialog(page).locator('[data-field="default-speed"] button[data-value="4"]').click();
  await settingsDialog(page).locator('[data-field="autosave"] button[data-value="3"]').click();
  await settingsDialog(page).locator('[data-action="save"]').click();
  await expect(settingsDialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mh.settings') ?? 'null'))).toEqual({
    settingsVersion: 1,
    defaultSpeed: 4,
    autosaveEveryDays: 3,
    sound: false,
  });
  await page.locator('[data-field="panel-settings"]').click();
  await expect(settingsDialog(page).locator('[data-field="default-speed"] button[aria-pressed="true"]')).toHaveText('4×');
  await page.keyboard.press('Escape');

  // nová hra po uložení nastavení štartuje s predvolenou rýchlosťou 4×
  await page.reload();
  await waitForGame(page);
  await expect(page.locator('[data-field="speed"] button[data-speed="4"]')).toHaveAttribute('aria-pressed', 'true');

  expect(errors).toEqual([]);
});

test('F6: export do súboru → nová hra → import súboru → rovnaký HUD a stav; chybný súbor svet nezmení', async ({ page }, testInfo: TestInfo) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await waitForGame(page);

  // hra, ktorá sa líši od novej: postavená cesta (iná hotovosť), prijatý kontrakt, ~pol hodiny hernej hodiny na 8×
  const road = await page.evaluate(() =>
    window.__sim!.dispatchJSON!({ type: 'PlaceRoad', cells: [41, 42, 43, 44].map((x) => ({ x, y: 22 })) }),
  );
  expect(road.ok).toBe(true);
  expect(await page.evaluate(() => window.__sim!.acceptFirstOffer())).not.toBeNull();
  await setSpeed(page, 8);
  await page.waitForFunction(() => window.__sim!.world.clock.tick > 900, null, { polling: 'raf' });
  await pauseAndSettle(page);
  const hud = await readHud(page);
  const world = await worldJson(page);
  expect(hud.cash).not.toBe('$1,200,000');
  expect(hud.time).not.toBe('Deň 1 · 00:00');

  // export aktuálnej hry: stiahne sa `modular-harbor-<deň>-current.json` s obálkou savu
  await openSaves(page);
  const downloadPromise = page.waitForEvent('download');
  await saveDialog(page).locator('[data-action="export"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^modular-harbor-\d+-current\.json$/);
  const file = testInfo.outputPath('export.json');
  await download.saveAs(file);
  const exported = JSON.parse(readFileSync(file, 'utf8')) as { format: string; saveVersion: number; preview: { cashCents: number; day: number }; world: { version: number } };
  expect(exported).toMatchObject({ format: 'modular-harbor-save', saveVersion: 1 });
  expect(exported.preview.cashCents).toBe(await page.evaluate(() => window.__sim!.world.cashCents));
  await expect(toast(page, 'Exportované')).toHaveCount(1);
  expect(await worldJson(page)).toBe(world); // export stav sveta nemení

  // nová hra (reload): HUD je východiskový; chybný súbor → toast „Import zlyhal“, svet aj dialóg ostávajú
  await page.reload();
  await waitForGame(page);
  const fresh = await readHud(page);
  expect(fresh.cash).toBe('$1,200,000');
  await openSaves(page);
  const input = saveDialog(page).locator('[data-field="import-input"]');
  await input.setInputFiles({ name: 'zle.json', mimeType: 'application/json', buffer: Buffer.from('toto nie je uložená hra') });
  await expect(toast(page, 'Import zlyhal')).toHaveCount(1);
  await expect(toast(page, 'Import zlyhal')).toContainText('JSON');
  await expect(saveDialog(page)).toBeVisible();
  // toast s chybou je nad zásterkou dialógu (inak by ho hráč pri otvorenom dialógu nevidel)
  const failure = toast(page, 'Import zlyhal');
  expect(await failure.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
  await screenshot(page, 'f6-import-error');
  expect(await page.evaluate(() => window.__sim!.world.clock.speed)).toBe(1); // hra beží ďalej nezmenená
  expect((await readHud(page)).cash).toBe(fresh.cash);

  // správny súbor, reštart v pauze (obsah ide ako buffer: `setInputFiles` s cestou k stiahnutému súboru po predchádzajúcom
  // importe v Playwrighte nevyvolalo `change`, čo s aplikáciou nesúvisí — udalosť v stránke vôbec nenastala)
  await input.setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expectLoaded(page, { hud, world });
  expect(await page.evaluate(() => window.__sim!.world.cashCents)).toBe(exported.preview.cashCents);

  expect(errors).toEqual([]);
});
