// Vozidlá na typoch ciest (T03-18, ADR-020): rýchlosť úseku podľa typu cieľovej bunky (advance so zvyškom kroku,
// poistka zaokrúhlenia), planRoute po smerových hranách a podľa ceny, obrat uprostred úseku nie proti jednosmerke
// (preplánovanie dopredu obchádzkou alebo no_path), prestavba pod trasou → preplánovanie, jednopruhová cesta = dlhšia
// jazda, vehicleMotionProblem pre krok proti smeru (krok 12 aj obnova).
import { describe, expect, it } from 'vitest';
import infrastructureJson from '@data/defs/infrastructure.json';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { CellCoord } from '@sim/grid';
import type { BerthModule } from '@sim/modules';
import { Vehicle, planRoute, vehicleMotionProblem, vehiclePosition, type VehicleInit } from '@sim/vehicles';
import { findWorldViolation, type World } from '@sim/world';
import { DEFS, RAW_DEFS } from '../world/world-fixtures';
import { ROOT_BERTH_ID, YARD_W, buyVehicle, dispatchWorld, execute, placeYard, unitsOnApron } from '../logistics/dispatch-fixtures';
import { STRADDLE_DEF } from './vehicle-fixtures';

const WIDTH = 96;
const idx = (x: number, y: number): number => y * WIDTH + x;
const SPEED = STRADDLE_DEF.speedCellsPerTick;
const cell = (x: number, y: number): CellCoord => ({ x, y });
const row = (x0: number, x1: number, y: number): CellCoord[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => cell(x0 + i, y));
const column = (x: number, y0: number, y1: number): CellCoord[] => Array.from({ length: y1 - y0 + 1 }, (_, i) => cell(x, y0 + i));

function vehicleOn(route: readonly number[], overrides: Partial<VehicleInit> = {}): Vehicle {
  const start = vehiclePosition(route[0], route[1], overrides.progress ?? 0, WIDTH);
  return new Vehicle({
    id: 7 as EntityId,
    def: STRADDLE_DEF,
    depotId: 3 as EntityId,
    state: 'to_pickup',
    jobId: 20 as EntityId,
    x: start.x,
    y: start.y,
    heading: 90,
    purchaseCostCents: 0,
    route,
    ...overrides,
  });
}

