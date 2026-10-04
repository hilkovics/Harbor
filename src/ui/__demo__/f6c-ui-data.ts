/**
 * Statické dáta dema F6c UI (T6C-05; ADR-034): ContractsPanel s kartami repositioningu prázdnych a prekládky (loď A → loď B),
 * odznakom linky, inšpektory depa prázdnych a skladu / lode so štyrmi smermi a toasty nových udalostí. Žiadny bridge ani simulácia —
 * komponenty sú čisto prezentačné. Mierka času a „teraz" sú z dema F5 (`time.json`); ceny jednotiek z `cargo_types.json`
 * (repositioning 12 000 ¢, prekládka 28 000 ¢ za TEU), linky z `lines.json`.
 */
import type { ContractBookingData, ContractCardData, ContractLineData } from '../contracts-panel';
import type { ModuleInspectorData } from '../module-inspector';
import type { ToastData } from '../toasts';
import { F5_TIME, NOW_TICK, TICKS_PER_DAY as D, TICKS_PER_HOUR as H } from './f5-ui-data';

export const F6C_TIME = F5_TIME;
export { NOW_TICK };

// --- Linky (`lines.json`) ---------------------------------------------------------------------------------------------------

const BLUE: ContractLineData = { id: 'blue_anchor', label: 'Blue Anchor Lines', colorToken: 'line-blue' };
const AMBER: ContractLineData = { id: 'northern_star', label: 'Northern Star Shipping', colorToken: 'line-amber' };
const TEAL: ContractLineData = { id: 'golden_wave', label: 'Golden Wave Container', colorToken: 'line-teal' };

// --- Karty kontraktov -------------------------------------------------------------------------------------------------------

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

// Ponuky: repositioning (vlastná plavba), repositioning bez depa (zablokované), prekládka s rozstupom príchodu lode B,
// export + repositioning v jednej plavbe (jedno „Prijať oba“).
const OFFER_REPO: ContractCardData = {
  ...BASE,
  id: 411,
  kind: 'empty_repositioning',
  voyageId: 411,
  volumeUnits: 24,
  rewardCents: 316_800,
  xpReward: 24,
  line: BLUE,
  offerExpiresTick: NOW_TICK + D + 2 * H,
  slaWindowTicks: 3 * D,
  availableEmpties: 17,
  booking: booking(),
};

const OFFER_REPO_BLOCKED: ContractCardData = {
  ...BASE,
  id: 412,
  kind: 'empty_repositioning',
  voyageId: 412,
  volumeUnits: 12,
  rewardCents: 158_400,
  xpReward: 12,
  line: AMBER,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  offerExpiresTick: NOW_TICK + 5 * H,
  slaWindowTicks: 4 * D,
  availableEmpties: 0,
  disabledReason: 'Chýba depo prázdnych kontajnerov (postav depo prázdnych pri rampe)',
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 12 }),
};

const OFFER_TRANSHIP: ContractCardData = {
  ...BASE,
  id: 413,
  kind: 'tranship',
  voyageId: 413,
  volumeUnits: 36,
  rewardCents: 1_159_200,
  xpReward: 36,
  line: TEAL,
  offerExpiresTick: NOW_TICK + 2 * D + 6 * H,
  slaWindowTicks: 5 * D,
  tranship: { outVoyageId: 414, outGapTicks: [D, 2 * D] },
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 36 }),
};

const OFFER_COMBINED_EXPORT: ContractCardData = {
  ...BASE,
  id: 415,
  kind: 'export',
  voyageId: 415,
  volumeUnits: 24,
  rewardCents: 960_000,
  xpReward: 24,
  line: BLUE,
  offerExpiresTick: NOW_TICK + D + 4 * H,
  slaWindowTicks: 3 * D,
  booking: booking({ cutoffLeadTicks: 12 * H }),
};

const OFFER_COMBINED_REPO: ContractCardData = {
  ...BASE,
  id: 416,
  kind: 'empty_repositioning',
  voyageId: 415,
  volumeUnits: 12,
  rewardCents: 158_400,
  xpReward: 12,
  line: BLUE,
  offerExpiresTick: NOW_TICK + D + 4 * H,
  slaWindowTicks: 3 * D,
  availableEmpties: 17,
  booking: booking({ bookedUnits: 12 }),
};

