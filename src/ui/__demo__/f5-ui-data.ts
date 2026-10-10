/**
 * Statické dáta dema F5 UI (ContractsPanel, TopHUD delta + XP, GameOverModal, toasty kontraktov): žiadny bridge, komponenty
 * sú čisto prezentačné. Mierka času je z `data/defs/time.json` (tick = 10 herných sekúnd → 360 tickov/h, 8 640 tickov/deň),
 * aby demo nezaostalo za defom. Hodnoty ponúk vychádzajú z prototypu design/ui/game-ui.source.html (`C.offers`, `C.active`,
 * `C.history`), prispôsobené kontraktu ARCHITECTURE §9.1 (jednotky TEU, triedy lodí z defs).
 */
import type { ContractCardData, ContractsTimeScale } from '../contracts-panel';
import type { ToastData } from '../toasts';
import timeDef from '@data/defs/time.json';

const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

/** Ticky na hodinu a deň z `time.json` (`tickGameSeconds`). */
export const TICKS_PER_HOUR = SECONDS_PER_HOUR / timeDef.tickGameSeconds;
export const TICKS_PER_DAY = TICKS_PER_HOUR * HOURS_PER_DAY;

const H = TICKS_PER_HOUR;
const D = TICKS_PER_DAY;

/** „Teraz": Deň 12 · 14:20 (0-based deň 11), ako HUD prototypu. */
export const NOW_TICK = 11 * D + 14 * H + (20 * H) / 60;

export const F5_TIME: ContractsTimeScale = { nowTick: NOW_TICK, ticksPerHour: TICKS_PER_HOUR, ticksPerDay: TICKS_PER_DAY };

/** Hotovosť a denný výsledok dema: hodnoty prototypu ($1,234,560, +$12,300/deň; varovanie −$48,200, −$6,400/deň). */
export const F5_CASH_CENTS = 123_456_000;
export const F5_DELTA_POSITIVE_CENTS = 1_230_000;
export const F5_CASH_DEBT_CENTS = -4_820_000;
export const F5_DELTA_NEGATIVE_CENTS = -640_000;
export const F5_XP = 340;

const CENTS = 100;

// --- Ponuky ---------------------------------------------------------------------------------------------------------

