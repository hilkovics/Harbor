// WorldState — vozidlá (T03-04…T03-06; docs/tasks/phase-03.md rozhodnutie 10; ARCHITECTURE §14; ADR-018, ADR-019): vozidlá
// v save (id, def, depo, stav, poloha, kurz, job, zaplatená cena, zvyšok trasy, progres, odpočet, príznak preplánovania)
// vzostupne podľa id; roundtrip (depo dostane vehicleIds v poradí nákupu, rovnaký ďalší priebeh), fail-fast parsovanie
// aj obnova s JSON pointermi, náklad in_vehicle sa overí voči existencii, kapacite, kategóriám a jobu vozidla. Joby
// podrobne: world-jobs.test.ts.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { VehicleDepot } from '@sim/modules';
import { SERIALIZED_VEHICLE_KEYS, Vehicle } from '@sim/vehicles';
import { WORLD_STATE_VERSION, World, WorldStateError, type WorldState } from '@sim/world';
import type { StorageModule } from '@sim/modules';
import { GRAIN, GRAIN_DEFS, STRADDLE, STRADDLE_DEF, addVehicleTo, buy, carryingVehicle, depotWorld, execute, loadInto, sell } from '../vehicles/vehicle-fixtures';
import { DEFS, MAP, SEED, hashState, runTicks } from './world-fixtures';

const id = (value: number): EntityId => value as EntityId;
/** Index vonkajšej bunky depa (35, 23) na harbor_01 (šírka 96) — trasa nečinného vozidla z `fleetWorld`. */
const ROUTE_CELL = 23 * 96 + 35;

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Svet s depom (id 3), dvorom (id 4) a tromi vozidlami, z ktorých stredné je predané (id 5, 7 ostanú). */
function fleetWorld(): World {
  const { world, depot } = depotWorld({ yard: true });
  execute(world, buy(depot.id));
  execute(world, buy(depot.id));
  execute(world, buy(depot.id));
  const middle = [...world.vehicles.keys()][1];
  execute(world, sell(middle));
  runTicks(world, 25);
  return world;
}

function errorOf(action: () => unknown): WorldStateError {
  try {
    action();
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw error;
  }
  throw new Error('očakávaná WorldStateError, nič nevyhodilo');
}

describe('World.serialize — vozidlá', () => {
  it('vehicles = Vehicle.toState() vzostupne podľa id (poradie nákupu), jobs = []', () => {
    const world = fleetWorld();
    const state = world.serialize();
    expect(state.version).toBe(WORLD_STATE_VERSION);
    expect(state.jobs).toEqual([]);
    expect(state.vehicles.map((vehicle) => vehicle.id)).toEqual([...world.vehicles.keys()]);
    expect(state.vehicles).toHaveLength(2);
    for (const entry of state.vehicles) {
      expect(Object.keys(entry)).toEqual([...SERIALIZED_VEHICLE_KEYS]);
      expect(entry).toMatchObject({ defId: STRADDLE, depotId: 3, state: 'idle', jobId: null, purchaseCostCents: STRADDLE_DEF.purchaseCents });
    }
    expect(viaJson(state)).toStrictEqual(state);
  });
});

