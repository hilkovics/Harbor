// Vozidlá vo svete (T03-04; ARCHITECTURE §5, §6 krok 12, §7.1): World.vehicles, addVehicle/removeVehicle s VehicleError
// (svet sa pri chybe nemení), VehicleDepot.vehicleIds v poradí nákupu, vozidlo ako držiteľ in_vehicle
// (CARGO_HOLDER_SOURCES) a invarianty vozidiel.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { ModuleError } from '@sim/modules';
import { Ship, ShipError } from '@sim/ships';
import { VehicleError, type Vehicle } from '@sim/vehicles';
import { CARGO_HOLDER_SOURCES, World, findWorldViolation } from '@sim/world';
import { DEFS, MAP, SEED, hashState, runTicks } from '../world/world-fixtures';
import type { StorageModule } from '@sim/modules';
import { DEPOT_OUTSIDE, GRAIN, GRAIN_DEFS, STRADDLE_DEF, addVehicleTo, buy, carryingVehicle, depotWorld, execute, loadInto } from './vehicle-fixtures';

const id = (value: number): EntityId => value as EntityId;
const TEU = 'container_teu';

/** Dvor z `depotWorld({ yard: true })`. */
function yardOf(world: World): StorageModule {
  const yard = [...world.modules.values()].find((module) => module.kind === 'storage');
  if (yard === undefined) throw new Error('svet nemá dvor');
  return yard as StorageModule;
}

