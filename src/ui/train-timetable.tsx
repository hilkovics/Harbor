/**
 * Cestovný poriadok vlakov (TR6-04; tokeny podľa `design/tokens.css`, štýl ako tabuľky v ostatných paneloch).
 * Malá tabuľka: vlak, príchod, odchod, počet vagónov a stav. Časy prichádzajú ako hotové texty (`Deň 2 · 14:30`),
 * komponent nič nepočíta a nemá hooky; rodič ich zostaví zo snapshotu (`useSimSnapshot(selector, 100)`, TR6-05).
 * Čísla v stĺpcoch s `tabular-nums`.
 */
import { EM_DASH, formatCount } from './format';
import { Icon } from './icon';
import './train-timetable.css';

/** Stav vlaku v cestovnom poriadku: plánovaný, nakladá sa, mešká, odišiel. */
export type TrainTimetableStatus = 'planned' | 'loading' | 'delayed' | 'departed';

export interface TrainTimetableRow {
  readonly trainId: number;
  /** Označenie pre hráča (`V-112`); bez neho sa ukáže `Vlak <id>`. */
  readonly label?: string;
  /** Čas príchodu ako text (napr. `Deň 2 · 14:30`). */
  readonly arrivalLabel: string;
  /** Čas odchodu ako text; chýba = ešte nie je určený. */
  readonly departureLabel?: string;
  /** Počet vagónov vlaku. */
  readonly wagons: number;
  readonly status: TrainTimetableStatus;
}

export interface TrainTimetableProps {
  readonly rows?: readonly TrainTimetableRow[];
}

export const TRAIN_STATUS_LABELS: Readonly<Record<TrainTimetableStatus, string>> = {
  planned: 'Plánovaný',
  loading: 'Nakladá sa',
  delayed: 'Mešká',
  departed: 'Odišiel',
};

/** Tón stavu pre farbu odznaku: mešká = warn, nakladá sa = ok, plánovaný a odišiel = mute. */
export const TRAIN_STATUS_TONES: Readonly<Record<TrainTimetableStatus, 'ok' | 'warn' | 'mute'>> = {
  planned: 'mute',
  loading: 'ok',
  delayed: 'warn',
  departed: 'mute',
};

export function TrainTimetable({ rows }: TrainTimetableProps) {
  const list = rows ?? [];
  if (list.length === 0) {
    return (
      <section
        className="train-timetable train-timetable--empty"
        aria-label="Cestovný poriadok vlakov"
        data-section="train-timetable"
      >
        <span className="train-timetable__empty" data-field="timetable-empty">
          Cestovný poriadok je prázdny.
        </span>
      </section>
    );
  }
  return (
    <section className="train-timetable" aria-label="Cestovný poriadok vlakov" data-section="train-timetable">
      <table className="train-timetable__table">
        <thead>
          <tr>
            <th scope="col" className="train-timetable__head">
              <Icon name="ic_train" className="train-timetable__head-icon" />
              Vlak
            </th>
            <th scope="col" className="train-timetable__head train-timetable__head--num">
              Príchod
            </th>
            <th scope="col" className="train-timetable__head train-timetable__head--num">
              Odchod
            </th>
            <th scope="col" className="train-timetable__head train-timetable__head--num">
              Vagóny
            </th>
            <th scope="col" className="train-timetable__head">
              Stav
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr
              key={row.trainId}
              className={`train-timetable__row train-timetable__row--${row.status}`}
              data-train-id={row.trainId}
              data-status={row.status}
            >
              <td className="train-timetable__cell" data-field="train">
                {row.label ?? `Vlak ${String(row.trainId)}`}
              </td>
              <td className="train-timetable__cell train-timetable__cell--num" data-field="arrival">
                {row.arrivalLabel}
              </td>
              <td className="train-timetable__cell train-timetable__cell--num" data-field="departure">
                {row.departureLabel ?? EM_DASH}
              </td>
              <td className="train-timetable__cell train-timetable__cell--num" data-field="wagons">
                {formatCount(row.wagons)}
              </td>
              <td className="train-timetable__cell" data-field="status">
                <span className={`train-timetable__badge train-timetable__badge--${TRAIN_STATUS_TONES[row.status]}`}>
                  {TRAIN_STATUS_LABELS[row.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
