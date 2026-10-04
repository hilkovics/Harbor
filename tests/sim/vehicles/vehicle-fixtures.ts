// Pomôcky testov vozidiel (T03-04, T03-05): svet s pripojeným depom a dvorom na starter parcele harbor_01, vozidlo priamo
// cez World.addVehicle (bez príkazu), vozidlo s nákladom uprostred jobu a vykonanie JSON príkazu.
import cargoTypesJson from '@data/defs/cargo_types.json';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { TransportJob } from '@sim/logistics';
import type { StorageModule, VehicleDepot } from '@sim/modules';
import { Vehicle, type VehicleInit } from '@sim/vehicles';
import { World } from '@sim/world';
import { DEFS, MAP, RAW_DEFS, SEED } from '../world/world-fixtures';

export const STRADDLE = 'straddle_carrier';
export const STRADDLE_DEF = DEFS.vehicles.get(STRADDLE);

/** Sypký typ nákladu pre testy kategórie (straddle carrier ho nevozí). */
export const GRAIN = 'grain_test';

/** Bundled defy + `GRAIN` (kategória `bulk`). */
export const GRAIN_DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  cargo_types: {
    ...cargoTypesJson,
    items: [
      ...cargoTypesJson.items,
      { id: GRAIN, category: 'bulk', unitName: 't', unitsPerBatch: 25, basePricePerUnitCents: 1200, exportPricePerUnitCents: 1000, repositioningPricePerUnitCents: 300, transhipPricePerUnitCents: 700, xpPerUnit: 1, colorToken: 'cargo-bulk' },
    ],
  },
});

/** Jednotka po reťazci §7.1 až vo vozidle `vehicleId` (len ledger; loď, žeriav a apron nemusia existovať). */
export function loadInto(world: World, vehicleId: EntityId, typeId = 'container_teu'): EntityId {
  const holder = (value: number): EntityId => value as EntityId;
  const unit = world.cargo.create(typeId, { kind: 'on_ship', shipId: holder(900) }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: holder(901) });
  world.cargo.move(unit, { kind: 'on_apron', berthId: holder(902), slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId });
  return unit;
}

/**
 * Rozloženie na starter parcele (x 30–57, y 14–33): depo 3×3 na (34, 20) má konektor (35, 22, s) → vonkajšia bunka
 * (35, 23); dvor 4×4 na (50, 20..23) má konektor (51, 23, s) → vonkajšia bunka (51, 24). Cesta (35, 23) → (35, 24)
 * a pozdĺž y = 24 po x = 51 ich spája (mimo footprintov).
 */
export const DEPOT_ORIGIN = { x: 34, y: 20 };
export const DEPOT_OUTSIDE = { x: 35, y: 23 };
export const YARD_ORIGIN = { x: 50, y: 20 };
export const YARD_OUTSIDE = { x: 51, y: 24 };
export const LAYOUT_ROADS = [DEPOT_OUTSIDE, ...Array.from({ length: YARD_OUTSIDE.x - DEPOT_OUTSIDE.x + 1 }, (_, i) => ({ x: DEPOT_OUTSIDE.x + i, y: 24 }))];

/** Enqueue + `applyPending`: udalosti príkazu. */
export function execute(world: World, command: SerializedCommand): readonly SimEvent[] {
  world.enqueue(commandFromJSON(command));
  return world.applyPending();
}

export const buy = (depotId: number, vehicleDefId = STRADDLE): SerializedCommand => ({ type: 'BuyVehicle', vehicleDefId, depotId });
export const sell = (vehicleId: number): SerializedCommand => ({ type: 'SellVehicle', vehicleId });

export interface DepotWorld {
  readonly world: World;
  readonly depot: VehicleDepot;
}

/** harbor_01 (Root modul id 1, 2) + cesta + depo (id 3) + voliteľne dvor (id 4); depo je pripojené. */
export function depotWorld(options: { readonly roads?: boolean; readonly yard?: boolean; readonly world?: World } = {}): DepotWorld {
  const world = options.world ?? World.create(DEFS, MAP, SEED);
  if (options.roads ?? true) execute(world, { type: 'PlaceRoad', cells: LAYOUT_ROADS });
  execute(world, { type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_ORIGIN.x, y: DEPOT_ORIGIN.y, rotation: 0 });
  if (options.yard ?? false) execute(world, { type: 'PlaceModule', defId: 'container_yard_small', x: YARD_ORIGIN.x, y: YARD_ORIGIN.y, rotation: 0 });
  const depot = [...world.modules.values()].find((module) => module.kind === 'depot');
  if (depot === undefined) throw new Error('depotWorld: depo sa nepostavilo');
  return { world, depot: depot as VehicleDepot };
}

/** Vozidlo priamo do sveta (`World.addVehicle`) s novým id; predvolene `idle` na vonkajšej bunke depa (trasa `[táto bunka]`). */
export function addVehicleTo(world: World, depotId: EntityId, overrides: Partial<VehicleInit> = {}): Vehicle {
  const vehicle = new Vehicle({
    id: world.ids.next(),
    def: STRADDLE_DEF,
    depotId,
    state: 'idle',
    x: DEPOT_OUTSIDE.x + 0.5,
    y: DEPOT_OUTSIDE.y + 0.5,
    heading: 180,
    purchaseCostCents: STRADDLE_DEF.purchaseCents,
    route: [world.grid.index(DEPOT_OUTSIDE.x, DEPOT_OUTSIDE.y)],
    ...overrides,
  });
  world.addVehicle(vehicle);
  return vehicle;
}

/** Vozidlo s nákladom uprostred jobu (`carryingVehicle`). */
export interface CarryingVehicle {
  readonly vehicle: Vehicle;
  readonly job: TransportJob;
  readonly unit: EntityId;
}

/**
 * Konzistentné vozidlo s nákladom (rozhodnutie orchestrátora F3 č. 5: náklad vezie len vozidlo s jobom): vozidlo stojí
 * na vonkajšej bunke dvora `yard` (`YARD_OUTSIDE`) v stave `unloading` s pobytom `unloadTicks`, jeho job (`dropping`,
 * zdroj apron Root berthu) má rezervovaný slot v dvore a jednotka je vo vozidle (reťaz §7.1 cez fiktívne loď/žeriav —
 * len ledger).
 */
export function carryingVehicle(world: World, depotId: EntityId, yard: StorageModule, overrides: Partial<VehicleInit> = {}): CarryingVehicle {
  const vehicleId = world.ids.next();
  const jobId = world.ids.next();
  const vehicle = addVehicleTo(world, depotId, {
    id: vehicleId,
    state: 'unloading',
    jobId,
    x: YARD_OUTSIDE.x + 0.5,
    y: YARD_OUTSIDE.y + 0.5,
    route: [world.grid.index(YARD_OUTSIDE.x, YARD_OUTSIDE.y)],
    waitTicks: STRADDLE_DEF.unloadTicks,
    ...overrides,
  });
  const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
  world.cargo.move(unit, { kind: 'on_apron', berthId: 902 as EntityId, slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId });
  const job = new TransportJob({
    id: jobId,
    unitIds: [unit],
    from: { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 },
    to: { kind: 'in_storage', moduleId: yard.id, slot: yard.reserve() },
    createdTick: world.clock.tick,
    state: 'dropping',
    vehicleId,
  });
  world.addJob(job);
  return { vehicle, job, unit };
}
