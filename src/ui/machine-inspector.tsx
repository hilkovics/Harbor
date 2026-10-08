/**
 * Inšpektor strojov a blokov (TR3-04; rozloženie z prototypu design/ui/game-ui-t2.html, sekcie `sc === 'machine'`,
 * `sc === 'block'` a výber gangu STS). Tri čisto prezentačné komponenty, každý s voliteľnými props, aby existujúce
 * použitie v UI kompilovalo:
 *  - `MachineInspector` — stroj (RTG, ťahač, …): druh, stav (badge), blok, aktuálny kontajner (veľkosť / typ), dĺžka
 *    fronty úloh a presuny za hodinu.
 *  - `BlockInspector` — blok RTG: prioritný výber (loď / kamión / housekeeping) volá `onSetPriority(order)`.
 *  - `CraneInspector` — žeriav STS: režim gang / pool a počet ťahačov na STS (`tractorsPerSts`) volá `onSetGang(mode, n)`.
 *
 * Dáta zostaví rodič zo snapshotu (`useSimSnapshot(selector, 100)`; napojenie prinesie TR3-05), komponenty nemajú hooky
 * ani prístup k simulácii. Farby len cez tokeny (`design/tokens.css`), čísla s `tabular-nums`, peniaze tu nie sú.
 */
import { formatCount } from './format';
import { Icon, type IconName } from './icon';
import './machine-inspector.css';

/** Stav stroja pre badge a text (`idle` = nečinný, `working` = pracuje, `waiting` = čaká, `blocked` = blokovaný). */
export type MachineStateName = 'idle' | 'working' | 'waiting' | 'blocked';

/** Kontajner, ktorý stroj práve drží (veľkosť v stopách a typ, napr. `dry`, `reefer`). */
export interface MachineCargoData {
  readonly sizeFt: 20 | 40;
  readonly containerType: string;
}

/** Dáta inšpektora jedného stroja; `blockId` je `null`, ak stroj nepatrí žiadnemu bloku. */
export interface MachineInspectorData {
  readonly id: number;
  readonly defId: string;
  /** Voliteľný názov pre hráča (`Terminálový ťahač`); bez neho sa zobrazí `defId`. */
  readonly displayName?: string;
  readonly blockId: number | null;
  readonly state: MachineStateName;
  readonly cargo: MachineCargoData | null;
  /** Počet úloh čakajúcich vo fronte stroja. */
  readonly queueLength: number;
  /** Presuny za herný čas jednej hodiny (rodič ich počíta z tickov). */
  readonly movesPerHour: number;
}

export interface MachineInspectorProps {
  readonly data?: MachineInspectorData;
}

/** Slovenské názvy stavov stroja. */
export const MACHINE_STATE_LABELS: Readonly<Record<MachineStateName, string>> = {
  idle: 'Nečinný',
  working: 'Pracuje',
  waiting: 'Čaká',
  blocked: 'Blokovaný',
};

/** Badge tón podľa stavu: pracuje = ok, čaká = warn, blokovaný = bad, nečinný = mute. */
export const MACHINE_STATE_TONES: Readonly<Record<MachineStateName, 'ok' | 'warn' | 'bad' | 'mute'>> = {
  idle: 'mute',
  working: 'ok',
  waiting: 'warn',
  blocked: 'bad',
};

/** Ikona podľa definície stroja; neznáme defId dostane všeobecný žeriav. */
export function machineIcon(defId: string): IconName {
  if (defId.includes('rtg')) return 'ic_rtg';
  if (defId.includes('tractor')) return 'ic_tractor';
  if (defId.includes('straddle')) return 'ic_straddle';
  if (defId.includes('reach')) return 'ic_reach_stacker';
  if (defId.includes('ech')) return 'ic_ech';
  return 'ic_crane';
}

/** Text kontajnera v riadku „Náklad": `40′ dry`, bez kontajnera `Prázdny`. */
export function machineCargoText(cargo: MachineCargoData | null): string {
  return cargo === null ? 'Prázdny' : `${String(cargo.sizeFt)}′ ${cargo.containerType}`;
}

/** Hlavička inšpektora: názov (alebo defId), podtitul `#id · blok N`. */
export function machineSubtitle(data: MachineInspectorData): string {
  const block = data.blockId === null ? 'bez bloku' : `blok #${String(data.blockId)}`;
  return `#${String(data.id)} · ${block}`;
}