describe('World.deserialize — vozidlá', () => {
  it('roundtrip: rovnaký stav, Vehicle inštancie, depo.vehicleIds v poradí nákupu, krok 12 prechádza', () => {
    const original = fleetWorld();
    const restored = World.deserialize(DEFS, MAP, viaJson(original.serialize()));
    expect(restored.serialize()).toEqual(original.serialize());
    for (const vehicle of restored.vehicles.values()) expect(vehicle).toBeInstanceOf(Vehicle);
    const depot = restored.modules.get(id(3)) as VehicleDepot;
    expect(depot.vehicleIds).toEqual([...original.vehicles.keys()]);
    expect(() => restored.assertInvariants()).not.toThrow();
  });

  it('obnovený svet pokračuje rovnako (ďalší nákup dostane rovnaké id, predaj rovnakú refundáciu, rovnaký hash)', () => {
    const original = fleetWorld();
    const restored = World.deserialize(DEFS, MAP, viaJson(original.serialize()));
    for (const world of [original, restored]) {
      execute(world, buy(3));
      runTicks(world, 100);
      execute(world, sell([...world.vehicles.keys()][0]));
      runTicks(world, 100);
    }
    expect(hashState(restored.serialize())).toBe(hashState(original.serialize()));
  });

  it('jednotka vo vozidle (in_vehicle) sa uloží aj obnoví — vozidlo s jobom (rozhodnutie orchestrátora F3 č. 5)', () => {
    const { world, depot } = depotWorld({ yard: true });
    const yard = world.modules.get(id(4)) as StorageModule;
    const { vehicle, unit, job } = carryingVehicle(world, depot.id, yard);
    const restored = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
    expect(restored.cargo.unitsAt('in_vehicle', vehicle.id)).toEqual([unit]);
    expect(restored.serialize()).toEqual(world.serialize());
    const copy = restored.jobs.get(job.id);
    expect([copy?.state, copy?.vehicleId, (restored.modules.get(yard.id) as StorageModule).reservedSlots()]).toEqual(['dropping', vehicle.id, yard.reservedSlots()]);
    expect(() => restored.assertInvariants()).not.toThrow();
  });
});

