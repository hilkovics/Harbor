// Plán toku prázdnych kontajnerov (T6C-01, ADR-034): `EmptyFlow` (fronty návratu a výdaja zoradené podľa ticku, stabilné,
// konzumácia, zrušenie výdajov bookingu, stav) a `parseEmptyFlowState` (fail-fast s pointerom). Plnenie plánu dodá T6C-02.
import { describe, expect, it } from 'vitest';
import { DefRegistry } from '@sim/defs';
import { EMPTY_FLOW_STATE_KEYS, EmptyFlow, PICKUP_PLAN_ENTRY_KEYS, RETURN_PLAN_ENTRY_KEYS } from '@sim/logistics';
import { WorldStateError, parseEmptyFlowState } from '@sim/world';
import { RAW_DEFS } from '../world/world-fixtures';

const DEFS = DefRegistry.fromRaw(RAW_DEFS);

describe('EmptyFlow — plán návratov', () => {
  it('nový plán je prázdny; nič nie je splatné', () => {
    const flow = new EmptyFlow();
    expect([flow.returnPlan, flow.pickupPlan]).toEqual([[], []]);
    expect([flow.dueReturn(1_000_000), flow.duePickup(1_000_000)]).toEqual([undefined, undefined]);
  });

  it('scheduleReturn: položky podľa dueTick, pri rovnakom ticku v poradí vzniku (stabilné)', () => {
    const flow = new EmptyFlow();
    flow.scheduleReturn(500, 'golden_wave');
    flow.scheduleReturn(100, 'blue_anchor');
    flow.scheduleReturn(500, 'northern_star');
    flow.scheduleReturn(300, 'blue_anchor');
    flow.scheduleReturn(500, 'blue_anchor');
    expect(flow.returnPlan.map((entry) => [entry.dueTick, entry.lineId])).toEqual([
      [100, 'blue_anchor'],
      [300, 'blue_anchor'],
      [500, 'golden_wave'],
      [500, 'northern_star'],
      [500, 'blue_anchor'],
    ]);
  });

  it('dueReturn berie najbližšiu položku len keď je splatná (dueTick ≤ tick); consumeReturn ju odstráni', () => {
    const flow = new EmptyFlow();
    flow.scheduleReturn(200, 'blue_anchor');
    flow.scheduleReturn(100, 'golden_wave');
    expect(flow.dueReturn(99)).toBeUndefined();
    expect(flow.dueReturn(100)).toEqual({ dueTick: 100, lineId: 'golden_wave' });
    flow.consumeReturn();
    expect(flow.dueReturn(150)).toBeUndefined();
    expect(flow.dueReturn(200)).toEqual({ dueTick: 200, lineId: 'blue_anchor' });
    flow.consumeReturn();
    flow.consumeReturn(); // prázdny plán: bez chyby
    expect(flow.returnPlan).toEqual([]);
  });
});

describe('EmptyFlow — plán výdajov exportérovi', () => {
  it('schedulePickup / duePickup / consumePickup rovnako ako návraty, nezávisle od returnPlan', () => {
    const flow = new EmptyFlow();
    flow.schedulePickup(400, 'blue_anchor', 7);
    flow.schedulePickup(250, 'northern_star', 8);
    flow.scheduleReturn(10, 'golden_wave');
    expect(flow.pickupPlan.map((entry) => entry.contractId)).toEqual([8, 7]);
    expect(flow.duePickup(249)).toBeUndefined();
    expect(flow.duePickup(250)).toEqual({ dueTick: 250, lineId: 'northern_star', contractId: 8 });
    flow.consumePickup();
    expect(flow.duePickup(1_000)?.contractId).toBe(7);
    expect(flow.returnPlan).toHaveLength(1);
  });

  it('dropPickupsOf zruší nesplatené výdaje len daného bookingu a vráti ich počet', () => {
    const flow = new EmptyFlow();
    flow.schedulePickup(100, 'blue_anchor', 7);
    flow.schedulePickup(200, 'blue_anchor', 8);
    flow.schedulePickup(300, 'blue_anchor', 7);
    flow.schedulePickup(300, 'blue_anchor', 9);
    expect(flow.dropPickupsOf(7)).toBe(2);
    expect(flow.pickupPlan.map((entry) => entry.contractId)).toEqual([8, 9]);
    expect(flow.dropPickupsOf(7)).toBe(0);
  });
});

