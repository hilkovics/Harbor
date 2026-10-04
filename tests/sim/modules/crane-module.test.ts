// CraneModule (T02-03, T02-05, ARCHITECTURE §7.2, rozhodnutie 3 a 7, ADR-016): berthId z berthu pod žeriavom,
// počiatočný stav, tabuľky CRANE_STATE_TRAITS a CRANE_TRANSITIONS (transition, enterPhase, phaseProgress),
// serializácia runtime stavu (roundtrip + validácia s cestou).
import { describe, expect, it } from 'vitest';
import { craneParams } from '@sim/defs';
import {
  CRANE_CYCLES,
  CRANE_CYCLE_TRAITS,
  CRANE_STATES,
  CRANE_STATE_TRAITS,
  CRANE_TRANSITIONS,
  CraneModule,
  ModuleError,
  ModuleStateError,
  craneReservesApronSlot,
  cranePhaseProblem,
  isCraneTransitionAllowed,
  type CraneRuntimeState,
  type CraneState,
} from '@sim/modules';
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
  cycle: 'unload',
  phaseTicksTotal: 6,
  phaseTicksLeft: 2,
  reservedSlot: 1,
  targetUnitId: null,
  dualUnitId: null,
  busyTicks: 120,
  idleTicks: 40,
  blockedTicks: 7,
  waitForVehicleTicks: 11,
  vehicleWaitTicks: 13,
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
      idle: { holdsUnit: false, hasReservation: false, counter: 'idle', phase: 'none' },
      grabbing: { holdsUnit: false, hasReservation: true, counter: 'busy', phase: 'timed' },
      swinging: { holdsUnit: true, hasReservation: true, counter: 'busy', phase: 'instant' },
      placing: { holdsUnit: true, hasReservation: true, counter: 'busy', phase: 'timed' },
      blocked: { holdsUnit: false, hasReservation: false, counter: 'blocked', phase: 'none' },
    });
  });
});

