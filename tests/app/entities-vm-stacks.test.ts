// TR2-05: VM stohov bloku (`ModuleVM.stacks`, `stackGeometry`) a nesený kontajner (`VehicleVM.cargo`, `TruckVM.cargo`) zo simu —
// štítky jednotky (veľkosť, typ, linka, smer) sa premietnu 1:1, pole stohov ide po riadkoch (riadok × bays + bay), 40′ stojí v dvoch bays.
import { describe, expect, it } from 'vitest';
import type { ContainerVM, ModuleVM } from '@render/view-models';
import type { CargoUnit, CargoUnitLabelsInput } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { YardBlock } from '@sim/modules';
import type { World } from '@sim/world';
import { moduleVMs, truckVMs, vehicleVMs } from '@app/entities-vm';
import { YARD_ID, buildFullChain, buildLogistics, buyVehicles, createApp, frameUntil, type App } from './app-fixtures';

const TEU = 'container_teu';
const id = (value: number): EntityId => value as EntityId;

function labels(lineId: string | null, sizeFt: 20 | 40, direction: 'import' | 'empty' = 'import'): CargoUnitLabelsInput {
  return { direction, voyageId: null, lineId, destinationPort: null, weightClass: 'medium', sizeFt };
}

/** Jednotka s danými štítkami pripravená vo vozidle `vehicleId` (reťaz §7.1 s fiktívnym žeriavom a berthom; import cez loď, prázdny cez kamión a rampu). */
function inVehicle(world: World, input: CargoUnitLabelsInput, vehicleId: EntityId = id(903)): CargoUnit {
  const empty = input.direction === 'empty';
  const unit = world.cargo.create(TEU, empty ? { kind: 'in_truck', truckId: id(950) } : { kind: 'on_ship', shipId: id(900) }, null, input);
  if (empty) {
    world.cargo.move(unit.id, { kind: 'at_ramp', rampId: id(960), dock: 0 });
  } else {
    world.cargo.move(unit.id, { kind: 'in_crane', craneId: id(901) });
    world.cargo.move(unit.id, { kind: 'on_apron', berthId: id(902), slot: 0 });
  }
  world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId });
  return world.cargo.get(unit.id) as CargoUnit;
}

function store(world: World, yard: YardBlock, unit: CargoUnit, bay: number, row: number, tier: number): void {
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: yard.id, slot: yard.slotOf(bay, row, tier) });
}

function logisticsApp(): App {
  const app = createApp();
  buildLogistics(app);
  return app;
}

/** Jednotku zo skladu späť do vozidla (uvoľní vrch stohu). */
function takeBack(world: World, unit: CargoUnit): void {
  world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: id(903) });
}

const yardVM = (world: World): ModuleVM => moduleVMs(world).find((vm) => vm.id === YARD_ID) as ModuleVM;
const stackAt = (vm: ModuleVM, bay: number, row: number) => (vm.stacks ?? []).find((stack) => stack.bay === bay && stack.row === row);
const lookOf = (unit: CargoUnit): ContainerVM => ({ sizeFt: unit.sizeFt, containerType: unit.containerType, lineId: unit.lineId, direction: unit.direction });

