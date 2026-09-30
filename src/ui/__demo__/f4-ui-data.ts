/**
 * Statické dáta dema F4 UI (T04-07): žiadny bridge, komponenty sú čisto prezentačné. Ceny a rozmery sú z defov F4
 * (`truck_gate` $80,000 2×2, `truck_waiting_area` $60,000 4×3, `loading_ramp_container` $100,000 4×2 — karta T04-01),
 * nie z prototypu ($60,000 / $40,000 / $55,000). Ikony položiek BuildBar dáva `moduleKindIcon(kind)`, presne ako ich
 * v hre poskladá app vrstva (T04-08) z `def.kind`. Zámerné rozdiely voči prototypu sú vymenované v zhrnutí karty.
 */
import type { BuildBarCategory, BuildBarItem } from '../build-bar';
import { moduleKindIcon, type ModuleInspectorData } from '../module-inspector';

/** Hotovosť dema ($1,234,560 ako v prototype). */
export const F4_CASH_CENTS = 123_456_000;

// --- BuildBar -----------------------------------------------------------------------------------------------------

const ROAD_TWO_LANE: BuildBarItem = {
  defId: 'road_two_lane',
  displayName: 'Cesta dvojpruhová',
  costCents: 200_000,
  priceText: '$2,000 / bunka',
  icon: 'ic_road',
  locked: false,
  affordable: true,
  action: 'road',
};

const ROAD_ONE_LANE: BuildBarItem = { ...ROAD_TWO_LANE, defId: 'road_one_lane', displayName: 'Cesta jednopruhová', costCents: 120_000, priceText: '$1,200 / bunka' };
const ROAD_ONE_WAY: BuildBarItem = { ...ROAD_TWO_LANE, defId: 'road_one_way', displayName: 'Jednosmerná cesta', costCents: 150_000, priceText: '$1,500 / bunka' };

export const GATE_ITEM: BuildBarItem = {
  defId: 'truck_gate',
  displayName: 'Brána kamiónov',
  costCents: 8_000_000,
  icon: moduleKindIcon('gate'),
  footprint: { w: 2, h: 2 },
  locked: false,
  affordable: true,
};

export const WAITING_AREA_ITEM: BuildBarItem = {
  defId: 'truck_waiting_area',
  displayName: 'Čakacia plocha',
  costCents: 6_000_000,
  icon: moduleKindIcon('waiting_area'),
  footprint: { w: 4, h: 3 },
  locked: false,
  affordable: true,
};

export const RAMP_ITEM: BuildBarItem = {
  defId: 'loading_ramp_container',
  displayName: 'Rampa · kontajnery',
  costCents: 10_000_000,
  icon: moduleKindIcon('ramp'),
  footprint: { w: 4, h: 2 },
  locked: false,
  affordable: true,
};

function lockedCategory(id: string, label: string, icon: string): BuildBarCategory {
  return { id, label, icon, enabled: false, items: [] };
}

function tabs(landsideItems: readonly BuildBarItem[]): readonly BuildBarCategory[] {
  return [
    { id: 'terminal', label: 'Terminál', icon: 'ic_berth', enabled: true, items: [] },
    { id: 'storage', label: 'Sklady', icon: 'ic_yard', enabled: true, items: [] },
    { id: 'logistics', label: 'Logistika', icon: 'ic_vehicle', enabled: true, items: [] },
    { id: 'landside', label: 'Landside', icon: 'ic_gate', enabled: true, items: landsideItems },
    lockedCategory('rail', 'Železnica', 'ic_rail'),
    lockedCategory('pipes', 'Potrubia', 'ic_pipe'),
  ];
}

/** Landside ako ho ponúkne hra: tri typy ciest a tri skutočné moduly z defov (zástupné položky F3 sú preč). */
export const F4_CATEGORIES: readonly BuildBarCategory[] = tabs([ROAD_TWO_LANE, ROAD_ONE_LANE, ROAD_ONE_WAY, GATE_ITEM, WAITING_AREA_ITEM, RAMP_ITEM]);

