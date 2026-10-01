/**
 * ModalDialog (T06-04): spoločný obal overlayov Nastavenia a Uložiť/načítať (rozloženie z prototypu
 * design/ui/game-ui.source.html, overlay `settings`): zásterka cez celý kontajner hry, dialóg so záhlavím
 * (nadpis + ✕) a obsahom, ktorý dodá rodič (`modal-dialog__body` + `modal-dialog__footer`).
 *
 * Prístupnosť: `role="dialog"` + `aria-modal` + `aria-label`; po zobrazení dostane fokus prvý ovládací prvok, po zatvorení
 * sa fokus vráti na prvok, ktorý ho mal predtým (ikona v HUD); Esc zatvára; Tab a Shift+Tab ostávajú v dialógu.
 * Klávesnica patrí dialógu: každý `keydown` sa zastaví (`stopPropagation`), takže herné skratky (medzerník, 1–8, R…)
 * nereagujú, kým je overlay otvorený. Rodič vkladá overlay do relatívne pozicovaného kontajnera hry.
 *
 * Logika klávesov (`handleDialogKeyDown`, `trapTarget`) je čistá a testovaná bez DOM (tests/ui/modal-dialog.test.ts).
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './icon';
import './modal-dialog.css';

/** Prvky, na ktoré sa dá Tabom dostať (vynechané: disabled, skryté, `tabindex="-1"`, `input type=hidden`). */
export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
]
  .map((selector) => `${selector}:not([tabindex="-1"]):not([hidden])`)
  .join(',');

/** Prvky dialógu v poradí dokumentu, na ktoré sa dá Tabom dostať. */
export function listFocusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Cieľ fokusu, ktorý musí dialóg vynútiť, aby Tab neopustil dialóg; `undefined` = nechaj prehliadač (Tab ostane vnútri).
 * - fokus mimo zoznamu (napr. na `body` po kliknutí na zásterku) → prvý prvok (Shift+Tab: posledný),
 * - Tab na poslednom prvku → prvý, Shift+Tab na prvom → posledný.
 */
export function trapTarget<T>(focusables: readonly T[], active: unknown, shift: boolean): T | undefined {
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const index = focusables.findIndex((item) => item === active);
  if (index === -1) return shift ? last : first;
  if (!shift && index === focusables.length - 1) return first;
  if (shift && index === 0) return last;
  return undefined;
}

/** Podmnožina `KeyboardEvent`, ktorú dialóg používa (aby šla logika testovať bez DOM). */
export interface DialogKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Esc zatvára, Tab sa zalamuje v dialógu; ostatné klávesy sa len zastavia (nešíria sa do herných skratiek). */
export function handleDialogKeyDown<T extends { focus(): void }>(
  event: DialogKeyEvent,
  onClose: () => void,
  focusables: readonly T[],
  active: unknown,
): void {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
    return;
  }
  if (event.key === 'Tab') {
    const target = trapTarget(focusables, active, event.shiftKey);
    if (target !== undefined) {
      event.preventDefault();
      target.focus();
    }
  }
}

export interface ModalDialogProps {
  /** Prístupný názov dialógu (`aria-label`). */
  readonly label: string;
  /** Viditeľný nadpis v záhlaví. */
  readonly title: string;
  readonly onClose: () => void;
  /** Modifikátor tried dialógu (`settings-panel`, `save-load-panel`). */
  readonly className?: string;
  /** Hodnota `data-dialog` pre testy a e2e. */
  readonly dialogId?: string;
  /** Obsah pod záhlavím: `modal-dialog__body` a `modal-dialog__footer` dodáva rodič. */
  readonly children: ReactNode;
}

export function ModalDialog({ label, title, onClose, className, dialogId, children }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fokus na prvý prvok po zobrazení; po zatvorení späť na pôvodný prvok.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const previous = dialog.ownerDocument.activeElement;
    const [first] = listFocusables(dialog);
    (first ?? dialog).focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const dialog = dialogRef.current;
    handleDialogKeyDown(
      event,
      onClose,
      dialog === null ? [] : listFocusables(dialog),
      dialog === null ? null : dialog.ownerDocument.activeElement,
    );
  };

  return (
    <div className="modal-scrim" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        className={className === undefined ? 'modal-dialog' : `modal-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-dialog={dialogId}
      >
        <div className="modal-dialog__header">
          <span className="modal-dialog__title">{title}</span>
          <button type="button" className="modal-dialog__close" title="Zavrieť (Esc)" aria-label="Zavrieť" data-action="close-x" onClick={onClose}>
            <Icon name="ic_close" className="modal-dialog__close-icon" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