/** Vozidlo priamo do sveta na trase `route` (bunky) s polohou podľa progresu. */
function vehicleAt(world: World, depotId: EntityId, route: readonly CellCoord[], overrides: Partial<VehicleInit> = {}): Vehicle {
  const indices = route.map(({ x, y }) => world.grid.index(x, y));
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

describe('Vehicle.advance — rýchlosť podľa typu cieľovej bunky úseku', () => {
  const route = [idx(10, 5), idx(11, 5), idx(12, 5), idx(12, 6), idx(13, 6)];

  it('bez faktora = faktor 1 bitovo (spätná kompatibilita pohybu)', () => {
    const plain = vehicleOn(route);
    const unit = vehicleOn(route);
    for (let t = 0; t < 12; t++) {
      plain.advance(SPEED, WIDTH);
      unit.advance(SPEED, WIDTH, () => 1);
      expect([unit.x, unit.y, unit.progress, unit.cell, unit.heading]).toEqual([plain.x, plain.y, plain.progress, plain.cell, plain.heading]);
    }
  });

  it('úsek do pomalej bunky ide speed × faktor; faktor výchozej bunky úsek neovplyvní', () => {
    const slowTarget = vehicleOn(route);
    slowTarget.advance(SPEED, WIDTH, (i) => (i === idx(11, 5) ? 0.5 : 1));
    expect(slowTarget.progress).toBeCloseTo(SPEED * 0.5, 12);
    const slowSource = vehicleOn(route);
    slowSource.advance(SPEED, WIDTH, (i) => (i === idx(10, 5) ? 0.5 : 1));
    expect(slowSource.progress).toBe(SPEED);
  });

  it('zvyšok kroku prechádza do pomalšieho úseku v jednotkách pri faktore 1 (0,2 × 0,5 = 0,1)', () => {
    const vehicle = vehicleOn(route, { progress: 0.8 });
    vehicle.advance(SPEED, WIDTH, (i) => (i === idx(12, 5) ? 0.5 : 1));
    expect(vehicle.cell).toBe(idx(11, 5));
    expect(vehicle.progress).toBeCloseTo(0.1, 12);
    expect(vehicle.x).toBeCloseTo(11.6, 12);
  });

  it('jazda po jednopruhových bunkách trvá 1 / 0,7-krát dlhšie', () => {
    const straight = [idx(10, 5), idx(11, 5), idx(12, 5), idx(13, 5), idx(14, 5), idx(15, 5), idx(16, 5), idx(17, 5)];
    const ticksToEnd = (factor: number): number => {
      const vehicle = vehicleOn(straight);
      let ticks = 0;
      while (!vehicle.advance(SPEED, WIDTH, () => factor)) ticks += 1;
      return ticks + 1;
    };
    const fast = ticksToEnd(1);
    const slow = ticksToEnd(DEFS.infrastructure.roadKinds.one_lane.speedFactor);
    expect(fast).toBe(Math.ceil(7 / SPEED));
    expect(slow).toBe(Math.ceil(7 / (SPEED * 0.7)));
    expect(slow).toBeGreaterThan(fast);
  });

  it('poistka zaokrúhlenia: 0,7 + 0,3 = 1 v double → vozidlo dorazí do stredu ďalšej bunky, progres ostane v [0, 1)', () => {
    const [progress, step] = [0.7, 0.3];
    expect([step < 1 - progress, progress + step]).toEqual([true, 1]);
    const vehicle = vehicleOn(route, { progress });
    vehicle.advance(step, WIDTH);
    expect([vehicle.cell, vehicle.progress, vehicle.x, vehicle.y]).toEqual([idx(11, 5), 0, 11.5, 5.5]);
  });
});

describe('planRoute — smerové hrany, cena a obrat uprostred úseku', () => {
  const berthOf = (world: World): BerthModule => world.modules.get(ROOT_BERTH_ID) as BerthModule;

  it('jednosmerka proti smeru k bližšiemu konektoru → cieľ je vzdialenejší konektor', () => {
    const { world, depot } = dispatchWorld();
    const vehicle = vehicleAt(world, depot.id, [cell(42, 18)]);
    expect(planRoute(world, vehicle, berthOf(world))).toBe(true);
    expect(vehicle.remainingRoute().at(-1)).toBe(world.grid.index(41, 18));
    execute(world, { type: 'PlaceRoad', cells: [cell(41, 18)], kind: 'one_way', dirs: ['E'] });
    expect(planRoute(world, vehicle, berthOf(world))).toBe(true);
    expect(vehicle.remainingRoute()).toEqual(row(42, 46, 18).map(({ x, y }) => world.grid.index(x, y)));
  });

  it('konektor podľa ceny, nie dĺžky: 2 pomalé bunky (faktor 0,5 → cena 4) prehrajú s 3 dvojpruhovými', () => {
    const infrastructure = { ...infrastructureJson, roadKinds: { ...infrastructureJson.roadKinds, one_lane: { costPerCellCents: 1, speedFactor: 0.5 } } };
    const { world, depot } = dispatchWorld(DefRegistry.fromRaw({ ...RAW_DEFS, infrastructure }));
    execute(world, { type: 'PlaceRoad', cells: [cell(42, 18), cell(41, 18)], kind: 'one_lane' });
    const vehicle = vehicleAt(world, depot.id, [cell(43, 18)]);
    expect(planRoute(world, vehicle, berthOf(world))).toBe(true);
    expect(vehicle.remainingRoute()).toEqual(row(43, 46, 18).map(({ x, y }) => world.grid.index(x, y)));
  });

  it('obrat uprostred úseku proti jednosmerke nie je povolený → preplánuje dopredu obchádzkou (úsek dokončí)', () => {
    const { world, depot } = dispatchWorld();
    const west = placeYard(world, YARD_W);
    // Okruh južne od nábrežnej cesty: (43,18) ↓ (43,21) ← (39,21) ↑ (39,18).
    execute(world, { type: 'PlaceRoad', cells: [...column(43, 19, 21), ...row(39, 42, 21), ...column(39, 19, 20)] });
    execute(world, { type: 'PlaceRoad', cells: [cell(40, 18), cell(41, 18)], kind: 'one_way', dirs: ['E', 'E'] });
    const vehicle = vehicleAt(world, depot.id, [cell(40, 18), cell(41, 18)], { progress: 0.5 });
    const before = [vehicle.x, vehicle.y];
    expect(planRoute(world, vehicle, west)).toBe(true);
    const expected = [
      cell(40, 18), cell(41, 18), cell(42, 18), cell(43, 18), ...column(43, 19, 21), ...row(39, 42, 21).reverse(), cell(39, 20), cell(39, 19),
      cell(39, 18), cell(38, 18), cell(37, 18),
    ];
    expect(vehicle.remainingRoute()).toEqual(expected.map(({ x, y }) => world.grid.index(x, y)));
    expect([vehicle.progress, vehicle.x, vehicle.y, vehicle.heading]).toEqual([0.5, ...before, 90]);
  });

  it('bez obchádzky na jednosmerke → false (žiadny obrat), vozidlo sa nezmení', () => {
    const { world, depot } = dispatchWorld();
    const west = placeYard(world, YARD_W);
    execute(world, { type: 'PlaceRoad', cells: [cell(40, 18), cell(41, 18)], kind: 'one_way', dirs: ['E', 'E'] });
    const vehicle = vehicleAt(world, depot.id, [cell(40, 18), cell(41, 18)], { progress: 0.5 });
    const before = vehicle.remainingRoute();
    expect(planRoute(world, vehicle, west)).toBe(false);
    expect([vehicle.remainingRoute(), vehicle.progress]).toEqual([before, 0.5]);
  });

  it('na obojsmernej jednopruhovej ceste sa vozidlo otočí ako na dvojpruhovej', () => {
    const { world, depot } = dispatchWorld();
    const west = placeYard(world, YARD_W);
    execute(world, { type: 'PlaceRoad', cells: [cell(40, 18), cell(41, 18)], kind: 'one_lane' });
    const vehicle = vehicleAt(world, depot.id, [cell(40, 18), cell(41, 18)], { progress: 0.25 });
    expect(planRoute(world, vehicle, west)).toBe(true);
    expect(vehicle.remainingRoute().slice(0, 2)).toEqual([world.grid.index(41, 18), world.grid.index(40, 18)]);
    expect(vehicle.progress).toBe(0.75);
  });
});

describe('VehicleSystem — prestavba pod trasou a rýchlosť v ticku', () => {
  /** Svet s vozidlom na ceste k apronu (to_pickup), krok 12 zapnutý. */
  function drivingWorld(): { world: World; vehicleId: EntityId } {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const vehicleId = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    world.tick();
    return { world, vehicleId };
  }

  it('prestavba bunky pred vozidlom na jednopruhovú: replanPending, preplánuje v tom istom ticku a jazdí pomalšie', () => {
    const { world, vehicleId } = drivingWorld();
    const vehicle = world.vehicles.get(vehicleId) as Vehicle;
    expect(vehicle.state).toBe('to_pickup');
    const ahead = vehicle.remainingRoute().slice(3, 6).map((i) => world.grid.coordOf(i));
    const version = world.roadVersion;
    execute(world, { type: 'PlaceRoad', cells: ahead, kind: 'one_lane' });
    expect(world.roadVersion).toBe(version + 1);
    expect(vehicle.replanPending).toBe(true);
    world.tick();
    expect(vehicle.replanPending).toBe(false);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('jednopruhová nábrežná cesta: vozidlo príde k apronu neskôr ako po dvojpruhovej (krok 12 celý čas)', () => {
    const arrivalTick = (kind: 'two_lane' | 'one_lane'): number => {
      const { world, depot } = dispatchWorld();
      placeYard(world, YARD_W);
      if (kind === 'one_lane') execute(world, { type: 'PlaceRoad', cells: row(33, 41, 18), kind });
      const id = buyVehicle(world, depot);
      unitsOnApron(world, [0]);
      for (let t = 0; t < 200; t++) {
        world.tick();
        if (world.vehicles.get(id)?.state === 'loading') return world.clock.tick;
      }
      throw new Error('vozidlo neprišlo');
    };
    const fast = arrivalTick('two_lane');
    const slow = arrivalTick('one_lane');
    expect(slow).toBeGreaterThan(fast);
    expect(slow - fast).toBeGreaterThanOrEqual(Math.floor((9 / (SPEED * 0.7)) - 9 / SPEED) - 1);
  });

  it('jednosmerka proti smeru jazdy pred vozidlom: preplánuje obchádzkou alebo no_path, nikdy nejde proti smeru', () => {
    const { world, vehicleId } = drivingWorld();
    const vehicle = world.vehicles.get(vehicleId) as Vehicle;
    const route = vehicle.remainingRoute();
    const [a, b] = [world.grid.coordOf(route[2]), world.grid.coordOf(route[3])];
    const against = a.x < b.x ? 'W' : 'E';
    execute(world, { type: 'PlaceRoad', cells: [b], kind: 'one_way', dirs: [against] });
    for (let t = 0; t < 40; t++) {
      world.tick(); // krok 12 overí trasu aj rozbehnutý úsek voči smerom
      expect(['to_pickup', 'no_path']).toContain(vehicle.state);
    }
    expect(vehicle.state).toBe('no_path');
  });
});

describe('vehicleMotionProblem — krok proti smeru jednosmerky', () => {
  /** Vozidlo v jazde k apronu uprostred úseku (2 ticky × 0,4), bez porušenia. */
  function movingVehicle(): { world: World; vehicle: Vehicle } {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const id = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    world.tick();
    world.tick();
    const vehicle = world.vehicles.get(id) as Vehicle;
    expect(vehicle.progress).toBeGreaterThan(0);
    expect(vehicleMotionProblem(world, vehicle)).toBeUndefined();
    return { world, vehicle };
  }

  /** Priamy zápis jednosmerky proti kroku `route[i − 1] → route[i]` bez markRoadsChanged — poškodený stav. */
  function oneWayAgainst(world: World, vehicle: Vehicle, i: number): void {
    const route = vehicle.remainingRoute();
    const a = world.grid.coordOf(route[i - 1]);
    const b = world.grid.coordOf(route[i]);
    const target = world.grid.atIndex(route[i]);
    target.roadKind = 'one_way';
    target.roadDir = a.x < b.x ? 'W' : a.x > b.x ? 'E' : a.y < b.y ? 'N' : 'S';
  }

  it('trasa vedie proti smeru (bez preplánovania) → pole route, aj v kroku 12', () => {
    const { world, vehicle } = movingVehicle();
    oneWayAgainst(world, vehicle, 4);
    const problem = vehicleMotionProblem(world, vehicle);
    expect(problem?.field).toBe('route');
    expect(problem?.problem).toMatch(/krok trasy .* proti smeru jednosmerky/);
    expect(findWorldViolation(world)).toMatch(/proti smeru jednosmerky/);
  });

  it('rozbehnutý úsek proti smeru → pole route', () => {
    const { world, vehicle } = movingVehicle();
    oneWayAgainst(world, vehicle, 1);
    expect(vehicleMotionProblem(world, vehicle)?.problem).toMatch(/rozbehnutý úsek .* proti smeru jednosmerky/);
  });
});
