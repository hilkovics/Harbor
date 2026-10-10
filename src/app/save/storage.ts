/**
 * Prístup k úložisku prehliadača pre ukladanie hry a nastavení (ADR-030 bod 3).
 *
 * `localStorage` môže byť nedostupné (súkromný režim, zakázané cookies → `SecurityError` už pri čítaní
 * `window.localStorage`), plné (`QuotaExceededError`) alebo inak zlyhať. Každý prístup preto ide cez `guardStorage`,
 * ktorý akúkoľvek chybu prevedie na `StorageError` s dôvodom a textom pre hráča — do UI nikdy nepadne surová výnimka
 * prehliadača a hra beží ďalej.
 *
 * Úložisko sa dodáva ako funkcia (`StorageProvider`), nie hodnota: samotné vyhodnotenie `window.localStorage` môže
 * vyhodiť, a test tak vie nahradiť úložisko falošným (plné, nedostupné).
 */

/** Podmnožina `Storage`, ktorú aplikácia používa. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Vráti úložisko, alebo vyhodí, ak nie je dostupné. */
export type StorageProvider = () => KeyValueStorage;

/** `window.localStorage`; vyhodnotenie môže vyhodiť (bez `window` v Node, `SecurityError`) — volajúci ide cez `guardStorage`. */
export const browserStorage: StorageProvider = () => window.localStorage;

/**
 * Dôvod zlyhania úložiska: `unavailable` (nie je dostupné), `quota` (plné), `corrupt` (obsah nie je platné uloženie),
 * `failed` (iná chyba pri čítaní alebo zápise).
 */
export type StorageErrorReason = 'unavailable' | 'quota' | 'corrupt' | 'failed';

const STORAGE_ERROR_TEXT: Readonly<Record<Exclude<StorageErrorReason, 'corrupt'>, string>> = Object.freeze({
  unavailable: 'Úložisko prehliadača nie je dostupné (súkromný režim alebo zakázané ukladanie)',
  quota: 'Úložisko prehliadača je plné — zmaž starší slot alebo hru exportuj do súboru',
  failed: 'Úložisko prehliadača zlyhalo',
});

export class StorageError extends Error {
  readonly reason: StorageErrorReason;

  /** @param detail doplnok za text dôvodu (napr. slot, ktorý je poškodený); `corrupt` ho vyžaduje. */
  constructor(reason: StorageErrorReason, detail?: string, options?: ErrorOptions) {
    const base = reason === 'corrupt' ? 'Uloženie je poškodené' : STORAGE_ERROR_TEXT[reason];
    super(detail === undefined || detail === '' ? base : `${base}: ${detail}`, options);
    this.name = 'StorageError';
    this.reason = reason;
  }
}

/** Mená výnimiek prehliadačov pri prekročení kvóty (Chromium/WebKit `QuotaExceededError`, Firefox `NS_ERROR_DOM_QUOTA_REACHED`). */
const QUOTA_ERROR_NAMES: ReadonlySet<string> = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name } = error as { readonly name?: unknown };
  return typeof name === 'string' && QUOTA_ERROR_NAMES.has(name);
}

/**
 * Vykoná `action` nad úložiskom; zlyhanie získania úložiska → `StorageError('unavailable')`, výnimka z `action`
 * (kvóta → `quota`, inak `failed`). `StorageError` z `action` sa prepúšťa nezmenený.
 */
export function guardStorage<T>(provider: StorageProvider, action: (storage: KeyValueStorage) => T): T {
  let storage: KeyValueStorage;
  try {
    storage = provider();
  } catch (error) {
    throw new StorageError('unavailable', undefined, { cause: error });
  }
  try {
    return action(storage);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(isQuotaError(error) ? 'quota' : 'failed', undefined, { cause: error });
  }
}
