/**
 * Statické dáta dema F6a UI (T6A-07; ADR-032): ContractsPanel s export bookingom a spoločnou kartou voyage (roundtrip),
 * inšpektor skladu s rozdelením import / export, inšpektor lode s nákladom podľa smeru a lashingom a toasty nových udalostí
 * exportu. Žiadny bridge ani simulácia — komponenty sú čisto prezentačné. Mierka času a „teraz" sú z dema F5 (`time.json`).
 * Hodnoty nadväzujú na prototyp design/ui/game-ui.source.html (export karty: „Naložené" / „Dovezené", Rotterdam…).
 */
import type { ContractBookingData, ContractCardData } from '../contracts-panel';
import type { ModuleInspectorData } from '../module-inspector';
import type { ToastData } from '../toasts';
import { F5_TIME, NOW_TICK, TICKS_PER_DAY as D, TICKS_PER_HOUR as H } from './f5-ui-data';

export const F6A_TIME = F5_TIME;
export { NOW_TICK };

const CENTS = 100;

// --- Karty kontraktov ---------------------------------------------------------------------------------------------------------

const BASE: ContractCardData = {
  id: 0,
  state: 'offered',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 0,
  rewardCents: 0,
  xpReward: 0,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  offerExpiresTick: NOW_TICK + D,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

function booking(patch: Partial<ContractBookingData> = {}): ContractBookingData {
  return {
    destinationPort: 'Rotterdam',
    bookedUnits: 24,
    pendingArrivals: 0,
    arrivedUnits: 0,
    loadedUnits: 0,
    lastMinuteUnits: 0,
    rolledUnits: 0,
    returnedUnits: 0,
    heldUnits: 0,
    ...patch,
  };
}

// Ponuky: roundtrip (voyage 111 = import 111 + export 112), export-only s dôvodom odmietnutia, import.
const OFFER_ROUNDTRIP_IMPORT: ContractCardData = {
  ...BASE,
  id: 111,
  kind: 'import',
  voyageId: 111,
  volumeUnits: 48,
  rewardCents: 180_000 * CENTS,
  xpReward: 48,
  offerExpiresTick: NOW_TICK + D + 4 * H,
  slaWindowTicks: 4 * D,
};

const OFFER_ROUNDTRIP_EXPORT: ContractCardData = {
  ...BASE,
  id: 112,
  kind: 'export',
  voyageId: 111,
  volumeUnits: 24,
  rewardCents: 96_000 * CENTS,
  xpReward: 24,
  offerExpiresTick: NOW_TICK + D + 4 * H,
  slaWindowTicks: 3 * D,
  booking: booking({ cutoffLeadTicks: 12 * H }),
};

const OFFER_EXPORT_BLOCKED: ContractCardData = {
  ...BASE,
  id: 113,
  kind: 'export',
  voyageId: 113,
  volumeUnits: 18,
  rewardCents: 72_000 * CENTS,
  xpReward: 18,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  offerExpiresTick: NOW_TICK + 5 * H,
  slaWindowTicks: 5 * D,
  disabledReason: 'Pri kotvisku pre loď chýba žeriav na tento náklad',
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 18, cutoffLeadTicks: 12 * H }),
};

const OFFER_IMPORT: ContractCardData = {
  ...BASE,
  id: 114,
  kind: 'import',
  voyageId: 114,
  volumeUnits: 72,
  rewardCents: 264_000 * CENTS,
  xpReward: 72,
  offerExpiresTick: NOW_TICK + 2 * D + 6 * H,
  slaWindowTicks: 5 * D,
};

export const F6A_OFFERS: readonly ContractCardData[] = [OFFER_ROUNDTRIP_IMPORT, OFFER_ROUNDTRIP_EXPORT, OFFER_EXPORT_BLOCKED, OFFER_IMPORT];

// Aktívne: roundtrip uprostred (import sa vykladá, export dostáva kamióny), export pred cut-off, po cut-off s rolled a VGM.
const ACTIVE_ROUNDTRIP_IMPORT: ContractCardData = {
  ...BASE,
  id: 211,
  kind: 'import',
  voyageId: 211,
  state: 'unloading',
  volumeUnits: 48,
  rewardCents: 180_000 * CENTS,
  xpReward: 48,
  shipArrivalTick: NOW_TICK - 3 * H,
  slaDeadlineTick: NOW_TICK + 3 * D - 3 * H,
  unitsUnloaded: 30,
  unitsExported: 11,
};

const ACTIVE_ROUNDTRIP_EXPORT: ContractCardData = {
  ...BASE,
  id: 212,
  kind: 'export',
  voyageId: 211,
  state: 'exporting',
  volumeUnits: 24,
  rewardCents: 96_000 * CENTS,
  xpReward: 24,
  shipArrivalTick: NOW_TICK - 3 * H,
  slaDeadlineTick: NOW_TICK + 2 * D - 3 * H,
  booking: booking({ cutoffTick: NOW_TICK - 15 * H, arrivedUnits: 24, loadedUnits: 9, heldUnits: 1 }),
};

