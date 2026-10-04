// Misia kamióna a vykládka exportu (T6A-01, ADR-032 body 4 a 12): stav `unloading` v tabuľke prechodov, vlastnosti
// stavov podľa misie (delivery bez nároku na náklad docku, náklad `loaded` → `unloading` → prázdny), dual transaction
// (`becomePickup` len vo vykládke) a misia v save zázname.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import {
  TRUCK_COLLECT_STATE_TRAITS,
  TRUCK_DELIVERY_STATE_TRAITS,
  TRUCK_MISSIONS,
  TRUCK_MISSION_STATE_TRAITS,
  TRUCK_STATES,
  TRUCK_STATE_TRAITS,
  TRUCK_TRANSITIONS,
  Truck,
  TruckError,
  isTruckTransitionAllowed,
  truckStateTraits,
  type TruckInit,
  type TruckStateTraits,
} from '@sim/trucks';
import { DEFS } from '../world/world-fixtures';

const id = (value: number): EntityId => value as EntityId;

function delivery(overrides: Partial<TruckInit> = {}): Truck {
  return new Truck({
    id: id(41),
    def: DEFS.trucks.get('truck_container'),
    mission: 'delivery',
    state: 'to_gate',
    x: 0.5,
    y: 0.5,
    heading: 0,
    route: [0],
    rampId: id(8),
    dock: 1,
    gateId: id(6),
    waitingAreaId: id(7),
    bay: 2,
    ...overrides,
  });
}

/** Štrukturálne vlastnosti (pohyb, bay, dock, fronta) — rovnaké pre obe misie. */
const STRUCTURAL: readonly (keyof TruckStateTraits)[] = ['motion', 'waits', 'stop', 'holdsBay', 'bayOccupied', 'holdsDock', 'gateSide', 'queued', 'afterGate', 'passageBack'];

describe('stav unloading a misie (ADR-032)', () => {
  it('to_dock → loading | unloading | no_path; unloading → loading (dual transaction) | to_gate_out', () => {
    expect(TRUCK_STATES).toContain('unloading');
    expect(TRUCK_TRANSITIONS.get('to_dock')).toEqual(['loading', 'unloading', 'no_path']);
    expect(TRUCK_TRANSITIONS.get('unloading')).toEqual(['loading', 'to_gate_out']);
    expect(isTruckTransitionAllowed('loading', 'unloading')).toBe(false);
    expect(TRUCK_MISSIONS).toEqual(['pickup', 'delivery', 'collect']);
    expect(TRUCK_MISSION_STATE_TRAITS).toEqual({ pickup: TRUCK_STATE_TRAITS, delivery: TRUCK_DELIVERY_STATE_TRAITS, collect: TRUCK_COLLECT_STATE_TRAITS });
  });

  it('delivery: rovnaké väzby a pohyb ako pickup, bez nároku na náklad, náklad loaded → unloading → empty', () => {
    for (const state of TRUCK_STATES) {
      for (const key of STRUCTURAL) expect(TRUCK_DELIVERY_STATE_TRAITS[state][key], `${state}.${key}`).toBe(TRUCK_STATE_TRAITS[state][key]);
    }
    expect(TRUCK_STATES.filter((state) => TRUCK_DELIVERY_STATE_TRAITS[state].claimsCargo)).toEqual(['loading']);
    const cargo = Object.fromEntries(TRUCK_STATES.map((state) => [state, truckStateTraits('delivery', state).cargo]));
    expect(cargo).toEqual({
      to_gate: 'loaded',
      gate_queue: 'loaded',
      to_bay: 'loaded',
      waiting: 'loaded',
      to_dock: 'loaded',
      loading: 'loading',
      unloading: 'unloading',
      to_gate_out: 'empty',
      gate_queue_out: 'empty',
      to_portal: 'empty',
      exited: 'empty',
      no_path: 'empty',
    });
    expect(TRUCK_STATE_TRAITS.unloading).toMatchObject({ motion: 'park', waits: true, stop: 'ramp', holdsDock: true, claimsCargo: false, cargo: 'unloading' });
  });

  it('Truck: predvolená misia pickup; bonds a traits podľa misie; misia v save zázname', () => {
    const t = delivery();
    expect([t.mission, t.bonds, t.traits]).toEqual(['delivery', TRUCK_DELIVERY_STATE_TRAITS.to_gate, TRUCK_DELIVERY_STATE_TRAITS.to_gate]);
    expect(t.toState().mission).toBe('delivery');
    const pickup = new Truck({ id: id(42), def: DEFS.trucks.get('truck_container'), state: 'to_gate', x: 0.5, y: 0.5, heading: 0, route: [0], rampId: id(8), dock: 0, gateId: id(6), waitingAreaId: id(7), bay: 0 });
    expect([pickup.mission, pickup.bonds]).toEqual(['pickup', TRUCK_STATE_TRAITS.to_gate]);
    expect(() => delivery({ mission: 'drone' as 'pickup' })).toThrow(TruckError);
  });

  it('becomePickup len pre delivery vo vykládke (dual transaction); inak TruckError bez zmeny', () => {
    const t = delivery({ state: 'unloading', bay: null, route: [0] });
    t.becomePickup();
    expect([t.mission, t.bonds.claimsCargo, t.bonds.cargo]).toEqual(['pickup', false, 'unloading']);
    t.transition('loading');
    expect([t.bonds.claimsCargo, t.bonds.cargo]).toEqual([true, 'loading']);
    expect(() => t.becomePickup()).toThrow(TruckError);
    const early = delivery();
    expect(() => early.becomePickup()).toThrow(/vo vykládke/);
    expect(early.mission).toBe('delivery');
  });
});

