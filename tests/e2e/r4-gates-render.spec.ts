import { expect, test, type Page } from '@playwright/test';

// R4 / TR4-03 render demo (`src/render/__demo__/r4-gates.html`): pevné view-modely bez simu. Scény: `gates` (8 vstupných a 4 výstupné pruhy so strechou,
// predbránová plocha s kamiónmi vedľa seba, odstavná plocha) a `rtg` (blok RTG s TP a safe zónou). Test kontroluje, že sa demo načíta bez chýb;
// screenshoty idú do `tests/e2e/__screenshots__/`.

const DEMO_URL = '/src/render/__demo__/r4-gates.html';

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

for (const scene of ['gates', 'rtg']) {
  test(`R4 demo: scéna ${scene}`, async ({ page }) => {
    const errors = await openDemo(page, scene);
    await page.screenshot({ path: `tests/e2e/__screenshots__/r4-gates-${scene}.png` });
    expect(errors).toEqual([]);
  });
}