export function MachineInspector({ data }: MachineInspectorProps) {
  if (data === undefined) {
    return (
      <aside className="machine-inspector" aria-label="Inšpektor stroja" data-section="machine-empty">
        <span className="machine-inspector__empty">Stroj nie je vybraný.</span>
      </aside>
    );
  }
  const tone = MACHINE_STATE_TONES[data.state];
  return (
    <aside
      className="machine-inspector"
      aria-label="Inšpektor stroja"
      data-machine-id={data.id}
      data-def-id={data.defId}
      data-state={data.state}
    >
      <div className="machine-inspector__header">
        <Icon name={machineIcon(data.defId)} className="machine-inspector__icon" />
        <div className="machine-inspector__titles">
          <span className="machine-inspector__title" data-field="title">
            {data.displayName ?? data.defId}
          </span>
          <span className="machine-inspector__sub" data-field="sub" title={data.defId}>
            {machineSubtitle(data)}
          </span>
        </div>
        <span className={`machine-inspector__badge machine-inspector__badge--${tone}`} data-field="badge">
          {MACHINE_STATE_LABELS[data.state]}
        </span>
      </div>
      <div className="machine-inspector__body">
        <dl className="machine-inspector__rows">
          <div className="machine-inspector__row" data-row="cargo">
            <dt className="machine-inspector__label">Náklad</dt>
            <dd className="machine-inspector__value" data-field="cargo">
              {machineCargoText(data.cargo)}
            </dd>
          </div>
          <div className="machine-inspector__row" data-row="queue">
            <dt className="machine-inspector__label">Fronta úloh</dt>
            <dd className="machine-inspector__value" data-field="queue">
              {formatCount(data.queueLength)}
            </dd>
          </div>
          <div className="machine-inspector__row" data-row="moves">
            <dt className="machine-inspector__label">Presuny / h</dt>
            <dd className="machine-inspector__value" data-field="moves">
              {formatCount(data.movesPerHour)}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

/** Priorita RTG bloku: loď (výkladka lode), kamión (odvoz), housekeeping (preskladanie v nečinnosti). */
export type RtgPriority = 'ship' | 'truck' | 'housekeeping';

export const RTG_PRIORITY_ORDERS: readonly RtgPriority[] = ['ship', 'truck', 'housekeeping'];

export const RTG_PRIORITY_LABELS: Readonly<Record<RtgPriority, string>> = {
  ship: 'Loď',
  truck: 'Kamión',
  housekeeping: 'Housekeeping',
};

/** Predvolená priorita, kým rodič nedodá skutočnú (prototyp: `rtgPrio: 0` = Loď). */
export const RTG_DEFAULT_PRIORITY: RtgPriority = 'ship';

export interface BlockInspectorProps {
  readonly priority?: RtgPriority;
  readonly onSetPriority?: (order: RtgPriority) => void;
}

export function BlockInspector({ priority, onSetPriority }: BlockInspectorProps) {
  const current = priority ?? RTG_DEFAULT_PRIORITY;
  return (
    <section className="machine-inspector__section" data-section="rtg-priority">
      <span className="machine-inspector__section-title">
        Priorita RTG
      </span>
      <div className="machine-inspector__segments" role="radiogroup" aria-label="Priorita RTG">
        {RTG_PRIORITY_ORDERS.map((order) => {
          const selected = order === current;
          return (
            <button
              key={order}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? 'machine-inspector__segment machine-inspector__segment--on' : 'machine-inspector__segment'}
              data-priority={order}
              onClick={() => onSetPriority?.(order)}
            >
              {RTG_PRIORITY_LABELS[order]}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Režim žeriava STS: `gang` = ťahače pridelené tomuto STS, `pool` = spoločný bazén ťahačov. */
export type GangMode = 'gang' | 'pool';

export const GANG_MODE_LABELS: Readonly<Record<GangMode, string>> = {
  gang: 'Gang STS',
  pool: 'Pool',
};

export const TRACTORS_PER_STS_MIN = 1;
export const TRACTORS_PER_STS_MAX = 8;
export const TRACTORS_PER_STS_DEFAULT = 2;

/** Zaokrúhli na celé číslo a ohraničí do `[MIN, MAX]`; neplatné (`NaN`) → minimum. */
export function clampTractorsPerSts(value: number): number {
  if (!Number.isFinite(value)) return TRACTORS_PER_STS_MIN;
  return Math.min(TRACTORS_PER_STS_MAX, Math.max(TRACTORS_PER_STS_MIN, Math.round(value)));
}

export interface CraneInspectorProps {
  readonly gang?: GangMode;
  readonly tractorsPerSts?: number;
  readonly onSetGang?: (mode: GangMode, n: number) => void;
}

export function CraneInspector({ gang, tractorsPerSts, onSetGang }: CraneInspectorProps) {
  const mode: GangMode = gang ?? 'gang';
  const count = clampTractorsPerSts(tractorsPerSts ?? TRACTORS_PER_STS_DEFAULT);
  return (
    <section className="machine-inspector__section" data-section="crane-gang">
      <span className="machine-inspector__section-title">
        Režim ťahačov
      </span>
      <div className="machine-inspector__segments" role="radiogroup" aria-label="Režim ťahačov">
        {(['gang', 'pool'] as const).map((option) => {
          const selected = option === mode;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? 'machine-inspector__segment machine-inspector__segment--on' : 'machine-inspector__segment'}
              data-gang={option}
              onClick={() => onSetGang?.(option, count)}
            >
              {GANG_MODE_LABELS[option]}
            </button>
          );
        })}
      </div>
      <label className="machine-inspector__row" data-row="tractors-per-sts">
        <span className="machine-inspector__label">Ťahače na STS</span>
        <input
          className="machine-inspector__number"
          type="number"
          inputMode="numeric"
          min={TRACTORS_PER_STS_MIN}
          max={TRACTORS_PER_STS_MAX}
          step={1}
          value={count}
          data-field="tractors-per-sts"
          onChange={(event) => onSetGang?.(mode, clampTractorsPerSts(Number(event.currentTarget.value)))}
        />
      </label>
    </section>
  );
}
