// LandsideSystem — krok 8 (T04-04; ARCHITECTURE §6, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6;
// ADR-011, ADR-024): spawn kamióna (dock s pripraveným nákladom, voľný bay, dock bez iného kamióna), presné trvania
// prechodu bránou (`processTicks` + `internalTicks`), pobytu v stojisku a nakládky, spätný priechod stojiskom pri
// odchode, export na portáli, NoWaitingBay 1×/h aj cez save, no_path a návrat, zaniknutá strana brány či výstup
// stojiska, RemoveRoad pod kamiónom, traffic, World.addTruck / removeTruck, invarianty kroku 12 a chyby obnovy save.
// Rozloženie: tests/sim/logistics/outbound-fixtures.ts (brána 6, stojisko 7, rampa 8); náklad sa na dock kladie priamo
// cez ledger, vozidlá netreba.
import modulesJson from '@data/defs/modules.json';
import trucksJson from '@data/defs/trucks.json';
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { LoadingRamp, TruckGate, WaitingArea } from '@sim/modules';
import { Truck, TruckError } from '@sim/trucks';
import { World, WorldInvariantError, WorldStateError, type WorldState } from '@sim/world';
import { areaOf, buyVehicles, execute, gateOf, ofType, outboundWorld, rampOf, stockYard } from '../logistics/outbound-fixtures';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';

interface Timed {
  readonly tick: number;
  readonly event: SimEvent;
}

const PROCESS = 18;
const INTERNAL = DEFS.logistics.defaultInternalTicks;
const REPATH = DEFS.logistics.repathIntervalTicks;
const LOAD = 6;
const PORTAL = { x: 44, y: 63 };
const GATE_ENTRY = { x: 44, y: 33 };
const GATE_EXIT = { x: 47, y: 33 };
const AREA_WEST = { x: 48, y: 33 };
const AREA_EAST = { x: 53, y: 33 };

function run(world: World, ticks: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < ticks; i++) for (const event of world.tick()) log.push({ tick: world.clock.tick, event });
  return log;
}

function runUntil(world: World, done: (world: World) => boolean, limit: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < limit && !done(world); i++) run(world, 1, log);
  if (!done(world)) throw new Error(`podmienka nenastala do ${String(limit)} tickov`);
  return log;
}

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `count` jednotiek priamo na dock rampy cez ledger (fiktívna loď 900, žeriav 901, vozidlo 902 — len prechody §7.1). */
function stage(world: World, ramp: LoadingRamp, dock: number, count: number): EntityId[] {
  const units: EntityId[] = [];
  for (let i = 0; i < count; i++) {
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
    units.push(unit);
  }
  return units;
}

interface Landside {
  readonly world: World;
  readonly gate: TruckGate;
  readonly area: WaitingArea;
  readonly ramp: LoadingRamp;
}

function landside(defs: DefRegistry = DEFS): Landside {
  const { world } = outboundWorld({ defs });
  return { world, gate: gateOf(world), area: areaOf(world), ramp: rampOf(world) };
}

const cellIndex = (world: World, cell: { x: number; y: number }): number => world.grid.index(cell.x, cell.y);
const onlyTruck = (world: World): Truck => {
  const [truck] = [...world.trucks.values()];
  if (truck === undefined) throw new Error('vo svete nie je kamión');
  return truck;
};

function changes(log: readonly Timed[], truckId: EntityId): { tick: number; from: string; to: string }[] {
  const found: { tick: number; from: string; to: string }[] = [];
  for (const { tick, event } of log) if (event.type === 'TruckStateChanged' && event.truckId === truckId) found.push({ tick, from: event.from, to: event.to });
  return found;
}

const tickOf = (entries: readonly { tick: number; to: string }[], to: string): number => {
  const entry = entries.find((candidate) => candidate.to === to);
  if (entry === undefined) throw new Error(`prechod do ${to} nenastal`);
  return entry.tick;
};

function defsWithParams(defId: string, params: Readonly<Record<string, number>>): DefRegistry {
  const items = modulesJson.items.map((item) => (item.id === defId ? { ...item, params: { ...item.params, ...params } } : item));
  return DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...modulesJson, items } });
}

const defsWithGateInternal = (internalTicks: number): DefRegistry => defsWithParams('truck_gate', { internalTicks });
const defsWithBays = (bays: number): DefRegistry => defsWithParams('truck_waiting_area', { bays });

