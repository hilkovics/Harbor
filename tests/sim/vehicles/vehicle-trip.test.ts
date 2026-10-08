// Jazda vozidla k modulu (T03-06; ADR-019): planRoute k najbližšej prístupovej bunke z kotvy (bunka / cieľ úseku), obrat
// uprostred úseku, bez cesty false; startTrip a enterNoPath; vehicleMotionProblem (krok 12 aj obnova) pre každé pravidlo;
// World.vehicleOnCell a markRoadsChanged.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { BerthModule } from '@sim/modules';
import { Vehicle, planRoute, vehicleMotionProblem, vehiclePosition, type VehicleInit } from '@sim/vehicles';
import { findWorldViolation, type World } from '@sim/world';
import { DEFS } from '../world/world-fixtures';
import { BERTH_ACCESS, ROOT_BERTH_ID, YARD_W, YARD_W_ACCESS, buyVehicle, dispatchWorld, execute, placeYard, unitsOnApron } from '../logistics/dispatch-fixtures';

/** Vozidlo priamo cez `World.addVehicle` na trase `route` (bunky), s polohou podľa trasy a progresu. */
function vehicleAt(world: World, depotId: EntityId, route: readonly { x: number; y: number }[], overrides: Partial<VehicleInit> = {}): Vehicle {
  const indices = route.map((cell) => world.grid.index(cell.x, cell.y));
  const position = vehiclePosition(indices[0], indices[1], overrides.progress ?? 0, world.grid.width);
  const vehicle = new Vehicle({
    id: world.ids.next(),
    def: DEFS.vehicles.get('straddle_carrier'),
    depotId,
    state: 'idle',
    x: position.x,
    y: position.y,
    heading: 90,
    purchaseCostCents: 0,
    route: indices,
    ...overrides,
  });
  world.addVehicle(vehicle);
  return vehicle;
}

const berthOf = (world: World): BerthModule => world.modules.get(ROOT_BERTH_ID) as BerthModule;
const cell = (x: number, y: number) => ({ x, y });

describe('planRoute', () => {
  it('z bunky vozidla k najbližšej prístupovej bunke modulu (zmrazená cesta z cache, vrátane oboch koncov)', () => {
    const { world, depot } = dispatchWorld();
    const vehicle = vehicleAt(world, depot.id, [cell(32, 18)]);
    expect(planRoute(world, vehicle, berthOf(world))).toBe(true);
    const route = vehicle.remainingRoute();
    expect(route[0]).toBe(world.grid.index(32, 18));
    expect(route.at(-1)).toBe(world.grid.index(BERTH_ACCESS[0].x, BERTH_ACCESS[0].y));
    expect(route).toHaveLength(10);
    expect(vehicle.replanPending).toBe(false);
  });

  it('medzi bunkami plánuje z cieľovej bunky úseku a úsek dokončí', () => {
    const { world, depot } = dispatchWorld();
    const vehicle = vehicleAt(world, depot.id, [cell(33, 18), cell(34, 18)], { progress: 0.5 });
    expect(planRoute(world, vehicle, berthOf(world))).toBe(true);
    expect(vehicle.remainingRoute().slice(0, 3)).toEqual([world.grid.index(33, 18), world.grid.index(34, 18), world.grid.index(35, 18)]);
    expect(vehicle.progress).toBe(0.5);
  });

  it('medzi bunkami s cestou späť cez začiatok úseku: obrat na mieste (turnAround), poloha sa nezmení', () => {
    const { world, depot } = dispatchWorld();
    const west = placeYard(world, YARD_W);
    const vehicle = vehicleAt(world, depot.id, [cell(40, 18), cell(41, 18)], { progress: 0.5 });
    const before = [vehicle.x, vehicle.y];
    expect(planRoute(world, vehicle, west)).toBe(true);
    expect(vehicle.remainingRoute()).toEqual([41, 40, 39, 38, 37].map((x) => world.grid.index(x, 18)));
    expect([vehicle.progress, vehicle.x, vehicle.y, vehicle.heading]).toEqual([0.5, ...before, 270]);
    expect(YARD_W_ACCESS).toEqual(cell(37, 18));
  });

  it('bez cesty k modulu (nepripojený alebo odrezaný) → false a vozidlo sa nezmení', () => {
    const { world, depot } = dispatchWorld();
    const unconnected = placeYard(world, cell(42, 24), 0);
    const vehicle = vehicleAt(world, depot.id, [cell(32, 18)]);
    expect(planRoute(world, vehicle, unconnected)).toBe(false);
    execute(world, { type: 'RemoveRoad', cells: [cell(36, 18)] });
    expect(planRoute(world, vehicle, berthOf(world))).toBe(false);
    expect(vehicle.remainingRoute()).toEqual([world.grid.index(32, 18)]);
  });
});

