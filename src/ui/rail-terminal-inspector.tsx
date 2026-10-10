/**
 * Inšpektor železničného terminálu (TR6-04; rozloženie a tokeny podľa `reefer-inspector.tsx` a `design/tokens.css`).
 * Čisto prezentačný komponent: naplnenie buffera (TEU obsadené / celkom), stav RMG a fronta, odhad príchodu ďalšieho
 * vlaku, a aktuálny vlak s vagónmi v poradí nakladania (0–3 TEU na vagón), odpočtom odchodu a meškaním.
 *
 * Dáta zostaví rodič zo snapshotu (`useSimSnapshot(selector, 100)`; napojenie prinesie TR6-05), komponent nemá hooky
 * ani prístup k simulácii. Farby len cez tokeny, čísla s `tabular-nums`, peniaze tu nie sú. Odpočty sú v minútach
 * herného času; text `1 h 10 min` počíta `formatMinutesLeft` z `reefer-inspector.tsx`.
 */
import { EM_DASH, formatCount } from './format';
import { formatMinutesLeft } from './reefer-inspector';
import { Icon } from './icon';
import { MACHINE_STATE_LABELS, MACHINE_STATE_TONES, type MachineStateName } from './machine-inspector';
import './rail-terminal-inspector.css';

/** Kapacita vagóna v TEU (`wagon_container_60` = 60′ = 3 TEU, ADR-043); použije sa, ak dáta kapacitu nedodajú. */
export const RAIL_WAGON_CAPACITY_TEU = 3;

/** Vagón vlaku v poradí nakladania (index 0 = pri lokomotíve). `teu` je obsadenie v TEU, ohraničené kapacitou. */
export interface RailWagonData {
  readonly wagonId: number;
  readonly teu: number;
  /** Kapacita v TEU; bez nej `RAIL_WAGON_CAPACITY_TEU`. */
  readonly capacityTeu?: number;
}

/** Aktuálny vlak v termináli. `departureInMin` = odpočet do odchodu; `delayMin` = minúty meškania (0 = bez meškania). */
export interface RailTrainData {
  readonly trainId: number;
  /** Označenie pre hráča (`Vlak V-112`). */
  readonly label: string;
  readonly wagons: readonly RailWagonData[];
  readonly departureInMin: number;
  readonly delayMin: number;
}

export interface RailTerminalInspectorData {
  readonly id: number;
  /** Názov terminálu pre hráča (`Železničný terminál`). */
  readonly label: string;
  /** Obsadenie buffera v TEU. */
  readonly bufferUsedTeu: number;
  /** Kapacita buffera v TEU. */
  readonly bufferTotalTeu: number;
  /** Stav RMG nad koľajou a bufferom (rovnaká škála ako ostatné stroje). */
  readonly rmgState: MachineStateName;
  /** Počet úloh RMG čakajúcich vo fronte. */
  readonly rmgQueue: number;
  /** Minúty do príchodu ďalšieho vlaku; chýba = žiadny plánovaný vlak. */
  readonly nextTrainEtaMin?: number;
  /** Vlak práve v termináli; chýba = koľaj je prázdna. */
  readonly currentTrain?: RailTrainData;
}

export interface RailTerminalInspectorProps {
  readonly data?: RailTerminalInspectorData;
}

/** Obsadenie buffera v percentách 0..100; bez kapacity → 0. Obsadenie je ohraničené kapacitou. */
export function railBufferPct(used: number, total: number): number {
  if (!(total > 0)) return 0;
  const clamped = Math.min(total, Math.max(0, used));
  return (clamped / total) * 100;
}

/** Obsadenie vagóna v TEU ohraničené na `0..kapacita`; neplatné čísla → 0. */
export function railWagonFill(wagon: RailWagonData): {
  readonly teu: number;
  readonly capacityTeu: number;
} {
  const capacity =
    wagon.capacityTeu !== undefined && Number.isFinite(wagon.capacityTeu) && wagon.capacityTeu > 0
      ? Math.floor(wagon.capacityTeu)
      : RAIL_WAGON_CAPACITY_TEU;
  const teu = Number.isFinite(wagon.teu) ? Math.min(capacity, Math.max(0, Math.floor(wagon.teu))) : 0;
  return { teu, capacityTeu: capacity };
}

/** Text meškania: `bez meškania`, inak `meškanie 5 min` (záporné / neplatné = bez meškania). */
export function railDelayText(delayMin: number): string {
  const whole = Number.isFinite(delayMin) ? Math.floor(delayMin) : 0;
  return whole > 0 ? `meškanie ${formatMinutesLeft(whole)}` : 'bez meškania';
}

/** Text odpočtu odchodu: `odchod za 12 min`, pri nule `odchádza teraz`. */
export function railDepartureText(departureInMin: number): string {
  const whole = Number.isFinite(departureInMin) ? Math.floor(departureInMin) : 0;
  return whole <= 0 ? 'odchádza teraz' : `odchod za ${formatMinutesLeft(whole)}`;
}

/** Tón terminálu: meškajúci vlak = warn, RMG blokovaný = bad, inak podľa stavu RMG. */
export function railTerminalTone(data: RailTerminalInspectorData): 'ok' | 'warn' | 'bad' | 'mute' {
  if (data.rmgState === 'blocked') return 'bad';
  if (data.currentTrain !== undefined && data.currentTrain.delayMin > 0) return 'warn';
  return MACHINE_STATE_TONES[data.rmgState];
}