describe('spawn kamióna', () => {
  it('dock s pripraveným nákladom → kamión na portáli v to_gate, drží bay 0 a nárok na svoju kapacitu, dock ešte nie (ADR-029); na druhú jednotku vznikne druhý kamión v ďalšom ticku, tretí nie', () => {
    const { world, area, ramp } = landside();
    stage(world, ramp, 0, 2);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    expect(log.filter((entry) => entry.event.type === 'TruckSpawned').map((entry) => entry.event)).toEqual([{ type: 'TruckSpawned', truckId: truck.id, rampId: ramp.id, dock: 0 }]);
    expect([truck.state, truck.cell, truck.progress, truck.x, truck.y, truck.heading]).toEqual(['to_gate', cellIndex(world, PORTAL), 0, PORTAL.x + 0.5, PORTAL.y + 0.5, 0]);
    expect(truck.remainingRoute().at(-1)).toBe(cellIndex(world, GATE_ENTRY));
    expect([truck.gateId, truck.waitingAreaId, truck.rampId, truck.bay, truck.dock]).toEqual([6, 7, 8, 0, 0]);
    expect([area.bayHolder(0), area.reservedBays, ramp.dockTruck(0), ramp.dockTruck(1), ramp.claimedAt(0), ramp.claimedAt(1)]).toEqual([truck.id, 1, null, null, 1, 0]);
    const next = run(world, 5);
    expect(next.filter((entry) => entry.event.type === 'TruckSpawned').map((entry) => [entry.tick, entry.event.type === 'TruckSpawned' ? entry.event.dock : -1])).toEqual([[2, 0]]);
    expect([world.trucks.size, ramp.claimedAt(0), area.reservedBays]).toEqual([2, 2, 2]);
  });

  it('náklad, ktorý k docku vezie vozidlo, stačí na spawn; otvorený job bez vozidla nie (ADR-029)', () => {
    const open = outboundWorld({ defs: DEFS });
    stockYard(open.world, open.far, 1);
    const withoutVehicle = run(open.world, 50);
    expect(ofType(withoutVehicle.map((entry) => entry.event), 'JobCreated')).toHaveLength(1);
    expect([open.world.trucks.size, rampOf(open.world).reservedAt(0)]).toEqual([0, 1]);

    const { world, depot, far } = outboundWorld({ defs: DEFS });
    stockYard(world, far, 1);
    buyVehicles(world, depot, 1);
    const ramp = rampOf(world);
    const log = run(world, 1);
    expect(ofType(log.map((entry) => entry.event), 'JobAssigned')).toHaveLength(1);
    expect(ofType(log.map((entry) => entry.event), 'TruckSpawned')).toEqual([{ type: 'TruckSpawned', truckId: onlyTruck(world).id, rampId: ramp.id, dock: 0 }]);
    expect([ramp.stagedAt(0), ramp.reservedAt(0), ramp.claimedAt(0), ramp.dockTruck(0)]).toEqual([0, 1, 1, null]);
    run(world, 100);
    expect(world.trucks.size).toBe(1);
  });

  it('neprevádzková rampa (bez brány) kamión nespawne ani s pripraveným nákladom; NoWaitingBay nevznikne', () => {
    const { world } = outboundWorld({ defs: DEFS, landside: ['waiting_area', 'ramp'] });
    stage(world, rampOf(world), 0, 1);
    const log = run(world, 400);
    expect(world.trucks.size).toBe(0);
    expect(log.filter((entry) => entry.event.type === 'TruckSpawned' || entry.event.type === 'NoWaitingBay')).toEqual([]);
  });

  it('bez voľného bay (bays 1): druhý dock kamión nedostane, NoWaitingBay raz za hernú hodinu; hodina prežije save', () => {
    const { world, ramp } = landside(defsWithBays(1));
    stage(world, ramp, 0, 1);
    stage(world, ramp, 1, 1);
    const log = run(world, 1);
    expect(log.filter((entry) => entry.event.type === 'TruckSpawned').map((entry) => (entry.event.type === 'TruckSpawned' ? entry.event.dock : -1))).toEqual([0]);
    expect(log.filter((entry) => entry.event.type === 'NoWaitingBay').map((entry) => entry.event)).toEqual([{ type: 'NoWaitingBay', rampId: ramp.id }]);
    expect(ramp.lastNoWaitingBayHour).toBe(world.clock.gameHour);
    const restored = World.deserialize(world.defs, MAP, viaJson(world.serialize()));
    expect(rampOf(restored).lastNoWaitingBayHour).toBe(world.clock.gameHour);
    const a = run(world, 300);
    const b = run(restored, 300);
    expect(b).toEqual(a);
    expect(a.filter((entry) => entry.event.type === 'NoWaitingBay')).toEqual([]);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
  });
});

describe('povel do docku a fronta v stojisku (ADR-029)', () => {
  it('dva kamióny na jeden dock: prvý si vezme dock až pri odchode zo stojiska, druhý čaká v bayi, kým prvý nedoloží', () => {
    // Pomalá nakládka (60 tickov), aby druhý kamión prišiel do stojiska, kým prvý ešte nakladá.
    const { world, area, ramp } = landside(defsWithParams('loading_ramp_container', { loadTicksPerUnit: 60 }));
    stage(world, ramp, 0, 2);
    const log: Timed[] = [];
    let maxHolders = 0;
    runUntil(
      world,
      (w) => {
        maxHolders = Math.max(maxHolders, [...w.trucks.values()].filter((truck) => truck.bonds.holdsDock).length);
        return w.cargo.exportedCount === 2;
      },
      2000,
      log,
    );
    const [first, second] = [...new Set(log.flatMap((entry) => (entry.event.type === 'TruckSpawned' ? [entry.event.truckId] : [])))];
    const a = changes(log, first);
    const b = changes(log, second);
    expect(maxHolders).toBe(1);
    // Druhý kamión dorazí do stojiska skôr, než prvý doloží, a čaká v bayi dlhšie ako pobyt stojiska.
    expect(tickOf(b, 'waiting')).toBeLessThan(tickOf(a, 'to_gate_out'));
    expect(tickOf(b, 'to_dock') - tickOf(b, 'waiting')).toBeGreaterThan(INTERNAL);
    // Dock sa uvoľní koncom nakládky prvého kamióna; druhý odíde najneskôr v ďalšom ticku (kamióny vzostupne podľa id).
    expect(tickOf(b, 'to_dock') - tickOf(a, 'to_gate_out')).toBeGreaterThanOrEqual(0);
    expect(tickOf(b, 'to_dock') - tickOf(a, 'to_gate_out')).toBeLessThanOrEqual(1);
    expect([area.reservedBays + area.occupiedBays, ramp.assignedDocks, ramp.claimedUnits, world.cargo.exportedCount]).toEqual([0, 0, 0, 2]);
  });

  it('kamión na náklad, ktorý ešte vezie vozidlo, čaká v bayi a do docku ide až s celým nákladom na docku', () => {
    const { world, depot, near } = outboundWorld({ defs: DEFS });
    stockYard(world, near, 3);
    buyVehicles(world, depot, 1);
    const ramp = rampOf(world);
    const toDock: { tick: number; staged: number; dock: number }[] = [];
    for (let i = 0; i < 3000 && world.cargo.exportedCount < 3; i++) {
      for (const event of world.tick()) {
        if (event.type !== 'TruckStateChanged' || event.to !== 'to_dock') continue;
        const truck = world.trucks.get(event.truckId);
        if (truck !== undefined) toDock.push({ tick: world.clock.tick, staged: ramp.stagedAt(truck.dock), dock: truck.dock });
      }
    }
    expect(world.cargo.exportedCount).toBe(3);
    expect(toDock).toHaveLength(3);
    for (const entry of toDock) expect(entry.staged, `tick ${String(entry.tick)}`).toBeGreaterThanOrEqual(1);
  });
});

