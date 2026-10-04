/**
 * ModuleInspector (DESIGN_BRIEF §6.2 bod 4; rozloženie z prototypu design/ui/game-ui.source.html, pravý SidePanel
 * „Inspector"): hlavička (ikona modulu, názov, mono podtitul, badge stavu, zavrieť), telo (upozornenie, tri
 * číselné dlaždice, pruh kapacity, sekcia lode, riadky s údajmi) a dole akcia „Odstrániť".
 *
 * Druhy obsahu sa vykreslia podľa prítomnosti polí v `ModuleInspectorData`, nie podľa `kind` (ten určuje len
 * ikonu): kotvisko (`apron`, `dockedShip`) a žeriav (`crane`) z F2, sklad (`storage`) a depo vozidiel (`depot`,
 * zoznam vozidiel s predajom a tlačidlo „Kúpiť vozidlo v depe") z F3, brána (`gate`: fronta, priepustnosť za hodinu,
 * ticky na kamión), čakacia plocha (`waitingArea`: rad stojísk) a rampa (`ramp`: docky so staging slotmi a kamiónom)
 * z F4. `connected === false` pridá banner „Nepripojené k ceste" a žltý badge „Nepripojené" (vzor `insp_gate`
 * z prototypu) — má prednosť pred `stateLabel`; neprevádzková rampa (`ramp.operational === false`) má vlastný
 * banner s dôvodom a žltý badge „Neprevádzková" (po „Nepripojené", pred `stateLabel`). Prototypová akcia
 * „Presunúť" nie je (žiadny príkaz na presun), sparkline 24 h a politika skladu prídu s fázami, ktoré ich dáta prinesú.
 * F6a (T6A-07, ADR-032): sklad ukáže rozdelenie uskladnených jednotiek na import a export (`storage.split`), zakotvená loď
 * náklad na palube podľa smeru (`dockedShip.cargoSplit`: import na vykládku / naložený export) a stav lashing s progresom
 * (`dockedShip.lashing`: zostávajúci čas a podiel z celkovej doby, ak ju app pozná).
 * F6c (T6C-05, ADR-034): rozdelenie podľa smeru má štyri kľúče (import, export, tranship, prázdne; tranship a prázdne ukáže legenda
 * a pruh len pri nenulovom počte) a depo prázdnych (`emptyDepot`) ukáže dostupné / poškodené / v oprave podľa linky a opravárenské
 * miesta (obsadené = beží oprava).
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov): dáta zostaví rodič zo snapshotu
 * (`useSimSnapshot(selector, 100)`, T02-09/T02-10, T03-10), odstránenie ide cez `onRemove(id)` → `dispatch(RemoveModule)`,
 * nákup / predaj vozidla cez `onBuyVehicle(depotId)` / `onSellVehicle(vehicleId)` → `dispatch(BuyVehicle | SellVehicle)`.
 * Šírku dáva `--side-panel-w`, výšku kontajner (panel vyplní 100 % výšky rodiča, telo sa posúva).
 */
import { EM_DASH, formatCount, formatDuration, formatFootprint, formatFraction, formatMoney, formatPercent, type TimeScale } from './format';
import { Icon, type IconName } from './icon';
import { lineStyle } from './line-color';
import './module-inspector.css';

export type CraneStateName = 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked';

/** Stav vozidla pre zoznam v depe: `busy` = akýkoľvek pracovný stav (na ceste, nakladá, vykladá). */
export type DepotVehicleState = 'idle' | 'busy' | 'no_path';

export interface DepotVehicleData {
  readonly id: number;
  /** Názov druhu vozidla (`Straddle carrier`) — sekundárny text riadku. */
  readonly label: string;
  readonly state: DepotVehicleState;
  /** Voliteľný mono kód riadku (prototyp: `SC-01`); bez neho `#<id>`. */
  readonly code?: string;
  /** Voliteľný: čo hráč pri predaji dostane, v centoch — do tooltipu tlačidla predaja. */
  readonly refundCents?: number;
}

/**
 * F4: brána kamiónov. `throughputPerHour` = koľko kamiónov brána pustí za herný čas jednej hodiny (rodič ho počíta
 * z `processTicks` a dĺžky hodiny; nepripojená brána nepustí nikoho → 0), `processTicks` = ticky jedného kamióna.
 */
export interface GateData {
  readonly queueLength: number;
  readonly throughputPerHour: number;
  readonly processTicks: number;
}

/** F4: čakacia plocha. `occupied` = kamión stojí na bay, `reserved` = bay je rezervovaný kamiónu na ceste. */
export interface WaitingAreaData {
  readonly bays: number;
  readonly occupied: number;
  readonly reserved: number;
}

/** F4: jeden dock rampy — `staged` jednotiek pripravených v staging slotoch z `capacity`, `truck` = kamión stojí v docku. */
export interface RampDockData {
  readonly staged: number;
  readonly capacity: number;
  readonly truck: boolean;
}

/**
 * F4: nakladacia rampa. `operational === false` = žltý badge „Neprevádzková" + banner; `inoperativeReason` je hotový
 * slovenský text dôvodu (kódy simu → text: `rampInoperativeText`), bez neho sa ukáže všeobecný text.
 */
export interface RampData {
  readonly docks: readonly RampDockData[];
  readonly operational: boolean;
  readonly inoperativeReason?: string;
}

/**
 * F6a / F6c: jednotky rozdelené podľa smeru — import (príde loďou, odíde po súši), export (príde po súši, odpláva loďou),
 * prekládka (loď → loď, nikdy cez bránu) a prázdne kontajnery (návrat z vnútrozemia, depo, repositioning).
 */
export interface CargoSplitData {
  readonly import: number;
  readonly export: number;
  readonly tranship: number;
  readonly empty: number;
}

export type CargoSplitDirection = keyof CargoSplitData;

/** Poradie smerov v legende, pruhu a texte. */
export const CARGO_SPLIT_DIRECTIONS: readonly CargoSplitDirection[] = ['import', 'export', 'tranship', 'empty'];

/** Názvy smerov pre hráča (legenda, popis pruhu). */
export const CARGO_SPLIT_LABELS: Readonly<Record<CargoSplitDirection, string>> = {
  import: 'Import',
  export: 'Export',
  tranship: 'Tranship',
  empty: 'Prázdne',
};

/** Smery, ktoré legenda a pruh ukážu aj s nulou (bežný tok z F6a); tranship a prázdne len pri nenulovom počte. */
const ALWAYS_SHOWN_DIRECTIONS: ReadonlySet<CargoSplitDirection> = new Set<CargoSplitDirection>(['import', 'export']);

/** F6c: jedna linka v depe prázdnych — prázdne kontajnery podľa stavu kvality. */
export interface EmptyLineData {
  readonly lineId: string;
  /** Názov linky pre hráča (`Blue Anchor Lines`). */
  readonly label: string;
  /** Názov farebného tokenu linky (`line-blue`, bez `--`). */
  readonly colorToken: string;
  /** Dostupné (stav `available`) — dajú sa vydať exportérovi alebo naložiť. */
  readonly available: number;
  /** Poškodené (stav `damaged`) — čakajú na voľné miesto opravy. */
  readonly damaged: number;
  /** V oprave (stav `in_repair`). */
  readonly inRepair: number;
}

/** F6c: depo prázdnych kontajnerov — prázdne podľa linky a stavu a opravárenské miesta (`repairBays`). */
export interface EmptyDepotData {
  readonly lines: readonly EmptyLineData[];
  /** Počet súčasných opráv; obsadené miesta = jednotky v stave `in_repair`. */
  readonly repairBays: number;
}

/**
 * F6a: lashing a papiere lode pri kotvisku (`ship.state === 'lashing'`): zostávajúce ticky a (ak ich app pozná z defu
 * triedy lode) celková doba na výpočet progresu; `scale` je mierka času na formátovanie zostávajúceho času.
 */
export interface LashingData {
  readonly ticksLeft: number;
  readonly totalTicks?: number;
  readonly scale: TimeScale;
}

