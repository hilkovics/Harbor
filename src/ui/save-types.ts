/**
 * Typy ukladania — jediný zdroj pravdy (Fáza 6, T06-03b). UI (`SettingsPanel`, `SaveLoadPanel`) ich importuje odtiaľto
 * a aplikačná vrstva (`src/app/save/*.ts`, `src/app/settings.ts`) ich z `@ui/save-types` len importuje a re-exportuje
 * — smer závislosti je app → ui, nikdy opačne (UI nesmie závisieť od úložiska ani od simulácie). Jediný runtime obsah je
 * zoznam slotov, z ktorého je odvodený typ `SaveSlotId`.
 */

/** Sloty uloženia v poradí zobrazenia: automatický (autosave) a tri ručné. */
export const SAVE_SLOT_IDS = ['auto', '1', '2', '3'] as const;

/** Slot uloženia: automatický (autosave) a tri ručné. */
export type SaveSlotId = (typeof SAVE_SLOT_IDS)[number];

/**
 * Odvodené údaje pre zoznam slotov (pri načítaní sa ignorujú). Dvojica `day` + `timeLabel` je dátum a čas dňa zvlášť,
 * nie hotový popisok: UI z nich zloží `Deň N · HH:MM` (`formatDayAndClock`), rovnako ako HUD.
 */
export interface SavePreview {
  /** Herný deň, 0-based ako `SimClock.gameDay` a `WorldSnapshot.day` (hráč vidí `day + 1`). */
  readonly day: number;
  /** Čas dňa ako `HH:MM` (napr. `14:20`), bez dňa — ten nesie `day`. */
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
  /**
   * Save sveta inej verzie než aktuálnej (starý save, ADR-036): v zozname sa označí a jeho načítanie hru nezmení
   * (hláška o staršej verzii). Chýba = kompatibilný.
   */
  readonly incompatible?: boolean;
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