describe('cyklus jedného kamióna', () => {
  it('presné trvania: brána processTicks, stojisko internalTicks, nakládka loadTicksPerUnit; export na portáli s TruckExited', () => {
    const { world, gate, area, ramp } = landside();
    const [unit] = stage(world, ramp, 0, 1);
    const log: Timed[] = [];
    const positions: { state: string; x: number; y: number }[] = [];
    run(world, 1, log);
    const truck = onlyTruck(world);
    runUntil(
      world,
      (w) => {
        if (w.trucks.has(truck.id)) positions.push({ state: truck.state, x: truck.x, y: truck.y });
        return w.cargo.exportedCount === 1;
      },
      2000,
      log,
    );
    const path = changes(log, truck.id);
    expect(path.map((entry) => entry.to)).toEqual(['gate_queue', 'to_bay', 'waiting', 'to_dock', 'loading', 'to_gate_out', 'gate_queue_out', 'to_portal', 'exited']);
    expect(tickOf(path, 'to_bay') - tickOf(path, 'gate_queue')).toBe(PROCESS);
    expect(tickOf(path, 'to_dock') - tickOf(path, 'waiting')).toBe(INTERNAL);
    expect(tickOf(path, 'to_gate_out') - tickOf(path, 'loading')).toBe(LOAD);
    expect(tickOf(path, 'to_portal') - tickOf(path, 'gate_queue_out')).toBe(PROCESS);
    const exitTick = tickOf(path, 'exited');
    const atExit = log.filter((entry) => entry.tick === exitTick).map((entry) => entry.event);
    expect(atExit).toContainEqual({ type: 'CargoMoved', unitId: unit, from: { kind: 'in_truck', truckId: truck.id }, to: { kind: 'exported' }, tick: exitTick });
    expect(atExit).toContainEqual({ type: 'TruckExited', truckId: truck.id, units: 1 });
    expect([world.trucks.size, gate.trucksProcessed, gate.queueLength, area.reservedBays + area.occupiedBays, ramp.dockTruck(0)]).toEqual([0, 2, 0, 0, null]);
    expect(world.cargo.get(unit)).toBeUndefined();
    // Po prechode bránou sa kamión objaví na výstupnej bunke; odchádza spätne cez stojisko (východ → západ, telom).
    const firstToBay = positions.find((sample) => sample.state === 'to_bay');
    expect(firstToBay).toMatchObject({ x: GATE_EXIT.x + 0.5, y: GATE_EXIT.y + 0.5 });
    const jumps = positions.filter((sample, i) => i > 0 && sample.state === 'to_gate_out' && Math.abs(sample.x - positions[i - 1].x) > 1);
    expect(jumps).toEqual([{ state: 'to_gate_out', x: AREA_WEST.x + 0.5, y: AREA_WEST.y + 0.5 }]);
    expect(positions.some((sample) => sample.state === 'to_dock' && sample.x === AREA_EAST.x + 0.5 && sample.y === AREA_EAST.y + 0.5)).toBe(true);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('brána s internalTicks: prechod trvá processTicks + internalTicks (passTicks)', () => {
    const { world, gate, ramp } = landside(defsWithGateInternal(5));
    expect(gate.passTicks).toBe(PROCESS + 5);
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'waiting', 500, log);
    const path = changes(log, truck.id);
    expect(tickOf(path, 'to_bay') - tickOf(path, 'gate_queue')).toBe(PROCESS + 5);
  });

  it('traffic rastie aj pod kamiónom (krok 11 po pohybe)', () => {
    const { world, ramp } = landside();
    stage(world, ramp, 0, 1);
    run(world, 3);
    const truck = onlyTruck(world);
    expect(world.grid.at(Math.floor(truck.x), Math.floor(truck.y)).traffic).toBeGreaterThanOrEqual(1);
  });
});

describe('cesty pod kamiónom a bez cesty', () => {
  it('RemoveRoad pod stojacim kamiónom (portál) → occupied; carrierOnCell ho nájde', () => {
    const { world, ramp } = landside();
    stage(world, ramp, 0, 1);
    run(world, 1);
    const truck = onlyTruck(world);
    expect(world.carrierOnCell(cellIndex(world, PORTAL))).toBe(truck);
    expect(world.vehicleOnCell(cellIndex(world, PORTAL))).toBeUndefined();
    const result = commandFromJSON({ type: 'RemoveRoad', cells: [PORTAL] }).validate(world);
    expect(result.reasons).toContain('occupied');
  });

  it('prerušená cesta k bráne: jazdiaci kamión preplánuje, bez cesty no_path (resume to_gate), po oprave sa vráti a dôjde', () => {
    const { world, ramp } = landside();
    stage(world, ramp, 0, 1);
    const log = run(world, 10);
    const truck = onlyTruck(world);
    expect(truck.state).toBe('to_gate');
    execute(world, { type: 'RemoveRoad', cells: [{ x: 44, y: 45 }] });
    expect(truck.replanPending).toBe(true);
    run(world, 1, log);
    expect([truck.state, truck.resume, truck.waitTicks, truck.bay]).toEqual(['no_path', 'to_gate', REPATH, 0]);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 44, y: 45 }] });
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
    const path = changes(log, truck.id).map((entry) => `${entry.from}>${entry.to}`);
    expect(path.slice(0, 3)).toEqual(['to_gate>no_path', 'no_path>to_gate', 'to_gate>gate_queue']);
  });

  it('zaniknutá výstupná strana brány počas prechodu: kamión ostane na čele fronty, po obnove cesty prejde', () => {
    const { world, gate, ramp } = landside();
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'gate_queue', 500, log);
    execute(world, { type: 'RemoveRoad', cells: [GATE_EXIT] });
    expect(world.isRampOperational(ramp)).toBe(false);
    run(world, PROCESS + 5, log);
    expect([truck.state, gate.queueLength, gate.busyTicksLeft]).toEqual(['gate_queue', 1, 0]);
    execute(world, { type: 'PlaceRoad', cells: [GATE_EXIT] });
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
    expect(changes(log, truck.id).map((entry) => entry.to)).toContain('to_bay');
  });

  it('gate_queue_out: vonkajšia strana zanikne počas prechodu von a vráti sa → prechod sa zopakuje celý, trucksProcessed +1, nie +2; aj cez save (BACKLOG P2, T06-07)', () => {
    const { world, gate, ramp } = landside();
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'gate_queue_out', 3000, log);
    run(world, 2, log);
    expect([gate.trucksProcessed, gate.busyTicksLeft]).toEqual([1, PROCESS - 2]);
    execute(world, { type: 'RemoveRoad', cells: [GATE_ENTRY] });
    run(world, PROCESS + REPATH, log);
    expect([truck.state, gate.queuedTruckIds, gate.busyTicksLeft, gate.trucksProcessed]).toEqual(['gate_queue_out', [truck.id], 0, 1]);
    const restored = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
    for (const target of [world, restored]) {
      execute(target, { type: 'PlaceRoad', cells: [GATE_ENTRY] });
      const placedAt = target.clock.tick;
      const tail: Timed[] = [];
      runUntil(target, () => target.cargo.exportedCount === 1, 3000, tail);
      expect(tickOf(changes(tail, truck.id), 'to_portal') - placedAt).toBe(PROCESS + 1);
      expect(gateOf(target).trucksProcessed).toBe(2);
    }
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
  });

  it('zaniknutý výstup stojiska: kamión čaká v bayi (repathIntervalTicks), po obnove cesty ide k docku', () => {
    const { world, area, ramp } = landside();
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'waiting', 500, log);
    execute(world, { type: 'RemoveRoad', cells: [AREA_EAST] });
    run(world, INTERNAL + 1, log);
    expect([truck.state, truck.waitTicks, area.occupiedBays]).toEqual(['waiting', REPATH - 1, 1]);
    execute(world, { type: 'PlaceRoad', cells: [AREA_EAST] });
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
  });
});

