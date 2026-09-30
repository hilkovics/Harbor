// Pozemné moduly (T04-02, ADR-022): TruckGate (fronta, priepustnosť, strany, runtime), WaitingArea (bays) a LoadingRamp
// (staging docky nad ledgerom — DockStaging, zverejnený prevádzkový stav). Moduly mimo sveta cez ModuleRegistry.
import modulesJson from '@data/defs/modules.json';
import { describe, expect, it } from 'vitest';
import type { CargoLedger } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import {
  DockStaging,
  LandExportModule,
  LoadingRamp,
  ModuleError,
  ModuleStateError,
  RAMP_OPERATIONAL,
  TruckGate,
  WaitingArea,
  gatePassProblem,
  moduleRegistry,
  type ModuleErrorCode,
  type PlacedConnector,
} from '@sim/modules';
import { RAW_DEFS } from '../world/world-fixtures';
import { emptyCargo, id, quayGrid } from './module-fixtures';

const [, , , , gateJson, areaJson, rampJson] = modulesJson.items;

/** Bundled defy + varianty s `internalTicks` a stojisko s jedným bay. */
const DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: [
      ...modulesJson.items,
      { ...gateJson, id: 'gate_slow_test', params: { processTicks: 30, internalTicks: 4 } },
      { ...areaJson, id: 'area_one_bay_test', params: { bays: 1, internalTicks: 2 } },
      { ...rampJson, id: 'ramp_quick_test', params: { ...rampJson.params, internalTicks: 3 } },
    ],
  },
});

const GRID = quayGrid(20, 12);

function create<T>(defId: string, cls: abstract new (...args: never[]) => T, cargo: CargoLedger = emptyCargo(DEFS), moduleId = 1): T {
  const module = moduleRegistry.create(DEFS.modules.get(defId), { defId, x: 2, y: 2, rotation: 0 }, id(moduleId), 0, { grid: GRID, cargo });
  if (!(module instanceof cls)) throw new Error(`${defId} nie je ${cls.name}`);
  return module;
}

function errorCode(action: () => unknown): ModuleErrorCode | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof ModuleError) return error.code;
    throw error;
  }
  return undefined;
}

function statePath(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof ModuleStateError) return error.path;
    throw error;
  }
  return undefined;
}

const truck = (value: number): EntityId => value as EntityId;

describe('LandExportModule', () => {
  it('brána, stojisko aj rampa dedia z LandExportModule; internalTicks = params.internalTicks = vehicleInternalTicks', () => {
    for (const defId of ['truck_gate', 'truck_waiting_area', 'loading_ramp_container']) {
      const module = moduleRegistry.create(DEFS.modules.get(defId), { defId, x: 2, y: 2, rotation: 0 }, id(1), 0, { grid: GRID, cargo: emptyCargo(DEFS) });
      if (!(module instanceof LandExportModule)) throw new Error(`${defId} nie je LandExportModule`);
      expect(module.internalTicks, defId).toBeUndefined();
      expect(module.vehicleInternalTicks(), defId).toBeUndefined();
    }
    expect(create('gate_slow_test', TruckGate).internalTicks).toBe(4);
    expect(create('area_one_bay_test', WaitingArea).vehicleInternalTicks()).toBe(2);
    expect(create('ramp_quick_test', LoadingRamp).vehicleInternalTicks()).toBe(3);
  });
});

