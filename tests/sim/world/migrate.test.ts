// Migrácia WorldState (T02-03, T03-04, T03-05, T04-04; ARCHITECTURE §14, ADR-014, ADR-018, ADR-024): v1 → v2 (v1 polia
// ostanú, pribudnú prázdne traffic/modules/cargo/ships, starter moduly mapy sa nedoplnia) → v3 (v2 polia ostanú, pribudnú
// prázdne vehicles/jobs, runtime skladu stratí reservedSlots a kotvisko dostane lastNoStorageHour: null) → v4 (v3 polia
// ostanú, pribudne prázdne trucks, rampa dostane lastNoWaitingBayHour: null); aktuálna verzia prejde bez zmeny; neznáma
// verzia a zlý tvar staršej verzie → WorldStateError. World.deserialize prijme v1 až v4, serialize() vždy vráti v4.
import { describe, expect, it } from 'vitest';
import {
  OLDEST_WORLD_STATE_VERSION,
  WORLD_STATE_KEYS,
  WORLD_STATE_V1_KEYS,
  WORLD_STATE_V2,
  WORLD_STATE_V2_KEYS,
  WORLD_STATE_V3,
  WORLD_STATE_V3_KEYS,
  WORLD_STATE_V4,
  WORLD_STATE_V4_KEYS,
  WORLD_STATE_VERSION,
  World,
  WorldStateError,
  migrateWorldState,
  type WorldState,
  type WorldStateV1,
  type WorldStateV2,
  type WorldStateV3,
} from '@sim/world';
import { commandFromJSON } from '@sim/commands';
import type { VehicleDepot } from '@sim/modules';
import { outboundWorld, rampOf } from '../logistics/outbound-fixtures';
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

/** `runtime` modulu tak, ako ho zapisoval v2 (T03-02): kotvisko `{}`, sklad s `reservedSlots` pred počítadlami. */
const RUNTIME_AS_V2: Partial<Record<string, (runtime: Record<string, unknown>) => Record<string, unknown>>> = {
  berth: () => ({}),
  storage: (runtime) => ({ reservedSlots: [], ...runtime }),
};

/** Save vo formáte v2 (F2 / T03-02): len kľúče v2, `version: 2`, `runtime` modulov ako v2 — presne to, čo zapisoval F2/T03-02 `serialize()`. */
function toV2(state: WorldState): WorldStateV2 {
  const v2: Record<string, unknown> = {};
  for (const key of WORLD_STATE_V2_KEYS) v2[key] = state[key];
  v2.version = 2;
  v2.modules = state.modules.map((entry) => {
    const downgrade = RUNTIME_AS_V2[DEFS.modules.get(entry.defId).kind];
    return downgrade === undefined ? entry : { ...entry, runtime: downgrade({ ...entry.runtime }) };
  });
  return viaJson(v2) as unknown as WorldStateV2;
}

/** `runtime` modulu tak, ako ho zapisoval v3 (T04-02/T04-03): rampa `{}`. */
const RUNTIME_AS_V3: Partial<Record<string, (runtime: Record<string, unknown>) => Record<string, unknown>>> = {
  ramp: () => ({}),
};

/** Save vo formáte v3 (F3 / T04-03): len kľúče v3, `version: 3`, `runtime` rampy `{}` — to, čo zapisoval `serialize()` pred T04-04. */
function toV3(state: WorldState): WorldStateV3 {
  const v3: Record<string, unknown> = {};
  for (const key of WORLD_STATE_V3_KEYS) v3[key] = state[key];
  v3.version = 3;
  v3.modules = state.modules.map((entry) => {
    const downgrade = RUNTIME_AS_V3[DEFS.modules.get(entry.defId).kind];
    return downgrade === undefined ? entry : { ...entry, runtime: downgrade({ ...entry.runtime }) };
  });
  return viaJson(v3) as unknown as WorldStateV3;
}

