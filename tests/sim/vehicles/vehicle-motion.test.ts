// Pohyb vozidla po trase (T03-06; docs/tasks/phase-03.md rozhodnutie 1; ADR-019): trasa = indexy buniek, progres úseku,
// advance so zvyškom kroku do ďalšieho úseku a zastavením na konci trasy, kardinálny kurz bez trigonometrie,
// followRoute (nový plán z bunky / dokončenie rozbehnutého úseku), turnAround (obrat uprostred úseku), halt, poloha
// vehiclePosition bitovo zhodná s Vehicle.place.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { PROGRESS_NOISE, Vehicle, VehicleError, isValidProgress, vehiclePosition, type VehicleInit } from '@sim/vehicles';
import { STRADDLE_DEF } from './vehicle-fixtures';

const WIDTH = 96;
const idx = (x: number, y: number): number => y * WIDTH + x;
const SPEED = STRADDLE_DEF.speedCellsPerTick;

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

function vehicleError(action: () => unknown): VehicleError {
  try {
    action();
  } catch (error) {
    if (error instanceof VehicleError) return error;
    throw error;
  }
  throw new Error('očakávaná VehicleError');
}

describe('vehiclePosition', () => {
  it('stred bunky (+ 0,5) posunutý o progres smerom k ďalšej bunke; bez ďalšej bunky alebo pri progrese 0 stred', () => {
    expect(vehiclePosition(idx(10, 5), undefined, 0, WIDTH)).toEqual({ x: 10.5, y: 5.5 });
    expect(vehiclePosition(idx(10, 5), idx(11, 5), 0, WIDTH)).toEqual({ x: 10.5, y: 5.5 });
    expect(vehiclePosition(idx(10, 5), idx(11, 5), 0.25, WIDTH)).toEqual({ x: 10.75, y: 5.5 });
    expect(vehiclePosition(idx(10, 5), idx(9, 5), 0.25, WIDTH)).toEqual({ x: 10.25, y: 5.5 });
    expect(vehiclePosition(idx(10, 5), idx(10, 4), 0.5, WIDTH)).toEqual({ x: 10.5, y: 5 });
    expect(vehiclePosition(idx(10, 5), idx(10, 6), 0.75, WIDTH)).toEqual({ x: 10.5, y: 6.25 });
  });
});

