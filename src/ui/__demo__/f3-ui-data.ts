/**
 * Statické dáta dema F3 UI (T03-09): žiadny bridge, komponenty sú čisto prezentačné. Ceny sú z defov F3
 * (straddle carrier $48,000, dvor S $150,000, depo $90,000 — karta T03-01), nie z prototypu (dvor $90,000, depo $85,000).
 * Zámerné rozdiely voči prototypu sú vymenované v zhrnutí karty.
 */
import type { BuildBarCategory, BuildBarItem } from '../build-bar';
import type { DepotVehicleData, ModuleInspectorData } from '../module-inspector';
import type { ToastData } from '../toasts';

/** Hotovosť dema ($1,234,560 ako v prototype): stačí na všetko okrem „drahých" položiek kontrolného pásu. */
export const F3_CASH_CENTS = 123_456_000;

// --- BuildBar -----------------------------------------------------------------------------------------------------

export const YARD_S: BuildBarItem = {
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  costCents: 15_000_000,
  icon: 'ic_yard',
  footprint: { w: 4, h: 4 },
  locked: false,
  affordable: true,
};

export const DEPOT_ITEM: BuildBarItem = {
  defId: 'vehicle_depot',
  displayName: 'Depo vozidiel',
  costCents: 9_000_000,
  icon: 'ic_depot',
  footprint: { w: 3, h: 3 },
  locked: false,
  affordable: true,
};

export const STRADDLE_CARRIER: BuildBarItem = {
  defId: 'straddle_carrier',
  displayName: 'Straddle carrier',
  costCents: 4_800_000,
  icon: 'ic_vehicle',
  locked: false,
  affordable: true,
  action: 'buy',
};

function lockedCategory(id: string, label: string, icon: string): BuildBarCategory {
  return { id, label, icon, enabled: false, items: [] };
}

/** Kategórie F3: Terminál (F2), Sklady a Logistika povolené, ostatné vizuálne zamknuté. */
export const F3_CATEGORIES: readonly BuildBarCategory[] = [
  {
    id: 'terminal',
    label: 'Terminál',
    icon: 'ic_berth',
    enabled: true,
    items: [
      { defId: 'berth_standard', displayName: 'Kotvisko štandard', costCents: 40_000_000, icon: 'ic_berth', footprint: { w: 8, h: 3 }, locked: false, affordable: true },
    ],
  },
  { id: 'storage', label: 'Sklady', icon: 'ic_yard', enabled: true, items: [YARD_S] },
  { id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, items: [STRADDLE_CARRIER, DEPOT_ITEM] },
  lockedCategory('landside', 'Landside', 'ic_gate'),
  lockedCategory('rail', 'Železnica', 'ic_rail'),
  lockedCategory('pipes', 'Potrubia', 'ic_pipe'),
];

/** Kontrolný pás: všetky stavy položiek Skladov a Logistiky (dostupná, bez peňazí, zamknutá technológiou, zamknutý nákup). */
export const F3_STATES_CATEGORIES: readonly BuildBarCategory[] = [
  {
    id: 'storage',
    label: 'Sklady',
    icon: 'ic_yard',
    enabled: true,
    items: [
      YARD_S,
      { defId: 'container_yard_medium', displayName: 'Kontajnerový dvor M', costCents: 190_000_000, icon: 'ic_yard', footprint: { w: 6, h: 6 }, locked: false, affordable: false, missingCents: 190_000_000 - F3_CASH_CENTS },
      {
        defId: 'container_yard_large',
        displayName: 'Kontajnerový dvor L',
        costCents: 340_000_000,
        icon: 'ic_yard',
        footprint: { w: 8, h: 8 },
        locked: true,
        affordable: true,
        lockedReason: 'Vyžaduje technológiu Veľký dvor · 150 XP',
      },
    ],
  },
  {
    id: 'logistics',
    label: 'Logistika',
    icon: 'ic_vehicle',
    enabled: true,
    items: [
      STRADDLE_CARRIER,
      { ...STRADDLE_CARRIER, defId: 'straddle_carrier_no_depot', locked: true, lockedReason: 'Postav depo vozidiel' },
      { ...STRADDLE_CARRIER, defId: 'straddle_carrier_poor', affordable: false, missingCents: 4_800_000 - 1_000_000 },
      {
        defId: 'agv',
        displayName: 'AGV',
        costCents: 6_200_000,
        icon: 'ic_vehicle',
        locked: true,
        affordable: true,
        action: 'buy',
        lockedReason: 'Vyžaduje technológiu Automatizácia I · 180 XP',
      },
      DEPOT_ITEM,
    ],
  },
  lockedCategory('landside', 'Landside', 'ic_gate'),
];

// --- ModuleInspector ----------------------------------------------------------------------------------------------