describe('World.vehicleOnCell a markRoadsChanged', () => {
  it('bunka pod vozidlom; pri pohybe medzi bunkami aj cieľ úseku; inak undefined', () => {
    const { world, depot } = dispatchWorld();
    const parked = vehicleAt(world, depot.id, [cell(32, 18)]);
    const moving = vehicleAt(world, depot.id, [cell(40, 18), cell(41, 18)], { state: 'idle', progress: 0.25 });
    expect(world.vehicleOnCell(world.grid.index(32, 18))).toBe(parked);
    expect(world.vehicleOnCell(world.grid.index(40, 18))).toBe(moving);
    expect(world.vehicleOnCell(world.grid.index(41, 18))).toBe(moving);
    expect(world.vehicleOnCell(world.grid.index(42, 18))).toBeUndefined();
  });

  it('markRoadsChanged zvýši roadVersion a označí na preplánovanie len vozidlá v jazde', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const driver = buyVehicle(world, depot);
    const parked = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    world.tick();
    const version = world.roadVersion;
    world.markRoadsChanged();
    expect(world.roadVersion).toBe(version + 1);
    expect([world.vehicles.get(driver)?.state, world.vehicles.get(driver)?.replanPending]).toEqual(['to_pickup', true]);
    expect([world.vehicles.get(parked)?.state, world.vehicles.get(parked)?.replanPending]).toEqual(['parked', false]);
  });
});

describe('vehicleMotionProblem (krok 12, obnova)', () => {
  /** Svet s vozidlom v jazde (to_pickup) a konzistentným jobom. */
  function drivingWorld(): { world: World; vehicle: Vehicle } {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const id = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    world.tick();
    world.tick();
    const vehicle = world.vehicles.get(id);
    if (vehicle === undefined) throw new Error('vozidlo');
    expect(findWorldViolation(world)).toBeUndefined();
    return { world, vehicle };
  }

  it('konzistentné vozidlá (idle aj v jazde) → undefined', () => {
    const { world, vehicle } = drivingWorld();
    expect(vehicleMotionProblem(world, vehicle)).toBeUndefined();
  });

  it.each<[string, (world: World, vehicle: Vehicle) => void, string, RegExp]>([
    ['poloha mimo trasy', (_w, v) => (v.x += 0.1), 'x', /≠ poloha na trase/],
    ['jazda so zahodenou trasou (len rozbehnutý úsek)', (_w, v) => v.halt(), 'route', /trasa nekončí na prístupovej bunke/],
    ['odpočet v jazde', (_w, v) => (v.waitTicks = 3), 'waitTicks', /musí byť 0/],
    ['cesta pod vozidlom zmizla', (w, v) => (w.grid.atIndex(v.cell).road = 'none'), 'route', /bez cesty/],
    ['trasa cez bunku bez cesty', (w) => (w.grid.at(38, 18).road = 'none'), 'route', /trasa vedie cez bunku/],
    ['kurz rozbehnutého vozidla ≠ smer úseku (ADR-021)', (_w, v) => (v.heading = v.heading === 0 ? 180 : 0), 'heading', /nezodpovedá rozbehnutému úseku/],
  ])('%s → pole %s', (_name, corrupt, field, message) => {
    const { world, vehicle } = drivingWorld();
    expect(vehicle.progress).toBeGreaterThan(0);
    corrupt(world, vehicle);
    const problem = vehicleMotionProblem(world, vehicle);
    expect(problem?.field).toBe(field);
    expect(problem?.problem).toMatch(message);
    expect(findWorldViolation(world)).toMatch(message);
  });

  it('príznak preplánovania mimo jazdy, stojace vozidlo s trasou, nesusedná trasa, pobyt mimo prístupovej bunky', () => {
    const { world, depot } = dispatchWorld();
    const idleFlag = vehicleAt(world, depot.id, [cell(32, 18)], { replanPending: true });
    expect(vehicleMotionProblem(world, idleFlag)?.field).toBe('replan');
    const idleRoute = vehicleAt(world, depot.id, [cell(32, 18), cell(33, 18)]);
    expect(vehicleMotionProblem(world, idleRoute)?.problem).toMatch(/stojí, ale má pred sebou 1 buniek/);
    const jump = vehicleAt(world, depot.id, [cell(32, 18), cell(34, 18)]);
    expect(vehicleMotionProblem(world, jump)?.problem).toMatch(/nie sú susedné/);
    const offRoad = vehicleAt(world, depot.id, [cell(32, 20)]);
    expect(vehicleMotionProblem(world, offRoad)?.problem).toMatch(/bez cesty/);
  });

  it('šum progresu ≤ PROGRESS_NOISE (konštruktor ho pripustí) → pole progress; stojace vozidlo kurz nekontroluje (ADR-021)', () => {
    const { world, depot } = dispatchWorld();
    const noisy = vehicleAt(world, depot.id, [cell(32, 18), cell(33, 18)], { progress: 2 ** -60 });
    const problem = vehicleMotionProblem(world, noisy);
    expect(problem?.field).toBe('progress');
    expect(problem?.problem).toMatch(/musí byť 0 alebo v \(PROGRESS_NOISE, 1\)/);
    expect(findWorldViolation(world)).toMatch(/PROGRESS_NOISE/);
    const parkedAnyHeading = vehicleAt(world, depot.id, [cell(40, 18)], { heading: 0 });
    expect(vehicleMotionProblem(world, parkedAnyHeading)).toBeUndefined();
  });
});
