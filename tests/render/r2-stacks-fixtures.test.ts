// Konzistencia scén demo TR2-03 (`src/render/__demo__/r2-stacks.fixtures.ts`): moduly sa neprekrývajú a stoja na pevnine, stohy sú v geometrii bloku,
// páry 40′ sú úplné, výšky v limite, nosiče stoja na cestách a nezdieľajú bunky; v scéne nie sú žiadni ľudia (len stroje a kontajnery).
import { describe, expect, it } from 'vitest';
import { loadBundledMap } from '@sim/grid';
import {
  BLOCK,
  BLOCK_STACKS,
  CARRIERS,
  DEPOT,
  DEPOT_STACKS,
  R2_SCENES,
  TRUCKS,
  createR2Grid,
  type R2Scene,
} from '@render/__demo__/r2-stacks.fixtures';
import { cargoSpriteEntry, moduleSprite } from '@render/entity-assets';
import { containerSpriteId } from '@render/container-sprites';
import type { ModuleVM, StackVM } from '@render/view-models';

const map = loadBundledMap();
const key = (x: number, y: number): string => `${String(Math.floor(x))},${String(Math.floor(y))}`;

function footprint(module: ModuleVM): string[] {
  const cells: string[] = [];
  for (let y = module.y; y < module.y + module.h; y++) for (let x = module.x; x < module.x + module.w; x++) cells.push(key(x, y));
  return cells;
}

describe.each(Object.entries(R2_SCENES))('scéna %s', (_name, scene: R2Scene) => {
  const grid = createR2Grid(map, scene);
  const roads = new Set(scene.roads.map((cell) => key(cell.x, cell.y)));

  it('moduly sa neprekrývajú, nestoja na cestách a ležia na pevnine', () => {
    const used = new Set<string>();
    for (const module of scene.vm.modules) {
      for (const cell of footprint(module)) {
        expect(used.has(cell), `bunka ${cell} je v dvoch moduloch`).toBe(false);
        expect(roads.has(cell), `bunka ${cell}: cesta pod modulom`).toBe(false);
        used.add(cell);
        const [x, y] = cell.split(',').map(Number);
        expect(['land', 'quay'], `bunka ${cell}`).toContain(grid.at(x, y).terrain);
      }
    }
  });

  it('cesty ležia na pevnine a nosiče (hlava aj stopa) stoja na cestách bez zdieľania buniek', () => {
    for (const cell of scene.roads) expect(['land', 'quay'], `cesta (${String(cell.x)}; ${String(cell.y)})`).toContain(grid.at(cell.x, cell.y).terrain);
    const owner = new Map<string, number>();
    for (const carrier of [...(scene.vm.vehicles ?? []), ...(scene.vm.trucks ?? [])]) {
      const line = [{ x: carrier.x, y: carrier.y }, ...(carrier.body ?? [])];
      expect(line.length, `nosič ${String(carrier.id)}`).toBe(carrier.lengthCells);
      for (const point of line) {
        const cell = key(point.x, point.y);
        expect(roads.has(cell), `nosič ${String(carrier.id)}: ${cell} nie je cesta`).toBe(true);
        expect(owner.has(cell), `bunka ${cell}: nosiče ${String(owner.get(cell))} a ${String(carrier.id)}`).toBe(false);
        owner.set(cell, carrier.id);
      }
    }
  });
});

