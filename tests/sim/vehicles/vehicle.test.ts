// Vehicle (T03-04; ARCHITECTURE §4.4, §5; docs/tasks/phase-03.md rozhodnutia 4, 7 a „Spoločné rozhrania"): stavy a ich
// vlastnosti, konštruktor (fail-fast vstup), privátny stav s getterom, save záznam; výjazd z depa (vonkajšia bunka
// konektora po rotácii, stred bunky, kurz von z depa).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { Rotation } from '@sim/grid';
import type { VehicleDepot } from '@sim/modules';
import {
  SERIALIZED_VEHICLE_KEYS,
  VEHICLE_STATES,
  VEHICLE_STATE_TRAITS,
  Vehicle,
  VehicleError,
  depotExit,
  isVehicleState,
  type VehicleInit,
} from '@sim/vehicles';
import { World } from '@sim/world';
import { DEFS, MAP, SEED } from '../world/world-fixtures';
import { STRADDLE_DEF } from './vehicle-fixtures';

const id = (value: number): EntityId => value as EntityId;

const BASE: VehicleInit = {
  id: id(7),
  def: STRADDLE_DEF,
  depotId: id(3),
  state: 'idle',
  x: 47.5,
  y: 30.5,
  heading: 180,
  purchaseCostCents: STRADDLE_DEF.purchaseCents,
  route: [30 * 96 + 47],
};

describe('stavy vozidla', () => {
  it('VEHICLE_STATES = stavy zo „Spoločných rozhraní" v poradí životného cyklu', () => {
    expect(VEHICLE_STATES).toEqual(['idle', 'to_pickup', 'loading', 'to_dropoff', 'unloading', 'no_path']);
  });

  it('VEHICLE_STATE_TRAITS: job má každý stav okrem idle; tabuľka pokrýva všetky stavy a je zmrazená', () => {
    expect(Object.keys(VEHICLE_STATE_TRAITS)).toEqual([...VEHICLE_STATES]);
    for (const state of VEHICLE_STATES) expect(VEHICLE_STATE_TRAITS[state].hasJob).toBe(state !== 'idle');
    expect(Object.isFrozen(VEHICLE_STATE_TRAITS)).toBe(true);
  });

  it('isVehicleState', () => {
    for (const state of VEHICLE_STATES) expect(isVehicleState(state)).toBe(true);
    for (const value of ['flying', '', null, 0, undefined]) expect(isVehicleState(value)).toBe(false);
  });
});

describe('Vehicle', () => {
  it('polia z defu a vstupu, stav cez getter, jobId predvolene null, label', () => {
    const vehicle = new Vehicle(BASE);
    expect(vehicle.id).toBe(7);
    expect(vehicle.def).toBe(STRADDLE_DEF);
    expect(vehicle.defId).toBe('straddle_carrier');
    expect(vehicle.depotId).toBe(3);
    expect(vehicle.state).toBe('idle');
    expect([vehicle.x, vehicle.y, vehicle.heading]).toEqual([47.5, 30.5, 180]);
    expect(vehicle.jobId).toBeNull();
    expect(vehicle.purchaseCostCents).toBe(STRADDLE_DEF.purchaseCents);
    expect(vehicle.label).toBe('straddle_carrier #7');
  });

  it('stav nejde prepísať zvonka (len getter — FSM prechody doplní T03-06)', () => {
    const vehicle = new Vehicle(BASE);
    expect(() => {
      (vehicle as unknown as { state: string }).state = 'loading';
    }).toThrow(TypeError);
    expect(vehicle.state).toBe('idle');
  });

  it('toState: čistý JSON s kľúčmi SERIALIZED_VEHICLE_KEYS v poradí, nová kópia pri každom volaní', () => {
    const vehicle = new Vehicle({ ...BASE, state: 'to_pickup', jobId: id(12), purchaseCostCents: 0 });
    const state = vehicle.toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_VEHICLE_KEYS]);
    expect(state).toEqual({
      id: 7,
      defId: 'straddle_carrier',
      depotId: 3,
      state: 'to_pickup',
      x: 47.5,
      y: 30.5,
      heading: 180,
      jobId: 12,
      purchaseCostCents: 0,
      route: [30 * 96 + 47],
      progress: 0,
      waitTicks: 0,
      replan: false,
    });
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    expect(vehicle.toState()).not.toBe(state);
  });

  const INVALID: readonly [string, Partial<VehicleInit>][] = [
    ['id 0', { id: id(0) }],
    ['id necelé', { id: id(1.5) }],
    ['depotId 0', { depotId: id(0) }],
    ['x NaN', { x: Number.NaN }],
    ['y Infinity', { y: Infinity }],
    ['kurz 45', { heading: 45 as Rotation }],
    ['neznámy stav', { state: 'flying' as VehicleInit['state'] }],
    ['jobId 0', { jobId: id(0) }],
    ['záporná cena', { purchaseCostCents: -1 }],
    ['necelá cena', { purchaseCostCents: 0.5 }],
  ];
  it.each(INVALID)('%s → VehicleError(invalid_input)', (_name, overrides) => {
    let error: unknown;
    try {
      new Vehicle({ ...BASE, ...overrides });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(VehicleError);
    expect((error as VehicleError).code).toBe('invalid_input');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Výjazd z depa
// ---------------------------------------------------------------------------------------------------------

/**
 * Depo 3×3 na (34, 20) s konektorom lokálne (1, 2) `s`. Po rotácii (x, y = ľavý horný roh po rotácii):
 * 0 → (35, 22) s → von (35, 23), kurz 180; 90 → (34, 21) w → (33, 21), 270; 180 → (35, 20) n → (35, 19), 0;
 * 270 → (36, 21) e → (37, 21), 90.
 */
const EXITS: readonly { rotation: Rotation; cell: { x: number; y: number }; heading: Rotation }[] = [
  { rotation: 0, cell: { x: 35, y: 23 }, heading: 180 },
  { rotation: 90, cell: { x: 33, y: 21 }, heading: 270 },
  { rotation: 180, cell: { x: 35, y: 19 }, heading: 0 },
  { rotation: 270, cell: { x: 37, y: 21 }, heading: 90 },
];

describe('depotExit', () => {
  it.each(EXITS)('rotácia $rotation: vonkajšia bunka $cell.x,$cell.y, stred bunky, kurz $heading; bez cesty undefined', ({ rotation, cell, heading }) => {
    const world = World.create(DEFS, MAP, SEED);
    const depot = world.placeModule({ defId: 'vehicle_depot', x: 34, y: 20, rotation }, 0) as VehicleDepot;
    expect(depotExit(world.grid, depot)).toBeUndefined();
    world.grid.at(cell.x, cell.y).road = 'road';
    expect(world.isConnected(depot)).toBe(true);
    expect(depotExit(world.grid, depot)).toEqual({ cell, x: cell.x + 0.5, y: cell.y + 0.5, heading });
  });

  it('koľaj na vonkajšej bunke nie je výjazd', () => {
    const world = World.create(DEFS, MAP, SEED);
    const depot = world.placeModule({ defId: 'vehicle_depot', x: 34, y: 20, rotation: 0 }, 0);
    world.grid.at(35, 23).road = 'rail';
    expect(depotExit(world.grid, depot)).toBeUndefined();
  });
});