export interface ModuleInspectorData {
  readonly id: number;
  readonly defId: string;
  readonly displayName: string;
  /** `berth` | `crane` | … (`ModuleKind` zo simu) — určuje len ikonu hlavičky. */
  readonly kind: string;
  /**
   * Doplnok oproti karte T02-08 (voliteľný): rozmer v bunkách pri aktuálnej rotácii — podtitul hlavičky ako v
   * prototype (`GTE-01 · 2×2`). Bez neho je podtitul len kód modulu.
   */
  readonly footprint?: { readonly w: number; readonly h: number };
  /** Text badge v hlavičke (pri dlhšom „A — B" sa v badge ukáže len „A", celý text je v `title` a v tele). */
  readonly stateLabel: string;
  /** `true` = zelený badge, `false` = žltý (varovanie). */
  readonly ok: boolean;
  readonly apron?: { readonly used: number; readonly reserved: number; readonly capacity: number };
  /** `null` = pri kotvisku nikto nekotví (zobrazí sa prázdny stav). */
  readonly dockedShip?: {
    readonly classLabel: string;
    readonly unitsOnBoard: number;
    readonly capacityUnits: number;
    /** Doplnok oproti karte T02-08 (voliteľný): jednotka počtu, napr. `TEU`. */
    readonly unitLabel?: string;
    /** F6a: náklad na palube podľa smeru (súčet = `unitsOnBoard`); bez neho jeden segment pruhu. */
    readonly cargoSplit?: CargoSplitData;
    /** F6a: loď je v stave lashing (po nakládke, pred odplávaním). */
    readonly lashing?: LashingData;
  } | null;
  readonly crane?: {
    readonly state: CraneStateName;
    readonly utilizationPct: number;
    readonly blockedPct: number;
    /**
     * F6a (ADR-033, režim `under_hook`): žeriav drží jednotku vykládky nad nábrežím a čaká na vozidlo pod hákom (aj buffer je
     * plný). Pole je prítomné len pri `true`; badge a banner sú vtedy „Čaká na vozidlo“.
     */
    readonly waitingForVehicle?: true;
  };
  /** F3: sklad. `stored` sú fyzicky uložené jednotky (ledger), `reserved` rezervácie jobov, `unitsIn/Out` kumulatívne. */
  readonly storage?: {
    readonly stored: number;
    readonly reserved: number;
    readonly capacity: number;
    readonly unitsIn: number;
    readonly unitsOut: number;
    /** Voliteľná jednotka počtu, napr. `TEU`; bez nej `jedn.`. */
    readonly unitLabel?: string;
    /** F6a: uskladnené jednotky podľa smeru (import / export, súčet = `stored`); bez neho sekcia chýba. */
    readonly split?: CargoSplitData;
  };
  /** F6c: depo prázdnych kontajnerov (sklad s rolou `empty_depot`); bez neho pole nie je. Nahrádza dlaždice skladu a import / export rozdelenie. */
  readonly emptyDepot?: EmptyDepotData;
  /** F3: depo vozidiel. `canBuy` + `buyBlockedReason` (depo plné, nepripojené, nedostatok peňazí…) určuje rodič. */
  readonly depot?: {
    readonly vehicles: readonly DepotVehicleData[];
    readonly capacity: number;
    readonly canBuy: boolean;
    readonly buyBlockedReason?: string;
    /** Voliteľný: cena vozidla v centoch — ukáže sa v tlačidle nákupu (prototyp: „Kúpiť vozidlo v depe · $48,000"). */
    readonly buyPriceCents?: number;
  };
  /** F4: brána kamiónov (`kind: 'gate'`). */
  readonly gate?: GateData;
  /** F4: čakacia plocha (stojisko) kamiónov (`kind: 'waiting_area'`). */
  readonly waitingArea?: WaitingAreaData;
  /** F4: nakladacia rampa (`kind: 'ramp'`). */
  readonly ramp?: RampData;
  /**
   * F3 (voliteľný): modul s cestným konektorom má cestu. `false` = banner „Nepripojené k ceste" a badge „Nepripojené"
   * (má prednosť pred `stateLabel`); `undefined` / `true` = bez zmeny (moduly bez konektorov pole nemajú).
   */
  readonly connected?: boolean;
  /** Suma, ktorú hráč dostane pri odstránení, v centoch (zo zaplatenej ceny). */
  readonly refundCents: number;
  readonly removable: boolean;
  /** Dôvod, prečo sa modul nedá odstrániť (zobrazí sa pri `removable === false`). */
  readonly removeBlockedReason?: string;
}

export interface ModuleInspectorProps {
  readonly data: ModuleInspectorData;
  readonly onRemove: (id: number) => void;
  readonly onClose: () => void;
  /** F3 (voliteľný): nákup vozidla v depe `depotId`; volá sa len pri `depot.canBuy`. */
  readonly onBuyVehicle?: (depotId: number) => void;
  /** F3 (voliteľný): predaj vozidla `vehicleId`; volá sa len pri vozidle v stave `idle`. */
  readonly onSellVehicle?: (vehicleId: number) => void;
}

// --- Stav žeriavu -------------------------------------------------------------------------------------------------

/** Slovenské popisy stavov žeriavu (T02-08): pracovné fázy cyklu sú pre hráča jedno „Vykladá". */
export const CRANE_STATE_LABELS: Readonly<Record<CraneStateName, string>> = {
  idle: 'Nečinný',
  grabbing: 'Vykladá',
  swinging: 'Vykladá',
  placing: 'Vykladá',
  blocked: 'Blokovaný — plný apron',
};

/** F6a (ADR-033): žeriav s jednotkou v ruke čaká pod hákom na vozidlo (stav FSM ostáva `placing`, preto vlastný popis). */
export const CRANE_WAITING_LABEL = 'Čaká na vozidlo';

/** Popis stavu žeriavu; čakanie na vozidlo pod hákom má prednosť pred pracovnou fázou cyklu. */
export function craneStateLabel(state: CraneStateName, waitingForVehicle = false): string {
  return waitingForVehicle ? CRANE_WAITING_LABEL : CRANE_STATE_LABELS[state];
}

/** Badge je zelený, kým žeriav nie je zablokovaný ani nečaká na vozidlo (blokovaný aj čakajúci = žltý, varovanie). */
export function craneStateOk(state: CraneStateName, waitingForVehicle = false): boolean {
  return state !== 'blocked' && !waitingForVehicle;
}

// --- Čisté pomocné funkcie (testované v tests/ui/module-inspector.test.ts) ---------------------------------------

/** Ikona hlavičky podľa druhu modulu (tabuľka, nie switch); neznámy druh → `ic_inspect`. */
const MODULE_KIND_ICONS: Readonly<Record<string, IconName>> = {
  berth: 'ic_berth',
  crane: 'ic_crane',
  storage: 'ic_yard',
  gate: 'ic_gate',
  waiting_area: 'ic_waiting',
  ramp: 'ic_ramp',
  depot: 'ic_depot',
  rail_station: 'ic_rail_station',
  pipeline: 'ic_pipe',
};

export function moduleKindIcon(kind: string): IconName {
  return MODULE_KIND_ICONS[kind] ?? 'ic_inspect';
}

/** Trojpísmenné kódy druhov modulu pre podtitul hlavičky (prototyp: `YRD-03`, `DEP-01`, `GTE-01`). */
const MODULE_KIND_CODES: Readonly<Record<string, string>> = {
  berth: 'BRT',
  crane: 'CRN',
  storage: 'YRD',
  gate: 'GTE',
  waiting_area: 'WAI',
  ramp: 'RMP',
  depot: 'DEP',
  rail_station: 'RST',
  pipeline: 'PIP',
};

/** Kód modulu: `CRN-08` (druh + id doplnené na dve číslice); neznámy druh → prvé tri písmená veľkými. */
export function moduleCode(kind: string, id: number): string {
  const code = MODULE_KIND_CODES[kind] ?? kind.slice(0, 3).toUpperCase();
  const digits = String(Math.trunc(id));
  return `${code}-${digits.length < 2 ? `0${digits}` : digits}`;
}