describe('misia collect — výdaj prázdneho exportérovi (F6c, ADR-034)', () => {
  it('rovnaké štrukturálne väzby ako pickup, bez nároku na náklad docku; náklad collected od odchodu od docku, loading pri nakládke', () => {
    for (const state of TRUCK_STATES) {
      for (const key of STRUCTURAL) expect(TRUCK_COLLECT_STATE_TRAITS[state][key], `${state}.${key}`).toBe(TRUCK_STATE_TRAITS[state][key]);
    }
    expect(TRUCK_STATES.filter((state) => TRUCK_COLLECT_STATE_TRAITS[state].claimsCargo)).toEqual([]);
    expect(TRUCK_STATES.filter((state) => TRUCK_COLLECT_STATE_TRAITS[state].holdsIntake)).toEqual([]);
    const cargo = Object.fromEntries(TRUCK_STATES.map((state) => [state, truckStateTraits('collect', state).cargo]));
    expect(cargo).toMatchObject({ to_gate: 'empty', waiting: 'empty', to_dock: 'empty', loading: 'loading', to_gate_out: 'collected', gate_queue_out: 'collected', to_portal: 'collected', exited: 'collected' });
  });

  it('waiting → to_gate_out (vzdanie sa) je v tabuľke prechodov; iné stavy bez nového prechodu', () => {
    expect(TRUCK_TRANSITIONS.get('waiting')).toEqual(['to_dock', 'to_gate_out']);
    expect(isTruckTransitionAllowed('to_bay', 'to_gate_out')).toBe(false);
    expect(isTruckTransitionAllowed('loading', 'to_gate_out')).toBe(true);
  });

  it('Truck s misiou collect: bonds a traits podľa misie, misia v save zázname, becomePickup odmietne', () => {
    const truck = delivery({ mission: 'collect', state: 'waiting', bay: 1 });
    expect([truck.mission, truck.bonds.claimsCargo, truck.bonds.cargo, truck.bonds.holdsDock]).toEqual(['collect', false, 'empty', false]);
    expect(truck.toState().mission).toBe('collect');
    truck.transition('to_gate_out');
    expect([truck.state, truck.traits.cargo]).toEqual(['to_gate_out', 'collected']);
    expect(() => truck.becomePickup()).toThrow(TruckError);
  });
});
