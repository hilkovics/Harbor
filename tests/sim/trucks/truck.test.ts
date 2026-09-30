// Kamión a jeho FSM (T04-04; ARCHITECTURE §7.5; rozhodnutie orchestrátora F4 č. 6; ADR-024): explicitná tabuľka
// prechodov, vlastnosti stavov (bay, dock, náklad, fronta), návrat z no_path len do stavu, z ktorého kamión vypadol,
// validácia konštruktora (TruckError) a save záznam v pevnom poradí kľúčov. Pohyb zdieľa Carrier s vozidlami.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { Carrier } from '@sim/movement';
import {
  SERIALIZED_TRUCK_KEYS,
  TRUCK_STATES,
  TRUCK_STATE_TRAITS,
  TRUCK_TRANSITIONS,
  TRUCK_TRAVEL_STATES,
  Truck,
  TruckError,
  changeTruckState,
  type TruckInit,
  type TruckState,
} from '@sim/trucks';
import type { SimEvent } from '@sim/events';
import { DEFS } from '../world/world-fixtures';

const DEF = DEFS.trucks.get('truck_container');
const id = (value: number): EntityId => value as EntityId;

function truck(overrides: Partial<TruckInit> = {}): Truck {
  return new Truck({
    id: id(40),
    def: DEF,
    state: 'to_gate',
    x: 0.5,
    y: 0.5,
    heading: 0,
    route: [0],
    rampId: id(8),
    dock: 0,
    gateId: id(6),
    waitingAreaId: id(7),
    bay: 0,
    ...overrides,
  });
}

function truckError(action: () => unknown): TruckError {
  try {
    action();
  } catch (error) {
    if (error instanceof TruckError) return error;
    throw error;
  }
  throw new Error('očakávaná TruckError');
}

describe('TRUCK_TRANSITIONS a TRUCK_STATE_TRAITS', () => {
  it('cyklus to_gate → … → to_portal → exited; jazdné stavy môžu do no_path, z no_path len do jazdných; exited je koncový', () => {
    const cycle: TruckState[] = ['to_gate', 'gate_queue', 'to_bay', 'waiting', 'to_dock', 'loading', 'to_gate_out', 'gate_queue_out', 'to_portal', 'exited'];
    for (let i = 0; i + 1 < cycle.length; i++) expect(TRUCK_TRANSITIONS.get(cycle[i]), cycle[i]).toContain(cycle[i + 1]);
    for (const state of TRUCK_STATES) {
      const travel = (TRUCK_TRAVEL_STATES as readonly string[]).includes(state);
      expect(TRUCK_TRANSITIONS.get(state)?.includes('no_path') ?? false, state).toBe(travel);
    }
    expect(TRUCK_TRANSITIONS.get('no_path')).toEqual([...TRUCK_TRAVEL_STATES]);
    expect(TRUCK_TRANSITIONS.get('exited')).toEqual([]);
  });

  it('vlastnosti: bay od spawnu po waiting, dock od povelu do docku po loading, nárok na náklad od spawnu po loading (ADR-029), náklad prázdny → nakládka → plný, fronta len gate_queue*', () => {
    const holdsBay = TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].holdsBay);
    const holdsDock = TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].holdsDock);
    const claimsCargo = TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].claimsCargo);
    const queued = TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].queued);
    expect(holdsBay).toEqual(['to_gate', 'gate_queue', 'to_bay', 'waiting']);
    expect(holdsDock).toEqual(['to_dock', 'loading']);
    expect(claimsCargo).toEqual(['to_gate', 'gate_queue', 'to_bay', 'waiting', 'to_dock', 'loading']);
    expect(queued).toEqual(['gate_queue', 'gate_queue_out']);
    expect(TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].bayOccupied)).toEqual(['waiting']);
    expect(TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].cargo === 'loading')).toEqual(['loading']);
    expect(TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].waits)).toEqual(['waiting', 'loading', 'no_path']);
    expect(TRUCK_STATES.filter((state) => TRUCK_STATE_TRAITS[state].passageBack)).toEqual(['to_gate_out']);
    expect([TRUCK_STATE_TRAITS.gate_queue.afterGate, TRUCK_STATE_TRAITS.gate_queue_out.afterGate]).toEqual(['to_bay', 'to_portal']);
    for (const state of TRUCK_TRAVEL_STATES) expect(TRUCK_STATE_TRAITS[state].motion, state).toBe('drive');
  });
});

