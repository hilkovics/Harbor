/**
 * Inšpektory brány a predbránovej plochy (TR4-04; rozloženie z prototypu design/ui/game-ui-t2.html, sekcia
 * `sc === 'gate'` a riadok predbránovej plochy v paneli landside). Tri čisto prezentačné komponenty:
 *  - `GateLaneInspector` — pruh brány (vstup / výstup): režim Štandard / Express / Trouble volá `onSetMode(mode)`,
 *    aktuálny krok s priebehom, dĺžka fronty, kamióny spracované a kamióny za hodinu.
 *  - `PreGateInspector` — predbránová plocha: riadky × 2 sloty (obsadenosť) a počet kamiónov čakajúcich vo vnútrozemí.
 *  - `TurnTimeStat` — karta TTT (truck turn time, čas kamióna v termináli) pre panel štatistík.
 *
 * Dáta zostaví rodič zo snapshotu (`useSimSnapshot(selector, 100)`; napojenie prinesie TR4-05), komponenty nemajú hooky
 * ani prístup k simulácii. Farby len cez tokeny (`design/tokens.css`), čísla s `tabular-nums`, peniaze tu nie sú.
 */
import { EM_DASH, formatCount, formatPercent } from './format';
import { Icon, type IconName } from './icon';
import './gate-inspector.css';

/** Režim pruhu brány: štandard, express (rýchla obsluha), trouble (riešenie problémov). */
export type GateLaneMode = 'standard' | 'express' | 'trouble';

/** Krok spracovania kamióna v pruhu; `null` = pruh voľný. */
export type GateLaneStep = 'ocr' | 'check' | 'issue' | 'weigh' | 'scan' | 'seal' | 'express' | 'trouble' | 'inspect';

/** Smer pruhu: vstup (IN) alebo výstup (OUT). */
export type GateLaneKind = 'in' | 'out';

export const GATE_LANE_MODES: readonly GateLaneMode[] = ['standard', 'express', 'trouble'];

export const GATE_LANE_MODE_LABELS: Readonly<Record<GateLaneMode, string>> = {
  standard: 'Štandard',
  express: 'Express',
  trouble: 'Trouble',
};

export const GATE_LANE_KIND_LABELS: Readonly<Record<GateLaneKind, string>> = {
  in: 'Vstup',
  out: 'Výstup',
};

export const GATE_LANE_STEP_LABELS: Readonly<Record<GateLaneStep, string>> = {
  ocr: 'Čítanie OCR',
  check: 'Kontrola dokladov',
  issue: 'Vydanie lístka',
  weigh: 'Váženie',
  scan: 'Skener',
  seal: 'Kontrola plomby',
  express: 'Express odbavenie',
  trouble: 'Riešenie problému',
  inspect: 'Inšpekcia',
};

/** Dáta inšpektora jedného pruhu brány; `label` je označenie pre hráča (`IN-8`, `OUT-2`). */
export interface GateLaneInspectorData {
  readonly id: number;
  readonly label: string;
  readonly kind: GateLaneKind;
  readonly mode: GateLaneMode;
  /** Aktuálny krok; `null`, ak pruh práve nikoho neobsluhuje. */
  readonly step: GateLaneStep | null;
  /** Priebeh aktuálneho kroku v rozsahu 0..1 (mimo rozsahu sa orezáva, neplatné → 0). */
  readonly progress: number;
  /** Kamióny čakajúce v rade pred pruhom. */
  readonly queueLength: number;
  /** Kamióny odbavené pruhom od spustenia. */
  readonly trucksProcessed: number;
  /** Priepustnosť: kamióny za herný čas jednej hodiny (rodič ich počíta z tickov). */
  readonly trucksPerHour: number;
}

export interface GateLaneInspectorProps {
  readonly data?: GateLaneInspectorData;
  readonly onSetMode?: (mode: GateLaneMode) => void;
}

/** Ikona pruhu podľa smeru (vstupná / výstupná brána). */
export function gateLaneIcon(kind: GateLaneKind): IconName {
  return kind === 'in' ? 'ic_gate_in' : 'ic_gate_out';
}

