import { describe, expect, it } from 'vitest';
import { World, WorldStateError, WORLD_STATE_VERSION, type WorldState } from '@sim/world';
import {
  DEFS,
  MAP,
  SEED,
  TestCommand,
  adjustCash,
  consumeRng,
  findCell,
  hashState,
  runTicks,
  setRoad,
} from './world-fixtures';

const create = (): World => World.create(DEFS, MAP, SEED);

const PUBLIC_LAND = findCell(MAP.grid, (cell) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none');
const OTHER_PUBLIC_LAND = findCell(
  MAP.grid,
  (cell, x, y) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none' && (x !== PUBLIC_LAND.x || y !== PUBLIC_LAND.y),
);
const WATER_INDEX = (() => {
  const { x, y } = findCell(MAP.grid, (cell) => cell.terrain === 'deep_water');
  return MAP.grid.index(x, y);
})();
const STARTER_ROAD = MAP.starter.roads[0];

/** Hlboká kópia cez JSON — rovnaká cesta ako save/load. */
function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Svet s netriviálnym stavom: cesty/koľaj, odstránená starter cesta, prenájom, hotovosť, rng, ID, rýchlosť. */
function busyWorld(): World {
  const world = create();
  runTicks(world, 123);
  world.enqueue(setRoad([PUBLIC_LAND], 'road'));
  world.enqueue(setRoad([OTHER_PUBLIC_LAND], 'rail'));
  world.enqueue(setRoad([STARTER_ROAD], 'none'));
  world.enqueue(
    new TestCommand({
      apply: (w) => {
        const parcel = w.parcels.get('west_quay');
        if (parcel === undefined) throw new Error('mapa nemá west_quay');
        parcel.ownership = 'leased';
        w.clock.setSpeed(4);
      },
    }),
  );
  world.enqueue(adjustCash(-420_000));
  world.enqueue(consumeRng());
  world.applyPending();
  return world;
}

describe('World.serialize — WorldState v1', () => {
  it('tvar: presne kľúče v1 v pevnom poradí a hodnoty novej hry', () => {
    const world = create();
    const state = world.serialize();
    expect(Object.keys(state)).toEqual(['version', 'mapId', 'seed', 'rng', 'clock', 'ids', 'cashCents', 'roads', 'parcels']);
    expect(state.version).toBe(WORLD_STATE_VERSION);
    expect(state.version).toBe(1);
    expect(state.mapId).toBe(MAP.id);
    expect(state.seed).toBe(SEED);
    expect(state.rng).toEqual(world.rng.getState());
    expect(state.clock).toEqual({ tick: 0, speed: 1 });
    expect(state.ids).toEqual({ nextId: 1 });
    expect(state.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(state.parcels).toEqual({ starter: 'owned', west_quay: 'none', east_yard: 'none' });
    expect(Object.keys(state.parcels)).toEqual(MAP.parcels.map((p) => p.id));
  });

  it('cesty = všetky bunky s road ≠ none ako [index, vrstva] vzostupne (vrátane starter ciest)', () => {
    const world = busyWorld();
    const state = world.serialize();
    const expected: [number, string][] = [];
    for (let i = 0; i < world.grid.cellCount; i++) {
      const { road } = world.grid.atIndex(i);
      if (road !== 'none') expected.push([i, road]);
    }
    expect(state.roads).toEqual(expected);
    const indexes = state.roads.map(([index]) => index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(state.roads).toContainEqual([MAP.grid.index(PUBLIC_LAND.x, PUBLIC_LAND.y), 'road']);
    expect(state.roads).toContainEqual([MAP.grid.index(OTHER_PUBLIC_LAND.x, OTHER_PUBLIC_LAND.y), 'rail']);
    expect(indexes).not.toContain(MAP.grid.index(STARTER_ROAD.x, STARTER_ROAD.y));
    expect(state.roads).toContainEqual([MAP.grid.index(MAP.starter.roads[1].x, MAP.starter.roads[1].y), 'road']);
  });

  it('čistý JSON: JSON roundtrip je hlboko rovný a nie sú v ňom inštancie tried', () => {
    const state = busyWorld().serialize();
    expect(viaJson(state)).toEqual(state);
    const plain = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return ['number', 'string', 'boolean'].includes(typeof value) || value === null;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype) return false;
      return Object.values(value).every(plain);
    };
    expect(plain(state)).toBe(true);
  });

  it('vrátený stav je kópia — nezdieľa nič meniteľné so svetom', () => {
    const world = busyWorld();
    const state = world.serialize();
    const hash = hashState(state);
    // Zmena vráteného stavu svet neovplyvní…
    state.rng[0] = 0;
    (state.roads as unknown as unknown[]).length = 0;
    (state.parcels as Record<string, string>).starter = 'none';
    expect(hashState(world.serialize())).toBe(hash);

    // …a neskoršie zmeny sveta nezmenia skôr vrátený stav.
    const fresh = world.serialize();
    runTicks(world, 10);
    world.enqueue(consumeRng());
    world.enqueue(setRoad([PUBLIC_LAND], 'none'));
    world.tick();
    expect(hashState(fresh)).toBe(hash);
    expect(hashState(world.serialize())).not.toBe(hash);
  });

  it('s neaplikovanými príkazmi vo fronte vyhodí chybu (fronta sa neukladá)', () => {
    const world = create();
    world.enqueue(new TestCommand());
    expect(() => world.serialize()).toThrow(/applyPending/);
    world.applyPending();
    expect(() => world.serialize()).not.toThrow();
  });
});

describe('World.deserialize', () => {
  it('deserialize(serialize(w)) po 1 000 tickoch ≡ w po ďalších 1 000 tickoch (hash serialize)', () => {
    const original = busyWorld();
    runTicks(original, 1000);
    const saved = viaJson(original.serialize());
    const restored = World.deserialize(DEFS, MAP, saved);
    expect(hashState(restored.serialize())).toBe(hashState(saved));

    // Rovnaké príkazy vrátane spotreby Rng — rozdielny stav rng by sa prejavil v hotovosti.
    for (const world of [original, restored]) {
      runTicks(world, 500);
      world.enqueue(consumeRng());
      world.enqueue(setRoad([MAP.starter.roads[2]], 'none'));
      runTicks(world, 500);
    }
    expect(restored.clock.tick).toBe(original.clock.tick);
    expect(hashState(restored.serialize())).toBe(hashState(original.serialize()));
    expect(restored.serialize()).toEqual(original.serialize());
  });

  it('obnoví hodiny, rng, ID, hotovosť, cesty a vlastníctvo parciel', () => {
    const original = busyWorld();
    const restored = World.deserialize(DEFS, MAP, viaJson(original.serialize()));
    expect(restored.clock.getState()).toEqual(original.clock.getState());
    expect(restored.clock.speed).toBe(4);
    expect(restored.rng.getState()).toEqual(original.rng.getState());
    expect(restored.ids.getState()).toEqual(original.ids.getState());
    expect(restored.cashCents).toBe(original.cashCents);
    expect(restored.seed).toBe(SEED);
    expect(restored.parcels.get('west_quay')?.ownership).toBe('leased');
    for (let i = 0; i < MAP.grid.cellCount; i++) {
      expect(restored.grid.atIndex(i)).toEqual(original.grid.atIndex(i));
    }
    // Odstránená starter cesta sa z mapy neobnoví.
    expect(restored.grid.at(STARTER_ROAD.x, STARTER_ROAD.y).road).toBe('none');
    expect(restored.pendingCommandCount).toBe(0);
  });

  it('nezdieľa stav so vstupom ani so šablónou mapy', () => {
    const state = busyWorld().serialize();
    const stateHash = hashState(state);
    const restored = World.deserialize(DEFS, MAP, state);
    restored.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).road = 'none';
    restored.enqueue(consumeRng());
    restored.tick();
    const parcel = restored.parcels.get('east_yard');
    if (parcel === undefined) throw new Error('mapa nemá east_yard');
    parcel.ownership = 'owned';
    expect(hashState(state)).toBe(stateHash);
    expect(MAP.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).road).toBe('none');
    expect(MAP.grid.at(STARTER_ROAD.x, STARTER_ROAD.y).road).toBe('road');
    expect(MAP.parcels.find((p) => p.id === 'east_yard')?.ownership).toBe('none');
    expect(MAP.parcels.find((p) => p.id === 'west_quay')?.ownership).toBe('none');

    // Zmena vstupu po načítaní svet neovplyvní.
    const again = World.deserialize(DEFS, MAP, state);
    const hash = hashState(again.serialize());
    state.rng[0] ^= 1;
    (state as { clock: unknown }).clock = { tick: 0, speed: 0 };
    (state.roads as unknown as unknown[]).length = 0;
    expect(hashState(again.serialize())).toBe(hash);
  });

  it('dva svety z jedného stavu sú nezávislé', () => {
    const state = busyWorld().serialize();
    const a = World.deserialize(DEFS, MAP, state);
    const b = World.deserialize(DEFS, MAP, state);
    a.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).road = 'none';
    a.rng.nextU32();
    expect(hashState(b.serialize())).toBe(hashState(state));
  });

  type Mutation = (state: Record<string, unknown>) => void;
  const set =
    (key: string, value: unknown): Mutation =>
    (state) => {
      state[key] = value;
    };
  const firstRoadIndex = (state: Record<string, unknown>): number => (state.roads as [number, string][])[0][0];

  const INVALID: readonly [string, Mutation, string][] = [
    ['neznámy kľúč', set('extra', 1), '/extra'],
    ['chýba kľúč', (s) => delete s.cashCents, '/cashCents'],
    ['iná verzia', set('version', 2), '/version'],
    ['iná mapa', set('mapId', 'harbor_99'), '/mapId'],
    ['záporný seed', set('seed', -1), '/seed'],
    ['seed ≥ 2^32', set('seed', 2 ** 32), '/seed'],
    ['nulový stav rng', set('rng', [0, 0, 0, 0]), '/rng'],
    ['krátky stav rng', set('rng', [1, 2, 3]), '/rng'],
    ['rng nie je pole', set('rng', 'abc'), '/rng'],
    ['clock nie je objekt', set('clock', null), '/clock'],
    ['clock bez speed', set('clock', { tick: 0 }), '/clock/speed'],
    ['clock s neznámym kľúčom', set('clock', { tick: 0, speed: 1, day: 0 }), '/clock/day'],
    ['záporný tick', set('clock', { tick: -1, speed: 1 }), '/clock'],
    ['rýchlosť mimo time.speeds', set('clock', { tick: 0, speed: 3 }), '/clock/speed'],
    ['ids.nextId 0', set('ids', { nextId: 0 }), '/ids'],
    ['ids bez nextId', set('ids', {}), '/ids/nextId'],
    ['zlomková hotovosť', set('cashCents', 1.5), '/cashCents'],
    ['hotovosť ako reťazec', set('cashCents', '100'), '/cashCents'],
    ['roads nie je pole', set('roads', {}), '/roads'],
    ['záznam cesty nie je dvojica', set('roads', [[1]]), '/roads/0'],
    ['záporný index bunky', set('roads', [[-1, 'road']]), '/roads/0/0'],
    ['index mimo mapy', set('roads', [[MAP.grid.cellCount, 'road']]), '/roads/0/0'],
    ['vrstva none', (s) => set('roads', [[firstRoadIndex(s), 'none']])(s), '/roads/0/1'],
    ['duplicitná bunka', (s) => set('roads', [[firstRoadIndex(s), 'road'], [firstRoadIndex(s), 'rail']])(s), '/roads/1/0'],
    ['cesta na vode', set('roads', [[WATER_INDEX, 'road']]), '/roads/0/0'],
    ['parcels nie je objekt', set('parcels', []), '/parcels'],
    ['neznáma parcela', (s) => ((s.parcels as Record<string, string>).nowhere = 'none'), '/parcels/nowhere'],
    ['chýba parcela', (s) => delete (s.parcels as Record<string, string>).east_yard, '/parcels/east_yard'],
    ['neplatné vlastníctvo', (s) => ((s.parcels as Record<string, string>).west_quay = 'sold'), '/parcels/west_quay'],
    ['prenájom neprenajímateľnej parcely', (s) => ((s.parcels as Record<string, string>).starter = 'leased'), '/parcels/starter'],
  ];

  it.each(INVALID)('%s → WorldStateError na %s', (_name, mutate, path) => {
    const state = viaJson(busyWorld().serialize()) as unknown as Record<string, unknown>;
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(DEFS, MAP, state as unknown as WorldState);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
    expect((error as WorldStateError).message.startsWith(`WorldState${path}: `)).toBe(true);
  });

  it('stav, ktorý nie je objekt → WorldStateError na koreni', () => {
    for (const raw of [null, 42, 'state', []]) {
      expect(() => World.deserialize(DEFS, MAP, raw as unknown as WorldState)).toThrow(WorldStateError);
    }
  });

  it('rýchlosť 0 (pauza) je platná, ak je v time.speeds', () => {
    const world = create();
    world.clock.setSpeed(0);
    expect(World.deserialize(DEFS, MAP, world.serialize()).clock.speed).toBe(0);
  });
});