describe('Truck', () => {
  it('je Carrier (zdieľaný pohyb) a chyby pohybu hlási ako TruckError(invalid_input)', () => {
    const t = truck();
    expect(t).toBeInstanceOf(Carrier);
    expect(truckError(() => t.followRoute([5])).code).toBe('invalid_input');
    expect([t.label, t.defId, t.state, t.resume, t.effectiveState, t.bonds]).toEqual(['truck_container #40', 'truck_container', 'to_gate', null, 'to_gate', TRUCK_STATE_TRAITS.to_gate]);
  });

  it('prechody podľa tabuľky; do no_path si zapamätá stav a vráti sa len doň; väzby v no_path podľa resume', () => {
    const t = truck();
    const events: SimEvent[] = [];
    changeTruckState({ emit: (event) => events.push(event) }, t, 'no_path');
    expect([t.state, t.resume, t.effectiveState, t.bonds.holdsBay]).toEqual(['no_path', 'to_gate', 'to_gate', true]);
    expect(truckError(() => t.transition('to_bay')).code).toBe('invalid_transition');
    expect(t.state).toBe('no_path');
    t.transition('to_gate');
    expect([t.state, t.resume]).toEqual(['to_gate', null]);
    expect(truckError(() => t.transition('waiting')).code).toBe('invalid_transition');
    expect(events).toEqual([{ type: 'TruckStateChanged', truckId: 40, from: 'to_gate', to: 'no_path' }]);
  });

  it.each<[string, Partial<TruckInit>]>([
    ['id 0', { id: id(0) }],
    ['rampId 0', { rampId: id(0) }],
    ['záporný dock', { dock: -1 }],
    ['neznámy stav', { state: 'parked' as TruckState }],
    ['resume mimo no_path', { resume: 'to_gate' }],
    ['no_path bez resume', { state: 'no_path', bay: null }],
    ['no_path s resume, ktorý nie je jazdný', { state: 'no_path', resume: 'waiting' as never }],
    ['bay v stave bez bay', { state: 'to_dock', bay: 0 }],
    ['bez bay v stave s bay', { bay: null }],
    ['záporný bay', { bay: -2 }],
    ['kurz 45', { heading: 45 as never }],
    ['prázdna trasa', { route: [] }],
    ['progres bez ďalšej bunky', { progress: 0.5 }],
    ['záporný waitTicks', { waitTicks: -1 }],
  ])('konštruktor: %s → TruckError(invalid_input)', (_name, overrides) => {
    expect(truckError(() => truck(overrides)).code).toBe('invalid_input');
  });

  it('no_path s resume to_bay drží bay; s resume to_dock nie', () => {
    expect(truck({ state: 'no_path', resume: 'to_bay', bay: 2 }).bonds.holdsBay).toBe(true);
    expect(truck({ state: 'no_path', resume: 'to_dock', bay: null }).bonds.holdsDock).toBe(true);
  });

  it('toState: kľúče v poradí SERIALIZED_TRUCK_KEYS, čistý JSON so zvyškom trasy', () => {
    const t = truck({ state: 'no_path', resume: 'to_bay', bay: 3, route: [0, 1], progress: 0.25, x: 0.75, heading: 90, waitTicks: 7 });
    const state = t.toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_TRUCK_KEYS]);
    expect(state).toEqual({
      id: 40,
      defId: 'truck_container',
      state: 'no_path',
      x: 0.75,
      y: 0.5,
      heading: 90,
      rampId: 8,
      dock: 0,
      gateId: 6,
      waitingAreaId: 7,
      bay: 3,
      resume: 'to_bay',
      route: [0, 1],
      progress: 0.25,
      waitTicks: 7,
      replan: false,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
