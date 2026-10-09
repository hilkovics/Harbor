// Cieľ doručenia jobu a zápis výdaja (T04-03, ADR-023): `Module.cargoDropTarget()` — sklad (slot, `in_storage`) s tokom rezervácia → assertCommittable → CargoLedger.move → commit, zrušenie `release`,
// obnova `restoreReservation`; ostatné moduly cieľom nie sú. `Module.recordTaken` — sklad počíta `unitsOut`, apron nič.
import { describe, expect, it } from 'vitest';
import type { CargoLedger } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { ModuleError, StorageModule, moduleRegistry, type Module, type ModuleErrorCode } from '@sim/modules';
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
    expect([target.kind, target.category, target.places]).toEqual(['in_storage', 'container', 48]);
    expect(yard.cargoDropTarget()).toBe(target);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it('rezervácia → assertCommittable → move → commit (unitsIn); reservationsAt 0/1, mimo rozsahu 0 bez chyby', () => {
    const cargo = emptyCargo(DEFS);
    const yard = yardOf(cargo);
    const target = yard.cargoDropTarget();
    const slot = yard.reserve();
    expect([target.reservationsAt(slot), target.reservationsAt(slot + 1), target.reservationsAt(-1), target.reservationsAt(48), target.reservationsAt(0.5)]).toEqual([1, 0, 0, 0, 0]);
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
    expect(errorCode(() => target.restoreReservation(48))).toBe('invalid_slot');
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

describe('ostatné moduly', () => {
  it('kotvisko je cieľ nakládky exportu (slot apronu, ľubovoľná kategória) a recordTaken nerobí nič (slot apronu uvoľní presun v ledgeri)', () => {
    const cargo = emptyCargo(DEFS);
    const berth = berthOn(GRID, 30, { x: 2, y: 2 }, 0, 'berth_standard', cargo);
    const target = berth.cargoDropTarget();
    expect([target?.kind, target?.category, target?.reserves, target?.places]).toEqual(['on_apron', null, true, 8]);
    // Rezervácia slotu: slot 3 sa rezervuje cez cieľ, `release` ho uvoľní, `commit` po presune premení rezerváciu na obsadenie.
    target?.restoreReservation(3);
    expect([target?.reservationsAt(3), target?.reservationsAt(2), target?.reservationsAt(99), berth.apron.reservedSlots()]).toEqual([1, 0, 0, [3]]);
    target?.release(3);
    expect(berth.apron.reservedCount).toBe(0);
    const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) }).id;
    cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
    cargo.move(unit, { kind: 'on_apron', berthId: berth.id, slot: 0 });
    cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(902) });
    expect(() => berth.recordTaken(unit)).not.toThrow();
    expect(berth.getRuntimeState()).toEqual({ lastNoStorageHour: null });
  });
});
