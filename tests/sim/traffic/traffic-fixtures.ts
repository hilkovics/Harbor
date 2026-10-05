/**
 * Pomôcky testov dopravy bez prekrývania (R1, TR1-02, ADR-037): svet z `dispatchWorld` (depo, cesta pozdĺž nábrežia y = 17)
 * s vlastnými cestami v voľnej zemi (x 30…58, y ≥ 21) a syntetickými vozidlami v stave `to_pickup` bez jobu. Testy ticknú
 * len `world.traffic` (krok 6a) — FSM vozidiel a dispatcher nebežia, vozidlo na konci trasy teda stojí a drží svoje sloty.
 * Po každom ticku sa overí `carrierOverlapProblem`.
 */
import { expect } from 'vitest';
import type { Direction4Name, RoadKind } from '@sim/grid';
import type { VehicleDepot } from '@sim/modules';
import { carrierOverlapProblem, slotKey } from '@sim/traffic';
import { Vehicle } from '@sim/vehicles';
import type { World } from '@sim/world';
import { dispatchWorld } from '../logistics/dispatch-fixtures';

export type XY = readonly [number, number];

export interface TrafficBed {
  readonly world: World;
  readonly depot: VehicleDepot;
}

export function trafficBed(): TrafficBed {
  const { world, depot } = dispatchWorld();
  return { world, depot };
}

/** Položí cesty (typ, voliteľné smery jednosmeriek) a oznámi svetu zmenu siete. */
export function lay(world: World, cells: readonly XY[], kind: RoadKind = 'two_lane', dirs?: readonly Direction4Name[]): void {
  cells.forEach(([x, y], i) => {
    const cell = world.grid.at(x, y);
    cell.road = 'road';
    cell.roadKind = kind;
    cell.roadDir = dirs?.[i] ?? null;
  });
  world.markRoadsChanged();
}

/** Priamka buniek od `a` po `b` (jedna súradnica sa nemení), vrátane oboch koncov. */
export function line(a: XY, b: XY): XY[] {
  const cells: XY[] = [];
  const dx = Math.sign(b[0] - a[0]);
  const dy = Math.sign(b[1] - a[1]);
  for (let x = a[0], y = a[1]; ; x += dx, y += dy) {
    cells.push([x, y]);
    if (x === b[0] && y === b[1]) break;
  }
  return cells;
}

export interface SpawnOptions {
  /** Dĺžka vozidla v bunkách (`def.lengthCells`); predvolene 2. */
  readonly length?: number;
  /** Rýchlosť v bunkách za tick; predvolene 1 (jedna bunka za tick na dvojpruhovej ceste). */
  readonly speed?: number;
  /** Kľúče slotov, ktoré vozidlo drží od začiatku (hlava prvá). */
  readonly body?: readonly number[];
}

export const idx = (world: World, [x, y]: XY): number => world.grid.index(x, y);

/** Vozidlo v jazdnom stave `to_pickup` na začiatku trasy `route` (bunky po susedných); bez slotov, kým ich neobsadí. */
export function spawn(bed: TrafficBed, route: readonly XY[], options: SpawnOptions = {}): Vehicle {
  const { world, depot } = bed;
  const cells = route.map((xy) => idx(world, xy));
  const base = world.defs.vehicles.get('straddle_carrier');
  const def = { ...base, lengthCells: options.length ?? 2, speedCellsPerTick: options.speed ?? 1 };
  const [x, y] = route[0];
  const next = route[1];
  const heading = next === undefined ? 90 : next[0] > x ? 90 : next[0] < x ? 270 : next[1] > y ? 180 : 0;
  const vehicle = new Vehicle({
    id: world.ids.next(),
    def,
    depotId: depot.id,
    state: 'to_pickup',
    x: x + 0.5,
    y: y + 0.5,
    heading,
    purchaseCostCents: 0,
    route: cells,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  world.addVehicle(vehicle);
  return vehicle;
}

/** Kľúč slotu bunky `xy` v pruhu `lane`. */
export const keyAt = (world: World, xy: XY, lane: 0 | 1): number => slotKey(idx(world, xy), lane);

/** Bunky (x, y) tela vozidla od hlavy k chvostu. */
export function bodyCells(world: World, vehicle: Vehicle): XY[] {
  const { width } = world.grid;
  return vehicle.body.map((key): XY => [(key >> 1) % width, Math.floor((key >> 1) / width)]);
}

/** Bunka vozidla (x, y). */
export function cellOf(world: World, vehicle: Vehicle): XY {
  const { width } = world.grid;
  return [vehicle.cell % width, Math.floor(vehicle.cell / width)];
}

/** Jeden tick dopravy; invariant `carrierOverlapProblem` platí po každom ticku. */
export function tickTraffic(world: World, ticks = 1): void {
  for (let i = 0; i < ticks; i++) {
    world.traffic.tick(world);
    expect(carrierOverlapProblem(world)).toBeNull();
  }
}
