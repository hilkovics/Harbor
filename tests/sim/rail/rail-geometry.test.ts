// Poloha vozňov vlaka na trase (TR6-01, ADR-043): `Train.cars()` a `railPoseAt` — vagóny za lokomotívou, stred vozňa na trase, uhol podľa smeru koľaje, extrapolácia pred portálom.
import { describe, expect, it } from 'vitest';
import { Train, railPoseAt } from '@sim/rail';
import { World } from '@sim/world';
import { RAIL_MAP, railDefs, railWorld } from '../helpers/r6-rail';

describe('vozne vlaka', () => {
  const defs = railDefs();
  const world = World.create(defs, RAIL_MAP, 1);
  const grid = world.grid;
  // Rovná trasa na východ po y = 52: bunky (60 … 79, 52).
  const route = Array.from({ length: 20 }, (_, i) => grid.index(60 + i, 52));
  const train = new Train({ id: 5 as never, state: 'arriving', route, posMilli: 12_000, terminalId: 2 as never, track: 0, wagons: 4, scheduledTick: 0, spawnedTick: 0, stoppedTick: null, departAtTick: null, def: defs.rail.train });

  it('lokomotíva na čele, vagóny 0 … 3 za ňou; stred každého vozňa o polovicu jeho dĺžky za predkom', () => {
    const cars = train.cars();
    expect(cars.map((car) => [car.kind, car.wagon])).toEqual([['loco', -1], ['wagon', 0], ['wagon', 1], ['wagon', 2], ['wagon', 3]]);
    expect(cars.map((car) => car.centerMilli)).toEqual([10_500, 7_500, 4_500, 1_500, -1_500]);
    expect(train.lengthMilli).toBe(15_000);
  });

  it('pozícia na trase: stred bunky, uhol 0° na východ, extrapolácia pred portálom', () => {
    expect(railPoseAt(grid, route, 500)).toEqual({ x: 60.5, y: 52.5, angle: 0 });
    expect(railPoseAt(grid, route, 10_500)).toEqual({ x: 70.5, y: 52.5, angle: 0 });
    expect(railPoseAt(grid, route, -1_500)).toEqual({ x: 58.5, y: 52.5, angle: 0 });
  });

  it('obsadené bunky: od chvosta po predok, na začiatku nič', () => {
    expect(train.occupiedRangeAt(12_000)).toEqual({ lo: 0, hi: 11 });
    expect(train.occupiedRangeAt(20_000)).toEqual({ lo: 5, hi: 19 });
    expect(train.occupiedRangeAt(0).hi).toBeLessThan(train.occupiedRangeAt(0).lo);
  });

  it('terminál vo svete vydá bunky koľají od vjazdu a vonkajšiu bunku vjazdu', () => {
    const { terminal } = railWorld();
    expect(terminal.trackCells(0)).toHaveLength(16);
    expect(terminal.trackCells(0)[0]).toEqual({ x: 85, y: 50 });
    expect(terminal.trackCells(1)[15]).toEqual({ x: 70, y: 51 });
    expect(terminal.trackEntry(0)).toEqual({ x: 86, y: 50 });
    expect(terminal.trackEntry(1)).toEqual({ x: 86, y: 51 });
  });
});
