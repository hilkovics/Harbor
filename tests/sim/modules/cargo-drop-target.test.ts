// Cieľ doručenia jobu a zápis výdaja (T04-03, ADR-023): `Module.cargoDropTarget()` — sklad (slot, `in_storage`) a rampa
// (dock, `at_ramp`) s rovnakým tokom rezervácia → assertCommittable → CargoLedger.move → commit, zrušenie `release`,
// obnova `restoreReservation`; ostatné moduly cieľom nie sú. `Module.recordTaken` — sklad počíta `unitsOut`, apron nič.
import { describe, expect, it } from 'vitest';
import type { CargoLedger } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { LoadingRamp, ModuleError, StorageModule, moduleRegistry, type Module, type ModuleErrorCode } from '@sim/modules';
import { DEFS } from '../world/world-fixtures';
import { berthOn, emptyCargo, id, quayGrid } from './module-fixtures';

const GRID = quayGrid(20, 12);

function create(defId: string, cargo: CargoLedger, moduleId: number): Module {
  return moduleRegistry.create(DEFS.modules.get(defId), { defId, x: 2, y: 2, rotation: 0 }, id(moduleId), 0, { grid: GRID, cargo });
}

function yardOf(cargo: CargoLedger = emptyCargo(DEFS)): StorageModule {
  const module = create('container_yard_small', cargo, 10);
  if (!(module instanceof StorageModule)) throw new Error('container_yard_small nie je StorageModule');
  return module;
}

function rampOf(cargo: CargoLedger = emptyCargo(DEFS)): LoadingRamp {
  const module = create('loading_ramp_container', cargo, 20);
  if (!(module instanceof LoadingRamp)) throw new Error('loading_ramp_container nie je LoadingRamp');
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

/** Jednotka po ceste §7.1 až do vozidla 902 (fiktívni držitelia — ledger overuje len prechody). */
function unitInVehicle(cargo: CargoLedger): EntityId {
  const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) }).id;
  cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
  cargo.move(unit, { kind: 'on_apron', berthId: id(903), slot: 0 });
  cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(902) });
  return unit;
}

describe('StorageModule.cargoDropTarget — slot skladu', () => {
  it('druh in_storage, kategória a počet miest zo skladu; vždy ten istý zmrazený objekt', () => {
    const yard = yardOf();
    const target = yard.cargoDropTarget();
    expect([target.kind, target.category, target.places]).toEqual(['in_storage', 'container', 64]);
    expect(yard.cargoDropTarget()).toBe(target);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it('rezervácia → assertCommittable → move → commit (unitsIn); reservationsAt 0/1, mimo rozsahu 0 bez chyby', () => {
    const cargo = emptyCargo(DEFS);
    const yard = yardOf(cargo);
    const target = yard.cargoDropTarget();
    const slot = yard.reserve();
    expect([target.reservationsAt(slot), target.reservationsAt(slot + 1), target.reservationsAt(-1), target.reservationsAt(64), target.reservationsAt(0.5)]).toEqual([1, 0, 0, 0, 0]);
    const unit = unitInVehicle(cargo);
    target.assertCommittable(slot, unit);
    cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot });
    target.commit(slot, unit);
    expect([yard.storedCount, yard.reservedCount, yard.unitsIn, target.reservationsAt(slot)]).toEqual([1, 0, 1, 0]);
  });

  it('release zruší rezerváciu; restoreReservation = reserveSlot (obsadený alebo rezervovaný slot → chyba)', () => {
    const yard = yardOf();
    const target = yard.cargoDropTarget();
    target.restoreReservation(5);
    expect(yard.reservedSlots()).toEqual([5]);
    expect(errorCode(() => target.restoreReservation(5))).toBe('slot_reserved');
    expect(errorCode(() => target.restoreReservation(64))).toBe('invalid_slot');
    target.release(5);
    expect(yard.reservedCount).toBe(0);
    expect(errorCode(() => target.release(5))).toBe('slot_not_reserved');
  });

  it('recordTaken (prepis háčika Module): po presune von unitsOut + 1, jednotka stále v sklade → unit_still_held', () => {
    const cargo = emptyCargo(DEFS);
    const yard = yardOf(cargo);
    const unit = unitInVehicle(cargo);
    cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot: 0 });
    const asModule: Module = yard;
    expect(errorCode(() => asModule.recordTaken(unit))).toBe('unit_still_held');
    cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(904) });
    asModule.recordTaken(unit);
    expect(yard.unitsOut).toBe(1);
  });
});

describe('LoadingRamp.cargoDropTarget — staging dock rampy', () => {
  it('druh at_ramp, kategória rampy, miest = docks; vždy ten istý zmrazený objekt', () => {
    const ramp = rampOf();
    const target = ramp.cargoDropTarget();
    expect([target.kind, target.category, target.places]).toEqual(['at_ramp', 'container', 2]);
    expect(ramp.cargoDropTarget()).toBe(target);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it('reserve(dock) → assertCommittable → move na dock → commit: rezervácia zanikne, staged + 1; reservationsAt = reservedAt, mimo rozsahu 0', () => {
    const cargo = emptyCargo(DEFS);
    const ramp = rampOf(cargo);
    const target = ramp.cargoDropTarget();
    ramp.reserve(1);
    ramp.reserve(1);
    expect([target.reservationsAt(0), target.reservationsAt(1), target.reservationsAt(2), target.reservationsAt(-1)]).toEqual([0, 2, 0, 0]);
    const unit = unitInVehicle(cargo);
    target.assertCommittable(1, unit);
    cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock: 1 });
    target.commit(1, unit);
    expect([ramp.stagedAt(1), ramp.reservedAt(1), target.reservationsAt(1)]).toEqual([1, 1, 1]);
    expect(errorCode(() => target.assertCommittable(0, unit))).toBe('slot_not_reserved');
  });

  it('restoreReservation = reserve(dock): nad stagingPerDock → no_free_slot, dock mimo rozsahu → invalid_slot; release', () => {
    const ramp = rampOf();
    const target = ramp.cargoDropTarget();
    const per = ramp.stagingPerDock;
    for (let i = 0; i < per; i++) target.restoreReservation(0);
    expect(errorCode(() => target.restoreReservation(0))).toBe('no_free_slot');
    expect(errorCode(() => target.restoreReservation(2))).toBe('invalid_slot');
    target.release(0);
    expect([ramp.reservedAt(0), ramp.freeAt(0)]).toEqual([per - 1, 1]);
  });
});

describe('ostatné moduly', () => {
  it('kotvisko nie je cieľ doručenia a recordTaken nerobí nič (slot apronu uvoľní presun v ledgeri)', () => {
    const cargo = emptyCargo(DEFS);
    const berth = berthOn(GRID, 30, { x: 2, y: 2 }, 0, 'berth_standard', cargo);
    expect(berth.cargoDropTarget()).toBeUndefined();
    const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) }).id;
    cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
    cargo.move(unit, { kind: 'on_apron', berthId: berth.id, slot: 0 });
    cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(902) });
    expect(() => berth.recordTaken(unit)).not.toThrow();
    expect(berth.getRuntimeState()).toEqual({ lastNoStorageHour: null });
  });
});