describe('cesta späť a kamión za bránou (review T04-11, major 1 a 2)', () => {
  const oneWay = (cell: { x: number; y: number }, dir: 'N' | 'E' | 'S' | 'W') => ({ type: 'PlaceRoad', cells: [cell], kind: 'one_way', dirs: [dir] }) as const;
  const outboundJobs = (world: World): number => [...world.jobs.values()].filter((job) => job.to.kind === 'at_ramp').length;

  it.each<[string, { x: number; y: number }, 'N' | 'E']>([
    ['jednosmerka (47, 33) smerom E', GATE_EXIT, 'E'],
    ['jednosmerka (44, 33) smerom N', GATE_ENTRY, 'N'],
  ])('%s: rampa no_return_path, kamión nevznikne; po oprave cesty kamión naloží a odíde z mapy', (_name, cell, dir) => {
    const { world, ramp } = landside();
    execute(world, oneWay(cell, dir));
    stage(world, ramp, 0, 1);
    const log = run(world, 400);
    expect(world.rampStatus(ramp).reason).toBe('no_return_path');
    expect([world.trucks.size, outboundJobs(world)]).toEqual([0, 0]);
    expect(log.filter((entry) => entry.event.type === 'TruckSpawned' || entry.event.type === 'NoWaitingBay')).toEqual([]);
    execute(world, { type: 'PlaceRoad', cells: [cell], kind: 'two_lane' });
    expect(world.isRampOperational(ramp)).toBe(true);
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
    expect(world.trucks.size).toBe(0);
  });

  it('prerušený vstup brány (44, 33) s kamiónom vo waiting: naloží, uvoľní dock a bay, čaká vo fronte von na (47, 33); po obnove odíde', () => {
    const { world, gate, area, ramp } = landside();
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'waiting', 500, log);
    execute(world, { type: 'RemoveRoad', cells: [GATE_ENTRY] });
    expect(world.rampStatus(ramp).reason).toBe('no_gate');
    runUntil(world, () => truck.state === 'gate_queue_out', 500, log);
    expect([truck.cell, ramp.dockTruck(0), area.reservedBays + area.occupiedBays, world.cargo.countAt('in_truck', truck.id)]).toEqual([cellIndex(world, GATE_EXIT), null, 0, 1]);
    run(world, 3 * REPATH, log);
    expect([truck.state, gate.queuedTruckIds, gate.busyTicksLeft, gate.trucksProcessed]).toEqual(['gate_queue_out', [truck.id], 0, 1]);
    expect(changes(log, truck.id).map((entry) => entry.to)).toEqual(['gate_queue', 'to_bay', 'waiting', 'to_dock', 'loading', 'to_gate_out', 'gate_queue_out']);
    // Kamión za bránou už nič nedrží — uložený stav sa obnoví a pokračuje rovnako.
    const restored = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
    execute(world, { type: 'PlaceRoad', cells: [GATE_ENTRY] });
    execute(restored, { type: 'PlaceRoad', cells: [GATE_ENTRY] });
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
    const tail = run(restored, 0);
    runUntil(restored, () => restored.cargo.exportedCount === 1, 3000, tail);
    expect(restored.clock.tick).toBe(world.clock.tick);
    expect(gate.trucksProcessed).toBe(2);
  });

  it('prerušená cesta rampa → stojisko počas nakládky: kamión naloží, uvoľní dock a čaká v no_path (to_gate_out); po obnove odíde', () => {
    const { world, ramp } = landside();
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'loading', 800, log);
    execute(world, { type: 'RemoveRoad', cells: [{ x: 53, y: 32 }] });
    expect(world.rampStatus(ramp).reason).toBe('not_connected');
    runUntil(world, () => truck.state === 'no_path', 50, log);
    expect([truck.resume, ramp.dockTruck(0), world.cargo.countAt('in_truck', truck.id)]).toEqual(['to_gate_out', null, 1]);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 53, y: 32 }] });
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
  });

  it('dock 1 na slepej jednosmerke (55, 30): rampa ostane prevádzková, kamión docku 1 nakladá na (54, 30) s cestou späť', () => {
    const { world, ramp } = landside();
    execute(world, oneWay({ x: 55, y: 30 }, 'E'));
    expect(world.isRampOperational(ramp)).toBe(true);
    stage(world, ramp, 1, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    expect(truck.dock).toBe(1);
    runUntil(world, () => truck.state === 'loading', 800, log);
    expect(truck.cell).toBe(cellIndex(world, { x: 54, y: 30 }));
    runUntil(world, () => world.cargo.exportedCount === 1, 3000, log);
  });
});

