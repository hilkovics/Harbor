/**
 * Prístup k spritom modulov, lodí, vozidiel a nákladu podľa `assets/manifest.json` (DESIGN_BRIEF §5.3–§5.7).
 *
 * Názvy súborov, footprinty, apron sloty, konektory a pivoty častí žeriava sa nepíšu do kódu: berú sa z manifestu
 * (`sprites.<defId>`, `entities.ship_<classId>`, `entities.<vehicleDefId>`, `cargo.<typeId>`). Id definície modulu /
 * triedy lode / vozidla / typu nákladu je zhodné s kľúčom v manifeste (konvencia `conventions.fileNames`), takže nový
 * modul = nový záznam v manifeste bez zásahu do kódu. Súradnice `pivot`, `mountOnBase` a `travel` sú v px zdrojového
 * SVG (`cellPx` z manifestu), preto `manifestScale` prepočíta na aktuálnu veľkosť bunky (`--cell`).
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

/** Obdĺžnik v px zdrojového SVG (ľavý horný roh a rozmer): stojisko čakacej plochy, dok rampy. */
export interface ManifestRect extends ManifestPoint {
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
  /** Kam sa ľavý horný roh súboru časti kladie na základni (px od ľavého horného rohu footprintu; závora brány). */
  readonly offset?: ManifestPoint;
  /** Uhol časti v stupňoch (v smere hodinových ručičiek) v zatvorenej polohe; závora brány. */
  readonly closedDeg?: number;
  /** Uhol časti v stupňoch v otvorenej polohe; závora brány (záporný = proti smeru hodinových ručičiek). */
  readonly openDeg?: number;
}

/** Záznam modulu v `sprites.<defId>`. */
export interface ModuleSpriteEntry {
  readonly footprint: CellSize;
  /** Jediný sprite modulu; moduly zložené z častí (`parts`) alebo so stavmi (`states`) ho nemajú. */
  readonly file?: string;
  /** Sprity podľa stavu (sklady: `fill00…fill100`, viď `storage-fill.ts`): kľúč stavu → súbor. */
  readonly states?: Readonly<Record<string, string>>;
  /** Apron sloty berthu: bunky footprintu pri rot 0 (poradie = index `slot`). */
  readonly apronSlots?: readonly ManifestPoint[];
  readonly parts?: Readonly<Record<string, ManifestPart>>;
  /** Stojiská čakacej plochy: obdĺžniky pri rot 0 v px súboru (poradie = index `waitingArea.occupied`). */
  readonly stalls?: readonly ManifestRect[];
  /** Doky nakladacej rampy: obdĺžniky pri rot 0 v px súboru (poradie = index `ramp.staged`). */
  readonly docks?: readonly ManifestRect[];
  /** Kategória nákladu rampy (`container`, `bulk`, …); určuje typ nákladu pripraveného na doku. */
  readonly category?: string;
  readonly connectors: readonly ManifestConnector[];
}

/** Sprity lode v `entities.ship_<classId>`: footprint (`w` = šírka, `h` = dĺžka) a varianty paluby. */
export interface ShipSpriteEntry {
  readonly footprint: CellSize;
  readonly variants: Readonly<Record<string, { readonly empty: string; readonly loaded: string }>>;
}

