/**
 * Kamióny s prázdnymi kontajnermi (F6c, ADR-034 bod 6, 8 + dodatok T6C-02; F6d, ADR-035) — krok 8, vjazd z vnútrozemia (`trucks/hinterland.ts`).
 *
 * - **Návrat prázdneho** (`returnPlan`): splatná položka je kamión `delivery` s novou jednotkou `direction: 'empty'` (`CargoLedger.create` v `in_truck`,
 *   linka plánu, bez kontraktu; `Rng` sa nespotrebuje), ktorý čaká vo vnútrozemí. Vjazd dostane s rezerváciou (`tryAdmitDelivery`: slot v depe a token TP / státia); prejde bránou (`EmptyReturned`,
 *   `trucks/export-gate.ts`) a na TP depa ho obslúži vozidlo (`landside-system.ts`). **Len ak má depo voľné miesto** (T6C-07b, M1): depo bez jediného voľného miesta (alebo nedosiahnuteľné) položku zahodí bez
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
import { slotOf } from '../cargo/cargo-location';
import { emptyCargoTypeId, emptyLabels, findAvailableEmpty } from '../logistics/empty-stock';
import type { PickupPlanEntry } from '../logistics/empty-flow';
import { openReceiveJob } from '../logistics/truck-jobs';
import { unitPickable } from '../logistics/yard-planner';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import { nearBayOfSlot } from './destination';
import { tryAdmitDelivery, type AdmissionOutcome } from './hinterland-entry';
import { trySpawn, truckDefFor } from './truck-spawner';

/** Booking výdaja ešte beží (nie je uzavretý ani expirovaný)? Zanikol → výdaj nemá komu. */
function bookingOpen(world: World, entry: PickupPlanEntry): boolean {
  return world.contractBook.openContracts.has(entry.contractId as ContractId);
}

/** Krok 8, časť návrat prázdnych: splatné návraty v poradí plánu (viď hlavička). Skutočná jednotka vznikne až pri skutočnom vjazde (T6D-05b). */
export function admitReturnTrucks(world: World): void {
  const { emptyFlow } = world;
  const { tick } = world.clock;
  if (emptyFlow.dueReturn(tick) === undefined) return;
  const typeId = emptyCargoTypeId(world.defs);
  if (typeId === undefined) return;
  for (let entry = emptyFlow.dueReturn(tick); entry !== undefined; entry = emptyFlow.dueReturn(tick)) {
    const { lineId, dueTick, sizeFt } = entry;
    const labels = emptyLabels(lineId, sizeFt);
    const outcome: AdmissionOutcome = tryAdmitDelivery(world, 'empty', { typeId, contractId: null, probe: labels, final: () => labels });
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

/** Linky, pre ktoré v tomto ticku nebol dostupný prázdny (ďalšie položky tej istej linky sa nepokúšajú); plní sa pri každom volaní. */
const LINES_WITHOUT_EMPTY: string[] = [];

/**
 * Pokus o vjazd kamióna `collect` pre výdaj `entry`: dostupný prázdny linky (v sklade, `available`, bez jobu) dostane kamión pri vzniku — job `receive` a poverenie `errand.unitId`; kamión
 * dostane token cieľa pri bloku prázdneho. `admitted` = kamión vznikol; `no_empty` = linka nemá dostupný prázdny (čaká sa na ňu); `waiting` = nie je kam (typ prázdneho, token, portál, zavalený stoh).
 */
function admitCollectTruck(world: World, entry: PickupPlanEntry): AdmissionOutcome | 'no_empty' {
  const typeId = emptyCargoTypeId(world.defs);
  if (typeId === undefined) return 'waiting';
  const def = truckDefFor(world.defs, world.defs.cargoTypes.get(typeId).category);
  if (def === undefined) return 'waiting';
  const unit = findAvailableEmpty(world, entry.lineId);
  if (unit === undefined) return 'no_empty';
  const block = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  const slot = slotOf(unit.location);
  // Zavalený prázdny bez miesta na rehandling sa nevydáva (stroj by uviazol, TR2-06b) — kamión vznikne, až keď sa blok uvoľní.
  if (!(block instanceof YardBlock) || slot === null || !unitPickable(world, unit)) return 'waiting';
  const outcome = trySpawn(world, def, 'collect', block, nearBayOfSlot(block, slot), (truck) => {
    world.emptyFlow.addErrand(truck.id, entry.lineId, entry.contractId);
    world.emptyFlow.assignErrandUnit(truck.id, unit.id);
    openReceiveJob(world, truck, unit, block);
  });
  return outcome === 'spawned' ? 'admitted' : 'waiting';
}

/** Krok 8, časť výdaj prázdnych: splatné výdaje v poradí plánu, s preskakovaním tých, ktoré čakajú na prázdny (viď hlavička). */
export function admitCollectTrucks(world: World): void {
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
    if (!noRoom && !LINES_WITHOUT_EMPTY.includes(entry.lineId)) outcome = admitCollectTruck(world, entry);
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
