// LandsideSystem — krok 8 (T04-04; ARCHITECTURE §6, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6;
// ADR-011, ADR-024): spawn kamióna (dock s pripraveným nákladom, voľný bay, dock bez iného kamióna), presné trvania
// prechodu bránou (`processTicks` + `internalTicks`), pobytu v stojisku a nakládky, spätný priechod stojiskom pri
// odchode, export na portáli, NoWaitingBay 1×/h aj cez save, no_path a návrat, zaniknutá strana brány či výstup
// stojiska, RemoveRoad pod kamiónom, traffic, World.addTruck / removeTruck, invarianty kroku 12 a chyby obnovy save.
// Rozloženie: tests/sim/logistics/outbound-fixtures.ts (brána 6, stojisko 7, rampa 8); náklad sa na dock kladie priamo
// cez ledger, vozidlá netreba.
import modulesJson from '@data/defs/modules.json';
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { LoadingRamp, TruckGate, WaitingArea } from '@sim/modules';
import { Truck, TruckError } from '@sim/trucks';
import { World, WorldInvariantError, WorldStateError, type WorldState } from '@sim/world';
import { areaOf, execute, gateOf, outboundWorld, rampOf } from '../logistics/outbound-fixtures';
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
  it('dock s pripraveným nákladom → kamión na portáli v to_gate, drží bay 0 a dock; ďalší pre ten istý dock nevznikne', () => {
    const { world, area, ramp } = landside();
    stage(world, ramp, 0, 2);
    const log = run(world, 1);
    const truck = onlyTruck(world);
    expect(log.filter((entry) => entry.event.type === 'TruckSpawned').map((entry) => entry.event)).toEqual([{ type: 'TruckSpawned', truckId: truck.id, rampId: ramp.id, dock: 0 }]);
    expect([truck.state, truck.cell, truck.progress, truck.x, truck.y, truck.heading]).toEqual(['to_gate', cellIndex(world, PORTAL), 0, PORTAL.x + 0.5, PORTAL.y + 0.5, 0]);
    expect(truck.remainingRoute().at(-1)).toBe(cellIndex(world, GATE_ENTRY));
    expect([truck.gateId, truck.waitingAreaId, truck.rampId, truck.bay]).toEqual([6, 7, 8, 0]);
    expect([area.bayHolder(0), area.reservedBays, ramp.dockTruck(0), ramp.dockTruck(1)]).toEqual([truck.id, 1, truck.id, null]);
    run(world, 5);
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
    expect([area.bayHolder(0), ramp.dockTruck(0)]).toEqual([first.id, first.id]);
    expect(truckErrorCode(() => world.addTruck(first))).toBe('duplicate_id');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { rampId: 6 as EntityId, bay: 1, dock: 1 })))).toBe('unknown_module');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { dock: 5, bay: 1 })))).toBe('unknown_module');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { dock: 1 })))).toBe('bay_taken');
    expect(truckErrorCode(() => world.addTruck(truckAt(world, { bay: 1 })))).toBe('dock_taken');
    expect([world.trucks.size, area.reservedBays, ramp.assignedDocks]).toEqual([1, 1, 1]);
  });

  it('removeTruck: neznámy → unknown_truck; drží bay a dock → busy; s nákladom → has_cargo', () => {
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
    gate.dequeue();
    expect(() => world.assertInvariants()).toThrow(/nie je vo fronte/);
  });

  it('bay kamióna uvoľnený mimo systému → WorldInvariantError', () => {
    const { world, area, truck } = queued();
    area.releaseBay(truck.id);
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
  });

  it('dock kamióna uvoľnený mimo systému → WorldInvariantError', () => {
    const { world, ramp, truck } = queued();
    ramp.releaseDock(0, truck.id);
    expect(() => world.assertInvariants()).toThrow(/nedrží dock/);
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
    expect(trucksOf(state)).toHaveLength(2);
    expect(JSON.stringify(World.deserialize(DEFS, MAP, viaJson(state)).serialize())).toBe(JSON.stringify(state));
  });

  it.each<[string, (state: WorldState & Record<string, unknown>) => void, string | ((state: WorldState) => string)]>([
    ['stav exited', (s) => (trucksOf(s)[0]['state'] = 'exited'), '/trucks/0/state'],
    ['resume mimo no_path', (s) => (trucksOf(s)[0]['resume'] = 'to_gate'), '/trucks/0/resume'],
    ['bez bay v stave s bay', (s) => (trucksOf(s)[0]['bay'] = null), '/trucks/0/bay'],
    ['dva kamióny s tým istým bay', (s) => (trucksOf(s)[1]['bay'] = trucksOf(s)[0]['bay']), '/trucks/1/bay'],
    ['dva kamióny na tom istom docku', (s) => (trucksOf(s)[1]['dock'] = trucksOf(s)[0]['dock']), '/trucks/1/dock'],
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
      (s) => ((s.modules[moduleIndex(s, 'truck_gate')].runtime as { queue: number[] }).queue = []),
      '/trucks/0/state',
    ],
    [
      'hodina NoWaitingBay v budúcnosti',
      (s) => ((s.modules[moduleIndex(s, 'loading_ramp_container')].runtime as { lastNoWaitingBayHour: number }).lastNoWaitingBayHour = 99999),
      (s) => `/modules/${String(moduleIndex(s, 'loading_ramp_container'))}/runtime/lastNoWaitingBayHour`,
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
});
