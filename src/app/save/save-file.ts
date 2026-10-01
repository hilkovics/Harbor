/**
 * Export a import uloženej hry ako súboru `.json` (ADR-030 bod 3).
 *
 * - export = `Blob` + `<a download>` s názvom `modular-harbor-<deň>-<slot>.json` (deň ako ho vidí hráč, od 1);
 * - import = čítanie vybraného `File` → JSON → `decodeSave`. Chyba (nie je JSON, zlý formát, zlá verzia, príliš veľký
 *   súbor) je `SaveError` s textom pre hráča; obsah sveta overí až `World.deserialize` pri načítaní.
 *
 * Stiahnutie je injektovateľné (`FileDownloader`), takže sa dá testovať v Node bez DOM.
 */
import { SaveError, decodeSave, type SaveGame, type SaveSlotId } from './save-game';

export const SAVE_FILE_MIME = 'application/json';

const BYTES_PER_MIB = 1024 * 1024;

/** Najväčší súbor, ktorý import prijme (ochrana pred omylom — bežný save má rádovo stovky kB). */
export const MAX_IMPORT_BYTES = 32 * BYTES_PER_MIB;

/** Za ako dlho po kliku sa uvoľní URL `Blob`u (stiahnutie sa medzitým už začalo). */
const REVOKE_URL_DELAY_MS = 1000;

/** Časť názvu súboru za dňom: slot, z ktorého exportujeme, alebo `current` (aktuálna rozohraná hra). */
export type ExportSlotToken = SaveSlotId | 'current';

/** `modular-harbor-<deň>-<slot>.json`; `dayNumber` je deň od 1 (ako v HUD). */
export function saveFileName(dayNumber: number, slot: ExportSlotToken): string {
  return `modular-harbor-${String(dayNumber)}-${slot}.json`;
}

export interface FileDownloader {
  download(fileName: string, blob: Blob): void;
}

/** Stiahnutie cez dočasný odkaz `<a download>`. */
export const browserDownloader: FileDownloader = {
  download(fileName, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, REVOKE_URL_DELAY_MS);
  },
};

/** Stiahne obálku ako súbor. @returns názov súboru */
export function exportSaveFile(save: SaveGame, slot: ExportSlotToken, downloader: FileDownloader = browserDownloader): string {
  const fileName = saveFileName(save.preview.day + 1, slot);
  downloader.download(fileName, new Blob([JSON.stringify(save)], { type: SAVE_FILE_MIME }));
  return fileName;
}

/** Podmnožina `File`/`Blob`, ktorú import číta. */
export interface ReadableFile {
  readonly size: number;
  text(): Promise<string>;
}

/** Prečíta súbor a overí obálku. @throws SaveError `too_large` / `read` / `json` / `not_object` / `format` / `version` / `world` / `fields` */
export async function readSaveFile(file: ReadableFile): Promise<SaveGame> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new SaveError('too_large', `Súbor je príliš veľký (${String(Math.ceil(file.size / BYTES_PER_MIB))} MB)`);
  }
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    throw new SaveError('read', 'Súbor sa nepodarilo prečítať', { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SaveError('json', 'Súbor nie je platný JSON', { cause: error });
  }
  return decodeSave(parsed);
}