const OFFER_CONTAINER: ContractCardData = {
  id: 101,
  state: 'offered',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 1200,
  rewardCents: 184_000 * CENTS,
  xpReward: 120,
  shipClassId: 'panamax',
  shipClassLabel: 'Panamax',
  offerExpiresTick: NOW_TICK + D + 4 * H,
  slaWindowTicks: 6 * D,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

/** Zablokované „Prijať": ponuka je platná, ale chýba kapacita (dôvod v `title` aj pod tlačidlami). */
const OFFER_BLOCKED: ContractCardData = {
  ...OFFER_CONTAINER,
  id: 102,
  cargoCategory: 'bulk',
  cargoLabel: 'Sypký náklad',
  unit: 't',
  volumeUnits: 32_000,
  rewardCents: 128_000 * CENTS,
  xpReward: 90,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  offerExpiresTick: NOW_TICK + 2 * D + 6 * H,
  slaWindowTicks: 3 * D,
  disabledReason: 'Chýba sklad pre sypký náklad.',
};

/** Ponuka, ktorá expiruje do 5 h (zvýraznený čas), krátke SLA 2 dni (červená pilulka). */
const OFFER_SOON: ContractCardData = {
  ...OFFER_CONTAINER,
  id: 103,
  cargoCategory: 'roro',
  cargoLabel: 'RoRo',
  unit: 'áut',
  volumeUnits: 640,
  rewardCents: 71_500 * CENTS,
  xpReward: 60,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  offerExpiresTick: NOW_TICK + 5 * H,
  slaWindowTicks: 2 * D,
};

export const F5_OFFERS: readonly ContractCardData[] = [OFFER_CONTAINER, OFFER_BLOCKED, OFFER_SOON];

// --- Aktívne (všetky stavy medzi prijatím a exportom) ------------------------------------------------------------------

/** Prijaté, loď sa ešte nevydala; 0 / 0 progres. */
const ACCEPTED: ContractCardData = {
  id: 201,
  state: 'accepted',
  cargoCategory: 'liquid',
  cargoLabel: 'Kvapaliny',
  unit: 'm³',
  volumeUnits: 18_000,
  rewardCents: 96_000 * CENTS,
  xpReward: 80,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  offerExpiresTick: NOW_TICK,
  slaWindowTicks: 3 * D,
  shipArrivalTick: NOW_TICK + 20 * H,
  slaDeadlineTick: NOW_TICK + 20 * H + 3 * D,
  unitsUnloaded: 0,
  unitsExported: 0,
  penaltiesCents: 0,
};

const EN_ROUTE: ContractCardData = {
  ...ACCEPTED,
  id: 202,
  state: 'ship_en_route',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 800,
  rewardCents: 74_000 * CENTS,
  xpReward: 70,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  shipArrivalTick: NOW_TICK + 5 * H,
  slaDeadlineTick: NOW_TICK + 5 * H + 6 * D,
};

const UNLOADING: ContractCardData = {
  ...ACCEPTED,
  id: 203,
  state: 'unloading',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 2400,
  rewardCents: 352_000 * CENTS,
  xpReward: 240,
  shipClassId: 'mega',
  shipClassLabel: 'Mega',
  shipArrivalTick: NOW_TICK - 9 * H,
  slaDeadlineTick: NOW_TICK + 4 * D - 9 * H,
  unitsUnloaded: 1820,
  unitsExported: 640,
  // Demurrage: loď stojí nad `berthAllowanceTicks`.
  penaltiesCents: 8_800 * CENTS,
};

const EXPORTING: ContractCardData = {
  ...ACCEPTED,
  id: 204,
  state: 'exporting',
  cargoCategory: 'container',
  cargoLabel: 'Kontajnery',
  unit: 'TEU',
  volumeUnits: 600,
  rewardCents: 58_000 * CENTS,
  xpReward: 55,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  shipArrivalTick: NOW_TICK - 2 * D,
  slaDeadlineTick: NOW_TICK + 5 * D + 3 * H,
  unitsUnloaded: 600,
  unitsExported: 420,
};

/** Ohrozené: do SLA termínu zostáva menej než deň. */
const AT_RISK: ContractCardData = {
  ...EXPORTING,
  id: 205,
  cargoCategory: 'gas',
  cargoLabel: 'Plyn',
  unit: 'm³',
  volumeUnits: 9500,
  rewardCents: 142_000 * CENTS,
  xpReward: 100,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  slaDeadlineTick: NOW_TICK + 8 * H,
  unitsUnloaded: 9500,
  unitsExported: 3100,
};

/** Po termíne: neskorý export, penalizácie 5 % odmeny za deň. */
const OVERDUE: ContractCardData = {
  ...EXPORTING,
  id: 206,
  cargoCategory: 'bulk',
  cargoLabel: 'Sypký náklad',
  unit: 't',
  volumeUnits: 12_000,
  rewardCents: 52_000 * CENTS,
  xpReward: 45,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  slaDeadlineTick: NOW_TICK - D - 6 * H,
  unitsUnloaded: 12_000,
  unitsExported: 7_400,
  penaltiesCents: 2_600 * CENTS,
};

export const F5_ACTIVE: readonly ContractCardData[] = [UNLOADING, AT_RISK, EXPORTING, EN_ROUTE, ACCEPTED, OVERDUE];

// --- História ---------------------------------------------------------------------------------------------------------------

const COMPLETED_ON_TIME: ContractCardData = {
  ...EXPORTING,
  id: 301,
  state: 'completed',
  cargoCategory: 'container',
  volumeUnits: 800,
  unitsUnloaded: 800,
  unitsExported: 800,
  rewardCents: 74_000 * CENTS,
  xpReward: 70,
  slaDeadlineTick: NOW_TICK - D,
  closedTick: NOW_TICK - D - 6 * H,
};

const COMPLETED_LATE: ContractCardData = {
  ...COMPLETED_ON_TIME,
  id: 302,
  cargoCategory: 'roro',
  cargoLabel: 'RoRo',
  unit: 'áut',
  volumeUnits: 420,
  unitsUnloaded: 420,
  unitsExported: 420,
  rewardCents: 46_500 * CENTS,
  xpReward: 40,
  shipClassId: 'feeder',
  shipClassLabel: 'Feeder',
  slaDeadlineTick: NOW_TICK - 4 * D,
  closedTick: NOW_TICK - 3 * D - 3 * H,
  penaltiesCents: 2_100 * CENTS,
};

const FAILED: ContractCardData = {
  ...COMPLETED_ON_TIME,
  id: 303,
  state: 'failed',
  cargoCategory: 'bulk',
  cargoLabel: 'Sypký náklad',
  unit: 't',
  volumeUnits: 12_000,
  unitsUnloaded: 12_000,
  unitsExported: 4_100,
  rewardCents: 52_000 * CENTS,
  xpReward: 45,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  slaDeadlineTick: NOW_TICK - 6 * D,
  closedTick: NOW_TICK - 3 * D,
  penaltiesCents: 24_000 * CENTS,
};

const EXPIRED: ContractCardData = {
  ...OFFER_CONTAINER,
  id: 304,
  state: 'expired',
  cargoCategory: 'liquid',
  cargoLabel: 'Kvapaliny',
  unit: 'm³',
  volumeUnits: 18_000,
  rewardCents: 96_000 * CENTS,
  xpReward: 80,
  shipClassId: 'handy',
  shipClassLabel: 'Handy',
  offerExpiresTick: NOW_TICK - 2 * D,
  closedTick: NOW_TICK - 2 * D,
};

export const F5_HISTORY: readonly ContractCardData[] = [COMPLETED_ON_TIME, COMPLETED_LATE, FAILED, EXPIRED];

/** Všetky karty (počty záložiek: Ponuky · 3, Aktívne · 6). */
export const F5_ALL: readonly ContractCardData[] = [...F5_OFFERS, ...F5_ACTIVE, ...F5_HISTORY];

/** Galéria: jedna karta na každý stav + odvodené stavy (Ohrozené, Po termíne) a zablokovaná ponuka. */
export const F5_GALLERY: readonly ContractCardData[] = [
  OFFER_CONTAINER,
  OFFER_BLOCKED,
  OFFER_SOON,
  ACCEPTED,
  EN_ROUTE,
  UNLOADING,
  EXPORTING,
  AT_RISK,
  OVERDUE,
  COMPLETED_ON_TIME,
  COMPLETED_LATE,
  FAILED,
  EXPIRED,
];

/** Ponuky pre ukážku „Ponuky · 0" (prototyp `contracts_empty`): ostatné záložky sú plné. */
export const F5_NO_OFFERS: readonly ContractCardData[] = [...F5_ACTIVE, ...F5_HISTORY];

/** Ďalšia ponuka príde o 2 dni (text prázdneho stavu prototypu). */
export const F5_NEXT_OFFER_TICKS = 2 * D;

// --- Toasty udalostí kontraktov (obsah určuje app vrstva; tu len ukážka tónov) ----------------------------------------------

/** Callbacky sú v demo len zápis do záznamu, preto ich dodá volajúci. */
export function contractToasts(onClose: (id: number | string) => void, onShow: (id: number | string) => void): readonly ToastData[] {
  return [
    {
      id: 'payout',
      tone: 'success',
      icon: 'ic_check',
      title: 'Kontrakt splnený',
      text: 'Kontajnery · Feeder · +$74,000, +70 XP',
      onShow,
      onClose,
    },
    {
      id: 'penalty',
      tone: 'warning',
      icon: 'ic_warning',
      title: 'Penalizácia za státie lode',
      text: 'Mega stojí pri kotvisku nad limit · −$8,800',
      onShow,
      onClose,
    },
    {
      id: 'failed',
      tone: 'danger',
      icon: 'ic_blocked',
      title: 'Kontrakt zlyhal',
      text: 'Sypký náklad · odmena prepadla, penalizácie −$24,000',
      onShow,
      onClose,
    },
  ];
}
