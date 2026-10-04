import { expect, test, type Locator, type Page } from '@playwright/test';

// T06-04: demo stránka s overlayom Nastavenia a Uložiť/načítať (statické dáta, žiadna simulácia ani úložisko). Dev server
// servíruje src/ui/__demo__/f6-ui-demo.html. Screenshoty slúžia na vizuálnu kontrolu voči prototypu
// design/ui/game-ui.source.html (overlay `settings`); test overuje aj klávesnicu (fokus, Tab v dialógu, Esc), mazanie
// s potvrdením a import cez skrytý input.
const DEMO_URL = '/src/ui/__demo__/f6-ui-demo.html';
const SCREENSHOTS = 'tests/e2e/__screenshots__';

const saveDialog = (scope: Page | Locator): Locator => scope.getByRole('dialog', { name: 'Uložiť a načítať hru' });
const settingsDialog = (scope: Page | Locator): Locator => scope.getByRole('dialog', { name: 'Nastavenia' });

/** Počet Tab-ov, po ktorých sa fokus musí vrátiť na východisko (dialóg zalomí Tab), a že fokus nikdy neopustí dialóg. */
async function expectTabStaysInside(page: Page, dialog: Locator, steps: number, key: 'Tab' | 'Shift+Tab'): Promise<void> {
  for (let step = 0; step < steps; step++) {
    await page.keyboard.press(key);
    const inside = await dialog.evaluate((element) => element.contains(element.ownerDocument.activeElement));
    expect(inside, `${key} #${String(step + 1)} ostal v dialógu`).toBe(true);
  }
}

