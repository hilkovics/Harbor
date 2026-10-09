/**
 * ToastCenter (T03-10) — oznámenia pre hráča zo simu: zásobník toastov, ktorý číta udalosti (`SimBridge.onEvents`) a
 * plní `@ui/toasts` (čisto prezentačné). Žije mimo Reactu (vzor `BuildSelection`), takže StrictMode ani prekreslenia
 * oznámenia nezdvojujú; React ho číta cez `useSyncExternalStore` (`subscribe`, `get`).
 *
 * Zdroje oznámení (`toastSpecsForEvents`, čistá funkcia nad `World` a udalosťami):
 * - `NoStorageAvailable` → „Chýba sklad“ (warning): kotvisko nemá kam uložiť náklad (aj keď je len nepripojené).
 * - `ModulePlaced` modulu s cestným konektorom, ktorý nie je pripojený → „Nepripojené“ (info) s akciou „Ukázať“
 *   (centruje kameru na modul).
 *
 * - Kontrakty (F5, T05-07): `ContractOffered` → jeden toast „Nové ponuky“ za herný deň (zlúčené, info, akcia „Zobraziť“
 *   otvorí panel kontraktov); `ContractAccepted` (info); `ContractCompleted` → výplata (success, `+$… a +N XP`);
 *   `PenaltyApplied` → penalizácia (warning, dedup podľa kontraktu a druhu, sumy z jednej dávky sa sčítajú);
 *   `ContractFailed` (danger); `MonthlyReport` (info). Zánik ponuky (`ContractExpired`) a `GameOver` (modál) toast nemajú.
 *
 * - Export a booking (F6a, T6A-07, ADR-032): `CutoffWarning` → „Cut-off exportu o N h“ (warning); `UnitRolled` → jednotka po
 *   cut-off (warning, jedna za kontrakt a dávku so súčtom); `VgmHoldStarted` → „Chýba VGM“ (warning, zlučené podľa kontraktu);
 *   `ExportShipped` → „Loď odplávala s exportom“ (success); `BookingPenaltyApplied` → penalizácia bookingu (warning, podľa
 *   druhu: last minute / rolled / nesplnený). `ContractAccepted` roundtripu je jeden toast za voyage; popis export kontraktu
 *   nesie cieľ (`#4 · Export 24 TEU → Rotterdam`).
 *
 * - Prázdne kontajnery a prekládka (F6c, T6C-05, ADR-034): `EmptyReturned` → „Návrat prázdnych“ (nenápadné, info, rýchlo zmizne;
 *   jeden toast za linku a dávku so súčtom, nie za každý kus); `EmptyRepaired` → „Oprava hotová“ (success, zlúčené podľa depa a
 *   linky, s cenou opráv a akciou „Ukázať“ na depo); `EmptyPickupMissed` → „Výdaj prázdneho zlyhal“ (warning; `truckId === null` = kamión sa vzdal vo vnútrozemí a do prístavu nevošiel, F6d ADR-035,
 *   inak kamión odišiel prázdny zo stojiska);
 *   `TranshipMissed` → „Tranship zmeškaný“ (danger, aj so sumou penalizácie; jej `BookingPenaltyApplied rolled` samostatný toast nemá),
 *   `TranshipRescued` (info) a `TranshipSold` (warning) — čo sa stalo so zmeškanými jednotkami; `ExportShipped` lode B prekládky
 *   ukáže triedu a cieľ z kontraktu prekládky (`tranship.outShipId`). `EmptyStored` / `EmptyDamaged` / `EmptyRepairStarted` / `EmptyPickedUp` toast nemajú (stav je v inšpektore depa).
 *
 * Pravidlá zásobníka:
 * - Rovnaký `key` (napr. `no_storage:1`) sa naraz nezobrazí dvakrát — opakovaná udalosť pre to isté kotvisko nezaplaví panel.
 * - Naraz sa ukáže najviac `MAX_TOASTS` (4); ďalšie čakajú a ukážu sa, keď sa niektorý zavrie.
 * - Zobrazený toast sa zatvorí sám po `autoCloseMs` (`TOAST_AUTO_CLOSE_MS`, reálny čas); odpočet začína až pri zobrazení.
 */
