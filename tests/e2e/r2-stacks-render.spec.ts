import { expect, test, type Page } from '@playwright/test';
import type { ModuleDecor } from '../../src/render/module-decor';
import type { StacksDecor } from '../../src/render/stacks-decor';

// R2 / TR2-03 render demo (`src/render/__demo__/r2-stacks.html`): pevné view-modely bez simu. Jedna scéna, štyri pohľady kamery:
// `terminal` (celok), `block` (straddle blok so stohmi výšky 1–3, 20′ aj 40′, tri linky), `depot` (depo prázdnych do výšky 8) a `vehicles` (kamióny s 20′
// a 40′, straddle carriery so 40′ a 20′, ECH s prázdnym 20′ / 40′ a bez kontajnera). Test kontroluje, že sa kreslia stohy zhora (jeden vrchný kontajner
// na stoh, 40′ raz na pár bays), tieň výšky (posun 3 px × výška), telo bloku bez sprite `fillNN` a kontajnery na nosičoch podľa veľkosti a typu;
// screenshoty idú do `tests/e2e/__screenshots__/`. Nikde nie sú ľudia.

const DEMO_URL = '/src/render/__demo__/r2-stacks.html';

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

interface StackReport {
  bay: number;
  row: number;
  height: number;
  sizeFt: number;
  x: number;
  y: number;
  texture: string | null;
  tint: number | null;
  /** Posun tieňa dole-vpravo od vrchného kontajnera (px sveta). */
  shadowShift: number | null;
}

interface BlockReport {
  stacks: StackReport[];
  bodyVisible: boolean;
  fill: number | null;
  layout: { pitchX: number; pitchY: number; fit: number };
  cellPx: number;
}

/** Stohy bloku `id`: poloha vrchného kontajnera, sprite, tónovanie a posun tieňa. */
async function block(page: Page, id: number): Promise<BlockReport> {
  return page.evaluate((moduleId) => {
    const { renderer } = window.__r2Demo!;
    const view = renderer.modules.moduleView(moduleId)!;
    const decor = view.decor<StacksDecor>('stacks')!;
    const stacks = decor.stacks.map((stack) => {
      const bounds = stack.shadow.getLocalBounds();
      const sprite = stack.sprite;
      // tieň je šesťuholník (obrys kontajnera spojený s posunutým): pravý okraj tieňa je o posun za pravým okrajom kontajnera
      const shadowShift = bounds.width > 0 ? bounds.x + bounds.width - (sprite.x + sprite.width / 2) : null;
      return {
        bay: stack.bay,
        row: stack.row,
        height: stack.height,
        sizeFt: stack.sizeFt,
        x: sprite.x,
        y: sprite.y,
        texture: sprite.textureFile,
        tint: sprite.tintColor,
        shadowShift,
      };
    });
    return { stacks, bodyVisible: view.bodyVisible, fill: view.fill, layout: decor.layout, cellPx: renderer.palette.cellPx };
  }, id);
}

test('block: straddle blok kreslí jeden vrchný kontajner na stoh, 40′ raz na pár bays, telo bloku je procedurálne (bez sprite fillNN)', async ({ page }) => {
  const errors = await openDemo(page, 'block');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r2-block.png' });
  const report = await block(page, 3);
  // 16 pozícií: 1 prázdna; 40′ páry: (rad 0, pár 1), (rad 1, pár 0), (rad 2, pár 1) → 3 kontajnery namiesto 6 stohov; zvyšok 20′
  expect(report.stacks).toHaveLength(12);
  expect(report.stacks.filter((stack) => stack.sizeFt === 40)).toHaveLength(3);
  expect(report.stacks.map((stack) => stack.height)).toEqual([...report.stacks.map((stack) => stack.height)].sort((a, b) => a - b)); // od najnižšieho
  expect(report.bodyVisible).toBe(false);
  expect(report.fill).toBe(0);
  // sprity podľa veľkosti a typu: dry tónovaný farbou linky, prázdny sivý bez tónu, bez linky netónovaný
  const byPos = (bay: number, row: number): StackReport => report.stacks.find((stack) => stack.bay === bay && stack.row === row)!;
  expect(byPos(0, 0).texture).toBe('cargo/container_20_dry.svg');
  expect(byPos(0, 0).tint).not.toBeNull();
  expect(byPos(2, 0).texture).toBe('cargo/container_40_dry.svg'); // pár bays (2; 3), kreslí sa raz na prvej pozícii páru
  expect(byPos(0, 2).texture).toBe('cargo/container_20_empty.svg');
  expect(byPos(0, 2).tint).toBeNull();
  expect(byPos(3, 1).texture).toBe('cargo/container_20_dry.svg');
  expect(byPos(3, 1).tint).toBeNull(); // bez linky
  // 40′ leží uprostred páru bays: o pol rozstupu vedľa stredu prvej pozície
  const { pitchX } = report.layout;
  expect(byPos(2, 0).x - (byPos(1, 0).x + pitchX)).toBeCloseTo(pitchX / 2, 3);
  expect(errors).toEqual([]);
});

