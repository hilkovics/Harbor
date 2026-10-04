/**
 * Kamióny s prázdnymi kontajnermi (F6c, ADR-034 bod 6, 8 + dodatok T6C-02; F6d, ADR-035) — krok 8, vjazd z vnútrozemia (`trucks/hinterland.ts`).
 *
 * - **Návrat prázdneho** (`returnPlan`): splatná položka je kamión `delivery` s novou jednotkou `direction: 'empty'` (`CargoLedger.create` v `in_truck`,
 *   linka plánu, bez kontraktu; `Rng` sa nespotrebuje), ktorý čaká vo vnútrozemí. Vjazd dostane s rezerváciou (`admitDelivery`: bay nad kvótou pre odvoz,
 *   dock so zaručeným miestom na vyloženie, voľné miesto v depe po odpočítaní rozbehnutých návratov — `emptyReturnRoom`); prejde bránou (`EmptyReturned`,
 *   `trucks/export-gate.ts`), počká v stojisku a vyloží na dock rampy rovnako ako export (`landside-system.ts`); prázdny na docku odvezie vozidlo do depa
 *   (`logistics/empty-jobs.ts`). **Len ak má depo voľné miesto** (T6C-07b, M1): depo bez jediného voľného miesta (alebo nedosiahnuteľné) položku zahodí bez
 *   kamióna (`EmptyReturnDeclined`) — nič nevznikne, konzervácia ostáva a bežný dvor sa prázdnymi nezaplní (import by sa zablokoval); miesto, ktoré zaberú
 *   kamióny na ceste, sa len čaká.
 * - **Výdaj prázdneho** (`pickupPlan`): splatná položka je kamión `collect` čakajúci vo vnútrozemí. Vjazd dostane, keď je pre jeho linku dostupný prázdny
 *   kontajner (po odpočítaní prázdnych, ktoré už čakajú na pridelenie kamiónom v prístave) a voľný bay (kamión na odvoz smie obsadiť aj stojisko rezervované
 *   kvótou); vznikne s poverením (`EmptyFlow.errands`: linka bookingu, kontrakt, `giveUpTick` po príchode do stojiska = tick príchodu + `emptyPickupMaxWaitHours`),
 *   dispatcher mu pridelí prázdny z depa na jeho dock, kamión ho naloží a odíde (`EmptyPickedUp`, `in_truck → exported`). Bez dostupného prázdneho kamión
 *   čaká vo vnútrozemí `emptyPickupMaxWaitHours` od `dueTick` a potom sa **vzdá vo vnútrozemí** (`EmptyPickupMissed`, `truckId: null`) — do prístavu nevojde. Pri
 *   vjazde bez prideleného prázdneho (zmizol medzitým) platí vzdanie sa v stojisku (`trucks/empty-collect.ts`). Položka bookingu, ktorý medzitým zanikol
 *   (uzavretý), sa zahodí.
 *
 * Miesto vzniku ako pri exporte: prvá prevádzková rampa kategórie prázdneho, dock s najmenej kamiónmi (výdaj prednostne dock s voľným stagingom), road portál;
 * bez nich položka plánu počká (ďalší tick) a žiadna udalosť nezanikne.
 */
import type { ContractId } from '../core/entity-id';
import { countAvailableEmpties, emptyCargoTypeId, emptyLabels } from '../logistics/empty-stock';
import type { PickupPlanEntry } from '../logistics/empty-flow';
import type { Module } from '../modules/module';
import type { World } from '../world/world';
import { admitDelivery, leastBusyDock, type AdmissionOutcome } from './hinterland-entry';
import type { Truck } from './truck';
import { routeWithFreeBay, spawnTruck, truckDefFor } from './truck-spawner';

/** Booking výdaja ešte beží (nie je uzavretý ani expirovaný)? Zanikol → výdaj nemá komu. */
function bookingOpen(world: World, entry: PickupPlanEntry): boolean {
  return world.contractBook.openContracts.has(entry.contractId as ContractId);
}

/** Krok 8, časť návrat prázdnych: splatné návraty v poradí plánu (viď hlavička). */
export function admitReturnTrucks(world: World, portal: number): void {
  const { emptyFlow } = world;
  const { tick } = world.clock;
  const typeId = emptyCargoTypeId(world.defs);
  if (typeId === undefined) return;
  const category = world.defs.cargoTypes.get(typeId).category;
  for (let entry = emptyFlow.dueReturn(tick); entry !== undefined; entry = emptyFlow.dueReturn(tick)) {
    const { lineId, dueTick } = entry;
    const load = (truck: Truck): void => {
      world.cargo.create(typeId, { kind: 'in_truck', truckId: truck.id }, null, emptyLabels(lineId));
    };
    const outcome: AdmissionOutcome = admitDelivery(world, { direction: 'empty', category, load }, portal);
    if (outcome === 'waiting') break;
    emptyFlow.consumeReturn();
    if (outcome === 'declined') {
      world.hinterland.recordTurnedAway('delivery');
      world.events.emit({ type: 'EmptyReturnDeclined', lineId });
    } else {
      world.hinterland.recordAdmitted('delivery', tick - dueTick);
    }
  }
}

