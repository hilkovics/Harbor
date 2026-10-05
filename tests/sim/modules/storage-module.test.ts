// StorageModule + ContainerYard (T03-02; ARCHITECTURE §5.3, §7.7; ADR-017): sklad drží len rezervácie slotov
// a počítadlá unitsIn/unitsOut, obsadenie číta z CargoLedger (review T02-13). Tok job → reserve → presun do skladu →
// commit (unitsIn), výdaj → recordTaken (unitsOut), runtime stav v save a jeho fail-fast obnova.
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { describe, expect, it } from 'vitest';
import type { CargoLedger } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { DefError, DefRegistry, type ModuleDef } from '@sim/defs';
import {
  ContainerYard,
  ModuleError,
  ModuleStateError,
  StorageModule,
  moduleRegistry,
  type ModuleErrorCode,
  type YardRuntimeState,
} from '@sim/modules';
import { RAW_DEFS } from '../world/world-fixtures';
import { BERTH, emptyCargo, id, quayGrid } from './module-fixtures';

const YARD = 'container_yard_small';
const TINY_YARD = 'yard_tiny_test';
const SILO = 'silo_test';
const YARD_ID = id(10);

const [, , yardJson] = modulesJson.items;
const DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: [
      ...modulesJson.items,
      { ...yardJson, id: TINY_YARD, params: { capacityUnits: 2, category: 'container', internalTicks: 4 } },
      { ...yardJson, id: SILO, params: { capacityUnits: 24, category: 'bulk' } },
    ],
  },
});
const GRID = quayGrid(12, 12);

function yardOf(defId = YARD, cargo: CargoLedger = emptyCargo(DEFS)): { yard: StorageModule; cargo: CargoLedger } {
  const module = moduleRegistry.create(DEFS.modules.get(defId), { defId, x: 2, y: 2, rotation: 0 }, YARD_ID, 0, { grid: GRID, cargo });
  if (!(module instanceof StorageModule)) throw new Error(`${defId} nie je StorageModule`);
  return { yard: module, cargo };
}

/** Jednotka po reťazci §7.1 až vo vozidle (pred vykládkou do skladu). */
function unitInVehicle(cargo: CargoLedger): EntityId {
  const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) }).id;
  cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
  cargo.move(unit, { kind: 'on_apron', berthId: id(902), slot: 0 });
  cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
  return unit;
}

/** Vykládka do skladu tak, ako ju spraví vozidlo (T03-06): kontrola → presun v ledgeri → commit. */
function store(yard: StorageModule, cargo: CargoLedger, slot: number, unit = unitInVehicle(cargo)): EntityId {
  yard.assertCommittable(slot, unit);
  cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot });
  yard.commit(slot, unit);
  return unit;
}

function snapshot(yard: StorageModule) {
  return {
    stored: yard.storedCount,
    reserved: yard.reservedCount,
    free: yard.freeCount,
    in: yard.unitsIn,
    out: yard.unitsOut,
    units: yard.units(),
    reservedSlots: yard.reservedSlots(),
    runtime: yard.getRuntimeState(),
  };
}

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectModuleError(action: () => unknown, code: ModuleErrorCode): void {
  const error = errorOf(action);
  expect(error).toBeInstanceOf(ModuleError);
  expect((error as ModuleError).code).toBe(code);
}