export const F6C_OFFERS: readonly ContractCardData[] = [OFFER_REPO, OFFER_REPO_BLOCKED, OFFER_TRANSHIP, OFFER_COMBINED_EXPORT, OFFER_COMBINED_REPO];

// Aktívne: prekládka čaká na loď B, vykladá sa, zmeškaná loď B; repositioning sa nakladá.
const TRANSHIP_WAITING: ContractCardData = {
  ...BASE,
  id: 511,
  kind: 'tranship',
  voyageId: 511,
  state: 'exporting',
  volumeUnits: 36,
  rewardCents: 1_159_200,
  xpReward: 36,
  line: BLUE,
  shipArrivalTick: NOW_TICK - 5 * H,
  slaDeadlineTick: NOW_TICK + 4 * D - 5 * H,
  unitsUnloaded: 36,
  tranship: { outVoyageId: 512, outArrivalTick: NOW_TICK + D + 4 * H },
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 36, arrivedUnits: 36 }),
};

const TRANSHIP_UNLOADING: ContractCardData = {
  ...BASE,
  id: 513,
  kind: 'tranship',
  voyageId: 513,
  state: 'unloading',
  volumeUnits: 36,
  rewardCents: 1_159_200,
  xpReward: 36,
  line: AMBER,
  shipArrivalTick: NOW_TICK - 2 * H,
  slaDeadlineTick: NOW_TICK + 5 * D - 2 * H,
  unitsUnloaded: 14,
  tranship: { outVoyageId: 516, outArrivalTick: NOW_TICK + 2 * D },
  booking: booking({ destinationPort: 'Gdańsk', bookedUnits: 36, arrivedUnits: 14 }),
};

const TRANSHIP_MISSED: ContractCardData = {
  ...BASE,
  id: 514,
  kind: 'tranship',
  voyageId: 514,
  state: 'exporting',
  volumeUnits: 24,
  rewardCents: 772_800,
  xpReward: 24,
  line: TEAL,
  shipArrivalTick: NOW_TICK - 2 * D,
  slaDeadlineTick: NOW_TICK + 2 * D,
  penaltiesCents: 168_000,
  unitsUnloaded: 24,
  tranship: { outVoyageId: 515, outArrivalTick: NOW_TICK - 3 * H, rescueDeadlineTick: NOW_TICK + 2 * D + 3 * H },
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 24, arrivedUnits: 24 }),
};

const REPO_LOADING: ContractCardData = {
  ...BASE,
  id: 611,
  kind: 'empty_repositioning',
  voyageId: 611,
  state: 'exporting',
  volumeUnits: 30,
  rewardCents: 396_000,
  xpReward: 30,
  line: TEAL,
  shipArrivalTick: NOW_TICK - 3 * H,
  slaDeadlineTick: NOW_TICK + 3 * D - 3 * H,
  availableEmpties: 9,
  booking: booking({ destinationPort: 'Gdańsk', bookedUnits: 30, arrivedUnits: 30, loadedUnits: 18 }),
};

const REPO_ACCEPTED: ContractCardData = {
  ...BASE,
  id: 612,
  kind: 'empty_repositioning',
  voyageId: 612,
  state: 'accepted',
  volumeUnits: 18,
  rewardCents: 237_600,
  xpReward: 18,
  line: BLUE,
  shipArrivalTick: NOW_TICK + D + 6 * H,
  slaDeadlineTick: NOW_TICK + 4 * D + 6 * H,
  availableEmpties: 22,
  booking: booking({ bookedUnits: 18 }),
};

export const F6C_ACTIVE: readonly ContractCardData[] = [TRANSHIP_WAITING, TRANSHIP_UNLOADING, TRANSHIP_MISSED, REPO_LOADING, REPO_ACCEPTED];

// História: repositioning splnený, prekládka s predanými jednotkami, prekládka zlyhaná.
const REPO_DONE: ContractCardData = {
  ...BASE,
  id: 711,
  kind: 'empty_repositioning',
  voyageId: 711,
  state: 'completed',
  volumeUnits: 24,
  rewardCents: 316_800,
  xpReward: 24,
  line: BLUE,
  slaDeadlineTick: NOW_TICK - D,
  closedTick: NOW_TICK - D - 6 * H,
  booking: booking({ bookedUnits: 24, arrivedUnits: 24, loadedUnits: 24 }),
};