const EXPORT_BEFORE_CUTOFF: ContractCardData = {
  ...BASE,
  id: 213,
  kind: 'export',
  voyageId: 213,
  state: 'ship_en_route',
  volumeUnits: 36,
  rewardCents: 144_000 * CENTS,
  xpReward: 36,
  shipArrivalTick: NOW_TICK + 7 * H,
  slaDeadlineTick: NOW_TICK + 4 * D + 7 * H,
  booking: booking({ destinationPort: 'Gdańsk', bookedUnits: 36, cutoffTick: NOW_TICK + 5 * H, pendingArrivals: 9, arrivedUnits: 25, heldUnits: 2 }),
};

const EXPORT_AFTER_CUTOFF: ContractCardData = {
  ...BASE,
  id: 214,
  kind: 'export',
  voyageId: 214,
  state: 'exporting',
  volumeUnits: 24,
  rewardCents: 96_000 * CENTS,
  xpReward: 24,
  shipArrivalTick: NOW_TICK - 8 * H,
  slaDeadlineTick: NOW_TICK + 3 * D - 8 * H,
  penaltiesCents: 1_920 * CENTS,
  booking: booking({ cutoffTick: NOW_TICK - 20 * H, arrivedUnits: 23, loadedUnits: 17, lastMinuteUnits: 1, rolledUnits: 3, returnedUnits: 1, heldUnits: 0 }),
};

const ACCEPTED_EXPORT: ContractCardData = {
  ...BASE,
  id: 215,
  kind: 'export',
  voyageId: 215,
  state: 'accepted',
  volumeUnits: 12,
  rewardCents: 48_000 * CENTS,
  xpReward: 12,
  shipArrivalTick: NOW_TICK + 2 * D,
  slaDeadlineTick: NOW_TICK + 5 * D,
  booking: booking({ bookedUnits: 12, cutoffTick: NOW_TICK + 2 * D - 12 * H, pendingArrivals: 12 }),
};

export const F6A_ACTIVE: readonly ContractCardData[] = [ACTIVE_ROUNDTRIP_IMPORT, ACTIVE_ROUNDTRIP_EXPORT, EXPORT_BEFORE_CUTOFF, EXPORT_AFTER_CUTOFF, ACCEPTED_EXPORT];

// História: export splnený s penalizáciami, export zlyhaný (nič nenaložené), roundtrip uzavretý.
const EXPORT_COMPLETED: ContractCardData = {
  ...BASE,
  id: 311,
  kind: 'export',
  voyageId: 311,
  state: 'completed',
  volumeUnits: 24,
  rewardCents: 96_000 * CENTS,
  xpReward: 24,
  slaDeadlineTick: NOW_TICK - D,
  closedTick: NOW_TICK - D - 6 * H,
  penaltiesCents: 2_400 * CENTS,
  booking: booking({ arrivedUnits: 24, loadedUnits: 22, lastMinuteUnits: 1, rolledUnits: 2, returnedUnits: 1 }),
};

const EXPORT_FAILED: ContractCardData = {
  ...BASE,
  id: 312,
  kind: 'export',
  voyageId: 312,
  state: 'failed',
  volumeUnits: 18,
  rewardCents: 72_000 * CENTS,
  xpReward: 18,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  slaDeadlineTick: NOW_TICK - 3 * D,
  closedTick: NOW_TICK - 2 * D,
  penaltiesCents: 7_200 * CENTS,
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 18, arrivedUnits: 4, returnedUnits: 4, rolledUnits: 4 }),
};

const ROUNDTRIP_DONE_IMPORT: ContractCardData = {
  ...BASE,
  id: 313,
  kind: 'import',
  voyageId: 313,
  state: 'completed',
  volumeUnits: 36,
  rewardCents: 132_000 * CENTS,
  xpReward: 36,
  slaDeadlineTick: NOW_TICK - 3 * D,
  closedTick: NOW_TICK - 3 * D - 2 * H,
  unitsUnloaded: 36,
  unitsExported: 36,
};

const ROUNDTRIP_DONE_EXPORT: ContractCardData = {
  ...BASE,
  id: 314,
  kind: 'export',
  voyageId: 313,
  state: 'completed',
  volumeUnits: 16,
  rewardCents: 64_000 * CENTS,
  xpReward: 16,
  slaDeadlineTick: NOW_TICK - 3 * D,
  closedTick: NOW_TICK - 3 * D - 5 * H,
  booking: booking({ destinationPort: 'Gdańsk', bookedUnits: 16, arrivedUnits: 16, loadedUnits: 16 }),
};

export const F6A_HISTORY: readonly ContractCardData[] = [EXPORT_COMPLETED, EXPORT_FAILED, ROUNDTRIP_DONE_IMPORT, ROUNDTRIP_DONE_EXPORT];

export const F6A_ALL: readonly ContractCardData[] = [...F6A_OFFERS, ...F6A_ACTIVE, ...F6A_HISTORY];

