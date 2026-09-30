/**
 * ModuleInspector (DESIGN_BRIEF §6.2 bod 4; rozloženie z prototypu design/ui/game-ui.source.html, pravý SidePanel
 * „Inspector"): hlavička (ikona modulu, názov, mono podtitul, badge stavu, zavrieť), telo (upozornenie, tri
 * číselné dlaždice, pruh kapacity, sekcia lode, riadky s údajmi) a dole akcia „Odstrániť".
 *
 * Druhy obsahu sa vykreslia podľa prítomnosti polí v `ModuleInspectorData`, nie podľa `kind` (ten určuje len
 * ikonu): kotvisko (`apron`, `dockedShip`) a žeriav (`crane`) z F2, sklad (`storage`) a depo vozidiel (`depot`,
 * zoznam vozidiel s predajom a tlačidlo „Kúpiť vozidlo v depe") z F3. `connected === false` pridá banner „Nepripojené
 * k ceste" a žltý badge „Nepripojené" (vzor `insp_gate` z prototypu) — má prednosť pred `stateLabel`. Prototypová akcia
 * „Presunúť" nie je (žiadny príkaz na presun), sparkline 24 h a politika skladu prídu s fázami, ktoré ich dáta prinesú.
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov): dáta zostaví rodič zo snapshotu
 * (`useSimSnapshot(selector, 100)`, T02-09/T02-10, T03-10), odstránenie ide cez `onRemove(id)` → `dispatch(RemoveModule)`,
 * nákup / predaj vozidla cez `onBuyVehicle(depotId)` / `onSellVehicle(vehicleId)` → `dispatch(BuyVehicle | SellVehicle)`.
 * Šírku dáva `--side-panel-w`, výšku kontajner (panel vyplní 100 % výšky rodiča, telo sa posúva).
 */
import { formatCount, formatFootprint, formatFraction, formatMoney, formatPercent } from './format';
import { Icon, type IconName } from './icon';
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
  } | null;
  readonly crane?: {
    readonly state: CraneStateName;
    readonly utilizationPct: number;
    readonly blockedPct: number;
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
  };
  /** F3: depo vozidiel. `canBuy` + `buyBlockedReason` (depo plné, nepripojené, nedostatok peňazí…) určuje rodič. */
  readonly depot?: {
    readonly vehicles: readonly DepotVehicleData[];
    readonly capacity: number;
    readonly canBuy: boolean;
    readonly buyBlockedReason?: string;
    /** Voliteľný: cena vozidla v centoch — ukáže sa v tlačidle nákupu (prototyp: „Kúpiť vozidlo v depe · $48,000"). */
    readonly buyPriceCents?: number;
  };
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

export function craneStateLabel(state: CraneStateName): string {
  return CRANE_STATE_LABELS[state];
}

/** Badge je zelený, kým žeriav nie je zablokovaný (blokovaný = žltý, varovanie). */
export function craneStateOk(state: CraneStateName): boolean {
  return state !== 'blocked';
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

export type StatSwatch = 'used' | 'reserved' | 'free' | 'busy' | 'blocked' | 'idle';

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

/** Text a vzhľad badge v hlavičke; „Nepripojené" (`connected === false`) má prednosť pred stavom modulu. */
export const DISCONNECTED_BADGE_LABEL = 'Nepripojené';
export const DISCONNECTED_TITLE = 'Nepripojené k ceste';

export interface InspectorBadge {
  readonly label: string;
  /** Text pre `title` (celý popis). */
  readonly title: string;
  readonly ok: boolean;
}

export function inspectorBadge(data: Pick<ModuleInspectorData, 'stateLabel' | 'ok' | 'connected'>): InspectorBadge {
  if (data.connected === false) return { label: DISCONNECTED_BADGE_LABEL, title: DISCONNECTED_TITLE, ok: false };
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

function renderShip(ship: NonNullable<ModuleInspectorData['dockedShip']>) {
  return (
    <div className="module-inspector__ship" data-section="ship">
      <div className="module-inspector__ship-head">
        <Icon name="ic_ship" className="module-inspector__ship-icon" />
        <span className="module-inspector__ship-name" data-field="ship-class">
          {ship.classLabel}
        </span>
        <span className="module-inspector__ship-count" data-field="ship-units">
          {formatFraction(ship.unitsOnBoard, ship.capacityUnits, ship.unitLabel ?? 'jedn.')}
        </span>
      </div>
      {renderBar('Náklad na lodi', ship.unitsOnBoard, ship.capacityUnits, [
        { key: 'used', percent: shareOf(ship.unitsOnBoard, ship.capacityUnits) },
      ])}
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

export function ModuleInspector({ data, onRemove, onClose, onBuyVehicle, onSellVehicle }: ModuleInspectorProps) {
  const { apron, crane, dockedShip, storage, depot } = data;
  const blocked = crane?.state === 'blocked';
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
        {data.connected === false && renderDisconnectedBanner()}
        {apron !== undefined && renderStats(berthStats(apron))}
        {crane !== undefined && renderStats(craneStats(crane))}
        {storage !== undefined && renderStats(storageStats(storage))}
        {depot !== undefined && renderStats(depotStats(depot))}
        {apron !== undefined && renderApron(apron)}
        {crane !== undefined && renderCraneTime(crane)}
        {storage !== undefined && renderStorage(storage)}
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