describe('preklopenie strán brány pod kamiónom vo fronte (dodatok ADR-024)', () => {
  // Obchádzka brány: z verejnej cesty (44, 42) na východ (45..47, 42) a na sever (47, 41..34) k výstupnej bunke (47, 33).
  // Priamo 9 krokov k (44, 33), obchádzkou 12 k (47, 33) → vstup (44, 33). Prestavba (44, 34..41) na one_lane
  // (8 / 0,7 + 1 ≈ 12,4 > 12) strany preklopí: vstup (47, 33), výstup (44, 33).
  const BYPASS = [
    { x: 45, y: 42 },
    { x: 46, y: 42 },
    { x: 47, y: 42 },
    ...Array.from({ length: 8 }, (_, i) => ({ x: 47, y: 41 - i })),
  ];
  const SLOW = Array.from({ length: 8 }, (_, i) => ({ x: 44, y: 41 - i }));

  it('kamión v gate_queue na (44, 33) po preklopení vypadne z fronty bez prechodu (prechod sa zruší) a ide do stojiska; save hneď po príkaze sa obnoví', () => {
    const { world, gate, ramp } = landside();
    execute(world, { type: 'PlaceRoad', cells: BYPASS });
    expect(world.gateSides(gate).entryCell).toBe(cellIndex(world, GATE_ENTRY));
    stage(world, ramp, 0, 1);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'gate_queue', 500, log);
    expect(gate.busyTicksLeft).toBeGreaterThan(0);
    const flip = execute(world, { type: 'PlaceRoad', cells: SLOW, kind: 'one_lane' });
    for (const event of flip) log.push({ tick: world.clock.tick, event });
    expect(world.gateSides(gate)).toMatchObject({ entryCell: cellIndex(world, GATE_EXIT), exitCell: cellIndex(world, GATE_ENTRY) });
    expect(flip.filter((event) => event.type === 'TruckStateChanged')).toEqual([{ type: 'TruckStateChanged', truckId: truck.id, from: 'gate_queue', to: 'to_bay' }]);
    expect([truck.state, gate.queueLength, gate.busyTicksLeft, gate.trucksProcessed, truck.cell]).toEqual(['to_bay', 0, 0, 0, cellIndex(world, GATE_ENTRY)]);
    expect(() => world.assertInvariants()).not.toThrow();
    const restored = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    runUntil(world, () => world.cargo.exportedCount === 1, 4000, log);
    expect(changes(log, truck.id).map((entry) => entry.to)).toEqual(['gate_queue', 'to_bay', 'waiting', 'to_dock', 'loading', 'to_gate_out', 'gate_queue_out', 'to_portal', 'exited']);
  });

  it('krok 12: kamión vo fronte mimo svojej strany brány → WorldInvariantError', () => {
    const { world, gate, ramp } = landside();
    stage(world, ramp, 0, 1);
    run(world, 1);
    const truck = onlyTruck(world);
    runUntil(world, () => truck.state === 'gate_queue', 500);
    truck.jumpTo(cellIndex(world, GATE_EXIT), world.grid.width);
    expect(gate.isQueued(truck.id)).toBe(true);
    expect(() => world.assertInvariants()).toThrow(/nie na svojej strane brány/);
  });
});

