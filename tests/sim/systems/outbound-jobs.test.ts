// Outbound joby (T04-03; ARCHITECTURE §6 krok 5, §7.3 body 2–4, §7.7; rozhodnutia orchestrátora F4 č. 1 a 4; ADR-023):
// dispatcher vytvára joby sklad → staging dock prevádzkovej rampy (sklady podľa id, jednotky FIFO, najbližšia rampa,
// pri zhode menšie id), inbound má pri priradení vozidla prednosť, vozidlo vyzdvihne jednotku (recordTaken) a vyloží ju
// na dock (assertCommittable → move → commit), `open` job sa pri strate prevádzkovosti alebo dosiahnuteľnosti rampy zruší
// (JobCancelled, uvoľnenie rezervácie), job s vozidlom sa dokončí. Rezervácie dockov sa odvodia z jobov (save) a krok
// 12 ich previaže s jobmi. Rozloženie: tests/sim/logistics/outbound-fixtures.ts.
import modulesJson from '@data/defs/modules.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import { createOutboundJobs, type StoredCargoGroup } from '@sim/logistics';
import { World, WorldStateError, findWorldViolation, type WorldState } from '@sim/world';
import { NEAR_YARD_OUTSIDE, segment } from '../helpers/f3-layout';
import { unitsOnApron } from '../logistics/dispatch-fixtures';
import {
  LEGACY_NO_CONTAINER_TRUCK_DEFS,
  RAMP_ORIGIN,
  buyVehicles,
  execute,
  gateOf,
  landsideCommand,
  ofType,
  outboundWorld as buildOutboundWorld,
  rampOf,
  stagingOf,
  stockYard,
  type OutboundOptions,
} from '../logistics/outbound-fixtures';
import { DEFS, LEGACY_CAPACITY_DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';

/**
 * Celý súbor stojí na pôvodnom stagingu 2 × 2 (plný staging, poradie dockov 0, 0, 1, 1) — Fáza 5b zväčšila
 * `stagingPerDock` na 4, preto svet dostane pripnuté pôvodné kapacity (`LEGACY_NO_CONTAINER_TRUCK_DEFS`), ak test nedá vlastné defy.
 */
const outboundWorld = (options: OutboundOptions = {}): ReturnType<typeof buildOutboundWorld> =>
  buildOutboundWorld({ defs: LEGACY_NO_CONTAINER_TRUCK_DEFS, ...options });

interface Timed {
  readonly tick: number;
  readonly event: SimEvent;
}

const STRADDLE = DEFS.vehicles.get('straddle_carrier');
const INTERNAL = DEFS.logistics.defaultInternalTicks;
const REPATH = DEFS.logistics.repathIntervalTicks;

function run(world: World, ticks: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < ticks; i++) for (const event of world.tick()) log.push({ tick: world.clock.tick, event });
  return log;
}

function runUntil(world: World, done: (world: World) => boolean, limit: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < limit && !done(world); i++) run(world, 1, log);
  if (!done(world)) throw new Error(`podmienka nenastala do ${String(limit)} tickov`);
  return log;
}

const events = (log: readonly Timed[]): SimEvent[] => log.map((entry) => entry.event);

const tickOf = (log: readonly Timed[], predicate: (event: SimEvent) => boolean): number => {
  const found = log.find((entry) => predicate(entry.event));
  if (found === undefined) throw new Error('udalosť nenastala');
  return found.tick;
};

const stateChange = (vehicleId: EntityId, to: string) => (event: SimEvent): boolean =>
  event.type === 'VehicleStateChanged' && event.vehicleId === vehicleId && event.to === to;

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Druhá rampa otočená o 180° na (54, 31): konektory (56, 31) a (55, 31) `n` → prístup (56, 30) a (55, 30) — od dvora o krok ďalej. */
const FARTHER_RAMP = { type: 'PlaceModule', defId: 'loading_ramp_container', x: 54, y: 31, rotation: 180 } as const;

