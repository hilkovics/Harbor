// VehicleDepot (T03-02; ARCHITECTURE §5.3; rozhodnutie orchestrátora F3 č. 4; ADR-017): státia `params.capacity`,
// zoznam vozidiel `vehicleIds` spravuje World (T03-04) cez attach/detach, runtime stav je {} (odvodí sa z vozidiel).
import { describe, expect, it } from 'vitest';
import { DefError } from '@sim/defs';
import { ModuleError, VehicleDepot, moduleRegistry, type ModuleErrorCode } from '@sim/modules';
import { BERTH, MODULE_DEFS, emptyCargo, id, quayGrid } from './module-fixtures';

const DEPOT = 'vehicle_depot';
const GRID = quayGrid(10, 10);

function depotOf(): VehicleDepot {
  const module = moduleRegistry.create(MODULE_DEFS.modules.get(DEPOT), { defId: DEPOT, x: 1, y: 1, rotation: 0 }, id(5), 0, {
    grid: GRID,
    cargo: emptyCargo(),
  });
  if (!(module instanceof VehicleDepot)) throw new Error('vehicle_depot nie je VehicleDepot');
  return module;
}

function expectModuleError(action: () => unknown, code: ModuleErrorCode): void {
  let error: unknown;
  try {
    action();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ModuleError);
  expect((error as ModuleError).code).toBe(code);
}

describe('VehicleDepot', () => {
  it('z defu: 6 státí, bez vozidiel, bez slotov nákladu, runtime {}; konektor (1, 2, s) → svet (2, 3, s)', () => {
    const depot = depotOf();
    expect([depot.capacity, depot.freeStalls, depot.vehicleIds]).toEqual([6, 6, []]);
    expect(depot.params).toEqual({ capacity: 6 });
    expect(depot.cargoSlots()).toBeUndefined();
    expect(depot.getRuntimeState()).toEqual({});
    expect(depot.connectors).toEqual([{ x: 2, y: 3, side: 's', type: 'road' }]);
  });

  it('attach/detach v poradí pripojenia; freeStalls sa mení', () => {
    const depot = depotOf();
    depot.attachVehicle(id(20));
    depot.attachVehicle(id(21));
    depot.attachVehicle(id(22));
    expect([depot.vehicleIds, depot.freeStalls]).toEqual([[20, 21, 22], 3]);
    depot.detachVehicle(id(21));
    expect([depot.vehicleIds, depot.freeStalls]).toEqual([[20, 22], 4]);
  });

  it('duplicitné vozidlo → duplicate_id, plné depo → depot_full, cudzie vozidlo → unknown_vehicle; stav sa nezmení', () => {
    const depot = depotOf();
    for (let i = 0; i < depot.capacity; i++) depot.attachVehicle(id(30 + i));
    const before = [...depot.vehicleIds];
    expectModuleError(() => depot.attachVehicle(id(30)), 'duplicate_id');
    expectModuleError(() => depot.attachVehicle(id(99)), 'depot_full');
    expectModuleError(() => depot.detachVehicle(id(99)), 'unknown_vehicle');
    expect(depot.vehicleIds).toEqual(before);
    expect(depot.freeStalls).toBe(0);
  });

  it('def iného druhu → DefError', () => {
    const def = MODULE_DEFS.modules.get(BERTH);
    const init = { def, id: id(1), origin: { x: 0, y: 0 }, rotation: 0 as const, purchaseCostCents: 0, grid: GRID, cargo: emptyCargo() };
    let error: unknown;
    try {
      new VehicleDepot(init);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DefError);
  });
});