/** Tón badge podľa režimu: štandard = ok, express = info, trouble = warn. */
export function gateLaneModeTone(mode: GateLaneMode): 'ok' | 'info' | 'warn' {
  if (mode === 'express') return 'info';
  if (mode === 'trouble') return 'warn';
  return 'ok';
}

/** Priebeh v rozsahu 0..1; neplatná hodnota (`NaN`, `±Infinity`) → 0. */
export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

/** Text kroku: `Voľný` pri voľnom pruhu, inak názov kroku. */
export function gateLaneStepText(step: GateLaneStep | null): string {
  return step === null ? 'Voľný' : GATE_LANE_STEP_LABELS[step];
}

export function GateLaneInspector({ data, onSetMode }: GateLaneInspectorProps) {
  if (data === undefined) {
    return (
      <aside className="gate-inspector" aria-label="Inšpektor pruhu brány" data-section="gate-lane-empty">
        <span className="gate-inspector__empty">Pruh brány nie je vybraný.</span>
      </aside>
    );
  }
  const progress = clampProgress(data.progress);
  const progressPct = progress * 100;
  return (
    <aside
      className="gate-inspector"
      aria-label="Inšpektor pruhu brány"
      data-gate-lane-id={data.id}
      data-kind={data.kind}
      data-mode={data.mode}
      data-step={data.step ?? 'idle'}
    >
      <div className="gate-inspector__header">
        <Icon name={gateLaneIcon(data.kind)} className="gate-inspector__icon" />
        <div className="gate-inspector__titles">
          <span className="gate-inspector__title" data-field="title">
            {data.label}
          </span>
          <span className="gate-inspector__sub" data-field="kind">
            {GATE_LANE_KIND_LABELS[data.kind]}
          </span>
        </div>
        <span className={`gate-inspector__badge gate-inspector__badge--${gateLaneModeTone(data.mode)}`} data-field="mode-badge">
          {GATE_LANE_MODE_LABELS[data.mode]}
        </span>
      </div>

      <section className="gate-inspector__section" data-section="gate-mode">
        <span className="gate-inspector__section-title">Režim pruhu</span>
        <div className="gate-inspector__segments" role="radiogroup" aria-label="Režim pruhu">
          {GATE_LANE_MODES.map((mode) => {
            const selected = mode === data.mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                className={selected ? 'gate-inspector__segment gate-inspector__segment--on' : 'gate-inspector__segment'}
                data-mode={mode}
                onClick={() => onSetMode?.(mode)}
              >
                {GATE_LANE_MODE_LABELS[mode]}
              </button>
            );
          })}
        </div>
      </section>

      <section className="gate-inspector__section" data-section="gate-step">
        <div className="gate-inspector__step-head">
          <span className="gate-inspector__label">Aktuálny krok</span>
          <span className="gate-inspector__value" data-field="step">
            {gateLaneStepText(data.step)}
          </span>
        </div>
        <div
          className="gate-inspector__bar"
          role="progressbar"
          aria-label="Priebeh kroku"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPct)}
          data-field="progress-bar"
        >
          <div className="gate-inspector__bar-fill" style={{ width: `${String(progressPct)}%` }} />
        </div>
        <span className="gate-inspector__bar-value" data-field="progress">
          {formatPercent(progressPct)}
        </span>
      </section>

      <div className="gate-inspector__body">
        <dl className="gate-inspector__rows">
          <div className="gate-inspector__row" data-row="queue">
            <dt className="gate-inspector__label">Fronta</dt>
            <dd className="gate-inspector__value" data-field="queue">
              {formatCount(data.queueLength)}
            </dd>
          </div>
          <div className="gate-inspector__row" data-row="processed">
            <dt className="gate-inspector__label">Kamióny spolu</dt>
            <dd className="gate-inspector__value" data-field="processed">
              {formatCount(data.trucksProcessed)}
            </dd>
          </div>
          <div className="gate-inspector__row" data-row="throughput">
            <dt className="gate-inspector__label">Kamióny / h</dt>
            <dd className="gate-inspector__value" data-field="throughput">
              {formatCount(data.trucksPerHour)}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

