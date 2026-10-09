/**
 * `MapDef` — dátový formát mapy (ARCHITECTURE §4.7, `data/schemas/map.schema.json`) a jeho štrukturálny parser.
 *
 * Dve úrovne kontroly (obe fail-fast, `MapError` s JSON pointerom):
 * - `parseMapDef(raw)` — tvar ako v schéme: povinné/neznáme kľúče, typy, celé čísla a ich minimá, enumy, snake_case id,
 *   minimálne dĺžky polí. Z neznámeho JSON (import, `JSON.parse`) urobí typovaný, zmrazený `MapDef`.
 * - `loadMap(def)` (map-loader.ts) — vzťahy medzi poľami (rozmery terénu, znaky, parcely, portály, voda, cesty).
 *
 * Plnú JSON schému navyše vynucuje `pnpm validate:defs`; tu je minimum bez runtime závislostí (ako `DefRegistry`).
 */
import type { CellCoord, DepthClass, Direction4Name, Rect } from './grid';
import { MapError, pointerSegment } from './map-error';
import { isDirection4Name } from './road-direction';
import { isRotation, type Rotation } from './rotation';

/** Hĺbková trieda zóny nábrežia v `MapDef.depth` (1–3; 0 majú len bunky mimo nábrežia). */
export type DepthZoneClass = Exclude<DepthClass, 0>;

export interface MapParcelDef {
  readonly id: string;
  readonly rect: Rect;
  readonly priceCents: number;
  readonly leasable: boolean;
  /** Vlastnená od začiatku hry (ADR-008); chýba = `false`. */
  readonly startOwned?: boolean;
}

/** Smer cestného portálu (ADR-037 dodatok R1): `in` = vjazd do mapy (vznik kamiónov), `out` = výjazd z mapy, `both` = oboje (predvolené). */
export type PortalDirection = 'in' | 'out' | 'both';

/** Hodnoty `PortalDirection` v poradí schémy. */
export const PORTAL_DIRECTIONS: readonly PortalDirection[] = Object.freeze(['in', 'out', 'both'] as const);

export interface MapPortalDef {
  readonly id: string;
  readonly cell: CellCoord;
  /** Len cestné portály; chýba = `both` (staré mapy a scenáre). */
  readonly direction?: PortalDirection;
  /** Len cestné portály vjazdu (R4, ADR-041 bod 3): podiel kamiónov z danej strany vnútrozemia (číslo > 0); chýba = rovnaký podiel ako ostatné portály. */
  readonly trafficShare?: number;
}

/** Štartová cesta mapy: bunka, voliteľne s `dir` = jednosmerná (`one_way`) v danom smere; bez `dir` dvojpruhová. */
export interface MapStarterRoadDef extends CellCoord {
  readonly dir?: Direction4Name;
}