import { sumTotals } from '@sim/economy';
import type { ContractId, EntityId } from '@sim/core';
import type { CargoCategory } from '@sim/defs';
import type { ContractKind } from '@sim/contracts';
import type { BookingPenaltyKind, PenaltyKind, SimEvent } from '@sim/events';
import type { World } from '@sim/world';
import { formatDuration, formatFraction, formatMoney, formatMoneyDelta, formatXp } from '@ui/format';
import { moduleCode } from '@ui/module-inspector';
import { reeferAlarmToast, reeferClaimToast, reeferSkippedToast } from '@ui/reefer-toasts';
import { MAX_TOASTS, type ToastData, type ToastId, type ToastTone } from '@ui/toasts';
import { QUIET_TOAST_AUTO_CLOSE_MS, TOAST_AUTO_CLOSE_MS } from './config';
import { hasRoadConnector } from './entities-vm';
import type { PanelId } from './panel-selection';
import type { SimBridge, Unsubscribe } from './sim-bridge';
import type { TimerHost } from './snapshot-store';

/** Popis oznámenia pred zaradením do zásobníka. */
export interface ToastSpec {
  /** Kľúč zhody: toast s rovnakým kľúčom už v zásobníku → nový sa zahodí. */
  readonly key: string;
  readonly tone: ToastTone;
  /** Názov ikony zo spritu (`ic_warning`). */
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  /** Bod v bunkách, na ktorý akcia „Ukázať“ vycentruje kameru; bez neho toast akciu nemá. */
  readonly focus?: { readonly x: number; readonly y: number };
  /** Panel, ktorý akcia „Zobraziť“ otvorí (kontrakty); bez neho (alebo bez `openPanel`) toast túto akciu nemá. */
  readonly panel?: PanelId;
  /** Vlastný čas do automatického zatvorenia v ms (nenápadné oznámenia, napr. „Automaticky uložené“); predvolene `autoCloseMs` zásobníka. */
  readonly autoCloseMs?: number;
}

/** Názvy nákladu a skladu pre text „Chýba sklad“ podľa kategórie (prezentácia; F3 pozná len kontajnery). */
export const CARGO_CATEGORY_TEXT: Readonly<Record<CargoCategory, { readonly cargo: string; readonly storage: string }>> = Object.freeze({
  container: { cargo: 'kontajnery', storage: 'kontajnerový dvor' },
  bulk: { cargo: 'sypký náklad', storage: 'sklad sypkého nákladu' },
  liquid: { cargo: 'kvapaliny', storage: 'nádrž' },
  gas: { cargo: 'plyn', storage: 'zásobník plynu' },
  roro: { cargo: 'vozidlá', storage: 'parkovisko áut' },
});

/** Popis akcie „Ukázať“ (centrovanie kamery). */
export const TOAST_SHOW_ON_MAP_LABEL = 'Ukázať';

/** Popis akcie „Zobraziť“ (otvorenie panelu kontraktov). */
export const TOAST_SHOW_PANEL_LABEL = 'Zobraziť';

export const NO_STORAGE_TITLE = 'Chýba sklad';
export const DISCONNECTED_TOAST_TITLE = 'Nepripojené';

export const OFFERS_TOAST_TITLE = 'Nové ponuky kontraktov';
export const ACCEPTED_TOAST_TITLE = 'Kontrakt prijatý';
export const COMPLETED_TOAST_TITLE = 'Kontrakt splnený';
export const COMPLETED_LATE_TOAST_TITLE = 'Kontrakt splnený s meškaním';
export const FAILED_TOAST_TITLE = 'Kontrakt zlyhal';
export const MONTHLY_TOAST_TITLE = 'Mesačný výkaz';

/** Názov penalizácie podľa druhu (`demurrage` = státie lode nad limit, `late` = meškanie exportu po SLA). */
export const PENALTY_TOAST_TITLE: Readonly<Record<PenaltyKind, string>> = Object.freeze({
  demurrage: 'Penalizácia: státie lode',
  late: 'Penalizácia: meškanie exportu',
});

export const CUTOFF_WARNING_TOAST_TITLE = 'Cut-off exportu';
export const VGM_HOLD_TOAST_TITLE = 'Chýba VGM';
export const EXPORT_SHIPPED_TOAST_TITLE = 'Loď odplávala s exportom';

/** Názov penalizácie bookingu podľa druhu (last minute nakládka, vrátená rolled jednotka, nesplnený booking). */
export const BOOKING_PENALTY_TOAST_TITLE: Readonly<Record<BookingPenaltyKind, string>> = Object.freeze({
  last_minute: 'Penalizácia: last minute nakládka',
  rolled: 'Penalizácia: vrátené jednotky (rolled)',
  unfulfilled: 'Penalizácia: nesplnený booking',
});

export const EMPTY_RETURNED_TOAST_TITLE = 'Návrat prázdnych';
export const EMPTY_REPAIRED_TOAST_TITLE = 'Oprava hotová';
export const EMPTY_PICKUP_MISSED_TOAST_TITLE = 'Výdaj prázdneho zlyhal';
export const TRANSHIP_MISSED_TOAST_TITLE = 'Tranship zmeškaný';
export const TRANSHIP_RESCUED_TOAST_TITLE = 'Tranship zachránený';
export const TRANSHIP_SOLD_TOAST_TITLE = 'Tranship predaný';

