/**
 * Kamióny s prázdnymi kontajnermi (F6c, ADR-034 bod 6, 8 + dodatok T6C-02) — krok 8, po spawne kamiónov s exportom.
 *
 * - **Návrat prázdneho** (`returnPlan`): v `dueTick` vznikne kamión misie `delivery` s novou jednotkou `direction: 'empty'`
 *   (`CargoLedger.create` v `in_truck`, linka plánu, bez kontraktu; `Rng` sa nespotrebuje) na road portáli; prejde bránou
 *   (`EmptyReturned`, `trucks/export-gate.ts`), počká v stojisku a vyloží na dock rampy rovnako ako export (`landside-system.ts`);
 *   prázdny na docku odvezie vozidlo do depa (`logistics/empty-jobs.ts`).
 * - **Výdaj prázdneho** (`pickupPlan`): v `dueTick` vznikne kamión misie `collect` s poverením (`EmptyFlow.errands`: linka bookingu,
 *   kontrakt, `giveUpTick = tick + emptyPickupMaxWaitHours`). Kamión čaká v stojisku, kým mu dispatcher pridelí prázdny kontajner
 *   linky (z depa na jeho dock); potom ho naloží a odíde (`EmptyPickedUp`, `in_truck → exported`), alebo sa po `giveUpTick` bez
 *   prideleného vzdá a odíde prázdny (`EmptyPickupMissed`). Plán sa spotrebuje až po vzniku kamióna; položka bookingu, ktorý medzitým
 *   zanikol (uzavretý), sa zahodí bez kamióna.
 *
 * Miesto vzniku ako pri exporte: prvá prevádzková rampa kategórie prázdneho s voľným bayom na trase, dock s najmenej kamiónmi, road
 * portál; bez nich položka plánu počká (ďalší tick) a žiadna udalosť nezanikne.
 */
import type { ContractId, EntityId } from '../core/entity-id';
import { emptyCargoTypeId, emptyLabels } from '../logistics/empty-stock';
import { NO_ACCESS } from '../logistics/module-access';
import type { PickupPlanEntry, ReturnPlanEntry } from '../logistics/empty-flow';
import type { World } from '../world/world';
import { leastBusyDock } from './export-trucks';
import { routeWithFreeBay, spawnTruck, truckDefFor } from './truck-spawner';
import type { TruckMission } from './truck-fsm';

/** Misia a nakladač jednotky podľa druhu plánu: návrat vozí jednotku (`delivery`), výdaj ju nevezie (`collect`). */
interface EmptySpawn {
  readonly mission: TruckMission;
  /** Položí na kamión jednotku (návrat) alebo zaeviduje poverenie (výdaj) — voláno hneď po `World.addTruck`. */
  readonly onSpawn: (world: World, truckId: EntityId) => void;
}

/**
 * Vznikol kamión podľa `spawn` na prvej vhodnej rampe? `false` = nie je kam (typ prázdneho, rampa, bay, portál) — plán počká.
 * Rampa kategórie typu prázdneho kontajnera, prevádzková, s kamiónom kategórie a trasou s voľným bayom (ako `spawnDeliveryTruck`).
 */
function spawnEmptyTruck(world: World, spawn: EmptySpawn, portal: number): boolean {
  const typeId = emptyCargoTypeId(world.defs);
  if (typeId === undefined) return false;
  const category = world.defs.cargoTypes.get(typeId).category;
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.category !== category || !world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    const route = routeWithFreeBay(world, ramp);
    if (def === undefined || route === undefined) continue;
    spawnTruck(world, ramp, leastBusyDock(world, ramp), route, def, portal, spawn.mission, (truck) => {
      spawn.onSpawn(world, truck.id as EntityId);
    });
    return true;
  }
  return false;
}

/** Návrat prázdneho linky `entry.lineId`: kamión `delivery` s novou prázdnou jednotkou. */
function returnSpawn(entry: ReturnPlanEntry): EmptySpawn {
  return {
    mission: 'delivery',
    onSpawn: (world, truckId) => {
      const typeId = emptyCargoTypeId(world.defs);
      if (typeId === undefined) return;
      world.cargo.create(typeId, { kind: 'in_truck', truckId }, null, emptyLabels(entry.lineId));
    },
  };
}

/** Výdaj prázdneho exportérovi: kamión `collect` s poverením (`giveUpTick` od vzniku kamióna). */
function pickupSpawn(entry: PickupPlanEntry): EmptySpawn {
  return {
    mission: 'collect',
    onSpawn: (world, truckId) => {
      const { emptyPickupMaxWaitHours } = world.defs.logistics.emptyFlow;
      const giveUpTick = world.clock.tick + Math.round(emptyPickupMaxWaitHours * world.clock.ticksPerHour);
      world.emptyFlow.addErrand(truckId, entry.lineId, entry.contractId, giveUpTick);
    },
  };
}

/** Booking výdaja ešte beží (nie je uzavretý ani expirovaný)? Zanikol → výdaj nemá komu. */
function bookingOpen(world: World, entry: PickupPlanEntry): boolean {
  return world.contractBook.openContracts.has(entry.contractId as ContractId);
}

/** Krok 8, časť prázdne kontajnery (viď hlavička): splatné návraty, potom splatné výdaje (oba v poradí plánu). */
export function spawnEmptyTrucks(world: World): void {
  const portal = world.landside.portalCell;
  if (portal === NO_ACCESS || world.landsideModules.ramps.length === 0) return;
  const { tick } = world.clock;
  const { emptyFlow } = world;
  for (let entry = emptyFlow.dueReturn(tick); entry !== undefined; entry = emptyFlow.dueReturn(tick)) {
    if (!spawnEmptyTruck(world, returnSpawn(entry), portal)) break;
    emptyFlow.consumeReturn();
  }
  for (let entry = emptyFlow.duePickup(tick); entry !== undefined; entry = emptyFlow.duePickup(tick)) {
    if (!bookingOpen(world, entry)) {
      emptyFlow.consumePickup();
      continue;
    }
    if (!spawnEmptyTruck(world, pickupSpawn(entry), portal)) break;
    emptyFlow.consumePickup();
  }
}
