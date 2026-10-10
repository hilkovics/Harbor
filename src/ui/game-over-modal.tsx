/**
 * GameOverModal (DESIGN_BRIEF §6.2 bod 11; rozloženie z prototypu design/ui/game-ui.source.html, overlay `gameover`):
 * modál „Bankrot" po `cash < 0` po `bankruptcyDays` dní za sebou (ARCHITECTURE §9.2). Ikona varovania, nadpis, vysvetlenie,
 * dlaždice štatistík (prežité dni, kontrakty, XP) a tlačidlo „Nová hra".
 *
 * Čisto prezentačný (props → DOM): štatistiky a počet dní bankrotu dodá app vrstva, „Nová hra" (a voliteľne „Načítať
 * uloženú hru", ktorú pripojí Fáza 6, kým nie je save/load) sú callbacky. Modál je terminálny — nemá zatváranie ani Esc.
 * Po zobrazení dostane fokus „Nová hra"; rodič ho vkladá do relatívne pozicovaného kontajnera hry (zakryje mapu aj panely).
 */
import { useEffect, useId, useRef } from 'react';
import { formatCount, formatXp } from './format';
import { Icon } from './icon';
import './game-over-modal.css';

export interface GameOverModalProps {
  /** Prežité dni (počet dokončených herných dní, nie 0-based index). */
  readonly daysSurvived: number;
  readonly completedContracts: number;
  readonly xp: number;
  /** Koľko dní za sebou musí byť hotovosť záporná (`economy.bankruptcyDays`); ide do vysvetľujúceho textu. */
  readonly bankruptcyDays: number;
  readonly onNewGame: () => void;
  /** Voliteľné „Načítať uloženú hru" (Fáza 6); bez handlera sa tlačidlo nezobrazí. */
  readonly onLoadGame?: () => void;
}

/** Vysvetlenie bankrotu (prototyp: „Hotovosť zostala záporná 30 dní po sebe. Banka zablokovala účet prístavu."). */
export function bankruptcyText(bankruptcyDays: number): string {
  return `Hotovosť zostala záporná ${formatCount(bankruptcyDays)} dní po sebe. Banka zablokovala účet prístavu.`;
}

export function GameOverModal({ daysSurvived, completedContracts, xp, bankruptcyDays, onNewGame, onLoadGame }: GameOverModalProps) {
  const newGameRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  useEffect(() => {
    newGameRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="game-over">
      <div
        className="game-over__dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
      >
        <div className="game-over__badge">
          <Icon name="ic_warning" className="game-over__badge-icon" />
        </div>
        <div className="game-over__message">
          <span className="game-over__title" id={titleId}>
            Bankrot
          </span>
          <span className="game-over__text" id={textId} data-field="text">
            {bankruptcyText(bankruptcyDays)}
          </span>
        </div>
        <div className="game-over__stats">
          <div className="game-over__stat">
            <span className="game-over__stat-label">Prežité dni</span>
            <span className="game-over__stat-value" data-field="days">
              {formatCount(daysSurvived)}
            </span>
          </div>
          <div className="game-over__stat">
            <span className="game-over__stat-label">Kontrakty</span>
            <span className="game-over__stat-value" data-field="contracts">
              {formatCount(completedContracts)}
            </span>
          </div>
          <div className="game-over__stat">
            <span className="game-over__stat-label">Skúsenosti</span>
            <span className="game-over__stat-value game-over__stat-value--xp" data-field="xp">
              {formatXp(xp)}
            </span>
          </div>
        </div>
        <div className="game-over__actions">
          {onLoadGame !== undefined && (
            <button type="button" className="game-over__btn game-over__btn--primary" data-action="load" onClick={onLoadGame}>
              <Icon name="ic_load" className="game-over__btn-icon" />
              Načítať uloženú hru
            </button>
          )}
          <button
            ref={newGameRef}
            type="button"
            className={onLoadGame === undefined ? 'game-over__btn game-over__btn--primary' : 'game-over__btn game-over__btn--secondary'}
            data-action="new-game"
            onClick={onNewGame}
          >
            Nová hra
          </button>
        </div>
      </div>
    </div>
  );
}