/** Galéria samostatných export kariet (jeden stav na kartu). */
export const F6A_GALLERY: readonly ContractCardData[] = [
  OFFER_EXPORT_BLOCKED,
  ACCEPTED_EXPORT,
  EXPORT_BEFORE_CUTOFF,
  EXPORT_AFTER_CUTOFF,
  EXPORT_COMPLETED,
  EXPORT_FAILED,
];

// --- Inšpektory ----------------------------------------------------------------------------------------------------------------

const SCALE = { ticksPerHour: H, ticksPerDay: D };

/** Kontajnerový dvor S: 46 / 64 TEU, z toho 30 importu a 16 exportu. */
export const F6A_YARD: ModuleInspectorData = {
  id: 4,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 46, reserved: 3, capacity: 64, unitsIn: 1_240, unitsOut: 12, unitLabel: 'TEU', split: { import: 30, export: 16, tranship: 0, empty: 0 } },
  connected: true,
  refundCents: 7_500_000,
  removable: false,
  removeBlockedReason: 'Modul obsahuje náklad',
};

const BERTH: ModuleInspectorData = {
  id: 1,
  defId: 'berth_standard',
  displayName: 'Kotvisko',
  kind: 'berth',
  footprint: { w: 8, h: 3 },
  stateLabel: 'Loď kotví',
  ok: true,
  apron: { used: 3, reserved: 1, capacity: 8 },
  connected: true,
  refundCents: 0,
  removable: false,
  removeBlockedReason: 'Na kotvisku stoja žeriavy · Pri kotvisku kotví loď',
};

/** Loď vykladá import a nakladá export súčasne: 12 / 40 TEU (4 importu, 8 exportu). */
export const F6A_BERTH_LOADING: ModuleInspectorData = {
  ...BERTH,
  dockedShip: { classLabel: 'Feeder', unitsOnBoard: 12, capacityUnits: 40, unitLabel: 'TEU', cargoSplit: { import: 4, export: 8, tranship: 0, empty: 0 } },
};

/** Po nakládke: len export na palube, lashing a papiere s progresom 62 %. */
export const F6A_BERTH_LASHING: ModuleInspectorData = {
  ...BERTH,
  stateLabel: 'Loď lashuje',
  dockedShip: {
    classLabel: 'Feeder',
    unitsOnBoard: 24,
    capacityUnits: 40,
    unitLabel: 'TEU',
    cargoSplit: { import: 0, export: 24, tranship: 0, empty: 0 },
    lashing: { ticksLeft: 1_020, totalTicks: 2_700, scale: SCALE },
  },
};

// --- Toasty nových udalostí ---------------------------------------------------------------------------------------------------

/** Callbacky sú v demo len zápis do záznamu, preto ich dodá volajúci. */
export function exportToasts(onClose: (id: number | string) => void, onShow: (id: number | string) => void): readonly ToastData[] {
  return [
    {
      id: 'cutoff',
      tone: 'warning',
      icon: 'ic_clock',
      title: 'Cut-off exportu o 6 h',
      text: '#213 · Export 36 TEU → Gdańsk · dovezené 25 / 36 TEU',
      onShow,
      onClose,
    },
    {
      id: 'rolled',
      tone: 'warning',
      icon: 'ic_warning',
      title: '3 jednotky po cut-off (rolled)',
      text: '#214 · Export 24 TEU → Rotterdam · naloží sa len ak loď ešte nezačala lashing, inak sa vráti odosielateľovi',
      onShow,
      onClose,
    },
    {
      id: 'vgm',
      tone: 'warning',
      icon: 'ic_lock',
      title: 'Chýba VGM',
      text: '#212 · Export 24 TEU → Rotterdam · zadržané: 1 jednotka, uvoľnenie o 6 h',
      onShow,
      onClose,
    },
    {
      id: 'shipped',
      tone: 'success',
      icon: 'ic_ship',
      title: 'Loď odplávala s exportom',
      text: 'Feeder · 22 TEU → Rotterdam',
      onShow,
      onClose,
    },
  ];
}

/** Penalizácie bookingu (tri druhy). */
export function penaltyToasts(onClose: (id: number | string) => void, onShow: (id: number | string) => void): readonly ToastData[] {
  return [
    {
      id: 'last_minute',
      tone: 'warning',
      icon: 'ic_warning',
      title: 'Penalizácia: last minute nakládka',
      text: '#214 · Export 24 TEU → Rotterdam · 1 jednotka · −$1,920',
      onShow,
      onClose,
    },
    {
      id: 'rolled_penalty',
      tone: 'warning',
      icon: 'ic_warning',
      title: 'Penalizácia: vrátené jednotky (rolled)',
      text: '#311 · Export 24 TEU → Rotterdam · 2 jednotky · −$4,800',
      onShow,
      onClose,
    },
    {
      id: 'unfulfilled',
      tone: 'warning',
      icon: 'ic_warning',
      title: 'Penalizácia: nesplnený booking',
      text: '#312 · Export 18 TEU → Hamburg · −$7,200',
      onShow,
      onClose,
    },
  ];
}