/** Podtitul hlavičky: `CRN-08 · 2×3` (rozmer len ak je známy). */
export function moduleSubtitle(data: Pick<ModuleInspectorData, 'kind' | 'id' | 'footprint'>): string {
  const code = moduleCode(data.kind, data.id);
  return data.footprint === undefined ? code : `${code} \u00B7 ${formatFootprint(data.footprint)}`;
}

/** Oddeľovač dlhého popisu stavu: `Blokovaný — plný apron` → v badge `Blokovaný`. */
const STATE_LABEL_SEPARATOR = ' — ';

/** Krátky text do badge (celý popis je v `title` badge a v tele panelu). */
export function badgeText(stateLabel: string): string {
  const cut = stateLabel.indexOf(STATE_LABEL_SEPARATOR);
  return cut < 0 ? stateLabel : stateLabel.slice(0, cut);
}

/** Orezanie na 0–100 (neplatná hodnota → 0). */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Podiel `part / total` v percentách, orezaný na 0–100; `total <= 0` → 0. */
export function shareOf(part: number, total: number): number {
  return total > 0 ? clampPercent((part / total) * 100) : 0;
}

/** Prahy farby vyťaženosti podľa prototypu (StatsPanel): ≥ 75 % žltá, ≥ 90 % červená. */
export const UTILIZATION_WARN_PCT = 75;
export const UTILIZATION_DANGER_PCT = 90;

export type StatTone = 'normal' | 'warn' | 'danger';

export function utilizationTone(percent: number): StatTone {
  if (percent >= UTILIZATION_DANGER_PCT) return 'danger';
  if (percent >= UTILIZATION_WARN_PCT) return 'warn';
  return 'normal';
}

/** Rozdelenie času žeriavu na celé percentá, ktorých súčet je vždy presne 100 (vyťažený / blokovaný / nečinný). */
export function craneTimeSplit(crane: { readonly utilizationPct: number; readonly blockedPct: number }): {
  readonly busy: number;
  readonly blocked: number;
  readonly idle: number;
} {
  const busy = Math.round(clampPercent(crane.utilizationPct));
  const blocked = Math.min(100 - busy, Math.round(clampPercent(crane.blockedPct)));
  return { busy, blocked, idle: 100 - busy - blocked };
}

export type StatSwatch =
  | 'used'
  | 'reserved'
  | 'free'
  | 'busy'
  | 'blocked'
  | 'idle'
  | 'import'
  | 'export'
  | 'tranship'
  | 'empty'
  | 'damaged'
  | 'repair';

export interface InspectorStat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tone: StatTone;
  /**
   * Farebná značka pri hodnote dlaždice — prepája dlaždicu s farbou v pruhu (farba nikdy nie je jediný nositeľ).
   * Dlaždice bez pruhu (depo vozidiel) ju nemajú.
   */
  readonly swatch?: StatSwatch;
}

/** Voľné sloty apronu (nikdy záporné). */
export function apronFree(apron: { readonly used: number; readonly reserved: number; readonly capacity: number }): number {
  return Math.max(0, apron.capacity - apron.used - apron.reserved);
}

/** Dlaždice kotviska: obsadené / rezervované / voľné sloty apronu (voľné 0 = varovanie). */
export function berthStats(apron: { readonly used: number; readonly reserved: number; readonly capacity: number }): InspectorStat[] {
  const free = apronFree(apron);
  return [
    { key: 'used', label: 'Obsadené', value: String(apron.used), tone: 'normal', swatch: 'used' },
    { key: 'reserved', label: 'Rezervované', value: String(apron.reserved), tone: 'normal', swatch: 'reserved' },
    { key: 'free', label: 'Voľné', value: String(free), tone: free === 0 ? 'warn' : 'normal', swatch: 'free' },
  ];
}

/** Dlaždice žeriavu: vyťaženosť (farba podľa prahov) / blokovaný (žltá, ak > 0) / nečinný. */
export function craneStats(crane: { readonly utilizationPct: number; readonly blockedPct: number }): InspectorStat[] {
  const split = craneTimeSplit(crane);
  return [
    { key: 'busy', label: 'Vyťaženosť', value: formatPercent(split.busy), tone: utilizationTone(split.busy), swatch: 'busy' },
    { key: 'blocked', label: 'Blokovaný', value: formatPercent(split.blocked), tone: split.blocked > 0 ? 'warn' : 'normal', swatch: 'blocked' },
    { key: 'idle', label: 'Nečinný', value: formatPercent(split.idle), tone: 'normal', swatch: 'idle' },
  ];
}

type StorageData = NonNullable<ModuleInspectorData['storage']>;
type DepotData = NonNullable<ModuleInspectorData['depot']>;

/** Voľné sloty skladu: `kapacita − uložené − rezervované` (nikdy záporné). */
export function storageFree(storage: Pick<StorageData, 'stored' | 'reserved' | 'capacity'>): number {
  return Math.max(0, storage.capacity - storage.stored - storage.reserved);
}

/** Zaplnenie skladu v celých percentách (len fyzicky uložené jednotky; rezervácie sa nerátajú), orezané na 0–100. */
export function storageFillPct(storage: Pick<StorageData, 'stored' | 'capacity'>): number {
  return Math.round(shareOf(storage.stored, storage.capacity));
}

/** Dlaždice skladu: zaplnenie (farba podľa prahov 75 / 90 %) / rezervované / voľné (0 = varovanie). */
export function storageStats(storage: Pick<StorageData, 'stored' | 'reserved' | 'capacity'>): InspectorStat[] {
  const fill = storageFillPct(storage);
  const free = storageFree(storage);
  return [
    { key: 'fill', label: 'Zaplnenie', value: formatPercent(fill), tone: utilizationTone(fill), swatch: 'used' },
    { key: 'reserved', label: 'Rezervované', value: formatCount(storage.reserved), tone: 'normal', swatch: 'reserved' },
    { key: 'free', label: 'Voľné', value: formatCount(free), tone: free === 0 ? 'warn' : 'normal', swatch: 'free' },
  ];
}

/** Počty vozidiel podľa stavu (`busy` = pracuje, `idle` = nečinné, `noPath` = bez cesty). */
export function depotVehicleCounts(vehicles: readonly Pick<DepotVehicleData, 'state'>[]): {
  readonly busy: number;
  readonly idle: number;
  readonly noPath: number;
} {
  let busy = 0;
  let idle = 0;
  let noPath = 0;
  for (const vehicle of vehicles) {
    if (vehicle.state === 'busy') busy += 1;
    else if (vehicle.state === 'idle') idle += 1;
    else noPath += 1;
  }
  return { busy, idle, noPath };
}

/**
 * Dlaždice depa (bez farebných značiek — depo nemá pruh, ktorému by farba prislúchala): obsadenie stání (plné =
 * varovanie) / pracuje / nečinné (vozidlo bez cesty ide do zoznamu so žltou ikonou).
 */
export function depotStats(depot: Pick<DepotData, 'vehicles' | 'capacity'>): InspectorStat[] {
  const counts = depotVehicleCounts(depot.vehicles);
  const total = depot.vehicles.length;
  return [
    {
      key: 'vehicles',
      label: 'Vozidlá',
      value: formatFraction(total, depot.capacity),
      tone: depot.capacity > 0 && total >= depot.capacity ? 'warn' : 'normal',
    },
    { key: 'busy', label: 'Pracuje', value: formatCount(counts.busy), tone: 'normal' },
    { key: 'idle', label: 'Nečinné', value: formatCount(counts.idle), tone: 'normal' },
  ];
}

// --- F6c: depo prázdnych kontajnerov ----------------------------------------------------------------------------------

/** Počet prázdnych jednotiek linky v depe (všetky stavy). */
export function emptyLineTotal(line: Pick<EmptyLineData, 'available' | 'damaged' | 'inRepair'>): number {
  return wholeCount(line.available) + wholeCount(line.damaged) + wholeCount(line.inRepair);
}

