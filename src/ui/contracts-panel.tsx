/**
 * ContractsPanel (DESIGN_BRIEF §6.2 bod 3; rozloženie z prototypu design/ui/game-ui.source.html, pravý panel
 * `contracts` a `contracts_empty`): hlavička „Kontrakty", záložky Ponuky / Aktívne / História (s počtami) a zoznam kariet.
 * Karta: glyf kategórie, typ nákladu, objem (TEU) + XP, odmena, SLA (pilulka s farbou podľa naliehavosti), trieda lode,
 * stav; pri aktívnom kontrakte progres `Vyložené` / `Exportované` voči objemu a penalizácie; pri ponuke čas do
 * expirácie a tlačidlá „Prijať" / „Odmietnuť".
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov a bez čítania simulácie): zoznam `ContractCardData`, aktívnu
 * záložku a mierku času dodáva app vrstva (Fáza 5), zápis ide výlučne cez callbacky `onAccept(id)` / `onDecline(id)`
 * (rodič z nich pošle `AcceptContractCommand` / `DeclineContractCommand` cez `dispatch`). Zablokované „Prijať" nesie
 * dôvod (`disabledReason`): tlačidlo je `aria-disabled`, dôvod je v `title` aj viditeľný pod tlačidlami.
 *
 * Časy sú v tickoch (`slaDeadlineTick`, `offerExpiresTick`…) a `time.nowTick` je aktuálny tick; ako ich previesť na dni
 * a hodiny určuje `time.ticksPerHour` / `time.ticksPerDay` (z `SimClock`), formátuje `formatDuration`.
 *
 * F6a (T6A-07, ADR-032): kontrakt má druh (`kind`: `import` | `export`), voyage (`voyageId`) a pri exporte booking
 * (`booking`: cieľový prístav, cut-off, bookované / dovezené / naložené TEU, zadržané VGM, rolled, vrátené). Karty jednej
 * voyage sa zoskupia: import-only a export-only kontrakt je samostatná karta, import + export booking (roundtrip) je
 * jedna spoločná karta voyage s časťou Import a časťou Export a jedným „Prijať" / „Odmietnuť" (sim prijme celú skupinu
 * ponuky, ADR-032 bod 1; callbacky dostanú id prvého kontraktu skupiny). Záložku skupiny určuje jej najaktívnejší kontrakt.
 *
 * F6c (T6C-05, ADR-034): každý kontrakt môže niesť linku (`line`: odznak s farbou z tokenu linky), pribudli druhy
 * `empty_repositioning` (booking prázdnych kontajnerov linky na loď: linka, počet prázdnych, cieľový prístav a plavba,
 * dostupné prázdne v prístave, naložené) a `tranship` (loď A privezie, loď B odvezie: trasa A → B s odpočtom do príchodu B,
 * vyložené / čakajúce / naložené / zmeškané, predané). Karty druhov sa skladajú z tabuľky sekcií `KIND_SECTIONS`
 * (nový druh = nový riadok), názvy a stavy podľa druhu sú tabuľky (`KIND_PART_NAME`, `STATUS_BY_KIND`).
 */
import type { ReactNode } from 'react';
import {
  EM_DASH,
  formatCount,
  formatDuration,
  formatFraction,
  formatMoney,
  formatMoneyDelta,
  formatXp,
  moneySign,
  type TimeScale,
} from './format';
import { Icon, toIconName, type IconName } from './icon';
import { lineStyle } from './line-color';
import './contracts-panel.css';

/** Stavy kontraktu presne podľa ARCHITECTURE §9.1. */
export type ContractCardState =
  | 'offered'
  | 'accepted'
  | 'ship_en_route'
  | 'unloading'
  | 'exporting'
  | 'completed'
  | 'failed'
  | 'expired';

/** Kategória nákladu (farba a glyf karty): `--cargo-<kategória>`, `ic_<kategória>`. */
export type ContractCargoCategory = 'container' | 'bulk' | 'liquid' | 'gas' | 'roro';

/** Id kontraktu (v simulácii branded číslo; UI ho len vracia v callbackoch). */
export type ContractCardId = number | string;

export type ContractsTab = 'offers' | 'active' | 'history';

/**
 * Druh kontraktu (ADR-032, ADR-034): import = náklad príde loďou a odíde po súši; export = booking, náklad príde po súši a
 * odpláva loďou; empty_repositioning = booking prázdnych kontajnerov linky z depa na loď; tranship = loď A privezie, loď B odvezie.
 */
export type ContractCardKind = 'import' | 'export' | 'empty_repositioning' | 'tranship';

/** Linka kontraktu (`lines.json`): názov pre hráča a názov farebného tokenu (`line-blue`, bez `--`). */
export interface ContractLineData {
  readonly id: string;
  readonly label: string;
  readonly colorToken: string;
}

/**
 * Prekládka loď A → loď B (`TranshipLeg` zo simu pre UI). Loď A je loď karty (`shipArrivalTick`, `shipClassLabel`, `voyageId`),
 * loď B nesie plavba `outVoyageId` a plánovaný príchod `outArrivalTick` (od prijatia).
 */
export interface ContractTranshipData {
  /** Plavba lode B (po záchrane zmeškanej prekládky ďalšia plavba linky). */
  readonly outVoyageId: ContractCardId;
  /** Plánovaný príchod lode B (od prijatia); ponuka ho nemá a ukáže `outGapTicks`. */
  readonly outArrivalTick?: number;
  /** Rozstup príchodu lode B po lodi A v tickoch `[min, max]` (def `transhipGapDaysRange`); relevantné pre ponuku. */
  readonly outGapTicks?: readonly [number, number];
  /** Trieda lode B, ak ju app pozná (loď už vznikla); bez nej sa ukáže len „Loď B“. */
  readonly outShipLabel?: string;
  /** Do kedy zmeškaná prekládka čaká na záchranu; prítomné = loď B odplávala bez jednotiek (zmeškané). */
  readonly rescueDeadlineTick?: number;
}

/**
 * Booking exportu (`ExportBooking` zo simu pre UI). `cutoffTick` je od prijatia; ponuka ho nemá a ukáže
 * `cutoffLeadTicks` (za koľko tickov pred príchodom lode cut-off nastane).
 */
export interface ContractBookingData {
  /** Cieľový prístav (`Rotterdam`). */
  readonly destinationPort: string;
  readonly cutoffTick?: number;
  /** Odstup cut-off od príchodu lode v tickoch (def `cutoffHours`); relevantné pre ponuku. */
  readonly cutoffLeadTicks?: number;
  /** Bookované TEU (= `volumeUnits` kontraktu). */
  readonly bookedUnits: number;
  /** Ešte nedorazené jednotky z plánu príchodov kamiónov (`arrivalPlan.length`). */
  readonly pendingArrivals: number;
  /** Jednotky, ktoré prešli bránou dnu (dovezené). */
  readonly arrivedUnits: number;
  readonly loadedUnits: number;
  /** Z naložených tie, ktoré prišli po cut-off. */
  readonly lastMinuteUnits: number;
  /** Jednotky, ktoré prišli po cut-off (rolled). */
  readonly rolledUnits: number;
  /** Jednotky vrátené odosielateľovi po súši. */
  readonly returnedUnits: number;
  /** Jednotky práve v VGM hold. */
  readonly heldUnits: number;
}