/** Prototyp `insp_yard`: dvor so zaplnením 72 % (46 / 64 TEU), 3 rezervované sloty, pripojený. */
export const YARD_72: ModuleInspectorData = {
  id: 3,
  defId: 'container_yard_small',
  displayName: 'Kontajnerový dvor S',
  kind: 'storage',
  footprint: { w: 4, h: 4 },
  stateLabel: 'V prevádzke',
  ok: true,
  storage: { stored: 46, reserved: 3, capacity: 64, unitsIn: 1_240, unitsOut: 12, unitLabel: 'TEU' },
  connected: true,
  refundCents: 7_500_000,
  removable: false,
  removeBlockedReason: 'Sklad obsahuje náklad.',
};

/** Plný dvor (91 %, voľné 0): červené zaplnenie a žlté voľné. */
export const YARD_FULL: ModuleInspectorData = {
  ...YARD_72,
  id: 4,
  storage: { stored: 58, reserved: 6, capacity: 64, unitsIn: 2_310, unitsOut: 560, unitLabel: 'TEU' },
};

/** Prototyp `insp_gate` (vzor „Nepripojené"): dvor bez cesty ku konektoru, prázdny. */
export const YARD_DISCONNECTED: ModuleInspectorData = {
  ...YARD_72,
  id: 6,
  stateLabel: 'V prevádzke',
  storage: { stored: 0, reserved: 0, capacity: 64, unitsIn: 0, unitsOut: 0, unitLabel: 'TEU' },
  connected: false,
  refundCents: 15_000_000,
  removable: true,
  removeBlockedReason: undefined,
};

export const CARRIER_SC01: DepotVehicleData = { id: 11, label: 'Straddle carrier', state: 'busy', code: 'SC-01' };
export const CARRIER_SC02: DepotVehicleData = { id: 12, label: 'Straddle carrier', state: 'idle', code: 'SC-02', refundCents: 2_400_000 };
export const CARRIER_SC03: DepotVehicleData = { id: 13, label: 'Straddle carrier', state: 'no_path', code: 'SC-03' };
export const CARRIER_SC04: DepotVehicleData = { id: 14, label: 'Straddle carrier', state: 'idle', code: 'SC-04', refundCents: 2_400_000 };

/** Prototyp `insp_depot`: depo s dvoma vozidlami (jedno pracuje, jedno nečinné), kúpiť sa dá. */
export const DEPOT_2: ModuleInspectorData = {
  id: 1,
  defId: 'vehicle_depot',
  displayName: 'Depo vozidiel',
  kind: 'depot',
  footprint: { w: 3, h: 3 },
  stateLabel: 'V prevádzke',
  ok: true,
  depot: { vehicles: [CARRIER_SC01, CARRIER_SC02], capacity: 6, canBuy: true, buyPriceCents: 4_800_000 },
  connected: true,
  refundCents: 4_500_000,
  removable: false,
  removeBlockedReason: 'Depo s vozidlami nejde odstrániť.',
};

/** Plné depo (4 / 4) s vozidlom bez cesty: nákup zablokovaný s dôvodom. */
export const DEPOT_FULL: ModuleInspectorData = {
  ...DEPOT_2,
  id: 2,
  depot: {
    vehicles: [CARRIER_SC01, CARRIER_SC02, CARRIER_SC03, CARRIER_SC04],
    capacity: 4,
    canBuy: false,
    buyBlockedReason: 'Depo je plné (4 / 4 stání).',
    buyPriceCents: 4_800_000,
  },
};

// --- Toasts -------------------------------------------------------------------------------------------------------

type ToastSeed = Omit<ToastData, 'onClose' | 'onShow'> & { readonly withShow: boolean };

/** Dva toasty z karty (stage): „Chýba sklad" (warning) a „Nepripojené" (info s akciou „Ukázať" — centrovanie kamery). */
export const STAGE_TOAST_SEEDS: readonly ToastSeed[] = [
  {
    id: 'no-storage',
    tone: 'warning',
    icon: 'ic_warning',
    title: 'Chýba sklad',
    text: 'Kotvisko BRT-01 nemá kam uložiť kontajnery (TEU)',
    withShow: false,
  },
  {
    id: 'disconnected',
    tone: 'info',
    icon: 'ic_info',
    title: 'Nepripojené',
    text: 'Kontajnerový dvor YRD-06 nemá cestu ku konektoru',
    showLabel: 'Ukázať',
    withShow: true,
  },
];

/** Všetky štyri tóny podľa prototypu (`TT`): info, success, warning, danger. */
export const ALL_TONE_TOAST_SEEDS: readonly ToastSeed[] = [
  { id: 'offer', tone: 'info', icon: 'ic_info', title: 'Nová ponuka kontraktu', text: 'Import · Kontajnery · 1,200 TEU · SLA 6 dní', withShow: true },
  { id: 'done', tone: 'success', icon: 'ic_check', title: 'Kontrakt splnený', text: 'Export · Feeder · +$74,000', withShow: true },
  { id: 'yard-full', tone: 'warning', icon: 'ic_warning', title: 'Dvor YRD-03 je plný na 92 %', text: 'Nové kontajnery budú čakať na aprone', withShow: true },
  { id: 'gate', tone: 'danger', icon: 'ic_blocked', title: 'Brána GTE-01 nie je pripojená', text: 'Kamióny nemôžu vojsť do prístavu', withShow: true },
];
