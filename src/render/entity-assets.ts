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
import { TEU_PX } from './world-scale';

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
  /** Sklady: počet stohových pozícií na jednej vrstve (`slots`) a počet vrstiev (`layers`); kapacita = `slots × layers`. */
  readonly slots?: number;
  readonly layers?: number;
  readonly connectors: readonly ManifestConnector[];
}

/**
 * Paluba kontajnerovej lode (`entities.ship_<classId>.deck`, F6a): `bays` sú polia paluby od predku k zadku (obdĺžniky v px
 * súboru pri rot 0, rovnaké ako šedé polia v sprite `empty`), `columns` je počet kontajnerov naprieč lodou v jednom poli.
 */
export interface ShipDeckEntry {
  readonly columns: number;
  readonly bays: readonly ManifestRect[];
}

/** Sprity lode v `entities.ship_<classId>`: footprint (`w` = šírka, `h` = dĺžka), varianty paluby a (kontajnerové lode) polia paluby. */
export interface ShipSpriteEntry {
  readonly footprint: CellSize;
  readonly variants: Readonly<Record<string, { readonly empty: string; readonly loaded: string }>>;
  readonly deck?: ShipDeckEntry;
}

/**
 * Sprity vozidla v `entities.<defId>`: footprint (`w` = šírka, `h` = dĺžka, predok hore) a stavy `empty` / `loaded`; F6c: voliteľný stav
 * `carries_empty` = vozidlo vezie prázdny (sivý) kontajner (`direction: 'empty'`), bez neho sa použije `loaded`.
 */
export interface VehicleSpriteEntry {
  readonly footprint: CellSize;
  readonly states: { readonly empty: string; readonly loaded: string; readonly carries_empty?: string };
}

/** Časť kĺbového vozidla (`entities.<defId>.parts.<partId>`): súbor, rozmer v bunkách a pivot (kĺb) v px súboru. */
export interface ArticulatedPart {
  readonly file: string;
  readonly footprint: CellSize;
  readonly pivot: ManifestPoint;
}

/**
 * Kĺbové vozidlo v `entities.<defId>` (R1, kamión): `cab` (pivot = točnica) a `trailer` (pivot = čap), `footprint` je celková dĺžka v bunkách
 * (3 = `lengthCells`). Kabína stojí na hlave, náves visí za čapom na točnici a sleduje stopu.
 */
export interface ArticulatedSpriteEntry {
  readonly footprint: CellSize;
  readonly cab: ArticulatedPart;
  readonly trailer: ArticulatedPart;
}

/** Prekryv brzdových svetiel (`entities.vehicle_brake_lights`): súbor a rozmer v bunkách (svetlá sú pri spodnom okraji). */
export interface BrakeLightsEntry {
  readonly file: string;
  readonly footprint: CellSize;
}

/** Sprite nákladu v `cargo.<typeId>`: rozmer v px zdrojového SVG; `tintable` = neutrálny sprite, ktorý hra tónuje farbou linky (R2: `container_<size>_dry`). */
export interface CargoSpriteEntry {
  readonly size: CellSize;
  readonly file: string;
  readonly tintable?: boolean;
}

/**
 * Spreader vozidla v `entities.<defId>` (R2, ECH): `mount` = bod v px súboru vozidla (`spreaderMount`), v ktorom visí spreader s kontajnerom; `footprint` je
 * rozmer plátna vozidla (bunky); `spreader20` / `spreader40` sú časti `parts.spreader_20` / `spreader_40` (pivot = `mount`).
 */
export interface VehicleSpreaderEntry {
  readonly mount: ManifestPoint;
  readonly footprint: CellSize;
  readonly spreader20: ArticulatedPart;
  readonly spreader40: ArticulatedPart;
}

/** Časť STS žeriavu (R3): súbor, rozmer v bunkách a pivot v px súboru. */
export interface StsPart {
  readonly file: string;
  readonly footprint: CellSize;
  readonly pivot: ManifestPoint;
}

