// Migrácia WorldState v1 → v2 (T02-03, ARCHITECTURE §14, rozhodnutie 8, ADR-014): v1 polia ostanú, pribudnú prázdne
// traffic/modules/cargo/ships, starter moduly mapy sa nedoplnia; aktuálna verzia prejde bez zmeny; neznáma verzia
// a zlý tvar v1 → WorldStateError. World.deserialize prijme v1 aj v2, serialize() vždy vráti v2.
import { describe, expect, it } from 'vitest';
import {
  OLDEST_WORLD_STATE_VERSION,
  WORLD_STATE_KEYS,
  WORLD_STATE_V1_KEYS,
  WORLD_STATE_V2,
  WORLD_STATE_VERSION,
  World,
  WorldStateError,
  migrateWorldState,
  type WorldState,
  type WorldStateV1,
} from '@sim/world';
import { BARE_MAP, DEFS, MAP, MAP_GRID, SEED, adjustCash, consumeRng, findCell, hashState, runTicks, setRoad } from './world-fixtures';

const PUBLIC_LAND = findCell(MAP_GRID, (cell) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none');

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * F1-like svet (cesty, hotovosť, rng, ids, rýchlosť, prenájom) bez modulov a nákladu — F1 moduly nepoznal, preto
 * vzniká na harbor_01 bez Root modulu (`BARE_MAP`, rovnaké `id` mapy); načítava sa voči plnej `MAP`.
 */
function f1World(): World {
  const world = World.create(DEFS, BARE_MAP, SEED);
  runTicks(world, 500);
  world.enqueue(setRoad([PUBLIC_LAND], 'road'));
  world.enqueue(setRoad([MAP.starter.roads[0]], 'none'));
  world.enqueue(adjustCash(-250_000));
  world.enqueue(consumeRng());
  world.applyPending();
  world.clock.setSpeed(8);
  const west = world.parcels.get('west_quay');
  if (west === undefined) throw new Error('mapa nemá west_quay');
  west.ownership = 'leased';
  return world;
}

/** Save vo formáte v1 (F1): len kľúče v1, `version: 1` — presne to, čo zapisoval F1 `serialize()`. */
function toV1(state: WorldState): WorldStateV1 {
  const v1: Record<string, unknown> = {};
  for (const key of WORLD_STATE_V1_KEYS) v1[key] = state[key];
  v1.version = 1;
  return viaJson(v1) as unknown as WorldStateV1;
}

describe('migrateWorldState', () => {
  it('verzie: najstaršia 1, aktuálna 2', () => {
    expect(OLDEST_WORLD_STATE_VERSION).toBe(1);
    expect(WORLD_STATE_VERSION).toBe(2);
  });

  it('krok v1 → v2 zapíše pomenovanú cieľovú verziu WORLD_STATE_V2 = najstaršia + 1 (T02-14, nie natvrdo 2)', () => {
    expect(WORLD_STATE_V2).toBe(OLDEST_WORLD_STATE_VERSION + 1);
    expect(WORLD_STATE_VERSION).toBe(WORLD_STATE_V2);
    const migrated = migrateWorldState(toV1(f1World().serialize())) as Record<string, unknown>;
    expect(migrated.version).toBe(WORLD_STATE_V2);
  });

  it('aktuálna verzia prejde bez zmeny (tá istá referencia)', () => {
    const state = World.create(DEFS, MAP, SEED).serialize();
    expect(migrateWorldState(state)).toBe(state);
  });

  it('v1 → v2: nový objekt, kľúče v2 v poradí serialize(), v1 hodnoty bez zmeny, prázdne nové polia', () => {
    const v1 = toV1(f1World().serialize());
    const before = viaJson(v1);
    const migrated = migrateWorldState(v1) as Record<string, unknown>;
    expect(migrated).not.toBe(v1);
    expect(Object.keys(migrated)).toEqual([...WORLD_STATE_KEYS]);
    for (const key of WORLD_STATE_V1_KEYS) {
      if (key !== 'version') expect(migrated[key]).toEqual(v1[key]);
    }
    expect(migrated.version).toBe(2);
    expect(migrated.traffic).toEqual([]);
    expect(migrated.modules).toEqual([]);
    expect(migrated.cargo).toEqual({ createdCount: 0, exportedCount: 0, units: [] });
    expect(migrated.ships).toEqual([]);
    expect(v1).toEqual(before); // vstup sa nezmenil
  });

  it('stav, ktorý nie je objekt → WorldStateError na koreni', () => {
    for (const raw of [null, 1, 'x', []]) {
      expect(() => migrateWorldState(raw)).toThrow(WorldStateError);
    }
  });

  const INVALID: readonly [string, string, Record<string, unknown>][] = [
    ['chýba version', '/version', {}],
    ['verzia 0', '/version', { version: 0 }],
    ['verzia 3', '/version', { version: 3 }],
    ['verzia ako reťazec', '/version', { version: '1' }],
    ['verzia 1.5', '/version', { version: 1.5 }],
  ];
  it.each(INVALID)('%s → WorldStateError na %s', (_name, path, raw) => {
    let error: unknown;
    try {
      migrateWorldState(raw);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
  });

  it('v1 s neznámym alebo chýbajúcim kľúčom → cesta v tvare v1', () => {
    const v1 = toV1(f1World().serialize()) as unknown as Record<string, unknown>;
    expect(() => migrateWorldState({ ...v1, modules: [] })).toThrow(expect.objectContaining({ path: '/modules' }) as Error);
    const missing = { ...v1 };
    delete missing.cashCents;
    expect(() => migrateWorldState(missing)).toThrow(expect.objectContaining({ path: '/cashCents' }) as Error);
  });
});

describe('World.deserialize — v1 save → migrate → v2', () => {
  it('v1 save sa načíta: hodiny, rng, ids, hotovosť, cesty a parcely ako v1; moduly, náklad, lode prázdne', () => {
    const original = f1World();
    const v1 = toV1(original.serialize());
    const world = World.deserialize(DEFS, MAP, v1);
    expect(world.clock.getState()).toEqual(v1.clock);
    expect(world.rng.getState()).toEqual(v1.rng);
    expect(world.ids.getState()).toEqual(v1.ids);
    expect(world.cashCents).toBe(v1.cashCents);
    expect(world.parcels.get('west_quay')?.ownership).toBe('leased');
    for (let i = 0; i < world.grid.cellCount; i++) expect(world.grid.atIndex(i).road).toBe(original.grid.atIndex(i).road);
    expect(world.modules.size).toBe(0);
    expect(world.berthGroups).toEqual([]);
    expect(world.ships.size).toBe(0);
    expect(world.cargo.getState()).toEqual({ createdCount: 0, exportedCount: 0, units: [] });
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('starter moduly mapy sa do starého save nedoplnia (rozhodnutie 8)', () => {
    expect(MAP.starter.modules.length).toBeGreaterThan(0);
    const world = World.deserialize(DEFS, MAP, toV1(World.create(DEFS, MAP, SEED).serialize()));
    expect(world.modules.size).toBe(0);
    const { x, y } = MAP.starter.modules[0];
    expect(world.moduleAt(x, y)).toBeUndefined();
  });

  it('serialize() po načítaní v1 vráti v2 s rovnakými v1 poliami a načíta sa znova rovnako', () => {
    const original = f1World();
    const v2 = original.serialize();
    const fromV1 = World.deserialize(DEFS, MAP, toV1(v2));
    const saved = fromV1.serialize();
    expect(saved.version).toBe(2);
    // F1 svet nemá moduly ani náklad, takže v2 z migrácie = v2 zo serialize() (traffic je v F1 vždy 0).
    expect(saved).toEqual(v2);
    expect(hashState(World.deserialize(DEFS, MAP, viaJson(saved)).serialize())).toBe(hashState(saved));
  });

  it('svet z v1 pokračuje rovnako ako svet z v2 (hash po 2 000 tickoch s príkazmi)', () => {
    const original = f1World();
    const fromV1 = World.deserialize(DEFS, MAP, toV1(original.serialize()));
    const fromV2 = World.deserialize(DEFS, MAP, viaJson(original.serialize()));
    for (const world of [fromV1, fromV2]) {
      runTicks(world, 1000);
      world.enqueue(consumeRng());
      world.enqueue(setRoad([MAP.starter.roads[3]], 'none'));
      runTicks(world, 1000);
    }
    expect(hashState(fromV1.serialize())).toBe(hashState(fromV2.serialize()));
  });

  it('neplatná hodnota v1 poľa sa ohlási s cestou v1 (napr. /cashCents) až pri parsovaní v2', () => {
    const v1 = { ...(toV1(f1World().serialize()) as unknown as Record<string, unknown>), cashCents: 1.5 };
    expect(() => World.deserialize(DEFS, MAP, v1 as unknown as WorldStateV1)).toThrow(expect.objectContaining({ path: '/cashCents' }) as Error);
  });
});
