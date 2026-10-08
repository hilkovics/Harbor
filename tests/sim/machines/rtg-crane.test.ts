// RTG žeriav a FSM stroja bloku (TR3-01, ADR-040 bod 3): tabuľka prechodov, fázový odpočet a spojitá poloha, fronta, validácia vstupu a save tvar.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { MACHINE_STATES, MACHINE_TRANSITIONS, MachineError, RtgCrane, SERIALIZED_MACHINE_KEYS, isMachineTransitionAllowed, type MachineState } from '@sim/machines';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const DEF = BUNDLED_DEFS.equipment.rtg;
const id = (value: number): EntityId => value as EntityId;
const crane = (): RtgCrane => RtgCrane.create(id(5), id(4), DEF, 5);

describe('equipment.json → rtg', () => {
  it('časy a priority loď > kamión > housekeeping sú v dátach', () => {
    expect(DEF).toEqual({ gantryCellsPerTick: 2, hoistTicksPerTier: 1, trolleyTicksPerRow: 1, lockTicks: 1, prefetchCells: 6, handoverGiveUpTicks: 600, priorities: { ship: 0, truck: 1, housekeeping: 2 } });
  });
});

describe('MACHINE_TRANSITIONS: idle → travel → (shift)* → lift → trolley → lower → idle', () => {
  it('tabuľka presne zodpovedá FSM (preskočené fázy bez dráhy: lift → trolley | lower, shift → lower)', () => {
    expect(MACHINE_STATES).toEqual(['idle', 'travel', 'shift', 'lift', 'trolley', 'lower']);
    expect(Object.fromEntries(MACHINE_TRANSITIONS)).toEqual({
      idle: ['travel'],
      travel: ['shift', 'lift', 'idle'],
      shift: ['shift', 'lift', 'trolley', 'lower', 'idle'],
      lift: ['shift', 'trolley', 'lower', 'idle'],
      trolley: ['shift', 'lower', 'idle'],
      lower: ['idle'],
    });
  });

  it.each<[MachineState, MachineState]>([
    ['idle', 'lift'],
    ['idle', 'lower'],
    ['travel', 'lower'],
    ['lower', 'shift'],
    ['lower', 'travel'],
    ['trolley', 'lift'],
  ])('%s → %s nie je povolené', (from, to) => {
    expect(isMachineTransitionAllowed(from, to)).toBe(false);
  });

  it('transition mimo tabuľky vyhodí MachineError a stav sa nezmení', () => {
    const rtg = crane();
    expect(() => rtg.transition('lift')).toThrow(MachineError);
    expect(rtg.state).toBe('idle');
  });
});