describe('migrateWorldState', () => {
  it('verzie: najstaršia 1, aktuálna 4; kľúče v4 = v3 + trucks = WORLD_STATE_KEYS, v3 = v2 + vehicles, jobs', () => {
    expect(OLDEST_WORLD_STATE_VERSION).toBe(1);
    expect(WORLD_STATE_VERSION).toBe(4);
    expect(WORLD_STATE_V4_KEYS).toEqual([...WORLD_STATE_V3_KEYS, 'trucks']);
    expect(WORLD_STATE_V3_KEYS).toEqual([...WORLD_STATE_V2_KEYS, 'vehicles', 'jobs']);
    expect(WORLD_STATE_V2_KEYS).toEqual([...WORLD_STATE_V1_KEYS, 'traffic', 'modules', 'cargo', 'ships']);
    expect([...WORLD_STATE_KEYS]).toEqual([...WORLD_STATE_V4_KEYS]);
  });

  it('kroky zapisujú pomenované cieľové verzie: WORLD_STATE_V2 = najstaršia + 1, V3 = V2 + 1, V4 = V3 + 1 = aktuálna', () => {
    expect(WORLD_STATE_V2).toBe(OLDEST_WORLD_STATE_VERSION + 1);
    expect(WORLD_STATE_V3).toBe(WORLD_STATE_V2 + 1);
    expect(WORLD_STATE_V4).toBe(WORLD_STATE_V3 + 1);
    expect(WORLD_STATE_VERSION).toBe(WORLD_STATE_V4);
    const migrated = migrateWorldState(toV1(f1World().serialize()), DEFS) as Record<string, unknown>;
    expect(migrated.version).toBe(WORLD_STATE_V4);
  });

  it('aktuálna verzia prejde bez zmeny (tá istá referencia)', () => {
    const state = World.create(DEFS, MAP, SEED).serialize();
    expect(migrateWorldState(state, DEFS)).toBe(state);
  });

  it('v1 → v2 → v3 → v4: nový objekt, kľúče v4 v poradí serialize(), v1 hodnoty bez zmeny, prázdne nové polia', () => {
    const v1 = toV1(f1World().serialize());
    const before = viaJson(v1);
    const migrated = migrateWorldState(v1, DEFS) as Record<string, unknown>;
    expect(migrated).not.toBe(v1);
    expect(Object.keys(migrated)).toEqual([...WORLD_STATE_KEYS]);
    for (const key of WORLD_STATE_V1_KEYS) {
      if (key !== 'version') expect(migrated[key]).toEqual(v1[key]);
    }
    expect(migrated.version).toBe(4);
    expect(migrated.traffic).toEqual([]);
    expect(migrated.modules).toEqual([]);
    expect(migrated.cargo).toEqual({ createdCount: 0, exportedCount: 0, units: [] });
    expect(migrated.ships).toEqual([]);
    expect(migrated.vehicles).toEqual([]);
    expect(migrated.jobs).toEqual([]);
    expect(migrated.trucks).toEqual([]);
    expect(v1).toEqual(before); // vstup sa nezmenil
  });

  it('v2 → v3 → v4: nový objekt, kľúče v4, v2 hodnoty bez zmeny (náklad, lode…) okrem runtime modulov, prázdne vehicles, jobs a trucks', () => {
    const world = World.create(DEFS, MAP, SEED);
    runTicks(world, 50);
    const v3 = world.serialize();
    const v2 = toV2(v3);
    const before = viaJson(v2);
    const migrated = migrateWorldState(v2, DEFS) as Record<string, unknown>;
    expect(migrated).not.toBe(v2);
    expect(Object.keys(migrated)).toEqual([...WORLD_STATE_KEYS]);
    for (const key of WORLD_STATE_V2_KEYS) {
      if (key !== 'version' && key !== 'modules') expect(migrated[key]).toEqual((v2 as unknown as Record<string, unknown>)[key]);
    }
    expect((migrated.modules as unknown[]).length).toBe(MAP.starter.modules.length);
    expect(migrated.modules).toEqual(v3.modules); // kotvisko dostalo lastNoStorageHour: null, žeriav bez zmeny
    expect(migrated.version).toBe(WORLD_STATE_V4);
    expect(migrated.vehicles).toEqual([]);
    expect(migrated.jobs).toEqual([]);
    expect(migrated.trucks).toEqual([]);
    expect(v2).toEqual(before);
  });

  it('v3 → v4 (ADR-024): nový objekt, kľúče v4, v3 hodnoty bez zmeny okrem runtime rampy (lastNoWaitingBayHour null), prázdne trucks', () => {
    const v3 = toV3(World.create(DEFS, MAP, SEED).serialize()) as unknown as { modules: Record<string, unknown>[] } & Record<string, unknown>;
    v3.modules.push(
      { id: 90, defId: 'loading_ramp_container', x: 30, y: 20, rotation: 0, purchaseCostCents: 0, runtime: {} },
      { id: 91, defId: 'truck_gate', x: 36, y: 20, rotation: 0, purchaseCostCents: 0, runtime: { queue: [], busyTicksLeft: 0, trucksProcessed: 3 } },
      { id: 92, defId: 'truck_waiting_area', x: 40, y: 20, rotation: 0, purchaseCostCents: 0, runtime: {} },
    );
    const before = viaJson(v3);
    const migrated = migrateWorldState(v3, DEFS) as { modules: { defId: string; runtime: unknown }[] } & Record<string, unknown>;
    expect(migrated).not.toBe(v3);
    expect(Object.keys(migrated)).toEqual([...WORLD_STATE_KEYS]);
    expect(migrated.version).toBe(WORLD_STATE_V4);
    expect(migrated.trucks).toEqual([]);
    for (const key of WORLD_STATE_V3_KEYS) {
      if (key !== 'version' && key !== 'modules') expect(migrated[key]).toEqual(v3[key]);
    }
    expect(migrated.modules.slice(-3).map((entry) => [entry.defId, entry.runtime])).toEqual([
      ['loading_ramp_container', { lastNoWaitingBayHour: null }],
      ['truck_gate', { queue: [], busyTicksLeft: 0, trucksProcessed: 3 }],
      ['truck_waiting_area', {}],
    ]);
    expect(v3).toEqual(before); // vstup (ani vnorené runtime) sa nezmenil
  });

  it('v3 s neznámym kľúčom (napr. trucks) → cesta v tvare v3', () => {
    const v3 = toV3(World.create(DEFS, MAP, SEED).serialize()) as unknown as Record<string, unknown>;
    expect(() => migrateWorldState({ ...v3, trucks: [] }, DEFS)).toThrow(expect.objectContaining({ path: '/trucks' }) as Error);
  });

  it('v2 → v3 runtime modulov podľa druhu (ADR-018): sklad stratí reservedSlots, kotvisko dostane lastNoStorageHour null, iné a neznáme defy bez zmeny', () => {
    const v2 = toV2(World.create(DEFS, MAP, SEED).serialize()) as unknown as { modules: Record<string, unknown>[] };
    v2.modules.push(
      { id: 90, defId: 'container_yard_small', x: 30, y: 20, rotation: 0, purchaseCostCents: 0, runtime: { reservedSlots: [1, 2], unitsIn: 3, unitsOut: 1 } },
      { id: 91, defId: 'vehicle_depot', x: 36, y: 20, rotation: 0, purchaseCostCents: 0, runtime: {} },
      { id: 92, defId: 'neznamy_modul', x: 40, y: 20, rotation: 0, purchaseCostCents: 0, runtime: { reservedSlots: [0] } },
    );
    const before = viaJson(v2);
    const migrated = migrateWorldState(v2, DEFS) as { modules: { defId: string; runtime: unknown }[] };
    expect(migrated.modules.map((entry) => [entry.defId, entry.runtime])).toEqual([
      ['berth_standard', { lastNoStorageHour: null }],
      ['crane_container_gantry', (before.modules[1] as { runtime: unknown }).runtime],
      ['container_yard_small', { unitsIn: 3, unitsOut: 1 }],
      ['vehicle_depot', {}],
      ['neznamy_modul', { reservedSlots: [0] }],
    ]);
    expect(v2).toEqual(before); // vstup (ani vnorené runtime) sa nezmenil
  });

  it('stav, ktorý nie je objekt → WorldStateError na koreni', () => {
    for (const raw of [null, 1, 'x', []]) {
      expect(() => migrateWorldState(raw, DEFS)).toThrow(WorldStateError);
    }
  });

  const INVALID: readonly [string, string, Record<string, unknown>][] = [
    ['chýba version', '/version', {}],
    ['verzia 0', '/version', { version: 0 }],
    ['verzia 5 (budúca)', '/version', { version: 5 }],
    ['verzia ako reťazec', '/version', { version: '1' }],
    ['verzia 1.5', '/version', { version: 1.5 }],
  ];
  it.each(INVALID)('%s → WorldStateError na %s', (_name, path, raw) => {
    let error: unknown;
    try {
      migrateWorldState(raw, DEFS);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
  });

  it('v1 s neznámym alebo chýbajúcim kľúčom → cesta v tvare v1', () => {
    const v1 = toV1(f1World().serialize()) as unknown as Record<string, unknown>;
    expect(() => migrateWorldState({ ...v1, modules: [] }, DEFS)).toThrow(expect.objectContaining({ path: '/modules' }) as Error);
    const missing = { ...v1 };
    delete missing.cashCents;
    expect(() => migrateWorldState(missing, DEFS)).toThrow(expect.objectContaining({ path: '/cashCents' }) as Error);
  });

  it('v2 s neznámym (napr. vehicles) alebo chýbajúcim kľúčom → cesta v tvare v2', () => {
    const v2 = toV2(World.create(DEFS, MAP, SEED).serialize()) as unknown as Record<string, unknown>;
    expect(() => migrateWorldState({ ...v2, vehicles: [] }, DEFS)).toThrow(expect.objectContaining({ path: '/vehicles' }) as Error);
    const missing = { ...v2 };
    delete missing.ships;
    expect(() => migrateWorldState(missing, DEFS)).toThrow(expect.objectContaining({ path: '/ships' }) as Error);
  });
});

describe('World.deserialize — v1 save → migrate → v4', () => {
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

  it('serialize() po načítaní v1 vráti v4 s rovnakými v1 poliami a načíta sa znova rovnako', () => {
    const original = f1World();
    const v4 = original.serialize();
    const fromV1 = World.deserialize(DEFS, MAP, toV1(v4));
    const saved = fromV1.serialize();
    expect(saved.version).toBe(4);
    // F1 svet nemá moduly, náklad, vozidlá ani kamióny, takže v4 z migrácie = v4 zo serialize() (traffic je v F1 vždy 0).
    expect(saved).toEqual(v4);
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

  it('neplatná hodnota v1 poľa sa ohlási s cestou v1 (napr. /cashCents) až pri parsovaní v3', () => {
    const v1 = { ...(toV1(f1World().serialize()) as unknown as Record<string, unknown>), cashCents: 1.5 };
    expect(() => World.deserialize(DEFS, MAP, v1 as unknown as WorldStateV1)).toThrow(expect.objectContaining({ path: '/cashCents' }) as Error);
  });
});

describe('World.deserialize — v2 save (F2 so skladom a depom) → migrate → v3', () => {
  /** F2/T03-02 svet: Root modul, loď s nákladom uprostred vykládky, cesta, dvor a depo bez vozidiel. */
  function f2World(): World {
    const world = World.create(DEFS, MAP, SEED);
    world.enqueue(commandFromJSON({ type: 'PlaceRoad', cells: [{ x: 35, y: 23 }, { x: 36, y: 23 }] }));
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: 'vehicle_depot', x: 34, y: 20, rotation: 0 }));
    world.enqueue(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
    runTicks(world, 700);
    return world;
  }

  it('v2 save sa načíta a pokračuje rovnako ako pôvodný svet (hash po ďalších 500 tickoch); depo nemá vozidlá', () => {
    const original = f2World();
    const fromV2 = World.deserialize(DEFS, MAP, toV2(original.serialize()));
    expect(fromV2.vehicles.size).toBe(0);
    const depot = [...fromV2.modules.values()].find((module) => module.kind === 'depot') as VehicleDepot | undefined;
    expect(depot?.vehicleIds).toEqual([]);
    // v2 nepoznal throttle `NoStorageAvailable` (ADR-018): kotvisko z v2 začína s lastNoStorageHour null, pôvodný svet
    // (s dispatcherom, jednotky na aprone bez skladu) už v hodine 1 hlásil. Inak je stav zhodný.
    const expected = original.serialize();
    expect((expected.modules[0].runtime as { lastNoStorageHour: unknown }).lastNoStorageHour).toBe(1);
    expect(fromV2.serialize()).toEqual({
      ...expected,
      modules: expected.modules.map((entry, i) => (i === 0 ? { ...entry, runtime: { lastNoStorageHour: null } } : entry)),
    });
    runTicks(original, 500);
    runTicks(fromV2, 500);
    expect(hashState(fromV2.serialize())).toBe(hashState(original.serialize()));
  });
});

describe('World.deserialize — v3 save (F4 s bránou, stojiskom a rampou pred kamiónmi) → migrate → v4', () => {
  it('v3 save sa načíta ako pôvodný svet a pokračuje rovnako aj po príchode kamiónov a exporte (ADR-024)', () => {
    const { world: original } = outboundWorld({ defs: DEFS });
    const ramp = rampOf(original);
    for (const dock of [0, 1]) {
      const unit = original.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as never }).id;
      original.cargo.move(unit, { kind: 'in_crane', craneId: 901 as never });
      original.cargo.move(unit, { kind: 'on_apron', berthId: 1 as never, slot: 0 });
      original.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as never });
      original.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
    }
    expect(original.trucks.size).toBe(0);
    const v3 = toV3(original.serialize());
    expect((v3 as unknown as Record<string, unknown>)['trucks']).toBeUndefined();
    const migrated = World.deserialize(DEFS, MAP, v3);
    expect(hashState(migrated.serialize())).toBe(hashState(original.serialize()));
    for (const world of [original, migrated]) runTicks(world, 600);
    expect(original.cargo.exportedCount).toBe(2);
    expect(hashState(migrated.serialize())).toBe(hashState(original.serialize()));
  });
});
