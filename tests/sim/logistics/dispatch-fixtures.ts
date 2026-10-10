// Fixtúra testov dispatchera a alokátora (T03-05, ADR-018): harbor_01 s Root berthom (id 1, apron 4 sloty, konektory
// → vonkajšie bunky (41, 18) a (46, 18); berth 8 × 4 zaberá y 14…17) a cestou pozdĺž nábrežia y = 18, x 31…56. Moduly sú otočené o 180°, takže
// konektor (pôvodne `s`) smeruje na sever priamo na cestu:
//   depo (31, 19) → vonkajšia bunka (32, 18);  dvor W (35, 19) → (37, 18), od berthu 4;
//   dvor E (48, 19) → (50, 18), od berthu 4 (remíza s W);  dvor F (53, 19) → (55, 18), od berthu 9.
// Jednotky na aprone vznikajú priamo cez ledger (fiktívna loď 900 a žeriav 901 — len prechody §7.1), bez lode.
import vehiclesJson from '@data/defs/vehicles.json';
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import type { StorageModule, VehicleDepot } from '@sim/modules';
import { World } from '@sim/world';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';

export const ROOT_BERTH_ID = 1 as EntityId;
export const QUAY_ROAD: readonly CellCoord[] = Array.from({ length: 26 }, (_, i) => ({ x: 31 + i, y: 18 }));
export const DEPOT_CELL: CellCoord = { x: 31, y: 19 };
export const DEPOT_ACCESS: CellCoord = { x: 32, y: 18 };
export const YARD_W: CellCoord = { x: 35, y: 19 };
export const YARD_W_ACCESS: CellCoord = { x: 37, y: 18 };
export const YARD_E: CellCoord = { x: 48, y: 19 };
export const YARD_E_ACCESS: CellCoord = { x: 50, y: 18 };
export const YARD_F: CellCoord = { x: 53, y: 19 };
export const YARD_F_ACCESS: CellCoord = { x: 55, y: 18 };
export const BERTH_ACCESS: readonly CellCoord[] = [
  { x: 41, y: 18 },
  { x: 46, y: 18 },
];

export const STRADDLE = 'straddle_carrier';
export const BULK_VEHICLE = 'flatbed_bulk';

/** Defy s pridaným vozidlom `flatbed_bulk` (kategória `bulk`) a voliteľne inou kapacitou dvora. */
export function dispatchDefs(options: { readonly yardCapacity?: number } = {}): DefRegistry {
  const bulk = { ...vehiclesJson.items[0], id: BULK_VEHICLE, displayName: 'Flatbed (bulk)', cargoCategories: ['bulk'] };
  const items = modulesJson.items.map((item) =>
    item.id === 'container_yard_small' && options.yardCapacity !== undefined ? { ...item, params: { ...item.params, capacityUnits: options.yardCapacity } } : item,
  );
  return DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...modulesJson, items }, vehicles: { ...vehiclesJson, items: [...vehiclesJson.items, bulk] } });
}

/** Enqueue + `applyPending`; odmietnutý príkaz = chyba testu. */
export function execute(world: World, command: SerializedCommand): readonly SimEvent[] {
  world.enqueue(commandFromJSON(command));
  const events = world.applyPending();
  const rejected = events.filter((event) => event.type === 'CommandRejected');
  if (rejected.length > 0) throw new Error(`príkaz ${command.type} odmietnutý: ${JSON.stringify(rejected)}`);
  return events;
}

export const placeYard = (world: World, cell: CellCoord, rotation: 0 | 180 = 180): StorageModule => {
  execute(world, { type: 'PlaceModule', defId: 'container_yard_small', x: cell.x, y: cell.y, rotation });
  return world.moduleAt(cell.x, cell.y) as StorageModule;
};

export interface DispatchWorld {
  readonly world: World;
  readonly depot: VehicleDepot;
}

/** Svet s cestou pozdĺž nábrežia a depom (prvý `PlaceModule`, id 3); dvory a vozidlá pridáva test. */
export function dispatchWorld(defs: DefRegistry = DEFS, seed = 3050): DispatchWorld {
  const world = World.create(defs, MAP, seed);
  execute(world, { type: 'PlaceRoad', cells: QUAY_ROAD });
  execute(world, { type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_CELL.x, y: DEPOT_CELL.y, rotation: 180 });
  return { world, depot: world.moduleAt(DEPOT_CELL.x, DEPOT_CELL.y) as VehicleDepot };
}

/** Kúpi vozidlo do depa a vráti jeho id. */
export function buyVehicle(world: World, depot: VehicleDepot, vehicleDefId = STRADDLE): EntityId {
  const events = execute(world, { type: 'BuyVehicle', vehicleDefId, depotId: depot.id });
  const bought = events.find((event) => event.type === 'VehicleBought');
  if (bought?.type !== 'VehicleBought') throw new Error('BuyVehicle nevyprodukoval VehicleBought');
  return bought.vehicleId;
}

/**
 * Jednotky na aprone Root berthu na daných slotoch v tomto poradí (poradie príchodu = FIFO, nie poradie slotov); cez
 * ledger s fiktívnou loďou 900 a žeriavom 901 (len prechody §7.1).
 */
export function unitsOnApron(world: World, slots: readonly number[], typeId = 'container_teu'): EntityId[] {
  return slots.map((slot) => {
    const unit = world.cargo.create(typeId, { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit, { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot });
    return unit;
  });
}

/** Index bunky mriežky sveta. */
export const cellIndex = (world: World, cell: CellCoord): number => world.grid.index(cell.x, cell.y);

/** `tick()` a udalosti ticku daného typu. */
export function tickEvents<T extends SimEvent['type']>(world: World, type: T): Extract<SimEvent, { type: T }>[] {
  return world.tick().filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}