describe('World.deserialize — neplatné vozidlá (parsovanie)', () => {
  type Mutation = (state: Record<string, unknown>, vehicles: Record<string, unknown>[]) => void;
  const CASES: readonly [string, Mutation, string, RegExp?][] = [
    ['vehicles nie je pole', (s) => (s.vehicles = {}), '/vehicles'],
    ['neznámy kľúč', (_s, v) => (v[0].speed = 1), '/vehicles/0/speed'],
    ['chýba kľúč', (_s, v) => delete v[0].heading, '/vehicles/0/heading'],
    ['id ≥ ids.nextId', (s, v) => (v[1].id = (s.ids as { nextId: number }).nextId), '/vehicles/1/id'],
    ['id nie vzostupne', (_s, v) => ([v[0].id, v[1].id] = [v[1].id, v[0].id]), '/vehicles/1/id', /vzostupne/],
    ['id patrí modulu', (_s, v) => (v[0].id = 3), '/vehicles/0/id', /patrí modulu/],
    ['neznámy def', (_s, v) => (v[0].defId = 'hovercraft'), '/vehicles/0/defId'],
    ['depotId 0', (_s, v) => (v[0].depotId = 0), '/vehicles/0/depotId'],
    ['neznámy stav', (_s, v) => (v[0].state = 'flying'), '/vehicles/0/state'],
    ['x mimo mapy', (_s, v) => (v[0].x = 1000), '/vehicles/0/x'],
    ['y záporné', (_s, v) => (v[0].y = -1), '/vehicles/0/y'],
    ['kurz 45', (_s, v) => (v[0].heading = 45), '/vehicles/0/heading'],
    ['jobId 0', (_s, v) => (v[0].jobId = 0), '/vehicles/0/jobId'],
    ['idle s jobom', (_s, v) => (v[0].jobId = 12), '/vehicles/0/jobId', /nesmie mať job/],
    ['to_pickup bez jobu', (_s, v) => (v[0].state = 'to_pickup'), '/vehicles/0/jobId', /vyžaduje job/],
    ['záporná cena', (_s, v) => (v[0].purchaseCostCents = -1), '/vehicles/0/purchaseCostCents'],
    ['job bez kľúčov (tvar SerializedJob, T03-05)', (s) => (s.jobs = [{ id: 99 }]), '/jobs/0/unitIds', /chýba/],
    ['trasa nie je pole (T03-06)', (_s, v) => (v[0].route = 5), '/vehicles/0/route'],
    ['prázdna trasa', (_s, v) => (v[0].route = []), '/vehicles/0/route', /aspoň bunku/],
    ['bunka trasy mimo mapy', (_s, v) => (v[0].route = [96 * 64]), '/vehicles/0/route/0'],
    ['nesusedná bunka trasy', (_s, v) => (v[0].route = [ROUTE_CELL, ROUTE_CELL + 2]), '/vehicles/0/route/1', /nesusedí/],
    ['progres 1', (_s, v) => (v[0].progress = 1), '/vehicles/0/progress'],
    ['progres bez ďalšej bunky', (_s, v) => (v[0].progress = 0.5), '/vehicles/0/progress', /bez ďalšej bunky/],
    ['progres = šum pod PROGRESS_NOISE (ADR-021)', (_s, v) => ((v[0].route = [ROUTE_CELL, ROUTE_CELL + 96]), (v[0].progress = 2 ** -60)), '/vehicles/0/progress', /PROGRESS_NOISE/],
    [
      'kurz rozbehnutého vozidla ≠ smer úseku (ADR-021)',
      (_s, v) => ((v[0].route = [ROUTE_CELL, ROUTE_CELL + 96]), (v[0].progress = 0.5), (v[0].y = (v[0].y as number) + 0.5), (v[0].heading = 90)),
      '/vehicles/0/heading',
      /nezodpovedá rozbehnutému úseku/,
    ],
    ['záporný waitTicks', (_s, v) => (v[0].waitTicks = -1), '/vehicles/0/waitTicks'],
    ['replan nie je boolean', (_s, v) => (v[0].replan = 1), '/vehicles/0/replan'],
    ['poloha mimo trasy', (_s, v) => (v[0].x = (v[0].x as number) + 1), '/vehicles/0/x', /nie je na trase/],
    ['idle s odpočtom', (_s, v) => (v[0].waitTicks = 3), '/vehicles/0/waitTicks', /musí byť 0/],
    ['idle s príznakom preplánovania', (_s, v) => (v[0].replan = true), '/vehicles/0/replan'],
    ['idle s trasou pred sebou', (_s, v) => (v[0].route = [ROUTE_CELL, ROUTE_CELL + 96]), '/vehicles/0/route', /stojí, ale má pred sebou/],
    ['vozidlo na bunke bez cesty', (_s, v) => ((v[0].route = [ROUTE_CELL + 1]), (v[0].x = (v[0].x as number) + 1)), '/vehicles/0/route', /bez cesty/],
    // R1 (ADR-037): doprava bez prekrývania
    ['body nie je pole', (_s, v) => (v[0].body = 5), '/vehicles/0/body'],
    ['slot nie je pár', (_s, v) => (v[0].body = [ROUTE_CELL]), '/vehicles/0/body/0', /pár \[bunka, pruh\]/],
    ['slot mimo mriežky', (_s, v) => (v[0].body = [[96 * 64, 0]]), '/vehicles/0/body/0/0', /mimo mriežky/],
    ['pruh 2', (_s, v) => (v[0].ahead = [[ROUTE_CELL, 2]]), '/vehicles/0/ahead/0/1', /0 alebo 1/],
    ['záporný blockedTicks', (_s, v) => (v[0].blockedTicks = -1), '/vehicles/0/blockedTicks'],
    ['rerouteCooldown necelý', (_s, v) => (v[0].rerouteCooldown = 1.5), '/vehicles/0/rerouteCooldown'],
    ['idle drží sloty (nosič mimo cesty)', (_s, v) => (v[0].body = [[ROUTE_CELL, 0]]), '', /mimo cesty/],
    ['jobs nie je pole', (s) => (s.jobs = null), '/jobs'],
  ];

  it.each(CASES)('%s → WorldStateError na %s', (_name, mutate, path, message) => {
    const state = viaJson(fleetWorld().serialize()) as unknown as Record<string, unknown>;
    mutate(state, state.vehicles as Record<string, unknown>[]);
    const error = errorOf(() => World.deserialize(DEFS, MAP, state as unknown as WorldState));
    expect(error.path).toBe(path);
    if (message !== undefined) expect(error.message).toMatch(message);
  });

  it('jednotka nákladu s id vozidla → chyba jednotky (id entít sú jedinečné)', () => {
    const { world, depot } = depotWorld();
    const vehicle = addVehicleTo(world, depot.id);
    loadInto(world, vehicle.id);
    const state = viaJson(world.serialize()) as unknown as { cargo: { units: { id: number }[] } };
    state.cargo.units[0].id = vehicle.id;
    const error = errorOf(() => World.deserialize(DEFS, MAP, state as unknown as WorldState));
    expect(error.path).toBe('/cargo/units/0/id');
    expect(error.message).toMatch(/patrí vozidlu/);
  });
});