/** Kontrolný pás: bez peňazí (brána $80,000), zamknutá technológiou (rampa pre sypký náklad) a vybraná položka (rampa). */
export const F4_STATES_CATEGORIES: readonly BuildBarCategory[] = tabs([
  { ...GATE_ITEM, affordable: false, missingCents: GATE_ITEM.costCents - 5_000_000 },
  WAITING_AREA_ITEM,
  RAMP_ITEM,
  {
    defId: 'loading_ramp_bulk',
    displayName: 'Rampa · sypký',
    costCents: 11_000_000,
    icon: moduleKindIcon('ramp'),
    footprint: { w: 4, h: 2 },
    locked: true,
    affordable: true,
    lockedReason: 'Vyžaduje technológiu Sypké terminály · 90 XP',
  },
]);

// --- ModuleInspector ----------------------------------------------------------------------------------------------

/** Prototyp `insp_gate`, ale pripojená a v prevádzke: fronta 3 kamióny, 18 tickov na kamión = 20 kamiónov za hodinu. */
export const GATE_QUEUE_3: ModuleInspectorData = {
  id: 1,
  defId: 'truck_gate',
  displayName: 'Brána kamiónov',
  kind: 'gate',
  footprint: { w: 2, h: 2 },
  stateLabel: 'V prevádzke',
  ok: true,
  gate: { queueLength: 3, throughputPerHour: 20, processTicks: 18 },
  connected: true,
  refundCents: 8_000_000,
  removable: true,
};

/** Prototyp `insp_gate` doslova: brána bez cesty (žltý badge „Nepripojené", banner), nepustí nikoho. */
export const GATE_DISCONNECTED: ModuleInspectorData = {
  ...GATE_QUEUE_3,
  id: 2,
  gate: { queueLength: 0, throughputPerHour: 0, processTicks: 18 },
  connected: false,
};

/** Čakacia plocha: 3 kamióny stoja, 1 bay je rezervovaný (kamión je na ceste), 2 voľné. */
export const WAITING_3_OF_6: ModuleInspectorData = {
  id: 3,
  defId: 'truck_waiting_area',
  displayName: 'Čakacia plocha',
  kind: 'waiting_area',
  footprint: { w: 4, h: 3 },
  stateLabel: 'V prevádzke',
  ok: true,
  waitingArea: { bays: 6, occupied: 3, reserved: 1 },
  connected: true,
  refundCents: 6_000_000,
  removable: false,
  removeBlockedReason: 'Stojisko používa kamión.',
};

/** Plné stojisko (4 obsadené + 2 rezervované): voľné 0 = žltá dlaždica, kamión sa nespawnuje. */
export const WAITING_FULL: ModuleInspectorData = {
  ...WAITING_3_OF_6,
  id: 4,
  waitingArea: { bays: 6, occupied: 4, reserved: 2 },
};

/** Rampa v prevádzke: dock 1 má plný staging a kamión (nakladá), dock 2 čaká na kamión s jednou jednotkou. */
export const RAMP_OPERATIONAL: ModuleInspectorData = {
  id: 5,
  defId: 'loading_ramp_container',
  displayName: 'Rampa · kontajnery',
  kind: 'ramp',
  footprint: { w: 4, h: 2 },
  stateLabel: 'V prevádzke',
  ok: true,
  ramp: {
    docks: [
      { staged: 2, capacity: 2, truck: true },
      { staged: 1, capacity: 2, truck: false },
    ],
    operational: true,
  },
  connected: true,
  refundCents: 10_000_000,
  removable: false,
  removeBlockedReason: 'Na rampe je náklad.',
};

/**
 * Rampa bez brány na ceste: žltý badge „Neprevádzková" s dôvodom sa odvodí z `ramp.operational` (stateLabel ostáva
 * „V prevádzke" ako z app vrstvy), docky sú prázdne — neprevádzková rampa nedostáva outbound joby.
 */
export const RAMP_NO_GATE: ModuleInspectorData = {
  ...RAMP_OPERATIONAL,
  id: 6,
  ramp: {
    docks: [
      { staged: 0, capacity: 2, truck: false },
      { staged: 0, capacity: 2, truck: false },
    ],
    operational: false,
    inoperativeReason: 'Chýba brána na ceste.',
  },
  refundCents: 10_000_000,
  removable: true,
  removeBlockedReason: undefined,
};