describe('ModuleVM.stacks / stackGeometry', () => {
  it('prázdny dvor: geometria z defu (4 × 4 × 3), 16 stohov po riadkoch, všetky s výškou 0 a bez vrchu; iné moduly stohy nemajú', () => {
    const app = logisticsApp();
    const vm = yardVM(app.world);
    expect(vm.stackGeometry).toEqual({ bays: 4, rows: 4, maxTier: 3 });
    expect(vm.stacks).toHaveLength(16);
    expect((vm.stacks ?? []).map((stack) => [stack.bay, stack.row])).toEqual(Array.from({ length: 16 }, (_, index) => [index % 4, Math.floor(index / 4)]));
    expect((vm.stacks ?? []).every((stack) => stack.height === 0 && stack.top === null)).toBe(true);
    for (const other of moduleVMs(app.world).filter((module) => !(app.world.modules.get(id(module.id)) instanceof YardBlock))) {
      expect(other.stacks).toBeUndefined();
      expect(other.stackGeometry).toBeUndefined();
    }
  });

  it('výška a vrchný kontajner so štítkami (veľkosť, typ, linka, smer); 40′ stojí v páre bays; odobratie vrchu zníži výšku', () => {
    const app = logisticsApp();
    const yard = app.world.modules.get(YARD_ID) as YardBlock;
    const low = inVehicle(app.world, labels('blue_anchor', 20));
    const high = inVehicle(app.world, labels('northern_star', 20, 'empty'));
    const wide = inVehicle(app.world, labels('golden_wave', 40));
    store(app.world, yard, low, 0, 0, 0);
    store(app.world, yard, high, 0, 0, 1);
    store(app.world, yard, wide, 2, 1, 0);
    const vm = yardVM(app.world);
    expect(stackAt(vm, 0, 0)).toEqual({ bay: 0, row: 0, height: 2, top: lookOf(high) });
    expect(stackAt(vm, 0, 0)?.top).toEqual({ sizeFt: 20, containerType: 'dry', lineId: 'northern_star', direction: 'empty' });
    expect(stackAt(vm, 2, 1)).toEqual({ bay: 2, row: 1, height: 1, top: { sizeFt: 40, containerType: 'dry', lineId: 'golden_wave', direction: 'import' } });
    expect(stackAt(vm, 3, 1)).toEqual({ bay: 3, row: 1, height: 1, top: lookOf(wide) }); // bunka tieňa 40′
    expect(stackAt(vm, 1, 0)).toEqual({ bay: 1, row: 0, height: 0, top: null });

    takeBack(app.world, high);
    expect(stackAt(yardVM(app.world), 0, 0)).toEqual({ bay: 0, row: 0, height: 1, top: lookOf(low) });
  });
});

describe('VehicleVM.cargo', () => {
  it('prázdne vozidlo `cargo` nemá; naložené nesie štítky kontajnera (veľkosť, typ, linka, smer) a prázdny kontajner nesie smer empty', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 1);
    const vehicle = [...app.world.vehicles.values()][0];
    if (vehicle === undefined) throw new Error('vozidlo chýba');
    expect(vehicleVMs(app.world)[0]?.cargo).toBeUndefined();

    const unit = inVehicle(app.world, labels('golden_wave', 40), vehicle.id);
    expect(vehicleVMs(app.world)[0]?.cargo).toEqual({ sizeFt: 40, containerType: 'dry', lineId: 'golden_wave', direction: 'import' });
    expect(vehicleVMs(app.world)[0]?.cargo).toEqual(lookOf(unit));

    app.world.cargo.move(unit.id, { kind: 'in_storage', moduleId: YARD_ID, slot: (app.world.modules.get(YARD_ID) as YardBlock).slotOf(0, 0, 0) });
    expect(vehicleVMs(app.world)[0]?.cargo).toBeUndefined();
    const empty = inVehicle(app.world, labels('blue_anchor', 20, 'empty'), vehicle.id);
    expect(vehicleVMs(app.world)[0]).toMatchObject({ loaded: true, carriesEmpty: true, cargo: lookOf(empty) });
  });
});

describe('TruckVM.cargo', () => {
  it('kamión v behu reťazca: `cargo` je prítomné práve pri `loaded` a zhoduje sa so štítkami prvej jednotky na kamióne', () => {
    const app = createApp();
    buildFullChain(app, { units: 6 });
    frameUntil(app, () => truckVMs(app.world).some((truck) => truck.loaded), 6000);
    for (const vm of truckVMs(app.world)) {
      if (!vm.loaded) {
        expect(vm.cargo).toBeUndefined();
        continue;
      }
      const unitId = app.world.cargo.unitAtIndex('in_truck', id(vm.id), 0) as EntityId;
      expect(vm.cargo).toEqual(lookOf(app.world.cargo.get(unitId) as CargoUnit));
    }
  });
});