/**
 * Druhá rampa oproti prvej: (53, 31) rot 180, prístup (55, 30) a (54, 30) — rovnaký ako prvej rampy (zhoda vzdialenosti).
 * Spojka zo stojiska vedie namiesto (53, 31..32) okolo: (54..57, 33), (57, 30..32), (56, 30).
 */
const FACING_LAYOUT = {
  omitRoads: [
    { x: 53, y: 31 },
    { x: 53, y: 32 },
  ],
  before: [
    { type: 'PlaceRoad', cells: [...segment(54, 33, 57, 33), ...segment(57, 30, 57, 32), { x: 56, y: 30 }] },
    { type: 'PlaceModule', defId: 'loading_ramp_container', x: 53, y: 31, rotation: 180 },
  ],
} as const;

describe('vznik outbound jobov (dispatcher krok 5, §7.3 bod 2)', () => {
  it('bez brány je rampa neprevádzková: žiadny outbound job ani rezervácia; po postavení brány vzniknú joby FIFO na docky 0, 0, 1, 1', () => {
    const { world, far } = outboundWorld({ landside: ['waiting_area', 'ramp'] });
    const ramp = rampOf(world);
    const units = stockYard(world, far, 6);
    expect(ofType(events(run(world, 3)), 'JobCreated')).toEqual([]);
    expect(world.isRampOperational(ramp)).toBe(false);
    expect(stagingOf(ramp)).toEqual([
      [0, 0],
      [0, 0],
    ]);

    const placed = execute(world, landsideCommand('gate'));
    expect(ofType(placed, 'RampOperationalChanged')).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: true, reason: null }]);
    const created = ofType(world.tick(), 'JobCreated');
    expect(created.map((event) => event.unitIds)).toEqual(units.slice(0, 4).map((unit) => [unit]));
    expect(created.every((event) => event.fromModuleId === far.id && event.toModuleId === ramp.id)).toBe(true);
    const jobs = [...world.jobs.values()];
    expect(created.map((event) => event.jobId)).toEqual(jobs.map((job) => job.id));
    expect(jobs.map((job) => job.to)).toEqual([0, 0, 1, 1].map((dock) => ({ kind: 'at_ramp', rampId: ramp.id, dock })));
    expect(jobs.map((job) => job.from)).toEqual(units.slice(0, 4).map((unit) => world.cargo.get(unit)?.location));
    expect(jobs.map((job) => [job.state, job.vehicleId, job.priority])).toEqual(Array.from({ length: 4 }, () => ['open', null, 1]));
    expect(stagingOf(ramp)).toEqual([
      [0, 2],
      [0, 2],
    ]);
    expect(ramp.freeCount).toBe(0);
    expect(units.slice(4).map((unit) => world.jobOfUnit(unit))).toEqual([undefined, undefined]);
    expect(ofType(world.tick(), 'JobCreated')).toEqual([]);
  });

  it('sklady vzostupne podľa id: blízky dvor (id 4) dostane staging skôr ako ďaleký (5), hoci je od rampy ďalej', () => {
    const { world, near, far } = outboundWorld();
    const nearUnits = stockYard(world, near, 3);
    const farUnits = stockYard(world, far, 3);
    const created = ofType(world.tick(), 'JobCreated');
    expect(created.map((event) => [event.fromModuleId, event.unitIds[0]])).toEqual([...nearUnits.map((unit) => [near.id, unit]), [far.id, farUnits[0]]]);
  });

  it('najbližšia rampa podľa DistanceMatrix vyhrá nad menším id; keď je plná, dostane zvyšok ďalšia', () => {
    const { world, far } = outboundWorld({ before: [FARTHER_RAMP] });
    const farther = world.moduleAt(FARTHER_RAMP.x, FARTHER_RAMP.y);
    const nearest = rampOf(world);
    expect(farther?.id).toBeLessThan(nearest.id);
    expect([world.isRampOperational(nearest), farther !== undefined && world.isRampOperational(farther)]).toEqual([true, true]);
    stockYard(world, far, 6);
    const created = ofType(world.tick(), 'JobCreated');
    expect(created.map((event) => event.toModuleId)).toEqual([nearest.id, nearest.id, nearest.id, nearest.id, farther?.id, farther?.id]);
  });

  it('pri zhode vzdialenosti (rampy so spoločnými prístupovými bunkami) vyhrá menšie id', () => {
    const { world, far } = outboundWorld(FACING_LAYOUT);
    const facing = world.moduleAt(53, 31);
    const ramp = rampOf(world);
    expect(facing !== undefined && world.isRampOperational(facing) && world.isRampOperational(ramp)).toBe(true);
    stockYard(world, far, 9);
    const created = ofType(world.tick(), 'JobCreated');
    expect(created.map((event) => event.toModuleId)).toEqual([...Array.from({ length: 4 }, () => facing?.id), ...Array.from({ length: 4 }, () => ramp.id)]);
  });

  it('rampa zo skladu nedosiahnuteľná po ceste (prevádzková pre kamióny) job nedostane; po dostavaní cesty áno', () => {
    const gap: CellCoord = { x: 51, y: 30 };
    const { world, far } = outboundWorld({ omitRoads: [gap] });
    const ramp = rampOf(world);
    expect(world.isRampOperational(ramp)).toBe(true);
    stockYard(world, far, 2);
    expect(ofType(events(run(world, 2)), 'JobCreated')).toEqual([]);
    execute(world, { type: 'PlaceRoad', cells: [gap] });
    expect(ofType(world.tick(), 'JobCreated').map((event) => event.toModuleId)).toEqual([ramp.id, ramp.id]);
  });

  it('rampa inej kategórie nákladu (syntetická bulk rampa) outbound job pre kontajnery nedostane', () => {
    const items = modulesJson.items.map((item) => item);
    const container = items.find((item) => item.id === 'loading_ramp_container');
    if (container === undefined) throw new Error('chýba def rampy');
    const defs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      modules: { ...modulesJson, items: [...items, { ...container, id: 'ramp_bulk_test', params: { ...container.params, category: 'bulk' } }] },
    });
    const { world, far } = outboundWorld({
      defs,
      landside: ['gate', 'waiting_area'],
      after: [{ type: 'PlaceModule', defId: 'ramp_bulk_test', x: RAMP_ORIGIN.x, y: RAMP_ORIGIN.y, rotation: 0 }],
    });
    const ramp = rampOf(world);
    expect([ramp.category, world.isRampOperational(ramp)]).toEqual(['bulk', true]);
    stockYard(world, far, 2);
    expect(ofType(events(run(world, 2)), 'JobCreated')).toEqual([]);
    expect(ramp.reservedCount).toBe(0);
  });

  describe('výkon: uskladnené jednotky sa neprechádzajú bez voľného staging miesta na prevádzkovej rampe', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Od T05-04 (ADR-027) dispatcher číta uskladnené jednotky zo skupín `World.storedCargo`, nie z ledgera skladu —
    // prečítaná jednotka = jedno volanie `jobOfUnit` (má už job?). Ledger skladu sa nečíta vôbec.
    const unitReads = (world: World, action: () => void): number => {
      const jobs = vi.spyOn(world, 'jobOfUnit');
      const ledger = vi.spyOn(world.cargo, 'unitAtIndex');
      action();
      const reads = jobs.mock.calls.length;
      expect(ledger.mock.calls.filter(([kind]) => kind === 'in_storage')).toEqual([]);
      jobs.mockRestore();
      ledger.mockRestore();
      return reads;
    };

    it('plný staging: createOutboundJobs nečíta jednotky skladov ani pri 60 jednotkách; neprevádzková rampa tiež nie', () => {
      const { world, far } = outboundWorld();
      stockYard(world, far, 60);
      world.tick();
      expect(rampOf(world).freeCount).toBe(0);
      expect(unitReads(world, () => createOutboundJobs(world))).toBe(0);

      const inoperative = outboundWorld({ landside: ['waiting_area', 'ramp'] });
      stockYard(inoperative.world, inoperative.far, 60);
      expect(unitReads(inoperative.world, () => createOutboundJobs(inoperative.world))).toBe(0);
    });

    it('sklad bez vhodnej rampy sa preskočí skokom na hranicu ďalšieho skladu skupiny, bez prechodu jeho jednotiek (T05-11)', () => {
      // Blízky dvor (id 4) je bez cesty — rampa z neho nedosiahnuteľná; ďaleký (id 5) je pripojený. Obe partie sú v jednej
      // skupine (bez kontraktu), blízky dvor prvý (sklady ↑).
      const { world, near, far } = outboundWorld({ omitRoads: [NEAR_YARD_OUTSIDE] });
      const skipped = stockYard(world, near, 40);
      const served = stockYard(world, far, 2);
      const group = world.storedCargo.groupOf(null);
      if (group === undefined) throw new Error('chýba skupina bez kontraktu');
      let storageReads = 0;
      const storages = new Proxy(group.storages, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) storageReads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const counted: StoredCargoGroup = { contractId: group.contractId, units: group.units, storages };
      vi.spyOn(world.storedCargo, 'entries', 'get').mockReturnValue([counted]);
      const reads = unitReads(world, () => createOutboundJobs(world));

      expect(served.map((unit) => world.jobOfUnit(unit)?.toModuleId)).toEqual([rampOf(world).id, rampOf(world).id]);
      expect(skipped.every((unit) => world.jobOfUnit(unit) === undefined)).toBe(true);
      expect(reads).toBe(served.length);
      // Binárny skok: rádovo log2(42) čítaní pre blízky dvor + ďaleký dvor, nie 40 + 2.
      expect(storageReads).toBeLessThan(skipped.length / 2);
    });

    it('voľné miesto na rampe: prečítajú sa len jednotky s aktívnym outbound jobom a jednotka, ktorá job dostane', () => {
      const { world, far } = outboundWorld();
      stockYard(world, far, 60);
      world.tick();
      const [first] = [...world.jobs.values()];
      rampOf(world).release(first.to.kind === 'at_ramp' ? first.to.dock : -1);
      // Rezervácia uvoľnená mimo jobu (len pre meranie): voľné miesto → skupina sa prejde po prvú jednotku bez jobu.
      expect(unitReads(world, () => createOutboundJobs(world))).toBe(5);
    });
  });
});

