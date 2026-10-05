// Cesty s typom a smerom vo svete (T03-18, ADR-020): štartové cesty mapy sú dvojpruhové, save ukladá
// `[index, vrstva, typ?, smer?]` v kanonickom tvare (roundtrip, fail-fast parsovanie s JSON pointermi, dvojice
// = dvojpruhové), obnovený svet pokračuje rovnako (determinizmus s vozidlami na jednosmerkách a jednopruhových
// cestách) a krok 12 stráži normalizovaný stav buniek.
import { describe, expect, it } from 'vitest';
import { PlaceRoadCommand } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import { World, WorldStateError, findWorldViolation, serializeRoad, type WorldState } from '@sim/world';
import { YARD_W, buyVehicle, dispatchWorld, execute, placeYard, unitsOnApron } from '../logistics/dispatch-fixtures';
import { DEFS, MAP, MAP_GRID, SEED, hashState, runTicks } from './world-fixtures';

const cell = (x: number, y: number): CellCoord => ({ x, y });
const row = (x0: number, x1: number, y: number): CellCoord[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => cell(x0 + i, y));
const indexOf = ({ x, y }: CellCoord): number => MAP_GRID.index(x, y);

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorOf(action: () => unknown): WorldStateError {
  try {
    action();
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw error;
  }
  throw new Error('očakávaná WorldStateError');
}

/** Svet s cestami všetkých typov: nábrežná cesta (dvojpruhová), jednopruhový a jednosmerný úsek. */
function kindsWorld(): World {
  const { world } = dispatchWorld();
  execute(world, { type: 'PlaceRoad', cells: row(33, 35, 17), kind: 'one_lane' });
  execute(world, { type: 'PlaceRoad', cells: [cell(50, 17), cell(51, 17), cell(52, 17)], kind: 'one_way', dirs: ['E', 'E', 'N'] });
  return world;
}

describe('štartové cesty mapy', () => {
  it('sú dvojpruhové bez smeru (World.create aj map.createGrid)', () => {
    const world = World.create(DEFS, MAP, SEED);
    for (const { x, y } of MAP.starter.roads) {
      expect([world.grid.at(x, y).roadKind, world.grid.at(x, y).roadDir]).toEqual(['two_lane', null]);
      expect([MAP_GRID.at(x, y).roadKind, MAP_GRID.at(x, y).roadDir]).toEqual(['two_lane', null]);
    }
  });
});

