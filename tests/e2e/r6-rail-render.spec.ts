import { expect, test } from '@playwright/test';

// R6 / TR6-03 render demo (`src/render/__demo__/r6-rail.html`): koľaje (hladké oblúky S), vlak (lokomotíva + 6 vagónov s kontajnermi) a RMG.
// Test kontroluje, že sa demo načíta bez chýb a že sa kreslia sprity vlaku; screenshot ide do `tests/e2e/__screenshots__/`.

test('R6 demo: koľaje, vlak s kontajnermi, RMG', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/src/render/__demo__/r6-rail.html?scene=terminal');
  await page.waitForSelector('body[data-demo-ready="true"]');
  const report = await page.evaluate(() => {
    const { renderer } = window.__r6Demo!;
    const train = renderer.trains.trainView(61)!;
    return {
      cars: train.carCount,
      textured: [0, 1].map((i) => train.car(i)!.textured),
      containers: Array.from({ length: train.carCount }, (_, i) => train.car(i)!.containerCount),
      rails: renderer.rails.tileCount,
      paths: renderer.rails.paths.length,
      corner: renderer.rails.tileAt(44, 24) ?? null,
      machineTextured: renderer.machines.machineView(62)!.textured,
    };
  });
  expect(report.cars).toBe(7);
  expect(report.textured).toEqual([true, true]);
  expect(report.containers).toEqual([0, 2, 3, 1, 0, 1, 0]);
  expect(report.paths).toBe(1);
  expect(report.corner).toMatchObject({ shape: 'corner' });
  expect(report.machineTextured).toBe(true);
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r6-rail-demo.png' });
  expect(errors).toEqual([]);
});