export const TRAFFIC_JAM_TOAST_TITLE = 'Zápcha';

/** „1 jednotka“, „2 jednotky“, „5 jednotiek“. */
export function unitsText(count: number): string {
  if (count === 1) return '1 jednotka';
  return count >= 2 && count <= 4 ? `${String(count)} jednotky` : `${String(count)} jednotiek`;
}

/** „1 prázdny kontajner“, „2 prázdne kontajnery“, „5 prázdnych kontajnerov“. */
export function emptiesText(count: number): string {
  if (count === 1) return '1 prázdny kontajner';
  return count >= 2 && count <= 4 ? `${String(count)} prázdne kontajnery` : `${String(count)} prázdnych kontajnerov`;
}

/** Čas do cut-off pre nadpis toastu: `6 h`, `1 d 2 h`, pod hodinu `menej než hodinu`. */
export function cutoffInText(ticks: number, scale: { readonly ticksPerHour: number; readonly ticksPerDay: number }): string {
  const text = formatDuration(ticks, scale);
  return text === '< 1 h' ? 'menej než hodinu' : text;
}

/** „1 nová ponuka“, „2 nové ponuky“, „5 nových ponúk“. */
export function newOffersText(count: number): string {
  if (count === 1) return '1 nová ponuka';
  return count >= 2 && count <= 4 ? `${String(count)} nové ponuky` : `${String(count)} nových ponúk`;
}

/** Kód modulu pre text oznámenia (`BRT-01`); zaniknutý modul → kód z druhu `fallbackKind`. */
function codeOf(world: World, moduleId: EntityId, fallbackKind: string): string {
  return moduleCode(world.modules.get(moduleId)?.kind ?? fallbackKind, moduleId);
}

/** Názov druhu booking kontraktu v popise (`Export 24 TEU → Rotterdam`); import booking nemá. */
const BOOKING_LABEL: Readonly<Record<ContractKind, string>> = {
  import: 'Import',
  export: 'Export',
  empty_repositioning: 'Prázdne',
  tranship: 'Tranship',
};

/**
 * Popis kontraktu pre text oznámenia: import `#3 · 120 TEU`, export booking `#4 · Export 24 TEU → Rotterdam`, repositioning
 * `#5 · Prázdne 24 TEU → Rotterdam`, prekládka `#6 · Tranship 24 TEU → Hamburg` (zaniknutá ponuka → len `#3`).
 */
function contractLabel(world: World, contractId: ContractId): string {
  const contract = world.contracts.get(contractId);
  if (contract === undefined) return `#${String(contractId)}`;
  const volume = `${String(contract.volumeUnits)} ${world.defs.cargoTypes.get(contract.cargoTypeId).unitName}`;
  const { booking } = contract;
  return booking === null ? `#${String(contractId)} · ${volume}` : `#${String(contractId)} · ${BOOKING_LABEL[contract.kind]} ${volume} → ${booking.destinationPort}`;
}

/** Názov linky z `lines.json` pre text oznámenia (neznáme id → id). */
function lineLabel(world: World, lineId: string): string {
  return world.defs.lines.has(lineId) ? world.defs.lines.get(lineId).displayName : lineId;
}

/** Stred modulu v bunkách pre akciu „Ukázať“; zaniknutý modul → `undefined`. */
function focusOf(world: World, moduleId: EntityId): { readonly x: number; readonly y: number } | undefined {
  const module = world.modules.get(moduleId);
  return module === undefined ? undefined : { x: module.origin.x + module.size.w / 2, y: module.origin.y + module.size.h / 2 };
}

/** Popis kontraktov celej voyage (`#3 · 48 TEU + #4 · Export 24 TEU → Rotterdam`); import-only = popis kontraktu. */
function voyageLabel(world: World, contractId: ContractId): string {
  const contract = world.contracts.get(contractId);
  if (contract === undefined) return contractLabel(world, contractId);
  const members = world.contractBook.voyageContracts(contract.voyageId);
  return (members.length === 0 ? [contract] : members).map((member) => contractLabel(world, member.id)).join(' + ');
}

/**
 * Oznámenia o kontraktoch pre jednu udalosť. `offers` (počet `ContractOffered` dávky) a `penalties` (súčet
 * `PenaltyApplied` podľa kontraktu a druhu) sa zlučujú: dávka dá jeden toast, nie jeden na udalosť.
 */
