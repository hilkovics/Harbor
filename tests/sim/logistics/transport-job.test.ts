// TransportJob (T03-05, T04-03; ARCHITECTURE §7.3; ADR-018, ADR-023): stavy, tabuľka prechodov a vlastnosti stavov
// (vrátane zrušenia open → cancelled), JOB_ROUTES s prioritou (inbound pred outbound), fail-fast konštruktor,
// assign/transition bez skrytých prechodov a save záznam.
import { describe, expect, it } from 'vitest';
import type { CargoLocation } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import {
  JOB_CANCEL_REASONS,
  JOB_PRIORITY_LEVELS,
  JOB_ROUTES,
  JOB_STATES,
  JOB_STATE_TRAITS,
  JOB_TRANSITIONS,
  JobError,
  SERIALIZED_JOB_KEYS,
  TransportJob,
  isJobRoute,
  isJobState,
  isJobTransitionAllowed,
  jobRouteOf,
  type JobState,
  type TransportJobInit,
} from '@sim/logistics';

const id = (value: number): EntityId => value as EntityId;
const FROM: CargoLocation = { kind: 'on_apron', berthId: id(1), slot: 2 };
const TO: CargoLocation = { kind: 'in_storage', moduleId: id(4), slot: 7 };
const BASE: TransportJobInit = { id: id(20), unitIds: [id(11)], from: FROM, to: TO, createdTick: 5 };
const RAMP_TO: CargoLocation = { kind: 'at_ramp', rampId: id(8), dock: 1 };
const OUTBOUND: TransportJobInit = { id: id(21), unitIds: [id(12)], from: TO, to: RAMP_TO, createdTick: 6 };

function jobError(action: () => unknown): JobError {
  try {
    action();
  } catch (error) {
    if (error instanceof JobError) return error;
    throw error;
  }
  throw new Error('očakávaná JobError');
}

describe('stavy jobu a tabuľky', () => {
  it('JOB_STATES v poradí životného cyklu; prechody dopredu po jednom až po done, zrušiť sa dá len open; done a cancelled sú konečné', () => {
    expect(JOB_STATES).toEqual(['open', 'assigned', 'picking', 'moving', 'dropping', 'done', 'cancelled']);
    expect([...JOB_TRANSITIONS.entries()]).toEqual([
      ['open', ['assigned', 'cancelled']],
      ['assigned', ['picking']],
      ['picking', ['moving']],
      ['moving', ['dropping']],
      ['dropping', ['done']],
      ['done', []],
      ['cancelled', []],
    ]);
    const lifecycle: readonly JobState[] = ['open', 'assigned', 'picking', 'moving', 'dropping', 'done'];
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        const forward = lifecycle.includes(from) && lifecycle.includes(to) && lifecycle.indexOf(to) === lifecycle.indexOf(from) + 1;
        expect(isJobTransitionAllowed(from, to), `${from} → ${to}`).toBe(forward || (from === 'open' && to === 'cancelled'));
      }
    }
  });

  it('JOB_STATE_TRAITS: vozidlo od assigned, náklad na zdroji do picking, vo vozidle moving/dropping, done a cancelled neaktívne', () => {
    expect(Object.keys(JOB_STATE_TRAITS)).toEqual([...JOB_STATES]);
    expect(JOB_STATES.map((state) => [JOB_STATE_TRAITS[state].hasVehicle, JOB_STATE_TRAITS[state].cargoAt, JOB_STATE_TRAITS[state].active])).toEqual([
      [false, 'source', true],
      [true, 'source', true],
      [true, 'source', true],
      [true, 'vehicle', true],
      [true, 'vehicle', true],
      [true, 'target', false],
      [false, 'source', false],
    ]);
    expect(Object.isFrozen(JOB_STATE_TRAITS)).toBe(true);
  });

  it('JOB_ROUTES: inbound apron / hák → sklad a nakládka pod hákom (priorita 0) pred outbound, prijatím exportu a nakládkou na apron (priorita 1); isJobState; dôvody zrušenia', () => {
    expect(JOB_ROUTES).toEqual([
      { from: 'on_apron', to: 'in_storage', priority: 0 },
      { from: 'in_storage', to: 'at_ramp', priority: 1 },
      { from: 'at_ramp', to: 'in_storage', priority: 1 },
      { from: 'in_storage', to: 'on_apron', priority: 1 },
      { from: 'in_crane', to: 'in_storage', priority: 0 },
      { from: 'in_storage', to: 'in_crane', priority: 0 },
    ]);
    expect(JOB_PRIORITY_LEVELS).toBe(2);
    expect(isJobRoute('on_apron', 'in_storage')).toBe(true);
    expect(isJobRoute('in_storage', 'at_ramp')).toBe(true);
    expect(isJobRoute('at_ramp', 'in_storage')).toBe(true);
    expect(jobRouteOf('at_ramp', 'in_storage')?.priority).toBe(1);
    expect(isJobRoute('in_storage', 'on_apron')).toBe(true);
    expect(isJobRoute('in_crane', 'in_storage')).toBe(true);
    expect(isJobRoute('in_storage', 'in_crane')).toBe(true);
    expect(isJobRoute('on_apron', 'at_ramp')).toBe(false);
    expect(isJobRoute('in_crane', 'on_apron')).toBe(false);
    expect(jobRouteOf('in_storage', 'at_ramp')?.priority).toBe(1);
    expect(jobRouteOf('at_ramp', 'in_truck')).toBeUndefined();
    for (const state of JOB_STATES) expect(isJobState(state)).toBe(true);
    for (const value of ['closed', '', null, 1]) expect(isJobState(value)).toBe(false);
    expect(JOB_CANCEL_REASONS).toEqual(['ramp_inoperative', 'ramp_unreachable', 'loading_stopped']);
  });
});