/** Jeden riadok predbránovej plochy: označenie a dva sloty (`true` = obsadený). */
export interface PreGateRowData {
  readonly label: string;
  readonly slots: readonly [boolean, boolean];
}

/** Dáta predbránovej plochy: riadky × 2 sloty a počet kamiónov čakajúcich vo vnútrozemí. */
export interface PreGateInspectorData {
  readonly rows: readonly PreGateRowData[];
  readonly inlandWaiting: number;
}

export interface PreGateInspectorProps {
  readonly data?: PreGateInspectorData;
}

/** Počet obsadených slotov a celkový počet slotov (každý riadok má 2). */
export function preGateOccupancy(rows: readonly PreGateRowData[]): { occupied: number; total: number } {
  let occupied = 0;
  for (const row of rows) {
    if (row.slots[0]) occupied += 1;
    if (row.slots[1]) occupied += 1;
  }
  return { occupied, total: rows.length * 2 };
}

export function PreGateInspector({ data }: PreGateInspectorProps) {
  if (data === undefined) {
    return (
      <aside className="gate-inspector" aria-label="Predbránová plocha" data-section="pregate-empty">
        <span className="gate-inspector__empty">Predbránová plocha nie je vybraná.</span>
      </aside>
    );
  }
  const { occupied, total } = preGateOccupancy(data.rows);
  return (
    <aside className="gate-inspector" aria-label="Predbránová plocha" data-section="pregate">
      <div className="gate-inspector__header">
        <Icon name="ic_one_way" className="gate-inspector__icon" />
        <div className="gate-inspector__titles">
          <span className="gate-inspector__title">Predbránový pruh</span>
          <span className="gate-inspector__sub" data-field="occupancy">
            {`${formatCount(occupied)} / ${formatCount(total)} slotov`}
          </span>
        </div>
      </div>

      <section className="gate-inspector__section" data-section="pregate-slots">
        <span className="gate-inspector__section-title">Obsadenie</span>
        <div className="gate-inspector__grid" role="table" aria-label="Obsadenie predbránovej plochy">
          {data.rows.map((row) => (
            <div className="gate-inspector__grid-row" role="row" key={row.label} data-row-label={row.label}>
              <span className="gate-inspector__grid-label" role="rowheader">
                {row.label}
              </span>
              {row.slots.map((taken, index) => (
                <span
                  key={index}
                  role="cell"
                  className={taken ? 'gate-inspector__slot gate-inspector__slot--taken' : 'gate-inspector__slot'}
                  data-slot={taken ? 'taken' : 'free'}
                  aria-label={taken ? 'obsadený' : 'voľný'}
                />
              ))}
            </div>
          ))}
        </div>
      </section>

      <div className="gate-inspector__body">
        <dl className="gate-inspector__rows">
          <div className="gate-inspector__row" data-row="inland">
            <dt className="gate-inspector__label">Vo vnútrozemí čaká</dt>
            <dd className="gate-inspector__value" data-field="inland">
              {formatCount(data.inlandWaiting)}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}

export interface TurnTimeStatProps {
  /** Priemerný čas kamióna v termináli v minútach; bez hodnoty sa zobrazí pomlčka. */
  readonly minutes?: number;
}

/** Textová hodnota TTT: celé minúty s jednotkou, `—` bez platnej hodnoty. */
export function turnTimeText(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return EM_DASH;
  return formatCount(Math.max(0, Math.round(minutes)), 'min');
}

/** Karta TTT (truck turn time) pre panel štatistík. */
export function TurnTimeStat({ minutes }: TurnTimeStatProps) {
  return (
    <div className="gate-inspector__stat" data-stat="ttt" title="TTT — čas kamióna v termináli">
      <span className="gate-inspector__stat-label">TTT · čas v termináli</span>
      <span className="gate-inspector__stat-value" data-field="ttt">
        {turnTimeText(minutes)}
      </span>
    </div>
  );
}