/** Sprity vozidla v `entities.<defId>`: footprint (`w` = šírka, `h` = dĺžka, predok hore) a stavy `empty` / `loaded`. */
export interface VehicleSpriteEntry {
  readonly footprint: CellSize;
  readonly states: { readonly empty: string; readonly loaded: string };
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
const VEHICLE_SPRITES = entitiesManifest as unknown as Readonly<Record<string, Partial<VehicleSpriteEntry>>>;
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

/**
 * Záznam vozidla `defId` (`entities.<defId>` so stavmi `empty` / `loaded`), alebo `undefined`. Lode (`ship_*`) majú
 * `variants`, nie `states`, takže nie sú vozidlá.
 */
export function vehicleSprite(defId: string): VehicleSpriteEntry | undefined {
  const entry = lookup(VEHICLE_SPRITES, defId);
  if (entry?.footprint === undefined || entry.states === undefined) return undefined;
  return { footprint: entry.footprint, states: entry.states };
}

/** Záznam nákladu typu `typeId` (`cargo.<typeId>`), alebo `undefined`. */
export function cargoSpriteEntry(typeId: string): CargoSpriteEntry | undefined {
  return lookup(CARGO_SPRITES, typeId);
}

/** Rozmer bunky `badge` (`overlay.blocked_badge.size`) v px zdroja. */
export const BLOCKED_BADGE_SIZE: CellSize = overlayManifest.blocked_badge.size;

/** Súbor `overlay.blocked_badge` (cesta relatívne k `assets/`). */
export const BLOCKED_BADGE_FILE: string = overlayManifest.blocked_badge.file;

/** Rozmer odznaku `overlay.warning_badge` („nepripojené“) v px zdroja. */
export const WARNING_BADGE_SIZE: CellSize = overlayManifest.warning_badge.size;

/** Súbor `overlay.warning_badge` (cesta relatívne k `assets/`). */
export const WARNING_BADGE_FILE: string = overlayManifest.warning_badge.file;

/** Rozmer odznaku `overlay.queue_badge` (fronta pred bránou) v px zdroja; stred kruhu je v strede súboru. */
export const QUEUE_BADGE_SIZE: CellSize = overlayManifest.queue_badge.size;

/** Súbor `overlay.queue_badge` (cesta relatívne k `assets/`). */
export const QUEUE_BADGE_FILE: string = overlayManifest.queue_badge.file;

/** Typ nákladu pre neznámu kategóriu: kontajner. */
const DEFAULT_CARGO_TYPE = 'container_teu';

/** Typ nákladu (`cargo.<typeId>`) pre kategóriu nákladu — čo sa kreslí na doku rampy danej kategórie. */
const CARGO_TYPE_OF_CATEGORY: Readonly<Record<string, string>> = {
  container: DEFAULT_CARGO_TYPE,
  bulk: 'bulk_pile',
  liquid: 'liquid_batch',
  gas: 'gas_batch',
  roro: 'car',
};

/** Typ nákladu pre kategóriu; neznáma alebo chýbajúca kategória → kontajner (`container_teu`). */
export function cargoTypeOfCategory(category: string | undefined): string {
  return (category === undefined ? undefined : lookup(CARGO_TYPE_OF_CATEGORY, category)) ?? DEFAULT_CARGO_TYPE;
}

/**
 * Varianty lodí, ktorých sprity sa načítajú do atlasu. Načítanie všetkých (5 kategórií × 4 triedy × 2 stavy)
 * by rasterizovalo desiatky MB textúr, ktoré F2 nepoužije; vo F2 sa vozia iba kontajnery. S ďalšou kategóriou nákladu
 * (bulk, liquid…) pribudne jej variant sem.
 */
export const LOADED_SHIP_VARIANTS: readonly string[] = ['container'];

/**
 * Moduly so stavmi (`states`), ktorých sprity sa načítajú do atlasu. Sklady majú po päť SVG (`fill00…fill100`);
 * `container_yard_large` (8×8, 5 stavov) by pri rasterizácii 128 px na bunku zabral desiatky MB, ktoré F3 nepoužije,
 * preto sa berie iba to, čo sa dá postaviť. S novým skladom (silo, nádrže…) pribudne jeho id sem.
 */
export const LOADED_STATE_MODULES: readonly string[] = ['container_yard_small'];

/**
 * Vozidlá a kamióny, ktorých sprity (`states.empty`, `states.loaded`) sa načítajú do atlasu — `straddle_carrier` (F3)
 * a `truck_container` (F4). Ostatné (AGV, vysokozdvižný vozík, ďalšie kamióny, vlaky) pribudnú so svojimi fázami;
 * do vtedy nakreslí `VehicleView` fallback z tokenov.
 */
export const LOADED_VEHICLES: readonly string[] = ['straddle_carrier', 'truck_container'];

/**
 * Súbory (relatívne k `assets/`), ktoré atlas načíta pre entity sveta: sprity modulov (`file` a `parts.*.file`),
 * stavy skladov z `LOADED_STATE_MODULES`, varianty lodí z `LOADED_SHIP_VARIANTS`, vozidlá z `LOADED_VEHICLES`,
 * všetok náklad a odznaky (zablokovania, nepripojené, fronta). Bez duplicít, v poradí manifestu.
 */
export function entitySpriteFiles(): string[] {
  const files = new Set<string>();
  for (const entry of Object.values(MODULE_SPRITES)) {
    if (entry.file !== undefined) files.add(entry.file);
    for (const part of Object.values(entry.parts ?? {})) files.add(part.file);
  }
  for (const defId of LOADED_STATE_MODULES) {
    for (const file of Object.values(moduleSprite(defId)?.states ?? {})) files.add(file);
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
  for (const defId of LOADED_VEHICLES) {
    const entry = vehicleSprite(defId);
    if (entry !== undefined) {
      files.add(entry.states.empty);
      files.add(entry.states.loaded);
    }
  }
  for (const entry of Object.values(CARGO_SPRITES)) files.add(entry.file);
  files.add(BLOCKED_BADGE_FILE);
  files.add(WARNING_BADGE_FILE);
  files.add(QUEUE_BADGE_FILE);
  return [...files];
}