/** Predpostavený modul (Root modul od F2): def z `modules.json`, ľavý horný roh a rotácia. */
export interface PlacedModuleSpec {
  readonly defId: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

export interface MapStarterDef {
  readonly modules: readonly PlacedModuleSpec[];
  readonly roads: readonly MapStarterRoadDef[];
}

/** Jediná podporovaná verzia formátu mapy (`schemaVersion` v `data/maps/*.json`, `map.schema.json`). */
export const SUPPORTED_MAP_SCHEMA_VERSION = 1;

/** Mapa podľa §4.7; `Cell` z §4.7 = `CellCoord`. */
export interface MapDef {
  readonly schemaVersion: typeof SUPPORTED_MAP_SCHEMA_VERSION;
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Riadky zhora nadol; znaky `~ = Q . #` (§4.7, `TERRAIN_TRAITS`). */
  readonly terrain: readonly string[];
  /** Kľúč = obdĺžnik `"x,y,w,h"`, hodnota = hĺbková trieda nábrežia v ňom; nábrežie mimo zón má triedu 1. */
  readonly depth: Readonly<Record<string, DepthZoneClass>>;
  readonly parcels: readonly MapParcelDef[];
  readonly roadPortals: readonly MapPortalDef[];
  readonly railPortals: readonly MapPortalDef[];
  /** Polyline plavebnej dráhy od okraja mapy k anchorage. */
  readonly seaLane: readonly CellCoord[];
  /** Čakacie pozície lodí (rejda — vyhradená zóna kotvísk na otvorenom mori, ADR-029 dodatok T6D-03). */
  readonly anchorage: readonly CellCoord[];
  /**
   * Kurz všetkých lodí na kotve (0/90/180/270, 0 = predok na sever): jednotné natočenie voči pobrežiu — pozdĺž pobrežia
   * alebo prídou proti prevládajúcemu prúdu (ADR-029 dodatok, T6D-03). Chýba = `DEFAULT_ANCHORAGE_HEADING`.
   */
  readonly anchorageHeading?: Rotation;
  readonly starter: MapStarterDef;
}

/**
 * Predvolený kurz lodí na kotve, keď mapa `anchorageHeading` neuvádza: východ (90) = rovnobežne s pobrežím na sever
 * od prístavu, rovnako ako loď pri kotvisku so stranou `n` (`DOCKED_HEADING`). Štrukturálny predvolený údaj formátu
 * mapy, nie balans.
 */
export const DEFAULT_ANCHORAGE_HEADING: Rotation = 90;

// Hranice nižšie zrkadlia map.schema.json (tvar formátu), nie sú to laditeľné herné hodnoty.

/** snake_case identifikátor (`$defs/id`). */
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const DEPTH_ZONE_CLASSES: readonly DepthZoneClass[] = [1, 2, 3];

const MAP_KEYS = [
  'schemaVersion',
  'id',
  'width',
  'height',
  'terrain',
  'depth',
  'parcels',
  'roadPortals',
  'railPortals',
  'seaLane',
  'anchorage',
  'starter',
] as const;
const MAP_OPTIONAL_KEYS = ['anchorageHeading'] as const;
const PARCEL_KEYS = ['id', 'rect', 'priceCents', 'leasable'] as const;
const PARCEL_OPTIONAL_KEYS = ['startOwned'] as const;
const RECT_KEYS = ['x', 'y', 'w', 'h'] as const;
const CELL_KEYS = ['x', 'y'] as const;
const PORTAL_KEYS = ['id', 'cell'] as const;
const PORTAL_OPTIONAL_KEYS = ['direction', 'trafficShare'] as const;
const STARTER_ROAD_OPTIONAL_KEYS = ['dir'] as const;
const PLACED_MODULE_KEYS = ['defId', 'x', 'y', 'rotation'] as const;
const STARTER_KEYS = ['modules', 'roads'] as const;

/** Minimálne počty položiek polí (`minItems` v schéme). */
const MIN_ITEMS = {
  terrain: 1,
  parcels: 1,
  roadPortals: 1,
  railPortals: 0,
  seaLane: 2,
  anchorage: 1,
  starterModules: 0,
  starterRoads: 0,
} as const;
/** Minimum súradnice a rozmeru (`$defs/cell`, `$defs/rect`, `width`/`height`). */
const MIN_COORD = 0;
const MIN_SIZE = 1;
const MIN_PRICE_CENTS = 0;

/** Označenie mapy v chybách, kým nie je známe platné `id`. */
const UNKNOWN_MAP_ID = 'map';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'pole';
  if (typeof value === 'object') return 'objekt';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

type ItemParser<T> = (value: unknown, path: string) => T;

/** Parser jednej mapy; drží `mapId` pre správy chýb. Metódy vracajú nové zmrazené objekty (vstup sa nemení). */
class MapDefParser {
  constructor(private readonly mapId: string) {}

  parse(raw: unknown): MapDef {
    const root = this.object(raw, '', MAP_KEYS, MAP_OPTIONAL_KEYS);
    // Poradie vlastností = poradie kontrol = poradie v schéme (prvá chyba vyhráva).
    const def: MapDef = {
      schemaVersion: this.schemaVersion(root['schemaVersion'], '/schemaVersion'),
      id: this.id(root['id'], '/id'),
      width: this.integer(root['width'], '/width', MIN_SIZE),
      height: this.integer(root['height'], '/height', MIN_SIZE),
      terrain: this.array(root['terrain'], '/terrain', MIN_ITEMS.terrain, (v, p) => this.string(v, p)),
      depth: this.depth(root['depth'], '/depth'),
      parcels: this.array(root['parcels'], '/parcels', MIN_ITEMS.parcels, (v, p) => this.parcel(v, p)),
      roadPortals: this.array(root['roadPortals'], '/roadPortals', MIN_ITEMS.roadPortals, (v, p) => this.portal(v, p)),
      railPortals: this.array(root['railPortals'], '/railPortals', MIN_ITEMS.railPortals, (v, p) => this.portal(v, p)),
      seaLane: this.array(root['seaLane'], '/seaLane', MIN_ITEMS.seaLane, (v, p) => this.cell(v, p)),
      anchorage: this.array(root['anchorage'], '/anchorage', MIN_ITEMS.anchorage, (v, p) => this.cell(v, p)),
      starter: this.starter(root['starter'], '/starter'),
    };
    if (!Object.hasOwn(root, 'anchorageHeading')) return Object.freeze(def);
    return Object.freeze({ ...def, anchorageHeading: this.rotation(root['anchorageHeading'], '/anchorageHeading') });
  }

