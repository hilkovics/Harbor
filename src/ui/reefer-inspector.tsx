/**
 * Inšpektor reefer bloku (TR5-04; rozloženie z prototypu design/ui/game-ui-t2.html, sekcia `sc === 'reefer'` a
 * inšpektor bloku). Čisto prezentačný komponent: zásuvky (celkom / obsadené / voľné), alarmy s odpočtom do reakcie,
 * reefery bez napájania s odpočtom do reklamácie a cena elektriny za herný čas jednej hodiny.
 *
 * Dáta zostaví rodič zo snapshotu (`useSimSnapshot(selector, 100)`; napojenie prinesie TR5-05), komponent nemá hooky
 * ani prístup k simulácii. Farby len cez tokeny (`design/tokens.css`), čísla s `tabular-nums`, peniaze cez `formatMoney`.
 * Odpočty sú v minútach herného času; text `1 h 10 min` počíta `formatMinutesLeft`.
 */
import { EM_DASH, MINUS_SIGN, formatCount, formatMoney } from './format';
import { Icon } from './icon';
import './reefer-inspector.css';

/** Reefer s aktívnym alarmom (teplota mimo rozsahu); `minutesToRespond` = koľko minút ostáva na reakciu hráča. */
export interface ReeferAlarmRow {
  readonly unitId: number;
  /** Označenie pre hráča (kód kontajnera, napr. `SUDU 618 220`). */
  readonly label: string;
  /** Teplota v °C (voliteľná; bez nej sa nezobrazí). */
  readonly temperatureC?: number;
  /** Cieľová teplota v °C (voliteľná; s `temperatureC` sa zobrazí ako „cieľ"). */
  readonly targetC?: number;
  readonly minutesToRespond: number;
}

/** Reefer čakajúci na zásuvku; `minutesToClaim` = odpočet do reklamácie. */
export interface ReeferUnpluggedRow {
  readonly unitId: number;
  readonly label: string;
  readonly minutesToClaim: number;
}

export interface ReeferBlockInspectorData {
  readonly id: number;
  /** Názov bloku pre hráča (`Reefer blok R1`). */
  readonly label: string;
  /** Počet zásuviek bloku celkom. */
  readonly plugsTotal: number;
  /** Zásuvky obsadené reefermi. */
  readonly plugsUsed: number;
  readonly alarms: readonly ReeferAlarmRow[];
  readonly unplugged: readonly ReeferUnpluggedRow[];
  /** Cena elektriny bloku za herný čas jednej hodiny (centy). */
  readonly powerCostCentsPerHour: number;
}

export interface ReeferBlockInspectorProps {
  readonly data?: ReeferBlockInspectorData;
}

/** Voľné zásuvky = celkom − obsadené, nikdy menej ako 0 a nikdy viac ako celkom. Neplatné čísla → 0. */
export function reeferPlugsFree(total: number, used: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safeUsed = Number.isFinite(used) ? Math.min(safeTotal, Math.max(0, Math.floor(used))) : 0;
  return safeTotal - safeUsed;
}

/** Obsadenosť zásuviek v percentách 0..100; bez zásuviek → 0. */
export function reeferPlugsUsedPct(total: number, used: number): number {
  if (!(total > 0)) return 0;
  const usedClamped = Math.min(total, Math.max(0, used));
  return (usedClamped / total) * 100;
}

/**
 * Minúty herného času ako text: `18 min`, od 60 min `1 h 10 min`. Záporné / neplatné → `0 min` (odpočet už vypršal).
 */
