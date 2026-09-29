/**
 * Ikony z ikonovej sady `assets/icons/icons.svg` (Claude Design, relácia 5): sprite `<symbol id="ic_…">`, viewBox 24,
 * čiara 2 px, `currentColor` — farbu určuje CSS rodiča, veľkosť trieda (`className`). URL spritu rieši Vite (`?url`,
 * v builde s hashom), takže `<use href>` funguje aj mimo koreňa servera.
 */
import iconsUrl from '../../assets/icons/icons.svg?url';

/** Názov symbolu v spritu, napr. `ic_cash` (zoznam: `assets/manifest.json` → `icons`, prefix `ic_`). */
export type IconName = `ic_${string}`;

/** Adresa symbolu v spritu (`<url>#ic_cash`). */
export function iconHref(name: IconName): string {
  return `${iconsUrl}#${name}`;
}

export interface IconProps {
  readonly name: IconName;
  /** Trieda s rozmerom (`width`/`height`) — bez nej má ikona veľkosť podľa CSS rodiča. */
  readonly className?: string;
}

/** Dekoratívna ikona (`aria-hidden`); zmysel nesie text alebo `aria-label` okolitého prvku. */
export function Icon({ name, className }: IconProps) {
  return (
    <svg className={className === undefined ? 'hud-icon' : `hud-icon ${className}`} aria-hidden="true" focusable="false">
      <use href={iconHref(name)} />
    </svg>
  );
}

/**
 * Trojuholník `▲`/`▼` pri dennom delta. Sprite ho neobsahuje a textový glyf by záležal na záložnom fonte
 * (Inter ho nemá), preto je to malé inline SVG s `currentColor`.
 */
export function TrendIcon({ direction, className }: { direction: 'up' | 'down'; className?: string }) {
  return (
    <svg
      className={className === undefined ? 'hud-icon' : `hud-icon ${className}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={direction === 'up' ? 'M12 4l10 16H2z' : 'M12 20L2 4h20z'} />
    </svg>
  );
}
