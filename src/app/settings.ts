/**
 * Nastavenia hry (ADR-030 bod 2): per-zariadenie, preto sa do savu neukladajú. `localStorage['mh.settings']` =
 * `{ settingsVersion: 1, defaultSpeed, autosaveEveryDays, sound }`.
 *
 * - `defaultSpeed` — rýchlosť, s ktorou sa spustí nová hra (0 = štart v pauze); rýchlosť rozohranej hry nesie save;
 * - `autosaveEveryDays` — každý N-tý uzavretý herný deň sa hra automaticky uloží do slotu `auto` (0 = vypnuté);
 * - `sound` — zvuk zatiaľ nie je (vždy `false`), pole je pripravené kvôli stabilnému tvaru.
 *
 * Načítanie je zhovievavé: chýbajúce, poškodené alebo neplatné hodnoty sa nahradia predvolenými (po poliach), nikdy
 * nevyhodí. Zápis hlási zlyhanie úložiska ako výsledok (`SettingsWriteResult`), nastavenia ostávajú v pamäti.
 */
import type { Settings } from '@ui/save-types';
import { StorageError, browserStorage, guardStorage, type StorageProvider } from './save/storage';

// Typ `Settings` je definovaný raz, v `@ui/save-types` (UI nesmie závisieť od app); tu sa len re-exportuje.
export type { Settings };

export const SETTINGS_KEY = 'mh.settings';
export const SETTINGS_VERSION = 1;

export type DefaultSpeed = Settings['defaultSpeed'];

/** Rýchlosti, ktoré možno zvoliť ako predvolené (zhodné s `time.speeds`; stráži to test). */
export const SETTINGS_SPEEDS: readonly DefaultSpeed[] = Object.freeze<DefaultSpeed[]>([0, 1, 2, 4, 8]);

/** Najdlhší interval automatického ukladania v dňoch. */
export const MAX_AUTOSAVE_EVERY_DAYS = 30;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  settingsVersion: SETTINGS_VERSION,
  defaultSpeed: 1,
  autosaveEveryDays: 1,
  sound: false,
});

function isDefaultSpeed(value: unknown): value is DefaultSpeed {
  return (SETTINGS_SPEEDS as readonly unknown[]).includes(value);
}

function isAutosaveInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_AUTOSAVE_EVERY_DAYS;
}

/**
 * Nastavenia z ľubovoľnej hodnoty: každé neplatné pole dostane predvolenú hodnotu; iná `settingsVersion` alebo
 * hodnota, ktorá nie je objekt, dá všetky predvolené. Vždy vráti nový platný objekt.
 */
export function normalizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_SETTINGS;
  const source = raw as Readonly<Record<string, unknown>>;
  if (source['settingsVersion'] !== SETTINGS_VERSION) return DEFAULT_SETTINGS;
  const { defaultSpeed, autosaveEveryDays } = source;
  return {
    settingsVersion: SETTINGS_VERSION,
    defaultSpeed: isDefaultSpeed(defaultSpeed) ? defaultSpeed : DEFAULT_SETTINGS.defaultSpeed,
    autosaveEveryDays: isAutosaveInterval(autosaveEveryDays) ? autosaveEveryDays : DEFAULT_SETTINGS.autosaveEveryDays,
    sound: false,
  };
}

/** Načíta nastavenia z úložiska; nedostupné úložisko, chýbajúci alebo poškodený záznam → predvolené. Nevyhodí. */
export function loadSettings(provider: StorageProvider = browserStorage): Settings {
  try {
    const raw = guardStorage(provider, (storage) => storage.getItem(SETTINGS_KEY));
    return raw === null ? DEFAULT_SETTINGS : normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** @throws StorageError `unavailable` / `quota` / `failed` */
export function saveSettings(settings: Settings, provider: StorageProvider = browserStorage): void {
  const text = JSON.stringify(settings);
  guardStorage(provider, (storage) => {
    storage.setItem(SETTINGS_KEY, text);
  });
}

export type SettingsWriteResult = { readonly ok: true } | { readonly ok: false; readonly error: StorageError };

/** Nastavenia v pamäti s priepisom do úložiska; zdieľa ich celá aplikácia (nová hra číta `defaultSpeed`, autosave interval). */
export interface SettingsStore {
  get(): Settings;
  /** Znormalizuje a uloží `next`. V pamäti platí aj vtedy, keď zápis do úložiska zlyhá (výsledok to oznámi). */
  set(next: Settings): SettingsWriteResult;
}

export function createSettingsStore(provider: StorageProvider = browserStorage): SettingsStore {
  let current = loadSettings(provider);
  return {
    get: () => current,
    set(next) {
      current = normalizeSettings(next);
      try {
        saveSettings(current, provider);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof StorageError ? error : new StorageError('failed', undefined, { cause: error }) };
      }
    },
  };
}