test('block: tieň výšky — posun 3 px × výška (pri cell 64 px), vyšší stoh má dlhší tieň', async ({ page }) => {
  const errors = await openDemo(page, 'block');
  const report = await block(page, 3);
  const unit = report.cellPx / 64;
  for (const stack of report.stacks) {
    expect(stack.shadowShift, `(${String(stack.bay)}; ${String(stack.row)})`).not.toBeNull();
    // tieň je orezaný na plochu bloku, preto len horná hranica; pri stohoch uprostred bloku (nie pri okraji) je posun presný
    expect(stack.shadowShift!).toBeLessThanOrEqual(3 * stack.height * unit + 0.01);
  }
  const inner = report.stacks.find((stack) => stack.bay === 1 && stack.row === 1) ?? report.stacks.find((stack) => stack.bay === 1 && stack.row === 2)!;
  expect(inner.shadowShift!).toBeCloseTo(3 * inner.height * unit, 1);
  expect(errors).toEqual([]);
});

test('depot: depo prázdnych s výškou do 8, sivé kontajnery s odznakmi depa', async ({ page }) => {
  const errors = await openDemo(page, 'depot');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r2-depot.png' });
  const report = await block(page, 5);
  expect(Math.max(...report.stacks.map((stack) => stack.height))).toBe(8);
  expect(report.stacks.every((stack) => stack.texture?.includes('_empty.svg') === true)).toBe(true);
  expect(report.stacks.filter((stack) => stack.sizeFt === 40)).toHaveLength(3);
  const badges = await page.evaluate(() => window.__r2Demo!.renderer.modules.moduleView(5)!.decor<ModuleDecor & { badgeCount: number }>('depot')!.badgeCount);
  expect(badges).toBe(2); // poškodené a opravy
  expect(errors).toEqual([]);
});

test('vehicles: kontajner na kamióne a nosičoch podľa veľkosti a typu; ECH má spreader podľa veľkosti', async ({ page }) => {
  const errors = await openDemo(page, 'vehicles');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r2-vehicles.png' });
  const result = await page.evaluate(() => {
    const { renderer } = window.__r2Demo!;
    const truck = (id: number) => {
      const view = renderer.entities.truckView(id)!;
      return { size: view.cargoContainer?.sizeFt ?? null, file: view.cargoSprite?.textureFile ?? null, y: view.cargoSprite?.y ?? null, angle: view.cargoSprite?.angle ?? null };
    };
    const carrier = (id: number) => {
      const view = renderer.entities.vehicleView(id)!;
      return { size: view.cargoContainer?.sizeFt ?? null, file: view.cargoSprite?.textureFile ?? null, spreader: view.spreaderSizeFt, x: view.cargoSprite?.x ?? null, y: view.cargoSprite?.y ?? null };
    };
    return {
      t20: truck(101),
      t40: truck(102),
      tEmpty: truck(103),
      s40: carrier(111),
      s20: carrier(112),
      e20: carrier(113),
      e40: carrier(114),
      free: carrier(115),
    };
  });
  expect(result.t20).toMatchObject({ size: 20, file: 'cargo/container_20_dry.svg', angle: 90 });
  expect(result.t40).toMatchObject({ size: 40, file: 'cargo/container_40_dry.svg' });
  expect(result.tEmpty).toMatchObject({ size: 40, file: 'cargo/container_40_empty.svg' });
  expect(result.t20.y!).toBeLessThan(result.t40.y!); // 20′ leží vpredu na návese, 40′ je na jeho strede
  expect(result.s40).toMatchObject({ size: 40, file: 'cargo/container_40_dry.svg', spreader: null });
  expect(result.s20).toMatchObject({ size: 20, file: 'cargo/container_20_dry.svg' });
  expect(result.e20).toMatchObject({ size: 20, file: 'cargo/container_20_empty.svg', spreader: 20 });
  expect(result.e40).toMatchObject({ size: 40, file: 'cargo/container_40_empty.svg', spreader: 40 });
  expect(result.free).toMatchObject({ size: null, file: null, spreader: 20 });
  expect(errors).toEqual([]);
});

test('terminal: celok — straddle blok, depo a nosiče na cestách', async ({ page }) => {
  const errors = await openDemo(page, 'terminal');
  await page.screenshot({ path: 'tests/e2e/__screenshots__/r2-terminal.png' });
  expect(errors).toEqual([]);
});