export function formatMinutesLeft(minutes: number): string {
  const whole = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  if (whole < 60) return `${String(whole)} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** Teplota s typografickým mínusom: `−14 °C`; bez hodnoty prázdny reťazec. */
export function reeferTemperatureText(celsius: number | undefined): string {
  if (celsius === undefined || !Number.isFinite(celsius)) return '';
  const rounded = Math.round(celsius);
  return `${rounded < 0 ? MINUS_SIGN : ''}${String(Math.abs(rounded))} °C`;
}

/** Tón odznaku bloku: alarm = bad, bez napájania = warn, inak OK. */
export function reeferBlockTone(data: ReeferBlockInspectorData): 'bad' | 'warn' | 'ok' {
  if (data.alarms.length > 0) return 'bad';
  if (data.unplugged.length > 0) return 'warn';
  return 'ok';
}

const TONE_LABELS: Readonly<Record<'bad' | 'warn' | 'ok', string>> = {
  bad: 'Alarm',
  warn: 'Bez napájania',
  ok: 'OK',
};

export function ReeferBlockInspector({ data }: ReeferBlockInspectorProps) {
  if (data === undefined) {
    return (
      <aside className="reefer-inspector" aria-label="Inšpektor reefer bloku" data-section="reefer-block-empty">
        <span className="reefer-inspector__empty">Reefer blok nie je vybraný.</span>
      </aside>
    );
  }
  const free = reeferPlugsFree(data.plugsTotal, data.plugsUsed);
  const usedPct = reeferPlugsUsedPct(data.plugsTotal, data.plugsUsed);
  const tone = reeferBlockTone(data);
  return (
    <aside
      className="reefer-inspector"
      aria-label="Inšpektor reefer bloku"
      data-reefer-block-id={data.id}
      data-tone={tone}
    >
      <div className="reefer-inspector__header">
        <Icon name="ic_reefer" className="reefer-inspector__icon" />
        <div className="reefer-inspector__titles">
          <span className="reefer-inspector__title" data-field="title">
            {data.label}
          </span>
          <span className="reefer-inspector__sub">Zásuvky a napájanie</span>
        </div>
        <span className={`reefer-inspector__badge reefer-inspector__badge--${tone}`} data-field="status-badge">
          {TONE_LABELS[tone]}
        </span>
      </div>

      <section className="reefer-inspector__section" data-section="reefer-plugs">
        <div className="reefer-inspector__plug-head">
          <span className="reefer-inspector__label">Zásuvky</span>
          <span className="reefer-inspector__value" data-field="plugs-used">
            {`${formatCount(data.plugsUsed)} / ${formatCount(data.plugsTotal)}`}
          </span>
        </div>
        <div
          className="reefer-inspector__bar"
          role="progressbar"
          aria-label="Obsadenosť zásuviek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPct)}
          data-field="plugs-bar"
        >
          <div className="reefer-inspector__bar-fill" style={{ width: `${String(usedPct)}%` }} />
        </div>
        <dl className="reefer-inspector__rows">
          <div className="reefer-inspector__row" data-row="plugs-total">
            <dt className="reefer-inspector__label">Zásuvky celkom</dt>
            <dd className="reefer-inspector__value" data-field="plugs-total">
              {formatCount(data.plugsTotal)}
            </dd>
          </div>
          <div className="reefer-inspector__row" data-row="plugs-free">
            <dt className="reefer-inspector__label">Voľné</dt>
            <dd className="reefer-inspector__value" data-field="plugs-free">
              {formatCount(free)}
            </dd>
          </div>
          <div className="reefer-inspector__row" data-row="power-cost">
            <dt className="reefer-inspector__label">Elektrina za hodinu</dt>
            <dd className="reefer-inspector__value" data-field="power-cost">
              {`${formatMoney(data.powerCostCentsPerHour)} / h`}
            </dd>
          </div>
        </dl>
      </section>

      <section className="reefer-inspector__section" data-section="reefer-alarms">
        <div className="reefer-inspector__list-head">
          <span className="reefer-inspector__label">Alarmy</span>
          <span className="reefer-inspector__value" data-field="alarm-count">
            {formatCount(data.alarms.length)}
          </span>
        </div>
        {data.alarms.length === 0 ? (
          <span className="reefer-inspector__none" data-field="alarms-empty">
            Žiadne alarmy.
          </span>
        ) : (
          <ul className="reefer-inspector__list">
            {data.alarms.map((alarm) => (
              <li key={alarm.unitId} className="reefer-inspector__item reefer-inspector__item--bad" data-unit-id={alarm.unitId}>
                <Icon name="ic_warning" className="reefer-inspector__item-icon" />
                <div className="reefer-inspector__item-body">
                  <span className="reefer-inspector__item-title">{alarm.label}</span>
                  <span className="reefer-inspector__item-sub">
                    {[reeferTemperatureText(alarm.temperatureC), alarm.targetC === undefined ? '' : `cieľ ${reeferTemperatureText(alarm.targetC)}`]
                      .filter((part) => part !== '')
                      .join(' · ') || EM_DASH}
                  </span>
                </div>
                <span className="reefer-inspector__item-time" data-field="alarm-minutes">
                  {`reagovať do ${formatMinutesLeft(alarm.minutesToRespond)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="reefer-inspector__section" data-section="reefer-unplugged">
        <div className="reefer-inspector__list-head">
          <span className="reefer-inspector__label">Bez napájania</span>
          <span className="reefer-inspector__value" data-field="unplugged-count">
            {formatCount(data.unplugged.length)}
          </span>
        </div>
        {data.unplugged.length === 0 ? (
          <span className="reefer-inspector__none" data-field="unplugged-empty">
            Všetky reefery majú zásuvku.
          </span>
        ) : (
          <ul className="reefer-inspector__list">
            {data.unplugged.map((unit) => (
              <li key={unit.unitId} className="reefer-inspector__item" data-unit-id={unit.unitId}>
                <Icon name="ic_reefer" className="reefer-inspector__item-icon" />
                <div className="reefer-inspector__item-body">
                  <span className="reefer-inspector__item-title">{unit.label}</span>
                </div>
                <span className="reefer-inspector__item-time" data-field="claim-minutes">
                  {`reklamácia o ${formatMinutesLeft(unit.minutesToClaim)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