describe('TruckGate', () => {
  it('počiatočný stav: params z defu, prázdna fronta, voľná brána, strany neurčené, runtime', () => {
    const gate = create('truck_gate', TruckGate);
    expect(gate.params).toEqual({ processTicks: 18 });
    expect([gate.queueLength, gate.busyTicksLeft, gate.trucksProcessed, gate.isOpen]).toEqual([0, 0, 0, false]);
    expect(gate.queuedTruckIds).toEqual([]);
    expect([gate.entrySide, gate.exitSide]).toEqual([null, null]);
    expect(gate.getRuntimeState()).toEqual({ queue: [], busyTicksLeft: 0, trucksProcessed: 0 });
    expect(gate.findRuntimeProblem()).toBeUndefined();
    expect(gate.cargoReservations()).toBeUndefined();
  });

  it('spoločná FIFO fronta: enqueue / peekQueue / dequeue; snímka queuedTruckIds je zmrazená a stabilná', () => {
    const gate = create('truck_gate', TruckGate);
    gate.enqueue(truck(20));
    gate.enqueue(truck(11));
    gate.enqueue(truck(35));
    const view = gate.queuedTruckIds;
    expect(view).toEqual([20, 11, 35]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(gate.queuedTruckIds).toBe(view);
    expect([gate.queueLength, gate.peekQueue(), gate.isQueued(truck(11)), gate.isQueued(truck(12))]).toEqual([3, 20, true, false]);
    expect(gate.dequeue()).toBe(20);
    expect(gate.queuedTruckIds).toEqual([11, 35]);
    expect(view).toEqual([20, 11, 35]);
    expect([gate.dequeue(), gate.dequeue()]).toEqual([11, 35]);
    expect(gate.peekQueue()).toBeUndefined();
    expect(errorCode(() => gate.dequeue())).toBe('queue_empty');
  });

  it('enqueue: kamión už vo fronte → duplicate_id, neplatné id → invalid_input (fronta sa nezmení)', () => {
    const gate = create('truck_gate', TruckGate);
    gate.enqueue(truck(5));
    expect(errorCode(() => gate.enqueue(truck(5)))).toBe('duplicate_id');
    expect(errorCode(() => gate.enqueue(truck(0)))).toBe('invalid_input');
    expect(errorCode(() => gate.enqueue(truck(1.5)))).toBe('invalid_input');
    expect(gate.queuedTruckIds).toEqual([5]);
  });

  it('priepustnosť: beginPass pre čelo fronty nastaví busyTicksLeft, počas prechodu ďalší nezačne (busy); bez fronty queue_empty', () => {
    const gate = create('truck_gate', TruckGate);
    expect(errorCode(() => gate.beginPass(3))).toBe('queue_empty');
    gate.enqueue(truck(7));
    gate.enqueue(truck(8));
    gate.beginPass(3);
    expect([gate.busyTicksLeft, gate.trucksProcessed, gate.isOpen]).toEqual([3, 0, true]);
    expect(errorCode(() => gate.beginPass(3))).toBe('busy');
    gate.advancePass();
    gate.advancePass();
    expect(gate.busyTicksLeft).toBe(1);
    gate.advancePass();
    expect([gate.busyTicksLeft, gate.isOpen]).toEqual([0, false]);
    gate.advancePass();
    expect(gate.busyTicksLeft).toBe(0);
    gate.beginPass(1);
    expect(gate.trucksProcessed).toBe(0);
    for (const ticks of [0, -1, 2.5, Number.NaN]) {
      const fresh = create('truck_gate', TruckGate);
      fresh.enqueue(truck(1));
      expect(errorCode(() => fresh.beginPass(ticks)), String(ticks)).toBe('invalid_input');
      expect(fresh.busyTicksLeft).toBe(0);
    }
  });

  it('completePass: vyberie čelo a započíta dokončený prechod; zopakovaný začiatok prechodu sa nezapočíta dvakrát (review T04-11 d)', () => {
    const gate = create('truck_gate', TruckGate);
    gate.enqueue(truck(7));
    gate.enqueue(truck(8));
    gate.beginPass(2);
    expect(errorCode(() => gate.completePass())).toBe('busy');
    gate.advancePass();
    gate.advancePass();
    // Druhá strana chýbala — prechod sa zopakuje (landsideSystem), počítadlo sa nemení.
    gate.beginPass(2);
    gate.advancePass();
    gate.advancePass();
    expect(gate.trucksProcessed).toBe(0);
    expect(gate.completePass()).toBe(7);
    expect([gate.trucksProcessed, gate.queuedTruckIds]).toEqual([1, [8]]);
    expect(gate.completePass()).toBe(8);
    expect(errorCode(() => gate.completePass())).toBe('queue_empty');
    expect(gate.trucksProcessed).toBe(2);
  });

  it('withdraw: vyradí kamión z fronty bez prechodu; čelo počas prechodu zruší aj prechod; mimo fronty invalid_input', () => {
    const gate = create('truck_gate', TruckGate);
    for (const id of [3, 4, 5]) gate.enqueue(truck(id));
    gate.beginPass(5);
    gate.withdraw(truck(4));
    expect([gate.queuedTruckIds, gate.busyTicksLeft, gate.isQueued(truck(4))]).toEqual([[3, 5], 5, false]);
    gate.withdraw(truck(3));
    expect([gate.queuedTruckIds, gate.busyTicksLeft, gate.trucksProcessed]).toEqual([[5], 0, 0]);
    expect(errorCode(() => gate.withdraw(truck(3)))).toBe('invalid_input');
    gate.withdraw(truck(5));
    expect([gate.queueLength, gate.findRuntimeProblem()]).toEqual([0, undefined]);
  });

  it('gatePassProblem / findRuntimeProblem: odpočet nad passTicks alebo prechod bez kamióna vo fronte (review T04-11 a)', () => {
    const gate = create('truck_gate', TruckGate);
    expect(gatePassProblem(0, 18, 0)).toBeUndefined();
    expect(gatePassProblem(18, 18, 1)).toBeUndefined();
    expect(gatePassProblem(19, 18, 1)).toMatchObject({ path: '/busyTicksLeft' });
    expect(gatePassProblem(1, 18, 0)).toMatchObject({ path: '/busyTicksLeft' });
    gate.enqueue(truck(2));
    gate.beginPass(gate.passTicks);
    expect(gate.findRuntimeProblem()).toBeUndefined();
    gate.dequeue();
    expect(gate.findRuntimeProblem()).toMatch(/prechod beží \(18 tickov\), ale fronta je prázdna/);
  });

  it('setSides zverejní strany; výstup bez vstupu je chyba programu', () => {
    const gate = create('truck_gate', TruckGate);
    const [north, south] = gate.connectors as readonly PlacedConnector[];
    gate.setSides(south, north);
    expect([gate.entrySide, gate.exitSide]).toEqual([south, north]);
    gate.setSides(south, null);
    expect([gate.entrySide, gate.exitSide]).toEqual([south, null]);
    expect(errorCode(() => gate.setSides(null, north))).toBe('invalid_input');
    expect([gate.entrySide, gate.exitSide]).toEqual([south, null]);
    gate.setSides(null, null);
    expect(gate.entrySide).toBeNull();
  });

  it('runtime: roundtrip cez JSON zachová frontu, odpočet aj počítadlo', () => {
    const gate = create('truck_gate', TruckGate);
    gate.enqueue(truck(9));
    gate.enqueue(truck(4));
    gate.beginPass(7);
    const state = JSON.parse(JSON.stringify(gate.getRuntimeState())) as unknown;
    const copy = create('truck_gate', TruckGate);
    copy.restoreRuntimeState(state);
    expect(copy.getRuntimeState()).toEqual({ queue: [9, 4], busyTicksLeft: 7, trucksProcessed: 0 });
    expect(copy.queuedTruckIds).toEqual([9, 4]);
    expect(copy.dequeue()).toBe(9);
    expect(gate.queuedTruckIds).toEqual([9, 4]);
  });

  const BAD_RUNTIME: readonly [string, unknown, string][] = [
    ['nie objekt', null, ''],
    ['chýba queue', { busyTicksLeft: 0, trucksProcessed: 0 }, '/queue'],
    ['neznámy kľúč', { queue: [], busyTicksLeft: 0, trucksProcessed: 0, open: true }, '/open'],
    ['queue nie pole', { queue: 3, busyTicksLeft: 0, trucksProcessed: 0 }, '/queue'],
    ['id 0 vo fronte', { queue: [1, 0], busyTicksLeft: 0, trucksProcessed: 0 }, '/queue/1'],
    ['duplicitný kamión', { queue: [4, 4], busyTicksLeft: 0, trucksProcessed: 0 }, '/queue/1'],
    ['záporný odpočet', { queue: [], busyTicksLeft: -1, trucksProcessed: 0 }, '/busyTicksLeft'],
    ['necelé počítadlo', { queue: [], busyTicksLeft: 0, trucksProcessed: 1.5 }, '/trucksProcessed'],
    ['odpočet nad passTicks', { queue: [2], busyTicksLeft: 19, trucksProcessed: 0 }, '/busyTicksLeft'],
    ['prechod bez kamióna vo fronte', { queue: [], busyTicksLeft: 5, trucksProcessed: 0 }, '/busyTicksLeft'],
  ];
  it.each(BAD_RUNTIME)('restoreRuntimeState: %s → ModuleStateError %s, stav sa nezmení', (_name, raw, path) => {
    const gate = create('truck_gate', TruckGate);
    gate.enqueue(truck(2));
    expect(statePath(() => gate.restoreRuntimeState(raw))).toBe(path);
    expect(gate.getRuntimeState()).toEqual({ queue: [2], busyTicksLeft: 0, trucksProcessed: 0 });
  });
});

describe('WaitingArea', () => {
  it('bays z defu; reserveBay dá najnižší voľný; occupy / release menia počítadlá', () => {
    const area = create('truck_waiting_area', WaitingArea);
    expect([area.bays, area.freeBays, area.reservedBays, area.occupiedBays]).toEqual([6, 6, 0, 0]);
    expect(area.reserveBay(truck(30))).toBe(0);
    expect(area.reserveBay(truck(31))).toBe(1);
    expect(area.reserveBay(truck(32))).toBe(2);
    expect([area.freeBays, area.reservedBays, area.occupiedBays]).toEqual([3, 3, 0]);
    expect(area.occupyBay(truck(31))).toBe(1);
    expect([area.freeBays, area.reservedBays, area.occupiedBays]).toEqual([3, 2, 1]);
    expect([area.bayHolder(1), area.isBayOccupied(1), area.isBayOccupied(0), area.bayOf(truck(32)), area.bayOf(truck(99))]).toEqual([
      31,
      true,
      false,
      2,
      undefined,
    ]);
    expect(area.releaseBay(truck(30))).toBe(0);
    expect(area.reserveBay(truck(33))).toBe(0);
    expect(area.releaseBay(truck(31))).toBe(1);
    expect([area.freeBays, area.reservedBays, area.occupiedBays, area.bayHolder(1)]).toEqual([4, 2, 0, null]);
    expect(area.findRuntimeProblem()).toBeUndefined();
    expect(area.getRuntimeState()).toEqual({});
  });

  it('chyby sú atomické: duplicate_id, no_free_bay, slot_not_reserved, slot_occupied, slot_reserved, invalid_slot', () => {
    const area = create('area_one_bay_test', WaitingArea);
    expect(area.bays).toBe(1);
    area.reserveBay(truck(7));
    expect(errorCode(() => area.reserveBay(truck(7)))).toBe('duplicate_id');
    expect(errorCode(() => area.reserveBay(truck(8)))).toBe('no_free_bay');
    expect(errorCode(() => area.occupyBay(truck(8)))).toBe('slot_not_reserved');
    expect(errorCode(() => area.releaseBay(truck(8)))).toBe('slot_not_reserved');
    area.occupyBay(truck(7));
    expect(errorCode(() => area.occupyBay(truck(7)))).toBe('slot_occupied');
    expect(errorCode(() => area.reserveBayAt(0, truck(8)))).toBe('slot_reserved');
    expect(errorCode(() => area.reserveBayAt(1, truck(8)))).toBe('invalid_slot');
    expect(errorCode(() => area.bayHolder(-1))).toBe('invalid_slot');
    expect(errorCode(() => area.isBayOccupied(1))).toBe('invalid_slot');
    expect(errorCode(() => area.reserveBay(truck(0)))).toBe('invalid_input');
    expect([area.freeBays, area.reservedBays, area.occupiedBays, area.bayHolder(0)]).toEqual([0, 0, 1, 7]);
    expect(area.findRuntimeProblem()).toBeUndefined();
  });

  it('reserveBayAt (obnova z kamióna) rezervuje konkrétny bay', () => {
    const area = create('truck_waiting_area', WaitingArea);
    area.reserveBayAt(4, truck(12));
    expect([area.bayHolder(4), area.reservedBays, area.freeBays]).toEqual([12, 1, 5]);
    expect(errorCode(() => area.reserveBayAt(2, truck(12)))).toBe('duplicate_id');
    expect(area.reserveBay(truck(13))).toBe(0);
  });
});

/** Ledger s jednotkami presunutými na docky rampy `rampId` (cez `in_vehicle` — povolený prechod §7.1). */
function stageUnits(cargo: CargoLedger, rampId: number, docks: readonly number[]): EntityId[] {
  return docks.map((dock) => {
    const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) });
    cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: id(901) });
    cargo.move(unit.id, { kind: 'at_ramp', rampId: id(rampId), dock });
    return unit.id;
  });
}

