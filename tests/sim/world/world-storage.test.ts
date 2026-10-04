// Sklady a depá vo svete (T03-02, T03-05; ARCHITECTURE §5.3, §6 krok 12, §7.7, §14; ADR-017, ADR-018): stavba cez
// ModuleRegistry, invarianty kroku 12 (rezervácie ≤ kapacita, stored + reserved ≤ capacity, rezervovaný slot nie je
// obsadený, slot jednotky v rozsahu, kategória, depo ≤ capacity, rezervácie = sloty aktívnych jobov), odstránenie
// s nákladom/rezerváciou a save v3 (runtime skladu = len počítadlá — rezervácie sa odvodia z jobov, depo {}),
// roundtrip aj fail-fast obnova.
//
// harbor_01 bez Root modulu (BARE_MAP): dvor (50, 20) → konektor (51, 23, s), depo (34, 20) → konektor (35, 22, s).
import cargoTypesJson from '@data/defs/cargo_types.json';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { ContainerYard, StorageModule, VehicleDepot, type Module, type StorageRuntimeState } from '@sim/modules';
import { World, WorldStateError, findWorldViolation, type WorldState } from '@sim/world';
import { addVehicleTo } from '../vehicles/vehicle-fixtures';
import { BARE_MAP, DEFS, RAW_DEFS, SEED, hashState, runTicks } from './world-fixtures';

const YARD = 'container_yard_small';
const DEPOT = 'vehicle_depot';
const TEU = 'container_teu';
const GRAIN = 'grain_test';
const id = (value: number): EntityId => value as EntityId;

/** Bundled defy + sypký typ (sklad kategórie container ho nesmie držať). */
const GRAIN_DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  cargo_types: {
    ...cargoTypesJson,
    items: [
      ...cargoTypesJson.items,
      { id: GRAIN, category: 'bulk', unitName: 't', unitsPerBatch: 25, basePricePerUnitCents: 1200, exportPricePerUnitCents: 1000, repositioningPricePerUnitCents: 300, transhipPricePerUnitCents: 700, xpPerUnit: 1, colorToken: 'cargo-bulk' },
    ],
  },
});

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asYard(module: Module): StorageModule {
  if (!(module instanceof StorageModule)) throw new Error(`${module.label} nie je sklad`);
  return module;
}

function asDepot(module: Module): VehicleDepot {
  if (!(module instanceof VehicleDepot)) throw new Error(`${module.label} nie je depo`);
  return module;
}

interface StorageWorld {
  readonly world: World;
  readonly yard: StorageModule;
  readonly depot: VehicleDepot;
}

function storageWorld(defs: DefRegistry = DEFS): StorageWorld {
  const world = World.create(defs, BARE_MAP, SEED);
  const yard = asYard(world.placeModule({ defId: YARD, x: 50, y: 20, rotation: 0 }, 15_000_000));
  const depot = asDepot(world.placeModule({ defId: DEPOT, x: 34, y: 20, rotation: 0 }, 9_000_000));
  return { world, yard, depot };
}