export interface EmptyDepotTotals {
  readonly available: number;
  readonly damaged: number;
  readonly inRepair: number;
  readonly total: number;
  /** Obsadené opravárenské miesta (`inRepair`, najviac `repairBays`). */
  readonly repairBusy: number;
  readonly repairFree: number;
}

/** Súčty depa cez všetky linky a stav opravárenských miest. */
export function emptyDepotTotals(depot: EmptyDepotData): EmptyDepotTotals {
  let available = 0;
  let damaged = 0;
  let inRepair = 0;
  for (const line of depot.lines) {
    available += wholeCount(line.available);
    damaged += wholeCount(line.damaged);
    inRepair += wholeCount(line.inRepair);
  }
  const bays = wholeCount(depot.repairBays);
  const repairBusy = Math.min(bays, inRepair);
  return { available, damaged, inRepair, total: available + damaged + inRepair, repairBusy, repairFree: bays - repairBusy };
}

/** Dlaždice depa prázdnych: dostupné / poškodené (varovanie, ak sú) / v oprave. */
export function emptyDepotStats(depot: EmptyDepotData): InspectorStat[] {
  const totals = emptyDepotTotals(depot);
  return [
    { key: 'available', label: 'Dostupné', value: formatCount(totals.available), tone: 'normal', swatch: 'empty' },
    { key: 'damaged', label: 'Poškodené', value: formatCount(totals.damaged), tone: totals.damaged > 0 ? 'warn' : 'normal', swatch: 'damaged' },
    { key: 'repair', label: 'V oprave', value: formatCount(totals.inRepair), tone: 'normal', swatch: 'repair' },
  ];
}

/** Popis riadku linky pre čítačku: `Blue Anchor Lines: dostupné 12, poškodené 1, v oprave 0`. */
export function emptyLineText(line: EmptyLineData): string {
  return `${line.label}: dostupné ${formatCount(wholeCount(line.available))}, poškodené ${formatCount(wholeCount(line.damaged))}, v oprave ${formatCount(wholeCount(line.inRepair))}`;
}

/** Stav opravárenských miest depa: obsadené (beží oprava) → voľné; dĺžka je `repairBays`. */
export function repairBayStates(depot: EmptyDepotData): ('occupied' | 'free')[] {
  const totals = emptyDepotTotals(depot);
  const states: ('occupied' | 'free')[] = [];
  for (let index = 0; index < wholeCount(depot.repairBays); index += 1) states.push(index < totals.repairBusy ? 'occupied' : 'free');
  return states;
}

/** Poškodené kontajnery čakajú, lebo všetky opravárenské miesta sú obsadené: `Čakajú na voľné miesto opravy: 2`; inak `null`. */
export function repairWaitingText(depot: EmptyDepotData): string | null {
  const totals = emptyDepotTotals(depot);
  return totals.damaged > 0 && totals.repairFree === 0 ? `Čakajú na voľné miesto opravy: ${formatCount(totals.damaged)}` : null;
}

/** Popis a vzhľad stavu vozidla v zozname depa (prototyp: „Pracuje" / „Nečinné"; `no_path` je varovanie). */
export interface VehicleStateInfo {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: 'success' | 'muted' | 'warn';
}

export const VEHICLE_STATE_INFO: Readonly<Record<DepotVehicleState, VehicleStateInfo>> = {
  busy: { label: 'Pracuje', icon: 'ic_busy', tone: 'success' },
  idle: { label: 'Nečinné', icon: 'ic_idle', tone: 'muted' },
  no_path: { label: 'Bez cesty', icon: 'ic_warning', tone: 'warn' },
};

/** Predať sa dá len nečinné vozidlo (`SellVehicle` → `vehicle_busy`, ARCHITECTURE F3); ostatné zablokuje dôvod v tooltipe. */
export function canSellVehicle(vehicle: Pick<DepotVehicleData, 'state'>): boolean {
  return vehicle.state === 'idle';
}

export const SELL_BLOCKED_TEXT = 'Predať sa dá len nečinné vozidlo.';

/** Mono kód riadku vozidla: zadaný `code`, inak `#<id>`. */
export function vehicleCode(vehicle: Pick<DepotVehicleData, 'id' | 'code'>): string {
  return vehicle.code ?? `#${String(vehicle.id)}`;
}

/** Tooltip a `aria-label` tlačidla predaja: `Predať SC-01 · vráti $2,400` / dôvod zablokovania. */
export function sellTitle(vehicle: DepotVehicleData): string {
  const code = vehicleCode(vehicle);
  if (!canSellVehicle(vehicle)) return `${SELL_BLOCKED_TEXT} (${code})`;
  return vehicle.refundCents === undefined ? `Predať ${code}` : `Predať ${code} · vráti ${formatMoney(vehicle.refundCents)}`;
}

// --- F6a: import / export v sklade a na lodi, lashing ---------------------------------------------------------------

/** Smery, ktoré legenda a pruh ukážu: import a export vždy, tranship a prázdne len pri nenulovom počte. */
export function visibleSplitDirections(split: CargoSplitData): readonly CargoSplitDirection[] {
  return CARGO_SPLIT_DIRECTIONS.filter((direction) => ALWAYS_SHOWN_DIRECTIONS.has(direction) || wholeCount(split[direction]) > 0);
}

/**
 * Podiely smerov v celkovom počte: celé percentá so súčtom presne 100 (metóda najväčšieho zvyšku, pri zhode skôr v poradí smerov);
 * bez jednotiek samé 0.
 */
export function cargoSplitShares(split: CargoSplitData): CargoSplitData {
  const counts = CARGO_SPLIT_DIRECTIONS.map((direction) => wholeCount(split[direction]));
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return { import: 0, export: 0, tranship: 0, empty: 0 };
  const exact = counts.map((count) => (count / total) * 100);
  const shares = exact.map((value) => Math.floor(value));
  let left = 100 - shares.reduce((sum, share) => sum + share, 0);
  const byRemainder = exact.map((value, index) => ({ index, rest: value - (shares[index] ?? 0) })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    left -= 1;
  }
  const [imported = 0, exported = 0, transhipped = 0, empties = 0] = shares;
  return { import: imported, export: exported, tranship: transhipped, empty: empties };
}

/** Súčet jednotiek všetkých smerov. */
export function cargoSplitTotal(split: CargoSplitData): number {
  return CARGO_SPLIT_DIRECTIONS.reduce((sum, direction) => sum + wholeCount(split[direction]), 0);
}

/** Zoznam názvov slovensky: `a`, `a a b`, `a, b a c`. */
function joinNames(names: readonly string[]): string {
  const last = names[names.length - 1];
  if (names.length < 2 || last === undefined) return names.join('');
  return `${names.slice(0, -1).join(', ')} a ${last}`;
}

/** Názov smeru v texte: prvý s veľkým písmenom (`Import`), ďalší malými (`export`, `prázdne`). */
function directionName(direction: CargoSplitDirection, index: number): string {
  return index === 0 ? CARGO_SPLIT_LABELS[direction] : CARGO_SPLIT_LABELS[direction].toLowerCase();
}

/** Nadpis rozdelenia skladu: `Import / export`, s prekládkou a prázdnymi `Import / export / prázdne`. */
export function cargoSplitTitle(split: CargoSplitData): string {
  return visibleSplitDirections(split).map(directionName).join(' / ');
}

/** Popis pruhu skladu pre čítačku: `Obsah skladu: import a export`, `Obsah skladu: import, export a prázdne`. */
export function cargoSplitBarLabel(split: CargoSplitData): string {
  return `Obsah skladu: ${joinNames(visibleSplitDirections(split).map((direction) => CARGO_SPLIT_LABELS[direction].toLowerCase()))}`;
}

