/**
 * ModuleInspector (DESIGN_BRIEF §6.2 bod 4; rozloženie z prototypu design/ui/game-ui.source.html, pravý SidePanel
 * „Inspector"): hlavička (ikona modulu, názov, mono podtitul, badge stavu, zavrieť), telo (upozornenie, tri
 * číselné dlaždice, pruh kapacity, sekcia lode, riadky s údajmi) a dole akcia „Odstrániť".
 *
 * F2 pozná dva druhy obsahu, ktoré sa vykreslia podľa prítomnosti polí v `ModuleInspectorData`, nie podľa `kind`
 * (ten určuje len ikonu): kotvisko (`apron`, `dockedShip`) a žeriav (`crane`). Prototypová akcia „Presunúť" vo F2
 * nie je (žiadny príkaz na presun), ostatné sekcie prototypu (sparkline 24 h, politika skladu, vozidlá v depe)
 * prídu s fázami, ktoré ich dáta prinesú.
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov): dáta zostaví rodič zo snapshotu
 * (`useSimSnapshot(selector, 100)`, T02-09/T02-10), odstránenie ide cez `onRemove(id)` → `dispatch(RemoveModule)`.
 * Šírku dáva `--side-panel-w`, výšku kontajner (panel vyplní 100 % výšky rodiča, telo sa posúva).
 */
import { formatFootprint, formatFraction, formatMoney, formatPercent } from './format';
import { Icon, type IconName } from './icon';
import './module-inspector.css';

export type CraneStateName = 'idle' | 'grabbing' | 'swinging' | 'placing' | 'blocked';

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
  /** Farebná značka pri popise dlaždice — prepája dlaždicu s farbou v pruhu (farba nikdy nie je jediný nositeľ). */
  readonly swatch: StatSwatch;
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
            <span className={`module-inspector__swatch module-inspector__swatch--${stat.swatch}`} aria-hidden="true" />
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

export function ModuleInspector({ data, onRemove, onClose }: ModuleInspectorProps) {
  const { apron, crane, dockedShip } = data;
  const blocked = crane?.state === 'blocked';
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
          className={data.ok ? 'module-inspector__badge module-inspector__badge--ok' : 'module-inspector__badge module-inspector__badge--warn'}
          title={data.stateLabel}
          data-field="badge"
          data-ok={data.ok}
        >
          <Icon name={data.ok ? 'ic_check' : 'ic_warning'} className="module-inspector__badge-icon" />
          {badgeText(data.stateLabel)}
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
        {apron !== undefined && renderStats(berthStats(apron))}
        {crane !== undefined && renderStats(craneStats(crane))}
        {apron !== undefined && renderApron(apron)}
        {crane !== undefined && renderCraneTime(crane)}
        {dockedShip !== undefined && (
          <div className="module-inspector__section">
            <span className="module-inspector__section-title">Zakotvená loď</span>
            {dockedShip === null ? renderNoShip() : renderShip(dockedShip)}
          </div>
        )}
        <div className="module-inspector__rows">
          <div className="module-inspector__row">
            <span className="module-inspector__row-label">Vrátenie pri odstránení</span>
            <span data-field="refund">{formatMoney(data.refundCents)}</span>
          </div>
        </div>
        <div className="module-inspector__actions">
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
