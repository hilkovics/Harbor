// RTG čakajúci na ťahač (TR3-06b, ADR-040 dodatok): stroj so zdvihnutým kontajnerom nad TP nečaká večne — po `rtg.handoverGiveUpTicks` vráti jednotku do stohu
// (`in_handler → in_storage` cez ledger) a cyklus uvoľní; zrušený job uprostred predzásobenia cyklus vzdá bez `MachineError`.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { cancelJob } from '@sim/logistics/job-cancel';
import type { TransportJob } from '@sim/logistics/transport-job';
import { loadMap, parseMapDef } from '@sim/grid';
import { RtgCrane } from '@sim/machines';
import { YardMachineSystem } from '@sim/systems/yard-machine-system';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { lost, offerTranship, runUntil } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const ECONOMY = { startingCashCents: 400_000_000, transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };
const GIVE_UP = 25;

function setup(): { readonly world: World; readonly machine: () => RtgCrane } {
  const scenario = loadScenarioFile('tt_rtg');
  const defs = hookDefs(0, { economy: ECONOMY, rtg: { handoverGiveUpTicks: GIVE_UP } });
  const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  const contract = offerTranship(world, { units: 40 });
  send(world, acceptCommand(contract.id));
  return { world, machine: () => [...world.machines.values()][0] as RtgCrane };
}

/** Predzásobenie `take`: ťahač ide k TP (`to_pickup`), stroj sa chystá zdvihnúť kontajner zo stohu. */
function prefetchingTake(world: World, machine: RtgCrane): boolean {
  const cycle = machine.cycle;
  if (cycle?.kind !== 'take' || cycle.vehicleId === null || (machine.state !== 'travel' && machine.state !== 'lift')) return false;
  return world.vehicles.get(cycle.vehicleId as EntityId)?.state === 'to_pickup';
}

/** Podmienka „stroj drží kontajner nad TP, ktorý ťahač nikdy neobslúži“: po zdvihu v čakaní (`shift`), jednotka v `in_handler`. */
function holdingUnit(world: World, machine: RtgCrane): boolean {
  return machine.cycle?.kind === 'take' && machine.state === 'shift' && world.cargo.countAt('in_handler', machine.id) === 1;
}

/** Predzásobenie `take` a nezhoda bunky pruhu (stroj čaká na inom TP, než kam ťahač príde); vráti jednotku cyklu. */
function startMismatchedHold(world: World, machine: () => RtgCrane): EntityId {
  runUntil(world, (w) => prefetchingTake(w, machine()), 60_000, 'predzásobenie nakládky');
  const cycle = machine().cycle;
  if (cycle === null) throw new Error('cyklus očakávaný');
  machine().replaceCycle({ ...cycle, tpBay: cycle.tpBay + 1 < 12 ? cycle.tpBay + 1 : cycle.tpBay - 1 });
  return cycle.unitId as EntityId;
}

describe('RTG: čakanie na ťahač je ohraničené', () => {
  it('nezhoda bunky pruhu: po handoverGiveUpTicks sa kontajner vráti do stohu, stroj uvoľní cyklus a beh sa dokončí bez straty', () => {
    const { world, machine } = setup();
    const unitId = startMismatchedHold(world, machine);
    const moves = machine().moves;
    const events = runUntil(world, (w) => w.cargo.get(unitId)?.location.kind === 'in_storage' && w.cargo.get(unitId)?.location.kind !== undefined && machine().cycle?.unitId !== unitId, 200, 'návrat kontajnera do stohu');
    const chain = events.filter(({ event }) => event.type === 'CargoMoved' && event.unitId === unitId).map(({ event }) => (event.type === 'CargoMoved' ? `${event.from.kind}→${event.to.kind}` : ''));
    expect(chain).toEqual(['in_storage→in_handler', 'in_handler→in_storage']);
    expect(machine().moves).toBe(moves);
    expect(findWorldViolation(world)).toBeUndefined();
    assertCargoConservation(world);
    // Po vzdaní ostal job aj ťahač: stroj kontajner zdvihne znova a prekládka sa dokončí.
    runUntil(world, (w) => w.contractBook.contracts.size > 0 && w.ships.size === 0 && [...w.contractBook.contracts.values()].every((c) => c.state === 'completed' || c.state === 'failed'), 120_000, 'uzavretie prekládky');
    expect(lost(world)).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  }, 120_000);

  it('job zrušený uprostred predzásobenia: cyklus sa vzdá (nie MachineError), kontajner je späť v stohu a stroj je idle', () => {
    const { world, machine } = setup();
    const unitId = startMismatchedHold(world, machine);
    runUntil(world, (w) => holdingUnit(w, machine()), GIVE_UP, 'RTG drží kontajner nad TP');
    const cycle = machine().cycle;
    if (cycle === null) throw new Error('cyklus očakávaný');
    const vehicle = world.vehicles.get(cycle.vehicleId as EntityId);
    if (vehicle === undefined || cycle.jobId === null) throw new Error('vozidlo a job očakávané');
    cancelJob(world, world.jobs.get(cycle.jobId as EntityId) as TransportJob, 'rehandle_stalled');
    vehicle.jobId = null;
    expect(() => new YardMachineSystem().tick(world)).not.toThrow();
    expect(machine().state).toBe('idle');
    expect(machine().cycle).toBeNull();
    expect(world.cargo.get(unitId)?.location.kind).toBe('in_storage');
    expect(world.cargo.countAt('in_handler', machine().id)).toBe(0);
  }, 120_000);
});