describe('RtgCrane — fázy, poloha a časy z defu', () => {
  it('nový stroj stojí v bayi 0 nad pruhom so spúšťačom hore a nič nedrží', () => {
    const rtg = crane();
    expect(rtg.state).toBe('idle');
    expect(rtg.restPose).toEqual({ gantry: 0, trolley: -1, hoist: 5 });
    expect(rtg.cycle).toBeNull();
    expect(rtg.moves).toBe(0);
    expect(rtg.label).toBe('rtg #5');
  });

  it('časy fáz: pojazd žeriavu hore na tick podľa gantryCellsPerTick, vozík a zdvih podľa defu', () => {
    const rtg = crane();
    expect([rtg.gantryTicks(0), rtg.gantryTicks(1), rtg.gantryTicks(3), rtg.gantryTicks(-11)]).toEqual([0, 1, 2, 6]);
    expect(rtg.trolleyTicks(-3)).toBe(3 * DEF.trolleyTicksPerRow);
    expect(rtg.hoistTicks(4)).toBe(4 * DEF.hoistTicksPerTier);
  });

  it('fáza trvá presne `ticks` tickov a poloha sa interpoluje lineárne od začiatku po cieľ (spojitá)', () => {
    const rtg = crane();
    rtg.enterPhase('travel', 4, { gantry: 8, trolley: -1, hoist: 0 });
    expect(rtg.state).toBe('travel');
    expect(rtg.poseNow()).toEqual({ gantry: 0, trolley: -1, hoist: 5 });
    const gantry: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(rtg.advancePhase()).toBe(false);
      gantry.push(rtg.poseNow().gantry);
    }
    expect(gantry).toEqual([2, 4, 6]);
    expect(rtg.advancePhase()).toBe(true);
    expect(rtg.restPose).toEqual({ gantry: 8, trolley: -1, hoist: 0 });
    expect(rtg.poseNow()).toEqual({ gantry: 8, trolley: -1, hoist: 0 });
  });

  it('cyklus: beginCycle len v idle bez cyklu; endCycle (z lower) vráti idle a počíta presun', () => {
    const rtg = crane();
    const cycle = { kind: 'put', unitId: 9, vehicleId: 11, jobId: 12, fromSlot: null, toSlot: 7, tpBay: 0 } as const;
    rtg.beginCycle(cycle);
    expect(() => rtg.beginCycle(cycle)).toThrow(MachineError);
    rtg.transition('travel');
    rtg.transition('lift');
    rtg.transition('lower');
    rtg.endCycle();
    expect(rtg.state).toBe('idle');
    expect(rtg.cycle).toBeNull();
    expect(rtg.moves).toBe(1);
  });

  it('fronta: vozidlo je vo fronte najviac raz, dequeue ho vyradí, serves hlási frontu aj rozbehnutý cyklus', () => {
    const rtg = crane();
    rtg.enqueue(id(11), 100);
    rtg.enqueue(id(11), 105);
    rtg.enqueue(id(12), 101);
    expect(rtg.queue).toEqual([{ vehicleId: 11, createdTick: 100 }, { vehicleId: 12, createdTick: 101 }]);
    rtg.dequeue(id(11));
    expect(rtg.serves(id(11))).toBe(false);
    expect(rtg.serves(id(12))).toBe(true);
    rtg.dequeue(id(12));
    rtg.beginCycle({ kind: 'take', unitId: 9, vehicleId: 12, jobId: 13, fromSlot: 3, toSlot: null, tpBay: 0 });
    expect(rtg.serves(id(12))).toBe(true);
  });

  it('toState je čistý JSON v poradí SERIALIZED_MACHINE_KEYS a obnova z neho dá rovnaký stav', () => {
    const rtg = crane();
    rtg.enqueue(id(11), 100);
    rtg.beginCycle({ kind: 'relocate', unitId: 9, vehicleId: null, jobId: null, fromSlot: 4, toSlot: 9, tpBay: 0 });
    rtg.enterPhase('travel', 3, { gantry: 6, trolley: 2, hoist: 1 });
    rtg.advancePhase();
    const state = rtg.toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_MACHINE_KEYS]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const copy = new RtgCrane({ ...state, id: id(state.id), blockId: id(state.blockId), def: DEF });
    expect(copy.toState()).toEqual(state);
    expect(copy.poseNow()).toEqual(rtg.poseNow());
  });

  it.each([
    ['id 0', { id: 0, blockId: 4 }],
    ['blockId 0', { id: 5, blockId: 0 }],
    ['nekonečná poloha', { id: 5, blockId: 4, pose: { gantry: Infinity, trolley: 0, hoist: 0 } }],
    ['idle s odpočtom', { id: 5, blockId: 4, phaseTotal: 3, phaseLeft: 2 }],
    ['fáza bez odpočtu', { id: 5, blockId: 4, state: 'lift' as const }],
    ['odpočet väčší než fáza', { id: 5, blockId: 4, state: 'lift' as const, phaseTotal: 2, phaseLeft: 3 }],
    ['záporné počítadlo', { id: 5, blockId: 4, moves: -1 }],
  ])('konštruktor odmietne %s', (_name, init) => {
    expect(() => new RtgCrane({ id: id(5), blockId: id(4), pose: { gantry: 0, trolley: 0, hoist: 0 }, def: DEF, ...(init as object) } as never)).toThrow(MachineError);
  });
});