/** Dáta jednej karty. Polia `volumeUnits`…`offerExpiresTick` zodpovedajú `Contract` z ARCHITECTURE §9.1. */
export interface ContractCardData {
  readonly id: ContractCardId;
  /** Druh kontraktu; bez neho `import` (karty spred F6a). */
  readonly kind?: ContractCardKind;
  /** Návšteva lode, ku ktorej kontrakt patrí; kontrakty s rovnakou voyage tvoria jednu kartu. Bez nej = `id`. */
  readonly voyageId?: ContractCardId;
  readonly state: ContractCardState;
  readonly cargoCategory: ContractCargoCategory;
  /** Názov nákladu pre hráča (`Kontajnery`). */
  readonly cargoLabel: string;
  /** Jednotka objemu (`TEU`). */
  readonly unit: string;
  /** Počet jednotiek (kontajnerov) kontraktu. */
  readonly volumeUnits: number;
  /** R2: objem v TEU (20′ = 1, 40′ = 2); chýba = `volumeUnits` (náklad mimo kontajnerov, staršie karty). */
  readonly volumeTeu?: number;
  readonly rewardCents: number;
  readonly xpReward: number;
  readonly shipClassId: string;
  /** Názov triedy lode pre hráča; bez neho sa ukáže `shipClassId`. */
  readonly shipClassLabel?: string;
  /** Tick, kedy ponuka expiruje (relevantné pre `offered`). */
  readonly offerExpiresTick: number;
  /** Dĺžka SLA okna (v tickoch) z šablóny; potrebná len pre ponuku, kým ešte nie je `slaDeadlineTick`. */
  readonly slaWindowTicks?: number;
  readonly slaDeadlineTick?: number;
  readonly shipArrivalTick?: number;
  /** Tick uzavretia (completed / failed / expired) — do nej sa v histórii počíta „včas" / „o N neskôr". */
  readonly closedTick?: number;
  readonly unitsUnloaded: number;
  readonly unitsExported: number;
  readonly penaltiesCents: number;
  /** Dôvod, prečo sa ponuku nedá prijať (napr. „Nedostatok kapacity"); pri jeho prítomnosti je „Prijať" zablokované. */
  readonly disabledReason?: string;
  /** Linka kontraktu (odznak s farbou linky); bez nej sa odznak nekreslí. */
  readonly line?: ContractLineData;
  /** Booking exportu, repositioningu a prekládky (`kind` ≠ `import`); pri repositioningu `destinationPort` je cieľ lode. */
  readonly booking?: ContractBookingData;
  /** Trasa prekládky A → B; len kontrakt `kind: 'tranship'`. */
  readonly tranship?: ContractTranshipData;
  /** Repositioning: dostupné prázdne kontajnery linky v prístave (stav `available` v skladoch), pre „V prístave je N dostupných”. */
  readonly availableEmpties?: number;
  /** R2: počet 20′ kontajnerov (voliteľný); bez neho sa nekreslí rozdelenie veľkostí. */
  readonly count20?: number;
  /** R2: počet 40′ kontajnerov (voliteľný); bez neho sa nekreslí rozdelenie veľkostí. */
  readonly count40?: number;
}

/** Aktuálny čas simulácie a mierka na prevod ticku na dni/hodiny. */
export interface ContractsTimeScale extends TimeScale {
  readonly nowTick: number;
}

export interface ContractsPanelProps {
  readonly contracts: readonly ContractCardData[];
  readonly tab: ContractsTab;
  readonly onTabChange: (tab: ContractsTab) => void;
  readonly time: ContractsTimeScale;
  readonly onAccept: (id: ContractCardId) => void;
  readonly onDecline: (id: ContractCardId) => void;
  readonly onClose?: () => void;
  /** Za koľko ticků príde ďalšia ponuka (prázdny stav Ponúk); `null`/vynechané = text bez času. */
  readonly nextOfferInTicks?: number | null;
}

// --- Čisté pomocné funkcie (testované samostatne) ---------------------------------------------------------------------

/** Prah dní, od ktorého je SLA zelené (≥ 5 dní) a žlté (≥ 3 dni); pod ním červené (prototyp `slaC`). */
export const SLA_OK_DAYS = 5;
export const SLA_WARN_DAYS = 3;
/** Aktívny kontrakt s SLA pod týmto počtom dní je „Ohrozené" (prototyp: SLA 1 deň → Ohrozené). */
export const AT_RISK_DAYS = 1;

export const CONTRACT_TAB_LABELS: Readonly<Record<ContractsTab, string>> = {
  offers: 'Ponuky',
  active: 'Aktívne',
  history: 'História',
};

const TAB_ORDER: readonly ContractsTab[] = ['offers', 'active', 'history'];

/** Záložka, do ktorej stav patrí: ponuka / prebiehajúci kontrakt / uzavretý kontrakt. */
export function contractTab(state: ContractCardState): ContractsTab {
  if (state === 'offered') return 'offers';
  if (state === 'completed' || state === 'failed' || state === 'expired') return 'history';
  return 'active';
}

/** Druh kontraktu karty (`import`, ak ho dáta neuvádzajú). */
export function contractKind(contract: ContractCardData): ContractCardKind {
  return contract.kind ?? 'import';
}

/** Voyage karty (bez `voyageId` je každý kontrakt vlastná voyage). */
export function contractVoyageId(contract: ContractCardData): ContractCardId {
  return contract.voyageId ?? contract.id;
}

/** Kontrakty jednej voyage (vzostupne podľa id) = jedna karta v paneli. */
export interface VoyageGroup {
  readonly voyageId: ContractCardId;
  readonly parts: readonly ContractCardData[];
}

/**
 * Zoskupenie kontraktov podľa voyage: skupiny v poradí prvého výskytu, kontrakty v skupine vzostupne podľa id
 * (číselné id; textové sa nepreraďujú). Import-only a export-only kontrakt je skupina s jednou časťou.
 */
export function voyageGroups(contracts: readonly ContractCardData[]): readonly VoyageGroup[] {
  const groups = new Map<ContractCardId, ContractCardData[]>();
  for (const contract of contracts) {
    const key = contractVoyageId(contract);
    const parts = groups.get(key);
    if (parts === undefined) groups.set(key, [contract]);
    else parts.push(contract);
  }
  return [...groups].map(([voyageId, parts]) => ({
    voyageId,
    parts: parts.length < 2 ? parts : [...parts].sort((a, b) => (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0)),
  }));
}

/** Záložka skupiny: ponuka, ak je ponukou ktorýkoľvek jej kontrakt; inak aktívna, kým je aktívny niektorý; inak história. */
export function voyageTab(group: VoyageGroup): ContractsTab {
  const tabs = group.parts.map((part) => contractTab(part.state));
  if (tabs.includes('offers')) return 'offers';
  return tabs.includes('active') ? 'active' : 'history';
}

/** Druh karty voyage: `roundtrip` = import aj export booking v jednej voyage, `combined` = iná zmes druhov (napr. export + prázdne). */
export type VoyageKind = ContractCardKind | 'roundtrip' | 'combined';

export function voyageKind(group: VoyageGroup): VoyageKind {
  const kinds = new Set(group.parts.map(contractKind));
  const [only] = kinds;
  if (only === undefined) return 'import';
  if (kinds.size === 1) return only;
  return kinds.size === 2 && kinds.has('import') && kinds.has('export') ? 'roundtrip' : 'combined';
}

/** Názov druhu v názve časti a v zozname objemov karty voyage (`Import`, `Export`, `Prázdne`, `Tranship`). */
export const KIND_PART_NAME: Readonly<Record<ContractCardKind, string>> = {
  import: 'Import',
  export: 'Export',
  empty_repositioning: 'Prázdne',
  tranship: 'Tranship',
};

/** Názov karty voyage podľa jej častí: `Import + export`, `Export + prázdne` (len prvé písmeno veľké). */
export function voyageTitle(group: VoyageGroup): string {
  const names = group.parts.map((part) => KIND_PART_NAME[contractKind(part)]);
  return names.map((name, index) => (index === 0 ? name : name.toLowerCase())).join(' + ');
}

/** Objem karty v jednotke karty (TEU): `volumeTeu`, bez neho `volumeUnits`. */
export function volumeOf(contract: Pick<ContractCardData, 'volumeUnits' | 'volumeTeu'>): number {
  return contract.volumeTeu ?? contract.volumeUnits;
}

/** Objem kontraktu pre hráča: `24 TEU`, pri repositioningu `24 TEU prázdnych`. */
export function volumeText(contract: ContractCardData): string {
  const base = formatCount(volumeOf(contract), contract.unit);
  let text = contractKind(contract) === 'empty_repositioning' ? `${base} prázdnych` : base;
  // R2: rozdelenie na 20′ a 40′ (počty kontajnerov), ak ho karta nesie; hlavné číslo sú TEU
  if (contract.count20 !== undefined && contract.count40 !== undefined) {
    text += ` (${contract.count20}× 20′, ${contract.count40}× 40′)`;
  }
  return text;
}

/** Počty kariet (skupín voyage) na záložku (do popisiek záložiek). */
export function tabCounts(contracts: readonly ContractCardData[]): Readonly<Record<ContractsTab, number>> {
  const counts: Record<ContractsTab, number> = { offers: 0, active: 0, history: 0 };
  for (const group of voyageGroups(contracts)) counts[voyageTab(group)] += 1;
  return counts;
}

/** Kontrakty jednej záložky v poradí, v akom ich dodal rodič (karty skladá `voyageCardsForTab`). */
export function contractsForTab(contracts: readonly ContractCardData[], tab: ContractsTab): readonly ContractCardData[] {
  return contracts.filter((contract) => contractTab(contract.state) === tab);
}

/** Karty (skupiny voyage) jednej záložky v poradí prvého výskytu. */
export function voyageCardsForTab(contracts: readonly ContractCardData[], tab: ContractsTab): readonly VoyageGroup[] {
  return voyageGroups(contracts).filter((group) => voyageTab(group) === tab);
}