describe('save — cesty [index, vrstva, typ?, smer?] (ADR-020)', () => {
  it('serializeRoad: kanonický tvar podľa vrstvy, typu a smeru', () => {
    expect(serializeRoad(5, 'road', 'two_lane', null)).toEqual([5, 'road']);
    expect(serializeRoad(5, 'rail', 'two_lane', null)).toEqual([5, 'rail']);
    expect(serializeRoad(5, 'road', 'one_lane', null)).toEqual([5, 'road', 'one_lane']);
    expect(serializeRoad(5, 'road', 'one_way', 'S')).toEqual([5, 'road', 'one_way', 'S']);
  });

  it('serialize: dvojpruhová cesta ako dvojica, jednopruhová s typom, jednosmerka s typom a smerom', () => {
    const state = kindsWorld().serialize();
    expect(state.roads).toContainEqual([indexOf(cell(40, 17)), 'road']);
    expect(state.roads).toContainEqual([indexOf(cell(34, 17)), 'road', 'one_lane']);
    expect(state.roads).toContainEqual([indexOf(cell(50, 17)), 'road', 'one_way', 'E']);
    expect(state.roads).toContainEqual([indexOf(cell(52, 17)), 'road', 'one_way', 'N']);
    const indexes = state.roads.map(([index]) => index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(viaJson(state)).toStrictEqual(state);
  });

  it('roundtrip: typy a smery sa obnovia, serialize(deserialize(s)) = s aj cez JSON', () => {
    const world = kindsWorld();
    const state = viaJson(world.serialize());
    const restored = World.deserialize(DEFS, MAP, state);
    expect(restored.serialize()).toEqual(state);
    for (let i = 0; i < world.grid.cellCount; i++) {
      const a = world.grid.atIndex(i);
      const b = restored.grid.atIndex(i);
      expect([b.road, b.roadKind, b.roadDir]).toEqual([a.road, a.roadKind, a.roadDir]);
    }
  });

  it('odstránená jednosmerka sa v save neobjaví a bunka po obnove je normalizovaná', () => {
    const world = kindsWorld();
    execute(world, { type: 'RemoveRoad', cells: [cell(51, 17)] });
    const restored = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
    expect(restored.serialize().roads.some(([index]) => index === indexOf(cell(51, 17)))).toBe(false);
    const removed = restored.grid.at(51, 17);
    expect([removed.road, removed.roadKind, removed.roadDir]).toEqual(['none', 'two_lane', null]);
  });

  it('obnovený svet s vozidlami na jednosmerke a jednopruhovej ceste pokračuje rovnako (determinizmus)', () => {
    const build = (): World => {
      const { world, depot } = dispatchWorld();
      placeYard(world, YARD_W);
      execute(world, { type: 'PlaceRoad', cells: row(33, 36, 17), kind: 'one_lane' });
      execute(world, { type: 'PlaceRoad', cells: row(38, 40, 17), kind: 'one_way', dirs: ['E', 'E', 'E'] });
      buyVehicle(world, depot);
      buyVehicle(world, depot);
      unitsOnApron(world, [0, 1, 2]);
      return world;
    };
    const original = build();
    runTicks(original, 7);
    const restored = World.deserialize(DEFS, MAP, viaJson(original.serialize()));
    const twin = build();
    runTicks(twin, 7);
    expect(hashState(twin.serialize())).toBe(hashState(original.serialize()));
    for (let t = 0; t < 120; t++) {
      original.tick();
      restored.tick();
    }
    expect(hashState(restored.serialize())).toBe(hashState(original.serialize()));
  });

  it('záznam [index, vrstva] bez typu je dvojpruhová cesta: štartové cesty sa uložia ako dvojice a načítajú ako two_lane', () => {
    const state = viaJson(World.create(DEFS, MAP, SEED).serialize()) as WorldState;
    expect(state.roads.length).toBeGreaterThan(0);
    for (const entry of state.roads) expect(entry).toHaveLength(2);
    const restored = World.deserialize(DEFS, MAP, state);
    for (const { x, y } of MAP.starter.roads) expect(restored.grid.at(x, y).roadKind).toBe('two_lane');
  });

  type Mutation = (roads: unknown[][]) => void;
  const firstRoad = (roads: unknown[][]): unknown[] => {
    const entry = roads.find((road) => road[1] === 'road');
    if (entry === undefined) throw new Error('žiadna cesta');
    return entry;
  };
  const firstRail = (roads: unknown[][]): unknown[] => roads.find((road) => road[1] === 'rail') ?? [];
  const at = (roads: unknown[][], entry: unknown[]): number => roads.indexOf(entry);

  const INVALID: readonly [string, Mutation, (roads: unknown[][]) => string][] = [
    ['záznam dlhší ako 4', (r) => firstRoad(r).push('one_way', 'E', 'x'), (r) => `/roads/${String(at(r, firstRoad(r)))}`],
    ['neznámy typ cesty', (r) => firstRoad(r).push('four_lane'), (r) => `/roads/${String(at(r, firstRoad(r)))}/2`],
    ['typ ako číslo', (r) => firstRoad(r).push(2), (r) => `/roads/${String(at(r, firstRoad(r)))}/2`],
    ['predvolený typ sa neukladá', (r) => firstRoad(r).push('two_lane'), (r) => `/roads/${String(at(r, firstRoad(r)))}/2`],
    ['typ pri koľaji', (r) => firstRail(r).push('one_lane'), (r) => `/roads/${String(at(r, firstRail(r)))}/2`],
    ['jednosmerka bez smeru', (r) => firstRoad(r).push('one_way'), (r) => `/roads/${String(at(r, firstRoad(r)))}/3`],
    ['jednosmerka so zlým smerom', (r) => firstRoad(r).push('one_way', 'NE'), (r) => `/roads/${String(at(r, firstRoad(r)))}/3`],
    ['smer pri jednopruhovej', (r) => firstRoad(r).push('one_lane', 'E'), (r) => `/roads/${String(at(r, firstRoad(r)))}/3`],
  ];

  it.each(INVALID)('%s → WorldStateError s cestou', (_name, mutate, pathOf) => {
    const world = kindsWorld();
    world.grid.at(40, 40).road = 'rail';
    const state = viaJson(world.serialize()) as unknown as Record<string, unknown>;
    const roads = state.roads as unknown[][];
    mutate(roads);
    const error = errorOf(() => World.deserialize(DEFS, MAP, state as unknown as WorldState));
    expect(error.path).toBe(pathOf(roads));
  });
});

describe('krok 12 — typ a smer cesty na bunke', () => {
  it('prázdnu bunku krok 12 nekontroluje (cena ticku) — normalizovaný stav zaručujú zápisy; prestavba ho neporuší', () => {
    const world = kindsWorld();
    world.grid.at(40, 40).roadKind = 'one_lane';
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('konzistentný svet so všetkými typmi → bez porušenia', () => {
    expect(findWorldViolation(kindsWorld())).toBeUndefined();
  });

  it.each<[string, (world: World) => void, RegExp]>([
    ['koľaj s typom', (w) => Object.assign(w.grid.at(40, 40), { road: 'rail', roadKind: 'one_way', roadDir: 'N' }), /vrstvou 'rail' má typ cesty 'one_way'/],
    ['koľaj so smerom', (w) => Object.assign(w.grid.at(40, 40), { road: 'rail', roadDir: 'E' }), /vrstvou 'rail' .* smer E/],
    ['neznámy typ cesty', (w) => void (w.grid.at(40, 17).roadKind = 'four_lane' as never), /neznámy typ cesty 'four_lane'/],
    ['jednosmerka bez smeru', (w) => void (w.grid.at(50, 17).roadDir = null), /jednosmerka musí mať smer/],
    ['dvojpruhová so smerom', (w) => void (w.grid.at(40, 17).roadDir = 'W'), /len jednosmerka má smer/],
    ['jednopruhová so smerom', (w) => void (w.grid.at(34, 17).roadDir = 'S'), /len jednosmerka má smer/],
  ])('%s → porušenie', (_name, corrupt, message) => {
    const world = kindsWorld();
    corrupt(world);
    expect(findWorldViolation(world)).toMatch(message);
  });

  it('PlaceRoad/RemoveRoad udržia normalizovaný stav (bez porušenia po prestavbách a odstránení)', () => {
    const world = kindsWorld();
    const cells = row(44, 48, 17);
    for (const command of [
      new PlaceRoadCommand(cells, 'one_way', ['W', 'W', 'W', 'W', 'W']),
      new PlaceRoadCommand(cells, 'one_lane'),
      new PlaceRoadCommand(cells),
    ]) {
      world.enqueue(command);
      world.applyPending();
      expect(findWorldViolation(world)).toBeUndefined();
    }
    execute(world, { type: 'RemoveRoad', cells: [cell(50, 17), cell(34, 17)] });
    expect(findWorldViolation(world)).toBeUndefined();
  });
});
