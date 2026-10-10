// Kamión a jeho FSM (T04-04; ARCHITECTURE §7.5; ADR-024; R4 ADR-041): explicitná tabuľka prechodov, vlastnosti stavov (token TP / státie, fáza na TP, fronta, cesta),
// návrat z no_path len do stavu, z ktorého kamión vypadol, validácia konštruktora (TruckError) a save záznam v pevnom poradí kľúčov. Pohyb zdieľa Carrier s vozidlami.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { Carrier } from '@sim/movement';
import {
  SERIALIZED_TRUCK_KEYS,
  TP_PHASE_SEQUENCE,
  TP_ROLE_OF_MISSION,
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

/** Kamión v `to_tp` s tokenom TP (bunka 5), blokom 4 a vstupným pruhom 6. */
function truck(overrides: Partial<TruckInit> = {}): Truck {
  return new Truck({
    id: id(40),
    def: DEF,
    state: 'to_tp',
    x: 0.5,
    y: 0.5,
    heading: 0,
    route: [0],
    blockId: id(4),
    gateId: id(6),
    tpCell: 5,
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

const statesWhere = (predicate: (state: TruckState) => boolean): TruckState[] => TRUCK_STATES.filter(predicate);

describe('TRUCK_TRANSITIONS a TRUCK_STATE_TRAITS', () => {
  it('cyklus to_pre_gate → … → to_tp → at_tp → to_gate_out → … → to_portal → exited; odstavná plocha, hrana bloku a dual transaction; jazdné stavy môžu do no_path, z no_path len do jazdných; exited je koncový', () => {
    const cycle: TruckState[] = ['to_pre_gate', 'pre_gate', 'to_gate', 'gate_queue', 'gate_pass', 'to_tp', 'at_tp', 'to_gate_out', 'gate_queue_out', 'gate_pass_out', 'to_portal', 'exited'];
    for (let i = 0; i + 1 < cycle.length; i++) expect(TRUCK_TRANSITIONS.get(cycle[i]), cycle[i]).toContain(cycle[i + 1]);
    expect(TRUCK_TRANSITIONS.get('gate_pass')).toEqual(['to_holding', 'to_tp']);
    expect(TRUCK_TRANSITIONS.get('to_holding')).toContain('holding');
    expect(TRUCK_TRANSITIONS.get('holding')).toEqual(['to_tp']);
    expect(TRUCK_TRANSITIONS.get('to_tp')).toContain('at_edge_tp');
    // dual transaction: z TP na ďalšie TP (jeden lístok), alebo von
    for (const state of ['at_tp', 'at_edge_tp'] as const) expect(TRUCK_TRANSITIONS.get(state), state).toEqual(['to_gate_out', 'to_tp']);
    for (const state of TRUCK_STATES) {
      const travel = (TRUCK_TRAVEL_STATES as readonly string[]).includes(state);
      expect(TRUCK_TRANSITIONS.get(state)?.includes('no_path') ?? false, state).toBe(travel);
    }
    expect(TRUCK_TRANSITIONS.get('no_path')).toEqual([...TRUCK_TRAVEL_STATES]);
    expect(TRUCK_TRANSITIONS.get('exited')).toEqual([]);
  });

  it('vlastnosti: token od vzniku po odchod z TP, na cestu len jazda, fronta a TP v pruhu (ADR-037), prechod bránou mimo cesty, fáza len na TP', () => {
    expect(statesWhere((state) => TRUCK_STATE_TRAITS[state].holdsToken)).toEqual(['to_pre_gate', 'pre_gate', 'to_gate', 'gate_queue', 'gate_pass', 'to_holding', 'holding', 'to_tp', 'at_tp', 'at_edge_tp']);
    expect(statesWhere((state) => TRUCK_STATE_TRAITS[state].queued)).toEqual(['gate_queue', 'gate_queue_out']);
    expect(statesWhere((state) => TRUCK_STATE_TRAITS[state].passing)).toEqual(['gate_pass', 'gate_pass_out']);
    expect(statesWhere((state) => TRUCK_STATE_TRAITS[state].holdsRoad)).toEqual(['to_pre_gate', 'to_gate', 'gate_queue', 'to_holding', 'to_tp', 'at_tp', 'to_gate_out', 'gate_queue_out', 'to_portal', 'no_path']);
    expect(statesWhere((state) => TRUCK_STATE_TRAITS[state].atTp)).toEqual(['at_tp', 'at_edge_tp']);
    expect(statesWhere((state) => TRUCK_STATE_TRAITS[state].waits)).toEqual(['holding', 'at_tp', 'at_edge_tp', 'no_path']);
    expect([TRUCK_STATE_TRAITS.gate_queue.afterGate, TRUCK_STATE_TRAITS.gate_queue_out.afterGate]).toEqual(['to_tp', 'to_portal']);
    expect([TRUCK_STATE_TRAITS.gate_pass.afterGate, TRUCK_STATE_TRAITS.gate_pass_out.afterGate]).toEqual(['to_tp', 'to_portal']);
    expect([TRUCK_STATE_TRAITS.gate_queue.passState, TRUCK_STATE_TRAITS.gate_queue_out.passState]).toEqual(['gate_pass', 'gate_pass_out']);
    for (const state of TRUCK_TRAVEL_STATES) expect(TRUCK_STATE_TRAITS[state].motion, state).toBe('drive');
  });

  it('úloha na TP podľa misie a postupnosť fáz (bezpečná zóna pred a po zdvihu, lashing / unlashing)', () => {
    expect(TP_ROLE_OF_MISSION).toEqual({ pickup: 'take', delivery: 'put', collect: 'take' });
    expect(TP_PHASE_SEQUENCE.take).toEqual(['safe_in', 'handling', 'safe_out', 'lash']);
    expect(TP_PHASE_SEQUENCE.put).toEqual(['safe_in', 'unlash', 'handling', 'safe_out']);
  });
});

describe('Truck', () => {
  it('je Carrier (zdieľaný pohyb) a chyby pohybu hlási ako TruckError(invalid_input)', () => {
    const t = truck();
    expect(t).toBeInstanceOf(Carrier);
    expect(truckError(() => t.followRoute([5])).code).toBe('invalid_input');
    expect([t.label, t.defId, t.state, t.resume, t.effectiveState, t.bonds]).toEqual(['truck_container #40', 'truck_container', 'to_tp', null, 'to_tp', TRUCK_STATE_TRAITS.to_tp]);
  });

  it('prechody podľa tabuľky; do no_path si zapamätá stav a vráti sa len doň; token sa drží aj v no_path', () => {
    const t = truck();
    const events: SimEvent[] = [];
    changeTruckState({ emit: (event) => events.push(event) }, t, 'no_path');
    expect([t.state, t.resume, t.effectiveState, t.bonds.holdsToken, t.tpCell]).toEqual(['no_path', 'to_tp', 'to_tp', true, 5]);
    expect(truckError(() => t.transition('at_tp')).code).toBe('invalid_transition');
    expect(t.state).toBe('no_path');
    t.transition('to_tp');
    expect([t.state, t.resume]).toEqual(['to_tp', null]);
    expect(truckError(() => t.transition('holding')).code).toBe('invalid_transition');
    expect(events).toEqual([{ type: 'TruckStateChanged', truckId: 40, from: 'to_tp', to: 'no_path' }]);
  });

  it('dual transaction: len delivery kamión na TP sa stane pickup; iná misia alebo stav mimo TP → invalid_transition', () => {
    const delivery = truck({ mission: 'delivery', state: 'at_tp', phase: 'handling' });
    delivery.becomePickup();
    expect(delivery.mission).toBe('pickup');
    expect(truckError(() => delivery.becomePickup()).code).toBe('invalid_transition');
    expect(truckError(() => truck({ mission: 'delivery' }).becomePickup()).code).toBe('invalid_transition');
  });

  it.each<[string, Partial<TruckInit>]>([
    ['id 0', { id: id(0) }],
    ['blockId 0', { blockId: id(0) }],
    ['gateId 0', { gateId: id(0) }],
    ['neznámy stav', { state: 'parked' as TruckState }],
    ['resume mimo no_path', { resume: 'to_tp' }],
    ['no_path bez resume', { state: 'no_path' }],
    ['no_path s resume, ktorý nie je jazdný', { state: 'no_path', resume: 'at_tp' as never }],
    ['záporné TP', { tpCell: -1 }],
    ['bez tokenu v stave s tokenom', { tpCell: null }],
    ['TP aj státie naraz', { stall: 0, holdingId: id(9) }],
    ['TP v stave bez tokenu', { state: 'to_portal', route: [0], tpCell: 5 }],
    ['státie bez odstavnej plochy', { tpCell: null, stall: 2 }],
    ['to_holding bez státia', { state: 'to_holding' }],
    ['fáza mimo TP', { phase: 'safe_in' }],
    ['TP bez fázy', { state: 'at_tp' }],
    ['neznáma fáza', { state: 'at_tp', phase: 'dance' as never }],
    ['záporný gateInTick', { gateInTick: -1 }],
    ['kurz 45', { heading: 45 as never }],
    ['prázdna trasa', { route: [] }],
    ['progres bez ďalšej bunky', { progress: 0.5 }],
    ['záporný waitTicks', { waitTicks: -1 }],
  ])('konštruktor: %s → TruckError(invalid_input)', (_name, overrides) => {
    expect(truckError(() => truck(overrides)).code).toBe('invalid_input');
  });

  it('kamión v odstavnej ploche drží státie (nie TP); no_path s resume to_tp drží token TP', () => {
    expect(truck({ state: 'holding', tpCell: null, holdingId: id(9), stall: 2, waitTicks: 3 }).bonds.holdsToken).toBe(true);
    expect(truck({ state: 'no_path', resume: 'to_tp' }).bonds.holdsToken).toBe(true);
    expect(truck({ state: 'no_path', resume: 'to_portal', tpCell: null }).bonds.holdsToken).toBe(false);
  });

  it('toState: kľúče v poradí SERIALIZED_TRUCK_KEYS, čistý JSON so zvyškom trasy', () => {
    const t = truck({ state: 'no_path', resume: 'to_tp', route: [0, 1], progress: 0.25, x: 0.75, heading: 90, waitTicks: 7, jobId: id(12), unitId: id(30), gateInTick: 44 });
    const state = t.toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_TRUCK_KEYS]);
    expect(state).toEqual({
      id: 40,
      defId: 'truck_container',
      mission: 'pickup',
      state: 'no_path',
      x: 0.75,
      y: 0.5,
      heading: 90,
      blockId: 4,
      jobId: 12,
      unitId: 30,
      tpCell: 5,
      holdingId: null,
      stall: null,
      phase: null,
      gateInTick: 44,
      gateId: 6,
      gateOutId: null,
      preGateId: null,
      row: null,
      resume: 'to_tp',
      route: [0, 1],
      progress: 0.25,
      waitTicks: 7,
      replan: false,
      body: [],
      ahead: [],
      blockedTicks: 0,
      rerouteCooldown: 0,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