/**
 * Suma vpravo hore: splnený import = odmena − penalizácie, splnený export = odmena pomerne k naloženým TEU (`⌊odmena ×
 * naložené / bookované⌋`, ADR-032 bod 14) − penalizácie, zlyhaný = −penalizácie (odmena prepadá), inak odmena.
 */
export function contractPayoutCents(contract: ContractCardData): number {
  if (contract.state === 'completed') {
    const { booking } = contract;
    const earned = booking === undefined || booking.bookedUnits <= 0 ? contract.rewardCents : Math.floor((contract.rewardCents * booking.loadedUnits) / booking.bookedUnits);
    return earned - contract.penaltiesCents;
  }
  if (contract.state === 'failed') return -contract.penaltiesCents;
  return contract.rewardCents;
}

/** Súčet súm častí karty voyage (`contractPayoutCents`). */
export function voyagePayoutCents(group: VoyageGroup): number {
  return group.parts.reduce((sum, part) => sum + contractPayoutCents(part), 0);
}

export type ContractTone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'muted';

export interface ContractSla {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'danger' | 'muted';
  readonly title: string;
}

function slaToneForDays(days: number): 'ok' | 'warn' | 'danger' {
  if (days >= SLA_OK_DAYS) return 'ok';
  return days >= SLA_WARN_DAYS ? 'warn' : 'danger';
}

/**
 * SLA pilulka: ponuka = dĺžka okna po príchode lode; aktívny = zostávajúci čas (po termíne `po termíne o …`);
 * uzavretý = `včas` / `o … neskôr` (ak je známy `closedTick`); expirovaná ponuka nemá SLA (`null`).
 */
export function contractSla(contract: ContractCardData, time: ContractsTimeScale): ContractSla | null {
  const { state } = contract;
  if (state === 'expired') return null;
  if (state === 'offered') {
    if (contract.slaWindowTicks === undefined) return { text: EM_DASH, tone: 'muted', title: 'SLA nie je známe' };
    return {
      text: formatDuration(contract.slaWindowTicks, time),
      tone: slaToneForDays(contract.slaWindowTicks / time.ticksPerDay),
      title: 'SLA: čas na export po príchode lode',
    };
  }
  const deadline = contract.slaDeadlineTick;
  if (deadline === undefined) return { text: EM_DASH, tone: 'muted', title: 'SLA nie je známe' };
  if (state === 'completed' || state === 'failed') {
    if (contract.closedTick === undefined) return null;
    const late = contract.closedTick - deadline;
    return late <= 0
      ? { text: 'včas', tone: 'ok', title: 'Splnené v rámci SLA' }
      : { text: `o ${formatDuration(late, time)} neskôr`, tone: 'danger', title: 'Splnené po termíne SLA' };
  }
  const remaining = deadline - time.nowTick;
  if (remaining < 0) {
    return { text: `po termíne o ${formatDuration(-remaining, time)}`, tone: 'danger', title: 'SLA termín uplynul' };
  }
  return { text: formatDuration(remaining, time), tone: slaToneForDays(remaining / time.ticksPerDay), title: 'Zostáva do SLA termínu' };
}

export interface ContractStatus {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: ContractTone;
}

const IMPORT_STATUS: Readonly<Record<ContractCardState, ContractStatus>> = {
  offered: { label: 'Ponuka', icon: 'ic_info', tone: 'info' },
  accepted: { label: 'Prijaté', icon: 'ic_check', tone: 'accent' },
  ship_en_route: { label: 'Loď na ceste', icon: 'ic_ship', tone: 'accent' },
  unloading: { label: 'Vykladá sa', icon: 'ic_busy', tone: 'accent' },
  exporting: { label: 'Exportuje sa', icon: 'ic_truck', tone: 'accent' },
  completed: { label: 'Splnené', icon: 'ic_check', tone: 'ok' },
  failed: { label: 'Zlyhané', icon: 'ic_close', tone: 'danger' },
  expired: { label: 'Expirovaná', icon: 'ic_clock', tone: 'muted' },
};

const LOADING_STATUS: ContractStatus = { label: 'Nakladá sa', icon: 'ic_busy', tone: 'accent' };

/**
 * Stavy karty podľa druhu: export booking (aj repositioning) v `exporting` nenakladá súš, ale loď („Nakladá sa"), `unloading`
 * nepozná; prekládka v `exporting` čaká na loď B (nakladá sa, až keď sú jednotky na lodi B — `contractStatus`).
 */
const STATUS_BY_KIND: Readonly<Record<ContractCardKind, Readonly<Record<ContractCardState, ContractStatus>>>> = {
  import: IMPORT_STATUS,
  export: { ...IMPORT_STATUS, exporting: LOADING_STATUS },
  empty_repositioning: { ...IMPORT_STATUS, exporting: LOADING_STATUS },
  tranship: { ...IMPORT_STATUS, exporting: { label: 'Čaká na loď B', icon: 'ic_clock', tone: 'accent' } },
};

/** Stav karty; aktívny kontrakt blízko SLA termínu je `Ohrozené`, po termíne `Po termíne` (prototyp: Prebieha / Ohrozené). */
export function contractStatus(contract: ContractCardData, time: ContractsTimeScale): ContractStatus {
  if (contractTab(contract.state) === 'active' && contract.slaDeadlineTick !== undefined) {
    const remaining = contract.slaDeadlineTick - time.nowTick;
    if (remaining < 0) return { label: 'Po termíne', icon: 'ic_warning', tone: 'danger' };
    if (remaining < AT_RISK_DAYS * time.ticksPerDay) return { label: 'Ohrozené', icon: 'ic_warning', tone: 'warn' };
  }
  const kind = contractKind(contract);
  if (kind === 'tranship' && contract.state === 'exporting' && (contract.booking?.loadedUnits ?? 0) > 0) return LOADING_STATUS;
  return STATUS_BY_KIND[kind][contract.state];
}

// --- Export booking: cut-off, pruhy, počítadlá (ADR-032) ---------------------------------------------------------------

/** Cut-off s menej než toľkými hodinami je „blízko" (žltá pilulka); zhodné s predvolenou `economy.cutoffWarningHours`, určuje len farbu. */
export const CUTOFF_SOON_HOURS = 6;

/** Druhy bookingu bez cut-off a plánu príchodov kamiónov (prázdne berie depo, prekládka ide z lode na loď). */
const NO_CUTOFF_KINDS: ReadonlySet<ContractCardKind> = new Set<ContractCardKind>(['empty_repositioning', 'tranship']);

export interface CutoffInfo {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'muted';
  readonly title: string;
}

/**
 * Cut-off bookingu: ponuka ukáže odstup pred príchodom lode (ak ho app pozná), prijatý booking odpočet (`Cut-off o 5 h`,
 * žltý pod `CUTOFF_SOON_HOURS`), po cut-off `Cut-off uplynul`. Uzavretý kontrakt a kontrakt bez bookingu → `null`.
 */
export function cutoffInfo(contract: ContractCardData, time: ContractsTimeScale): CutoffInfo | null {
  const { booking, state } = contract;
  if (booking === undefined || contractTab(state) === 'history' || NO_CUTOFF_KINDS.has(contractKind(contract))) return null;
  if (state === 'offered' || booking.cutoffTick === undefined) {
    const lead = booking.cutoffLeadTicks;
    return {
      text: lead === undefined ? 'Cut-off pred príchodom lode' : `Cut-off ${formatDuration(lead, time)} pred príchodom lode`,
      tone: 'muted',
      title: 'Po cut-off už kamióny s exportom nestihnú riadne nakladanie',
    };
  }
  const remaining = booking.cutoffTick - time.nowTick;
  if (remaining <= 0) return { text: 'Cut-off uplynul', tone: 'muted', title: 'Jednotky, ktoré prídu po cut-off, sa naložia len ak loď ešte nezačala lashing' };
  return {
    text: `Cut-off o ${formatDuration(remaining, time)}`,
    tone: remaining < CUTOFF_SOON_HOURS * time.ticksPerHour ? 'warn' : 'ok',
    title: 'Čas do uzávierky príjmu exportu',
  };
}

export interface BookingBar {
  readonly field: 'arrived' | 'loaded' | 'unloaded';
  readonly label: string;
  readonly part: number;
  readonly total: number;
}

