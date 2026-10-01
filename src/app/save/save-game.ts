/**
 * SaveGame v1 — obálka uloženej hry v aplikačnej vrstve (ADR-030, ARCHITECTURE §14). Sim o nej nevie:
 * `{ format, saveVersion, gameVersion, savedAtIso, label, preview, world }`.
 *
 * - `version`, `seed` a `tick` žijú len vo `world` (`WorldState`), obálka ich nezdvojuje;
 * - `saveVersion` verzuje len obálku, tvar sveta verzuje `world.version` a prevádza ho `World.deserialize`
 *   (`migrateWorldState`) — obálka v1 teda môže niesť `world` v1 … aktuálnu verziu;
 * - `preview` je odvodený z `world` pri uložení a slúži len na zoznam slotov; pri načítaní sa ignoruje (neoveruje sa
 *   voči `world`, nie je druhým zdrojom pravdy);
 * - `savedAtIso` (reálny čas) a `gameVersion` (z `package.json`) dopĺňa aplikácia — sim reálny čas čítať nesmie.
 *
 * `decodeSave` overí len obálku (formát, verziu, prítomnosť sveta a typy polí). Obsah `world` overí až
 * `World.deserialize` (`WorldStateError` s JSON pointerom), takže poškodený svet sa nikdy nepoužije napoly.
 */
import type { World, WorldState } from '@sim/world';
import { formatGameTime } from '@ui/format';
import { GAME_VERSION } from '../config';

export const SAVE_FORMAT = 'modular-harbor-save';
export const SAVE_VERSION = 1;

/** Sloty úložiska: `auto` (automatické uloženie) a tri ručné. */
export type SaveSlotId = 'auto' | '1' | '2' | '3';

/** Všetky sloty v poradí zobrazenia. */
export const SAVE_SLOT_IDS: readonly SaveSlotId[] = Object.freeze<SaveSlotId[]>(['auto', '1', '2', '3']);

export function isSaveSlotId(value: unknown): value is SaveSlotId {
  return typeof value === 'string' && (SAVE_SLOT_IDS as readonly string[]).includes(value);
}

/** Odvodené údaje pre zoznam slotov. `day` je 0-based ako `WorldSnapshot.day`; `timeLabel` je text pre hráča (`Deň N · HH:MM`). */
export interface SavePreview {
  readonly day: number;
  readonly timeLabel: string;
  readonly cashCents: number;
  readonly xp: number;
}

export interface SaveGame {
  readonly format: typeof SAVE_FORMAT;
  readonly saveVersion: 1;
  readonly gameVersion: string;
  /** Reálny čas uloženia, ISO 8601. */
  readonly savedAtIso: string;
  readonly label: string;
  readonly preview: SavePreview;
  /** Stav sveta; môže byť aj staršej verzie, ktorú prevedie `World.deserialize`. */
  readonly world: WorldState;
}

/**
 * Dôvod odmietnutia savu: `not_object` (nie je JSON objekt), `format` (iný `format`), `version` (nepodporovaná
 * `saveVersion`), `world` (chýba stav sveta), `fields` (pole obálky s nesprávnym typom), `json` (text nie je platný
 * JSON), `too_large` (súbor je príliš veľký), `read` (súbor sa nepodarilo prečítať).
 */
export type SaveErrorReason = 'not_object' | 'format' | 'version' | 'world' | 'fields' | 'json' | 'too_large' | 'read';

export class SaveError extends Error {
  readonly reason: SaveErrorReason;

  constructor(reason: SaveErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SaveError';
    this.reason = reason;
  }
}

/**
 * Obálka z živého sveta. Fronta príkazov sveta musí byť prázdna (`World.serialize` inak vyhodí) — volajúci ju najprv
 * vyprázdni (`applyPending`, ADR-030 bod 1).
 */
export function encodeSave(world: World, label: string, nowIso: string): SaveGame {
  const state = world.serialize();
  const { clock } = world;
  return {
    format: SAVE_FORMAT,
    saveVersion: SAVE_VERSION,
    gameVersion: GAME_VERSION,
    savedAtIso: nowIso,
    label,
    preview: {
      day: clock.gameDay,
      timeLabel: formatGameTime({ day: clock.gameDay, hour: clock.hourOfDay, minute: clock.minuteOfHour }),
      cashCents: world.cashCents,
      xp: world.xp,
    },
    world: state,
  };
}

type JsonObject = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldError(path: string, expected: string): SaveError {
  return new SaveError('fields', `Uloženie je poškodené: pole ${path} musí byť ${expected}`);
}

function readString(source: JsonObject, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw fieldError(path, 'reťazec');
  return value;
}

function readNumber(source: JsonObject, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fieldError(path, 'konečné číslo');
  return value;
}

function decodePreview(raw: unknown): SavePreview {
  if (!isRecord(raw)) throw fieldError('/preview', 'objekt');
  return {
    day: readNumber(raw, 'day', '/preview/day'),
    timeLabel: readString(raw, 'timeLabel', '/preview/timeLabel'),
    cashCents: readNumber(raw, 'cashCents', '/preview/cashCents'),
    xp: readNumber(raw, 'xp', '/preview/xp'),
  };
}

/**
 * Overí obálku (nie svet). @throws SaveError `not_object` / `format` / `version` / `world` / `fields`
 */
export function decodeSave(raw: unknown): SaveGame {
  if (!isRecord(raw)) {
    throw new SaveError('not_object', 'Súbor neobsahuje uloženú hru (očakáva sa objekt JSON)');
  }
  if (raw['format'] !== SAVE_FORMAT) {
    throw new SaveError('format', `Nie je to uložená hra Modular Harbor (chýba format "${SAVE_FORMAT}")`);
  }
  const version = raw['saveVersion'];
  if (version !== SAVE_VERSION) {
    const shown = typeof version === 'number' || typeof version === 'string' ? String(version) : 'neznáma';
    throw new SaveError('version', `Nepodporovaná verzia uloženia (saveVersion ${shown}); táto verzia hry číta ${String(SAVE_VERSION)}`);
  }
  const world = raw['world'];
  if (!isRecord(world) || typeof world['version'] !== 'number') {
    throw new SaveError('world', 'Uloženiu chýba stav sveta (world)');
  }
  return {
    format: SAVE_FORMAT,
    saveVersion: SAVE_VERSION,
    gameVersion: readString(raw, 'gameVersion', '/gameVersion'),
    savedAtIso: readString(raw, 'savedAtIso', '/savedAtIso'),
    label: readString(raw, 'label', '/label'),
    preview: decodePreview(raw['preview']),
    // Tvar a obsah sveta overí `World.deserialize` (WorldStateError s cestou); tu je overená len prítomnosť objektu s verziou.
    world: world as unknown as WorldState,
  };
}