/**
 * STS žeriav (R3, `sprites.<defId>.parts`: `frame`, `trolley`, `spreader_20`, `spreader_40`): rám je statický (footprint celého modulu, pivot v px
 * súboru), vozík jazdí po osi Y rámu v rozsahu `travelY` (súradnice rámu, px) a spreader (pivot = pivot vozíka) visí pod ním.
 */
export interface StsEntry {
  readonly footprint: CellSize;
  readonly frame: StsPart;
  readonly trolley: StsPart;
  readonly travelY: { readonly yMin: number; readonly yMax: number };
  readonly spreader20: StsPart;
  readonly spreader40: StsPart;
}

/** RTG (R3, `entities.rtg`): rám (pivot = stred rámu, jazdí po Y) a vozík (jazdí po X rámu v rozsahu `travelX`, px rámu; stred vozíka). */
export interface MachineSpriteEntry {
  readonly footprint: CellSize;
  readonly frame: StsPart;
  readonly trolley: StsPart;
  readonly travelX: { readonly yMin: number; readonly yMax: number };
}

/** Veľkosť bunky v px, v ktorej sú nakreslené sprity manifestu (`cellPx`). */
export const MANIFEST_CELL_PX: number = manifestCellPx;

const MODULE_SPRITES = spritesManifest as unknown as Readonly<Record<string, ModuleSpriteEntry>>;
const SHIP_SPRITES = entitiesManifest as unknown as Readonly<Record<string, ShipSpriteEntry>>;
const VEHICLE_SPRITES = entitiesManifest as unknown as Readonly<
  Record<string, Partial<VehicleSpriteEntry> & { readonly file?: string; readonly parts?: Readonly<Record<string, ArticulatedPart>>; readonly spreaderMount?: ManifestPoint }>
>;
const MACHINE_SPRITES = entitiesManifest as unknown as Readonly<
  Record<string, { readonly footprint?: CellSize; readonly parts?: Readonly<Record<string, Partial<StsPart> & { readonly travel?: { readonly yMin: number; readonly yMax: number } }>> }>
>;
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

/**
 * Počet miest státia depa vozidiel (`sprites.<defId>.stalls` ako číslo, napr. `vehicle_depot` = 10), alebo `undefined`: modul bez
 * záznamu a čakacia plocha (kde `stalls` je pole obdĺžnikov) ho nemajú.
 */
export function parkingStalls(defId: string): number | undefined {
  const stalls: unknown = moduleSprite(defId)?.stalls;
  return typeof stalls === 'number' ? stalls : undefined;
}

/** Id záznamu STS v `sprites`: každé `sts*` id modulu žeriavu sa kreslí z neho. */
export const STS_ENTRY_ID = 'sts';

function stsPart(part: (Partial<StsPart> & { readonly file?: string }) | undefined): StsPart | undefined {
  if (part?.file === undefined || part.footprint === undefined || part.pivot === undefined) return undefined;
  return { file: part.file, footprint: part.footprint, pivot: part.pivot };
}

/** STS žeriav `defId` (`sprites.<defId>.parts.frame` + `trolley` s `travel` + `spreader_20` / `spreader_40`), alebo `undefined` (starý žeriav s výložníkom). */
export function stsSprite(defId: string): StsEntry | undefined {
  const entry = moduleSprite(defId.startsWith(STS_ENTRY_ID) ? STS_ENTRY_ID : defId);
  const parts = entry?.parts;
  const frame = stsPart(parts?.['frame']);
  const trolley = stsPart(parts?.['trolley']);
  const spreader20 = stsPart(parts?.['spreader_20']);
  const spreader40 = stsPart(parts?.['spreader_40']);
  const travel = parts?.['trolley']?.travel;
  if (entry === undefined || frame === undefined || trolley === undefined || spreader20 === undefined || spreader40 === undefined || travel === undefined) return undefined;
  return { footprint: entry.footprint, frame, trolley, travelY: { yMin: travel.yMin, yMax: travel.yMax }, spreader20, spreader40 };
}