const TRANSHIP_SOLD: ContractCardData = {
  ...BASE,
  id: 712,
  kind: 'tranship',
  voyageId: 712,
  state: 'completed',
  volumeUnits: 36,
  rewardCents: 1_159_200,
  xpReward: 36,
  line: AMBER,
  slaDeadlineTick: NOW_TICK - 2 * D,
  closedTick: NOW_TICK - D - 8 * H,
  penaltiesCents: 252_000,
  unitsUnloaded: 36,
  unitsExported: 6,
  tranship: { outVoyageId: 713, outArrivalTick: NOW_TICK - 2 * D - 4 * H },
  booking: booking({ destinationPort: 'Gdańsk', bookedUnits: 36, arrivedUnits: 36, loadedUnits: 30, returnedUnits: 6 }),
};

const TRANSHIP_FAILED: ContractCardData = {
  ...BASE,
  id: 714,
  kind: 'tranship',
  voyageId: 714,
  state: 'failed',
  volumeUnits: 24,
  rewardCents: 772_800,
  xpReward: 24,
  line: TEAL,
  slaDeadlineTick: NOW_TICK - 3 * D,
  closedTick: NOW_TICK - 2 * D,
  penaltiesCents: 420_000,
  unitsUnloaded: 24,
  unitsExported: 24,
  tranship: { outVoyageId: 715, outArrivalTick: NOW_TICK - 4 * D },
  booking: booking({ destinationPort: 'Hamburg', bookedUnits: 24, arrivedUnits: 24, returnedUnits: 24 }),
};

export const F6C_HISTORY: readonly ContractCardData[] = [REPO_DONE, TRANSHIP_SOLD, TRANSHIP_FAILED];

export const F6C_ALL: readonly ContractCardData[] = [...F6C_OFFERS, ...F6C_ACTIVE, ...F6C_HISTORY];

/** Galéria samostatných kariet nových druhov (jeden stav na kartu). */
export const F6C_GALLERY: readonly ContractCardData[] = [
  OFFER_REPO,
  OFFER_REPO_BLOCKED,
  OFFER_TRANSHIP,
  TRANSHIP_WAITING,
  TRANSHIP_MISSED,
  REPO_LOADING,
  TRANSHIP_SOLD,
  REPO_DONE,
];

// --- Inšpektory ---------------------------------------------------------------------------------------------------------------

const SCALE = { ticksPerHour: H, ticksPerDay: D };

const DEPOT_BASE: ModuleInspectorData = {
  id: 9,
  defId: 'empty_depot',
  displayName: 'Depo prázdnych kontajnerov',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  connected: true,
  refundCents: 11_000_000,
  removable: false,
  removeBlockedReason: 'Modul obsahuje náklad',
};

/** Depo prázdnych v prevádzke: poškodené kontajnery čakajú na voľné miesto opravy (oba boxy opravy obsadené). */
export const F6C_DEPOT_BUSY: ModuleInspectorData = {
  ...DEPOT_BASE,
  storage: { stored: 41, reserved: 2, capacity: 96, unitsIn: 212, unitsOut: 171, unitLabel: 'TEU', split: { import: 0, export: 0, tranship: 0, empty: 41 } },
  emptyDepot: {
    repairBays: 2,
    lines: [
      { lineId: BLUE.id, label: BLUE.label, colorToken: BLUE.colorToken, available: 18, damaged: 1, inRepair: 1 },
      { lineId: AMBER.id, label: AMBER.label, colorToken: AMBER.colorToken, available: 12, damaged: 0, inRepair: 1 },
      { lineId: TEAL.id, label: TEAL.label, colorToken: TEAL.colorToken, available: 7, damaged: 1, inRepair: 0 },
    ],
  },
};

/** Pokojné depo: všetko dostupné, opravy voľné. */
export const F6C_DEPOT_QUIET: ModuleInspectorData = {
  ...DEPOT_BASE,
  storage: { stored: 26, reserved: 0, capacity: 96, unitsIn: 88, unitsOut: 62, unitLabel: 'TEU', split: { import: 0, export: 0, tranship: 0, empty: 26 } },
  removable: true,
  emptyDepot: {
    repairBays: 2,
    lines: [
      { lineId: BLUE.id, label: BLUE.label, colorToken: BLUE.colorToken, available: 14, damaged: 0, inRepair: 0 },
      { lineId: AMBER.id, label: AMBER.label, colorToken: AMBER.colorToken, available: 12, damaged: 0, inRepair: 0 },
      { lineId: TEAL.id, label: TEAL.label, colorToken: TEAL.colorToken, available: 0, damaged: 0, inRepair: 0 },
    ],
  },
};