describe('ContainerYard — z defu container_yard_small', () => {
  it('kapacita 48 TEU (4 × 4 × 3), kategória container, prázdny, počítadlá 0; sloty in_storage u modulu', () => {
    const { yard } = yardOf();
    expect(yard).toBeInstanceOf(ContainerYard);
    expect([yard.capacity, yard.category, yard.storedCount, yard.reservedCount, yard.freeCount]).toEqual([48, 'container', 0, 0, 48]);
    expect([yard.unitsIn, yard.unitsOut]).toEqual([0, 0]);
    expect(yard.params).toEqual({ capacityUnits: 48, category: 'container', bays: 4, rows: 4, maxTier: 3 });
    const slots = yard.cargoSlots();
    expect([slots.kind, slots.holderId, slots.capacity]).toEqual(['in_storage', YARD_ID, 48]);
    expect(yard.getRuntimeState()).toEqual({ unitsIn: 0, unitsOut: 0, rehandles: 0 } satisfies YardRuntimeState);
  });

  it('konektor po rotácii je vo `connectors` (1, 3, s) → svet (3, 5, s)', () => {
    const { yard } = yardOf();
    expect(yard.connectors).toEqual([{ x: 3, y: 5, side: 's', type: 'road' }]);
  });

  it('trieda nesedí s kategóriou defu → invalid_input; def iného druhu → DefError', () => {
    const cargo = emptyCargo(DEFS);
    const init = (def: Readonly<ModuleDef>) => ({ def, id: YARD_ID, origin: { x: 0, y: 0 }, rotation: 0 as const, purchaseCostCents: 0, grid: GRID, cargo });
    expectModuleError(() => new ContainerYard(init(DEFS.modules.get(SILO))), 'invalid_input');
    expect(errorOf(() => new ContainerYard(init(DEFS.modules.get(BERTH))))).toBeInstanceOf(DefError);
  });
});

