/**
 * SpeedControl (DESIGN_BRIEF §6.3, prototyp design/ui/game-ui.source.html): segmentovaná skupina ⏸ 1× 2× 4× 8×.
 * Prezentačný komponent bez hookov. Zoznam rýchlostí a aktuálnu hodnotu dostane od rodiča (TopHUD ich berie
 * zo snapshotu: `snapshot.speeds` = `time.speeds`), zmenu hlási cez `onChange`. Aktívny stav je v `aria-pressed` + triede
 * `speed-control__btn--active` (vyplnené tlačidlo, nie len farba). Pri pauze ⏸ zmení ikonu na ▶ (klik = obnoviť).
 */
import { formatSpeed } from './format';
import { Icon } from './icon';
import './top-hud.css';

export interface SpeedControlProps {
  /** Aktuálna rýchlosť (0 = pauza); zvýrazní sa zodpovedajúce tlačidlo. */
  readonly value: number;
  /** Ponúkané rýchlosti v poradí zobrazenia (0 = pauza), typicky `world.defs.time.speeds`. */
  readonly speeds: readonly number[];
  /**
   * Volá sa pri každom kliknutí, aj na už aktívne tlačidlo: `value` prichádza zo snapshotu (throttle 100 ms), takže
   * môže krátko zaostávať za sim — vynechanie „nezmenenej" hodnoty by pri rýchlom dvojkliku stratilo príkaz.
   */
  readonly onChange: (speed: number) => void;
  readonly className?: string;
}

/** Nápoveda klávesy: medzerník = pauza, `1…n` = poradie medzi nenulovými rýchlosťami (ARCHITECTURE §15.2). */
function keyHint(speed: number, running: readonly number[]): string {
  if (speed === 0) return 'Medzerník';
  return String(running.indexOf(speed) + 1);
}

export function SpeedControl({ value, speeds, onChange, className }: SpeedControlProps) {
  const running = speeds.filter((speed) => speed !== 0);
  const rootClass = className === undefined ? 'speed-control' : `speed-control ${className}`;
  return (
    <div className={rootClass} role="group" aria-label="Rýchlosť hry" data-field="speed" data-value={value}>
      {speeds.map((speed) => {
        const active = speed === value;
        const isPause = speed === 0;
        const btnClass = [
          'speed-control__btn',
          active ? 'speed-control__btn--active' : '',
          isPause ? 'speed-control__btn--pause' : '',
        ]
          .filter((part) => part !== '')
          .join(' ');
        return (
          <button
            key={speed}
            type="button"
            className={btnClass}
            aria-pressed={active}
            aria-label={isPause ? 'Pauza' : `Rýchlosť ${formatSpeed(speed)}`}
            title={isPause ? `Pauza (${keyHint(speed, running)})` : `Rýchlosť ${formatSpeed(speed)} (${keyHint(speed, running)})`}
            data-speed={speed}
            onClick={() => {
              onChange(speed);
            }}
          >
            {isPause ? <Icon name={active ? 'ic_play' : 'ic_pause'} className="speed-control__icon" /> : formatSpeed(speed)}
          </button>
        );
      })}
    </div>
  );
}
