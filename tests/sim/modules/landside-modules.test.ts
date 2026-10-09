// Pozemné moduly (T04-02, ADR-022): TruckGate (fronta, priepustnosť, strany, runtime), WaitingArea (bays) a LoadingRamp
// (staging docky nad ledgerom — DockStaging, zverejnený prevádzkový stav). Moduly mimo sveta cez ModuleRegistry.
import { APRON_MODULES } from '../helpers/apron-modules';
import realModulesJson from '@data/defs/modules.json';
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
  PreGateBuffer,
  RAMP_OPERATIONAL,
  TruckGate,
  TruckHolding,
  WaitingArea,
  gatePassProblem,
  moduleRegistry,
  type ModuleErrorCode,
  type PlacedConnector,
} from '@sim/modules';
import { RAW_DEFS } from '../world/world-fixtures';
import { emptyCargo, id, quayGrid } from './module-fixtures';

/** Pruhy brány majú v tomto súbore skutočné šance na problém (`APRON_MODULES` ich pripína na 0); ostatné moduly ako v `APRON_MODULES`. */
const modulesJson = { ...APRON_MODULES, items: APRON_MODULES.items.map((item) => (item.kind === 'gate' ? (realModulesJson.items.find((real) => real.id === item.id) ?? item) : item)) };
const itemById = (defId: string) => {
  const item = modulesJson.items.find((candidate) => candidate.id === defId);
  if (item === undefined) throw new Error(`def ${defId} chýba`);
  return item;
};
const gateJson = itemById('gate_in_lane');
const areaJson = itemById('truck_waiting_area');
const rampJson = itemById('loading_ramp_container');