describe('World.deserialize — neplatné vozidlá (obnova vzťahov)', () => {
  it('depotId odkazuje na modul, ktorý nie je depo → /vehicles/0/depotId', () => {
    const state = viaJson(fleetWorld().serialize());
    const vehicles = state.vehicles as unknown as Record<string, unknown>[];
    vehicles[0].depotId = 4; // dvor
    const error = errorOf(() => World.deserialize(DEFS, MAP, state));
    expect(error.path).toBe('/vehicles/0/depotId');
    expect(error.message).toMatch(/nie je depo/);
  });

  it('viac vozidiel než státí depa → chyba prvého nadpočetného vozidla (depot_full)', () => {
    const { world, depot } = depotWorld();
    for (let i = 0; i < depot.capacity; i++) addVehicleTo(world, depot.id);
    const state = viaJson(world.serialize()) as unknown as Record<string, unknown>;
    const vehicles = state.vehicles as Record<string, unknown>[];
    const extraId = (state.ids as { nextId: number }).nextId;
    (state.ids as { nextId: number }).nextId = extraId + 1;
    vehicles.push({ ...vehicles[0], id: extraId });
    const error = errorOf(() => World.deserialize(DEFS, MAP, state as unknown as WorldState));
    expect(error.path).toBe(`/vehicles/${String(depot.capacity)}/depotId`);
    expect(error.message).toMatch(/plné/);
  });

  it('vozidlo s jobom (stav s jobom) — job v save nie je → /vehicles/0/jobId', () => {
    const state = viaJson(fleetWorld().serialize());
    const vehicles = state.vehicles as unknown as Record<string, unknown>[];
    vehicles[0].state = 'to_pickup';
    vehicles[0].jobId = 99;
    const error = errorOf(() => World.deserialize(DEFS, MAP, state));
    expect(error.path).toBe('/vehicles/0/jobId');
    expect(error.message).toMatch(/job #99 vo svete neexistuje/);
  });

  it('jednotka in_vehicle bez vozidla v save → chyba jednotky s „in_vehicle" (CARGO_HOLDER_SOURCES)', () => {
    const { world, depot } = depotWorld({ yard: true });
    carryingVehicle(world, depot.id, world.modules.get(id(4)) as StorageModule);
    const state = viaJson(world.serialize()) as unknown as Record<string, unknown>;
    state.vehicles = [];
    const error = errorOf(() => World.deserialize(DEFS, MAP, state as unknown as WorldState));
    expect(error.path).toBe('/cargo/units/0/location/vehicleId');
    expect(error.message).toMatch(/in_vehicle/);
  });

  it('jednotka kategórie, ktorú vozidlo nevozí (bulk v straddle carrieri) → chyba jednotky', () => {
    const { world, depot } = depotWorld({ world: World.create(GRAIN_DEFS, MAP, SEED) });
    loadInto(world, addVehicleTo(world, depot.id).id, GRAIN);
    const error = errorOf(() => World.deserialize(GRAIN_DEFS, MAP, viaJson(world.serialize())));
    expect(error.path).toBe('/cargo/units/0/location/vehicleId');
    expect(error.message).toMatch(/nevozí náklad kategórie 'bulk'/);
  });

  it('vozidlo s viac jednotkami, než unesie → chyba druhej jednotky', () => {
    const { world, depot } = depotWorld();
    const vehicle = addVehicleTo(world, depot.id);
    loadInto(world, vehicle.id);
    loadInto(world, vehicle.id);
    const error = errorOf(() => World.deserialize(DEFS, MAP, viaJson(world.serialize())));
    expect(error.path).toBe('/cargo/units/1/location/vehicleId');
    expect(error.message).toMatch(/unesie 1 jednotiek/);
  });
});