  private error(path: string, problem: string): MapError {
    return new MapError(this.mapId, path, problem);
  }

  /** Objekt s danými kľúčmi: najprv neznámy kľúč, potom chýbajúci povinný (ako `DefRegistry`). */
  private object(
    value: unknown,
    path: string,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Record<string, unknown> {
    if (!isPlainObject(value)) throw this.error(path, `očakávaný objekt, dostal ${describeValue(value)}`);
    const known = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
      if (!known.has(key)) throw this.error(`${path}${pointerSegment(key)}`, 'neznámy kľúč');
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) throw this.error(`${path}${pointerSegment(key)}`, 'chýba povinné pole');
    }
    return value;
  }

  private array<T>(value: unknown, path: string, minItems: number, item: ItemParser<T>): readonly T[] {
    if (!Array.isArray(value)) throw this.error(path, `očakávané pole, dostal ${describeValue(value)}`);
    if (value.length < minItems) {
      throw this.error(path, `pole musí mať aspoň ${String(minItems)} položiek, má ${String(value.length)}`);
    }
    return Object.freeze(value.map((entry: unknown, index) => item(entry, `${path}${pointerSegment(index)}`)));
  }

  private schemaVersion(value: unknown, path: string): typeof SUPPORTED_MAP_SCHEMA_VERSION {
    if (value !== SUPPORTED_MAP_SCHEMA_VERSION) {
      throw this.error(
        path,
        `nepodporovaná verzia schémy mapy, očakávaná ${String(SUPPORTED_MAP_SCHEMA_VERSION)}, dostal ${describeValue(value)}`,
      );
    }
    return SUPPORTED_MAP_SCHEMA_VERSION;
  }

