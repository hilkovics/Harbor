import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { dismissToasts } from './dismiss-toasts';

// R6 e2e (TR6-05): v skutočnej hre na harbor_01 sa postaví železničný terminál na parcele `rail_yard` a koľaj k portálu (rozloženie zo scenára `rail_flow`),
// do bufferu sa uloží import, vlak príde (`entities.trains`) a RMG naloží vagón (`in_train`). Screenshot: `r6-rail-game.png`.

const SHOTS = 'tests/e2e/__screenshots__';
test.describe.configure({ timeout: 3 * 60_000 });

interface ScenarioCommand {
  readonly atTick: number;
  readonly command: Record<string, unknown>;
}
const scenario = JSON.parse(readFileSync('data/scenarios/rail_flow.json', 'utf8')) as { commands: ScenarioCommand[] };
const COMMANDS = scenario.commands.map((entry) => entry.command).filter((command) => command['type'] === 'PlaceModule' || command['type'] === 'PlaceRail' || command['type'] === 'PlaceRoad');

test('R6: vlak príde na koľaj terminálu a RMG naloží vagón', async ({ page }) => {
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
    expect(result, JSON.stringify(command).slice(0, 120)).toMatchObject({ ok: true });
  }
  // import v bufferi terminálu (ako by ho uložil ťahač s RMG): ledger `on_ship → in_crane → in_vehicle → in_storage`
  const stored = await page.evaluate(() => {
    const { world } = window.__sim!;
    type Block = { id: number; def: { id: string }; reserveFor(slot: number, unit: unknown): void; commit(slot: number, id: number): void };
    const terminal = [...world.modules.values()].find((module) => module.def.id === 'rmg_rail_block') as unknown as Block;
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 901 } as never, null, { direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium', sizeFt: 20 } as never);
      world.cargo.move(unit.id, { kind: 'in_crane', craneId: 900 } as never);
      terminal.reserveFor(i, unit);
      world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 902 } as never);
      world.cargo.move(unit.id, { kind: 'in_storage', moduleId: terminal.id, slot: i } as never);
      terminal.commit(i, unit.id);
      ids.push(unit.id);
    }
    return ids;
  });
  expect(stored).toHaveLength(4);

  // vlak príde (cestovný poriadok, prvý príchod 2. hodina) a RMG naloží aspoň jeden kontajner na vagón
  let loaded = false;
  for (let i = 0; i < 200 && !loaded; i++) {
    await page.evaluate(() => window.__sim!.advance!(100));
    loaded = await page.evaluate(() => window.__sim!.entities().trains?.some((train) => train.cars.some((car) => car.cargo.length > 0)) ?? false);
  }
  expect(loaded, 'RMG naložil kontajner na vagón').toBe(true);
  await page.evaluate(() => window.__sim!.centerOn!(52, 40, 0.5));
  await dismissToasts(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const entities = await page.evaluate(() => window.__sim!.entities());
  const train = entities.trains![0]!;
  expect(train.cars.length).toBe(5); // lokomotíva + 4 vagóny
  expect(train.cars[0]!.kind).toBe('loco');
  expect(entities.machines?.some((machine) => machine.defId === 'rmg')).toBe(true);
  expect(await page.evaluate(() => window.__sim!.rendered!().trains)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__sim!.rendered!().crossings)).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/r6-rail-game.png` });
  expect(errors).toEqual([]);
});