describe('priorita: inbound pred outbound pri priradení vozidla', () => {
  it('starší outbound job čaká, voľné vozidlo dostane novší inbound job', () => {
    const { world, far, depot } = outboundWorld();
    stockYard(world, far, 2);
    world.tick();
    const outbound = [...world.jobs.values()];
    expect(outbound.map((job) => job.state)).toEqual(['open', 'open']);
    const [vehicleId] = buyVehicles(world, depot, 1);
    const [unit] = unitsOnApron(world, [0]);
    const tick = world.tick();
    const inbound = world.jobOfUnit(unit);
    expect(inbound?.priority).toBe(0);
    expect(outbound.every((job) => job.id < (inbound?.id ?? 0))).toBe(true);
    expect(ofType(tick, 'JobAssigned')).toEqual([{ type: 'JobAssigned', jobId: inbound?.id, vehicleId }]);
    expect(outbound.map((job) => job.state)).toEqual(['open', 'open']);
  });

  it('dve vozidlá v tom istom ticku: najprv sa priradí inbound, potom outbound', () => {
    const { world, far, depot } = outboundWorld();
    stockYard(world, far, 1);
    world.tick();
    buyVehicles(world, depot, 2);
    const [unit] = unitsOnApron(world, [0]);
    const assigned = ofType(world.tick(), 'JobAssigned');
    const inbound = world.jobOfUnit(unit);
    expect(assigned.map((event) => world.jobs.get(event.jobId)?.priority)).toEqual([0, 1]);
    expect(assigned[0].jobId).toBe(inbound?.id);
  });
});

