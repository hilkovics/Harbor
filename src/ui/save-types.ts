/**
 * Typy ukladania pre UI (Fáza 6, T06-04). Zrkadlia „Spoločné rozhrania" z docs/tasks/phase-06.md presne, pretože
 * `src/app/save/save-game.ts`, `src/app/save/save-store.ts` a `src/app/settings.ts` vznikajú paralelne (T06-03).
 * UI importuje typy len odtiaľto; po zlúčení karty ich orchestrátor zjednotí (re-export z `@app/…` alebo naopak),
 * zmena je len v tomto jednom súbore. Žiadny runtime kód — UI nesmie závisieť od úložiska ani od simulácie.
 */

/** Slot uloženia: automatický (autosave) a tri ručné. */
export type SaveSlotId = 'auto' | '1' | '2' | '3';

/** Odvodené údaje pre zoznam slotov (pri načítaní sa ignorujú). */
export interface SavePreview {
  /** Herný deň, 0-based ako `WorldSnapshot.day` (hráč vidí `day + 1`). */
  readonly day: number;
  /** Čas dňa ako text, napr. `14:20`. */
  readonly timeLabel: string;
  readonly cashCents: number;
  readonly xp: number;
}

/** Jeden obsadený slot v zozname (prázdne sloty v zozname nie sú). */
export interface SaveSlotInfo {
  readonly slot: SaveSlotId;
  readonly label: string;
  /** Čas uloženia, ISO 8601 (UTC). */
  readonly savedAtIso: string;
  readonly preview: SavePreview;
}

/** Nastavenia na zariadení (neukladajú sa do savu). */
export interface Settings {
  readonly settingsVersion: 1;
  /** Rýchlosť po štarte hry (0 = pauza). */
  readonly defaultSpeed: 0 | 1 | 2 | 4 | 8;
  /** Autosave každých N herných dní; 0 = vypnuté. */
  readonly autosaveEveryDays: number;
  readonly sound: false;
}