describe('World.addTruck / removeTruck', () => {
  function truckAt(world: World, overrides: Partial<ConstructorParameters<typeof Truck>[0]> = {}): Truck {
    const portal = cellIndex(world, PORTAL);
    return new Truck({
      id: world.ids.next() as EntityId,
      def: DEFS.trucks.get('truck_container'),
      state: 'to_gate',
      x: PORTAL.x + 0.5,
      y: PORTAL.y + 0.5,
      heading: 0,
      route: [portal],
      rampId: 8 as EntityId,
      dock: 0,
      gateId: 6 as EntityId,
      waitingAreaId: 7 as EntityId,
      bay: 0,
      ...overrides,
    });
  }

  function truckErrorCode(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      if (error instanceof TruckError) return error.code;
      throw error;
    }
    return 'none';
  }

  it('chyby: duplicitné id, zlé moduly, dock mimo rozsahu, obsadený bay alebo dock; svet sa nezmení', () => {
    const { world, area, ramp } = landside();
    const first = truckAt(world);
    world.addTruck(first);
    // Pred povelom do docku kamión dock nedrží, len si nárokuje svoju kapacitu na docku (ADR-029).
    expect([area.bayHolder(0), ramp.dockTruck(0), ramp.claimedAt(0)]).toEqual([first.id, null, 1]);
    const atDock = truckAt(world, { state: 'to_dock', bay: null });
    world.addTruck(atDock);
    expect([ramp.dockTruck(0), ramp.claimedAt(0)]).toEqual([atDock.id, 2]);
    expect(truckErrorCode(() => world.addTruck(first))).toBe('duplicate_id');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { rampId: 6 as EntityId, bay: 1, dock: 1 })))).toBe('unknown_module');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { dock: 5, bay: 1 })))).toBe('unknown_module');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { dock: 1 })))).toBe('bay_taken');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { state: 'loading', bay: null })))).toBe('dock_taken');
    expect([world.trucks.size, area.reservedBays, ramp.assignedDocks, ramp.claimedAt(0), ramp.claimedAt(1)]).toEqual([2, 1, 1, 2, 0]);
  });

  it('removeTruck: neznámy → unknown_truck; drží bay a nárok → busy; s nákladom → has_cargo', () => {
    const { world, ramp } = landside();
    const live = truckAt(world);
    world.addTruck(live);
    expect(truckErrorCode(() => world.removeTruck(999 as EntityId))).toBe('unknown_truck');
    expect(truckErrorCode(() => world.removeTruck(live.id))).toBe('busy');
    const [unit] = stage(world, ramp, 1, 1);
    const leaving = truckAt(world, { state: 'to_gate_out', bay: null, dock: 1 });
    world.addTruck(leaving);
    world.cargo.move(unit, { kind: 'in_truck', truckId: leaving.id });
    expect(truckErrorCode(() => world.removeTruck(leaving.id))).toBe('has_cargo');
  });
});