/** Popis rozdelenia pre čítačku a tooltip: `Import 12 TEU, export 8 TEU`; nenulové tranship a prázdne pribudnú (`, prázdne 4 TEU`). */
export function cargoSplitText(split: CargoSplitData, unitLabel?: string): string {
  return visibleSplitDirections(split)
    .map((direction, index) => `${directionName(direction, index)} ${formatCount(wholeCount(split[direction]), unitLabel)}`)
    .join(', ');
}

/** Podiel odpracovaného lashingu v celých percentách (0–100); bez celkovej doby `null` (progres sa nekreslí). */
export function lashingProgressPct(lashing: Pick<LashingData, 'ticksLeft' | 'totalTicks'>): number | null {
  const { totalTicks } = lashing;
  if (totalTicks === undefined || !(totalTicks > 0)) return null;
  const left = Math.min(totalTicks, Math.max(0, lashing.ticksLeft));
  return Math.round(((totalTicks - left) / totalTicks) * 100);
}

/** Text lashingu: `Lashing a papiere · zostáva 2 h` (`< 1 h`, ak zostáva menej než hodina). */
export function lashingText(lashing: Pick<LashingData, 'ticksLeft' | 'scale'>): string {
  return `Lashing a papiere · zostáva ${formatDuration(lashing.ticksLeft, lashing.scale)}`;
}

// --- F4: brána, čakacia plocha, rampa -----------------------------------------------------------------------------

/** Celé nezáporné číslo z počtu (neplatná hodnota → 0); počty kusov v dátach sú celé, UI sa nikdy nerozbije na `NaN`. */
function wholeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Text priepustnosti brány: `20 / h` (celé kamióny za hodinu); neplatná hodnota → `—`. */
export function gateThroughputText(throughputPerHour: number): string {
  return Number.isFinite(throughputPerHour) ? `${formatCount(Math.round(throughputPerHour))} / h` : EM_DASH;
}

/** Dlaždice brány: fronta pred bránou / priepustnosť za hodinu / ticky na spracovanie jedného kamióna. */
export function gateStats(gate: GateData): InspectorStat[] {
  return [
    { key: 'queue', label: 'Fronta', value: formatCount(gate.queueLength), tone: 'normal' },
    { key: 'throughput', label: 'Priepustnosť', value: gateThroughputText(gate.throughputPerHour), tone: 'normal' },
    { key: 'process', label: 'Tickov/kamión', value: formatCount(gate.processTicks), tone: 'normal' },
  ];
}

/** Stav jedného stojiska (bay) čakacej plochy. */
export type BayState = 'occupied' | 'reserved' | 'free';

/**
 * Stojiská čakacej plochy v poradí obsadené → rezervované → voľné; dĺžka je vždy `bays` (počty sa orežú, aby súčet
 * nepresiahol počet stojísk).
 */
export function bayStates(area: WaitingAreaData): BayState[] {
  const bays = wholeCount(area.bays);
  const occupied = Math.min(bays, wholeCount(area.occupied));
  const reserved = Math.min(bays - occupied, wholeCount(area.reserved));
  const states: BayState[] = [];
  for (let index = 0; index < bays; index += 1) {
    states.push(index < occupied ? 'occupied' : index < occupied + reserved ? 'reserved' : 'free');
  }
  return states;
}

/** Voľné stojiská (nikdy záporné). */
export function waitingAreaFree(area: WaitingAreaData): number {
  return bayStates(area).filter((state) => state === 'free').length;
}

/** Dlaždice čakacej plochy: obsadené / rezervované / voľné stojiská (voľné 0 = varovanie), rovnaké ako pri apron kotviska. */
export function waitingAreaStats(area: WaitingAreaData): InspectorStat[] {
  return berthStats({ used: area.occupied, reserved: area.reserved, capacity: area.bays });
}

/** Súčty rampy: docky, jednotky v staging slotoch, kapacita staging slotov a docky s kamiónom. */
export function rampTotals(ramp: Pick<RampData, 'docks'>): {
  readonly docks: number;
  readonly staged: number;
  readonly capacity: number;
  readonly trucks: number;
} {
  let staged = 0;
  let capacity = 0;
  let trucks = 0;
  for (const dock of ramp.docks) {
    staged += Math.min(wholeCount(dock.staged), wholeCount(dock.capacity));
    capacity += wholeCount(dock.capacity);
    if (dock.truck) trucks += 1;
  }
  return { docks: ramp.docks.length, staged, capacity, trucks };
}

/** Dlaždice rampy: počet dockov / jednotky v staging slotoch (farba nákladu) / kamióny v dockoch. */
export function rampStats(ramp: Pick<RampData, 'docks'>): InspectorStat[] {
  const totals = rampTotals(ramp);
  return [
    { key: 'docks', label: 'Docky', value: formatCount(totals.docks), tone: 'normal' },
    { key: 'staged', label: 'Staging', value: formatFraction(totals.staged, totals.capacity), tone: 'normal', swatch: 'used' },
    { key: 'trucks', label: 'Kamióny', value: formatCount(totals.trucks), tone: 'normal' },
  ];
}

/** Sloty staging jednotiek docku: `true` = slot obsadený pripraveným nákladom; dĺžka je `capacity`. */
export function stagingSlots(dock: Pick<RampDockData, 'staged' | 'capacity'>): boolean[] {
  const capacity = wholeCount(dock.capacity);
  const staged = Math.min(capacity, wholeCount(dock.staged));
  const slots: boolean[] = [];
  for (let index = 0; index < capacity; index += 1) slots.push(index < staged);
  return slots;
}

/** Dôvody neprevádzkovosti rampy zo simu (`LoadingRamp.inoperativeReason`) → slovenský text pre `RampData.inoperativeReason`. */
export const RAMP_INOPERATIVE_TEXTS: Readonly<Record<string, string>> = {
  no_gate: 'Chýba brána na ceste.',
  no_waiting_area: 'Chýba stojisko na ceste.',
  not_connected: 'Chýba súvislá cesta k rampe.',
  no_return_path: 'Kamióny sa nemajú ako vrátiť cez bránu k portálu.',
};

/** Všeobecný text, keď rampa je neprevádzková, ale dôvod nie je známy. */
export const RAMP_INOPERATIVE_FALLBACK = 'Rampa nemá súvislú cestu cez bránu a stojisko.';

/** Text dôvodu podľa kódu zo simu (`no_gate` …); neznámy alebo chýbajúci kód → `undefined`. */
export function rampInoperativeText(reason: string | null | undefined): string | undefined {
  return reason === null || reason === undefined ? undefined : RAMP_INOPERATIVE_TEXTS[reason];
}

/** Popis stavu docku v zozname rampy: kamión v docku / bez kamióna. */
export function dockTruckLabel(dock: Pick<RampDockData, 'truck'>): string {
  return dock.truck ? 'Kamión' : 'Bez kamióna';
}

/** Text a vzhľad badge v hlavičke; „Nepripojené" (`connected === false`) a „Neprevádzková" (rampa) majú prednosť pred stavom modulu. */
export const DISCONNECTED_BADGE_LABEL = 'Nepripojené';
export const DISCONNECTED_TITLE = 'Nepripojené k ceste';
export const INOPERATIVE_BADGE_LABEL = 'Neprevádzková';
export const INOPERATIVE_TITLE = 'Rampa je neprevádzková';

export interface InspectorBadge {
  readonly label: string;
  /** Text pre `title` (celý popis). */
  readonly title: string;
  readonly ok: boolean;
}

/** Dôvod neprevádzkovosti rampy: zadaný text, inak všeobecný. */
export function rampInoperativeReason(ramp: Pick<RampData, 'inoperativeReason'>): string {
  return ramp.inoperativeReason ?? RAMP_INOPERATIVE_FALLBACK;
}

/**
 * Badge hlavičky: „Nepripojené" (modul bez cesty) má prednosť pred „Neprevádzková" (rampa bez brány / stojiska), tá
 * pred stavom modulu. Titulok neprevádzkovej rampy nesie aj dôvod.
 */