test('F6 UI demo: Uložiť/načítať a Nastavenia — vzhľad, klávesnica, akcie', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(DEMO_URL);
  await page.evaluate(() => document.fonts.ready);
  const stage = page.getByTestId('stage');
  await expect(stage.locator('[data-field="panel-saves"]')).toBeVisible();
  await expect(stage.getByRole('dialog')).toHaveCount(0);

  // --- Kontrolné rámiky: Uložiť a načítať ------------------------------------------------------------------------------
  const savesFrame = page.getByTestId('frame-saves');
  const framed = saveDialog(savesFrame);
  await expect(framed).toBeVisible();
  await expect(framed.locator('li.save-slot')).toHaveCount(4);
  await expect(framed.locator('li[data-slot="auto"] [data-field="slot-name"]')).toHaveText('Automatické uloženie');
  await expect(framed.locator('li[data-slot="auto"] [data-field="slot-time"] dd')).toHaveText('Deň 12 · 14:20');
  await expect(framed.locator('li[data-slot="auto"] [data-field="slot-cash"] dd')).toHaveText('$1,234,560');
  await expect(framed.locator('li[data-slot="auto"] [data-field="slot-xp"] dd')).toHaveText('340 XP');
  await expect(framed.locator('li[data-slot="auto"] [data-field="slot-cash"] dd')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(framed.locator('li[data-slot="2"] [data-field="slot-empty"]')).toHaveText('Prázdny');
  await expect(framed.locator('li[data-slot="2"] [data-action="load"]')).toBeDisabled();
  await expect(framed.locator('li[data-slot="auto"] [data-action="save"]')).toHaveCount(0);
  await expect(framed.locator('[data-action="save"]')).toHaveCount(3);
  await page.screenshot({ path: `${SCREENSHOTS}/f6-ui-demo-page.png`, fullPage: true });
  await savesFrame.locator('.f6-demo__map').screenshot({ path: `${SCREENSHOTS}/f6-saves-frame.png` });
  await page.getByTestId('frame-settings').locator('.f6-demo__map').screenshot({ path: `${SCREENSHOTS}/f6-settings-frame.png` });

  // --- Hra: ikona uloženia otvorí overlay; fokus na prvom prvku, Tab ostáva v dialógu, Esc zatvára -------------------------
  const savesButton = stage.locator('[data-field="panel-saves"]');
  await savesButton.focus();
  await savesButton.click();
  const dialog = saveDialog(stage);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.locator('[data-action="close-x"]')).toBeFocused();
  // 1 (✕) + 3 × (Načítať, Vymazať) + 3 × Uložiť + Export + Import + Zavrieť, bez disabled → cyklus musí zalomiť
  await expectTabStaysInside(page, dialog, 25, 'Tab');
  await expectTabStaysInside(page, dialog, 25, 'Shift+Tab');
  await stage.screenshot({ path: `${SCREENSHOTS}/f6-stage-saves.png` });

  // --- Uložiť do prázdneho slotu 2 ---------------------------------------------------------------------------------------------
  const slot2 = dialog.locator('li[data-slot="2"]');
  await slot2.locator('[data-action="save"]').click();
  await expect(slot2.locator('[data-field="slot-time"] dd')).toHaveText('Deň 12 · 14:20');
  await expect(slot2.locator('[data-action="load"]')).toBeEnabled();
  await expect(stage.locator('.f6-demo__map-label')).toContainText('onSave(2)');
  await slot2.locator('[data-action="load"]').click();
  await expect(stage.locator('.f6-demo__map-label')).toContainText('onLoad(2)');

  // --- Mazanie s potvrdením: Vymazať → Zrušiť nič nezmaže; Vymazať → Vymazať zmaže ------------------------------------------
  await slot2.locator('[data-action="delete"]').click();
  await expect(slot2.getByRole('group', { name: 'Potvrdenie vymazania: Slot 2' })).toBeVisible();
  await expect(slot2.locator('[data-action="delete-cancel"]')).toBeFocused();
  await expect(stage.locator('.f6-demo__map-label')).not.toContainText('onDelete');
  await slot2.screenshot({ path: `${SCREENSHOTS}/f6-slot-confirm.png` });
  await slot2.locator('[data-action="delete-cancel"]').click();
  await expect(slot2.locator('[data-action="delete"]')).toBeFocused();
  await expect(slot2.locator('[data-field="slot-time"]')).toBeVisible();
  await slot2.locator('[data-action="delete"]').click();
  await slot2.locator('[data-action="delete-confirm"]').click();
  await expect(slot2.locator('[data-field="slot-empty"]')).toHaveText('Prázdny');
  await expect(stage.locator('.f6-demo__map-label')).toContainText('onDelete(2)');

  // --- Export a import (skrytý input, súbor zo setInputFiles) -------------------------------------------------------------
  await dialog.locator('[data-action="export"]').click();
  await expect(stage.locator('.f6-demo__map-label')).toContainText('onExport()');
  const input = dialog.locator('[data-field="import-input"]');
  await expect(input).toBeHidden();
  await expect(input).toHaveAttribute('accept', '.json,application/json');
  await input.setInputFiles({ name: 'moja-hra.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(stage.locator('.f6-demo__map-label')).toContainText('onImport(moja-hra.json)');

  // --- Esc zatvorí a fokus sa vráti na ikonu ---------------------------------------------------------------------------------
  await page.keyboard.press('Escape');
  await expect(stage.getByRole('dialog')).toHaveCount(0);
  await expect(savesButton).toBeFocused();

  // --- Nastavenia: koncept sa uloží až cez Uložiť, Zrušiť ho zahodí --------------------------------------------------------
  const settingsButton = stage.locator('[data-field="panel-settings"]');
  await settingsButton.click();
  const settings = settingsDialog(stage);
  await expect(settings).toBeVisible();
  await expect(settings.locator('[data-action="close-x"]')).toBeFocused();
  await expect(settings.locator('[data-field="default-speed"] [aria-pressed="true"]')).toHaveText('1×');
  await expect(settings.locator('[data-field="autosave"] [aria-pressed="true"]')).toHaveText('Každý deň');
  await expect(settings.locator('[data-field="sound"]')).toBeDisabled();
  await expectTabStaysInside(page, settings, 14, 'Tab');
  await settings.locator('[data-field="default-speed"] [data-value="4"]').click();
  await settings.locator('[data-field="autosave"] [data-value="7"]').click();
  await expect(settings.locator('[data-field="default-speed"] [aria-pressed="true"]')).toHaveText('4×');
  await stage.screenshot({ path: `${SCREENSHOTS}/f6-stage-settings.png` });
  await settings.locator('[data-action="cancel"]').click();
  await expect(stage.getByRole('dialog')).toHaveCount(0);
  await expect(stage.locator('.f6-demo__map-label')).not.toContainText('onChange');

  await settingsButton.click();
  await expect(settings.locator('[data-field="default-speed"] [aria-pressed="true"]')).toHaveText('1×');
  await settings.locator('[data-field="default-speed"] [data-value="8"]').click();
  await settings.locator('[data-field="autosave"] [data-value="3"]').click();
  await settings.locator('[data-action="save"]').click();
  await expect(stage.getByRole('dialog')).toHaveCount(0);
  await expect(stage.locator('.f6-demo__map-label')).toContainText('onChange(speed 8×, autosave 3 d)');

  await settingsButton.click();
  await expect(settings.locator('[data-field="default-speed"] [aria-pressed="true"]')).toHaveText('8×');
  await expect(settings.locator('[data-field="autosave"] [aria-pressed="true"]')).toHaveText('Každé 3 dni');
  await page.keyboard.press('Escape');
  await expect(stage.getByRole('dialog')).toHaveCount(0);

  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(errors).toEqual([]);
});