/** Bežný dvor so všetkými štyrmi smermi (prázdne uložené ako záložný sklad, prekládka čaká na loď B). */
export const F6C_YARD: ModuleInspectorData = {
  id: 4,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 42, reserved: 3, capacity: 64, unitsIn: 1_240, unitsOut: 12, unitLabel: 'TEU', split: { import: 22, export: 10, tranship: 6, empty: 4 } },
  connected: true,
  refundCents: 7_500_000,
  removable: false,
  removeBlockedReason: 'Modul obsahuje náklad',
};

/** Loď pri kotvisku nakladá export, prekládku a prázdne (repositioning): 22 / 40 TEU. */
export const F6C_BERTH: ModuleInspectorData = {
  id: 1,
  defId: 'berth_standard',
  displayName: 'Kotvisko',
  kind: 'berth',
  footprint: { w: 8, h: 3 },
  stateLabel: 'Loď kotví',
  ok: true,
  apron: { used: 3, reserved: 1, capacity: 8 },
  dockedShip: { classLabel: 'Feeder', unitsOnBoard: 22, capacityUnits: 40, unitLabel: 'TEU', cargoSplit: { import: 0, export: 8, tranship: 6, empty: 8 } },
  connected: true,
  refundCents: 0,
  removable: false,
  removeBlockedReason: 'Na kotvisku stoja žeriavy · Pri kotvisku kotví loď',
};

/** Po nakládke: export, prekládka a prázdne na palube, lashing s progresom 40 %. */
export const F6C_BERTH_LASHING: ModuleInspectorData = {
  ...F6C_BERTH,
  stateLabel: 'Loď lashuje',
  dockedShip: {
    classLabel: 'Feeder',
    unitsOnBoard: 36,
    capacityUnits: 40,
    unitLabel: 'TEU',
    cargoSplit: { import: 0, export: 12, tranship: 12, empty: 12 },
    lashing: { ticksLeft: 1_620, totalTicks: 2_700, scale: SCALE },
  },
};

// --- Toasty nových udalostí ---------------------------------------------------------------------------------------------------

/** Callbacky sú v demo len zápis do záznamu, preto ich dodá volajúci. */
export function emptyToasts(onClose: (id: number | string) => void, onShow: (id: number | string) => void): readonly ToastData[] {
  return [
    {
      id: 'returned',
      tone: 'info',
      icon: 'ic_truck',
      title: 'Návrat prázdnych',
      text: 'Blue Anchor Lines · 3 prázdne kontajnery z vnútrozemia',
      onClose,
    },
    {
      id: 'repaired',
      tone: 'success',
      icon: 'ic_check',
      title: 'Oprava hotová',
      text: 'YRD-09 · Northern Star Shipping · opravené: 1 · −$120',
      onShow,
      showLabel: 'Ukázať',
      onClose,
    },
    {
      id: 'pickup_missed',
      tone: 'warning',
      icon: 'ic_warning',
      title: 'Výdaj prázdneho zlyhal',
      text: '#415 · Export 24 TEU → Rotterdam · Golden Wave Container nemala dostupný prázdny kontajner, kamión odišiel prázdny',
      onShow,
      onClose,
    },
    {
      id: 'tranship_missed',
      tone: 'danger',
      icon: 'ic_warning',
      title: 'Tranship zmeškaný',
      text: '#514 · Tranship 24 TEU → Hamburg · loď B (plavba #515) odplávala, zmeškané: 24 jednotiek',
      onShow,
      onClose,
    },
  ];
}

/** Čo sa stalo so zmeškanými jednotkami prekládky. */
export function transhipToasts(onClose: (id: number | string) => void, onShow: (id: number | string) => void): readonly ToastData[] {
  return [
    {
      id: 'rescued',
      tone: 'info',
      icon: 'ic_ship',
      title: 'Tranship zachránený',
      text: '#514 · Tranship 24 TEU → Hamburg · zachránené: 24 jednotiek, čakajú na plavbu #518',
      onShow,
      onClose,
    },
    {
      id: 'sold',
      tone: 'warning',
      icon: 'ic_truck',
      title: 'Tranship predaný',
      text: '#712 · Tranship 36 TEU → Gdańsk · predané kamiónom (penalizácia): 6 jednotiek',
      onShow,
      onClose,
    },
  ];
}