describe('CraneModule — runtime stav', () => {
  it('getRuntimeState: presne kľúče v pevnom poradí, bez heldUnitId (je v ledgeri)', () => {
    const crane = freshCrane();
    expect(Object.keys(crane.getRuntimeState())).toEqual([
      'state',
      'cycle',
      'phaseTicksTotal',
      'phaseTicksLeft',
      'reservedSlot',
      'targetUnitId',
      'dualUnitId',
      'busyTicks',
      'idleTicks',
      'blockedTicks',
      'waitForVehicleTicks',
      'vehicleWaitTicks',
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
    // ADR-033: rezervovaný slot smie mať len stav cyklu, ktorý ho drží (nakládka ho nemá; mimo cyklu nikdy).
    ['nakládka s rezerváciou', { ...VALID, cycle: 'load', targetUnitId: 5 }, '/reservedSlot'],
    ['dual_load v grabbing s rezerváciou', { ...VALID, cycle: 'dual_load', state: 'grabbing', targetUnitId: 5 }, '/reservedSlot'],
    ['dual_unload bez dualUnitId', { ...VALID, cycle: 'dual_unload' }, '/dualUnitId'],
    ['dualUnitId mimo dual_unload', { ...VALID, dualUnitId: 9 }, '/dualUnitId'],
    ['dualUnitId 0', { ...VALID, cycle: 'dual_unload', dualUnitId: 0 }, '/dualUnitId'],
    ['záporné waitForVehicleTicks', { ...VALID, waitForVehicleTicks: -1 }, '/waitForVehicleTicks'],
    ['zlomkové vehicleWaitTicks', { ...VALID, vehicleWaitTicks: 0.5 }, '/vehicleWaitTicks'],
    ['idle s rezerváciou', { ...VALID, state: 'idle' }, '/reservedSlot'],
    ['blocked s rezerváciou', { ...VALID, state: 'blocked' }, '/reservedSlot'],
    ['záporný slot', { ...VALID, reservedSlot: -1 }, '/reservedSlot'],
    ['zlomková hodina', { ...VALID, lastBlockedHour: 0.5 }, '/lastBlockedHour'],
    // T02-14: fáza musí sedieť so stavom (fail-fast pri deserialize, nie až v tick()).
    ['idle s bežiacou fázou', { ...VALID, state: 'idle', reservedSlot: null, phaseTicksLeft: 2 }, '/phaseTicksLeft'],
    ['blocked s bežiacou fázou', { ...VALID, state: 'blocked', reservedSlot: null, phaseTicksLeft: 1 }, '/phaseTicksLeft'],
    ['idle so skončenou fázou, ale phaseTicksTotal > 0', { ...VALID, state: 'idle', reservedSlot: null, phaseTicksLeft: 0 }, '/phaseTicksTotal'],
    ['grabbing so skončenou fázou (phaseTicksLeft 0)', { ...VALID, state: 'grabbing', phaseTicksLeft: 0 }, '/phaseTicksLeft'],
    ['placing so skončenou fázou (phaseTicksLeft 0)', { ...VALID, phaseTicksLeft: 0 }, '/phaseTicksLeft'],
    ['placing bez fázy (0/0)', { ...VALID, phaseTicksTotal: 0, phaseTicksLeft: 0 }, '/phaseTicksLeft'],
    ['swinging sa neukladá (okamžitý stav)', { ...VALID, state: 'swinging' }, '/state'],
    ['swinging sa neukladá ani s nekonzistentnými poliami', { ...VALID, state: 'swinging', reservedSlot: null, phaseTicksLeft: 0 }, '/state'],
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

  it('rezervácia podľa smeru cyklu (ADR-033): dual_load drží slot od swinging, dual_unload od grabbing, placing bez slotu (under_hook) prejde', () => {
    const ok: readonly Partial<CraneRuntimeState>[] = [
      { state: 'placing', reservedSlot: null },
      { cycle: 'load', state: 'grabbing', reservedSlot: null, targetUnitId: 5 },
      { cycle: 'dual_load', state: 'grabbing', reservedSlot: null, targetUnitId: 5 },
      { cycle: 'dual_load', state: 'placing', reservedSlot: 3, targetUnitId: 5 },
      { cycle: 'dual_unload', state: 'grabbing', reservedSlot: 3, dualUnitId: 8 },
    ];
    for (const patch of ok) {
      const crane = freshCrane();
      crane.restoreRuntimeState({ ...VALID, ...patch });
      expect(crane.getRuntimeState()).toEqual({ ...VALID, ...patch });
    }
  });

  it('craneReservesApronSlot: tabuľka CRANE_CYCLE_TRAITS.reservesFrom', () => {
    expect(CRANE_CYCLE_TRAITS.unload.reservesFrom).toBe('grabbing');
    expect(CRANE_CYCLE_TRAITS.load.reservesFrom).toBeNull();
    expect(CRANE_CYCLE_TRAITS.dual_load.reservesFrom).toBe('swinging');
    expect(CRANE_CYCLE_TRAITS.dual_unload.reservesFrom).toBe('grabbing');
    for (const state of ['idle', 'blocked'] as const) for (const cycle of CRANE_CYCLES) expect(craneReservesApronSlot(cycle, state), `${cycle}/${state}`).toBe(false);
    expect(craneReservesApronSlot('unload', 'grabbing')).toBe(true);
    expect(craneReservesApronSlot('load', 'placing')).toBe(false);
    expect(craneReservesApronSlot('dual_load', 'grabbing')).toBe(false);
    expect(craneReservesApronSlot('dual_load', 'placing')).toBe(true);
  });

  it('konzistentné fázy prejdú: idle/blocked 0/0, grabbing/placing 1 ≤ left ≤ total (T02-14)', () => {
    const ok: readonly Partial<CraneRuntimeState>[] = [
      { state: 'idle', reservedSlot: null, phaseTicksTotal: 0, phaseTicksLeft: 0 },
      { state: 'blocked', reservedSlot: null, phaseTicksTotal: 0, phaseTicksLeft: 0 },
      { state: 'grabbing', phaseTicksTotal: 6, phaseTicksLeft: 6 },
      { state: 'grabbing', phaseTicksTotal: 6, phaseTicksLeft: 1 },
      { state: 'placing', phaseTicksTotal: 1, phaseTicksLeft: 1 },
    ];
    for (const patch of ok) {
      const crane = freshCrane();
      crane.restoreRuntimeState({ ...VALID, ...patch });
      expect(crane.getRuntimeState()).toEqual({ ...VALID, ...patch });
    }
  });

  it('cranePhaseProblem: tabuľka podľa CRANE_STATE_TRAITS.phase', () => {
    expect(cranePhaseProblem('idle', 0, 0)).toBeUndefined();
    expect(cranePhaseProblem('blocked', 3, 0)?.path).toBe('/phaseTicksTotal');
    expect(cranePhaseProblem('grabbing', 6, 0)?.path).toBe('/phaseTicksLeft');
    expect(cranePhaseProblem('placing', 6, 6)).toBeUndefined();
    expect(cranePhaseProblem('swinging', 6, 3)?.path).toBe('/state');
  });

  it('runtime, ktorý nie je objekt → ModuleStateError na koreni', () => {
    for (const raw of [null, 3, 'idle', []]) {
      expect(() => freshCrane().restoreRuntimeState(raw)).toThrow(ModuleStateError);
    }
  });
});

/** ADR-016: presne tieto prechody FSM žeriavu. */
const EXPECTED_TRANSITIONS: readonly (readonly [CraneState, CraneState])[] = [
  ['idle', 'grabbing'],
  ['idle', 'blocked'],
  ['grabbing', 'swinging'],
  ['swinging', 'placing'],
  ['placing', 'idle'],
  ['blocked', 'idle'],
  ['blocked', 'grabbing'],
];

describe('FSM žeriavu — CRANE_TRANSITIONS a CraneModule.transition (T02-05)', () => {
  it('tabuľka obsahuje každý stav a presne prechody §7.2 / ADR-016', () => {
    expect([...CRANE_TRANSITIONS.keys()].sort()).toEqual([...CRANE_STATES].sort());
    const listed = [...CRANE_TRANSITIONS].flatMap(([from, targets]) => targets.map((to) => [from, to] as const));
    expect(listed).toEqual(EXPECTED_TRANSITIONS);
    for (const from of CRANE_STATES) {
      for (const to of CRANE_STATES) {
        expect(isCraneTransitionAllowed(from, to), `${from} → ${to}`).toBe(EXPECTED_TRANSITIONS.some(([a, b]) => a === from && b === to));
      }
    }
  });

  it('povolený prechod zmení stav; celý cyklus idle → grabbing → swinging → placing → idle → blocked → idle', () => {
    const crane = freshCrane();
    for (const to of ['grabbing', 'swinging', 'placing', 'idle', 'blocked', 'idle'] as const) {
      crane.transition(to);
      expect(crane.state).toBe(to);
    }
  });

  it('state je len getter (T02-14): priamy zápis zlyhá, stav mení len transition a restoreRuntimeState', () => {
    const crane = freshCrane();
    const descriptor = Object.getOwnPropertyDescriptor(CraneModule.prototype, 'state');
    expect(descriptor?.get).toBeTypeOf('function');
    expect(descriptor?.set).toBeUndefined();
    expect(Object.keys(crane)).not.toContain('state');
    expect(() => {
      (crane as unknown as { state: CraneState }).state = 'blocked';
    }).toThrow(TypeError);
    expect(crane.state).toBe('idle');
    crane.transition('blocked');
    expect(crane.state).toBe('blocked');
    crane.restoreRuntimeState({ ...VALID, state: 'idle', reservedSlot: null, phaseTicksTotal: 0, phaseTicksLeft: 0 });
    expect(crane.state).toBe('idle');
  });

  it('nepovolený prechod → ModuleError(invalid_transition), stav sa nezmení', () => {
    const crane = freshCrane();
    let error: unknown;
    try {
      crane.transition('placing');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModuleError);
    expect((error as ModuleError).code).toBe('invalid_transition');
    expect((error as ModuleError).message).toContain('idle → placing');
    expect(crane.state).toBe('idle');
  });

  it('enterPhase nastaví trvanie fázy, phaseProgress = 1 − left/total (mimo fázy 0); neplatné trvanie → ModuleError', () => {
    const crane = freshCrane();
    expect(crane.phaseProgress).toBe(0);
    crane.enterPhase(6);
    expect([crane.phaseTicksTotal, crane.phaseTicksLeft, crane.phaseProgress]).toEqual([6, 6, 0]);
    crane.phaseTicksLeft = 3;
    expect(crane.phaseProgress).toBe(0.5);
    crane.enterPhase(0);
    expect([crane.phaseTicksTotal, crane.phaseTicksLeft, crane.phaseProgress]).toEqual([0, 0, 0]);
    expect(() => crane.enterPhase(-1)).toThrow(ModuleError);
    expect(() => crane.enterPhase(1.5)).toThrow(ModuleError);
  });
});
