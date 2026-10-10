/**
 * Toasts (DESIGN_BRIEF §6.2; rozloženie z prototypu design/ui/game-ui.source.html, `showToasts` / `TT`): zásobník
 * oznámení vľavo od pravého panelu, nad BuildBarom. Každý toast: farebný pruh tónu (info / success / warning /
 * danger), ikona, názov, popis a odkaz „Zobraziť" (voliteľný) + zavrieť. Tón nesie farba pruhu a ikony, ale
 * význam vždy aj ikona a text (farba nikdy nie je jediný nositeľ).
 *
 * Komponent je čisto prezentačný (props → DOM, bez hookov): zoznam toastov, ich poradie, automatické zatvorenie po N s
 * a zdroj udalostí (`NoStorageAvailable`, modul bez pripojenia…) rieši rodič (T03-10). Naraz sa ukáže najviac
 * `MAX_TOASTS` (4) prvých toastov zo zoznamu — ďalšie čakajú, kým sa niektorý zatvorí (ako v prototype: `slice(0, 4)`).
 * Zoznam je `role="region"` s pomenovaním, každý toast `role="status"` (zdvorilé oznámenie čítačkou obrazovky).
 *
 * Poloha (prototyp: `right:384px; bottom:108px; width:340px`) je odvodená z tokenov v toasts.css; rodič ho vkladá
 * do relatívne pozicovaného kontajnera hry (mapa), ako pravý panel a BuildBar.
 */
import { Icon, toIconName } from './icon';
import './toasts.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export type ToastId = number | string;

/** Najviac toastov naraz (DESIGN_BRIEF / karta T03-09). */
export const MAX_TOASTS = 4;

export interface ToastData {
  readonly id: ToastId;
  readonly tone: ToastTone;
  /** Názov ikony zo spritu, s prefixom (`ic_warning`) aj bez neho (`warning`). */
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  /**
   * Voliteľná akcia (prototyp: „Zobraziť" → prepne panel; F3: „Ukázať" → centrovanie kamery). Bez nej sa odkaz
   * nezobrazí.
   */
  readonly onShow?: (id: ToastId) => void;
  /** Voliteľný popis akcie; predvolene `Zobraziť` (prototyp). */
  readonly showLabel?: string;
  readonly onClose: (id: ToastId) => void;
}

export interface ToastsProps {
  readonly toasts: readonly ToastData[];
}

/** Predvolený popis odkazu akcie (prototyp). */
export const TOAST_SHOW_LABEL = 'Zobraziť';

/** Prvých `MAX_TOASTS` toastov (poradie určuje rodič); ostatné čakajú vo fronte rodiča. */
export function visibleToasts(toasts: readonly ToastData[]): readonly ToastData[] {
  return toasts.slice(0, MAX_TOASTS);
}

export function Toasts({ toasts }: ToastsProps) {
  const shown = visibleToasts(toasts);
  if (shown.length === 0) return null;
  return (
    <div className="toasts" role="region" aria-label="Oznámenia" data-count={shown.length}>
      {shown.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role="status" data-toast-id={toast.id} data-tone={toast.tone}>
          <span className="toast__stripe" aria-hidden="true" />
          <Icon name={toIconName(toast.icon)} className="toast__icon" />
          <div className="toast__body">
            <span className="toast__title" data-field="toast-title">
              {toast.title}
            </span>
            <span className="toast__text" data-field="toast-text">
              {toast.text}
            </span>
            {toast.onShow !== undefined && (
              <button
                type="button"
                className="toast__action"
                data-action="show"
                onClick={() => {
                  toast.onShow?.(toast.id);
                }}
              >
                {toast.showLabel ?? TOAST_SHOW_LABEL}
              </button>
            )}
          </div>
          <button
            type="button"
            className="toast__close"
            title="Zavrieť"
            aria-label={`Zavrieť oznámenie: ${toast.title}`}
            data-action="close"
            onClick={() => {
              toast.onClose(toast.id);
            }}
          >
            <Icon name="ic_close" className="toast__close-icon" />
          </button>
        </div>
      ))}
    </div>
  );
}