/** Pruhy bookingu: dovezené (prešli bránou) a naložené na loď voči bookovaným TEU. */
export function bookingBars(booking: ContractBookingData): readonly BookingBar[] {
  return [
    { field: 'arrived', label: 'Dovezené', part: booking.arrivedUnits, total: booking.bookedUnits },
    { field: 'loaded', label: 'Naložené', part: booking.loadedUnits, total: booking.bookedUnits },
  ];
}

export interface BookingCounter {
  readonly key: 'held' | 'last-minute' | 'rolled' | 'returned' | 'waiting' | 'missed' | 'sold';
  readonly label: string;
  readonly count: number;
  readonly tone: 'warn' | 'danger' | 'muted';
  readonly icon: IconName;
  readonly title: string;
}

/** Počítadlá bookingu, ktoré hráča zaujímajú len keď sú nenulové: zadržané (VGM), last minute, rolled, vrátené. */
export function bookingCounters(booking: ContractBookingData): readonly BookingCounter[] {
  const all: readonly BookingCounter[] = [
    { key: 'held', label: 'Zadržané (VGM)', count: booking.heldUnits, tone: 'warn', icon: 'ic_lock', title: 'Chýba VGM — jednotka sa nenaloží, kým zadržanie neskončí' },
    { key: 'last-minute', label: 'Last minute', count: booking.lastMinuteUnits, tone: 'warn', icon: 'ic_clock', title: 'Naložené po cut-off — penalizácia' },
    { key: 'rolled', label: 'Rolled', count: booking.rolledUnits, tone: 'danger', icon: 'ic_warning', title: 'Prišli po cut-off' },
    { key: 'returned', label: 'Vrátené', count: booking.returnedUnits, tone: 'muted', icon: 'ic_truck', title: 'Vrátené odosielateľovi po súši — penalizácia' },
  ];
  return all.filter((counter) => counter.count > 0);
}

/** Kontrakt, ktorý ešte čaká na plánované príchody kamiónov s exportom (len prijatý, pred cut-off). */
export function pendingArrivalsText(contract: ContractCardData): string | null {
  const { booking } = contract;
  if (booking === undefined || booking.pendingArrivals <= 0 || contractTab(contract.state) !== 'active') return null;
  return `Ešte príde ${formatCount(booking.pendingArrivals, contract.unit)}`;
}

/** Názov časti / karty export bookingu: `Export → Rotterdam`. */
export function exportTitle(contract: ContractCardData): string {
  return contract.booking === undefined ? 'Export' : `Export → ${contract.booking.destinationPort}`;
}

/** Názov časti karty voyage podľa druhu: `Import`, `Export → Rotterdam`, `Prázdne → Rotterdam`, `Tranship → Hamburg`. */
export function partTitle(contract: ContractCardData): string {
  const kind = contractKind(contract);
  const name = KIND_PART_NAME[kind];
  return kind === 'import' || contract.booking === undefined ? name : `${name} → ${contract.booking.destinationPort}`;
}

// --- F6c: repositioning prázdnych a prekládka (ADR-034) -----------------------------------------------------------------------

/** Pruhy repositioningu: len naložené prázdne na loď voči počtu v bookingu. */
export function repositioningBars(booking: ContractBookingData): readonly BookingBar[] {
  return [{ field: 'loaded', label: 'Naložené', part: booking.loadedUnits, total: booking.bookedUnits }];
}

/** Pruhy prekládky: vyložené z lode A a naložené na loď B voči počtu jednotiek. */
export function transhipBars(booking: ContractBookingData): readonly BookingBar[] {
  return [
    { field: 'unloaded', label: 'Vyložené', part: booking.arrivedUnits, total: booking.bookedUnits },
    { field: 'loaded', label: 'Naložené', part: booking.loadedUnits, total: booking.bookedUnits },
  ];
}

export interface EmptiesStock {
  readonly text: string;
  /** `ok` = v prístave je dosť dostupných prázdnych na zvyšok bookingu, `warn` = chýbajú. */
  readonly tone: 'ok' | 'warn';
  readonly title: string;
}

/**
 * Dostupné prázdne kontajnery linky v prístave voči zvyšku bookingu repositioningu (`Dostupné 12 / 24 TEU`); bez údaju od
 * app, v histórii a po naložení celého bookingu `null`. Dostupné = stav `available` (bez poškodených a opravovaných).
 */
export function availableEmptiesInfo(contract: ContractCardData): EmptiesStock | null {
  const { availableEmpties, booking } = contract;
  if (availableEmpties === undefined || booking === undefined || contractTab(contract.state) === 'history') return null;
  const needed = Math.max(0, booking.bookedUnits - booking.loadedUnits);
  if (needed === 0) return null;
  return {
    text: `Dostupné ${formatFraction(availableEmpties, needed, contract.unit)}`,
    tone: availableEmpties >= needed ? 'ok' : 'warn',
    title: 'Prázdne kontajnery linky v prístave, ktoré sa dajú naložiť (bez poškodených a opravovaných), voči zvyšku bookingu',
  };
}

/** Jednotky prekládky, ktoré čakajú v prístave na loď B: vyložené − naložené − predané (nikdy záporné). */
export function transhipWaitingUnits(booking: ContractBookingData): number {
  return Math.max(0, booking.arrivedUnits - booking.loadedUnits - booking.returnedUnits);
}

export interface TranshipMissedInfo {
  /** Zmeškané jednotky (čakajú v prístave po odchode lode B). */
  readonly units: number;
  /** `Na záchranu zostáva 2 d 3 h` / `Lehota záchrany uplynula`. */
  readonly text: string;
}

/** Zmeškaná prekládka (loď B odplávala bez jednotiek, `rescueDeadlineTick` je známy) v aktívnom kontrakte, inak `null`. */
export function transhipMissed(contract: ContractCardData, time: ContractsTimeScale): TranshipMissedInfo | null {
  const deadline = contract.tranship?.rescueDeadlineTick;
  if (deadline === undefined || contract.booking === undefined || contractTab(contract.state) !== 'active') return null;
  const remaining = deadline - time.nowTick;
  return {
    units: transhipWaitingUnits(contract.booking),
    text: remaining > 0 ? `Na záchranu zostáva ${formatDuration(remaining, time)}` : 'Lehota záchrany uplynula',
  };
}

/**
 * Počítadlá prekládky, len nenulové: čakajúce na loď B (po zmeškaní namiesto toho zmeškané) a predané (zmeškané jednotky, ktoré
 * odišli kamiónom — penalizácia).
 */
export function transhipCounters(contract: ContractCardData, time: ContractsTimeScale): readonly BookingCounter[] {
  const { booking } = contract;
  if (booking === undefined || contractTab(contract.state) === 'offers') return [];
  const missed = transhipMissed(contract, time);
  const all: readonly BookingCounter[] = [
    { key: 'waiting', label: 'Čakajú na loď B', count: missed === null ? transhipWaitingUnits(booking) : 0, tone: 'muted', icon: 'ic_clock', title: 'Vyložené jednotky v prístave, ktoré čakajú na naloženie na loď B' },
    { key: 'missed', label: 'Zmeškané', count: missed?.units ?? 0, tone: 'danger', icon: 'ic_warning', title: 'Loď B odplávala bez týchto jednotiek — penalizácia, jednotky čakajú na ďalšiu loď linky' },
    { key: 'sold', label: 'Predané', count: booking.returnedUnits, tone: 'muted', icon: 'ic_truck', title: 'Zmeškané jednotky odišli kamiónom ako predané — penalizácia' },
  ];
  return all.filter((counter) => counter.count > 0);
}

export interface TranshipLegInfo {
  readonly key: 'a' | 'b';
  /** Označenie lode v trase (`A`, `B`). */
  readonly badge: 'A' | 'B';
  /** Plavba lode: `plavba #3` (trieda lode je rovnaká ako triedy lode A — ukazuje ju odznak lode karty). */
  readonly text: string;
  /** Čas príchodu (`príde o 5 h`, `prišla`, `o 1 deň – 2 dni po lodi A`); v histórii prázdny. */
  readonly timing: string;
  readonly tone: 'normal' | 'danger';
}

/** Čas príchodu lode z plánovaného ticku: `príde o 5 h` / `prišla`; bez ticku `null`. */
function arrivalText(arrivalTick: number | undefined, time: ContractsTimeScale): string | null {
  if (arrivalTick === undefined) return null;
  const left = arrivalTick - time.nowTick;
  return left > 0 ? `príde o ${formatDuration(left, time)}` : 'prišla';
}

/**
 * Trasa prekládky: loď A (loď karty) a loď B (plavba `outVoyageId`; jej trieda je rovnaká ako triedy lode A) s odpočtom
 * do príchodu. Ponuka ukáže rozstup príchodu B po lodi A (`outGapTicks`), zmeškaná prekládka „odplávala bez jednotiek“. Kontrakt
 * bez trasy (`tranship` chýba) → `null`.
 */