describe('EmptyFlow — stav', () => {
  it('getState → JSON → fromState: rovnaký plán v rovnakom poradí; kópia nezdieľa objekty so živým plánom', () => {
    const flow = new EmptyFlow();
    flow.scheduleReturn(500, 'golden_wave');
    flow.scheduleReturn(100, 'blue_anchor');
    flow.schedulePickup(300, 'northern_star', 4);
    const state = flow.getState();
    expect(Object.keys(state)).toEqual([...EMPTY_FLOW_STATE_KEYS]);
    expect(Object.keys(state.returnPlan[0])).toEqual([...RETURN_PLAN_ENTRY_KEYS]);
    expect(Object.keys(state.pickupPlan[0])).toEqual([...PICKUP_PLAN_ENTRY_KEYS]);
    const restored = EmptyFlow.fromState(JSON.parse(JSON.stringify(state)));
    expect(restored.getState()).toEqual(state);
    flow.consumeReturn();
    expect(state.returnPlan).toHaveLength(2);
    expect(restored.returnPlan).toHaveLength(2);
    expect(flow.returnPlan).toHaveLength(1);
  });
});

describe('parseEmptyFlowState', () => {
  const valid = {
    returnPlan: [
      { dueTick: 100, lineId: 'blue_anchor' },
      { dueTick: 100, lineId: 'golden_wave' },
    ],
    pickupPlan: [{ dueTick: 50, lineId: 'northern_star', contractId: 3 }],
  };

  it('platný stav prejde a výsledok nezdieľa objekty so vstupom', () => {
    const parsed = parseEmptyFlowState(valid, DEFS);
    expect(parsed).toEqual(valid);
    expect(parsed.returnPlan[0]).not.toBe(valid.returnPlan[0]);
    expect(parseEmptyFlowState({ returnPlan: [], pickupPlan: [] }, DEFS)).toEqual({ returnPlan: [], pickupPlan: [] });
  });

  it.each<[string, unknown, string]>([
    ['nie objekt', null, '/emptyFlow'],
    ['chýbajúci kľúč', { returnPlan: [] }, '/emptyFlow/pickupPlan'],
    ['cudzí kľúč', { ...valid, extra: 1 }, '/emptyFlow/extra'],
    ['returnPlan nie pole', { ...valid, returnPlan: {} }, '/emptyFlow/returnPlan'],
    ['neznáma linka v návrate', { ...valid, returnPlan: [{ dueTick: 1, lineId: 'ghost_line' }] }, '/emptyFlow/returnPlan/0/lineId'],
    ['zlý dueTick návratu', { ...valid, returnPlan: [{ dueTick: -1, lineId: 'blue_anchor' }] }, '/emptyFlow/returnPlan/0/dueTick'],
    ['necelý dueTick návratu', { ...valid, returnPlan: [{ dueTick: 1.5, lineId: 'blue_anchor' }] }, '/emptyFlow/returnPlan/0/dueTick'],
    ['nezoradený návrat', { ...valid, returnPlan: [valid.returnPlan[0], { dueTick: 99, lineId: 'blue_anchor' }] }, '/emptyFlow/returnPlan/1/dueTick'],
    ['cudzí kľúč v návrate', { ...valid, returnPlan: [{ dueTick: 1, lineId: 'blue_anchor', contractId: 1 }] }, '/emptyFlow/returnPlan/0/contractId'],
    ['neznáma linka vo výdaji', { ...valid, pickupPlan: [{ dueTick: 1, lineId: 'ghost_line', contractId: 1 }] }, '/emptyFlow/pickupPlan/0/lineId'],
    ['contractId 0 vo výdaji', { ...valid, pickupPlan: [{ dueTick: 1, lineId: 'blue_anchor', contractId: 0 }] }, '/emptyFlow/pickupPlan/0/contractId'],
    ['nezoradený výdaj', { ...valid, pickupPlan: [{ dueTick: 9, lineId: 'blue_anchor', contractId: 1 }, { dueTick: 8, lineId: 'blue_anchor', contractId: 2 }] }, '/emptyFlow/pickupPlan/1/dueTick'],
  ])('odmietne: %s', (_name, raw, path) => {
    try {
      parseEmptyFlowState(raw, DEFS);
      throw new Error('mal zlyhať');
    } catch (error) {
      expect(error).toBeInstanceOf(WorldStateError);
      expect((error as WorldStateError).path).toBe(path);
    }
  });

  it('poradie nezoradenosti sa kontroluje zvlášť pre návraty a výdaje (výdaj nemusí nadväzovať na návrat)', () => {
    expect(() => parseEmptyFlowState({ returnPlan: [{ dueTick: 900, lineId: 'blue_anchor' }], pickupPlan: [{ dueTick: 5, lineId: 'blue_anchor', contractId: 1 }] }, DEFS)).not.toThrow();
  });
});
