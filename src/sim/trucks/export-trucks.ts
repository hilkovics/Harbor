/**
 * Kamióny s exportom (F6a, ADR-032 bod 6): vznik **delivery** kamiónov podľa plánu príchodov bookingov (krok 8, po
 * spawne pickup kamiónov). Každá položka plánu (`Contract.nextArrivalTick ≤ tick`) vytvorí kamión naložený jednou
 * jednotkou (`CargoLedger.create` v `in_truck`, hmotnostná trieda `Rng.weighted` podľa `exportFlow.weightClassShares`,
 * štítky z kontraktu) na road portáli; kamión ide k bráne, prejde ňou (`ExportArrived`), počká v stojisku a vyloží na dock
 * rampy (`trucks/truck-unload.ts`, `systems/landside-system.ts`).
 *
 * Kontrakty vzostupne podľa id; položky plánu spredu (neklesajúco). Bez prevádzkovej rampy kategórie nákladu, bez voľného
 * bayu na trase alebo bez road portálu položka počká (ďalší tick) — plán sa spotrebuje až po vzniku kamióna, takže
 * žiadny príchod nezanikne. Dock: ten s najmenej kamiónmi na rampe (pri zhode nižší), aby sa vykládky rozložili.
 */
import { WEIGHT_CLASSES } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS } from '../contracts/contract-fsm';
import type { EntityId } from '../core/entity-id';
import { NO_ACCESS } from '../logistics/module-access';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { World } from '../world/world';
import { routeWithFreeBay, spawnTruck, truckDefFor } from './truck-spawner';

/** Znovupoužiteľné pole počtu kamiónov na dock pre `leastBusyDock` (hot path bez alokácie; plní sa pri každom volaní). */
const DOCK_TRUCKS: number[] = [];

/** Dock rampy s najmenej kamiónmi (každej misie, vrátane tých na ceste k bráne); pri zhode nižší dock. */
export function leastBusyDock(world: World, ramp: LoadingRamp): number {
  DOCK_TRUCKS.length = ramp.docks;
  DOCK_TRUCKS.fill(0);
  for (const truck of world.trucks.values()) if (truck.rampId === ramp.id && truck.dock < ramp.docks) DOCK_TRUCKS[truck.dock] += 1;
  let best = 0;
  for (let dock = 1; dock < ramp.docks; dock++) if (DOCK_TRUCKS[dock] < DOCK_TRUCKS[best]) best = dock;
  return best;
}

/** Vznikol kamión pre najbližšiu položku plánu kontraktu? `false` = nie je kam (rampa, bay, portál) — plán počká. */
function spawnDeliveryTruck(world: World, contract: Contract, portal: number): boolean {
  const category = world.defs.cargoTypes.get(contract.cargoTypeId).category;
  const booking = contract.booking;
  if (booking === null) return false;
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.category !== category || !world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    const route = routeWithFreeBay(world, ramp);
    if (def === undefined || route === undefined) continue;
    const shares = world.defs.logistics.exportFlow.weightClassShares;
    spawnTruck(world, ramp, leastBusyDock(world, ramp), route, def, portal, 'delivery', (truck) => {
      const weightClass = world.rng.weighted(WEIGHT_CLASSES, (item) => shares[item]);
      world.cargo.create(contract.cargoTypeId, { kind: 'in_truck', truckId: truck.id as EntityId }, contract.id, {
        direction: 'export',
        voyageId: contract.voyageId,
        lineId: contract.lineId,
        destinationPort: booking.destinationPort,
        weightClass,
      });
    });
    return true;
  }
  return false;
}

/** Krok 8, časť export spawn (viď hlavička). */
export function spawnExportTrucks(world: World): void {
  const portal = world.landside.portalCell;
  if (portal === NO_ACCESS || world.landsideModules.ramps.length === 0) return;
  const { tick } = world.clock;
  for (const contract of world.contractBook.openContracts.values()) {
    // Booking po prijatí (plán je nastavený); ponuka ho nemá a uzavretý kontrakt už nie je medzi otvorenými.
    if (CONTRACT_STATE_TRAITS[contract.state].plan !== 'required') continue;
    for (let due = contract.nextArrivalTick; due !== undefined && due <= tick; due = contract.nextArrivalTick) {
      if (!spawnDeliveryTruck(world, contract, portal)) break;
      contract.consumeArrival();
    }
  }
}