describe('LoadingRamp', () => {
  it('parametre z defu a nezverejnený stav: neprevádzková, nepripojená; publishStatus hlási zmenu', () => {
    const ramp = create('loading_ramp_container', LoadingRamp);
    expect([ramp.docks, ramp.stagingPerDock, ramp.capacity, ramp.category, ramp.params.loadTicksPerUnit]).toEqual([2, 2, 4, 'container', 6]);
    expect([ramp.operational, ramp.inoperativeReason]).toEqual([false, 'not_connected']);
    expect(ramp.publishStatus({ operational: false, reason: 'not_connected' })).toBe(true);
    expect(ramp.publishStatus({ operational: false, reason: 'not_connected' })).toBe(false);
    expect(ramp.publishStatus({ operational: false, reason: 'no_gate' })).toBe(true);
    expect(ramp.inoperativeReason).toBe('no_gate');
    expect(ramp.publishStatus(RAMP_OPERATIONAL)).toBe(true);
    expect([ramp.operational, ramp.inoperativeReason, ramp.operationalStatus]).toEqual([true, null, RAMP_OPERATIONAL]);
    expect(ramp.getRuntimeState()).toEqual({ lastNoWaitingBayHour: null });
  });

  it('rezervácie na dockoch: reserve / freeAt / firstFreeDock / release; plný dock → no_free_slot', () => {
    const ramp = create('loading_ramp_container', LoadingRamp);
    expect([ramp.freeCount, ramp.firstFreeDock()]).toEqual([4, 0]);
    ramp.reserve(0);
    ramp.reserve(0);
    expect([ramp.reservedAt(0), ramp.freeAt(0), ramp.freeAt(1), ramp.firstFreeDock(), ramp.reservedCount]).toEqual([2, 0, 2, 1, 2]);
    expect(errorCode(() => ramp.reserve(0))).toBe('no_free_slot');
    ramp.reserve(1);
    ramp.reserve(1);
    expect([ramp.freeCount, ramp.firstFreeDock()]).toEqual([0, -1]);
    ramp.release(1);
    expect([ramp.reservedAt(1), ramp.firstFreeDock()]).toEqual([1, 1]);
    expect(ramp.cargoReservations()).toEqual({ kind: 'at_ramp', count: 3 });
    ramp.release(1);
    expect(errorCode(() => ramp.release(1))).toBe('slot_not_reserved');
    expect(errorCode(() => ramp.reserve(2))).toBe('invalid_slot');
    expect(errorCode(() => ramp.stagedAt(-1))).toBe('invalid_slot');
    expect(errorCode(() => ramp.freeAt(0.5))).toBe('invalid_slot');
    expect(ramp.findRuntimeProblem()).toBeUndefined();
  });

  it('tok: reserve → assertCommittable → CargoLedger.move → commit; obsadenie docku číta z ledgera (FIFO)', () => {
    const cargo = emptyCargo(DEFS);
    const ramp = create('loading_ramp_container', LoadingRamp, cargo, 50);
    const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) });
    cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: id(901) });
    ramp.reserve(1);
    ramp.assertCommittable(1, unit.id);
    expect(errorCode(() => ramp.assertCommittable(0, unit.id))).toBe('slot_not_reserved');
    expect(errorCode(() => ramp.commit(1, unit.id))).toBe('unit_not_at_slot');
    cargo.move(unit.id, { kind: 'at_ramp', rampId: ramp.id, dock: 1 });
    ramp.commit(1, unit.id);
    expect([ramp.stagedAt(1), ramp.reservedAt(1), ramp.stagedAt(0), ramp.stagedCount, ramp.freeCount]).toEqual([1, 0, 0, 1, 3]);

    const [a, b] = stageUnits(cargo, 50, [0, 0]);
    expect([ramp.firstUnitAt(0), ramp.firstUnitAt(1)]).toEqual([a, unit.id]);
    expect(ramp.unitsAt(0)).toEqual([a, b]);
    expect([ramp.freeAt(0), ramp.firstFreeDock()]).toEqual([0, 1]);
    cargo.move(a, { kind: 'in_truck', truckId: id(902) });
    expect([ramp.firstUnitAt(0), ramp.stagedAt(0)]).toEqual([b, 1]);
    expect(ramp.findRuntimeProblem()).toBeUndefined();
  });

  it('commit na inom docku alebo inej rampe → unit_not_at_slot (rezervácia ostane)', () => {
    const cargo = emptyCargo(DEFS);
    const ramp = create('loading_ramp_container', LoadingRamp, cargo, 50);
    const [onDock0] = stageUnits(cargo, 50, [0]);
    const [elsewhere] = stageUnits(cargo, 51, [1]);
    ramp.reserve(1);
    expect(errorCode(() => ramp.commit(1, onDock0))).toBe('unit_not_at_slot');
    expect(errorCode(() => ramp.commit(1, elsewhere))).toBe('unit_not_at_slot');
    expect(ramp.reservedAt(1)).toBe(1);
  });

  it('findRuntimeProblem: jednotka na docku mimo rozsahu, dock nad kapacitou (staged + reserved)', () => {
    const cargo = emptyCargo(DEFS);
    const ramp = create('loading_ramp_container', LoadingRamp, cargo, 50);
    stageUnits(cargo, 50, [1]);
    ramp.reserve(1);
    expect(ramp.findRuntimeProblem()).toBeUndefined();
    stageUnits(cargo, 50, [1]);
    expect(ramp.findRuntimeProblem()).toMatch(/dock 1: pripravené 2 \+ rezervované 1 > 2/);

    const other = create('loading_ramp_container', LoadingRamp, cargo, 60);
    const [far] = stageUnits(cargo, 60, [5]);
    expect(other.findRuntimeProblem()).toMatch(new RegExp(`jednotka #${String(far)} leží na docku 5 mimo 0…1`));
    expect(errorCode(() => other.stagedAt(5))).toBe('invalid_slot');
  });

  it('DockStaging: docks aj perDock musia byť celé ≥ 1', () => {
    const cargo = emptyCargo(DEFS);
    for (const [docks, perDock] of [
      [0, 2],
      [2, 0],
      [1.5, 1],
    ] as const) {
      expect(errorCode(() => new DockStaging({ rampId: id(1), docks, perDock, cargo, label: 'test' })), `${String(docks)}×${String(perDock)}`).toBe(
        'invalid_input',
      );
    }
    expect(new DockStaging({ rampId: id(1), docks: 3, perDock: 4, cargo, label: 'test' }).capacity).toBe(12);
  });
});