describe('cyklus vozidla: sklad → dock rampy', () => {
  it('pobyt v sklade internalTicks + loadTicks, in_storage → in_vehicle + unitsOut, jazda k rampe, pobyt internalTicks + unloadTicks, in_vehicle → at_ramp + commit, JobDone', () => {
    const { world, far, depot } = outboundWorld();
    const ramp = rampOf(world);
    const [unit] = stockYard(world, far, 1);
    const [vehicleId] = buyVehicles(world, depot, 1);
    const log = run(world, 60);
    const created = ofType(events(log), 'JobCreated');
    expect(created.map((event) => [event.fromModuleId, event.toModuleId, event.unitIds])).toEqual([[far.id, ramp.id, [unit]]]);
    const arrivedPickup = tickOf(log, stateChange(vehicleId, 'loading'));
    const loaded = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'in_vehicle');
    const arrivedDrop = tickOf(log, stateChange(vehicleId, 'unloading'));
    const staged = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'at_ramp');

    expect(tickOf(log, stateChange(vehicleId, 'to_pickup'))).toBe(1);
    expect(arrivedPickup).toBe(1 + Math.ceil(3 / STRADDLE.speedCellsPerTick) - 1); // depo (47, 30) → dvor (50, 30)
    expect(loaded - arrivedPickup).toBe(INTERNAL + STRADDLE.loadTicks);
    expect(arrivedDrop - loaded).toBe(Math.ceil(4 / STRADDLE.speedCellsPerTick)); // (50, 30) → dock 0 (54, 30)
    expect(staged - arrivedDrop).toBe(INTERNAL + STRADDLE.unloadTicks); // rampa bez params.internalTicks
    expect(tickOf(log, (event) => event.type === 'JobDone')).toBe(staged);

    const moves = ofType(events(log), 'CargoMoved').filter((event) => event.unitId === unit);
    expect(moves.map((event) => [event.from.kind, event.to.kind])).toEqual([
      ['in_storage', 'in_vehicle'],
      ['in_vehicle', 'at_ramp'],
    ]);
    expect(world.cargo.get(unit)?.location).toEqual({ kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    expect([far.storedCount, far.unitsOut, far.reservedCount]).toEqual([0, 1, 0]);
    expect(stagingOf(ramp)).toEqual([
      [1, 0],
      [0, 0],
    ]);
    expect([world.jobs.size, world.vehicles.get(vehicleId)?.state]).toEqual([0, 'idle']);
  });

  it('staging sa zaplní (2 docky × 2) a ďalšie outbound joby nevzniknú; zvyšok ostane v sklade, nič sa nestratí', () => {
    const { world, far, depot } = outboundWorld();
    const ramp = rampOf(world);
    const units = stockYard(world, far, 7);
    buyVehicles(world, depot, 2);
    const log = runUntil(world, (w) => ramp.stagedCount === 4 && w.jobs.size === 0, 400);
    run(world, 200, log);
    expect(ofType(events(log), 'JobCreated')).toHaveLength(4);
    expect(ofType(events(log), 'JobDone')).toHaveLength(4);
    expect(stagingOf(ramp)).toEqual([
      [2, 0],
      [2, 0],
    ]);
    expect([far.storedCount, far.unitsOut, world.cargo.countByKind('in_vehicle')]).toEqual([3, 4, 0]);
    expect(units.slice(0, 4).map((unit) => world.cargo.get(unit)?.location.kind)).toEqual(['at_ramp', 'at_ramp', 'at_ramp', 'at_ramp']);
    expect(world.cargo.liveCount).toBe(7);
  });
});