function expectVehicleError(action: () => unknown, code: VehicleError['code']): void {
  let error: unknown;
  try {
    action();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(VehicleError);
  expect((error as VehicleError).code).toBe(code);
}

describe('World.addVehicle', () => {
  it('pridá vozidlo, depo ho eviduje; world.vehicles aj vehicleIds idú vzostupne podľa id (poradie nákupu)', () => {
    const { world, depot } = depotWorld();
    expect(world.vehicles.size).toBe(0);
    const a = addVehicleTo(world, depot.id);
    const b = addVehicleTo(world, depot.id);
    expect([...world.vehicles.keys()]).toEqual([a.id, b.id]);
    expect(world.vehicles.get(a.id)).toBe(a);
    expect(depot.vehicleIds).toEqual([a.id, b.id]);
    expect(depot.freeStalls).toBe(depot.capacity - 2);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('duplicitné id (vozidlo, modul, loď, jednotka nákladu) → duplicate_id', () => {
    const { world, depot } = depotWorld();
    const vehicle = addVehicleTo(world, depot.id);
    execute(world, { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: TEU, units: 1 });
    const [shipId] = world.ships.keys();
    const unitId = world.cargo.unitsOnShip(shipId)[0];
    for (const taken of [vehicle.id, depot.id, shipId, unitId]) {
      expectVehicleError(() => addVehicleTo(world, depot.id, { id: taken }), 'duplicate_id');
    }
    expect(depot.vehicleIds).toEqual([vehicle.id]);
  });

  it('id nepridelené alokátorom alebo menšie ako posledné vozidlo → invalid_input', () => {
    const { world, depot } = depotWorld();
    // addVehicleTo si pred prepisom id pridelí jedno id → „budúce" id musí byť ďalej ako nextId.
    const future = id(world.ids.getState().nextId + 5);
    expectVehicleError(() => addVehicleTo(world, depot.id, { id: future }), 'invalid_input');
    const older = world.ids.next();
    addVehicleTo(world, depot.id);
    expectVehicleError(() => addVehicleTo(world, depot.id, { id: older }), 'invalid_input');
    expect(world.vehicles.size).toBe(1);
  });

  it('poradie addVehicle porovnáva s najväčším prítomným id: po predaji posledného prejde staršie id nad ostatnými (T03-14)', () => {
    const { world, depot } = depotWorld();
    const first = addVehicleTo(world, depot.id);
    const middleId = world.ids.next();
    const newest = addVehicleTo(world, depot.id);
    world.removeVehicle(newest.id);
    addVehicleTo(world, depot.id, { id: middleId });
    expect([...world.vehicles.keys()]).toEqual([first.id, middleId]);
    expectVehicleError(() => addVehicleTo(world, depot.id, { id: first.id }), 'duplicate_id');
    world.removeVehicle(middleId);
    world.removeVehicle(first.id);
    addVehicleTo(world, depot.id, { id: first.id }); // prázdna mapa → bez porovnania
    expect(depot.vehicleIds).toEqual([first.id]);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('depotId nie je depo (neexistuje, kotvisko) → unknown_depot; plné depo → depot_full; svet sa nemení', () => {
    const { world, depot } = depotWorld();
    expectVehicleError(() => addVehicleTo(world, id(999)), 'unknown_depot');
    expectVehicleError(() => addVehicleTo(world, id(1)), 'unknown_depot'); // Root berth
    for (let i = 0; i < depot.capacity; i++) addVehicleTo(world, depot.id);
    const vehiclesBefore = world.serialize().vehicles;
    const idsBefore = [...depot.vehicleIds];
    expectVehicleError(() => addVehicleTo(world, depot.id), 'depot_full');
    expect(depot.vehicleIds).toEqual(idsBefore);
    expect(world.serialize().vehicles).toEqual(vehiclesBefore);
    expect(world.vehicles.size).toBe(depot.capacity);
  });
});

describe('World.addShip — id vozidla', () => {
  it('loď s id existujúceho vozidla → ShipError(duplicate_id), svet sa nezmení', () => {
    const { world, depot } = depotWorld();
    const vehicle = addVehicleTo(world, depot.id);
    const ship = new Ship({
      id: vehicle.id,
      def: DEFS.ships.get('feeder'),
      cargoType: DEFS.cargoTypes.get(TEU),
      state: 'inbound',
      x: 1.5,
      y: 1.5,
      heading: 90,
    });
    expect(() => world.addShip(ship)).toThrow(ShipError);
    expect(world.ships.size).toBe(0);
  });
});

describe('World.removeVehicle', () => {
  it('odstráni nečinné vozidlo a odpojí ho od depa (poradie ostatných ostane)', () => {
    const { world, depot } = depotWorld();
    const [a, b, c] = [addVehicleTo(world, depot.id), addVehicleTo(world, depot.id), addVehicleTo(world, depot.id)];
    expect(world.removeVehicle(b.id)).toBe(b);
    expect([...world.vehicles.keys()]).toEqual([a.id, c.id]);
    expect(depot.vehicleIds).toEqual([a.id, c.id]);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('neznáme id → unknown_vehicle; vozidlo s nákladom → has_cargo; s jobom / mimo idle → busy; svet sa nemení', () => {
    const { world, depot } = depotWorld({ yard: true });
    expectVehicleError(() => world.removeVehicle(id(999)), 'unknown_vehicle');
    const loaded = carryingVehicle(world, depot.id, yardOf(world)).vehicle;
    expectVehicleError(() => world.removeVehicle(loaded.id), 'has_cargo');
    const busy = addVehicleTo(world, depot.id, { state: 'to_pickup', jobId: id(77) });
    expectVehicleError(() => world.removeVehicle(busy.id), 'busy');
    const idleWithJob = addVehicleTo(world, depot.id);
    idleWithJob.jobId = id(78);
    expectVehicleError(() => world.removeVehicle(idleWithJob.id), 'busy');
    expect(world.vehicles.size).toBe(3);
    expect(depot.vehicleIds).toEqual([loaded.id, busy.id, idleWithJob.id]);
  });

  it('depo s vozidlami nejde odstrániť (World.removeModule → ModuleError has_vehicles), po predaji áno', () => {
    const { world, depot } = depotWorld();
    const vehicle = addVehicleTo(world, depot.id);
    expect(() => world.removeModule(depot.id)).toThrow(ModuleError);
    expect(world.modules.has(depot.id)).toBe(true);
    world.removeVehicle(vehicle.id);
    expect(world.removeModule(depot.id)).toBe(depot);
  });
});

describe('vozidlo ako držiteľ nákladu (in_vehicle)', () => {
  it('CARGO_HOLDER_SOURCES.in_vehicle = id vozidiel sveta', () => {
    const { world, depot } = depotWorld();
    const a = addVehicleTo(world, depot.id);
    const b = addVehicleTo(world, depot.id);
    expect([...CARGO_HOLDER_SOURCES.in_vehicle(world)]).toEqual([a.id, b.id]);
  });

  it('jednotka vo vozidle je u existujúceho držiteľa — krok 12 prejde; vo vozidle, ktoré neexistuje, nie', () => {
    const { world, depot } = depotWorld({ yard: true });
    carryingVehicle(world, depot.id, yardOf(world)); // náklad vezie len vozidlo s jobom (rozhodnutie orchestrátora F3 č. 5)
    expect(() => world.assertInvariants()).not.toThrow();
    loadInto(world, id(4040));
    expect(findWorldViolation(world)).toMatch(/1 jednotiek v 'in_vehicle' je u neexistujúceho držiteľa/);
  });
});

describe('invarianty vozidiel (krok 12)', () => {
  type Corrupt = (world: World, vehicle: Vehicle, depotId: EntityId) => void;
  const CASES: readonly [string, RegExp, Corrupt][] = [
    ['idle vozidlo s jobom', /v stave 'idle' má job #5/, (_w, vehicle) => (vehicle.jobId = id(5))],
    ['job, ktorý neexistuje (joby pribudnú v T03-05)', /job #6 neexistuje/, (world, _v, depotId) => void addVehicleTo(world, depotId, { state: 'to_pickup', jobId: id(6) })],
    ['stav s jobom bez jobu', /v stave 'loading' nemá job/, (world, _v, depotId) => void addVehicleTo(world, depotId, { state: 'loading' })],
    ['poloha mimo mapy', /stojí mimo mapy/, (_w, vehicle) => (vehicle.x = -0.5)],
    ['poloha NaN', /stojí mimo mapy/, (_w, vehicle) => (vehicle.y = Number.NaN)],
    ['depo eviduje cudzie vozidlo', /vehicleIds \[\d+, 999\] ≠ vozidlá depa podľa id/, (world, _v, depotId) => {
      const depot = world.modules.get(depotId) as unknown as { vehicleIds: EntityId[] };
      depot.vehicleIds.push(id(999));
    }],
    ['depo vozidlo neeviduje', /chýba vo vehicleIds depa|≠ vozidlá depa/, (world, vehicle, depotId) => {
      const depot = world.modules.get(depotId) as unknown as { vehicleIds: EntityId[] };
      depot.vehicleIds.splice(depot.vehicleIds.indexOf(vehicle.id), 1);
    }],
    ['náklad nad kapacitu', /vezie 2 jednotiek \(capacityUnits 1\)/, (world, vehicle) => {
      loadInto(world, vehicle.id);
      loadInto(world, vehicle.id);
    }],
    ['idle vozidlo s nákladom (rozhodnutie orchestrátora F3 č. 5)', /v stave 'idle' vezie jednotku #\d+ mimo svojho jobu/, (world, vehicle) => {
      loadInto(world, vehicle.id);
    }],
  ];

  it.each(CASES)('%s', (_name, message, corrupt) => {
    const { world, depot } = depotWorld();
    const vehicle = addVehicleTo(world, depot.id);
    expect(findWorldViolation(world)).toBeUndefined();
    corrupt(world, vehicle, depot.id);
    expect(findWorldViolation(world)).toMatch(message);
  });

  it('náklad kategórie, ktorú vozidlo nevozí (bulk v straddle carrieri)', () => {
    const { world, depot } = depotWorld({ world: World.create(GRAIN_DEFS, MAP, SEED) });
    const vehicle = addVehicleTo(world, depot.id);
    loadInto(world, vehicle.id, GRAIN);
    expect(findWorldViolation(world)).toMatch(/vezie jednotku #\d+ kategórie 'bulk', ktorú nevozí/);
  });
});

describe('vozidlá počas ticku bez práce (žiadny náklad → žiadny job)', () => {
  it('kúpené vozidlá stoja idle na vonkajšej bunke depa, krok 12 prechádza, stav sa nemení', () => {
    const { world, depot } = depotWorld();
    execute(world, buy(depot.id));
    execute(world, buy(depot.id));
    const before = [...world.vehicles.values()].map((vehicle) => vehicle.toState());
    runTicks(world, 300);
    expect([...world.vehicles.values()].map((vehicle) => vehicle.toState())).toEqual(before);
    for (const vehicle of world.vehicles.values()) {
      expect([vehicle.state, vehicle.x, vehicle.y]).toEqual(['idle', DEPOT_OUTSIDE.x + 0.5, DEPOT_OUTSIDE.y + 0.5]);
      expect(vehicle.def).toBe(STRADDLE_DEF);
    }
  });

  it('World.create(…) pre rovnaký seed a príkazy dá rovnaký stav s vozidlami (determinizmus)', () => {
    const run = (): string => {
      const { world, depot } = depotWorld({ world: World.create(DEFS, MAP, SEED) });
      execute(world, buy(depot.id));
      runTicks(world, 50);
      execute(world, buy(depot.id));
      runTicks(world, 50);
      return hashState(world.serialize());
    };
    expect(run()).toBe(run());
  });
});