describe('StorageModule — rezervácie a obsadenie z ledgera', () => {
  it('reserve → presun do skladu → commit: rezervácia zaniká, stored z ledgera, unitsIn += 1', () => {
    const { yard, cargo } = yardOf();
    const slot = yard.reserve();
    expect([slot, yard.reservedCount, yard.freeCount, yard.isReserved(slot)]).toEqual([0, 1, 47, true]);
    const unit = store(yard, cargo, slot);
    expect([yard.storedCount, yard.reservedCount, yard.freeCount, yard.unitsIn]).toEqual([1, 0, 47, 1]);
    expect([yard.unitAt(slot), yard.slotOf(unit), yard.units()]).toEqual([unit, slot, [unit]]);
  });

  it('plný sklad (stored + reserved = capacity) → reserve() no_free_slot bez zmeny', () => {
    const { yard, cargo } = yardOf(TINY_YARD);
    store(yard, cargo, yard.reserve());
    yard.reserve();
    const before = snapshot(yard);
    expectModuleError(() => yard.reserve(), 'no_free_slot');
    expect(snapshot(yard)).toEqual(before);
  });

  it('release zruší rezerváciu (zrušený job); bez rezervácie → slot_not_reserved', () => {
    const { yard } = yardOf(TINY_YARD);
    const slot = yard.reserve();
    yard.release(slot);
    expect([yard.reservedCount, yard.freeCount]).toEqual([0, 2]);
    expectModuleError(() => yard.release(slot), 'slot_not_reserved');
  });

  it('commit bez presunu v ledgeri → unit_not_at_slot a unitsIn sa nezmení; assertCommittable bez rezervácie → slot_not_reserved', () => {
    const { yard, cargo } = yardOf(TINY_YARD);
    const unit = unitInVehicle(cargo);
    expectModuleError(() => yard.assertCommittable(1, unit), 'slot_not_reserved');
    const slot = yard.reserve();
    const before = snapshot(yard);
    expectModuleError(() => yard.commit(slot, unit), 'unit_not_at_slot');
    expect(snapshot(yard)).toEqual(before);
  });

  it('recordTaken: jednotka ešte v sklade → unit_still_held; po presune von → unitsOut += 1 a slot je voľný', () => {
    const { yard, cargo } = yardOf(TINY_YARD);
    const unit = store(yard, cargo, yard.reserve());
    expectModuleError(() => yard.recordTaken(unit), 'unit_still_held');
    expect(yard.unitsOut).toBe(0);
    cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
    yard.recordTaken(unit);
    expect([yard.storedCount, yard.unitsOut, yard.unitsIn, yard.freeCount]).toEqual([0, 1, 1, 2]);
    expect(yard.reserve()).toBe(0);
  });

  it('jednotky iného skladu sa nepočítajú; unitAt mimo rozsahu → invalid_slot', () => {
    const cargo = emptyCargo(DEFS);
    const { yard } = yardOf(TINY_YARD, cargo);
    const unit = unitInVehicle(cargo);
    cargo.move(unit, { kind: 'in_storage', moduleId: id(77), slot: 0 });
    expect([yard.storedCount, yard.unitAt(0), yard.slotOf(unit)]).toEqual([0, null, undefined]);
    expectModuleError(() => yard.unitAt(2), 'invalid_slot');
  });

  it('findProblem (krok 12): rezervovaný slot obsadený presunom bez commit', () => {
    const { yard, cargo } = yardOf(TINY_YARD);
    const slot = yard.reserve();
    cargo.move(unitInVehicle(cargo), { kind: 'in_storage', moduleId: yard.id, slot });
    expect(yard.cargoSlots().findProblem()).toMatch(/sklad yard_tiny_test #10: rezervovaný slot 0 obsadila jednotka/);
  });
});

describe('StorageModule — runtime stav v save', () => {
  it('getRuntimeState = len počítadlá (rezervácie patria jobom, ADR-018); restore na novej inštancii dá rovnaké počítadlá bez rezervácií', () => {
    const { yard, cargo } = yardOf();
    const [, b] = [yard.reserve(), yard.reserve(), yard.reserve()];
    const unit = store(yard, cargo, b);
    cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(903) });
    yard.recordTaken(unit);
    const state = yard.getRuntimeState();
    expect(state).toEqual({ unitsIn: 1, unitsOut: 1, rehandles: 0 });
    const copy = yardOf(YARD, cargo).yard;
    copy.restoreRuntimeState(JSON.parse(JSON.stringify(state)));
    expect([copy.unitsIn, copy.unitsOut, copy.reservedCount, copy.storedCount]).toEqual([1, 1, 0, 0]);
    expect(copy.getRuntimeState()).toEqual(state);
  });

  it('reserveSlot (obnova rezervácie jobu): konkrétny voľný slot; mimo rozsahu, obsadený alebo už rezervovaný → ModuleError', () => {
    const { yard, cargo } = yardOf(TINY_YARD);
    yard.reserveSlot(1);
    expect([yard.reservedSlots(), yard.reservedCount, yard.freeCount]).toEqual([[1], 1, 1]);
    expectModuleError(() => yard.reserveSlot(1), 'slot_reserved');
    expectModuleError(() => yard.reserveSlot(2), 'invalid_slot');
    cargo.move(unitInVehicle(cargo), { kind: 'in_storage', moduleId: yard.id, slot: 0 });
    expectModuleError(() => yard.reserveSlot(0), 'slot_occupied');
    expect(yard.reservedSlots()).toEqual([1]);
  });

  const INVALID: readonly [string, unknown, string][] = [
    ['nie objekt', null, ''],
    ['chýba unitsOut', { unitsIn: 0, rehandles: 0 }, '/unitsOut'],
    ['chýba rehandles (R2, ADR-039)', { unitsIn: 0, unitsOut: 0 }, '/rehandles'],
    ['neznámy kľúč', { unitsIn: 0, unitsOut: 0, rehandles: 0, stored: [] }, '/stored'],
    ['reservedSlots (v2 tvar, v3 ho nepozná)', { reservedSlots: [], unitsIn: 0, unitsOut: 0, rehandles: 0 }, '/reservedSlots'],
    ['unitsIn záporné', { unitsIn: -1, unitsOut: 0, rehandles: 0 }, '/unitsIn'],
    ['unitsOut zlomkové', { unitsIn: 0, unitsOut: 1.5, rehandles: 0 }, '/unitsOut'],
    ['rehandles záporné', { unitsIn: 0, unitsOut: 0, rehandles: -1 }, '/rehandles'],
  ];

  it.each(INVALID)('%s → ModuleStateError na %s, stav sa nezmení', (_name, raw, path) => {
    const { yard } = yardOf(TINY_YARD);
    yard.reserve();
    const before = snapshot(yard);
    const error = errorOf(() => yard.restoreRuntimeState(raw));
    expect(error).toBeInstanceOf(ModuleStateError);
    expect((error as ModuleStateError).path).toBe(path);
    expect(snapshot(yard)).toEqual(before);
  });
});
