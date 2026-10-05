// F5b č. 8: `ModuleVM.lastStorageOp` — posledná operácia s kontajnerom na slote skladu (podklad pre animáciu portálového žeriavu
// dvora). Sim ju nevedie: `StorageOpTracker` ju skladá z udalostí `CargoMoved`, `SimBridge` ju dopĺňa do VM skladov.
import { describe, expect, it } from 'vitest';
import type { CargoLocation } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { StorageOpTracker } from '@app/storage-ops';
import { entitiesVM, moduleVMs } from '@app/entities-vm';
import { YARD_ID, YARD_2_ID, buildLogistics, buyVehicles, createApp, frameUntil, runCommands } from './app-fixtures';

const id = (value: number): EntityId => value as EntityId;

function moved(from: CargoLocation, to: CargoLocation, tick: number): SimEvent {
  return { type: 'CargoMoved', unitId: id(9), from, to, tick };
}

const inVehicle: CargoLocation = { kind: 'in_vehicle', vehicleId: id(20) };
const inYard = (moduleId: number, slot: number): CargoLocation => ({ kind: 'in_storage', moduleId: id(moduleId), slot });

describe('StorageOpTracker', () => {
  it('bez udalostí nemá žiadnu operáciu', () => {
    expect(new StorageOpTracker().view.size).toBe(0);
  });

  it('`CargoMoved` do `in_storage` je put, z `in_storage` take; zapíše sa modul, slot a tick', () => {
    const tracker = new StorageOpTracker();
    tracker.record([moved(inVehicle, inYard(4, 13), 207)]);
    expect(tracker.view.get(4)).toEqual({ slot: 13, tick: 207, kind: 'put' });
    tracker.record([moved(inYard(4, 13), inVehicle, 300)]);
    expect(tracker.view.get(4)).toEqual({ slot: 13, tick: 300, kind: 'take' });
  });

  it('neskoršia operácia v rovnakom poli prepíše skoršiu; sklady sa sledujú nezávisle', () => {
    const tracker = new StorageOpTracker();
    tracker.record([
      moved(inVehicle, inYard(4, 1), 10),
      moved(inVehicle, inYard(5, 7), 11),
      moved(inVehicle, inYard(4, 2), 12),
    ]);
    expect(tracker.view.get(4)).toEqual({ slot: 2, tick: 12, kind: 'put' });
    expect(tracker.view.get(5)).toEqual({ slot: 7, tick: 11, kind: 'put' });
  });

  it('presuny mimo skladov (loď → žeriav → apron → vozidlo) nič nezapisujú', () => {
    const tracker = new StorageOpTracker();
    tracker.record([
      moved({ kind: 'on_ship', shipId: id(1) }, { kind: 'in_crane', craneId: id(2) }, 1),
      moved({ kind: 'on_apron', berthId: id(1), slot: 0 }, inVehicle, 2),
      { type: 'RoadChanged', cells: [] } as unknown as SimEvent,
    ]);
    expect(tracker.view.size).toBe(0);
  });

  it('`ModuleRemoved` zabudne operáciu odstráneného skladu', () => {
    const tracker = new StorageOpTracker();
    tracker.record([moved(inVehicle, inYard(4, 1), 10), moved(inVehicle, inYard(5, 2), 10)]);
    tracker.record([{ type: 'ModuleRemoved', moduleId: id(4), defId: 'container_yard_small', cells: [] }]);
    expect(tracker.view.has(4)).toBe(false);
    expect(tracker.view.get(5)).toEqual({ slot: 2, tick: 10, kind: 'put' });
  });
});

describe('lastStorageOp vo view-modeli skladu (SimBridge ← udalosti)', () => {
  function logisticsApp() {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 2);
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    return app;
  }

  it('nový svet a čistá funkcia `moduleVMs` bez operácií: sklady nemajú `lastStorageOp`', () => {
    const app = createApp();
    buildLogistics(app);
    for (const vm of app.bridge.snapshot().modules) expect(vm.lastStorageOp).toBeUndefined();
    for (const vm of moduleVMs(app.world)) expect(vm.lastStorageOp).toBeUndefined();
  });

  it('po uložení kontajnera vozidlom dvor nesie put so slotom, ktorý ledger zapísal; moduly bez skladu operáciu nemajú', () => {
    const app = logisticsApp();
    const yards = [YARD_ID, YARD_2_ID];
    frameUntil(app, () => app.bridge.snapshot().modules.some((vm) => vm.lastStorageOp !== undefined), 6000);
    const modules = app.bridge.snapshot().modules;
    const withOp = modules.filter((vm) => vm.lastStorageOp !== undefined);
    expect(withOp.length).toBeGreaterThan(0);
    for (const vm of withOp) {
      expect(vm.kind).toBe('storage');
      expect(yards.includes(id(vm.id))).toBe(true);
      const op = vm.lastStorageOp!;
      expect(op.kind).toBe('put');
      expect(Number.isInteger(op.slot)).toBe(true);
      expect(op.tick).toBeLessThanOrEqual(app.world.clock.tick);
      // slot z operácie je naozaj obsadený jednotkou v ledgeri
      const module = app.world.modules.get(id(vm.id));
      expect(module).toBeDefined();
      expect(app.world.cargo.unitAtSlot('in_storage', id(vm.id), op.slot)).toBeDefined();
    }
    for (const vm of modules.filter((candidate) => candidate.kind !== 'storage')) expect(vm.lastStorageOp).toBeUndefined();
  });

  it('operácia sa prenesie do `entities()` aj do snapshotu a mení sa s každým presunom na slote', () => {
    const app = logisticsApp();
    const seen = new Set<string>();
    frameUntil(
      app,
      () => {
        for (const vm of app.bridge.entities().modules) {
          if (vm.lastStorageOp !== undefined) seen.add(`${String(vm.id)}:${String(vm.lastStorageOp.slot)}:${String(vm.lastStorageOp.tick)}`);
        }
        expect(app.bridge.entities().modules).toEqual(app.bridge.snapshot().modules);
        return seen.size >= 3;
      },
      8000,
    );
    expect(seen.size).toBeGreaterThanOrEqual(3); // každé uloženie je nová operácia (iný slot alebo tick)
  });

  it('čistá `entitiesVM(world, …, storageOps)` dopĺňa operáciu podľa `id` skladu', () => {
    const app = createApp();
    buildLogistics(app);
    const tracker = new StorageOpTracker();
    tracker.record([moved(inVehicle, inYard(YARD_ID, 5), 42)]);
    const vm = entitiesVM(app.world, undefined, undefined, undefined, tracker.view).modules.find((module) => module.id === YARD_ID);
    expect(vm?.lastStorageOp).toEqual({ slot: 5, tick: 42, kind: 'put' });
    const other = entitiesVM(app.world, undefined, undefined, undefined, tracker.view).modules.find((module) => module.id === YARD_2_ID);
    expect(other?.lastStorageOp).toBeUndefined();
  });
});
