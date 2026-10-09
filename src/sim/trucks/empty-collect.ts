/**
 * Kamión misie `collect` — výdaj prázdneho kontajnera exportérovi (F6c, ADR-034 bod 8 + dodatok T6C-02; R4, ADR-041; krok 8). Kamión vznikne podľa `pickupPlan` s poverením
 * v `World.emptyFlow.errands` a už pri vzniku má pridelený prázdny kontajner (`errand.unitId`) a job `receive` (`trucks/empty-trucks.ts`): na TP depa ho obsluhuje vozidlo (empty handler,
 * straddle) a kamión s ním odíde (`finishCollect`, na portáli `in_truck → exported`: `EmptyPickedUp`, poverenie zanikne). Prázdny s jobom nie je náklad na odvoz (`direction: 'empty'`),
 * preto naň nemá nárok žiadny kamión misie `pickup` — kamión `collect` ho berie výlučne cez poverenie.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractId } from '../core/entity-id';
import type { World } from '../world/world';
import type { Truck } from './truck';

/** Prázdny kontajner odišiel s kamiónom z mapy (`unit` = jednotka pred presunom `→ exported`): `EmptyPickedUp` a zánik poverenia. */
export function finishCollect(world: World, truck: Truck, unit: CargoUnit): void {
  const errand = world.emptyFlow.errandOfTruck(truck.id);
  if (errand === undefined) return;
  world.emptyFlow.removeErrand(truck.id);
  world.events.emit({ type: 'EmptyPickedUp', unitId: unit.id, lineId: errand.lineId, contractId: errand.contractId as ContractId, truckId: truck.id });
}