describe('Vehicle — trasa a advance', () => {
  it('stojace vozidlo: cell = route[0], bez ďalšej bunky, progres 0, 0 buniek pred sebou; advance ho nepohne', () => {
    const vehicle = vehicleOn([idx(10, 5)], { state: 'idle', jobId: null });
    expect([vehicle.cell, vehicle.nextCell, vehicle.progress, vehicle.cellsAhead]).toEqual([idx(10, 5), undefined, 0, 0]);
    expect(vehicle.advance(SPEED, WIDTH)).toBe(true);
    expect([vehicle.x, vehicle.y]).toEqual([10.5, 5.5]);
  });

  it('po úsekoch rýchlosťou speedCellsPerTick; zvyšok kroku prechádza cez stred bunky do ďalšieho úseku (aj v zákrute)', () => {
    const route = [idx(10, 5), idx(11, 5), idx(11, 6), idx(11, 7)];
    const vehicle = vehicleOn(route);
    const positions: [number, number, number][] = [];
    let arrived = false;
    let ticks = 0;
    let previous = { x: vehicle.x, y: vehicle.y };
    while (!arrived) {
      arrived = vehicle.advance(SPEED, WIDTH);
      ticks += 1;
      const step = Math.abs(vehicle.x - previous.x) + Math.abs(vehicle.y - previous.y);
      expect(step).toBeLessThanOrEqual(SPEED + 1e-9); // nič sa neteleportuje (Manhattan ≤ rýchlosť)
      if (!arrived) expect(step).toBeGreaterThan(SPEED - 1e-9); // mimo konca trasy ide plnou rýchlosťou aj v zákrute
      previous = { x: vehicle.x, y: vehicle.y };
      positions.push([vehicle.x, vehicle.y, vehicle.heading]);
    }
    expect(ticks).toBe(Math.ceil(3 / SPEED)); // 3 úseky po 1 bunke
    expect(positions[0]).toEqual([10.9, 5.5, 90]);
    expect(positions[2][2]).toBe(180); // za zákrutou (11, 5) → (11, 6) kurz na juh
    expect(positions.at(-1)).toEqual([11.5, 7.5, 180]); // na konci trasy presne v strede, zvyšok kroku prepadne
    expect([vehicle.cell, vehicle.cellsAhead, vehicle.progress]).toEqual([idx(11, 7), 0, 0]);
    expect(vehicle.remainingRoute()).toEqual([idx(11, 7)]);
  });

  it('kurz je kardinálny podľa smeru úseku (sever 0, východ 90, juh 180, západ 270)', () => {
    const cases: [number, number, number][] = [
      [0, -1, 0],
      [1, 0, 90],
      [0, 1, 180],
      [-1, 0, 270],
    ];
    for (const [dx, dy, heading] of cases) {
      const vehicle = vehicleOn([idx(10, 5), idx(10 + dx, 5 + dy)], { heading: heading === 90 ? 0 : 90 });
      vehicle.advance(0.1, WIDTH);
      expect(vehicle.heading, `${String(dx)},${String(dy)}`).toBe(heading);
    }
  });

  it('toState nesie zvyšok trasy od aktuálnej bunky, progres, odpočet a príznak preplánovania', () => {
    const vehicle = vehicleOn([idx(10, 5), idx(11, 5), idx(12, 5), idx(13, 5)]);
    vehicle.advance(1.25, WIDTH);
    expect(vehicle.toState()).toMatchObject({ route: [idx(11, 5), idx(12, 5), idx(13, 5)], progress: 0.25, waitTicks: 0, replan: false, x: 11.75, y: 5.5 });
    const copy = new Vehicle({ ...vehicle.toState(), id: vehicle.id, def: STRADDLE_DEF, depotId: vehicle.depotId, jobId: vehicle.jobId, replanPending: false });
    for (let i = 0; i < 3; i++) {
      copy.advance(SPEED, WIDTH);
      vehicle.advance(SPEED, WIDTH);
      expect([copy.x, copy.y, copy.heading, copy.cell]).toEqual([vehicle.x, vehicle.y, vehicle.heading, vehicle.cell]);
    }
  });
});