export function transhipLegs(contract: ContractCardData, time: ContractsTimeScale): readonly TranshipLegInfo[] | null {
  const { tranship } = contract;
  if (tranship === undefined) return null;
  const tab = contractTab(contract.state);
  const gap = tranship.outGapTicks;
  const offerGap = gap === undefined ? 'príde po lodi A' : `o ${formatDuration(gap[0], time)} – ${formatDuration(gap[1], time)} po lodi A`;
  const timingA = tab === 'history' ? '' : tab === 'offers' ? 'príde po prijatí' : (arrivalText(contract.shipArrivalTick, time) ?? '');
  const missed = transhipMissed(contract, time) !== null;
  const timingB = tab === 'history' ? '' : missed ? 'odplávala bez jednotiek' : tab === 'offers' ? offerGap : (arrivalText(tranship.outArrivalTick, time) ?? 'príde po lodi A');
  return [
    { key: 'a', badge: 'A', text: `plavba #${String(contractVoyageId(contract))}`, timing: timingA, tone: 'normal' },
    { key: 'b', badge: 'B', text: `plavba #${String(tranship.outVoyageId)}`, timing: timingB, tone: missed ? 'danger' : 'normal' },
  ];
}

/** Percento pre šírku pruhu: 0–100, celé číslo, objem 0 → 0. */
export function progressPercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)));
}

/** Text expirácie ponuky (`Expiruje o 1 d 4 h`). */
export function offerExpiryText(contract: ContractCardData, time: ContractsTimeScale): string {
  return `Expiruje o ${formatDuration(contract.offerExpiresTick - time.nowTick, time)}`;
}

/** Ponuka expiruje do 1 dňa → zvýraznená. */
export function offerExpiresSoon(contract: ContractCardData, time: ContractsTimeScale): boolean {
  return contract.offerExpiresTick - time.nowTick < time.ticksPerDay;
}

/** Text lode: trieda a pri lodi na ceste čas do príchodu (`Panamax · o 5 h`). */
export function shipText(contract: ContractCardData, time: ContractsTimeScale): string {
  const name = contract.shipClassLabel ?? contract.shipClassId;
  if (contract.state === 'ship_en_route' && contract.shipArrivalTick !== undefined) {
    return `${name} · o ${formatDuration(contract.shipArrivalTick - time.nowTick, time)}`;
  }
  return name;
}

// --- Komponenty -----------------------------------------------------------------------------------------------------------

/** Názov `data-field` s predponou časti (`export` + `sla` → `export-sla`; bez predpony len `sla`). */
function fieldName(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}-${name}`;
}

function ProgressBar({ field, label, part, total, unit }: { field: string; label: string; part: number; total: number; unit: string }) {
  const percent = progressPercent(part, total);
  return (
    <div className="contract-card__bar" data-field={field}>
      <div className="contract-card__bar-head">
        <span>{label}</span>
        <span className="contract-card__bar-value" data-field={`${field}-value`}>
          {formatFraction(part, total, unit)}
        </span>
      </div>
      <div
        className="contract-card__bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="contract-card__bar-fill" style={{ width: `${String(percent)}%` }} data-percent={percent} />
      </div>
    </div>
  );
}

interface TimedProps {
  readonly contract: ContractCardData;
  readonly time: ContractsTimeScale;
  /** Predpona `data-field` (v karte voyage `import` / `export`, v samostatnej karte prázdna). */
  readonly prefix?: string;
  /** Linka kontraktu: sekcia ju ukáže ako prvý odznak svojho riadku (karta voyage ju má v hlavičke, preto jej ju časť nedáva). */
  readonly line?: ContractLineData;
}

function SlaPill({ contract, time, prefix = '' }: TimedProps) {
  const sla = contractSla(contract, time);
  if (sla === null) return null;
  return (
    <span className={`contract-card__pill contract-card__pill--${sla.tone}`} title={sla.title} data-field={fieldName(prefix, 'sla')} data-tone={sla.tone}>
      <Icon name="ic_clock" className="contract-card__pill-icon" />
      {sla.text}
    </span>
  );
}

function ShipPill({ contract, time }: TimedProps) {
  return (
    <span className="contract-card__pill contract-card__pill--plain" data-field="ship" data-ship-class={contract.shipClassId}>
      <Icon name="ic_ship" className="contract-card__pill-icon" />
      {shipText(contract, time)}
    </span>
  );
}

/** Odznak linky: farebná bodka (farba z tokenu linky) a názov; farba nikdy nie je jediný nositeľ (vždy aj text). */
function LinePill({ line, prefix = '' }: { readonly line: ContractLineData | undefined; readonly prefix?: string }) {
  if (line === undefined) return null;
  return (
    <span
      className="contract-card__pill contract-card__pill--plain contract-card__line"
      style={lineStyle(line.colorToken)}
      title={`Linka: ${line.label}`}
      data-field={fieldName(prefix, 'line')}
      data-line={line.id}
    >
      <span className="contract-card__line-dot" aria-hidden="true" />
      {line.label}
    </span>
  );
}

/** Plavba (voyage) lode kontraktu: `Plavba #7`. */
function VoyagePill({ contract, prefix = '' }: { readonly contract: ContractCardData; readonly prefix?: string }) {
  return (
    <span className="contract-card__pill contract-card__pill--plain" title="Plavba lode, na ktorú sa prázdne nakladajú" data-field={fieldName(prefix, 'voyage')}>
      <Icon name="ic_ship" className="contract-card__pill-icon" />
      {`Plavba #${String(contractVoyageId(contract))}`}
    </span>
  );
}

function DestinationPill({ booking, prefix = '' }: { readonly booking: ContractBookingData; readonly prefix?: string }) {
  return (
    <span className="contract-card__pill contract-card__pill--plain" title="Cieľový prístav" data-field={fieldName(prefix, 'destination')}>
      <Icon name="ic_berth" className="contract-card__pill-icon" />
      {booking.destinationPort}
    </span>
  );
}

function StatusLabel({ contract, time, prefix = '' }: TimedProps) {
  const status = contractStatus(contract, time);
  return (
    <span className={`contract-card__status contract-card__status--${status.tone}`} data-field={fieldName(prefix, 'status')} data-tone={status.tone}>
      <Icon name={status.icon} className="contract-card__status-icon" />
      {status.label}
    </span>
  );
}

/** Pruhy importu: vyložené a exportované (po súši) voči objemu. */
function ImportBars({ contract, prefix = '' }: { readonly contract: ContractCardData; readonly prefix?: string }) {
  return (
    <div className="contract-card__bars">
      <ProgressBar field={fieldName(prefix, 'unloaded')} label="Vyložené" part={contract.unitsUnloaded} total={contract.volumeUnits} unit={contract.unit} />
      <ProgressBar field={fieldName(prefix, 'exported')} label="Exportované" part={contract.unitsExported} total={contract.volumeUnits} unit={contract.unit} />
    </div>
  );
}

/** Pruhy progresu bookingu (druh určuje, ktoré: `bookingBars` / `repositioningBars` / `transhipBars`). */
function BarList({ bars, unit, prefix }: { readonly bars: readonly BookingBar[]; readonly unit: string; readonly prefix: string }) {
  return (
    <div className="contract-card__bars">
      {bars.map((bar) => (
        <ProgressBar key={bar.field} field={fieldName(prefix, bar.field)} label={bar.label} part={bar.part} total={bar.total} unit={unit} />
      ))}
    </div>
  );
}