/** Id záznamu RTG v `entities`: každé `rtg*` id stroja sa kreslí z neho. */
export const RTG_ENTRY_ID = 'rtg';

/** Stroje, ktorých sprity sa načítajú do atlasu. */
export const LOADED_MACHINES: readonly string[] = [RTG_ENTRY_ID];

/** RTG `defId` (`entities.rtg.parts.frame` + `trolley` s `travel`; `rtg*` → `rtg`), alebo `undefined`. */
export function machineSprite(defId: string): MachineSpriteEntry | undefined {
  const entry = lookup(MACHINE_SPRITES, defId.startsWith(RTG_ENTRY_ID) ? RTG_ENTRY_ID : defId);
  const frame = stsPart(entry?.parts?.['frame']);
  const trolley = stsPart(entry?.parts?.['trolley']);
  const travel = entry?.parts?.['trolley']?.travel;
  if (entry?.footprint === undefined || frame === undefined || trolley === undefined || travel === undefined) return undefined;
  return { footprint: entry.footprint, frame, trolley, travelX: { yMin: travel.yMin, yMax: travel.yMax } };
}

/** Záznam lode triedy `classId` (`entities.ship_<classId>`), alebo `undefined`. */
export function shipSprite(classId: string): ShipSpriteEntry | undefined {
  return lookup(SHIP_SPRITES, `${SHIP_ENTRY_PREFIX}${classId}`);
}

/** Polia paluby kontajnerovej lode triedy `classId` (`entities.ship_<classId>.deck`), alebo `undefined` (trieda / paluba v manifeste chýba). */
export function shipDeck(classId: string): ShipDeckEntry | undefined {
  return shipSprite(classId)?.deck;
}

/**
 * Záznam vozidla `defId` (`entities.<defId>` so stavmi `empty` / `loaded`), alebo `undefined`. Lode (`ship_*`) majú
 * `variants`, nie `states`, takže nie sú vozidlá.
 */
export function vehicleSprite(defId: string): VehicleSpriteEntry | undefined {
  const entry = lookup(VEHICLE_SPRITES, defId);
  if (entry?.footprint === undefined) return undefined;
  // jediný `file`: stavy `empty` / `loaded` sa líšia len kontajnerom, ktorý kreslí hra (straddle carrier, R1)
  if (entry.states === undefined) return entry.file === undefined ? undefined : { footprint: entry.footprint, states: { empty: entry.file, loaded: entry.file } };
  return { footprint: entry.footprint, states: entry.states };
}

/** Kĺbové vozidlo `defId` (`entities.<defId>.parts` = `cab` + `trailer`), alebo `undefined`. */
export function articulatedSprite(defId: string): ArticulatedSpriteEntry | undefined {
  const entry = lookup(VEHICLE_SPRITES, defId);
  const cab = entry?.parts?.cab;
  const trailer = entry?.parts?.trailer;
  if (entry?.footprint === undefined || cab === undefined || trailer === undefined) return undefined;
  return { footprint: entry.footprint, cab, trailer };
}

/** Spreader vozidla `defId` (`entities.<defId>.spreaderMount` + `parts.spreader_20` / `spreader_40`; R2: ECH), alebo `undefined`. */
export function vehicleSpreader(defId: string): VehicleSpreaderEntry | undefined {
  const entry = lookup(VEHICLE_SPRITES, defId);
  const mount = entry?.spreaderMount;
  const spreader20 = entry?.parts?.spreader_20;
  const spreader40 = entry?.parts?.spreader_40;
  if (entry?.footprint === undefined || mount === undefined || spreader20 === undefined || spreader40 === undefined) return undefined;
  return { mount, footprint: entry.footprint, spreader20, spreader40 };
}

/** Prekryv brzdových svetiel (`entities.vehicle_brake_lights`), alebo `undefined`. */
export function brakeLightsSprite(): BrakeLightsEntry | undefined {
  const entry = lookup(VEHICLE_SPRITES, 'vehicle_brake_lights');
  if (entry?.footprint === undefined || entry.file === undefined) return undefined;
  return { file: entry.file, footprint: entry.footprint };
}