/** Jednotka po reťazci §7.1 až vo vozidle (vozidlá prídu v T03-04 — invarianty sa medzitým nevolajú). */
function unitInVehicle(world: World, typeId = TEU): EntityId {
  const unit = world.cargo.create(typeId, { kind: 'on_ship', shipId: id(900) }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
  world.cargo.move(unit, { kind: 'on_apron', berthId: id(902), slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
  return unit;
}

/** Vykládka do skladu ako vozidlo (T03-06): rezervovaný slot → presun v ledgeri → commit. */
function store(world: World, yard: StorageModule, slot = yard.reserve(), typeId = TEU): EntityId {
  const unit = unitInVehicle(world, typeId);
  yard.assertCommittable(slot, unit);
  world.cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot });
  yard.commit(slot, unit);
  return unit;
}

describe('sklad a depo vo svete', () => {
  it('placeModule vytvorí ContainerYard a VehicleDepot podľa kind/kategórie; bunky footprintu patria modulom', () => {
    const { world, yard, depot } = storageWorld();
    expect(yard).toBeInstanceOf(ContainerYard);
    expect(world.moduleAt(53, 23)).toBe(yard);
    expect(world.moduleAt(36, 22)).toBe(depot);
    expect([yard.purchaseCostCents, depot.purchaseCostCents]).toEqual([15_000_000, 9_000_000]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('krok 12 prejde so skladom s uloženými slotmi a s depom s vozidlami ≤ capacity', () => {
    const { world, yard, depot } = storageWorld();
    store(world, yard);
    store(world, yard);
    world.grid.at(35, 23).road = 'road'; // vozidlo stojí na ceste pred depom (krok 12, ADR-019)
    world.markRoadsChanged();
    const vehicle = addVehicleTo(world, depot.id); // vozidlo cez World (T03-04) — depo ho eviduje vo vehicleIds
    expect(depot.vehicleIds).toEqual([vehicle.id]);
    expect([yard.storedCount, yard.reservedCount, yard.freeCount, yard.unitsIn]).toEqual([2, 0, 62, 2]);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(() => world.tick()).not.toThrow();
  });
});

describe('invarianty skladu a depa (krok 12)', () => {
  const CASES: readonly [string, RegExp, (h: StorageWorld & { grain?: boolean }) => void][] = [
    [
      'rezervovaný slot skladu obsadený presunom bez commit',
      /sklad container_yard_small #\d+: rezervovaný slot 0 obsadila jednotka/,
      ({ world, yard }) => {
        const slot = yard.reserve();
        world.cargo.move(unitInVehicle(world), { kind: 'in_storage', moduleId: yard.id, slot });
      },
    ],
    [
      'rezervácia skladu bez aktívneho jobu (rezervácie patria jobom, ADR-018)',
      /container_yard_small #\d+: rezervované sloty \[0\] ≠ sloty aktívnych jobov \[\]/,
      ({ yard }) => void yard.reserve(),
    ],
    [
      'jednotka v sklade na slote mimo kapacity',
      /leží na slote 64 mimo 0…63/,
      ({ world, yard }) => world.cargo.move(unitInVehicle(world), { kind: 'in_storage', moduleId: yard.id, slot: 64 }),
    ],
    [
      'depo s duplicitným vozidlom',
      /vehicleIds \[7, 7\] obsahujú duplicitu/,
      ({ depot }) => {
        // vehicleIds je zmrazená snímka (T03-14) — poškodenie len cez privátne pole v teste
        (depot as unknown as { view: readonly EntityId[] }).view = [id(7), id(7)];
      },
    ],
    [
      'depo s viac vozidlami než státí',
      /má 11 vozidiel \(capacity 10\)/,
      ({ depot }) => {
        (depot as unknown as { view: readonly EntityId[] }).view = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(id);
      },
    ],
  ];

  it.each(CASES)('%s', (_name, message, corrupt) => {
    const h = storageWorld();
    corrupt(h);
    expect(findWorldViolation(h.world)).toMatch(message);
  });

  it('sklad kategórie container s jednotkou kategórie bulk', () => {
    const { world, yard } = storageWorld(GRAIN_DEFS);
    const slot = yard.reserve();
    const unit = unitInVehicle(world, GRAIN);
    world.cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot });
    yard.commit(slot, unit);
    expect(findWorldViolation(world)).toMatch(/\(kategória 'container'\) drží jednotku #\d+ kategórie 'bulk'/);
  });
});

describe('odstránenie skladu', () => {
  it('sklad s uloženou jednotkou alebo s rezerváciou → has_cargo; prázdny ide odstrániť', () => {
    const { world, yard } = storageWorld();
    const slot = yard.reserve();
    expect(() => world.removeModule(yard.id)).toThrow(/má rezervované sloty \(in_storage\): 1/);
    const unit = store(world, yard, slot);
    expect(() => world.removeModule(yard.id)).toThrow(/drží náklad \(in_storage\)/);
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
    yard.recordTaken(unit);
    world.removeModule(yard.id);
    expect(world.modules.has(yard.id)).toBe(false);
  });
});

describe('WorldState v3 — sklad a depo v save', () => {
  it('runtime skladu = len počítadlá (rezervácie sa odvodia z jobov, ADR-018), depo {}; obsadenie ide len v cargo', () => {
    const { world, yard, depot } = storageWorld();
    const kept = store(world, yard);
    const taken = store(world, yard);
    world.cargo.move(taken, { kind: 'in_vehicle', vehicleId: id(903) });
    yard.recordTaken(taken);
    world.cargo.move(taken, { kind: 'in_storage', moduleId: yard.id, slot: 1 }); // znova uložená bez rezervácie (ako obnova)
    const state = world.serialize();
    const yardEntry = state.modules.find((entry) => entry.id === yard.id);
    const depotEntry = state.modules.find((entry) => entry.id === depot.id);
    expect(yardEntry?.runtime).toEqual({ unitsIn: 2, unitsOut: 1 } satisfies StorageRuntimeState);
    expect(depotEntry?.runtime).toEqual({});
    expect(state.jobs).toEqual([]);
    expect(state.cargo.units.map((unit) => [unit.id, unit.location])).toEqual([
      [kept, { kind: 'in_storage', moduleId: yard.id, slot: 0 }],
      [taken, { kind: 'in_storage', moduleId: yard.id, slot: 1 }],
    ]);
  });

  it('roundtrip: rovnaký stav, triedy, obsadenie z ledgera vo FIFO a počítadlá; ďalší priebeh rovnaký', () => {
    const { world, yard } = storageWorld();
    const [s0, s1] = [yard.reserve(), yard.reserve()];
    const a = store(world, yard, s1);
    const b = store(world, yard, s0);
    const state = viaJson(world.serialize());
    const restored = World.deserialize(DEFS, BARE_MAP, state);
    expect(restored.serialize()).toEqual(state);
    const copy = asYard(restored.modules.get(yard.id) as Module);
    expect(copy).toBeInstanceOf(ContainerYard);
    expect([copy.units(), copy.slotOf(a), copy.slotOf(b), copy.reservedSlots()]).toEqual([[a, b], 1, 0, []]);
    expect([copy.storedCount, copy.reservedCount, copy.unitsIn, copy.unitsOut]).toEqual([2, 0, 2, 0]);
    expect(restored.modules.get(id(yard.id + 1))).toBeInstanceOf(VehicleDepot);
    runTicks(world, 300);
    runTicks(restored, 300);
    expect(hashState(restored.serialize())).toBe(hashState(world.serialize()));
  });

  type Mutation = (state: {
    modules: { id: number; runtime: Record<string, unknown> }[];
    cargo: { units: { id: number; location: Record<string, unknown> }[] };
  }) => void;
  const runtimeOf = (state: Parameters<Mutation>[0], index: number): Record<string, unknown> => state.modules[index].runtime;

  // Poradie v save: [0] dvor, [1] depo; jednotky [0] slot 0, [1] slot 3.
  const INVALID: readonly [string, string, Mutation][] = [
    ['runtime skladu bez kľúča', '/modules/0/runtime/unitsIn', (s) => delete runtimeOf(s, 0).unitsIn],
    ['runtime skladu s rezerváciami (v2 tvar; v3 ich odvodí z jobov)', '/modules/0/runtime/reservedSlots', (s) => (runtimeOf(s, 0).reservedSlots = [1])],
    ['záporné unitsOut', '/modules/0/runtime/unitsOut', (s) => (runtimeOf(s, 0).unitsOut = -1)],
    ['runtime depa s kľúčom', '/modules/1/runtime/vehicleIds', (s) => (runtimeOf(s, 1).vehicleIds = [])],
    ['jednotka na slote mimo kapacity skladu', '/cargo/units/1/location/slot', (s) => (s.cargo.units[1].location.slot = 64)],
    ['jednotka v neexistujúcom sklade', '/cargo/units/1/location/moduleId', (s) => (s.cargo.units[1].location.moduleId = 99)],
    ['jednotka „v sklade" depa', '/cargo/units/1/location/moduleId', (s) => (s.cargo.units[1].location.moduleId = s.modules[1].id)],
  ];

  it.each(INVALID)('%s → WorldStateError na %s', (_name, path, mutate) => {
    const { world, yard } = storageWorld();
    const [s0, s1, s2, s3] = [yard.reserve(), yard.reserve(), yard.reserve(), yard.reserve()];
    store(world, yard, s0);
    store(world, yard, s3);
    yard.release(s1);
    yard.release(s2);
    const state = viaJson(world.serialize()) as unknown as Parameters<Mutation>[0];
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(DEFS, BARE_MAP, state as unknown as WorldState);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
  });

  it('jednotka iného typu v sklade → WorldStateError z poistky findWorldViolation (cesta "")', () => {
    const { world, yard } = storageWorld(GRAIN_DEFS);
    store(world, yard, yard.reserve(), GRAIN);
    let error: unknown;
    try {
      World.deserialize(GRAIN_DEFS, BARE_MAP, viaJson(world.serialize()));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe('');
    expect((error as WorldStateError).message).toMatch(/kategórie 'bulk'/);
  });
});
