// PathCache, DistanceMatrix a World.roadVersion (T03-03, ARCHITECTURE §7.4, rozhodnutie orchestrátora F3 č. 5):
// memo ciest a cien nad Pathfinder, invalidácia pri zmene roadVersion (PlaceRoad/RemoveRoad/deserialize) bez odberu
// udalostí, cache nie je stav simulácie (save sa nemení).
import { describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import { DistanceMatrix, PathCache, Pathfinder, type RoadVersionSource } from '@sim/logistics';
import { World } from '@sim/world';
import { DEFS, MAP, SEED, hashState } from '../world/world-fixtures';
import { gridWith, roadGrid } from './road-fixtures';

/** Meniteľný zdroj verzie pre testy bez sveta. */
class Version implements RoadVersionSource {
  roadVersion = 0;
}

describe('PathCache (bez sveta)', () => {
  it('opakovaný dotaz pri rovnakej verzii vráti to isté pole (zásah), inak rovnakú cestu ako Pathfinder', () => {
    const grid = gridWith(6, 4, () => true);
    const pathfinder = new Pathfinder(grid);
    const cache = new PathCache(pathfinder, new Version());
    const first = cache.get(0, 23);
    expect(first).toEqual(new Pathfinder(grid).findPath(0, 23));
    expect(cache.get(0, 23)).toBe(first);
    expect(cache.diagnostics()).toEqual({ size: 1, hits: 1, misses: 1, invalidations: 0 });
  });

  it('pamätá si aj „bez cesty" (null) — ďalší dotaz nehľadá znova', () => {
    const pathfinder = new Pathfinder(roadGrid(['..#..']));
    const cache = new PathCache(pathfinder, new Version());
    expect(cache.get(0, 4)).toBeNull();
    const searches = pathfinder.diagnostics().searches;
    expect(cache.get(0, 4)).toBeNull();
    expect(pathfinder.diagnostics().searches).toBe(searches);
    expect(cache.diagnostics()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  it('dvojica je usporiadaná: (a, b) a (b, a) sú rôzne kľúče', () => {
    const cache = new PathCache(new Pathfinder(roadGrid(['...'])), new Version());
    expect(cache.get(0, 2)).toEqual([0, 1, 2]);
    expect(cache.get(2, 0)).toEqual([2, 1, 0]);
    expect(cache.diagnostics().size).toBe(2);
  });

  it('zmena roadVersion celú cache vyprázdni — ďalší dotaz vidí nové cesty', () => {
    const grid = roadGrid(['..#..']);
    const version = new Version();
    const cache = new PathCache(new Pathfinder(grid), version);
    expect(cache.get(0, 4)).toBeNull();
    expect(cache.get(0, 1)).toEqual([0, 1]);
    grid.at(2, 0).road = 'road';
    expect(cache.get(0, 4)).toBeNull(); // bez zmeny verzie cache stále platí (zámerne — verziu mení svet)
    version.roadVersion += 1;
    expect(cache.diagnostics()).toMatchObject({ size: 0, invalidations: 1 });
    expect(cache.get(0, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it('index mimo mriežky → RangeError (kľúč by inak mohol kolidovať)', () => {
    const cache = new PathCache(new Pathfinder(roadGrid(['...'])), new Version());
    expect(() => cache.get(0, 3)).toThrow(RangeError);
    expect(() => cache.get(-1, 0)).toThrow(RangeError);
    expect(() => cache.get(1.5, 0)).toThrow(RangeError);
  });
});

describe('DistanceMatrix (bez sveta)', () => {
  it('lazy: cena = dĺžka cesty − 1, bez cesty Infinity, tá istá bunka 0; hodnota sa spočíta raz', () => {
    const grid = roadGrid(['....#.', '.##.#.', '......']);
    const pathfinder = new Pathfinder(grid);
    const version = new Version();
    const matrix = new DistanceMatrix(new PathCache(pathfinder, version), version);
    expect(matrix.diagnostics().size).toBe(0);
    const d = matrix.distance(0, 5);
    expect(d).toBe((pathfinder.findPath(0, 5) ?? []).length - 1);
    const searches = pathfinder.diagnostics().searches;
    expect(matrix.distance(0, 5)).toBe(d);
    expect(pathfinder.diagnostics().searches).toBe(searches);
    expect(matrix.distance(3, 3)).toBe(0);
    expect(matrix.distance(0, 4)).toBe(Infinity); // (4, 0) nie je cesta
  });

  it('cena z cesty PathCache: jeden A* pre cenu aj cestu tej istej dvojice, bitovo = findCost (aj pri cene 1 / 0,7)', () => {
    const grid = roadGrid(['......', '.####.', '......']);
    const slow = new Set([grid.index(3, 0), grid.index(2, 2), grid.index(3, 2)]); // horná cesta 6 + 1/0,7 < dolná 5 + 2/0,7
    const pathfinder = new Pathfinder(grid, (i) => (slow.has(i) ? 1 / 0.7 : 1));
    const version = new Version();
    const paths = new PathCache(pathfinder, version);
    const matrix = new DistanceMatrix(paths, version);
    const from = grid.index(0, 0);
    const to = grid.index(5, 2);
    const searches = pathfinder.diagnostics().searches;
    const cost = matrix.distance(from, to);
    const path = paths.get(from, to);
    expect(pathfinder.diagnostics().searches).toBe(searches + 1);
    expect(paths.diagnostics()).toMatchObject({ hits: 1, misses: 1 });
    expect(Object.is(cost, pathfinder.findCost(from, to))).toBe(true);
    expect(cost).toBe(pathfinder.routeCost(path ?? []));
    expect(path?.[1]).toBe(grid.index(1, 0)); // horná cesta
    expect(cost).toBeCloseTo(6 + 1 / 0.7, 12);
  });

  it('zneplatní sa pri zmene roadVersion', () => {
    const grid = roadGrid(['..#..']);
    const version = new Version();
    const matrix = new DistanceMatrix(new PathCache(new Pathfinder(grid), version), version);
    expect(matrix.distance(0, 4)).toBe(Infinity);
    grid.at(2, 0).road = 'road';
    version.roadVersion += 1;
    expect(matrix.distance(0, 4)).toBe(4);
    expect(matrix.diagnostics()).toMatchObject({ invalidations: 1, size: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------
// World: roadVersion a lenivé inštancie (harbor_01, starter parcela)
// ---------------------------------------------------------------------------------------------------------

/** Okruh na starter parcele: horný rad y=25 a dolný y=27 (x 31–35) spojené bunkami (31, 26) a (35, 26). */
const TOP: readonly CellCoord[] = [31, 32, 33, 34, 35].map((x) => ({ x, y: 25 }));
const BOTTOM: readonly CellCoord[] = [31, 32, 33, 34, 35].map((x) => ({ x, y: 27 }));
const WEST = { x: 31, y: 26 };
const EAST = { x: 35, y: 26 };
const LOOP: readonly CellCoord[] = [...TOP, ...BOTTOM, WEST, EAST];

function execute(world: World, command: SerializedCommand): void {
  world.enqueue(commandFromJSON(command));
  world.applyPending();
}

function loopWorld(): World {
  const world = World.create(DEFS, MAP, SEED);
  execute(world, { type: 'PlaceRoad', cells: LOOP });
  return world;
}

const index = (world: World, { x, y }: CellCoord): number => world.grid.index(x, y);
const coords = (world: World, path: readonly number[] | null): CellCoord[] | null => path?.map((i) => world.grid.coordOf(i)) ?? null;

describe('World.roadVersion', () => {
  it('nový svet 0; PlaceRoad a RemoveRoad ho zvýšia o 1, odmietnutý príkaz ani iné príkazy nie', () => {
    const world = World.create(DEFS, MAP, SEED);
    expect(world.roadVersion).toBe(0);
    execute(world, { type: 'PlaceRoad', cells: LOOP });
    expect(world.roadVersion).toBe(1);
    execute(world, { type: 'PlaceRoad', cells: [TOP[0]] }); // už je cesta → empty, odmietnuté
    expect(world.roadVersion).toBe(1);
    execute(world, { type: 'PlaceModule', defId: 'vehicle_depot', x: 50, y: 20, rotation: 0 });
    execute(world, { type: 'SetGameSpeed', speed: 2 });
    expect(world.modules.size).toBe(3);
    expect(world.roadVersion).toBe(1);
    execute(world, { type: 'RemoveRoad', cells: [TOP[2]] });
    expect(world.roadVersion).toBe(2);
  });

  it('deserialize ho zvýši (cesty prišli zo save) a verzia nie je súčasťou save', () => {
    const world = loopWorld();
    const state = world.serialize();
    expect(JSON.stringify(state)).not.toContain('roadVersion');
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(state)) as typeof state);
    expect(restored.roadVersion).toBeGreaterThan(0);
    expect(hashState(restored.serialize())).toBe(hashState(state));
  });

  it('markRoadsChanged zvýši verziu o 1', () => {
    const world = World.create(DEFS, MAP, SEED);
    world.markRoadsChanged();
    world.markRoadsChanged();
    expect(world.roadVersion).toBe(2);
  });
});

describe('World.paths / World.distances', () => {
  it('lenivé a stabilné inštancie nad mriežkou sveta', () => {
    const world = loopWorld();
    expect(world.paths).toBe(world.paths);
    expect(world.distances).toBe(world.distances);
    expect(world.pathfinder).toBe(world.pathfinder);
    expect(world.pathfinder.cellCount).toBe(world.grid.cellCount);
  });

  it('okruh: cesta W → E ide horným radom (tie-break), po RemoveRoad bunky trasy sa cache zneplatní a cesta ide dolu', () => {
    const world = loopWorld();
    const from = index(world, WEST);
    const to = index(world, EAST);
    const top = world.paths.get(from, to);
    expect(coords(world, top)).toEqual([WEST, ...TOP, EAST]);
    expect(world.distances.distance(from, to)).toBe(6);
    expect(world.paths.get(from, to)).toBe(top);

    execute(world, { type: 'RemoveRoad', cells: [TOP[2]] });
    const bottom = world.paths.get(from, to);
    expect(coords(world, bottom)).toEqual([WEST, ...BOTTOM, EAST]);
    expect(world.distances.distance(from, to)).toBe(6);
    expect(world.paths.diagnostics().invalidations).toBe(1);

    execute(world, { type: 'RemoveRoad', cells: [BOTTOM[2]] });
    expect(world.paths.get(from, to)).toBeNull();
    expect(world.distances.distance(from, to)).toBe(Infinity);

    execute(world, { type: 'PlaceRoad', cells: [TOP[2]] });
    expect(coords(world, world.paths.get(from, to))).toEqual([WEST, ...TOP, EAST]);
  });

  it('dotazy na cesty nemenia stav simulácie (hash serialize rovnaký, Rng nepoužité)', () => {
    const world = loopWorld();
    const before = hashState(world.serialize());
    world.paths.get(index(world, WEST), index(world, EAST));
    world.distances.distance(index(world, EAST), index(world, WEST));
    expect(hashState(world.serialize())).toBe(before);
  });
});
