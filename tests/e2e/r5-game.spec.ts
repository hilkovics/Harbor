import { expect, test } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// R5 e2e (TR5-05): v skutočnej hre sa postaví reefer blok a OOG plocha (príkazy cez `dispatchJSON`), do reefer bloku sa uložia reefery (v sklade sa zapoja), do OOG plochy
// OOG jednotky; VM nesie zásuvky (`plugs`) a reach stacker (`reach_stacker`). Screenshot: `r5-game.png`.

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 2 * 60_000 });

const COMMANDS: readonly Record<string, unknown>[] = [
  { type: 'PlaceModule', defId: 'reefer_block_8', x: 48, y: 19, rotation: 0 },
  { type: 'PlaceModule', defId: 'oog_area', x: 54, y: 19, rotation: 0 },
];

test('R5: reefer blok so zapojenými reefermi a OOG plocha s reach stackerom', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.app__map canvas')).toBeVisible();
  await page.waitForFunction(() => window.__sim?.rendered !== undefined && window.__sim.dispatchJSON !== undefined && window.__sim.centerOn !== undefined && window.__sim.advance !== undefined);
  for (const command of COMMANDS) {
    const result = await page.evaluate((json) => window.__sim!.dispatchJSON!(json as never), command);
    expect(result, JSON.stringify(command)).toMatchObject({ ok: true });
  }
  // sklad: reťaz povolených prechodov lode → sklad (ako v unit testoch ledgera); reefer sa v sklade bloku zapojí systémom reeferov
  await page.evaluate(() => {
    const { world } = window.__sim!;
    type Block = { id: number; def: { id: string }; slotOf(bay: number, row: number, tier: number): number };
    const blocks = [...world.modules.values()] as unknown as Block[];
    const reeferBlock = blocks.find((block) => block.def.id === 'reefer_block_8')!;
    const oogArea = blocks.find((block) => block.def.id === 'oog_area')!;
    const put = (block: Block, containerType: string, bay: number, row: number, oog: boolean): void => {
      const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 } as never, null, { direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium', sizeFt: 20, containerType, oog } as never);
      world.cargo.move(unit.id, { kind: 'in_crane', craneId: 901 } as never);
      world.cargo.move(unit.id, { kind: 'on_apron', berthId: 902, slot: 0 } as never);
      world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 903 } as never);
      world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, 0) } as never);
    };
    for (const [bay, row] of [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [3, 2], [4, 3]] as const) put(reeferBlock, 'reefer', bay, row, false);
    put(oogArea, 'flat_rack', 1, 0, true);
    put(oogArea, 'flat_rack', 3, 1, true);
  });
  await page.evaluate(() => window.__sim!.advance!(10));
  await page.evaluate(([x, y, zoom]) => window.__sim!.centerOn!(x, y, zoom), [54, 24, 0.7] as const);
  await dismissToasts(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const entities = await page.evaluate(() => window.__sim!.entities());
  const reeferVm = entities.modules.find((module) => module.defId === 'reefer_block_8')!;
  expect(reeferVm.plugs?.filter((plug) => plug.state === 'on').length).toBeGreaterThan(0);
  expect(reeferVm.plugs?.some((plug) => plug.state === 'empty')).toBe(true);
  expect(entities.machines?.some((machine) => machine.defId === 'reach_stacker')).toBe(true);
  await page.screenshot({ path: `${SHOTS}/r5-game.png` });
  expect(errors).toEqual([]);
});