describe('strata prevádzkovosti rampy', () => {
  it('odstránenie brány: open joby sa zrušia (JobCancelled, rezervácie uvoľnené), job s vozidlom sa dokončí; po obnove brány nové joby', () => {
    const { world, far, depot } = outboundWorld();
    const ramp = rampOf(world);
    const units = stockYard(world, far, 6);
    const [vehicleId] = buyVehicles(world, depot, 1);
    world.tick();
    const [assigned, ...open] = [...world.jobs.values()];
    expect([assigned.state, ...open.map((job) => job.state)]).toEqual(['assigned', 'open', 'open', 'open']);

    const removal = execute(world, { type: 'RemoveModule', moduleId: gateOf(world).id });
    expect(ofType(removal, 'RampOperationalChanged')).toEqual([{ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_gate' }]);
    const tick = world.tick();
    expect(ofType(tick, 'JobCancelled')).toEqual(open.map((job) => ({ type: 'JobCancelled', jobId: job.id, reason: 'ramp_inoperative' })));
    expect(ofType(tick, 'JobCreated')).toEqual([]);
    expect(open.map((job) => job.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect([...world.jobs.keys()]).toEqual([assigned.id]);
    expect(stagingOf(ramp)).toEqual([
      [0, 1],
      [0, 0],
    ]);
    expect(units.slice(1, 4).map((unit) => [world.jobOfUnit(unit), world.cargo.get(unit)?.location.kind])).toEqual(Array.from({ length: 3 }, () => [undefined, 'in_storage']));

    const log = run(world, 80);
    expect(ofType(events(log), 'JobCreated')).toEqual([]);
    expect(world.cargo.get(units[0])?.location).toEqual({ kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    expect([world.jobs.size, world.vehicles.get(vehicleId)?.state]).toEqual([0, 'idle']);
    expect(stagingOf(ramp)).toEqual([
      [1, 0],
      [0, 0],
    ]);

    execute(world, landsideCommand('gate'));
    const recreated = ofType(world.tick(), 'JobCreated');
    expect(recreated.map((event) => event.unitIds[0])).toEqual(units.slice(1, 4));
    runUntil(world, (w) => ramp.stagedCount === 4 && w.jobs.size === 0, 400);
    expect([far.storedCount, far.unitsOut, world.cargo.liveCount]).toEqual([2, 4, 6]);
  });

  it('cesta sklad → rampa zanikne (rampa ostane prevádzková): open joby ramp_unreachable; naložené vozidlo čaká v no_path a po obnove cesty doručí', () => {
    const gap: CellCoord = { x: 52, y: 30 };
    const { world, far, depot } = outboundWorld();
    const ramp = rampOf(world);
    const units = stockYard(world, far, 6);
    const [vehicleId] = buyVehicles(world, depot, 1);
    const vehicle = world.vehicles.get(vehicleId);
    const log = runUntil(world, () => vehicle?.state === 'loading', 40);
    execute(world, { type: 'RemoveRoad', cells: [gap] });
    expect(world.isRampOperational(ramp)).toBe(true);
    run(world, 1, log);
    expect(ofType(events(log), 'JobCancelled').map((event) => event.reason)).toEqual(['ramp_unreachable', 'ramp_unreachable', 'ramp_unreachable']);
    expect(stagingOf(ramp)).toEqual([
      [0, 1],
      [0, 0],
    ]);

    runUntil(world, () => vehicle?.state === 'no_path', 40, log);
    expect(world.cargo.get(units[0])?.location).toEqual({ kind: 'in_vehicle', vehicleId });
    run(world, 2 * REPATH, log);
    expect(vehicle?.state).toBe('no_path');
    expect(ofType(events(log), 'JobCreated')).toHaveLength(4);

    execute(world, { type: 'PlaceRoad', cells: [gap] });
    runUntil(world, (w) => ramp.stagedCount === 4 && w.jobs.size === 0, REPATH + 400, log);
    expect(world.cargo.get(units[0])?.location).toEqual({ kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    expect(ofType(events(log), 'JobCreated')).toHaveLength(7);
    expect([far.storedCount, world.cargo.liveCount]).toEqual([2, 6]);
  });

  it('rampa s outbound jobom sa nedá odstrániť (has_cargo — rezervácia docku patrí jobu)', () => {
    const { world, far } = outboundWorld();
    stockYard(world, far, 1);
    world.tick();
    const reasons = commandFromJSON({ type: 'RemoveModule', moduleId: rampOf(world).id }).validate(world).reasons;
    expect(reasons).toContain('has_cargo');
  });

  it('World.removeJob odstráni aj zrušený job; aktívny nie (not_done)', () => {
    const { world, far } = outboundWorld();
    stockYard(world, far, 1);
    world.tick();
    const [job] = [...world.jobs.values()];
    expect(() => world.removeJob(job.id)).toThrow(/aktívnom stave 'open'/);
    rampOf(world).release(0);
    job.transition('cancelled');
    expect(world.removeJob(job.id)).toBe(job);
    expect([world.jobs.size, world.jobUnitCount]).toEqual([0, 0]);
  });
});

describe('save a invarianty kroku 12', () => {
  function midRun(): { world: World; log: Timed[] } {
    const { world, far, depot } = outboundWorld();
    stockYard(world, far, 8);
    buyVehicles(world, depot, 2);
    const log = run(world, 20);
    return { world, log };
  }

  it('roundtrip uprostred outbound (joby open, assigned aj s nákladom vo vozidle): rezervácie dockov z jobov, beh pokračuje rovnako', () => {
    const { world } = midRun();
    const states = [...world.jobs.values()].map((job) => job.state);
    expect(states).toContain('open');
    expect(states.some((state) => state !== 'open')).toBe(true);
    const saved = viaJson(world.serialize());
    expect(saved.jobs.every((job) => job.to.kind === 'at_ramp' && job.from.kind === 'in_storage')).toBe(true);
    const restored = World.deserialize(world.defs, MAP, saved);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(saved));
    expect(stagingOf(rampOf(restored))).toEqual(stagingOf(rampOf(world)));
    expect([...restored.jobs.values()].map((job) => [job.id, job.state, job.vehicleId])).toEqual([...world.jobs.values()].map((job) => [job.id, job.state, job.vehicleId]));
    const a = events(run(world, 120));
    const b = events(run(restored, 120));
    expect(b).toEqual(a);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
  });

  function stateError(state: unknown): WorldStateError {
    try {
      World.deserialize(LEGACY_CAPACITY_DEFS, MAP, state as WorldState);
    } catch (error) {
      if (error instanceof WorldStateError) return error;
      throw error;
    }
    throw new Error('očakávaná WorldStateError');
  }

  type Mutation = (jobs: { to: Record<string, number | string> }[], yardId: number) => void;
  const CASES: readonly [string, Mutation, string, RegExp][] = [
    ['tri joby na dock s 2 miestami', (jobs) => jobs.forEach((job) => (job.to.dock = 0)), '/jobs/2/to/dock', /nemá voľné miesto/],
    ['dock mimo rozsahu', (jobs) => (jobs[0].to.dock = 2), '/jobs/0/to/dock', /dock musí byť/],
    ['cieľ at_ramp na sklade', (jobs, yardId) => (jobs[0].to.rampId = yardId), '/jobs/0/to/rampId', /neprijíma náklad jobu do 'at_ramp'/],
  ];
  it.each(CASES)('obnova: %s → WorldStateError na %s', (_name, mutate, path, message) => {
    const { world, far } = outboundWorld();
    stockYard(world, far, 4);
    world.tick();
    const saved = viaJson(world.serialize()) as unknown as { jobs: { to: Record<string, number | string> }[] };
    mutate(saved.jobs, far.id);
    const error = stateError(saved);
    expect(error.path).toBe(path);
    expect(error.message).toMatch(message);
  });

  it('krok 12: rezervácia docku bez jobu aj job bez rezervácie docku sú porušenie; staged + reserved ≤ stagingPerDock', () => {
    const { world, far } = outboundWorld();
    stockYard(world, far, 3);
    world.tick();
    const ramp = rampOf(world);
    expect(findWorldViolation(world)).toBeUndefined();
    ramp.reserve(1);
    expect(findWorldViolation(world)).toMatch(/dock 1 má 2 staging rezervácií, aktívne outbound joby naň vezú 1 jednotiek/);
    ramp.release(1);
    ramp.release(1);
    expect(findWorldViolation(world)).toMatch(/miesto 1 \('at_ramp'\) nie je rezervované/);
    ramp.reserve(1);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});
