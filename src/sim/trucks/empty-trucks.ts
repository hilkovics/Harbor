/**
 * Kamióny s prázdnymi kontajnermi (F6c, ADR-034 bod 6, 8 + dodatok T6C-02) — krok 8, po spawne kamiónov s exportom.
 *
 * - **Návrat prázdneho** (`returnPlan`): v `dueTick` vznikne kamión misie `delivery` s novou jednotkou `direction: 'empty'`
 *   (`CargoLedger.create` v `in_truck`, linka plánu, bez kontraktu; `Rng` sa nespotrebuje) na road portáli; prejde bránou
 *   (`EmptyReturned`, `trucks/export-gate.ts`), počká v stojisku a vyloží na dock rampy rovnako ako export (`landside-system.ts`);
 *   prázdny na docku odvezie vozidlo do depa (`logistics/empty-jobs.ts`). **Len ak má depo voľné miesto** (T6C-07b, M1: voľné − rozbehnuté
 *   návraty, `emptyReturnRoom`); bez miesta sa položka plánu len spotrebuje bez kamióna (`EmptyReturnDeclined`) — nič nevznikne, konzervácia
 *   ostáva a bežný dvor sa prázdnymi nezaplní (import by sa zablokoval). Svet bez depa (zbúrané po naplánovaní) miesto neobmedzuje (fallback).
 * - **Výdaj prázdneho** (`pickupPlan`): v `dueTick` vznikne kamión misie `collect` s poverením (`EmptyFlow.errands`: linka bookingu,
 *   kontrakt, `giveUpTick` po príchode do stojiska = tick príchodu + `emptyPickupMaxWaitHours`). Kamión čaká v stojisku, kým mu dispatcher pridelí prázdny kontajner
 *   linky (z depa na jeho dock); potom ho naloží a odíde (`EmptyPickedUp`, `in_truck → exported`), alebo sa po `giveUpTick` bez
 *   prideleného vzdá a odíde prázdny (`EmptyPickupMissed`). Plán sa spotrebuje až po vzniku kamióna; položka bookingu, ktorý medzitým
 *   zanikol (uzavretý), sa zahodí bez kamióna.
 *
 * Miesto vzniku ako pri exporte: prvá prevádzková rampa kategórie prázdneho s voľným bayom na trase, dock s najmenej kamiónmi, road
 * portál; bez nich položka plánu počká (ďalší tick) a žiadna udalosť nezanikne.
 */
import type { ContractId, EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import { emptyCargoTypeId, emptyLabels, emptyReturnRoom } from '../logistics/empty-stock';
import type { LoadingRamp } from '../modules/loading-ramp';
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
  /** Smie kamión vzniknúť na rampe `ramp` (návrat: depo prázdnych má miesto, M1)? Chýba = vždy. */
  readonly admits?: (world: World, ramp: LoadingRamp, category: CargoCategory) => boolean;
}

/** Výsledok pokusu o vznik kamióna: vznikol, plán sa má zahodiť bez kamióna (`declined`), alebo počká (`waiting`, nie je kam). */
type SpawnOutcome = 'spawned' | 'declined' | 'waiting';

/**
 * Pokus o vznik kamióna podľa `spawn` na prvej vhodnej rampe: kategória typu prázdneho kontajnera, prevádzková, s kamiónom kategórie a trasou
 * s voľným bayom (ako `spawnDeliveryTruck`) a prípadne s priechodom `spawn.admits`. `waiting` = nie je kam (typ prázdneho, rampa, bay, portál) —
 * plán počká; `declined` = rampa je vhodná, ale návrat nemá miesto v depe (pozri `admits`) — plán sa zahodí. Voľný bay sa overuje pred
 * `admits`, takže drahé počítanie rozbehnutých návratov beží len keď by kamión naozaj vznikol.
 */
function spawnEmptyTruck(world: World, spawn: EmptySpawn, portal: number): SpawnOutcome {
  const typeId = emptyCargoTypeId(world.defs);
  if (typeId === undefined) return 'waiting';
  const category = world.defs.cargoTypes.get(typeId).category;
  let blocked = false;
  let declined = false;
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.category !== category || !world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    if (def === undefined) continue;
    const route = routeWithFreeBay(world, ramp);
    if (route === undefined) {
      blocked = true;
      continue;
    }
    if (spawn.admits !== undefined && !spawn.admits(world, ramp, category)) {
      declined = true;
      continue;
    }
    spawnTruck(world, ramp, leastBusyDock(world, ramp), route, def, portal, spawn.mission, (truck) => {
      spawn.onSpawn(world, truck.id as EntityId);
    });
    return 'spawned';
  }
  return declined && !blocked ? 'declined' : 'waiting';
}

/** Návrat prázdneho linky `entry.lineId`: kamión `delivery` s novou prázdnou jednotkou, len ak má depo voľné miesto (`emptyReturnRoom`). */
function returnSpawn(entry: ReturnPlanEntry): EmptySpawn {
  return {
    mission: 'delivery',
    onSpawn: (world, truckId) => {
      const typeId = emptyCargoTypeId(world.defs);
      if (typeId === undefined) return;
      world.cargo.create(typeId, { kind: 'in_truck', truckId }, null, emptyLabels(entry.lineId));
    },
    admits: (world, ramp, category) => emptyReturnRoom(world, ramp, category) > 0,
  };
}

/** Výdaj prázdneho exportérovi: kamión `collect` s poverením (`giveUpTick` sa nastaví až po príchode do stojiska, `trucks/empty-collect.ts`). */
function pickupSpawn(entry: PickupPlanEntry): EmptySpawn {
  return {
    mission: 'collect',
    onSpawn: (world, truckId) => {
      world.emptyFlow.addErrand(truckId, entry.lineId, entry.contractId);
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
    const outcome = spawnEmptyTruck(world, returnSpawn(entry), portal);
    if (outcome === 'waiting') break;
    emptyFlow.consumeReturn();
    if (outcome === 'declined') world.events.emit({ type: 'EmptyReturnDeclined', lineId: entry.lineId });
  }
  for (let entry = emptyFlow.duePickup(tick); entry !== undefined; entry = emptyFlow.duePickup(tick)) {
    if (!bookingOpen(world, entry)) {
      emptyFlow.consumePickup();
      continue;
    }
    if (spawnEmptyTruck(world, pickupSpawn(entry), portal) !== 'spawned') break;
    emptyFlow.consumePickup();
  }
}