describe('Vehicle — followRoute, turnAround, halt', () => {
  it('followRoute z bunky: trasa musí začínať bunkou vozidla; zruší príznak preplánovania', () => {
    const vehicle = vehicleOn([idx(10, 5)], { replanPending: true });
    const route = Object.freeze([idx(10, 5), idx(10, 6)]);
    vehicle.followRoute(route);
    expect([vehicle.nextCell, vehicle.cellsAhead, vehicle.replanPending]).toEqual([idx(10, 6), 1, false]);
    expect(vehicleError(() => vehicle.followRoute([idx(10, 6), idx(10, 7)])).code).toBe('invalid_input');
  });

  it('followRoute medzi bunkami: rozbehnutý úsek sa dokončí (route[1] = nextCell), inak chyba a vozidlo sa nezmení', () => {
    const vehicle = vehicleOn([idx(10, 5), idx(11, 5), idx(12, 5)], { progress: 0.5 });
    expect(vehicleError(() => vehicle.followRoute([idx(10, 5), idx(10, 6)])).code).toBe('invalid_input');
    expect(vehicle.remainingRoute()).toEqual([idx(10, 5), idx(11, 5), idx(12, 5)]);
    vehicle.followRoute([idx(10, 5), idx(11, 5), idx(11, 4)]);
    expect([vehicle.progress, vehicle.x]).toEqual([0.5, 11]);
    vehicle.advance(SPEED, WIDTH); // 0,5 + 0,4 — stále na rozbehnutom úseku
    vehicle.advance(SPEED, WIDTH); // dokončí úsek a zatočí na sever
    expect([vehicle.cell, vehicle.nextCell, vehicle.heading]).toEqual([idx(11, 5), idx(11, 4), 0]);
  });

  it('turnAround: obrat uprostred úseku na mieste (progres 1 − p), potom jazda späť; bez pohybu medzi bunkami chyba', () => {
    const vehicle = vehicleOn([idx(10, 5), idx(11, 5)], { progress: 0.75 });
    const before = [vehicle.x, vehicle.y];
    vehicle.turnAround([idx(11, 5), idx(10, 5), idx(9, 5)], WIDTH);
    expect([vehicle.cell, vehicle.nextCell, vehicle.progress, vehicle.heading]).toEqual([idx(11, 5), idx(10, 5), 0.25, 270]);
    expect([vehicle.x, vehicle.y]).toEqual(before);
    vehicle.advance(SPEED, WIDTH);
    expect(vehicle.x).toBeCloseTo(10.85, 12);
    expect(vehicleError(() => vehicleOn([idx(10, 5), idx(11, 5)]).turnAround([idx(11, 5), idx(10, 5)], WIDTH)).code).toBe('invalid_input');
    expect(vehicleError(() => vehicleOn([idx(10, 5), idx(11, 5)], { progress: 0.5 }).turnAround([idx(11, 5), idx(12, 5)], WIDTH)).code).toBe('invalid_input');
  });

  it('halt: v strede bunky ostane [cell], medzi bunkami [cell, nextCell] s progresom; príznak preplánovania zaniká', () => {
    const atCell = vehicleOn([idx(10, 5), idx(11, 5), idx(12, 5)], { replanPending: true });
    atCell.halt();
    expect([atCell.remainingRoute(), atCell.replanPending]).toEqual([[idx(10, 5)], false]);
    const between = vehicleOn([idx(10, 5), idx(11, 5), idx(12, 5)], { progress: 0.5 });
    between.halt();
    expect([between.remainingRoute(), between.progress]).toEqual([[idx(10, 5), idx(11, 5)], 0.5]);
  });

  it('turnAround pri progrese 2^-54 (šum): poistka VehicleError(invalid_input), vozidlo sa nezmení (ADR-021)', () => {
    const noise = 2 ** -54;
    expect(1 - noise).toBe(1); // bez poistky by obrat dal neplatný progres 1
    const vehicle = vehicleOn([idx(10, 5), idx(11, 5)], { progress: noise });
    const before = [vehicle.remainingRoute(), vehicle.progress, vehicle.x, vehicle.y, vehicle.heading];
    const error = vehicleError(() => vehicle.turnAround([idx(11, 5), idx(10, 5), idx(9, 5)], WIDTH));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/šum pod PROGRESS_NOISE/);
    expect([vehicle.remainingRoute(), vehicle.progress, vehicle.x, vehicle.y, vehicle.heading]).toEqual(before);
  });

  it('turnAround tesne pred cieľom úseku (1 − p ≤ PROGRESS_NOISE): vozidlo stojí v strede nextCell s progresom 0', () => {
    const almost = 1 - 2 ** -53; // najväčší double pod 1
    const vehicle = vehicleOn([idx(10, 5), idx(11, 5)], { progress: almost });
    vehicle.turnAround([idx(11, 5), idx(10, 5), idx(9, 5)], WIDTH);
    expect([vehicle.cell, vehicle.nextCell, vehicle.progress, vehicle.x, vehicle.y]).toEqual([idx(11, 5), idx(10, 5), 0, 11.5, 5.5]);
    expect(isValidProgress(vehicle.progress)).toBe(true);
  });

  it.each<[string, Partial<VehicleInit>]>([
    ['prázdna trasa', { route: [] }],
    ['záporný index bunky', { route: [-1] }],
    ['necelý index bunky', { route: [1.5] }],
    ['progres 1', { route: [1, 2], progress: 1 }],
    ['záporný progres', { route: [1, 2], progress: -0.1 }],
    ['progres bez ďalšej bunky', { route: [1], progress: 0.5 }],
    ['záporný waitTicks', { waitTicks: -1 }],
    ['necelý waitTicks', { waitTicks: 1.5 }],
  ])('konštruktor: %s → VehicleError(invalid_input)', (_name, overrides) => {
    expect(vehicleError(() => vehicleOn([idx(10, 5)], { ...overrides, x: 0.5, y: 0.5 })).code).toBe('invalid_input');
  });
});