/** Počítadlá jednotiek bookingu (len nenulové; farba tónu + ikona + text). */
function CounterList({ counters, prefix, label }: { readonly counters: readonly BookingCounter[]; readonly prefix: string; readonly label: string }) {
  if (counters.length === 0) return null;
  return (
    <ul className="contract-card__counters" aria-label={label}>
      {counters.map((counter) => (
        <li
          key={counter.key}
          className={`contract-card__counter contract-card__counter--${counter.tone}`}
          title={counter.title}
          data-counter={counter.key}
          data-field={fieldName(prefix, `counter-${counter.key}`)}
        >
          <Icon name={counter.icon} className="contract-card__counter-icon" />
          {counter.label}
          <span className="contract-card__counter-value">{formatCount(counter.count)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Súhrn naložených v histórii (`Naložené 22 / 24 TEU`). */
function LoadedSummary({ contract, booking, prefix }: { readonly contract: ContractCardData; readonly booking: ContractBookingData; readonly prefix: string }) {
  return (
    <span className="contract-card__summary" data-field={fieldName(prefix, 'loaded-summary')}>
      {`Naložené ${formatFraction(booking.loadedUnits, booking.bookedUnits, contract.unit)}`}
    </span>
  );
}

/** Sekcia importu: odznak linky a pruhy vyložené / exportované pri aktívnom kontrakte. */
function ImportSection({ contract, line, prefix = '' }: TimedProps) {
  const bars = contractTab(contract.state) === 'active' ? <ImportBars contract={contract} prefix={prefix} /> : null;
  if (line === undefined) return bars;
  return (
    <>
      <div className="contract-card__chips">
        <LinePill line={line} prefix={prefix} />
      </div>
      {bars}
    </>
  );
}

/**
 * Booking exportu: cut-off (odpočet) a plánované príchody, pri aktívnom kontrakte pruhy dovezené / naložené, v histórii
 * súhrn naložených; počítadlá zadržané (VGM) / last minute / rolled / vrátené, len keď sú nenulové.
 */
function BookingSection({ contract, time, line, prefix = '' }: TimedProps) {
  const { booking } = contract;
  if (booking === undefined) return null;
  const tab = contractTab(contract.state);
  const cutoff = cutoffInfo(contract, time);
  const pending = pendingArrivalsText(contract);
  return (
    <div className="contract-card__booking" data-section={fieldName(prefix, 'booking')}>
      <div className="contract-card__booking-head">
        <LinePill line={line} prefix={prefix} />
        <DestinationPill booking={booking} prefix={prefix} />
        {cutoff !== null && (
          <span className={`contract-card__pill contract-card__pill--${cutoff.tone}`} title={cutoff.title} data-field={fieldName(prefix, 'cutoff')} data-tone={cutoff.tone}>
            <Icon name="ic_clock" className="contract-card__pill-icon" />
            {cutoff.text}
          </span>
        )}
        {pending !== null && (
          <span className="contract-card__pending" data-field={fieldName(prefix, 'pending')}>
            {pending}
          </span>
        )}
      </div>
      {tab === 'active' && <BarList bars={bookingBars(booking)} unit={contract.unit} prefix={prefix} />}
      {tab === 'history' && <LoadedSummary contract={contract} booking={booking} prefix={prefix} />}
      <CounterList counters={tab === 'offers' ? [] : bookingCounters(booking)} prefix={prefix} label="Stav jednotiek bookingu" />
    </div>
  );
}

/**
 * Repositioning prázdnych: cieľový prístav a plavba lode, dostupné prázdne linky v prístave voči zvyšku bookingu, pri aktívnom
 * kontrakte pruh naložených, v histórii súhrn naložených. Bez cut-off (prázdne vydáva depo, nie kamióny na termín).
 */
function RepositioningSection({ contract, line, prefix = '' }: TimedProps) {
  const { booking } = contract;
  if (booking === undefined) return null;
  const tab = contractTab(contract.state);
  const stock = availableEmptiesInfo(contract);
  return (
    <div className="contract-card__booking" data-section={fieldName(prefix, 'booking')}>
      <div className="contract-card__booking-head">
        <LinePill line={line} prefix={prefix} />
        <DestinationPill booking={booking} prefix={prefix} />
        <VoyagePill contract={contract} prefix={prefix} />
        {stock !== null && (
          <span className={`contract-card__pill contract-card__pill--${stock.tone}`} title={stock.title} data-field={fieldName(prefix, 'stock')} data-tone={stock.tone}>
            <Icon name="ic_container" className="contract-card__pill-icon" />
            {stock.text}
          </span>
        )}
      </div>
      {tab === 'active' && <BarList bars={repositioningBars(booking)} unit={contract.unit} prefix={prefix} />}
      {tab === 'history' && <LoadedSummary contract={contract} booking={booking} prefix={prefix} />}
    </div>
  );
}

/** Trasa prekládky: loď A → loď B (plavba, odpočet do príchodu); zmeškaná loď B červeno, s lehotou záchrany. */
function TranshipRoute({ contract, time, prefix }: { readonly contract: ContractCardData; readonly time: ContractsTimeScale; readonly prefix: string }) {
  const legs = transhipLegs(contract, time);
  if (legs === null) return null;
  return (
    <ol className="contract-card__route" aria-label="Trasa prekládky: loď A privezie, loď B odvezie" data-field={fieldName(prefix, 'route')}>
      {legs.map((leg) => (
        <li key={leg.key} className={`contract-card__leg contract-card__leg--${leg.tone}`} data-leg={leg.key}>
          <span className="contract-card__leg-badge" aria-hidden="true">
            {leg.badge}
          </span>
          <span className="contract-card__leg-text" data-field={fieldName(prefix, `leg-${leg.key}`)}>
            {`Loď ${leg.badge} · ${leg.text}`}
          </span>
          {leg.timing !== '' && (
            <span className="contract-card__leg-time" data-field={fieldName(prefix, `leg-${leg.key}-time`)}>
              {leg.timing}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Prekládka: cieľový prístav lode B, trasa A → B s odpočtom do príchodu B, pri aktívnom kontrakte pruhy vyložené / naložené,
 * v histórii súhrn naložených; počítadlá čakajúce / zmeškané (s lehotou záchrany) / predané, len keď sú nenulové.
 */
function TranshipSection({ contract, time, line, prefix = '' }: TimedProps) {
  const { booking } = contract;
  if (booking === undefined) return null;
  const tab = contractTab(contract.state);
  const missed = transhipMissed(contract, time);
  return (
    <div className="contract-card__booking" data-section={fieldName(prefix, 'booking')}>
      <div className="contract-card__booking-head">
        <LinePill line={line} prefix={prefix} />
        <DestinationPill booking={booking} prefix={prefix} />
        {missed !== null && (
          <span className="contract-card__pill contract-card__pill--danger" title="Loď B odplávala bez jednotiek prekládky" data-field={fieldName(prefix, 'rescue')} data-tone="danger">
            <Icon name="ic_warning" className="contract-card__pill-icon" />
            {missed.text}
          </span>
        )}
      </div>
      <TranshipRoute contract={contract} time={time} prefix={prefix} />
      {tab === 'active' && <BarList bars={transhipBars(booking)} unit={contract.unit} prefix={prefix} />}
      {tab === 'history' && <LoadedSummary contract={contract} booking={booking} prefix={prefix} />}
      <CounterList counters={transhipCounters(contract, time)} prefix={prefix} label="Stav jednotiek prekládky" />
    </div>
  );
}

/** Telo karty podľa druhu kontraktu (tabuľka, nie switch — nový druh = nový riadok). */
const KIND_SECTIONS: Readonly<Record<ContractCardKind, (props: TimedProps) => ReactNode>> = {
  import: ImportSection,
  export: BookingSection,
  empty_repositioning: RepositioningSection,
  tranship: TranshipSection,
};

/** Telo karty (pruhy, booking, trasa…) podľa druhu kontraktu. */
function KindSection({ contract, time, line, prefix = '' }: TimedProps) {
  const Section = KIND_SECTIONS[contractKind(contract)];
  return <Section contract={contract} time={time} line={line} prefix={prefix} />;
}

const EXPORT_PENALTY_TITLE = 'Penalizácie za státie lode, meškanie a export (last minute, rolled, nesplnený booking)';

/** Popis penalizácií podľa druhu karty (tabuľka, nie switch). */
const PENALTY_TITLE: Readonly<Record<VoyageKind, string>> = {
  import: 'Penalizácie za státie lode a meškanie exportu',
  export: EXPORT_PENALTY_TITLE,
  roundtrip: EXPORT_PENALTY_TITLE,
  combined: EXPORT_PENALTY_TITLE,
  empty_repositioning: 'Penalizácie za státie lode, meškanie a nesplnený booking prázdnych',
  tranship: 'Penalizácie za státie lode, meškanie a zmeškanú loď B (prekládka)',
};

/** Penalizácie karty (státie lode, meškanie, pri exporte aj rolled / last minute / nesplnený booking, pri prekládke zmeškaná loď B). */
function PenaltyRow({ cents, kind }: { readonly cents: number; readonly kind: VoyageKind }) {
  if (cents <= 0) return null;
  return (
    <div className="contract-card__penalty" data-field="penalties" title={PENALTY_TITLE[kind]}>
      <Icon name="ic_warning" className="contract-card__penalty-icon" />
      <span className="contract-card__penalty-label">Penalizácie</span>
      <span className="contract-card__penalty-value" data-field="penalties-value">
        {formatMoneyDelta(-cents)}
      </span>
    </div>
  );
}

interface OfferBlockProps {
  /** Ponuka (jeden kontrakt, alebo všetky kontrakty voyage — prijatie / odmietnutie platí pre celú skupinu). */
  readonly parts: readonly ContractCardData[];
  readonly time: ContractsTimeScale;
  readonly onAccept: (id: ContractCardId) => void;
  readonly onDecline: (id: ContractCardId) => void;
}

/**
 * Expirácia ponuky a tlačidlá „Prijať" / „Odmietnuť"; zablokované „Prijať" nesie prvý dôvod zo skupiny. Volá sa ako
 * funkcia (nie ako element), aby tlačidlá ostali priamo v strome karty (testy ho prehľadávajú bez vykreslenia).
 */
function renderOfferBlock({ parts, time, onAccept, onDecline }: OfferBlockProps) {
  const [lead] = parts;
  if (lead === undefined) return null;
  const { id } = lead;
  const reason = parts.find((part) => part.disabledReason !== undefined)?.disabledReason;
  const blocked = reason !== undefined;
  const soon = offerExpiresSoon(lead, time);
  const both = parts.length > 1;
  return (
    <div className="contract-card__offer">
      <span className={soon ? 'contract-card__expiry contract-card__expiry--soon' : 'contract-card__expiry'} data-field="expiry">
        <Icon name="ic_clock" className="contract-card__expiry-icon" />
        {offerExpiryText(lead, time)}
      </span>
      <div className="contract-card__actions">
        <button
          type="button"
          className="contract-card__btn contract-card__btn--primary"
          aria-disabled={blocked}
          title={reason}
          data-action="accept"
          onClick={() => {
            if (!blocked) onAccept(id);
          }}
        >
          <Icon name="ic_check" className="contract-card__btn-icon" />
          {both ? 'Prijať oba' : 'Prijať'}
        </button>
        <button
          type="button"
          className="contract-card__btn"
          data-action="decline"
          onClick={() => {
            onDecline(id);
          }}
        >
          {both ? 'Odmietnuť oba' : 'Odmietnuť'}
        </button>
      </div>
      {blocked && (
        <p className="contract-card__reason">
          <Icon name="ic_lock" className="contract-card__reason-icon" />
          <span data-field="accept-reason">{reason}</span>
        </p>
      )}
    </div>
  );
}

function CategoryTile({ category }: { readonly category: ContractCargoCategory }) {
  return (
    <div className="contract-card__tile">
      <Icon name={toIconName(category)} className="contract-card__tile-icon" />
    </div>
  );
}

/** Tón sumy vpravo hore: kladná / záporná / nulová, expirovaná ponuka stlmená. */
function rewardTone(cents: number, expired: boolean): 'pos' | 'neg' | 'zero' | 'muted' {
  if (expired) return 'muted';
  const sign = moneySign(cents);
  return sign < 0 ? 'neg' : sign > 0 ? 'pos' : 'zero';
}

/** Typ kontajnera v zmesi kontraktu (TR5, TERMINAL_2 §3): suchý, reefer, open top, flat rack, tank. */
export type ContainerTypeKey = 'dry' | 'reefer' | 'open_top' | 'flat_rack' | 'tank';

/** Jeden čip zmesi typov: počet kontajnerov daného typu; `oogCount` = z nich nadrozmerných (OOG). */
export interface ContractTypeChip {
  readonly type: ContainerTypeKey;
  readonly count: number;
  readonly oogCount?: number;
}

export const CONTAINER_TYPE_LABELS: Readonly<Record<ContainerTypeKey, string>> = {
  dry: 'dry',
  reefer: 'reefer',
  open_top: 'open top',
  flat_rack: 'flat rack',
  tank: 'tank',
};

export const CONTAINER_TYPE_ICONS: Readonly<Record<ContainerTypeKey, IconName>> = {
  dry: 'ic_container_40',
  reefer: 'ic_reefer',
  open_top: 'ic_open_top',
  flat_rack: 'ic_flat_rack',
  tank: 'ic_tank',
};

export interface ContractCardProps {
  readonly contract: ContractCardData;
  readonly time: ContractsTimeScale;
  readonly onAccept: (id: ContractCardId) => void;
  readonly onDecline: (id: ContractCardId) => void;
  /** TR5-04: zmes typov kontajnerov (čipy + odznak OOG); bez nej sa rad nekreslí. */
  readonly typeMix?: readonly ContractTypeChip[];
}

/** Riadok čipov zmesi typov; čip s nulou je stlmený, OOG odznak sa kreslí len pri `oogCount > 0`. */
function TypeMixChips({ chips }: { readonly chips: readonly ContractTypeChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="contract-card__types" data-section="type-mix" aria-label="Zmes typov kontajnerov">
      {chips.map((chip) => {
        const oog = chip.oogCount ?? 0;
        return (
          <span
            key={chip.type}
            className={`contract-card__type contract-card__type--${chip.type}${chip.count === 0 ? ' contract-card__type--empty' : ''}`}
            data-type={chip.type}
            data-count={chip.count}
          >
            <Icon name={CONTAINER_TYPE_ICONS[chip.type]} className="contract-card__type-icon" />
            <span className="contract-card__type-count" data-field={`type-count-${chip.type}`}>
              {formatCount(chip.count)}
            </span>
            <span className="contract-card__type-label">{CONTAINER_TYPE_LABELS[chip.type]}</span>
            {oog > 0 && (
              <span className="contract-card__oog" data-field={`oog-${chip.type}`}>
                {`OOG ${formatCount(oog)}`}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Predpona názvu karty podľa druhu: `Export · Kontajnery`; import je bez predpony (názov nákladu). */
function cardTitle(contract: ContractCardData): string {
  const kind = contractKind(contract);
  return kind === 'import' ? contract.cargoLabel : `${KIND_PART_NAME[kind]} · ${contract.cargoLabel}`;
}

/** Názov druhu pre čítačku obrazovky (`aria-label` karty). */
const KIND_ARIA_NAME: Readonly<Record<ContractCardKind, string>> = {
  import: 'Kontrakt',
  export: 'Export',
  empty_repositioning: 'Prázdne kontajnery',
  tranship: 'Prekládka',
};

/** Jedna karta kontraktu (import, export booking, repositioning alebo prekládka; roundtrip skladá `VoyageCard`). */
export function ContractCard({ contract, time, onAccept, onDecline, typeMix }: ContractCardProps) {
  const { id, state } = contract;
  const kind = contractKind(contract);
  const tab = contractTab(state);
  const payout = contractPayoutCents(contract);
  return (
    <article
      className={`contract-card contract-card--${contract.cargoCategory}`}
      data-contract-id={id}
      data-kind={kind}
      data-state={state}
      data-tab={tab}
      aria-label={`${KIND_ARIA_NAME[kind]}: ${contract.cargoLabel}, ${volumeText(contract)}`}
    >
      <div className="contract-card__head">
        <CategoryTile category={contract.cargoCategory} />
        <div className="contract-card__titles">
          <span className="contract-card__title" data-field="cargo">
            {cardTitle(contract)}
          </span>
          <span className="contract-card__meta">
            <span data-field="volume">{volumeText(contract)}</span>
            {' · '}
            <span className="contract-card__xp" data-field="xp-reward">
              {formatXp(contract.xpReward)}
            </span>
          </span>
        </div>
        <span className={`contract-card__reward contract-card__reward--${rewardTone(payout, state === 'expired')}`} data-field="reward">
          {state === 'expired' ? formatMoney(payout) : formatMoneyDelta(payout)}
        </span>
      </div>
      <div className="contract-card__chips">
        <SlaPill contract={contract} time={time} />
        <ShipPill contract={contract} time={time} />
        <span className="contract-card__spacer" />
        <StatusLabel contract={contract} time={time} />
      </div>
      {typeMix !== undefined && <TypeMixChips chips={typeMix} />}
      <KindSection contract={contract} time={time} line={contract.line} />
      <PenaltyRow cents={contract.penaltiesCents} kind={kind} />
      {state === 'offered' && renderOfferBlock({ parts: [contract], time, onAccept, onDecline })}
    </article>
  );
}

interface VoyagePartProps {
  readonly contract: ContractCardData;
  readonly time: ContractsTimeScale;
}

/** Časť karty voyage (Import / Export / Prázdne / Tranship): hlavička s odmenou, SLA, stav, cieľ a pruhy alebo booking. */
function VoyagePart({ contract, time }: VoyagePartProps) {
  const kind = contractKind(contract);
  const payout = contractPayoutCents(contract);
  const tab = contractTab(contract.state);
  return (
    <section className="contract-card__part" data-part={kind} data-contract-id={contract.id} data-state={contract.state} data-tab={tab}>
      <div className="contract-card__part-head">
        <span className="contract-card__part-title" data-field={`${kind}-title`}>
          {partTitle(contract)}
        </span>
        <span className="contract-card__part-volume" data-field={`${kind}-volume`}>
          {volumeText(contract)}
        </span>
        <span className="contract-card__spacer" />
        <span className={`contract-card__reward contract-card__reward--${rewardTone(payout, contract.state === 'expired')}`} data-field={`${kind}-reward`}>
          {contract.state === 'expired' ? formatMoney(payout) : formatMoneyDelta(payout)}
        </span>
      </div>
      <div className="contract-card__chips">
        <SlaPill contract={contract} time={time} prefix={kind} />
        <span className="contract-card__spacer" />
        <StatusLabel contract={contract} time={time} prefix={kind} />
      </div>
      <KindSection contract={contract} time={time} prefix={kind} />
    </section>
  );
}

export interface VoyageCardProps {
  /** Kontrakty jednej voyage (aspoň dva — import a export booking), vzostupne podľa id. */
  readonly group: VoyageGroup;
  readonly time: ContractsTimeScale;
  readonly onAccept: (id: ContractCardId) => void;
  readonly onDecline: (id: ContractCardId) => void;
}

/**
 * Spoločná karta voyage (roundtrip): jedna loď privezie import a odvezie export. Hlavička s kategóriou, objemami a súčtom
 * odmien, loď, časť Import a časť Export, súčet penalizácií a jedno „Prijať oba" / „Odmietnuť oba".
 */
export function VoyageCard({ group, time, onAccept, onDecline }: VoyageCardProps) {
  const { parts, voyageId } = group;
  const [lead] = parts;
  if (lead === undefined) return null;
  const kind = voyageKind(group);
  const payout = voyagePayoutCents(group);
  const expired = parts.every((part) => part.state === 'expired');
  const xp = parts.reduce((sum, part) => sum + part.xpReward, 0);
  const volumes = parts.map((part) => `${KIND_PART_NAME[contractKind(part)]} ${volumeText(part)}`).join(' · ');
  // Súčet objemu cez obe časti (rovnaká jednotka); pri rôznych jednotkách zoznam objemov podľa častí.
  const sameUnit = parts.every((part) => part.unit === lead.unit);
  const volume = sameUnit ? formatCount(parts.reduce((sum, part) => sum + volumeOf(part), 0), lead.unit) : volumes;
  const offers = parts.filter((part) => part.state === 'offered');
  return (
    <article
      className={`contract-card contract-card--${lead.cargoCategory} contract-card--voyage`}
      data-voyage-id={voyageId}
      data-kind={kind}
      data-tab={voyageTab(group)}
      aria-label={`Kontrakt: ${lead.cargoLabel}, ${volumes}`}
    >
      <div className="contract-card__head">
        <CategoryTile category={lead.cargoCategory} />
        <div className="contract-card__titles">
          <span className="contract-card__title" data-field="cargo">
            {`${voyageTitle(group)} · ${lead.cargoLabel}`}
          </span>
          <span className="contract-card__meta">
            <span data-field="volume">{volume}</span>
            {' · '}
            <span className="contract-card__xp" data-field="xp-reward">
              {formatXp(xp)}
            </span>
          </span>
        </div>
        <span className={`contract-card__reward contract-card__reward--${rewardTone(payout, expired)}`} data-field="reward">
          {expired ? formatMoney(payout) : formatMoneyDelta(payout)}
        </span>
      </div>
      <div className="contract-card__chips">
        <LinePill line={lead.line} />
        <ShipPill contract={lead} time={time} />
      </div>
      {parts.map((part) => (
        <VoyagePart key={part.id} contract={part} time={time} />
      ))}
      <PenaltyRow cents={parts.reduce((sum, part) => sum + part.penaltiesCents, 0)} kind={kind} />
      {offers.length > 0 && renderOfferBlock({ parts: offers, time, onAccept, onDecline })}
    </article>
  );
}

/** Karta skupiny voyage: jeden kontrakt = `ContractCard`, viac (roundtrip) = `VoyageCard`. */
function GroupCard({ group, time, onAccept, onDecline }: VoyageCardProps) {
  const [only] = group.parts;
  if (group.parts.length === 1 && only !== undefined) return <ContractCard contract={only} time={time} onAccept={onAccept} onDecline={onDecline} />;
  return <VoyageCard group={group} time={time} onAccept={onAccept} onDecline={onDecline} />;
}

const EMPTY_TEXTS: Readonly<Record<ContractsTab, { readonly title: string; readonly text: string }>> = {
  offers: { title: 'Žiadne ponuky', text: 'Nové ponuky prichádzajú každý deň.' },
  active: { title: 'Žiadne aktívne kontrakty', text: 'Prijmi ponuku a loď sa vydá do prístavu.' },
  history: { title: 'Zatiaľ žiadna história', text: 'Tu nájdeš splnené, zlyhané a expirované kontrakty.' },
};

/** Text prázdneho stavu; pri Ponukách s `nextOfferInTicks` ukáže, kedy príde ďalšia (prototyp: „Ďalšia ponuka príde o 2 dni."). */
export function emptyState(tab: ContractsTab, time: TimeScale, nextOfferInTicks?: number | null): { title: string; text: string } {
  const base = EMPTY_TEXTS[tab];
  if (tab === 'offers' && nextOfferInTicks !== undefined && nextOfferInTicks !== null) {
    return { title: base.title, text: `Ďalšia ponuka príde o ${formatDuration(nextOfferInTicks, time)}.` };
  }
  return base;
}

function Tabs({ tab, counts, onTabChange }: { tab: ContractsTab; counts: Readonly<Record<ContractsTab, number>>; onTabChange: (tab: ContractsTab) => void }) {
  return (
    <div className="contracts-panel__tabs" role="tablist" aria-label="Kontrakty">
      {TAB_ORDER.map((id) => {
        const selected = id === tab;
        // História je bez počtu (prototyp: „História"); ostatné „Ponuky · 3".
        const label = id === 'history' ? CONTRACT_TAB_LABELS[id] : `${CONTRACT_TAB_LABELS[id]} · ${String(counts[id])}`;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`contracts-tab-${id}`}
            aria-selected={selected}
            aria-controls="contracts-tabpanel"
            className={selected ? 'contracts-panel__tab contracts-panel__tab--active' : 'contracts-panel__tab'}
            data-tab={id}
            data-count={counts[id]}
            onClick={() => {
              onTabChange(id);
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ContractsEmpty({ tab, time, nextOfferInTicks }: { tab: ContractsTab; time: TimeScale; nextOfferInTicks?: number | null }): ReactNode {
  const { title, text } = emptyState(tab, time, nextOfferInTicks);
  return (
    <div className="contracts-panel__empty" data-section="empty" data-tab={tab}>
      <div className="contracts-panel__empty-badge">
        <Icon name="ic_contract" className="contracts-panel__empty-icon" />
      </div>
      <span className="contracts-panel__empty-title" data-field="empty-title">
        {title}
      </span>
      <span className="contracts-panel__empty-text" data-field="empty-text">
        {text}
      </span>
    </div>
  );
}

export function ContractsPanel({ contracts, tab, onTabChange, time, onAccept, onDecline, onClose, nextOfferInTicks }: ContractsPanelProps) {
  const counts = tabCounts(contracts);
  const shown = voyageCardsForTab(contracts, tab);
  return (
    <aside className="contracts-panel" aria-label="Kontrakty" data-tab={tab}>
      <div className="contracts-panel__header">
        <Icon name="ic_contract" className="contracts-panel__header-icon" />
        <span className="contracts-panel__title">Kontrakty</span>
        <button type="button" className="contracts-panel__close" title="Zavrieť (Esc)" aria-label="Zavrieť kontrakty" onClick={onClose}>
          <Icon name="ic_close" className="contracts-panel__close-icon" />
        </button>
      </div>
      <div className="contracts-panel__body">
        <Tabs tab={tab} counts={counts} onTabChange={onTabChange} />
        <div className="contracts-panel__list" role="tabpanel" id="contracts-tabpanel" aria-labelledby={`contracts-tab-${tab}`}>
          {shown.length === 0 ? (
            <ContractsEmpty tab={tab} time={time} nextOfferInTicks={nextOfferInTicks} />
          ) : (
            shown.map((group) => <GroupCard key={String(group.voyageId)} group={group} time={time} onAccept={onAccept} onDecline={onDecline} />)
          )}
        </div>
      </div>
    </aside>
  );
}
