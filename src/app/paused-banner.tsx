/**
 * Banner „Pozastavené“ (prototyp design/ui/game-ui.source.html): pás pod HUD, keď hra stojí (rýchlosť 0).
 * Ikona + text + nápoveda klávesu (KeyHint „Medzerník“), aby stav nebol len farba (DESIGN_BRIEF §6.4). Neblokuje myš.
 */
import { Icon } from '@ui/icon';
import { useSimSnapshot } from './use-sim-snapshot';

/** Odstup prekresľovania (rovnaký ako HUD, ARCHITECTURE §13). */
const BANNER_THROTTLE_MS = 100;

export function PausedBanner() {
  const paused = useSimSnapshot((snapshot) => snapshot.speed === 0, BANNER_THROTTLE_MS);
  if (!paused) return null;
  return (
    <div className="paused-banner" role="status" data-field="paused-banner">
      <div className="paused-banner__chip">
        <Icon name="ic_pause" className="paused-banner__icon" />
        <span className="paused-banner__label">Pozastavené</span>
        <kbd className="paused-banner__key">Medzerník</kbd>
      </div>
    </div>
  );
}