/** Bundled defy + varianty s `internalTicks` a stojisko s jedným bay. */
const DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: [
      ...modulesJson.items,
      { ...gateJson, id: 'gate_slow_test', params: { ...gateJson.params, internalTicks: 4 } },
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
  it('pruh brány, stojisko aj rampa dedia z LandExportModule; internalTicks = params.internalTicks = vehicleInternalTicks', () => {
    for (const defId of ['gate_in_lane', 'gate_out_lane', 'truck_waiting_area', 'loading_ramp_container']) {
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

/** Plán prechodu s jediným krokom `ocr` na `ticks` tickov (jednoduchý plán pre testy fronty a odpočtu). */
const plan = (ticks: number) => [{ id: 'ocr' as const, ticks }];

describe('TruckGate (pruh brány, R4 ADR-041)', () => {
  it('počiatočný stav: params z defu, smer, režim standard, prázdna fronta, voľný pruh, strany neurčené, runtime', () => {
    const gate = create('gate_in_lane', TruckGate);
    expect(gate.params).toEqual({ direction: 'in', ocrTicks: 3, checkTicks: 8, issueTicks: 4, gateIssueChance: 0.05, troubleTicks: 40, expressTicks: 6 });
    expect([gate.direction, gate.mode, gate.size]).toEqual(['in', 'standard', { w: 1, h: 4 }]);
    expect([gate.queueLength, gate.busyTicksLeft, gate.trucksProcessed, gate.isOpen]).toEqual([0, 0, 0, false]);
    expect(gate.queuedTruckIds).toEqual([]);
    expect([gate.entrySide, gate.exitSide]).toEqual([null, null]);
    expect(gate.getRuntimeState()).toEqual({ queue: [], busyTicksLeft: 0, trucksProcessed: 0, mode: 'standard', passPlan: [], passTotalTicks: 0 });
    expect(gate.findRuntimeProblem()).toBeUndefined();
    expect(gate.cargoReservations()).toBeUndefined();
    expect(gate.currentStep()).toBeNull();
    expect(create('gate_out_lane', TruckGate).direction).toBe('out');
  });

  it('plán krokov podľa smeru a režimu: vstup OCR → kontrola → lístok, výstup váha → sken → plomba; express jeden krok; trouble jeden dlhý krok; problém pridá krok navyše', () => {
    const lane = create('gate_in_lane', TruckGate);
    const out = create('gate_out_lane', TruckGate);
    expect(lane.planFor('standard', false)).toEqual([
      { id: 'ocr', ticks: 3 },
      { id: 'check', ticks: 8 },
      { id: 'issue', ticks: 4 },
    ]);
    expect(lane.planFor('standard', true).at(-1)).toEqual({ id: 'trouble', ticks: 40 });
    expect(lane.planFor('express', true)).toEqual([{ id: 'express', ticks: 6 }]);
    expect(lane.planFor('trouble', false)).toEqual([{ id: 'trouble', ticks: 40 }]);
    expect(out.planFor('standard', false).map((step) => step.id)).toEqual(['weigh', 'scan', 'seal']);
    expect(out.planFor('standard', true).at(-1)).toEqual({ id: 'inspect', ticks: 40 });
    expect(out.planFor('trouble', false)).toEqual([{ id: 'inspect', ticks: 40 }]);
    expect(lane.planTicks(lane.planFor('standard', false))).toBe(15);
    expect(create('gate_slow_test', TruckGate).planTicks(lane.planFor('standard', false))).toBe(19);
    expect(lane.issueChance).toBe(0.05);
    expect(out.issueChance).toBe(0.03);
    // Stredný čas obsluhy (ETA výberu brány): bez problému 15 + 5 % × 40 = 17 pri standard, pevný čas pri express a trouble.
    expect(lane.meanServiceTicks('standard')).toBeCloseTo(17, 10);
    expect([lane.meanServiceTicks('express'), lane.meanServiceTicks('trouble')]).toEqual([6, 40]);
    expect(lane.maxPassTicks).toBe(55);
  });

  it('setMode mení režim (platí od ďalšieho kamióna); neznámy režim → invalid_input; režim sa ukladá do runtime', () => {
    const lane = create('gate_in_lane', TruckGate);
    lane.setMode('express');
    expect(lane.mode).toBe('express');
    expect(lane.getRuntimeState().mode).toBe('express');
    expect(errorCode(() => lane.setMode('turbo' as never))).toBe('invalid_input');
    expect(lane.mode).toBe('express');
  });

  it('spoločná FIFO fronta: enqueue / peekQueue / dequeue; snímka queuedTruckIds je zmrazená a stabilná', () => {
    const gate = create('gate_in_lane', TruckGate);
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
    const gate = create('gate_in_lane', TruckGate);
    gate.enqueue(truck(5));
    expect(errorCode(() => gate.enqueue(truck(5)))).toBe('duplicate_id');
    expect(errorCode(() => gate.enqueue(truck(0)))).toBe('invalid_input');
    expect(errorCode(() => gate.enqueue(truck(1.5)))).toBe('invalid_input');
    expect(gate.queuedTruckIds).toEqual([5]);
  });

  it('priepustnosť: beginPass pre čelo fronty nastaví busyTicksLeft, počas prechodu ďalší nezačne (busy); bez fronty queue_empty', () => {
    const gate = create('gate_in_lane', TruckGate);
    expect(errorCode(() => gate.beginPass(plan(3)))).toBe('queue_empty');
    gate.enqueue(truck(7));
    gate.enqueue(truck(8));
    gate.beginPass(plan(3));
    expect([gate.busyTicksLeft, gate.passTotalTicks, gate.trucksProcessed, gate.isOpen]).toEqual([3, 3, 0, true]);
    expect(errorCode(() => gate.beginPass(plan(3)))).toBe('busy');
    gate.advancePass();
    gate.advancePass();
    expect(gate.busyTicksLeft).toBe(1);
    gate.advancePass();
    expect([gate.busyTicksLeft, gate.isOpen]).toEqual([0, false]);
    gate.advancePass();
    expect(gate.busyTicksLeft).toBe(0);
    gate.beginPass(plan(1));
    expect(gate.trucksProcessed).toBe(0);
    for (const ticks of [0, -1, 2.5, Number.NaN]) {
      const fresh = create('gate_in_lane', TruckGate);
      fresh.enqueue(truck(1));
      expect(errorCode(() => fresh.beginPass(plan(ticks))), String(ticks)).toBe('invalid_input');
      expect(fresh.busyTicksLeft).toBe(0);
    }
    const empty = create('gate_in_lane', TruckGate);
    empty.enqueue(truck(1));
    expect(errorCode(() => empty.beginPass([]))).toBe('invalid_input');
  });

  it('krok a priebeh prechodu: currentStep dáva id kroku a podiel 0 … 1 počas odpočtu (VM pruhu brány)', () => {
    const gate = create('gate_in_lane', TruckGate);
    gate.enqueue(truck(7));
    gate.beginPass(gate.planFor('standard', false));
    const seen: string[] = [];
    for (let i = 0; i < 15; i++) {
      const step = gate.currentStep();
      seen.push(`${step?.id}:${step?.progress.toFixed(2)}`);
      gate.advancePass();
    }
    expect(seen.slice(0, 3)).toEqual(['ocr:0.00', 'ocr:0.33', 'ocr:0.67']);
    expect(seen[3]).toBe('check:0.00');
    expect(seen[11]).toBe('issue:0.00');
    expect(seen[14]).toBe('issue:0.75');
    expect(gate.currentStep()).toBeNull();
    const slow = create('gate_slow_test', TruckGate);
    slow.enqueue(truck(1));
    slow.beginPass(slow.planFor('standard', false));
    // `internalTicks` 4 predchádza krokom: prvé 4 ticky je pruh v prvom kroku s nulovým priebehom.
    expect([slow.passTotalTicks, slow.currentStep()]).toEqual([19, { id: 'ocr', progress: 0 }]);
  });

  it('completePass: vyberie čelo a započíta dokončený prechod; zopakovaný začiatok prechodu sa nezapočíta dvakrát (review T04-11 d)', () => {
    const gate = create('gate_in_lane', TruckGate);
    gate.enqueue(truck(7));
    gate.enqueue(truck(8));
    gate.beginPass(plan(2));
    expect(errorCode(() => gate.completePass())).toBe('busy');
    gate.advancePass();
    gate.advancePass();
    // Druhá strana chýbala — prechod sa zopakuje (landsideSystem), počítadlo sa nemení.
    gate.beginPass(plan(2));
    gate.advancePass();
    gate.advancePass();
    expect(gate.trucksProcessed).toBe(0);
    expect(gate.completePass()).toBe(7);
    expect([gate.trucksProcessed, gate.queuedTruckIds, gate.passTotalTicks, gate.passPlan]).toEqual([1, [8], 0, []]);
    expect(gate.completePass()).toBe(8);
    expect(errorCode(() => gate.completePass())).toBe('queue_empty');
    expect(gate.trucksProcessed).toBe(2);
  });

  it('withdraw: vyradí kamión z fronty bez prechodu; čelo počas prechodu zruší aj prechod; mimo fronty invalid_input', () => {
    const gate = create('gate_in_lane', TruckGate);
    for (const id of [3, 4, 5]) gate.enqueue(truck(id));
    gate.beginPass(plan(5));
    gate.withdraw(truck(4));
    expect([gate.queuedTruckIds, gate.busyTicksLeft, gate.isQueued(truck(4))]).toEqual([[3, 5], 5, false]);
    gate.withdraw(truck(3));
    expect([gate.queuedTruckIds, gate.busyTicksLeft, gate.trucksProcessed, gate.passTotalTicks]).toEqual([[5], 0, 0, 0]);
    expect(errorCode(() => gate.withdraw(truck(3)))).toBe('invalid_input');
    gate.withdraw(truck(5));
    expect([gate.queueLength, gate.findRuntimeProblem()]).toEqual([0, undefined]);
  });

  it('gatePassProblem / findRuntimeProblem: odpočet nad trvaním prechodu alebo prechod bez kamióna vo fronte (review T04-11 a)', () => {
    const gate = create('gate_in_lane', TruckGate);
    expect(gatePassProblem(0, 15, 0)).toBeUndefined();
    expect(gatePassProblem(15, 15, 1)).toBeUndefined();
    expect(gatePassProblem(16, 15, 1)).toMatchObject({ path: '/busyTicksLeft' });
    expect(gatePassProblem(1, 15, 0)).toMatchObject({ path: '/busyTicksLeft' });
    gate.enqueue(truck(2));
    gate.beginPass(gate.planFor('standard', false));
    expect(gate.findRuntimeProblem()).toBeUndefined();
    gate.dequeue();
    expect(gate.findRuntimeProblem()).toMatch(/prechod beží \(15 tickov\), ale fronta je prázdna/);
  });

  it('setSides zverejní strany; od R4 sú strany nezávislé (vstup bez výstupu aj výstup bez vstupu)', () => {
    const gate = create('gate_in_lane', TruckGate);
    const [south, north] = gate.connectors as readonly PlacedConnector[];
    gate.setSides(south, north);
    expect([gate.entrySide, gate.exitSide]).toEqual([south, north]);
    gate.setSides(south, null);
    expect([gate.entrySide, gate.exitSide]).toEqual([south, null]);
    gate.setSides(null, north);
    expect([gate.entrySide, gate.exitSide]).toEqual([null, north]);
    gate.setSides(null, null);
    expect(gate.entrySide).toBeNull();
  });

  it('prvý konektor defu je vonkajšia (vstupná) strana pruhu — juh, druhý vnútorná — sever (rot 0)', () => {
    for (const defId of ['gate_in_lane', 'gate_out_lane']) {
      const gate = create(defId, TruckGate);
      const [first, second] = gate.connectors as readonly PlacedConnector[];
      expect([first.side, second.side], defId).toEqual(['s', 'n']);
    }
  });

  it('runtime: roundtrip cez JSON zachová frontu, odpočet, režim aj plán prechodu', () => {
    const gate = create('gate_in_lane', TruckGate);
    gate.setMode('express');
    gate.enqueue(truck(9));
    gate.enqueue(truck(4));
    gate.beginPass(gate.planFor('express', false));
    gate.advancePass();
    const state = JSON.parse(JSON.stringify(gate.getRuntimeState())) as unknown;
    const copy = create('gate_in_lane', TruckGate);
    copy.restoreRuntimeState(state);
    expect(copy.getRuntimeState()).toEqual({ queue: [9, 4], busyTicksLeft: 5, trucksProcessed: 0, mode: 'express', passPlan: [{ id: 'express', ticks: 6 }], passTotalTicks: 6 });
    expect(copy.queuedTruckIds).toEqual([9, 4]);
    expect(copy.currentStep()).toEqual({ id: 'express', progress: 1 / 6 });
    expect(copy.dequeue()).toBe(9);
    expect(gate.queuedTruckIds).toEqual([9, 4]);
  });

  const GOOD = { queue: [2], busyTicksLeft: 0, trucksProcessed: 0, mode: 'standard', passPlan: [], passTotalTicks: 0 };
  const BAD_RUNTIME: readonly [string, unknown, string][] = [
    ['nie objekt', null, ''],
    ['chýba queue', { busyTicksLeft: 0, trucksProcessed: 0, mode: 'standard', passPlan: [], passTotalTicks: 0 }, '/queue'],
    ['neznámy kľúč', { ...GOOD, queue: [], open: true }, '/open'],
    ['queue nie pole', { ...GOOD, queue: 3 }, '/queue'],
    ['id 0 vo fronte', { ...GOOD, queue: [1, 0] }, '/queue/1'],
    ['duplicitný kamión', { ...GOOD, queue: [4, 4] }, '/queue/1'],
    ['záporný odpočet', { ...GOOD, queue: [], busyTicksLeft: -1 }, '/busyTicksLeft'],
    ['necelé počítadlo', { ...GOOD, queue: [], trucksProcessed: 1.5 }, '/trucksProcessed'],
    ['neznámy režim', { ...GOOD, mode: 'turbo' }, '/mode'],
    ['plán nie pole', { ...GOOD, passPlan: 3 }, '/passPlan'],
    ['neznámy krok plánu', { ...GOOD, passPlan: [{ id: 'dance', ticks: 3 }], passTotalTicks: 3 }, '/passPlan/0/id'],
    ['krok bez trvania', { ...GOOD, passPlan: [{ id: 'ocr', ticks: 0 }], passTotalTicks: 0 }, '/passPlan/0/ticks'],
    ['trvanie nezodpovedá plánu', { ...GOOD, passPlan: [{ id: 'ocr', ticks: 3 }], passTotalTicks: 4 }, '/passTotalTicks'],
    ['odpočet nad trvaním prechodu', { ...GOOD, busyTicksLeft: 4, passPlan: [{ id: 'ocr', ticks: 3 }], passTotalTicks: 3 }, '/busyTicksLeft'],
    ['prechod bez kamióna vo fronte', { ...GOOD, queue: [], busyTicksLeft: 3, passPlan: [{ id: 'ocr', ticks: 3 }], passTotalTicks: 3 }, '/busyTicksLeft'],
    ['prechod beží bez plánu', { ...GOOD, busyTicksLeft: 3 }, '/busyTicksLeft'],
  ];
  it.each(BAD_RUNTIME)('restoreRuntimeState: %s → ModuleStateError %s, stav sa nezmení', (_name, raw, path) => {
    const gate = create('gate_in_lane', TruckGate);
    gate.enqueue(truck(2));
    expect(statePath(() => gate.restoreRuntimeState(raw))).toBe(path);
    expect(gate.getRuntimeState()).toEqual(GOOD);
  });
});

describe('PreGateBuffer (predbránová plocha, R4 ADR-041 bod 2)', () => {
  it('rady z defu: 8 radov po 2 kamióny; najkratší rad s najnižším indexom pri zhode; plný rad sa preskočí; plná plocha → −1', () => {
    const buffer = create('pre_gate_buffer', PreGateBuffer);
    expect([buffer.rowCount, buffer.rowCapacity, buffer.capacity, buffer.occupied, buffer.freeSlots]).toEqual([8, 2, 16, 0, 16]);
    expect(buffer.landsideRole).toBe('pre_gate');
    const rows: number[] = [];
    for (let i = 1; i <= 16; i++) {
      const row = buffer.shortestRow();
      rows.push(row);
      buffer.admit(truck(i), row);
    }
    // Rovnomerne: najprv každý rad po jednom (0…7), potom druhý kamión do každého (0…7).
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect([buffer.shortestRow(), buffer.occupied, buffer.freeSlots]).toEqual([-1, 16, 0]);
    expect(buffer.rowTrucks(3)).toEqual([4, 12]);
    expect([buffer.head(3), buffer.rowOf(truck(12)), buffer.rowOf(truck(99))]).toEqual([4, 3, -1]);
    expect(errorCode(() => buffer.admit(truck(17), 0))).toBe('no_free_bay');
    expect(errorCode(() => buffer.admit(truck(5), 6))).toBe('duplicate_id');
  });

  it('releaseHead vyberie čelo radu (FIFO) a uvoľní miesto; remove vyradí kamión; chyby', () => {
    const buffer = create('pre_gate_buffer', PreGateBuffer);
    buffer.admit(truck(1), 2);
    buffer.admit(truck(2), 2);
    expect(buffer.shortestRow()).toBe(0);
    expect(buffer.releaseHead(2)).toBe(1);
    expect([buffer.rowTrucks(2), buffer.shortestRow()]).toEqual([[2], 0]);
    buffer.remove(truck(2));
    expect(buffer.occupied).toBe(0);
    expect(errorCode(() => buffer.releaseHead(2))).toBe('queue_empty');
    expect(errorCode(() => buffer.remove(truck(2)))).toBe('invalid_input');
    expect(errorCode(() => buffer.head(8))).toBe('invalid_slot');
    expect(errorCode(() => buffer.admit(truck(0), 0))).toBe('invalid_input');
  });

  it('runtime: roundtrip cez JSON zachová rady; neplatný stav → ModuleStateError a stav sa nezmení', () => {
    const buffer = create('pre_gate_buffer', PreGateBuffer);
    buffer.admit(truck(5), 1);
    buffer.admit(truck(6), 1);
    buffer.admit(truck(7), 4);
    const state = JSON.parse(JSON.stringify(buffer.getRuntimeState())) as unknown;
    const copy = create('pre_gate_buffer', PreGateBuffer);
    copy.restoreRuntimeState(state);
    expect(copy.getRuntimeState()).toEqual(buffer.getRuntimeState());
    expect(copy.findRuntimeProblem()).toBeUndefined();
    const rows = (changes: Record<number, readonly number[]>): number[][] => Array.from({ length: 8 }, (_, r) => [...(changes[r] ?? [])]);
    const bad: readonly [string, unknown, string][] = [
      ['nie objekt', null, ''],
      ['málo radov', { rows: [[]] }, '/rows'],
      ['rad nad kapacitou', { rows: rows({ 0: [1, 2, 3] }) }, '/rows/0'],
      ['id 0 v rade', { rows: rows({ 2: [0] }) }, '/rows/2/0'],
      ['kamión v dvoch radoch', { rows: rows({ 0: [4], 3: [4] }) }, '/rows/3/0'],
      ['neznámy kľúč', { rows: rows({}), extra: 1 }, '/extra'],
    ];
    for (const [name, raw, path] of bad) {
      const target = create('pre_gate_buffer', PreGateBuffer);
      target.admit(truck(9), 0);
      expect(statePath(() => target.restoreRuntimeState(raw)), name).toBe(path);
      expect(target.rowTrucks(0), name).toEqual([9]);
    }
  });
});

describe('TruckHolding (odstavná plocha, stub TR4-01)', () => {
  it('def a modul bez dynamiky: stalls z defu, runtime {}, rola holding', () => {
    const holding = create('truck_holding', TruckHolding);
    expect([holding.stalls, holding.landsideRole, holding.size]).toEqual([4, 'holding', { w: 3, h: 6 }]);
    expect(holding.getRuntimeState()).toEqual({});
    expect(holding.internalTicks).toBeUndefined();
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
    expect([ramp.docks, ramp.stagingPerDock, ramp.capacity, ramp.category, ramp.params.loadTicksPerUnit]).toEqual([2, 4, 8, 'container', 6]);
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
    const per = ramp.stagingPerDock;
    expect([ramp.freeCount, ramp.firstFreeDock()]).toEqual([2 * per, 0]);
    for (let i = 0; i < per; i++) ramp.reserve(0);
    expect([ramp.reservedAt(0), ramp.freeAt(0), ramp.freeAt(1), ramp.firstFreeDock(), ramp.reservedCount]).toEqual([per, 0, per, 1, per]);
    expect(errorCode(() => ramp.reserve(0))).toBe('no_free_slot');
    for (let i = 0; i < per; i++) ramp.reserve(1);
    expect([ramp.freeCount, ramp.firstFreeDock()]).toEqual([0, -1]);
    ramp.release(1);
    expect([ramp.reservedAt(1), ramp.firstFreeDock()]).toEqual([per - 1, 1]);
    expect(ramp.cargoReservations()).toEqual({ kind: 'at_ramp', count: 2 * per - 1 });
    for (let i = 0; i < per - 1; i++) ramp.release(1);
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
    expect([ramp.stagedAt(1), ramp.reservedAt(1), ramp.stagedAt(0), ramp.stagedCount, ramp.freeCount]).toEqual([1, 0, 0, 1, 2 * ramp.stagingPerDock - 1]);

    const [a, b] = stageUnits(cargo, 50, [0, 0]);
    expect([ramp.firstUnitAt(0), ramp.firstUnitAt(1)]).toEqual([a, unit.id]);
    expect(ramp.unitsAt(0)).toEqual([a, b]);
    expect([ramp.freeAt(0), ramp.firstFreeDock()]).toEqual([ramp.stagingPerDock - 2, 0]);
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
    const per = ramp.stagingPerDock;
    stageUnits(cargo, 50, Array<number>(per - 1).fill(1));
    ramp.reserve(1);
    expect(ramp.findRuntimeProblem()).toBeUndefined();
    stageUnits(cargo, 50, [1]);
    expect(ramp.findRuntimeProblem()).toMatch(new RegExp(`dock 1: pripravené ${String(per)} \\+ rezervované 1 > ${String(per)}`));

    const other = create('loading_ramp_container', LoadingRamp, cargo, 60);
    const [far] = stageUnits(cargo, 60, [5]);
    expect(other.findRuntimeProblem()).toMatch(new RegExp(`jednotka #${String(far)} leží na docku 5 mimo 0…1`));
    expect(errorCode(() => other.stagedAt(5))).toBe('invalid_slot');
  });

  it('nároky kamiónov (ADR-029): claim / settleClaim po dockoch, počítadlo, chyby bez zmeny; findRuntimeProblem', () => {
    const ramp = create('loading_ramp_container', LoadingRamp);
    expect([ramp.claimedAt(0), ramp.claimedAt(1), ramp.claimedUnits]).toEqual([0, 0, 0]);
    ramp.claim(0, 1);
    ramp.claim(0, 2);
    ramp.claim(1, 1);
    expect([ramp.claimedAt(0), ramp.claimedAt(1), ramp.claimedUnits]).toEqual([3, 1, 4]);
    ramp.settleClaim(0, 1);
    expect([ramp.claimedAt(0), ramp.claimedUnits]).toEqual([2, 3]);
    expect(errorCode(() => ramp.claim(2, 1))).toBe('invalid_slot');
    expect(errorCode(() => ramp.claim(0, 0))).toBe('invalid_input');
    expect(errorCode(() => ramp.claim(0, 1.5))).toBe('invalid_input');
    expect(errorCode(() => ramp.settleClaim(1, 2))).toBe('invalid_input');
    expect(errorCode(() => ramp.settleClaim(-1, 1))).toBe('invalid_slot');
    expect(errorCode(() => ramp.claimedAt(2))).toBe('invalid_slot');
    expect([ramp.claimedAt(0), ramp.claimedAt(1), ramp.claimedUnits]).toEqual([2, 1, 3]);
    expect(ramp.findRuntimeProblem()).toBeUndefined();
    // Nároky nie sú dock: dock drží kamión až od povelu do docku.
    expect([ramp.dockTruck(0), ramp.assignedDocks]).toEqual([null, 0]);
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
