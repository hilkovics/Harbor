import { expect, test } from '@playwright/test';

// T02-08: demo stránka s BuildBar (Terminál) a ModuleInspector (kotvisko, žeriav blocked). Nespúšťa hru ani simuláciu —
// dev server servíruje statické demo src/ui/__demo__/f2-ui-demo.html. Screenshot slúži na vizuálnu kontrolu voči
// prototypu design/ui/game-ui.source.html.
const DEMO_URL = '/src/ui/__demo__/f2-ui-demo.html';

test('F2 UI demo: BuildBar a ModuleInspector sa vykreslia a reagujú', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(DEMO_URL);
  const stageBar = page.getByTestId('stage-bar');
  await expect(stageBar.getByRole('tablist', { name: 'Kategórie stavby' })).toBeVisible();
  // Písma (Inter, JetBrains Mono) musia byť načítané, inak sa screenshot líši šírkami textu.
  await page.evaluate(() => document.fonts.ready);

  // BuildBar: Terminál aktívny, ostatné kategórie zamknuté (mimo F2)
  const tabs = stageBar.getByRole('tab');
  await expect(tabs).toHaveCount(6);
  await expect(stageBar.getByRole('tab', { name: /Terminál/ })).toHaveAttribute('aria-selected', 'true');
  await expect(stageBar.locator('.build-bar__tab:disabled')).toHaveCount(5);

  // položky: cena cez formatMoney, rozmer footprintu, stav bez peňazí
  const berth = stageBar.locator('[data-def-id="berth_standard"]');
  const crane = stageBar.locator('[data-def-id="crane_container_gantry"]');
  await expect(berth.locator('[data-field="item-cost"]')).toHaveText('$400,000');
  await expect(berth.locator('[data-field="item-size"]')).toHaveText('· 8×3');
  await expect(crane.locator('[data-field="item-cost"]')).toHaveText('$600,000');
  await expect(crane.locator('[data-field="item-size"]')).toHaveText('· 2×3');
  await expect(berth).toHaveAttribute('data-status', 'available');
  await expect(crane).toHaveAttribute('data-status', 'unaffordable');

  // výber: kotvisko je vybrané, klik ho zruší a druhý klik ho vyberie znova; žeriav bez peňazí sa vybrať nedá
  await expect(berth).toHaveAttribute('aria-pressed', 'true');
  await berth.click();
  await expect(berth).toHaveAttribute('aria-pressed', 'false');
  await berth.click();
  await expect(berth).toHaveAttribute('aria-pressed', 'true');
  // aria-disabled: Playwright ho berie ako nepovolený, klik preto vynútime (komponent ho musí ignorovať)
  await crane.click({ force: true });
  await expect(crane).toHaveAttribute('aria-pressed', 'false');

  // ModuleInspector v hre: kotvisko, apron 3/4, loď Feeder 1/4 TEU, odstránenie zablokované s dôvodom
  const inspector = page.getByTestId('stage').getByRole('complementary', { name: 'Inšpektor modulu' });
  await expect(inspector.locator('[data-field="title"]')).toHaveText('Kotvisko štandard');
  await expect(inspector.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'true');
  await expect(inspector.locator('[data-field="apron-count"]')).toHaveText('3 / 4 slotov');
  await expect(inspector.locator('[data-field="ship-class"]')).toHaveText('Feeder');
  await expect(inspector.locator('[data-field="ship-units"]')).toHaveText('1 / 4 TEU');
  await expect(inspector.locator('[data-action="remove"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(inspector.locator('[data-field="remove-reason"]')).toHaveText('Pri kotvisku kotví loď.');

  // ModuleInspector: žeriav blocked — žltý badge, banner s vysvetlením, odstrániť volá onRemove(8)
  const blockedCrane = page.getByRole('complementary', { name: 'Inšpektor modulu' }).filter({ hasText: 'Blokovaný — plný apron' });
  await expect(blockedCrane).toHaveCount(1);
  await expect(blockedCrane.locator('[data-field="badge"]')).toHaveAttribute('data-ok', 'false');
  await expect(blockedCrane.locator('[data-field="badge"]')).toHaveText('Blokovaný');
  await expect(blockedCrane.locator('[data-field="stat-busy"]')).toHaveText('72 %');
  await expect(blockedCrane.locator('[data-field="stat-blocked"]')).toHaveText('21 %');
  await expect(blockedCrane.locator('[data-field="refund"]')).toHaveText('$300,000');
  await blockedCrane.locator('[data-action="remove"]').click();
  await expect(blockedCrane.locator('xpath=ancestor::figure').locator('[data-field="last-action"]')).toHaveText(
    'Posledná akcia: onRemove(8)',
  );

  // screenshot: tooltip „Chýba …" nad žeriavom, ktorý hráč nemôže kúpiť
  await crane.hover();
  const tip = crane.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Nedostatok peňazí');
  await expect(tip).toContainText('Chýba $150,000');
  // tooltip sa zobrazuje prechodom opacity (120 ms) — screenshot až po jeho dokončení
  await expect(tip).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/f2-ui-demo.png', fullPage: true });

  // kontrolný pás: tooltip zamknutej položky s dôvodom
  const locked = page.getByTestId('states').locator('[data-def-id="arm_liquid"]');
  await locked.hover();
  await expect(locked.getByRole('tooltip')).toContainText('Vyžaduje technológiu Kvapalné terminály');
  await expect(locked.getByRole('tooltip')).toHaveCSS('opacity', '1');
  await page.getByTestId('states').screenshot({ path: 'tests/e2e/__screenshots__/f2-ui-demo-states.png' });

  expect(errors).toEqual([]);
});