const HOOK: CargoLocation = { kind: 'in_crane', craneId: id(2) };

describe('TransportJob — hák žeriava a nakládka (F6a, ADR-033)', () => {
  it('vykládka pod hákom: zdroj in_crane, vozidlo jazdí ku kotvisku žeriava (fromModuleId), priorita 0', () => {
    const job = new TransportJob({ id: id(30), unitIds: [id(11)], from: HOOK, fromModuleId: id(1), to: TO, createdTick: 1 });
    expect([job.from, job.fromModuleId, job.toModuleId, job.priority]).toEqual([HOOK, 1, 4, 0]);
    expect(job.toState()).toEqual({ id: 30, unitIds: [11], from: HOOK, to: TO, createdTick: 1 });
  });

  it('nakládka pod hákom: cieľ in_crane (toModuleId = kotvisko), priorita 0; nakládka na apron: slot apronu, priorita 1', () => {
    const hook = new TransportJob({ id: id(31), unitIds: [id(11)], from: TO, to: HOOK, toModuleId: id(1), createdTick: 1 });
    expect([hook.toModuleId, hook.priority, hook.fromModuleId]).toEqual([1, 0, 4]);
    const apron = new TransportJob({ id: id(32), unitIds: [id(11)], from: TO, to: FROM, createdTick: 1 });
    expect([apron.toModuleId, apron.priority]).toEqual([1, 1]);
  });

  it('rebindSource: job zo háku sa presmeruje na slot apronu toho istého kotviska (buffer), len open/assigned', () => {
    const job = new TransportJob({ id: id(33), unitIds: [id(11)], from: HOOK, fromModuleId: id(1), to: TO, createdTick: 1 });
    job.rebindSource(FROM);
    expect(job.from).toEqual(FROM);
    expect(job.toState().from).toEqual(FROM);
    expect(jobError(() => job.rebindSource(FROM)).code).toBe('invalid_transition');
    const other = new TransportJob({ id: id(34), unitIds: [id(11)], from: HOOK, fromModuleId: id(1), to: TO, createdTick: 1 });
    expect(jobError(() => other.rebindSource({ kind: 'on_apron', berthId: id(9), slot: 0 })).code).toBe('invalid_input');
    expect(jobError(() => other.rebindSource({ kind: 'in_storage', moduleId: id(4), slot: 1 })).code).toBe('invalid_input');
    other.assign(id(7));
    other.transition('picking');
    expect(jobError(() => other.rebindSource(FROM)).code).toBe('invalid_transition');
    const plain = new TransportJob(BASE);
    expect(jobError(() => plain.rebindSource(FROM)).code).toBe('invalid_transition');
  });

  it('rebindTarget (T6D-05b): job nakládky pod hákom v moving sa presmeruje na slot apronu toho istého kotviska; inak JobError a job sa nezmení', () => {
    const load = (jobId: number): TransportJob => new TransportJob({ id: id(jobId), unitIds: [id(11)], from: TO, to: HOOK, toModuleId: id(1), createdTick: 1 });
    const job = load(40);
    expect(jobError(() => job.rebindTarget(FROM)).code).toBe('invalid_transition'); // open
    job.assign(id(7));
    job.transition('picking');
    expect(jobError(() => job.rebindTarget(FROM)).code).toBe('invalid_transition'); // picking: vozidlo ešte nemá jednotku
    job.transition('moving');
    expect(jobError(() => job.rebindTarget({ kind: 'on_apron', berthId: id(9), slot: 0 })).code).toBe('invalid_input'); // iný apron
    expect(jobError(() => job.rebindTarget({ kind: 'in_storage', moduleId: id(1), slot: 0 })).code).toBe('invalid_input'); // nie apron
    expect(job.to).toEqual(HOOK);
    job.rebindTarget(FROM);
    expect([job.to, job.toModuleId, job.state]).toEqual([FROM, 1, 'moving']);
    expect(job.toState().to).toEqual(FROM);
    expect(jobError(() => job.rebindTarget(FROM)).code).toBe('invalid_transition'); // cieľ už nie je hák
    const plain = new TransportJob(OUTBOUND);
    plain.assign(id(7));
    plain.transition('picking');
    plain.transition('moving');
    expect(jobError(() => plain.rebindTarget(FROM)).code).toBe('invalid_transition');
  });
});