export function inspectorBadge(data: Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'connected' | 'ramp'>): InspectorBadge {
  if (data.connected === false) return { label: DISCONNECTED_BADGE_LABEL, title: DISCONNECTED_TITLE, ok: false };
  if (data.ramp?.operational === false) {
    return { label: INOPERATIVE_BADGE_LABEL, title: `${INOPERATIVE_BADGE_LABEL} — ${rampInoperativeReason(data.ramp)}`, ok: false };
  }
  return { label: badgeText(data.stateLabel), title: data.stateLabel, ok: data.ok };
}

// --- Vykresľovanie ------------------------------------------------------------------------------------------------

function renderStats(stats: readonly InspectorStat[]) {
  return (
    <div className="module-inspector__stats">
      {stats.map((stat) => (
        <div key={stat.key} className="module-inspector__stat" data-stat={stat.key}>
          <span className="module-inspector__stat-label">{stat.label}</span>
          <div className="module-inspector__stat-row">
            <span className={`module-inspector__stat-value module-inspector__stat-value--${stat.tone}`} data-field={`stat-${stat.key}`}>
              {stat.value}
            </span>
            {stat.swatch !== undefined && (
              <span className={`module-inspector__swatch module-inspector__swatch--${stat.swatch}`} aria-hidden="true" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface BarSegment {
  readonly key: StatSwatch;
  readonly percent: number;
}

/** Pruh zloženia (8 px): segmenty idú za sebou zľava, zvyšok je podklad (`--ui-surface-2`). */
function renderBar(label: string, valueNow: number, valueMax: number, segments: readonly BarSegment[]) {
  return (
    <div
      className="module-inspector__bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
    >
      {segments.map((segment) => (
        <div
          key={segment.key}
          className={`module-inspector__bar-fill module-inspector__bar-fill--${segment.key}`}
          style={{ width: `${String(segment.percent)}%` }}
        />
      ))}
    </div>
  );
}

function renderApron(apron: NonNullable<ModuleInspectorData['apron']>) {
  return (
    <div className="module-inspector__meter" data-section="apron">
      <div className="module-inspector__meter-head">
        <span className="module-inspector__meter-label">Apron</span>
        <span data-field="apron-count">{formatFraction(apron.used, apron.capacity, 'slotov')}</span>
      </div>
      {renderBar('Zaplnenie apronu', apron.used, apron.capacity, [
        { key: 'used', percent: shareOf(apron.used, apron.capacity) },
        { key: 'reserved', percent: shareOf(apron.reserved, apron.capacity) },
      ])}
    </div>
  );
}

function renderCraneTime(crane: NonNullable<ModuleInspectorData['crane']>) {
  const split = craneTimeSplit(crane);
  return (
    <div className="module-inspector__meter" data-section="crane-time">
      <div className="module-inspector__meter-head">
        <span className="module-inspector__meter-label">Využitie času</span>
        <span data-field="crane-busy">{formatPercent(split.busy)}</span>
      </div>
      {renderBar('Rozdelenie času žeriavu', split.busy, 100, [
        { key: 'busy', percent: split.busy },
        { key: 'blocked', percent: split.blocked },
      ])}
    </div>
  );
}

/** Legenda rozdelenia podľa smeru: farebná značka + popis + počet (značka nie je jediný nositeľ — vždy aj text). */
function renderSplitLegend(section: string, split: CargoSplitData, unitLabel: string | undefined) {
  return (
    <ul className="module-inspector__legend" aria-label={cargoSplitText(split, unitLabel)} data-section={`${section}-legend`}>
      {visibleSplitDirections(split).map((direction) => (
        <li key={direction} className="module-inspector__legend-item" data-split={direction}>
          <span className={`module-inspector__swatch module-inspector__swatch--${direction}`} aria-hidden="true" />
          <span className="module-inspector__legend-label">{CARGO_SPLIT_LABELS[direction]}</span>
          <span className="module-inspector__legend-value" data-field={`${section}-${direction}`}>
            {formatCount(wholeCount(split[direction]), unitLabel)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function renderLashing(lashing: LashingData) {
  const progress = lashingProgressPct(lashing);
  return (
    <div className="module-inspector__lashing" data-section="lashing">
      <div className="module-inspector__lashing-head">
        <Icon name="ic_busy" className="module-inspector__lashing-icon" />
        <span data-field="lashing-text">{lashingText(lashing)}</span>
        {progress !== null && (
          <span className="module-inspector__lashing-value" data-field="lashing-progress">
            {formatPercent(progress)}
          </span>
        )}
      </div>
      {progress !== null && renderBar('Priebeh lashingu', progress, 100, [{ key: 'busy', percent: progress }])}
    </div>
  );
}

function renderShip(ship: NonNullable<ModuleInspectorData['dockedShip']>) {
  const { cargoSplit, lashing } = ship;
  return (
    <div className="module-inspector__ship" data-section="ship" data-lashing={lashing !== undefined}>
      <div className="module-inspector__ship-head">
        <Icon name="ic_ship" className="module-inspector__ship-icon" />
        <span className="module-inspector__ship-name" data-field="ship-class">
          {ship.classLabel}
        </span>
        <span className="module-inspector__ship-count" data-field="ship-units">
          {formatFraction(ship.unitsOnBoard, ship.capacityUnits, ship.unitLabel ?? 'jedn.')}
        </span>
      </div>
      {cargoSplit === undefined
        ? renderBar('Náklad na lodi', ship.unitsOnBoard, ship.capacityUnits, [{ key: 'used', percent: shareOf(ship.unitsOnBoard, ship.capacityUnits) }])
        : renderBar(
            'Náklad na lodi',
            ship.unitsOnBoard,
            ship.capacityUnits,
            visibleSplitDirections(cargoSplit).map((direction) => ({ key: direction, percent: shareOf(cargoSplit[direction], ship.capacityUnits) })),
          )}
      {cargoSplit !== undefined && renderSplitLegend('ship-split', cargoSplit, ship.unitLabel)}
      {lashing !== undefined && renderLashing(lashing)}
    </div>
  );
}

function renderNoShip() {
  return (
    <div className="module-inspector__ship module-inspector__ship--empty" data-section="ship">
      <div className="module-inspector__ship-head">
        <Icon name="ic_ship" className="module-inspector__ship-icon" />
        <span className="module-inspector__ship-name" data-field="ship-class">
          Žiadna loď pri kotvisku
        </span>
      </div>
    </div>
  );
}

function renderStorage(storage: StorageData) {
  return (
    <div className="module-inspector__meter" data-section="storage">
      <div className="module-inspector__meter-head">
        <span className="module-inspector__meter-label">Kapacita</span>
        <span data-field="storage-count">{formatFraction(storage.stored, storage.capacity, storage.unitLabel ?? 'jedn.')}</span>
      </div>
      {renderBar('Zaplnenie skladu', storage.stored, storage.capacity, [
        { key: 'used', percent: shareOf(storage.stored, storage.capacity) },
        { key: 'reserved', percent: shareOf(storage.reserved, storage.capacity) },
      ])}
    </div>
  );
}

/** F6a / F6c: obsah skladu podľa smeru — pruh (podiely z uskladnených jednotiek) a legenda; tranship a prázdne len pri nenulovom počte. */
function renderStorageSplit(storage: StorageData, split: CargoSplitData) {
  const shares = cargoSplitShares(split);
  const total = cargoSplitTotal(split);
  return (
    <div className="module-inspector__meter" data-section="storage-split">
      <div className="module-inspector__meter-head">
        <span className="module-inspector__meter-label">{cargoSplitTitle(split)}</span>
        <span data-field="storage-split-count">{total === 0 ? 'Prázdny' : formatCount(total, storage.unitLabel ?? 'jedn.')}</span>
      </div>
      {renderBar(
        cargoSplitBarLabel(split),
        total,
        total,
        visibleSplitDirections(split).map((direction) => ({ key: direction, percent: shares[direction] })),
      )}
      {renderSplitLegend('storage-split', split, storage.unitLabel)}
    </div>
  );
}

/** Stavy kvality prázdnych v depe v poradí riadku linky: kľúč poľa, popis a tón hodnoty. */
const EMPTY_STATUS_COLUMNS: readonly { readonly key: 'available' | 'damaged' | 'inRepair'; readonly field: string; readonly label: string; readonly tone: 'normal' | 'warn' | 'busy' }[] = [
  { key: 'available', field: 'line-available', label: 'Dostupné', tone: 'normal' },
  { key: 'damaged', field: 'line-damaged', label: 'Poškodené', tone: 'warn' },
  { key: 'inRepair', field: 'line-repair', label: 'V oprave', tone: 'busy' },
];

/**
 * F6c: prázdne v depe podľa linky a stavu kvality — rámovaný zoznam; riadok linky nesie farebnú bodku a názov (celý, bez orezania)
 * a súčet, pod ním tri počty (dostupné / poškodené / v oprave); nenulové poškodené a opravované sú zvýraznené farbou aj hrubším písmom.
 */
function renderEmptyLines(depot: EmptyDepotData) {
  return (
    <div className="module-inspector__section" data-section="empty-lines">
      <span className="module-inspector__section-title">Prázdne podľa linky</span>
      <ul className="module-inspector__lines" aria-label="Prázdne kontajnery podľa linky a stavu">
        {depot.lines.map((line) => (
          <li key={line.lineId} className="module-inspector__line" data-line={line.lineId} title={emptyLineText(line)}>
            <div className="module-inspector__line-head">
              <span className="module-inspector__line-dot" style={lineStyle(line.colorToken)} aria-hidden="true" />
              <span className="module-inspector__line-name" data-field="line-name">
                {line.label}
              </span>
              <span className="module-inspector__line-total" data-field="line-total">
                {formatCount(emptyLineTotal(line))}
              </span>
            </div>
            <dl className="module-inspector__line-counts">
              {EMPTY_STATUS_COLUMNS.map((column) => {
                const count = wholeCount(line[column.key]);
                const tone = count > 0 ? column.tone : 'normal';
                return (
                  <div key={column.key} className="module-inspector__line-count" data-status={column.key}>
                    <dt>{column.label}</dt>
                    <dd className={`module-inspector__line-value module-inspector__line-value--${tone}`} data-field={column.field}>
                      {formatCount(count)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

const REPAIR_BAY_TEXT: Readonly<Record<'occupied' | 'free', string>> = { occupied: 'oprava beží', free: 'voľné' };

/** F6c: opravárenské miesta depa — rad miest (obsadené = beží oprava) a upozornenie, keď poškodené čakajú na voľné miesto. */
function renderRepairBays(depot: EmptyDepotData) {
  const states = repairBayStates(depot);
  const waiting = repairWaitingText(depot);
  return (
    <div className="module-inspector__meter" data-section="repair-bays">
      <div className="module-inspector__meter-head">
        <span className="module-inspector__meter-label">Opravárenské miesta</span>
        <span data-field="repair-count">{formatFraction(states.filter((state) => state === 'occupied').length, states.length, 'miest')}</span>
      </div>
      <ul className="module-inspector__bays" aria-label="Obsadenosť opravárenských miest">
        {states.map((state, index) => {
          const title = `Miesto opravy ${String(index + 1)} · ${REPAIR_BAY_TEXT[state]}`;
          return (
            <li key={index} className={`module-inspector__bay module-inspector__bay--${state}`} data-bay={index} data-state={state} title={title} aria-label={title}>
              {state === 'occupied' && <Icon name="ic_build" className="module-inspector__bay-icon" />}
            </li>
          );
        })}
      </ul>
      {waiting !== null && (
        <span className="module-inspector__meter-note" data-field="repair-waiting">
          {waiting}
        </span>
      )}
    </div>
  );
}

function renderDisconnectedBanner() {
  return (
    <div className="module-inspector__banner" role="status" data-section="disconnected">
      <Icon name="ic_warning" className="module-inspector__banner-icon" />
      <div className="module-inspector__banner-text">
        <span className="module-inspector__banner-title">{DISCONNECTED_TITLE}</span>
        <span className="module-inspector__banner-desc">Konektor modulu nemá cestu. Vozidlá sa k nemu nedostanú.</span>
      </div>
    </div>
  );
}

function renderVehicles(depot: DepotData, onSellVehicle: ModuleInspectorProps['onSellVehicle']) {
  return (
    <div className="module-inspector__section" data-section="vehicles">
      <span className="module-inspector__section-title">Vozidlá v depe</span>
      {depot.vehicles.length === 0 ? (
        <p className="module-inspector__empty" data-field="vehicles-empty">
          V depe zatiaľ nie sú žiadne vozidlá.
        </p>
      ) : (
        <ul className="module-inspector__vehicles">
          {depot.vehicles.map((vehicle) => {
            const info = VEHICLE_STATE_INFO[vehicle.state];
            const sellable = canSellVehicle(vehicle);
            const title = sellTitle(vehicle);
            return (
              <li key={vehicle.id} className="module-inspector__vehicle" data-vehicle-id={vehicle.id} data-state={vehicle.state}>
                <Icon name="ic_vehicle" className="module-inspector__vehicle-icon" />
                <span className="module-inspector__vehicle-code" data-field="vehicle-code">
                  {vehicleCode(vehicle)}
                </span>
                <span className="module-inspector__vehicle-label">{vehicle.label}</span>
                <span className={`module-inspector__vehicle-state module-inspector__vehicle-state--${info.tone}`} data-field="vehicle-state">
                  <Icon name={info.icon} className="module-inspector__vehicle-state-icon" />
                  {info.label}
                </span>
                <button
                  type="button"
                  className="module-inspector__vehicle-sell"
                  aria-disabled={!sellable}
                  aria-label={title}
                  title={title}
                  data-action="sell-vehicle"
                  data-vehicle-id={vehicle.id}
                  onClick={() => {
                    if (sellable) onSellVehicle?.(vehicle.id);
                  }}
                >
                  <Icon name="ic_cash" className="module-inspector__vehicle-sell-icon" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const BAY_STATE_TEXT: Readonly<Record<BayState, string>> = { occupied: 'obsadené', reserved: 'rezervované', free: 'voľné' };

/** Rad stojísk čakacej plochy: obsadené (kamión, farba nákladu) → rezervované (svetlejšie, prerušovaný obrys) → voľné. */
function renderBays(area: WaitingAreaData) {
  const states = bayStates(area);
  return (
    <div className="module-inspector__meter" data-section="bays">
      <div className="module-inspector__meter-head">
        <span className="module-inspector__meter-label">Stojiská</span>
        <span data-field="bays-count">{formatFraction(states.filter((state) => state === 'occupied').length, states.length, 'stojísk')}</span>
      </div>
      <ul className="module-inspector__bays" aria-label="Obsadenosť stojísk">
        {states.map((state, index) => {
          const title = `Stojisko ${String(index + 1)} · ${BAY_STATE_TEXT[state]}`;
          return (
            <li key={index} className={`module-inspector__bay module-inspector__bay--${state}`} data-bay={index} data-state={state} title={title} aria-label={title}>
              {state !== 'free' && <Icon name="ic_truck" className="module-inspector__bay-icon" />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function renderInoperativeBanner(ramp: RampData) {
  return (
    <div className="module-inspector__banner" role="status" data-section="inoperative">
      <Icon name="ic_warning" className="module-inspector__banner-icon" />
      <div className="module-inspector__banner-text">
        <span className="module-inspector__banner-title">{INOPERATIVE_TITLE}</span>
        <span className="module-inspector__banner-desc" data-field="inoperative-reason">
          {rampInoperativeReason(ramp)}
        </span>
        <span className="module-inspector__banner-desc">Nedostane kamióny ani úlohy na presun nákladu.</span>
      </div>
    </div>
  );
}

/** Docky rampy: staging sloty (obsadený slot = farba nákladu), počet `staged / kapacita` a kamión v docku. */
function renderDocks(ramp: RampData) {
  return (
    <div className="module-inspector__section" data-section="docks">
      <span className="module-inspector__section-title">Docky rampy</span>
      {ramp.docks.length === 0 ? (
        <p className="module-inspector__empty" data-field="docks-empty">
          Rampa nemá žiadne docky.
        </p>
      ) : (
        <ul className="module-inspector__docks">
          {ramp.docks.map((dock, index) => {
            const slots = stagingSlots(dock);
            const staged = slots.filter(Boolean).length;
            return (
              <li key={index} className="module-inspector__dock" data-dock={index} data-truck={dock.truck}>
                <span className="module-inspector__dock-name" data-field="dock-name">{`Dock ${String(index + 1)}`}</span>
                <span
                  className="module-inspector__pips"
                  role="img"
                  aria-label={`Pripravené jednotky: ${formatFraction(staged, slots.length)}`}
                >
                  {slots.map((filled, slot) => (
                    <span key={slot} className={filled ? 'module-inspector__pip module-inspector__pip--filled' : 'module-inspector__pip'} />
                  ))}
                </span>
                <span className="module-inspector__dock-count" data-field="dock-staged">
                  {formatFraction(staged, slots.length)}
                </span>
                <span
                  className={`module-inspector__dock-truck module-inspector__dock-truck--${dock.truck ? 'present' : 'absent'}`}
                  data-field="dock-truck"
                >
                  <Icon name={dock.truck ? 'ic_truck' : 'ic_idle'} className="module-inspector__dock-truck-icon" />
                  {dockTruckLabel(dock)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ModuleInspector({ data, onRemove, onClose, onBuyVehicle, onSellVehicle }: ModuleInspectorProps) {
  const { apron, crane, dockedShip, storage, emptyDepot, depot, gate, waitingArea, ramp } = data;
  const blocked = crane?.state === 'blocked';
  const waiting = crane?.waitingForVehicle === true;
  const badge = inspectorBadge(data);
  return (
    <aside className="module-inspector" aria-label="Inšpektor modulu" data-module-id={data.id} data-def-id={data.defId} data-kind={data.kind}>
      <div className="module-inspector__header">
        <Icon name={moduleKindIcon(data.kind)} className="module-inspector__header-icon" />
        <div className="module-inspector__titles">
          <span className="module-inspector__title" data-field="title">
            {data.displayName}
          </span>
          <span className="module-inspector__sub" data-field="sub" title={data.defId}>
            {moduleSubtitle(data)}
          </span>
        </div>
        <span
          className={badge.ok ? 'module-inspector__badge module-inspector__badge--ok' : 'module-inspector__badge module-inspector__badge--warn'}
          title={badge.title}
          data-field="badge"
          data-ok={badge.ok}
        >
          <Icon name={badge.ok ? 'ic_check' : 'ic_warning'} className="module-inspector__badge-icon" />
          {badge.label}
        </span>
        <button type="button" className="module-inspector__close" title="Zavrieť (Esc)" aria-label="Zavrieť inšpektor" onClick={onClose}>
          <Icon name="ic_close" className="module-inspector__close-icon" />
        </button>
      </div>
      <div className="module-inspector__body">
        {blocked && (
          <div className="module-inspector__banner" role="status" data-section="blocked">
            <Icon name="ic_warning" className="module-inspector__banner-icon" />
            <div className="module-inspector__banner-text">
              <span className="module-inspector__banner-title">{craneStateLabel('blocked')}</span>
              <span className="module-inspector__banner-desc">
                Apron kotviska nemá voľný slot. Žeriav pokračuje, keď sa apron uvoľní.
              </span>
            </div>
          </div>
        )}
        {waiting && (
          <div className="module-inspector__banner" role="status" data-section="waiting">
            <Icon name="ic_warning" className="module-inspector__banner-icon" />
            <div className="module-inspector__banner-text">
              <span className="module-inspector__banner-title">{CRANE_WAITING_LABEL}</span>
              <span className="module-inspector__banner-desc">
                Žeriav drží kontajner nad nábrežím a pokračuje, keď vozidlo príde pod hák alebo sa uvoľní buffer na aprone.
              </span>
            </div>
          </div>
        )}
        {data.connected === false && renderDisconnectedBanner()}
        {ramp?.operational === false && renderInoperativeBanner(ramp)}
        {apron !== undefined && renderStats(berthStats(apron))}
        {crane !== undefined && renderStats(craneStats(crane))}
        {storage !== undefined && renderStats(emptyDepot === undefined ? storageStats(storage) : emptyDepotStats(emptyDepot))}
        {depot !== undefined && renderStats(depotStats(depot))}
        {gate !== undefined && renderStats(gateStats(gate))}
        {waitingArea !== undefined && renderStats(waitingAreaStats(waitingArea))}
        {ramp !== undefined && renderStats(rampStats(ramp))}
        {apron !== undefined && renderApron(apron)}
        {crane !== undefined && renderCraneTime(crane)}
        {storage !== undefined && renderStorage(storage)}
        {emptyDepot === undefined && storage?.split !== undefined && renderStorageSplit(storage, storage.split)}
        {emptyDepot !== undefined && renderEmptyLines(emptyDepot)}
        {emptyDepot !== undefined && renderRepairBays(emptyDepot)}
        {waitingArea !== undefined && renderBays(waitingArea)}
        {ramp !== undefined && renderDocks(ramp)}
        {dockedShip !== undefined && (
          <div className="module-inspector__section">
            <span className="module-inspector__section-title">Zakotvená loď</span>
            {dockedShip === null ? renderNoShip() : renderShip(dockedShip)}
          </div>
        )}
        {depot !== undefined && renderVehicles(depot, onSellVehicle)}
        <div className="module-inspector__rows">
          {storage !== undefined && (
            <>
              <div className="module-inspector__row">
                <span className="module-inspector__row-label">Prijaté celkom</span>
                <span data-field="units-in">{formatCount(storage.unitsIn, storage.unitLabel)}</span>
              </div>
              <div className="module-inspector__row">
                <span className="module-inspector__row-label">Vydané celkom</span>
                <span data-field="units-out">{formatCount(storage.unitsOut, storage.unitLabel)}</span>
              </div>
            </>
          )}
          <div className="module-inspector__row">
            <span className="module-inspector__row-label">Vrátenie pri odstránení</span>
            <span data-field="refund">{formatMoney(data.refundCents)}</span>
          </div>
        </div>
        <div className="module-inspector__actions">
          {depot !== undefined && (
            <>
              <button
                type="button"
                className="module-inspector__btn module-inspector__btn--primary"
                aria-disabled={!depot.canBuy}
                title={depot.canBuy ? undefined : depot.buyBlockedReason}
                data-action="buy-vehicle"
                onClick={() => {
                  if (depot.canBuy) onBuyVehicle?.(data.id);
                }}
              >
                <Icon name="ic_vehicle" className="module-inspector__btn-icon" />
                Kúpiť vozidlo v depe
                {depot.buyPriceCents !== undefined && (
                  <>
                    {' · '}
                    <span data-field="buy-price">{formatMoney(depot.buyPriceCents)}</span>
                  </>
                )}
              </button>
              {!depot.canBuy && depot.buyBlockedReason !== undefined && (
                <p className="module-inspector__reason">
                  <Icon name="ic_lock" className="module-inspector__reason-icon" />
                  <span data-field="buy-reason">{depot.buyBlockedReason}</span>
                </p>
              )}
            </>
          )}
          <button
            type="button"
            className="module-inspector__btn module-inspector__btn--danger"
            aria-disabled={!data.removable}
            title={data.removable ? undefined : data.removeBlockedReason}
            data-action="remove"
            onClick={() => {
              if (data.removable) onRemove(data.id);
            }}
          >
            <Icon name="ic_demolish" className="module-inspector__btn-icon" />
            Odstrániť
          </button>
          {!data.removable && data.removeBlockedReason !== undefined && (
            <p className="module-inspector__reason">
              <Icon name="ic_lock" className="module-inspector__reason-icon" />
              <span data-field="remove-reason">{data.removeBlockedReason}</span>
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