describe.each([
  ['straddle blok', BLOCK, BLOCK_STACKS],
  ['depo prázdnych', DEPOT, DEPOT_STACKS],
])('%s', (_name, module: ModuleVM, stacks: readonly StackVM[]) => {
  const geometry = module.stackGeometry!;

  it('manifest pozná modul a sprite; stohy ležia v geometrii bloku, výšky v limite, každá pozícia je najviac raz', () => {
    expect(moduleSprite(module.defId)).toBeDefined();
    const seen = new Set<string>();
    for (const stack of stacks) {
      expect(stack.bay).toBeGreaterThanOrEqual(0);
      expect(stack.bay).toBeLessThan(geometry.bays);
      expect(stack.row).toBeGreaterThanOrEqual(0);
      expect(stack.row).toBeLessThan(geometry.rows);
      expect(stack.height).toBeLessThanOrEqual(geometry.maxTier);
      expect(stack.top === null, `(${String(stack.bay)}; ${String(stack.row)})`).toBe(stack.height === 0);
      const position = key(stack.bay, stack.row);
      expect(seen.has(position), `pozícia ${position} dvakrát`).toBe(false);
      seen.add(position);
    }
  });

  it('40′ zaberá úplný pár bays (2k, 2k + 1) s rovnakou výškou a rovnakým vrchným kontajnerom', () => {
    for (const stack of stacks.filter((candidate) => candidate.top?.sizeFt === 40)) {
      const partner = stacks.find((candidate) => candidate.row === stack.row && candidate.bay === (stack.bay % 2 === 0 ? stack.bay + 1 : stack.bay - 1));
      expect(partner, `40′ (${String(stack.bay)}; ${String(stack.row)}) bez páru`).toBeDefined();
      expect(partner!.height).toBe(stack.height);
      expect(partner!.top).toEqual(stack.top);
    }
  });

  it('každý kontajner má sprite v manifeste; kapacita a obsadenie v TEU sedia na stohy', () => {
    for (const stack of stacks) if (stack.top !== null) expect(cargoSpriteEntry(containerSpriteId(stack.top)), containerSpriteId(stack.top)).toBeDefined();
    expect(module.storage?.capacity).toBe(geometry.bays * geometry.rows * geometry.maxTier);
    expect(module.storage?.stored).toBe(stacks.reduce((sum, stack) => sum + stack.height, 0));
  });
});

describe('obsah scény', () => {
  it('blok má výšky 1 až 3, 20′ aj 40′, tri linky, neutrálny kontajner bez linky, sivý prázdny a prázdnu pozíciu', () => {
    const heights = new Set(BLOCK_STACKS.map((stack) => stack.height));
    expect([...heights].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(new Set(BLOCK_STACKS.map((stack) => stack.top?.sizeFt))).toEqual(new Set([20, 40, undefined]));
    expect(new Set(BLOCK_STACKS.flatMap((stack) => (stack.top?.lineId === undefined ? [] : [stack.top.lineId])))).toEqual(new Set(['blue_anchor', 'northern_star', 'golden_wave', null]));
    expect(BLOCK_STACKS.some((stack) => stack.top?.direction === 'empty')).toBe(true);
  });

  it('depo má výšku až 8, všetky kontajnery prázdne a 20′ aj 40′', () => {
    expect(Math.max(...DEPOT_STACKS.map((stack) => stack.height))).toBe(8);
    expect(DEPOT_STACKS.every((stack) => stack.top === null || stack.top.direction === 'empty')).toBe(true);
    expect(new Set(DEPOT_STACKS.map((stack) => stack.top?.sizeFt))).toEqual(new Set([20, 40, undefined]));
  });

  it('kamióny nesú 20′, 40′ a prázdny 40′; nosiče straddle so 40′ a 20′, ECH s prázdnym 20′ a 40′ a ECH bez kontajnera', () => {
    expect(TRUCKS.map((truck) => [truck.cargo?.sizeFt, truck.cargo?.direction === 'empty'])).toEqual([[20, false], [40, false], [40, true]]);
    const byDef = (defId: string) => CARRIERS.filter((carrier) => carrier.defId === defId).map((carrier) => carrier.cargo);
    expect(byDef('straddle_carrier').map((cargo) => cargo?.sizeFt)).toEqual([40, 20]);
    expect(byDef('empty_handler').map((cargo) => [cargo?.sizeFt, cargo?.direction])).toEqual([[20, 'empty'], [40, 'empty'], [undefined, undefined]]);
    for (const carrier of [...TRUCKS, ...CARRIERS]) expect(carrier.loaded).toBe(carrier.cargo !== null && carrier.cargo !== undefined);
  });
});