export function RailTerminalInspector({ data }: RailTerminalInspectorProps) {
  if (data === undefined) {
    return (
      <aside className="rail-inspector" aria-label="Inšpektor železničného terminálu" data-section="rail-terminal-empty">
        <span className="rail-inspector__empty">Železničný terminál nie je vybraný.</span>
      </aside>
    );
  }
  const usedPct = railBufferPct(data.bufferUsedTeu, data.bufferTotalTeu);
  const tone = railTerminalTone(data);
  const train = data.currentTrain;
  return (
    <aside
      className="rail-inspector"
      aria-label="Inšpektor železničného terminálu"
      data-rail-terminal-id={data.id}
      data-tone={tone}
    >
      <div className="rail-inspector__header">
        <Icon name="ic_rail_station" className="rail-inspector__icon" />
        <div className="rail-inspector__titles">
          <span className="rail-inspector__title" data-field="title">
            {data.label}
          </span>
          <span className="rail-inspector__sub">Buffer, RMG a vlak</span>
        </div>
        <span className={`rail-inspector__badge rail-inspector__badge--${tone}`} data-field="status-badge">
          {MACHINE_STATE_LABELS[data.rmgState]}
        </span>
      </div>

      <section className="rail-inspector__section" data-section="rail-buffer">
        <div className="rail-inspector__row-head">
          <span className="rail-inspector__label">Buffer</span>
          <span className="rail-inspector__value" data-field="buffer-used">
            {`${formatCount(data.bufferUsedTeu)} / ${formatCount(data.bufferTotalTeu)} TEU`}
          </span>
        </div>
        <div
          className="rail-inspector__bar"
          role="progressbar"
          aria-label="Obsadenie buffera"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPct)}
          data-field="buffer-bar"
        >
          <div className="rail-inspector__bar-fill" style={{ width: `${String(usedPct)}%` }} />
        </div>
        <dl className="rail-inspector__rows">
          <div className="rail-inspector__row" data-row="rmg">
            <dt className="rail-inspector__label">RMG</dt>
            <dd className="rail-inspector__value" data-field="rmg-state">
              {MACHINE_STATE_LABELS[data.rmgState]}
            </dd>
          </div>
          <div className="rail-inspector__row" data-row="rmg-queue">
            <dt className="rail-inspector__label">Fronta RMG</dt>
            <dd className="rail-inspector__value" data-field="rmg-queue">
              {formatCount(data.rmgQueue)}
            </dd>
          </div>
          <div className="rail-inspector__row" data-row="next-train">
            <dt className="rail-inspector__label">Ďalší vlak</dt>
            <dd className="rail-inspector__value" data-field="next-train-eta">
              {data.nextTrainEtaMin === undefined ? EM_DASH : `príde za ${formatMinutesLeft(data.nextTrainEtaMin)}`}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rail-inspector__section" data-section="rail-train">
        {train === undefined ? (
          <span className="rail-inspector__none" data-field="train-empty">
            Vlak nie je v termináli.
          </span>
        ) : (
          <>
            <div className="rail-inspector__row-head">
              <span className="rail-inspector__item-title" data-field="train-label" data-train-id={train.trainId}>
                {train.label}
              </span>
              <span className="rail-inspector__value" data-field="departure">
                {railDepartureText(train.departureInMin)}
              </span>
            </div>
            <span
              className={`rail-inspector__delay${train.delayMin > 0 ? ' rail-inspector__delay--warn' : ''}`}
              data-field="delay"
            >
              {railDelayText(train.delayMin)}
            </span>
            <div className="rail-inspector__list-head">
              <span className="rail-inspector__label">Vagóny (poradie nakladania)</span>
              <span className="rail-inspector__value" data-field="wagon-count">
                {formatCount(train.wagons.length)}
              </span>
            </div>
            {train.wagons.length === 0 ? (
              <span className="rail-inspector__none" data-field="wagons-empty">
                Vlak nemá vagóny.
              </span>
            ) : (
              <ol className="rail-inspector__wagons">
                {train.wagons.map((wagon, index) => {
                  const fill = railWagonFill(wagon);
                  return (
                    <li
                      key={wagon.wagonId}
                      className="rail-inspector__wagon"
                      data-wagon-id={wagon.wagonId}
                      data-order={index + 1}
                    >
                      <span className="rail-inspector__wagon-order">{String(index + 1)}</span>
                      <Icon name="ic_container" className="rail-inspector__wagon-icon" />
                      <span
                        className="rail-inspector__cells"
                        role="img"
                        aria-label={`${String(fill.teu)} z ${String(fill.capacityTeu)} TEU`}
                      >
                        {Array.from({ length: fill.capacityTeu }, (_, cell) => (
                          <span
                            key={cell}
                            className={`rail-inspector__cell${cell < fill.teu ? ' rail-inspector__cell--on' : ''}`}
                          />
                        ))}
                      </span>
                      <span className="rail-inspector__wagon-teu" data-field="wagon-teu">
                        {`${String(fill.teu)} / ${String(fill.capacityTeu)} TEU`}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