function contractSpec(world: World, event: SimEvent, batch: ContractBatch): ToastSpec | null {
  switch (event.type) {
    case 'ContractOffered': {
      if (batch.offersShown) return null;
      batch.offersShown = true;
      return {
        key: `contracts_offered:${String(world.clock.gameDay)}`,
        tone: 'info',
        icon: 'ic_contract',
        title: OFFERS_TOAST_TITLE,
        text: newOffersText(batch.offers),
        panel: 'contracts',
      };
    }
    case 'ContractAccepted': {
      const contract = world.contracts.get(event.contractId);
      // Roundtrip prijíma celú voyage naraz: jeden toast za voyage (import-only: voyage = id kontraktu, kľúč ostáva).
      const voyage = contract?.voyageId ?? event.contractId;
      if (batch.acceptedVoyages.has(voyage)) return null;
      batch.acceptedVoyages.add(voyage);
      const arrival = contract?.shipArrivalTick;
      const eta = arrival === undefined ? '' : ` — loď príde o ${formatDuration(arrival - world.clock.tick, world.clock)}`;
      return {
        key: `contract_accepted:${String(voyage)}`,
        tone: 'info',
        icon: 'ic_check',
        title: ACCEPTED_TOAST_TITLE,
        text: `${voyageLabel(world, event.contractId)}${eta}`,
        panel: 'contracts',
      };
    }
    case 'ContractCompleted': {
      const paid = event.rewardCents - event.penaltiesCents;
      const penalties = event.penaltiesCents > 0 ? ` (penalizácie ${formatMoney(-event.penaltiesCents)})` : '';
      return {
        key: `contract_completed:${String(event.contractId)}`,
        tone: 'success',
        icon: 'ic_check',
        title: event.onTime ? COMPLETED_TOAST_TITLE : COMPLETED_LATE_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · ${formatMoneyDelta(paid)} a +${formatXp(event.xp)}${penalties}`,
        panel: 'contracts',
      };
    }
    case 'PenaltyApplied': {
      const id = `${String(event.contractId)}:${event.kind}`;
      if (batch.penaltiesShown.has(id)) return null;
      batch.penaltiesShown.add(id);
      const amount = batch.penalties.get(id) ?? event.amountCents;
      return {
        key: `penalty:${id}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: PENALTY_TOAST_TITLE[event.kind],
        text: `${contractLabel(world, event.contractId)} · ${formatMoney(-amount)}`,
        panel: 'contracts',
      };
    }
    case 'ContractFailed':
      return {
        key: `contract_failed:${String(event.contractId)}`,
        tone: 'danger',
        icon: 'ic_close',
        title: FAILED_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · odmena prepadla, penalizácia ${formatMoney(-event.penaltiesCents)}`,
        panel: 'contracts',
      };
    case 'CutoffWarning': {
      const contract = world.contracts.get(event.contractId);
      const booking = contract?.booking;
      const arrived =
        contract === undefined || booking === null || booking === undefined
          ? ''
          : ` · dovezené ${formatFraction(booking.arrivedUnits, booking.bookedUnits, world.defs.cargoTypes.get(contract.cargoTypeId).unitName)}`;
      return {
        key: `cutoff_warning:${String(event.contractId)}`,
        tone: 'warning',
        icon: 'ic_clock',
        title: `${CUTOFF_WARNING_TOAST_TITLE} o ${cutoffInText(event.cutoffTick - world.clock.tick, world.clock)}`,
        text: `${contractLabel(world, event.contractId)}${arrived}`,
        panel: 'contracts',
      };
    }
    case 'UnitRolled': {
      if (batch.rolledShown.has(event.contractId)) return null;
      batch.rolledShown.add(event.contractId);
      return {
        key: `unit_rolled:${String(event.contractId)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: `${unitsText(batch.rolled.get(event.contractId) ?? 1)} po cut-off (rolled)`,
        text: `${contractLabel(world, event.contractId)} · naloží sa len ak loď ešte nezačala lashing, inak sa vráti odosielateľovi`,
        panel: 'contracts',
      };
    }
    case 'VgmHoldStarted': {
      if (batch.holdsShown.has(event.contractId)) return null;
      batch.holdsShown.add(event.contractId);
      const hold = batch.holds.get(event.contractId) ?? { count: 1, untilTick: event.untilTick };
      return {
        key: `vgm_hold:${String(event.contractId)}`,
        tone: 'warning',
        icon: 'ic_lock',
        title: VGM_HOLD_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · zadržané: ${unitsText(hold.count)}, uvoľnenie o ${formatDuration(hold.untilTick - world.clock.tick, world.clock)}`,
        panel: 'contracts',
      };
    }
    case 'ExportShipped': {
      // Loď už zo sveta zmizla, preto triedu a cieľ berie kontrakt s bookingom, ktorý ju nakladal (kniha ho drží do uzavretia bookingu): export
      // a repositioning majú loď voyage (`shipId`), prekládka odváža loď B (`tranship.outShipId`; `shipId` je loď A, ktorá nič neodváža).
      const contract = [...world.contracts.values()].find((candidate) => candidate.booking !== null && (candidate.shipId === event.shipId || candidate.tranship?.outShipId === event.shipId));
      const ship = contract === undefined ? `Loď #${String(event.shipId)}` : world.defs.ships.get(contract.shipClassId).displayName;
      const unit = contract === undefined ? 'jedn.' : world.defs.cargoTypes.get(contract.cargoTypeId).unitName;
      const destination = contract === undefined || contract.booking === null ? '' : ` → ${contract.booking.destinationPort}`;
      return {
        key: `export_shipped:${String(event.shipId)}`,
        tone: 'success',
        icon: 'ic_ship',
        title: EXPORT_SHIPPED_TOAST_TITLE,
        text: `${ship} · ${String(event.units)} ${unit}${destination}`,
        panel: 'contracts',
      };
    }
    case 'BookingPenaltyApplied':
      // Zmeškaná prekládka je v sime `rolled` penalizácia; hráč ju dostane v toaste „Tranship zmeškaný“ (aj so sumou), nie ako „vrátené jednotky“.
      if (event.kind === 'rolled' && world.contracts.get(event.contractId)?.kind === 'tranship') return null;
      return {
        key: `booking_penalty:${String(event.contractId)}:${event.kind}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: BOOKING_PENALTY_TOAST_TITLE[event.kind],
        text: `${contractLabel(world, event.contractId)} · ${event.kind === 'unfulfilled' ? '' : `${unitsText(event.units)} · `}${formatMoney(-event.amountCents)}`,
        panel: 'contracts',
      };
    case 'EmptyReturned': {
      // Návrat prázdneho je rutina: jeden nenápadný toast za linku a dávku so súčtom, nie za každý kus.
      if (batch.returnsShown.has(event.lineId)) return null;
      batch.returnsShown.add(event.lineId);
      return {
        key: `empty_returned:${event.lineId}`,
        tone: 'info',
        icon: 'ic_truck',
        title: EMPTY_RETURNED_TOAST_TITLE,
        text: `${lineLabel(world, event.lineId)} · ${emptiesText(batch.returns.get(event.lineId) ?? 1)} z vnútrozemia`,
        autoCloseMs: QUIET_TOAST_AUTO_CLOSE_MS,
      };
    }
    case 'EmptyRepaired': {
      const id = `${String(event.moduleId)}:${event.lineId}`;
      if (batch.repairsShown.has(id)) return null;
      batch.repairsShown.add(id);
      const repaired = batch.repairs.get(id) ?? { count: 1, costCents: event.costCents };
      const focus = focusOf(world, event.moduleId);
      return {
        key: `empty_repaired:${id}`,
        tone: 'success',
        icon: 'ic_check',
        title: EMPTY_REPAIRED_TOAST_TITLE,
        text: `${codeOf(world, event.moduleId, 'storage')} · ${lineLabel(world, event.lineId)} · opravené: ${String(repaired.count)} · ${formatMoney(-repaired.costCents)}`,
        ...(focus === undefined ? {} : { focus }),
      };
    }
    case 'EmptyPickupMissed': {
      if (batch.pickupMissesShown.has(event.contractId)) return null;
      batch.pickupMissesShown.add(event.contractId);
      const missed = batch.pickupMisses.get(event.contractId) ?? 1;
      return {
        key: `empty_pickup_missed:${String(event.contractId)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: EMPTY_PICKUP_MISSED_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · ${lineLabel(world, event.lineId)} nemala dostupný prázdny kontajner, ${pickupMissedOutcome(missed, batch.pickupMissesInland.get(event.contractId) ?? 0)}${missed > 1 ? ` (×${String(missed)})` : ''}`,
        panel: 'contracts',
      };
    }
    case 'TranshipMissed': {
      const penaltyCents = batch.missedPenalties.get(event.contractId);
      const penalty = penaltyCents === undefined ? '' : ` · penalizácia ${formatMoney(-penaltyCents)}`;
      return {
        key: `tranship_missed:${String(event.contractId)}`,
        tone: 'danger',
        icon: 'ic_warning',
        title: TRANSHIP_MISSED_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · loď B (plavba #${String(event.outVoyageId)}) odplávala, zmeškané: ${unitsText(event.units)}${penalty}`,
        panel: 'contracts',
      };
    }
    case 'TranshipRescued':
      return {
        key: `tranship_rescued:${String(event.contractId)}`,
        tone: 'info',
        icon: 'ic_ship',
        title: TRANSHIP_RESCUED_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · zachránené: ${unitsText(event.units)}, čakajú na plavbu #${String(event.outVoyageId)}`,
        panel: 'contracts',
      };
    case 'TranshipSold':
      return {
        key: `tranship_sold:${String(event.contractId)}`,
        tone: 'warning',
        icon: 'ic_truck',
        title: TRANSHIP_SOLD_TOAST_TITLE,
        text: `${contractLabel(world, event.contractId)} · predané kamiónom (penalizácia): ${unitsText(event.units)}`,
        panel: 'contracts',
      };
    case 'MonthlyReport':
      return {
        key: `monthly:${String(event.month)}`,
        tone: 'info',
        icon: 'ic_cash',
        title: MONTHLY_TOAST_TITLE,
        text: `Mesiac ${String(event.month + 1)}: príjmy ${formatMoney(sumTotals(event.summary.incomeCents))}, výdavky ${formatMoney(sumTotals(event.summary.expenseCents))}, hotovosť ${formatMoney(event.summary.cashEndCents)}`,
      };
    default:
      return null;
  }
}

/** Zlučovanie udalostí kontraktov v rámci jednej dávky (viď `contractSpec`). */
interface ContractBatch {
  /** Počet `ContractOffered` v dávke. */
  offers: number;
  offersShown: boolean;
  /** Súčet `PenaltyApplied` podľa `kontrakt:druh`. */
  readonly penalties: Map<string, number>;
  readonly penaltiesShown: Set<string>;
  /** F6a: voyage, ktorých `ContractAccepted` už dostal toast (roundtrip = dva kontrakty, jeden toast). */
  readonly acceptedVoyages: Set<number>;
  /** F6a: počet `UnitRolled` podľa kontraktu a kontrakty, ktoré už dostali toast. */
  readonly rolled: Map<ContractId, number>;
  readonly rolledShown: Set<ContractId>;
  /** F6a: `VgmHoldStarted` podľa kontraktu (počet jednotiek a najskorší koniec zadržania) a kontrakty s toastom. */
  readonly holds: Map<ContractId, { count: number; untilTick: number }>;
  readonly holdsShown: Set<ContractId>;
  /** F6c: počet `EmptyReturned` podľa linky a linky, ktoré už dostali toast. */
  readonly returns: Map<string, number>;
  readonly returnsShown: Set<string>;
  /** F6c: `EmptyRepaired` podľa `depo:linka` (počet a súčet cien opráv) a kľúče, ktoré už dostali toast. */
  readonly repairs: Map<string, { count: number; costCents: number }>;
  readonly repairsShown: Set<string>;
  /** F6c: počet `EmptyPickupMissed` podľa kontraktu a kontrakty, ktoré už dostali toast. */
  readonly pickupMisses: Map<ContractId, number>;
  /** F6d (ADR-035): z nich tie, kde sa kamión vzdal vo vnútrozemí (`truckId === null`) a do prístavu nevošiel. */
  readonly pickupMissesInland: Map<ContractId, number>;
  readonly pickupMissesShown: Set<ContractId>;
  /** F6c: súčet `BookingPenaltyApplied` druhu `rolled` podľa kontraktu (penalizácia zmeškanej prekládky, ktorú ukáže toast `TranshipMissed`). */
  readonly missedPenalties: Map<ContractId, number>;
}

/**
 * Čo sa stalo s kamiónom po prázdny kontajner (F6d, ADR-035): `inland` z `missed` sa vzdalo vo vnútrozemí a do prístavu nevošlo (`truckId === null`),
 * zvyšok odišiel prázdny zo stojiska; zmiešaná dávka v jednom frame dostane všeobecný text.
 */
function pickupMissedOutcome(missed: number, inland: number): string {
  if (inland === 0) return 'kamión odišiel prázdny';
  return inland >= missed ? 'kamión do prístavu nevošiel' : 'kamióny odišli prázdne alebo do prístavu nevošli';
}

function contractBatch(events: readonly SimEvent[]): ContractBatch {
  const batch: ContractBatch = {
    offers: 0,
    offersShown: false,
    penalties: new Map(),
    penaltiesShown: new Set(),
    acceptedVoyages: new Set(),
    rolled: new Map(),
    rolledShown: new Set(),
    holds: new Map(),
    holdsShown: new Set(),
    returns: new Map(),
    returnsShown: new Set(),
    repairs: new Map(),
    repairsShown: new Set(),
    pickupMisses: new Map(),
    pickupMissesInland: new Map(),
    pickupMissesShown: new Set(),
    missedPenalties: new Map(),
  };
  for (const event of events) {
    if (event.type === 'ContractOffered') {
      batch.offers += 1;
    } else if (event.type === 'PenaltyApplied') {
      const id = `${String(event.contractId)}:${event.kind}`;
      batch.penalties.set(id, (batch.penalties.get(id) ?? 0) + event.amountCents);
    } else if (event.type === 'UnitRolled') {
      batch.rolled.set(event.contractId, (batch.rolled.get(event.contractId) ?? 0) + 1);
    } else if (event.type === 'VgmHoldStarted') {
      const known = batch.holds.get(event.contractId);
      batch.holds.set(event.contractId, { count: (known?.count ?? 0) + 1, untilTick: Math.min(known?.untilTick ?? event.untilTick, event.untilTick) });
    } else if (event.type === 'EmptyReturned') {
      batch.returns.set(event.lineId, (batch.returns.get(event.lineId) ?? 0) + 1);
    } else if (event.type === 'EmptyRepaired') {
      const id = `${String(event.moduleId)}:${event.lineId}`;
      const known = batch.repairs.get(id);
      batch.repairs.set(id, { count: (known?.count ?? 0) + 1, costCents: (known?.costCents ?? 0) + event.costCents });
    } else if (event.type === 'EmptyPickupMissed') {
      batch.pickupMisses.set(event.contractId, (batch.pickupMisses.get(event.contractId) ?? 0) + 1);
      if (event.truckId === null) batch.pickupMissesInland.set(event.contractId, (batch.pickupMissesInland.get(event.contractId) ?? 0) + 1);
    } else if (event.type === 'BookingPenaltyApplied' && event.kind === 'rolled') {
      batch.missedPenalties.set(event.contractId, (batch.missedPenalties.get(event.contractId) ?? 0) + event.amountCents);
    }
  }
  return batch;
}

/** Oznámenia pre udalosti jedného framu, v poradí udalostí; `world` je stav po frame (pripojenie sa číta z neho). */
export function toastSpecsForEvents(world: World, events: readonly SimEvent[]): ToastSpec[] {
  const specs: ToastSpec[] = [];
  const batch = contractBatch(events);
  for (const event of events) {
    const contract = contractSpec(world, event, batch);
    if (contract !== null) {
      specs.push(contract);
      continue;
    }
    if (event.type === 'NoStorageAvailable') {
      const text = CARGO_CATEGORY_TEXT[world.defs.cargoTypes.get(event.cargoTypeId).category];
      specs.push({
        key: `no_storage:${String(event.berthId)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: NO_STORAGE_TITLE,
        text: `Kotvisko ${codeOf(world, event.berthId, 'berth')} nemá kam uložiť ${text.cargo} (postav alebo pripoj ${text.storage})`,
      });
    } else if (event.type === 'ModulePlaced') {
      const module = world.modules.get(event.moduleId);
      if (module === undefined || !hasRoadConnector(module) || world.isConnected(module)) continue;
      specs.push({
        key: `disconnected:${String(module.id)}`,
        tone: 'info',
        icon: 'ic_info',
        title: DISCONNECTED_TOAST_TITLE,
        text: `${module.def.displayName} ${moduleCode(module.kind, module.id)} nemá cestu k vjazdu — pripoj ho cestou`,
        focus: { x: module.origin.x + module.size.w / 2, y: module.origin.y + module.size.h / 2 },
      });
    } else if (event.type === 'ReeferSkipped' || event.type === 'ReeferClaim' || event.type === 'ReeferAlarm') {
      const label = `Reefer #${String(event.unitId)}`;
      const text =
        event.type === 'ReeferSkipped'
          ? reeferSkippedToast({ label })
          : event.type === 'ReeferClaim'
            ? reeferClaimToast({ label, penaltyCents: event.cents })
            : reeferAlarmToast({ label, minutesToRespond: Math.round(world.defs.logistics.reefer.alarmResponseHours * 60) });
      specs.push({ key: `${event.type}:${String(event.unitId)}`, ...text });
    } else if (event.type === 'TrafficJam') {
      const carrierLabel = event.carrierKind === 'truck' ? 'Kamión' : 'Vozidlo';
      specs.push({
        key: `traffic_jam:${String(event.carrierId)}`,
        tone: 'warning',
        icon: 'ic_warning',
        title: TRAFFIC_JAM_TOAST_TITLE,
        text: `${carrierLabel} #${String(event.carrierId)} stojí v zápche`,
        focus: { x: event.cell.x, y: event.cell.y },
      });
    }
  }
  return specs;
}

export interface ToastCenterOptions {
  /** Vycentruje kameru na bod v bunkách (akcia „Ukázať“); bez neho toasty akciu nemajú. */
  readonly centerOn?: (cellX: number, cellY: number) => void;
  /** Otvorí pravý panel (akcia „Zobraziť“ pri toastoch kontraktov); bez neho tieto toasty akciu nemajú. */
  readonly openPanel?: (panel: PanelId) => void;
  /** Po koľkých ms sa zobrazený toast zavrie; predvolene `TOAST_AUTO_CLOSE_MS`. */
  readonly autoCloseMs?: number;
  /** Časovače; v testoch nahraditeľné. */
  readonly timers?: TimerHost;
}

const globalTimers: TimerHost = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

interface QueuedToast {
  readonly id: number;
  readonly key: string;
  readonly data: ToastData;
  /** Čas do automatického zatvorenia v ms (vlastný z `ToastSpec.autoCloseMs`, inak predvolený zásobníka). */
  readonly autoCloseMs: number;
  /** Časovač automatického zatvorenia; `null`, kým toast čaká vo fronte. */
  timer: unknown;
}

export class ToastCenter {
  private readonly queue: QueuedToast[] = [];
  private snapshot: readonly ToastData[] = Object.freeze([]);
  private nextId = 1;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly centerOn: ToastCenterOptions['centerOn'];
  private readonly openPanel: ToastCenterOptions['openPanel'];
  private readonly autoCloseMs: number;
  private readonly timers: TimerHost;
  private readonly stopEvents: Unsubscribe;

  constructor(
    private readonly bridge: Pick<SimBridge, 'world' | 'onEvents'>,
    options: ToastCenterOptions = {},
  ) {
    this.centerOn = options.centerOn;
    this.openPanel = options.openPanel;
    this.autoCloseMs = options.autoCloseMs ?? TOAST_AUTO_CLOSE_MS;
    this.timers = options.timers ?? globalTimers;
    this.stopEvents = bridge.onEvents((events) => {
      for (const spec of toastSpecsForEvents(this.bridge.world, events)) this.push(spec);
    });
  }

  /** Toasty v poradí príchodu (aj čakajúce; `Toasts` ukáže prvých `MAX_TOASTS`). Referencia je stabilná do zmeny. */
  readonly get = (): readonly ToastData[] => this.snapshot;

  /** Odber zmien zásobníka (pre `useSyncExternalStore`). */
  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Zaradí oznámenie, ak s rovnakým `key` už nie je v zásobníku. @returns `true`, ak sa pridalo. */
  push(spec: ToastSpec): boolean {
    if (this.disposed || this.queue.some((toast) => toast.key === spec.key)) return false;
    const id = this.nextId;
    this.nextId += 1;
    const { focus } = spec;
    const { centerOn, openPanel } = this;
    const { panel } = spec;
    const data: ToastData = {
      id,
      tone: spec.tone,
      icon: spec.icon,
      title: spec.title,
      text: spec.text,
      onClose: (toastId) => {
        this.close(toastId);
      },
      ...(focus !== undefined && centerOn !== undefined
        ? {
            onShow: () => {
              centerOn(focus.x, focus.y);
            },
            showLabel: TOAST_SHOW_ON_MAP_LABEL,
          }
        : panel !== undefined && openPanel !== undefined
          ? {
              onShow: () => {
                openPanel(panel);
              },
              showLabel: TOAST_SHOW_PANEL_LABEL,
            }
          : {}),
    };
    this.queue.push({ id, key: spec.key, data, autoCloseMs: spec.autoCloseMs ?? this.autoCloseMs, timer: null });
    this.changed();
    return true;
  }

  /** Zatvorí toast (tlačidlo ×, automaticky); neznáme id sa ignoruje. */
  close(id: ToastId): void {
    const index = this.queue.findIndex((toast) => toast.id === id);
    const found = this.queue[index];
    if (found === undefined) return;
    if (found.timer !== null) this.timers.clearTimeout(found.timer);
    this.queue.splice(index, 1);
    this.changed();
  }

  /** Odpojí sa od udalostí, zruší časovače a vyprázdni zásobník. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEvents();
    for (const toast of this.queue) {
      if (toast.timer !== null) this.timers.clearTimeout(toast.timer);
    }
    this.queue.length = 0;
    this.snapshot = Object.freeze([]);
    this.listeners.clear();
  }

  /** Spustí odpočet zobrazeným toastom, obnoví snapshot a upozorní odberateľov. */
  private changed(): void {
    for (const toast of this.queue.slice(0, MAX_TOASTS)) {
      if (toast.timer !== null) continue;
      toast.timer = this.timers.setTimeout(() => {
        this.close(toast.id);
      }, toast.autoCloseMs);
    }
    this.snapshot = Object.freeze(this.queue.map((toast) => toast.data));
    for (const listener of [...this.listeners]) listener();
  }
}
