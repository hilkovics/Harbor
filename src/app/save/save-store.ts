/**
 * Úložisko slotov uloženej hry v `localStorage` (ADR-030 bod 3): kľúče `mh.save.auto`, `mh.save.1` … `mh.save.3`,
 * hodnota = JSON obálky `SaveGame`. Úložisko je injektovateľné (`StorageProvider`), takže testy podstrčia falošné
 * (plné, nedostupné, poškodené).
 *
 * Chyby: `save`, `load` a `remove` hlásia zlyhanie výlučne ako `StorageError` (nikdy surová výnimka prehliadača) —
 * `SaveController` ich prevádza na výsledok a toast, takže do UI nepadne výnimka. `list` nikdy nevyhodí:
 * nedostupné úložisko dá prázdny zoznam, poškodený slot sa vynechá (zobrazí sa ako prázdny a dá sa prepísať).
 */
import { SAVE_SLOT_IDS, decodeSave, type SaveGame, type SavePreview, type SaveSlotId } from './save-game';
import { StorageError, browserStorage, guardStorage, type StorageProvider } from './storage';

/** Predpona kľúča slotu v `localStorage`. */
export const SAVE_KEY_PREFIX = 'mh.save.';

export function saveKey(slot: SaveSlotId): string {
  return `${SAVE_KEY_PREFIX}${slot}`;
}

/** Obsadený slot v zozname: údaje z obálky bez sveta. */
export interface SaveSlotInfo {
  readonly slot: SaveSlotId;
  readonly label: string;
  readonly savedAtIso: string;
  readonly preview: SavePreview;
}

export interface SaveStore {
  /** Obsadené sloty v poradí `auto`, `1`, `2`, `3`; nikdy nevyhodí. */
  list(): SaveSlotInfo[];
  /** @throws StorageError `unavailable` / `quota` / `failed` */
  save(slot: SaveSlotId, save: SaveGame): void;
  /** `null` = slot je prázdny. @throws StorageError `unavailable` / `failed` / `corrupt` */
  load(slot: SaveSlotId): SaveGame | null;
  /** @throws StorageError `unavailable` / `failed` */
  remove(slot: SaveSlotId): void;
}

export function toSlotInfo(slot: SaveSlotId, save: SaveGame): SaveSlotInfo {
  return { slot, label: save.label, savedAtIso: save.savedAtIso, preview: save.preview };
}

/** Prečíta a overí obálku zo slotu; chybný JSON alebo obálka → `StorageError('corrupt')`. */
function parseSlot(slot: SaveSlotId, raw: string): SaveGame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorageError('corrupt', `slot ${slot} nie je platný JSON`, { cause: error });
  }
  try {
    return decodeSave(parsed);
  } catch (error) {
    throw new StorageError('corrupt', `slot ${slot} — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function createSaveStore(provider: StorageProvider = browserStorage): SaveStore {
  return {
    list() {
      const infos: SaveSlotInfo[] = [];
      for (const slot of SAVE_SLOT_IDS) {
        try {
          const raw = guardStorage(provider, (storage) => storage.getItem(saveKey(slot)));
          if (raw !== null) infos.push(toSlotInfo(slot, parseSlot(slot, raw)));
        } catch {
          // nedostupné úložisko alebo poškodený slot: slot sa v zozname nezobrazí
        }
      }
      return infos;
    },
    save(slot, save) {
      const text = JSON.stringify(save);
      guardStorage(provider, (storage) => {
        storage.setItem(saveKey(slot), text);
      });
    },
    load(slot) {
      const raw = guardStorage(provider, (storage) => storage.getItem(saveKey(slot)));
      return raw === null ? null : parseSlot(slot, raw);
    },
    remove(slot) {
      guardStorage(provider, (storage) => {
        storage.removeItem(saveKey(slot));
      });
    },
  };
}
