// CraneModule (T02-03, ARCHITECTURE §7.2, rozhodnutie 3 a 7): berthId z berthu pod žeriavom, počiatočný stav,
// tabuľka CRANE_STATE_TRAITS, serializácia runtime stavu (roundtrip + validácia s cestou).
import { describe, expect, it } from 'vitest';
import { craneParams } from '@sim/defs';
import { CRANE_STATES, CRANE_STATE_TRAITS, CraneModule, ModuleStateError, type CraneRuntimeState } from '@sim/modules';
import { CRANE, MODULE_DEFS, craneOn, markCells, quayGrid } from './module-fixtures';

/** Berth #7 na x 2–9, y 2–4 syntetickej mriežky; žeriav #8 na (4, 2). */
const BERTH_ID = 7;

function freshCrane(): CraneModule {
  const grid = quayGrid(20, 12);
  markCells(grid, BERTH_ID, { x: 2, y: 2, w: 8, h: 3 });
  return craneOn(grid, 8, { x: 4, y: 2 });
}

const VALID: CraneRuntimeState = {
  state: 'placing',
  phaseTicksTotal: 6,
  phaseTicksLeft: 2,
  reservedSlot: 1,
  busyTicks: 120,
  idleTicks: 40,
  blockedTicks: 7,
  lastBlockedHour: 3,
};

describe('CraneModule', () => {
  it('stojí na berthe: berthId, typované params, kategória, počiatočný stav idle bez jednotky a rezervácie', () => {
    const crane = freshCrane();
    expect(crane.berthId).toBe(BERTH_ID);
    expect(crane.params).toEqual(craneParams(MODULE_DEFS.modules.get(CRANE)));
    expect(crane.category).toBe('container');
    expect(crane.state).toBe('idle');
    expect([crane.phaseTicksTotal, crane.phaseTicksLeft]).toEqual([0, 0]);
    expect(crane.heldUnitId).toBeNull();
    expect(crane.reservedSlot).toBeNull();
    expect([crane.busyTicks, crane.idleTicks, crane.blockedTicks]).toEqual([0, 0, 0]);
    expect(crane.lastBlockedHour).toBeNull();
    expect(crane.traits).toBe(CRANE_STATE_TRAITS.idle);
  });

  it('CRANE_STATE_TRAITS pokrýva všetky stavy podľa rozhodnutia 7', () => {
    expect(Object.keys(CRANE_STATE_TRAITS)).toEqual([...CRANE_STATES]);
    expect(CRANE_STATE_TRAITS).toEqual({
      idle: { holdsUnit: false, hasReservation: false, counter: 'idle' },
      grabbing: { holdsUnit: false, hasReservation: true, counter: 'busy' },
      swinging: { holdsUnit: true, hasReservation: true, counter: 'busy' },
      placing: { holdsUnit: true, hasReservation: true, counter: 'busy' },
      blocked: { holdsUnit: false, hasReservation: false, counter: 'blocked' },
    });
  });
});

describe('CraneModule — runtime stav', () => {
  it('getRuntimeState: presne kľúče v pevnom poradí, bez heldUnitId (je v ledgeri)', () => {
    const crane = freshCrane();
    expect(Object.keys(crane.getRuntimeState())).toEqual([
      'state',
      'phaseTicksTotal',
      'phaseTicksLeft',
      'reservedSlot',
      'busyTicks',
      'idleTicks',
      'blockedTicks',
      'lastBlockedHour',
    ]);
  });

  it('roundtrip: restoreRuntimeState(getRuntimeState()) cez JSON dá rovnaký stav', () => {
    const source = freshCrane();
    source.restoreRuntimeState(VALID);
    const target = freshCrane();
    target.restoreRuntimeState(JSON.parse(JSON.stringify(source.getRuntimeState())));
    expect(target.getRuntimeState()).toEqual(VALID);
    expect(target.state).toBe('placing');
    expect(target.reservedSlot).toBe(1);
  });

  it('getRuntimeState vracia novú kópiu', () => {
    const crane = freshCrane();
    const state = crane.getRuntimeState() as { busyTicks: number };
    state.busyTicks = 999;
    expect(crane.busyTicks).toBe(0);
  });

  const INVALID: readonly [string, Record<string, unknown>, string][] = [
    ['neznámy kľúč', { ...VALID, heldUnitId: 5 }, '/heldUnitId'],
    ['chýba kľúč', { ...VALID, lastBlockedHour: undefined }, '/lastBlockedHour'],
    ['neznámy stav', { ...VALID, state: 'sleeping' }, '/state'],
    ['záporné phaseTicksTotal', { ...VALID, phaseTicksTotal: -1 }, '/phaseTicksTotal'],
    ['phaseTicksLeft > total', { ...VALID, phaseTicksLeft: 7 }, '/phaseTicksLeft'],
    ['zlomkový busyTicks', { ...VALID, busyTicks: 1.5 }, '/busyTicks'],
    ['idleTicks ako reťazec', { ...VALID, idleTicks: '4' }, '/idleTicks'],
    ['záporný blockedTicks', { ...VALID, blockedTicks: -3 }, '/blockedTicks'],
    ['placing bez rezervácie', { ...VALID, reservedSlot: null }, '/reservedSlot'],
    ['idle s rezerváciou', { ...VALID, state: 'idle' }, '/reservedSlot'],
    ['blocked s rezerváciou', { ...VALID, state: 'blocked' }, '/reservedSlot'],
    ['záporný slot', { ...VALID, reservedSlot: -1 }, '/reservedSlot'],
    ['zlomková hodina', { ...VALID, lastBlockedHour: 0.5 }, '/lastBlockedHour'],
  ];
  it.each(INVALID)('%s → ModuleStateError na %s, stav sa nezmení', (_name, raw, path) => {
    const crane = freshCrane();
    const before = crane.getRuntimeState();
    const payload = JSON.parse(JSON.stringify(raw)) as unknown;
    let error: unknown;
    try {
      crane.restoreRuntimeState(payload);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModuleStateError);
    expect((error as ModuleStateError).path).toBe(path);
    expect(crane.getRuntimeState()).toEqual(before);
  });

  it('runtime, ktorý nie je objekt → ModuleStateError na koreni', () => {
    for (const raw of [null, 3, 'idle', []]) {
      expect(() => freshCrane().restoreRuntimeState(raw)).toThrow(ModuleStateError);
    }
  });
});