describe('invarianty kroku 12: kamióny ↔ bays, docky, fronta, náklad', () => {
  function queued(): Landside & { truck: Truck } {
    const parts = landside();
    stage(parts.world, parts.ramp, 0, 2);
    run(parts.world, 1);
    const truck = onlyTruck(parts.world);
    runUntil(parts.world, () => truck.state === 'gate_queue', 500);
    return { ...parts, truck };
  }

  it('platný stav prejde; kamión vo fronte bez miesta vo fronte brány → WorldInvariantError', () => {
    const { world, gate } = queued();
    expect(() => world.assertInvariants()).not.toThrow();
    expect(gate.busyTicksLeft).toBeGreaterThan(0);
    gate.dequeue();
    // Brána hlási prechod bez kamióna vo fronte skôr než kamióny (bod 10 pred bodom 11, review T04-11 a).
    expect(() => world.assertInvariants()).toThrow(/prechod beží .*fronta je prázdna/);
    while (gate.busyTicksLeft > 0) gate.advancePass();
    expect(() => world.assertInvariants()).toThrow(/nie je vo fronte/);
  });

  it('bay kamióna uvoľnený mimo systému → WorldInvariantError', () => {
    const { world, area, truck } = queued();
    area.releaseBay(truck.id);
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
  });

  it('dock kamióna uvoľnený mimo systému → WorldInvariantError', () => {
    const { world, ramp, truck } = queued();
    runUntil(world, () => truck.state === 'to_dock', 500);
    expect(() => world.assertInvariants()).not.toThrow();
    ramp.releaseDock(0, truck.id);
    expect(() => world.assertInvariants()).toThrow(/nedrží dock/);
  });

  it('nárok docku mimo systému → WorldInvariantError (ADR-029)', () => {
    const { world, ramp } = queued();
    ramp.settleClaim(0, 1);
    expect(() => world.assertInvariants()).toThrow(/dock 0 má nárok 1, kamióny docku 2/);
  });

  function truckOnDock1(world: World, state: 'to_gate' | 'to_dock'): Truck {
    // Kamión na portáli s trasou po x = 44 k vstupu brány (44, 33) — pohyb je v poriadku, porušený je len nárok/dock.
    const route: number[] = [];
    for (let y = PORTAL.y; y >= GATE_ENTRY.y; y--) route.push(cellIndex(world, { x: PORTAL.x, y }));
    return new Truck({
      id: world.ids.next() as EntityId,
      def: DEFS.trucks.get('truck_container'),
      state,
      x: PORTAL.x + 0.5,
      y: PORTAL.y + 0.5,
      heading: 0,
      route: state === 'to_gate' ? route : [cellIndex(world, PORTAL), cellIndex(world, { x: 44, y: 62 })],
      rampId: 8 as EntityId,
      dock: 1,
      gateId: 6 as EntityId,
      waitingAreaId: 7 as EntityId,
      bay: state === 'to_gate' ? 0 : null,
    });
  }

  it('kamión s nárokom na dock bez pripraveného ani vezeného nákladu → WorldInvariantError (ADR-029)', () => {
    const { world } = landside();
    world.addTruck(truckOnDock1(world, 'to_gate'));
    expect(() => world.assertInvariants()).toThrow(/dock 1 má nárok 1 > pripravené a vezené jednotky 0/);
  });

  it('kamión s dockom bez pripravených jednotiek na docku → WorldInvariantError (review T04-11 b)', () => {
    const { world } = landside();
    world.addTruck(truckOnDock1(world, 'to_dock'));
    expect(() => world.assertInvariants()).toThrow(/drží dock 1 .*na docku je 0 a v kamióne 0 jednotiek/);
  });

  it('def kamióna nevozí kategóriu rampy → WorldInvariantError (review T04-11 b)', () => {
    const { world, ramp } = landside();
    stage(world, ramp, 0, 1);
    const def = { ...DEFS.trucks.get('truck_container'), cargoCategories: ['bulk'] as const };
    world.addTruck(
      new Truck({
        id: world.ids.next() as EntityId,
        def,
        state: 'to_gate',
        x: PORTAL.x + 0.5,
        y: PORTAL.y + 0.5,
        heading: 0,
        route: [cellIndex(world, PORTAL), cellIndex(world, { x: 44, y: 62 })],
        rampId: 8 as EntityId,
        dock: 0,
        gateId: 6 as EntityId,
        waitingAreaId: 7 as EntityId,
        bay: 0,
      }),
    );
    expect(() => world.assertInvariants()).toThrow(/nevozí kategóriu 'container'/);
  });

  it('náklad v kamióne pred nakládkou → WorldInvariantError', () => {
    const { world, ramp, truck } = queued();
    const unit = ramp.firstUnitAt(0);
    if (unit === undefined) throw new Error('na docku nie je jednotka');
    world.cargo.move(unit, { kind: 'in_truck', truckId: truck.id });
    expect(() => world.assertInvariants()).toThrow(/pred nakládkou/);
  });
});

