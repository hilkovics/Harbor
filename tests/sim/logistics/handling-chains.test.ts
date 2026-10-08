// Reťaze nôh STS → TT → RTG a opačne (TR3-01, ADR-040 bod 4): tabuľka HANDLING_CHAINS podľa systému bloku (nie switch), určenie reťaze jobu a kto smie job vykonať.
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { HANDLING_CHAINS, chainKindOf, chainOfJob, jobNeedsMachine, vehicleMayServe, yardMachineOfJob } from '@sim/logistics/handling-chains';
import { TransportJob } from '@sim/logistics/transport-job';
import { loadMap, parseMapDef } from '@sim/grid';
import { ContainerYard, RtgBlock } from '@sim/modules';
import { World } from '@sim/world';
import { hookDefs } from '../helpers/f6a';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const id = (value: number): EntityId => value as EntityId;
const TRACTOR = { def: BUNDLED_DEFS.vehicles.get('terminal_tractor') };
const STRADDLE = { def: BUNDLED_DEFS.vehicles.get('straddle_carrier') };

/** Svet `tt_rtg` (RTG blok + 2 STS) s dvorom straddle na (42, 18); dosť hotovosti na všetko. */
function build(): World {
  const scenario = loadScenarioFile('tt_rtg');
  const w = World.create(hookDefs(0, { economy: { startingCashCents: 5_000_000_000 } }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
  runScenario(w, scenario, 1);
  w.enqueue(commandFromJSON({ type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 }));
  w.applyPending();
  return w;
}

describe('HANDLING_CHAINS', () => {
  it('straddle: vozidlo zdvihne a uloží samo; rtg: ťahač nezdvihne nič, odkladá stroj bloku', () => {
    const actors = (system: 'straddle' | 'rtg', kind: 'discharge' | 'load'): string[] => HANDLING_CHAINS[system][kind].map((leg) => `${leg.role}:${leg.actor}`);
    expect(actors('straddle', 'discharge')).toEqual(['quay:crane', 'yard:vehicle']);
    expect(actors('straddle', 'load')).toEqual(['yard:vehicle', 'quay:crane']);
    expect(actors('rtg', 'discharge')).toEqual(['quay:crane', 'carrier:vehicle', 'yard:machine']);
    expect(actors('rtg', 'load')).toEqual(['yard:machine', 'carrier:vehicle', 'quay:crane']);
  });

  it('nohy nadväzujú: koniec jednej je začiatok ďalšej a reťaz vykládky končí v sklade, nakládky v žeriave', () => {
    for (const system of ['straddle', 'rtg'] as const) {
      for (const kind of ['discharge', 'load'] as const) {
        const legs = HANDLING_CHAINS[system][kind];
        for (let i = 1; i < legs.length; i++) expect(legs[i].from, `${system} ${kind} noha ${String(i)}`).toBe(legs[i - 1].to);
        expect(legs.at(-1)?.to).toBe(kind === 'discharge' ? 'in_storage' : 'in_crane');
        expect(legs[0].from).toBe(kind === 'discharge' ? 'in_crane' : 'in_storage');
      }
    }
    expect(Object.isFrozen(HANDLING_CHAINS.rtg.discharge)).toBe(true);
  });
});

describe('chainKindOf / chainOfJob / vehicleMayServe', () => {
  const w = build();
  const rtg = [...w.modules.values()].find((module): module is RtgBlock => module instanceof RtgBlock) as RtgBlock;
  const yard = [...w.modules.values()].find((module): module is ContainerYard => module instanceof ContainerYard) as ContainerYard;
  const berth = id(1);
  const crane = [...w.modules.values()].find((module) => module.kind === 'crane')?.id as EntityId;

  const job = (from: 'hook' | 'storage' | 'ramp', to: 'hook' | 'storage', block: RtgBlock | ContainerYard): TransportJob => {
    const location = (end: 'hook' | 'storage' | 'ramp', slot: number) =>
      end === 'hook' ? ({ kind: 'in_crane', craneId: crane } as const) : end === 'storage' ? ({ kind: 'in_storage', moduleId: block.id, slot } as const) : ({ kind: 'at_ramp', rampId: id(90), dock: 0 } as const);
    return new TransportJob({
      id: id(500),
      unitIds: [id(501)],
      from: location(from, 0),
      to: location(to, 1),
      fromModuleId: from === 'hook' ? berth : from === 'storage' ? block.id : id(90),
      toModuleId: to === 'hook' ? berth : block.id,
      createdTick: 0,
    });
  };

  it('vykládka je in_crane → in_storage, nakládka in_storage → in_crane; job bez háku nemá reťaz', () => {
    expect(chainKindOf(job('hook', 'storage', rtg))).toBe('discharge');
    expect(chainKindOf(job('storage', 'hook', rtg))).toBe('load');
    expect(chainKindOf(job('ramp', 'storage', rtg))).toBeUndefined();
    expect(chainOfJob(w, job('ramp', 'storage', rtg))).toBeUndefined();
  });

  it('reťaz podľa systému bloku: RTG blok → rtg, dvor straddle → straddle', () => {
    expect(chainOfJob(w, job('hook', 'storage', rtg))).toBe(HANDLING_CHAINS.rtg.discharge);
    expect(chainOfJob(w, job('storage', 'hook', rtg))).toBe(HANDLING_CHAINS.rtg.load);
    expect(chainOfJob(w, job('hook', 'storage', yard))).toBe(HANDLING_CHAINS.straddle.discharge);
    expect(rtg.handlingSystem).toBe('rtg');
    expect(yard.handlingSystem).toBe('straddle');
  });

  it('stroj jobu: RTG blok má stroj, dvor straddle nie; job do RTG bloku stroj potrebuje, do dvora nie', () => {
    expect(yardMachineOfJob(w, job('hook', 'storage', rtg))).toBe(w.machineOfBlock(rtg.id));
    expect(yardMachineOfJob(w, job('hook', 'storage', yard))).toBeUndefined();
    expect(jobNeedsMachine(w, job('storage', 'hook', rtg))).toBe(true);
    expect(jobNeedsMachine(w, job('storage', 'hook', yard))).toBe(false);
  });

  it.each([
    ['vykládka do RTG bloku', 'hook', 'storage', 'rtg', true, false],
    ['nakládka z RTG bloku', 'storage', 'hook', 'rtg', true, false],
    ['vykládka do dvora straddle', 'hook', 'storage', 'yard', false, true],
    ['nakládka zo dvora straddle', 'storage', 'hook', 'yard', false, true],
    ['sklad z rampy (bez háku)', 'ramp', 'storage', 'rtg', false, true],
  ] as const)('%s: ťahač %s, straddle %s', (_name, from, to, which, tractor, straddle) => {
    const target = job(from, to, which === 'rtg' ? rtg : yard);
    expect(vehicleMayServe(w, TRACTOR, target)).toBe(tractor);
    expect(vehicleMayServe(w, STRADDLE, target)).toBe(straddle);
  });
});

describe('TransportJob.exchangeVehicle (žeriav odovzdá jednotku ťahaču, ktorý čaká pod hákom)', () => {
  const make = (jobId: number, state: 'assigned' | 'picking', vehicleId: number): TransportJob =>
    new TransportJob({
      id: id(jobId),
      unitIds: [id(600 + jobId)],
      from: { kind: 'in_crane', craneId: id(2) },
      to: { kind: 'in_storage', moduleId: id(4), slot: jobId },
      fromModuleId: id(1),
      createdTick: 0,
      state,
      vehicleId: id(vehicleId),
    });

  it('assigned job dostane čakajúce vozidlo a stane sa picking, picking job dostane vozidlo na ceste a stane sa assigned', () => {
    const enRoute = make(10, 'assigned', 7);
    const waiting = make(11, 'picking', 8);
    enRoute.exchangeVehicle(waiting);
    expect([enRoute.state, enRoute.vehicleId]).toEqual(['picking', 8]);
    expect([waiting.state, waiting.vehicleId]).toEqual(['assigned', 7]);
  });

  it.each([
    ['obe assigned', 'assigned', 'assigned'],
    ['obe picking', 'picking', 'picking'],
    ['opačné poradie', 'picking', 'assigned'],
  ] as const)('%s: JobError a nič sa nezmení', (_name, first, second) => {
    const a = make(10, first, 7);
    const b = make(11, second, 8);
    expect(() => a.exchangeVehicle(b)).toThrow(/výmena vozidla/);
    expect([a.state, a.vehicleId, b.state, b.vehicleId]).toEqual([first, 7, second, 8]);
  });
});