/** Znovupoužiteľné pole s rampou pre `countAvailableEmpties` (hot path; obsah sa vždy najprv prepíše). */
const RAMP_TARGET: Module[] = [];

/** Linky, pre ktoré v tomto ticku nebol dostupný prázdny (ďalšie položky tej istej linky sa nepokúšajú); plní sa pri každom volaní. */
const LINES_WITHOUT_EMPTY: string[] = [];

/** Prázdne kontajnery linky, ktoré možno prideliť novému kamiónu `collect` rampy: dostupné (v sklade s cestou k rampe) − poverenia linky bez prideleného prázdneho. */
function emptiesForNewErrand(world: World, lineId: string): number {
  let unassigned = 0;
  for (const errand of world.emptyFlow.errands) if (errand.lineId === lineId && errand.unitId === null) unassigned += 1;
  return countAvailableEmpties(world, lineId, RAMP_TARGET) - unassigned;
}

/**
 * Pokus o vjazd kamióna `collect` pre výdaj `entry`: prvá prevádzková rampa kategórie prázdneho s voľným bayom (aj rezervovaným pre odvoz), dockom so staging miestom pre výdaj a dostupným
 * prázdnym linky. `admitted` = kamión vznikol; `no_empty` = linka nemá dostupný prázdny (čaká sa na ňu); `blocked` = nie je kam (typ prázdneho, rampa, bay).
 */
function admitCollectTruck(world: World, entry: PickupPlanEntry, portal: number): AdmissionOutcome | 'no_empty' {
  const typeId = emptyCargoTypeId(world.defs);
  if (typeId === undefined) return 'waiting';
  const category = world.defs.cargoTypes.get(typeId).category;
  let outcome: AdmissionOutcome | 'no_empty' = 'waiting';
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.category !== category || !world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    if (def === undefined) continue;
    const route = routeWithFreeBay(world, ramp, 'collect');
    if (route === undefined) continue;
    RAMP_TARGET[0] = ramp;
    if (emptiesForNewErrand(world, entry.lineId) <= 0) {
      outcome = 'no_empty';
      continue;
    }
    world.dockIntake.refresh(world);
    const dock = leastBusyDock(world, ramp, true);
    // Prázdny sa na dock dostane jobom `storage → ramp`, ktorý potrebuje voľné staging miesto; bez neho by kamión držal stojisko, kým miesto niekto neuvoľní.
    if (dock < 0) continue;
    spawnTruck(world, ramp, dock, route, def, portal, 'collect', (truck) => {
      world.emptyFlow.addErrand(truck.id, entry.lineId, entry.contractId);
    });
    return 'admitted';
  }
  return outcome;
}

/** Krok 8, časť výdaj prázdnych: splatné výdaje v poradí plánu, s preskakovaním tých, ktoré čakajú na prázdny (viď hlavička). */
export function admitCollectTrucks(world: World, portal: number): void {
  const { emptyFlow } = world;
  const { tick, ticksPerHour } = world.clock;
  const maxWaitTicks = Math.round(world.defs.logistics.emptyFlow.emptyPickupMaxWaitHours * ticksPerHour);
  const plan = emptyFlow.pickupPlan;
  LINES_WITHOUT_EMPTY.length = 0;
  let noRoom = false;
  for (let i = 0; i < plan.length && plan[i].dueTick <= tick; ) {
    const entry = plan[i];
    if (!bookingOpen(world, entry)) {
      emptyFlow.dropPickupAt(i);
      continue;
    }
    let outcome: AdmissionOutcome | 'no_empty' = 'waiting';
    if (!noRoom && !LINES_WITHOUT_EMPTY.includes(entry.lineId)) outcome = admitCollectTruck(world, entry, portal);
    if (outcome === 'no_empty') LINES_WITHOUT_EMPTY.push(entry.lineId);
    else if (outcome === 'waiting') noRoom = true;
    if (outcome === 'admitted') {
      world.hinterland.recordAdmitted('collect', tick - entry.dueTick);
      emptyFlow.dropPickupAt(i);
    } else if (tick - entry.dueTick >= maxWaitTicks) {
      world.hinterland.recordTurnedAway('collect');
      world.events.emit({ type: 'EmptyPickupMissed', lineId: entry.lineId, contractId: entry.contractId as ContractId, truckId: null });
      emptyFlow.dropPickupAt(i);
    } else {
      i += 1;
    }
  }
}
