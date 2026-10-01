/**
 * SettingsPanel (T06-04; rozloženie z prototypu design/ui/game-ui.source.html, overlay `settings`): dialóg „Nastavenia"
 * so skupinami riadkov (názov vľavo, segmentovaný výber vpravo) a pätou Zrušiť / Uložiť.
 *
 * Skupiny: Hra (predvolená rýchlosť 1×–8×, automatické ukladanie Vypnuté / každý deň / každé 3 dni / každý týždeň)
 * a Zvuk (zatiaľ nedostupný: neaktívny prepínač s poznámkou; `Settings.sound` je vždy `false`).
 *
 * Čistý komponent s props (žiadny `useSimSnapshot`, žiadne úložisko): úpravy sa držia v lokálnom koncepte (`draft`),
 * `Uložiť` zavolá `onChange(draft)` (len ak sa niečo zmenilo) a potom `onClose()`; `Zrušiť`, ✕ a Esc zavolajú len
 * `onClose()` a koncept zahodia. `SettingsPanelView` je bez hookov (testovateľný bez DOM), `SettingsPanel` k nemu pridáva stav.
 */
import { useState, type ReactElement } from 'react';
import { formatSpeed } from './format';
import { ModalDialog } from './modal-dialog';
import type { Settings } from './save-types';
import './settings-panel.css';

type DefaultSpeed = Settings['defaultSpeed'];

/** Ponúkané predvolené rýchlosti (pauza sa ako štartovná rýchlosť nevolí). */
export const DEFAULT_SPEED_OPTIONS: readonly DefaultSpeed[] = [1, 2, 4, 8];

/** Možnosti automatického ukladania: počet herných dní (0 = vypnuté) a popisok. */
export const AUTOSAVE_OPTIONS: ReadonlyArray<{ readonly days: number; readonly label: string }> = [
  { days: 0, label: 'Vypnuté' },
  { days: 1, label: 'Každý deň' },
  { days: 3, label: 'Každé 3 dni' },
  { days: 7, label: 'Každý týždeň' },
];

/** Poznámka pri zvuku, kým nie je implementovaný. */
export const SOUND_NOTE = 'Zvuk zatiaľ nie je dostupný — pribudne v ďalšej verzii.';

export function withDefaultSpeed(settings: Settings, speed: DefaultSpeed): Settings {
  return { ...settings, defaultSpeed: speed };
}

export function withAutosave(settings: Settings, days: number): Settings {
  return { ...settings, autosaveEveryDays: days };
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return a.settingsVersion === b.settingsVersion && a.defaultSpeed === b.defaultSpeed && a.autosaveEveryDays === b.autosaveEveryDays && a.sound === b.sound;
}

/** `Uložiť`: odovzdá koncept rodičovi len ak sa líši od uložených nastavení, potom vždy zavrie dialóg. */
export function commitSettings(draft: Settings, saved: Settings, onChange: (settings: Settings) => void, onClose: () => void): void {
  if (!settingsEqual(draft, saved)) onChange(draft);
  onClose();
}

interface SegmentOption<T extends number> {
  readonly value: T;
  readonly label: string;
}

/**
 * Segmentovaná skupina tlačidiel (`aria-pressed`). Je to obyčajná funkcia vracajúca element, nie komponent — strom
 * ostáva plochý a testy ho prejdú bez DOM.
 */
function renderSegmented<T extends number>(
  labelledBy: string,
  field: string,
  options: readonly SegmentOption<T>[],
  selected: number,
  onSelect: (value: T) => void,
): ReactElement {
  return (
    <div className="segmented" role="group" aria-labelledby={labelledBy} data-field={field}>
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? 'segmented__btn segmented__btn--active' : 'segmented__btn'}
            aria-pressed={active}
            data-value={option.value}
            onClick={() => {
              onSelect(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface SettingsPanelViewProps {
  /** Rozpracovaný koncept (zobrazené hodnoty). */
  readonly draft: Settings;
  readonly onDraftChange: (next: Settings) => void;
  /** `Uložiť`: odovzdá koncept rodičovi a zavrie dialóg. */
  readonly onSave: () => void;
  /** `Zrušiť`, ✕, Esc. */
  readonly onCancel: () => void;
}

export function SettingsPanelView({ draft, onDraftChange, onSave, onCancel }: SettingsPanelViewProps) {
  const speedOptions = DEFAULT_SPEED_OPTIONS.map((speed) => ({ value: speed, label: formatSpeed(speed) }));
  const autosaveOptions = AUTOSAVE_OPTIONS.map((option) => ({ value: option.days, label: option.label }));
  return (
    <ModalDialog label="Nastavenia" title="Nastavenia" onClose={onCancel} className="settings-panel" dialogId="settings">
      <div className="modal-dialog__body">
        <div className="settings-group" data-group="game">
          <h3 className="settings-group__title">Hra</h3>
          <div className="settings-row">
            <div className="settings-row__text">
              <span className="settings-row__label" id="settings-label-speed">
                Predvolená rýchlosť
              </span>
              <span className="settings-row__hint">Rýchlosť po štarte hry; po načítaní uloženej hry ostáva pauza.</span>
            </div>
            {renderSegmented('settings-label-speed', 'default-speed', speedOptions, draft.defaultSpeed, (value) => {
              onDraftChange(withDefaultSpeed(draft, value));
            })}
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <span className="settings-row__label" id="settings-label-autosave">
                Automatické ukladanie
              </span>
              <span className="settings-row__hint">Zapisuje po skončení herného dňa.</span>
            </div>
            {renderSegmented('settings-label-autosave', 'autosave', autosaveOptions, draft.autosaveEveryDays, (value) => {
              onDraftChange(withAutosave(draft, value));
            })}
          </div>
        </div>
        <div className="settings-group" data-group="sound">
          <h3 className="settings-group__title">Zvuk</h3>
          <div className="settings-row">
            <div className="settings-row__text">
              <span className="settings-row__label" id="settings-label-sound">
                Zvuk zapnutý
              </span>
              <span className="settings-row__hint" id="settings-note-sound" data-field="sound-note">
                {SOUND_NOTE}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              className="toggle"
              aria-checked={false}
              aria-labelledby="settings-label-sound"
              aria-describedby="settings-note-sound"
              data-field="sound"
              disabled
            >
              <span className="toggle__knob" />
            </button>
          </div>
        </div>
      </div>
      <div className="modal-dialog__footer">
        <button type="button" className="modal-btn" data-action="cancel" onClick={onCancel}>
          Zrušiť
        </button>
        <button type="button" className="modal-btn modal-btn--primary" data-action="save" onClick={onSave}>
          Uložiť
        </button>
      </div>
    </ModalDialog>
  );
}

export interface SettingsPanelProps {
  /** Uložené nastavenia; slúžia ako východisko konceptu pri otvorení. */
  readonly settings: Settings;
  /** Volá sa pri `Uložiť` s novými nastaveniami (nevolá sa, ak sa nič nezmenilo). */
  readonly onChange: (settings: Settings) => void;
  readonly onClose: () => void;
}

export function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const [draft, setDraft] = useState<Settings>(settings);
  const onSave = (): void => {
    commitSettings(draft, settings, onChange, onClose);
  };
  return <SettingsPanelView draft={draft} onDraftChange={setDraft} onSave={onSave} onCancel={onClose} />;
}