  private integer(value: unknown, path: string, min: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw this.error(path, `očakávané celé číslo, dostal ${describeValue(value)}`);
    }
    if (value < min) throw this.error(path, `musí byť ≥ ${String(min)}, dostal ${String(value)}`);
    return value;
  }

  private string(value: unknown, path: string): string {
    if (typeof value !== 'string') throw this.error(path, `očakávaný reťazec, dostal ${describeValue(value)}`);
    return value;
  }

  private boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') throw this.error(path, `očakávaný boolean, dostal ${describeValue(value)}`);
    return value;
  }

  private id(value: unknown, path: string): string {
    const id = this.string(value, path);
    if (!ID_PATTERN.test(id)) throw this.error(path, `id musí byť snake_case (${String(ID_PATTERN)}), dostal ${JSON.stringify(id)}`);
    return id;
  }

  /** Kľúče zón (`"x,y,w,h"`) sú tu ľubovoľné reťazce — ich formát a geometriu overuje `loadMap`. */
  private depth(value: unknown, path: string): Readonly<Record<string, DepthZoneClass>> {
    if (!isPlainObject(value)) throw this.error(path, `očakávaný objekt, dostal ${describeValue(value)}`);
    const zones: Record<string, DepthZoneClass> = {};
    for (const [key, depthClass] of Object.entries(value)) {
      const found = DEPTH_ZONE_CLASSES.find((allowed) => allowed === depthClass);
      if (found === undefined) {
        throw this.error(`${path}${pointerSegment(key)}`, `hĺbková trieda musí byť 1, 2 alebo 3, dostal ${describeValue(depthClass)}`);
      }
      zones[key] = found;
    }
    return Object.freeze(zones);
  }

  private cell(value: unknown, path: string): CellCoord {
    const raw = this.object(value, path, CELL_KEYS);
    return Object.freeze({
      x: this.integer(raw['x'], `${path}/x`, MIN_COORD),
      y: this.integer(raw['y'], `${path}/y`, MIN_COORD),
    });
  }

  private starterRoad(value: unknown, path: string): MapStarterRoadDef {
    const raw = this.object(value, path, CELL_KEYS, STARTER_ROAD_OPTIONAL_KEYS);
    const cell = { x: this.integer(raw['x'], `${path}/x`, MIN_COORD), y: this.integer(raw['y'], `${path}/y`, MIN_COORD) };
    if (!Object.hasOwn(raw, 'dir')) return Object.freeze(cell);
    const dir = raw['dir'];
    if (!isDirection4Name(dir)) throw this.error(`${path}/dir`, `smer cesty musí byť 'N', 'E', 'S' alebo 'W', dostal ${describeValue(dir)}`);
    return Object.freeze({ ...cell, dir });
  }

  private rect(value: unknown, path: string): Rect {
    const raw = this.object(value, path, RECT_KEYS);
    return Object.freeze({
      x: this.integer(raw['x'], `${path}/x`, MIN_COORD),
      y: this.integer(raw['y'], `${path}/y`, MIN_COORD),
      w: this.integer(raw['w'], `${path}/w`, MIN_SIZE),
      h: this.integer(raw['h'], `${path}/h`, MIN_SIZE),
    });
  }

  private parcel(value: unknown, path: string): MapParcelDef {
    const raw = this.object(value, path, PARCEL_KEYS, PARCEL_OPTIONAL_KEYS);
    const parcel: MapParcelDef = {
      id: this.id(raw['id'], `${path}/id`),
      rect: this.rect(raw['rect'], `${path}/rect`),
      priceCents: this.integer(raw['priceCents'], `${path}/priceCents`, MIN_PRICE_CENTS),
      leasable: this.boolean(raw['leasable'], `${path}/leasable`),
    };
    if (!Object.hasOwn(raw, 'startOwned')) return Object.freeze(parcel);
    return Object.freeze({ ...parcel, startOwned: this.boolean(raw['startOwned'], `${path}/startOwned`) });
  }

  private portal(value: unknown, path: string): MapPortalDef {
    const raw = this.object(value, path, PORTAL_KEYS, PORTAL_OPTIONAL_KEYS);
    let portal: MapPortalDef = { id: this.id(raw['id'], `${path}/id`), cell: this.cell(raw['cell'], `${path}/cell`) };
    if (Object.hasOwn(raw, 'direction')) {
      const direction = raw['direction'];
      if (!PORTAL_DIRECTIONS.includes(direction as PortalDirection)) {
        throw this.error(`${path}/direction`, `smer portálu musí byť 'in', 'out' alebo 'both', dostal ${describeValue(direction)}`);
      }
      portal = { ...portal, direction: direction as PortalDirection };
    }
    if (Object.hasOwn(raw, 'trafficShare')) {
      const share = raw['trafficShare'];
      if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0) {
        throw this.error(`${path}/trafficShare`, `podiel premávky portálu musí byť konečné číslo > 0, dostal ${describeValue(share)}`);
      }
      portal = { ...portal, trafficShare: share };
    }
    return Object.freeze(portal);
  }

  private rotation(value: unknown, path: string): Rotation {
    if (!isRotation(value)) throw this.error(path, `rotácia musí byť 0, 90, 180 alebo 270, dostal ${describeValue(value)}`);
    return value;
  }

  private placedModule(value: unknown, path: string): PlacedModuleSpec {
    const raw = this.object(value, path, PLACED_MODULE_KEYS);
    const defId = this.id(raw['defId'], `${path}/defId`);
    const x = this.integer(raw['x'], `${path}/x`, MIN_COORD);
    const y = this.integer(raw['y'], `${path}/y`, MIN_COORD);
    const rotation = this.rotation(raw['rotation'], `${path}/rotation`);
    return Object.freeze({ defId, x, y, rotation });
  }

  private starter(value: unknown, path: string): MapStarterDef {
    const raw = this.object(value, path, STARTER_KEYS);
    return Object.freeze({
      modules: this.array(raw['modules'], `${path}/modules`, MIN_ITEMS.starterModules, (v, p) => this.placedModule(v, p)),
      roads: this.array(raw['roads'], `${path}/roads`, MIN_ITEMS.starterRoads, (v, p) => this.starterRoad(v, p)),
    });
  }
}

/**
 * Overí tvar surovej mapy (JSON import, `JSON.parse`) podľa `map.schema.json` a vráti typovaný zmrazený `MapDef`
 * (hlboká kópia; vstup sa nemení). Prvý problém → `MapError` s JSON pointerom. Vzťahy medzi poľami overí `loadMap`.
 */
export function parseMapDef(raw: unknown): MapDef {
  const rawId = isPlainObject(raw) ? raw['id'] : undefined;
  const mapId = typeof rawId === 'string' && rawId.length > 0 ? rawId : UNKNOWN_MAP_ID;
  return new MapDefParser(mapId).parse(raw);
}