describe('TransportJob', () => {
  it('polia zo vstupu, držitelia from/to, predvolene open bez vozidla, jednotky zmrazené, label', () => {
    const job = new TransportJob(BASE);
    expect([job.id, job.unitIds, job.from, job.to, job.fromModuleId, job.toModuleId, job.createdTick]).toEqual([20, [11], FROM, TO, 1, 4, 5]);
    expect([job.state, job.vehicleId, job.label]).toEqual(['open', null, 'job #20']);
    expect(Object.isFrozen(job.unitIds)).toBe(true);
    expect(Object.isFrozen(job.from)).toBe(true);
  });

  it('outbound sklad → dock rampy: držitelia sklad a rampa, priorita 1 (inbound 0); job na dock nie je obmedzený jedinečným slotom', () => {
    const job = new TransportJob(OUTBOUND);
    expect([job.fromModuleId, job.toModuleId, job.priority, job.to]).toEqual([4, 8, 1, RAMP_TO]);
    expect(new TransportJob(BASE).priority).toBe(0);
    expect(new TransportJob({ ...OUTBOUND, unitIds: [id(12), id(13)] }).unitIds).toEqual([12, 13]);
  });

  it('zrušenie: open → cancelled bez vozidla (neaktívny); po priradení vozidla sa job zrušiť nedá', () => {
    const job = new TransportJob(OUTBOUND);
    job.transition('cancelled');
    expect([job.state, job.vehicleId, JOB_STATE_TRAITS[job.state].active]).toEqual(['cancelled', null, false]);
    expect(jobError(() => job.assign(id(7))).code).toBe('invalid_transition');
    const assigned = new TransportJob(OUTBOUND);
    assigned.assign(id(7));
    expect(jobError(() => assigned.transition('cancelled')).code).toBe('invalid_transition');
    expect(assigned.state).toBe('assigned');
  });

  it('assign: open → assigned s vozidlom; transition ďalej po tabuľke až po done', () => {
    const job = new TransportJob(BASE);
    job.assign(id(7));
    expect([job.state, job.vehicleId]).toEqual(['assigned', 7]);
    for (const state of ['picking', 'moving', 'dropping', 'done'] as const) {
      job.transition(state);
      expect(job.state).toBe(state);
    }
    expect(job.vehicleId).toBe(7);
  });

  it('assign mimo open, transition → assigned, preskočenie alebo návrat → invalid_transition; job sa nezmení', () => {
    const job = new TransportJob(BASE);
    expect(jobError(() => job.transition('assigned')).code).toBe('invalid_transition');
    expect(jobError(() => job.transition('picking')).code).toBe('invalid_transition');
    job.assign(id(7));
    expect(jobError(() => job.assign(id(8))).code).toBe('invalid_transition');
    expect(jobError(() => job.transition('open')).code).toBe('invalid_transition');
    expect(jobError(() => job.transition('moving')).code).toBe('invalid_transition');
    expect([job.state, job.vehicleId]).toEqual(['assigned', 7]);
    expect(jobError(() => new TransportJob(BASE).assign(id(0))).code).toBe('invalid_input');
  });

  it('obnova v stave s vozidlom (save): stav a vozidlo zo vstupu', () => {
    const job = new TransportJob({ ...BASE, state: 'moving', vehicleId: id(9) });
    expect([job.state, job.vehicleId]).toEqual(['moving', 9]);
  });

  const INVALID: readonly [string, Partial<TransportJobInit>][] = [
    ['id 0', { id: id(0) }],
    ['prázdne unitIds', { unitIds: [] }],
    ['id jednotky 0', { unitIds: [id(0)] }],
    ['duplicitná jednotka', { unitIds: [id(11), id(11)] }],
    ['viac jednotiek do jedinečného slotu', { unitIds: [id(11), id(12)] }],
    ['from nie je lokácia', { from: { kind: 'on_apron', berthId: id(1) } as unknown as CargoLocation }],
    ['to bez držiteľa (exported)', { to: { kind: 'exported' } }],
    ['nepovolená dvojica (apron → rampa)', { from: FROM, to: RAMP_TO }],
    ['hák žeriava bez modulu (in_crane vyžaduje fromModuleId)', { from: { kind: 'in_crane', craneId: id(2) } }],
    ['fromModuleId, ktorý nie je držiteľom zdroja', { fromModuleId: id(9) }],
    ['fromModuleId 0', { fromModuleId: id(0) }],
    ['záporný createdTick', { createdTick: -1 }],
    ['necelý createdTick', { createdTick: 1.5 }],
    ['neznámy stav', { state: 'closed' as JobState }],
    ['open s vozidlom', { vehicleId: id(7) }],
    ['assigned bez vozidla', { state: 'assigned' }],
    ['vehicleId 0', { state: 'assigned', vehicleId: id(0) }],
  ];
  it.each(INVALID)('%s → JobError(invalid_input)', (_name, overrides) => {
    expect(jobError(() => new TransportJob({ ...BASE, ...overrides })).code).toBe('invalid_input');
  });

  it('toState: čistý JSON s kľúčmi SERIALIZED_JOB_KEYS (bez stavu a vozidla — odvodia sa), nová kópia pri každom volaní', () => {
    const job = new TransportJob({ ...BASE, state: 'picking', vehicleId: id(9) });
    const state = job.toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_JOB_KEYS]);
    expect(state).toEqual({ id: 20, unitIds: [11], from: FROM, to: TO, createdTick: 5 });
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    expect(job.toState()).not.toBe(state);
    expect(job.toState().unitIds).not.toBe(job.unitIds);
  });
});