describe('save v4: chyby obnovy kamiónov', () => {
  function midState(): WorldState & Record<string, unknown> {
    const { world, ramp } = landside();
    stage(world, ramp, 0, 2);
    stage(world, ramp, 1, 1);
    run(world, 1);
    runUntil(world, () => [...world.trucks.values()].some((truck) => truck.state === 'gate_queue'), 500);
    return viaJson(world.serialize()) as WorldState & Record<string, unknown>;
  }

  function stateError(state: unknown): WorldStateError {
    try {
      World.deserialize(DEFS, MAP, state as WorldState);
    } catch (error) {
      if (error instanceof WorldStateError) return error;
      throw error;
    }
    throw new Error('očakávaná WorldStateError');
  }

  type Trucks = Record<string, unknown>[];
  const trucksOf = (state: Record<string, unknown>): Trucks => state['trucks'] as Trucks;
  const moduleIndex = (state: WorldState, defId: string): number => state.modules.findIndex((entry) => entry.defId === defId);

  it('platný save sa obnoví a serializuje rovnako', () => {
    const state = midState();
    // Tick 1: kamión pre dock 0 aj dock 1; tick 2: druhý kamión pre druhú jednotku docku 0 (ADR-029).
    expect(trucksOf(state).map((truck) => truck['dock'])).toEqual([0, 1, 0]);
    expect(JSON.stringify(World.deserialize(DEFS, MAP, viaJson(state)).serialize())).toBe(JSON.stringify(state));
  });

  it.each<[string, (state: WorldState & Record<string, unknown>) => void, string | ((state: WorldState) => string)]>([
    ['stav exited', (s) => (trucksOf(s)[0]['state'] = 'exited'), '/trucks/0/state'],
    ['resume mimo no_path', (s) => (trucksOf(s)[0]['resume'] = 'to_gate'), '/trucks/0/resume'],
    ['bez bay v stave s bay', (s) => (trucksOf(s)[0]['bay'] = null), '/trucks/0/bay'],
    ['dva kamióny s tým istým bay', (s) => (trucksOf(s)[1]['bay'] = trucksOf(s)[0]['bay']), '/trucks/1/bay'],
    ['nároky kamiónov na dock prevyšujú jeho náklad (ADR-029)', (s) => (trucksOf(s)[1]['dock'] = trucksOf(s)[0]['dock']), '/trucks/2/dock'],
    ['neznámy def', (s) => (trucksOf(s)[0]['defId'] = 'truck_x'), '/trucks/0/defId'],
    ['rampa nie je rampa', (s) => (trucksOf(s)[0]['rampId'] = 6), '/trucks/0/rampId'],
    ['kamión mimo mapy (poloha nie je na trase)', (s) => (trucksOf(s)[0]['x'] = 1), '/trucks/0/x'],
    [
      'fronta brány s neznámym kamiónom',
      (s) => ((s.modules[moduleIndex(s, 'truck_gate')].runtime as { queue: number[] }).queue = [...(s.modules[moduleIndex(s, 'truck_gate')].runtime as { queue: number[] }).queue, 999]),
      (s) => `/modules/${String(moduleIndex(s, 'truck_gate'))}/runtime/queue/${String((s.modules[moduleIndex(s, 'truck_gate')].runtime as { queue: number[] }).queue.length - 1)}`,
    ],
    [
      'kamión vo fronte chýba vo fronte brány',
      (s) => {
        const runtime = s.modules[moduleIndex(s, 'truck_gate')].runtime as { queue: number[]; busyTicksLeft: number };
        runtime.queue = [];
        runtime.busyTicksLeft = 0;
      },
      '/trucks/0/state',
    ],
    [
      'hodina NoWaitingBay v budúcnosti',
      (s) => ((s.modules[moduleIndex(s, 'loading_ramp_container')].runtime as { lastNoWaitingBayHour: number }).lastNoWaitingBayHour = 99999),
      (s) => `/modules/${String(moduleIndex(s, 'loading_ramp_container'))}/runtime/lastNoWaitingBayHour`,
    ],
    [
      'brána: odpočet prechodu nad passTicks (review T04-11 a)',
      (s) => ((s.modules[moduleIndex(s, 'truck_gate')].runtime as { busyTicksLeft: number }).busyTicksLeft = PROCESS + 1),
      (s) => `/modules/${String(moduleIndex(s, 'truck_gate'))}/runtime/busyTicksLeft`,
    ],
    [
      'brána: prechod beží, fronta prázdna (review T04-11 a)',
      (s) => ((s.modules[moduleIndex(s, 'truck_gate')].runtime as { queue: number[] }).queue = []),
      (s) => `/modules/${String(moduleIndex(s, 'truck_gate'))}/runtime/busyTicksLeft`,
    ],
    [
      'kamión v gate_queue na výstupnej strane brány (review T04-11 b)',
      (s) => {
        const truck = trucksOf(s).find((entry) => entry['state'] === 'gate_queue');
        if (truck === undefined) throw new Error('v save nie je kamión v gate_queue');
        truck['route'] = [GATE_EXIT.y * MAP.width + GATE_EXIT.x];
        truck['x'] = GATE_EXIT.x + 0.5;
        truck['y'] = GATE_EXIT.y + 0.5;
      },
      (s) => `/trucks/${String(trucksOf(s as WorldState & Record<string, unknown>).findIndex((entry) => entry['state'] === 'gate_queue'))}/route`,
    ],
    [
      'kamión má nárok na dock, na ktorom nie je pripravená ani vezená jednotka (review T04-11 b, ADR-029)',
      (s) => {
        const unit = s.cargo.units.find((entry) => entry.location.kind === 'at_ramp' && entry.location.dock === 1);
        if (unit === undefined) throw new Error('na docku 1 nie je jednotka');
        (unit as { location: unknown }).location = { kind: 'in_storage', moduleId: 5, slot: 0 };
      },
      (s) => `/trucks/${String(trucksOf(s as WorldState & Record<string, unknown>).findIndex((entry) => entry['dock'] === 1))}/dock`,
    ],
    [
      'jednotka v kamióne pred nakládkou',
      (s) => {
        const unit = s.cargo.units.find((entry) => entry.location.kind === 'at_ramp');
        if (unit === undefined) throw new Error('na rampe nie je jednotka');
        (unit as { location: unknown }).location = { kind: 'in_truck', truckId: trucksOf(s)[0]['id'] };
      },
      (s) => `/cargo/units/${String(s.cargo.units.findIndex((entry) => entry.location.kind === 'in_truck'))}/location/truckId`,
    ],
  ])('%s → WorldStateError', (_name, mutate, path) => {
    const state = midState();
    mutate(state);
    const expected = typeof path === 'string' ? path : path(state);
    expect(stateError(state).path).toBe(expected);
  });

  it('def kamióna nevozí kategóriu rampy (review T04-11 b) → /trucks/0/defId', () => {
    const bulkDefs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      trucks: { ...trucksJson, items: [...trucksJson.items, { ...trucksJson.items[0], id: 'truck_bulk_test', cargoCategories: ['bulk'] }] },
    });
    const state = midState();
    trucksOf(state)[0]['defId'] = 'truck_bulk_test';
    let error: unknown;
    try {
      World.deserialize(bulkDefs, MAP, state);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe('/trucks/0/defId');
  });
});
