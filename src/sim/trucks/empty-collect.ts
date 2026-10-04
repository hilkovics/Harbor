/**
 * Kamión misie `collect` — výdaj prázdneho kontajnera exportérovi (F6c, ADR-034 bod 8 + dodatok T6C-02; krok 8). Kamión vznikne podľa
 * `pickupPlan` s poverením v `World.emptyFlow.errands` (`trucks/empty-trucks.ts`); tu je jeho správanie po vzniku:
 * - **Pripravenosť** (`collectReady`): pridelený prázdny (`errand.unitId`, job dispatchera zo skladu) leží na docku kamióna — až
 *   vtedy kamión odíde zo stojiska k docku (`DOCK_READY`);
 * - **Vzdanie sa** (`collectGivesUp`, `giveUpCollect`): bez prideleného prázdneho po `giveUpTick` kamión odíde zo stojiska prázdny
 *   (`EmptyPickupMissed`, poverenie zanikne);
 * - **Nakládka** (`loadCollected`): po `loadTicksPerUnit` prázdny `at_ramp → in_truck`, uvoľnenie docku a jazda k bráne von;
 * - **Odchod** (`finishCollect`, na portáli `in_truck → exported`): `EmptyPickedUp`, poverenie zanikne.
 * Prázdny na docku nie je náklad na odvoz (`isPickupCargo`), preto naň nemá nárok žiadny kamión misie `pickup` — kamión `collect` ho
 * berie výlučne cez poverenie.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractId, EntityId } from '../core/entity-id';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { World } from '../world/world';
import { TruckError } from './truck-error';
import type { Truck } from './truck';

/** Je pridelený prázdny kontajner na docku kamióna (pripravený na nakládku)? */
export function collectReady(world: World, truck: Truck, ramp: LoadingRamp): boolean {
  const unitId = world.emptyFlow.errandOfTruck(truck.id)?.unitId;
  if (unitId === null || unitId === undefined) return false;
  const location = world.cargo.get(unitId as EntityId)?.location;
  return location?.kind === 'at_ramp' && location.rampId === ramp.id && location.dock === truck.dock;
}

/** Má sa kamión vzdať — bez prideleného prázdneho uplynul `giveUpTick`? */
export function collectGivesUp(world: World, truck: Truck): boolean {
  const errand = world.emptyFlow.errandOfTruck(truck.id);
  return errand !== undefined && errand.unitId === null && world.clock.tick >= errand.giveUpTick;
}

/** Kamión sa vzdal: `EmptyPickupMissed` a zánik poverenia (kamión potom odíde prázdny bez docku). */
export function giveUpCollect(world: World, truck: Truck): void {
  const errand = world.emptyFlow.errandOfTruck(truck.id);
  if (errand === undefined) throw new TruckError('inconsistent', `${truck.label}: misia collect bez poverenia`);
  world.emptyFlow.removeErrand(truck.id);
  world.events.emit({ type: 'EmptyPickupMissed', lineId: errand.lineId, contractId: errand.contractId as ContractId, truckId: truck.id });
}

/**
 * Koniec nakládky: pridelený prázdny `at_ramp → in_truck` (`CargoLedger.move`). Jednotka chýba na docku (nemá nastať — kamión odišiel
 * k docku len pri `collectReady`) → `TruckError('inconsistent')`.
 */
export function loadCollected(world: World, truck: Truck, ramp: LoadingRamp): void {
  if (!collectReady(world, truck, ramp)) throw new TruckError('inconsistent', `${truck.label}: na docku ${String(truck.dock)} ${ramp.label} nie je pridelený prázdny kontajner`);
  const unitId = world.emptyFlow.errandOfTruck(truck.id)?.unitId as EntityId;
  world.cargo.move(unitId, { kind: 'in_truck', truckId: truck.id });
}

/** Prázdny kontajner odišiel s kamiónom z mapy (`unit` = jednotka pred presunom `→ exported`): `EmptyPickedUp` a zánik poverenia. */
export function finishCollect(world: World, truck: Truck, unit: CargoUnit): void {
  const errand = world.emptyFlow.errandOfTruck(truck.id);
  if (errand === undefined) return;
  world.emptyFlow.removeErrand(truck.id);
  world.events.emit({ type: 'EmptyPickedUp', unitId: unit.id, lineId: errand.lineId, contractId: errand.contractId as ContractId, truckId: truck.id });
}