/** Záznam nákladu typu `typeId` (`cargo.<typeId>`), alebo `undefined`. */
export function cargoSpriteEntry(typeId: string): CargoSpriteEntry | undefined {
  return lookup(CARGO_SPRITES, typeId);
}

/** Kontajner TEU, ktorého zobrazená veľkosť sa berie zo `world-scale.ts` (manifest má sprite 64 × 32, svet 64 × 26). */
const TEU_TYPE_ID = 'container_teu';

/**
 * Rozmer, v akom sa náklad `typeId` kreslí, v px zdroja (64 px bunka): kontajner TEU má jednotných 64 × 26 (`TEU_PX`, F5b č. 10:
 * rovnaký na aprone, pod žeriavom, na doku rampy aj vo vozidle), ostatný náklad rozmer zo sprite v manifeste. `undefined` pre
 * typ bez záznamu v manifeste. Jediné miesto, kde sa zobrazená veľkosť kontajnera určuje.
 */
export function cargoDisplaySize(typeId: string): CellSize | undefined {
  if (typeId === TEU_TYPE_ID && cargoSpriteEntry(typeId) !== undefined) return TEU_PX;
  return cargoSpriteEntry(typeId)?.size;
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

/** Súbory overlayov R4: odovzdávacie miesto RTG (`tp_marker`) a bezpečnostná zóna pri ňom (`safe_zone`); obe 1 × 1 bunka. */
export const TP_MARKER_FILE: string = overlayManifest.tp_marker.file;
export const SAFE_ZONE_FILE: string = overlayManifest.safe_zone.file;

/** Id záznamu zdieľanej závory pruhov brány v `sprites` (`parts.barrier`). */
export const GATE_BARRIER_ENTRY_ID = 'gate_lane_barrier';

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
 * preto sa berie iba to, čo sa dá postaviť; F6c pridáva depo prázdnych (4×4, ako malý dvor). S novým skladom (silo, nádrže…) pribudne jeho id sem.
 */
export const LOADED_STATE_MODULES: readonly string[] = ['container_yard_small', 'empty_depot'];

/**
 * Vozidlá a kamióny, ktorých sprity (`states.empty`, `states.loaded`, voliteľne `states.carries_empty`) sa načítajú do atlasu —
 * `straddle_carrier` (F3), `truck_container` (F4) a `empty_handler` (F6c, od R2 sprite `ech` + spreadery). Ostatné (AGV, vysokozdvižný vozík, ďalšie kamióny, vlaky) pribudnú so svojimi fázami;
 * do vtedy nakreslí `VehicleView` fallback z tokenov.
 */
export const LOADED_VEHICLES: readonly string[] = ['straddle_carrier', 'truck_container', 'empty_handler', 'terminal_tractor'];

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
      if (entry.states.carries_empty !== undefined) files.add(entry.states.carries_empty);
    }
    const parts = articulatedSprite(defId);
    if (parts !== undefined) {
      files.add(parts.cab.file);
      files.add(parts.trailer.file);
    }
    const spreader = vehicleSpreader(defId);
    if (spreader !== undefined) {
      files.add(spreader.spreader20.file);
      files.add(spreader.spreader40.file);
    }
  }
  for (const defId of LOADED_MACHINES) {
    const machine = machineSprite(defId);
    if (machine !== undefined) {
      files.add(machine.frame.file);
      files.add(machine.trolley.file);
    }
  }
  const brake = brakeLightsSprite();
  if (brake !== undefined) files.add(brake.file);
  for (const entry of Object.values(CARGO_SPRITES)) files.add(entry.file);
  files.add(BLOCKED_BADGE_FILE);
  files.add(WARNING_BADGE_FILE);
  files.add(QUEUE_BADGE_FILE);
  files.add(TP_MARKER_FILE);
  files.add(SAFE_ZONE_FILE);
  return [...files];
}