describe('Vehicle — šum progresu (review T03-13, ADR-021)', () => {
  const CELLS = 12;
  const route = Array.from({ length: CELLS + 1 }, (_, i) => idx(10 + i, 5));
  const FACTORS = [1, 0.7, 0.8] as const;
  /** Faktor cieľovej bunky: jednotný alebo cyklicky [1, 0,7, 0,8] posunutý o `shift` (rôzne typy ciest za sebou). */
  const FACTOR_CASES: readonly [string, (cell: number) => number][] = [
    ...FACTORS.map((factor): [string, (cell: number) => number] => [`faktor ${String(factor)}`, () => factor]),
    ...[0, 1, 2].map((shift): [string, (cell: number) => number] => [`cyklus [1, 0,7, 0,8] + ${String(shift)}`, (cell) => FACTORS[(cell - route[0] + shift) % FACTORS.length]]),
  ];

  it('PROGRESS_NOISE = Number.EPSILON; isValidProgress: 0 alebo (PROGRESS_NOISE, 1)', () => {
    expect(PROGRESS_NOISE).toBe(Number.EPSILON);
    expect([0, 0.5, 1 - 2 ** -53, PROGRESS_NOISE * 2].map(isValidProgress)).toEqual([true, true, true, true]);
    expect([2 ** -54, PROGRESS_NOISE, 1, -0.1, Number.NaN, Number.POSITIVE_INFINITY].map(isValidProgress)).toEqual([false, false, false, false, false, false]);
  });

  it.each([0.2, 0.25])('advance(%s) po 12 bunkách: po každom ticku progres 0 alebo > EPSILON (obrat 1 − p < 1) a roundtrip toState', (speed) => {
    for (const [name, factorOf] of FACTOR_CASES) {
      const vehicle = vehicleOn(route);
      let arrived = false;
      let ticks = 0;
      while (!arrived) {
        arrived = vehicle.advance(speed, WIDTH, factorOf);
        ticks += 1;
        const p = vehicle.progress;
        expect(p === 0 || p > Number.EPSILON, `${name}, tick ${String(ticks)}: progres ${String(p)}`).toBe(true);
        if (p > 0) expect(1 - p, `${name}, tick ${String(ticks)}: obrat`).toBeLessThan(1);
        const copy = new Vehicle({ ...vehicle.toState(), id: vehicle.id, def: STRADDLE_DEF, depotId: vehicle.depotId, jobId: vehicle.jobId, replanPending: false });
        expect(copy.toState()).toEqual(vehicle.toState());
        expect(ticks, name).toBeLessThan(200);
      }
      expect([vehicle.cell, vehicle.progress, vehicle.x], name).toEqual([route[CELLS], 0, 10 + CELLS + 0.5]);
    }
  });

  it('zvyšok kroku po strede bunky sa zahodí: rýchlosť 0,2 pri faktore 1 stojí po 5 tickoch presne v strede ďalšej bunky', () => {
    const vehicle = vehicleOn(route);
    for (let t = 0; t < 5; t++) vehicle.advance(0.2, WIDTH);
    // 0,2 + 0,2 + 0,2 + 0,2 = 0,8000000000000002 v double; zvyšok 0,2 − 0,19999999999999984 by bol progres ~5,6e-17.
    expect([vehicle.cell, vehicle.nextCell, vehicle.progress, vehicle.x]).toEqual([route[1], route[2], 0, 11.5]);
  });

  it('séria advance + obrat + advance: roundtrip new Vehicle(toState()) pokračuje bitovo rovnako', () => {
    for (const speed of [0.2, 0.25]) {
      const vehicle = vehicleOn(route);
      for (let t = 0; t < 23; t++) vehicle.advance(speed, WIDTH, FACTOR_CASES[4][1]);
      if (vehicle.progress === 0) vehicle.advance(speed, WIDTH, FACTOR_CASES[4][1]);
      const back = [vehicle.nextCell ?? -1, vehicle.cell, vehicle.cell - 1];
      vehicle.turnAround(back, WIDTH);
      const copy = new Vehicle({ ...vehicle.toState(), id: vehicle.id, def: STRADDLE_DEF, depotId: vehicle.depotId, jobId: vehicle.jobId, replanPending: false });
      for (let t = 0; t < 15; t++) {
        vehicle.advance(speed, WIDTH, FACTOR_CASES[4][1]);
        copy.advance(speed, WIDTH, FACTOR_CASES[4][1]);
        expect(copy.toState()).toEqual(vehicle.toState());
        expect(isValidProgress(vehicle.progress)).toBe(true);
      }
    }
  });
});
