/**
 * Prístup k spritom modulov, lodí a nákladu podľa `assets/manifest.json` (DESIGN_BRIEF §5.3, §5.6, §5.7).
 *
 * Názvy súborov, footprinty, apron sloty, konektory a pivoty častí žeriava sa nepíšu do kódu: berú sa z manifestu
 * (`sprites.<defId>`, `entities.ship_<classId>`, `cargo.<typeId>`). Id definície modulu / triedy lode / typu nákladu
 * je zhodné s kľúčom v manifeste (konvencia `conventions.fileNames`), takže nový modul = nový záznam v manifeste bez
 * zásahu do kódu. Súradnice `pivot`, `mountOnBase` a `travel` sú v px zdrojového SVG (`cellPx` z manifestu), preto
 * `manifestScale` prepočíta na aktuálnu veľkosť bunky (`--cell`).
 */
import {
  cargo as cargoManifest,
  cellPx as manifestCellPx,
  entities as entitiesManifest,
  overlay as overlayManifest,
  sprites as spritesManifest,
} from '../../assets/manifest.json';
import type { ViewSide } from './view-models';

/** Bod v px zdrojového SVG (alebo v bunkách footprintu — podľa poľa). */
export interface ManifestPoint {
  readonly x: number;
  readonly y: number;
}

/** Rozmer v bunkách. */
export interface CellSize {
  readonly w: number;
  readonly h: number;
}

/** Konektor modulu: bunka footprintu pri rot 0, strana vjazdu a typ prepojenia. */
export interface ManifestConnector extends ManifestPoint {
  readonly side: ViewSide;
  readonly type: 'road' | 'rail' | 'pipe';
}

/** Pohyblivá časť žeriava (`base`, `boom`, `trolley`…): súbor a — ak ide o otočnú/posuvnú časť — pivot a montáž. */
export interface ManifestPart {
  readonly file: string;
  /** Rozmer časti v bunkách (chýba pri `base`, ktorý má footprint celého modulu). */
  readonly footprint?: CellSize;
  /** Pivot v px súboru (bod, okolo ktorého sa časť otáča / ktorým sa kladie). */
  readonly pivot?: ManifestPoint;
  /** Kam sa pivot časti kladie na základni (px od ľavého horného rohu footprintu modulu). */
  readonly mountOnBase?: ManifestPoint;
  /** Posun po osi výložníka: os a rozsah `y` pivotu v súradniciach súboru výložníka (px). */
  readonly travel?: { readonly axis: string; readonly yMin: number; readonly yMax: number };
}

/** Záznam modulu v `sprites.<defId>`. */
export interface ModuleSpriteEntry {
  readonly footprint: CellSize;
  /** Jediný sprite modulu; moduly zložené z častí (`parts`) alebo so stavmi (`states`) ho nemajú. */
  readonly file?: string;
  /** Apron sloty berthu: bunky footprintu pri rot 0 (poradie = index `slot`). */
  readonly apronSlots?: readonly ManifestPoint[];
  readonly parts?: Readonly<Record<string, ManifestPart>>;
  readonly connectors: readonly ManifestConnector[];
}

/** Sprity lode v `entities.ship_<classId>`: footprint (`w` = šírka, `h` = dĺžka) a varianty paluby. */
export interface ShipSpriteEntry {
  readonly footprint: CellSize;
  readonly variants: Readonly<Record<string, { readonly empty: string; readonly loaded: string }>>;
}

/** Sprite nákladu v `cargo.<typeId>`: rozmer v px zdrojového SVG. */
export interface CargoSpriteEntry {
  readonly size: CellSize;
  readonly file: string;
}

/** Veľkosť bunky v px, v ktorej sú nakreslené sprity manifestu (`cellPx`). */
export const MANIFEST_CELL_PX: number = manifestCellPx;

const MODULE_SPRITES = spritesManifest as unknown as Readonly<Record<string, ModuleSpriteEntry>>;
const SHIP_SPRITES = entitiesManifest as unknown as Readonly<Record<string, ShipSpriteEntry>>;
const CARGO_SPRITES = cargoManifest as unknown as Readonly<Record<string, CargoSpriteEntry>>;

/** Prefix záznamov lodí v `entities` (`ship_feeder`, `ship_handy`, …). */
const SHIP_ENTRY_PREFIX = 'ship_';

function lookup<T>(record: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/** Koeficient px zdroja → px sveta: `cellPx` (token `--cell`) / `cellPx` manifestu. */
export function manifestScale(cellPx: number): number {
  return cellPx / MANIFEST_CELL_PX;
}

/** Záznam modulu `defId` v manifeste, alebo `undefined` (modul bez nakresleného spritu → fallback `Graphics`). */
export function moduleSprite(defId: string): ModuleSpriteEntry | undefined {
  return lookup(MODULE_SPRITES, defId);
}

/** Záznam lode triedy `classId` (`entities.ship_<classId>`), alebo `undefined`. */
export function shipSprite(classId: string): ShipSpriteEntry | undefined {
  return lookup(SHIP_SPRITES, `${SHIP_ENTRY_PREFIX}${classId}`);
}

/** Záznam nákladu typu `typeId` (`cargo.<typeId>`), alebo `undefined`. */
export function cargoSpriteEntry(typeId: string): CargoSpriteEntry | undefined {
  return lookup(CARGO_SPRITES, typeId);
}

/** Rozmer bunky `badge` (`overlay.blocked_badge.size`) v px zdroja. */
export const BLOCKED_BADGE_SIZE: CellSize = overlayManifest.blocked_badge.size;

/** Súbor `overlay.blocked_badge` (cesta relatívne k `assets/`). */
export const BLOCKED_BADGE_FILE: string = overlayManifest.blocked_badge.file;

/**
 * Varianty lodí, ktorých sprity sa načítajú do atlasu. Načítanie všetkých (5 kategórií × 4 triedy × 2 stavy)
 * by rasterizovalo desiatky MB textúr, ktoré F2 nepoužije; vo F2 sa vozia iba kontajnery. S ďalšou kategóriou nákladu
 * (bulk, liquid…) pribudne jej variant sem.
 */
export const LOADED_SHIP_VARIANTS: readonly string[] = ['container'];

/**
 * Súbory (relatívne k `assets/`), ktoré atlas načíta pre entity sveta: sprity modulov (`file` a `parts.*.file`;
 * sklady so `states` prídu s F3), varianty lodí z `LOADED_SHIP_VARIANTS`, všetok náklad a odznak zablokovania.
 * Bez duplicít, v poradí manifestu.
 */
export function entitySpriteFiles(): string[] {
  const files = new Set<string>();
  for (const entry of Object.values(MODULE_SPRITES)) {
    if (entry.file !== undefined) files.add(entry.file);
    for (const part of Object.values(entry.parts ?? {})) files.add(part.file);
  }
  for (const [id, entry] of Object.entries(SHIP_SPRITES)) {
    if (!id.startsWith(SHIP_ENTRY_PREFIX)) continue;
    for (const variant of LOADED_SHIP_VARIANTS) {
      const pair = lookup(entry.variants, variant);
      if (pair !== undefined) {
        files.add(pair.empty);
        files.add(pair.loaded);
      }
    }
  }
  for (const entry of Object.values(CARGO_SPRITES)) files.add(entry.file);
  files.add(BLOCKED_BADGE_FILE);
  return [...files];
}
