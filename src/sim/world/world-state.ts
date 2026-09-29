/**
 * Serializovaný stav sveta v1 (ARCHITECTURE §14): čistý JSON bez tried — `JSON.parse(JSON.stringify(s))` je hlboko
 * rovný `s`. Statické dáta mapy (terén, `depthClass`, `parcelId`, geometria a ceny parciel) sa neukladajú; pri
 * načítaní ich dodá `LoadedMap` s rovnakým `mapId`.
 *
 * `parseWorldState` je fail-fast: neplatný stav → `WorldStateError` s JSON pointerom, svet sa nevytvorí.
 */
import { EntityIdAllocator, type EntityIdAllocatorState } from '../core/entity-id';
import { Rng, type RngState } from '../core/rng';
import { SimClock, type SimClockState } from '../core/sim-clock';
import type { DefRegistry } from '../defs/def-registry';
import type { RoadLayer } from '../grid/grid';
import { pointerSegment } from '../grid/map-error';
import type { LoadedMap } from '../grid/map-loader';
import type { ParcelOwnership } from '../grid/parcel';
import { isRoadBuildable } from '../grid/terrain';

/** Jediná podporovaná verzia `WorldState` (migrácie starších verzií: §14 `migrate`, neskôr). */
export const WORLD_STATE_VERSION = 1;

/** Vrstva dopravy v save — bunky s `road: 'none'` sa neukladajú. */
export type SerializedRoadLayer = Exclude<RoadLayer, 'none'>;

/** Bunka s cestou alebo koľajou: `[row-major index bunky, vrstva]`. */
export type SerializedRoad = readonly [index: number, layer: SerializedRoadLayer];

export interface WorldState {
  readonly version: typeof WORLD_STATE_VERSION;
  /** `LoadedMap.id`; `World.deserialize` odmietne inú mapu. */
  readonly mapId: string;
  /** Pôvodný seed hry (uint32) — metadáta; pokračovanie určuje `rng`. */
  readonly seed: number;
  /** Stav jediného `Rng` (4× uint32). */
  readonly rng: RngState;
  readonly clock: SimClockState;
  readonly ids: EntityIdAllocatorState;
  readonly cashCents: number;
  /** Všetky bunky s cestou/koľajou (vrátane starter ciest z mapy) vzostupne podľa indexu. */
  readonly roads: readonly SerializedRoad[];
  /** Vlastníctvo každej parcely mapy, `id → ownership`, v poradí mapy. */
  readonly parcels: Readonly<Record<string, ParcelOwnership>>;
}

/** Neplatný `WorldState`. Správa: `WorldState<path>: <problém>`, napr. `WorldState/roads/3/0: bunka je voda`. */
export class WorldStateError extends Error {
  /** JSON pointer (RFC 6901) do `WorldState`; `''` = celý stav. */
  readonly path: string;
  readonly problem: string;

  constructor(path: string, problem: string) {
    super(`WorldState${path}: ${problem}`);
    this.name = 'WorldStateError';
    this.path = path;
    this.problem = problem;
  }
}

/** Overený stav pripravený na zostavenie `World` (jadrové objekty už vytvorené z uložených stavov). */
export interface ParsedWorldState {
  readonly seed: number;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  readonly cashCents: number;
  readonly roads: readonly SerializedRoad[];
  /** Vlastníctvo pre každú parcelu mapy. */
  readonly ownership: ReadonlyMap<string, ParcelOwnership>;
}

/** Kľúče v1 v poradí `serialize()`; iné kľúče sú chyba (stav nemá voliteľné polia). */
const WORLD_STATE_KEYS: readonly (keyof WorldState)[] = [
  'version',
  'mapId',
  'seed',
  'rng',
  'clock',
  'ids',
  'cashCents',
  'roads',
  'parcels',
];
const CLOCK_KEYS: readonly (keyof SimClockState)[] = ['tick', 'speed'];
const IDS_KEYS: readonly (keyof EntityIdAllocatorState)[] = ['nextId'];

/** Tabuľky platných hodnôt — `Record` nad úniou vynúti úplnosť pri kompilácii. */
const SERIALIZED_ROAD_LAYERS: Readonly<Record<SerializedRoadLayer, true>> = { road: true, rail: true };
const PARCEL_OWNERSHIPS: Readonly<Record<ParcelOwnership, true>> = { none: true, owned: true, leased: true };

/** Dĺžka záznamu cesty `[index, vrstva]`. */
const ROAD_ENTRY_LENGTH = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'pole';
  return typeof value === 'object' && value !== null ? 'objekt' : JSON.stringify(value);
}

/** Objekt s presne danými kľúčmi (chýbajúci aj neznámy kľúč = chyba). */
function checkKeys(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new WorldStateError(path, `musí byť objekt, dostal ${describeValue(value)}`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new WorldStateError(`${path}${pointerSegment(key)}`, 'neznámy kľúč');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new WorldStateError(`${path}${pointerSegment(key)}`, 'chýba povinný kľúč');
  }
  return value;
}

/** Validáciu rozsahov robia jadrové triedy (`RangeError`); tu sa ich chyba preloží na `WorldStateError` s cestou. */
function restore<T>(path: string, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) throw new WorldStateError(path, error.message);
    throw error;
  }
}

function parseRoads(value: unknown, map: LoadedMap): SerializedRoad[] {
  if (!Array.isArray(value)) throw new WorldStateError('/roads', `musí byť pole, dostal ${describeValue(value)}`);
  const { grid } = map;
  const seen = new Set<number>();
  return value.map((entry: unknown, i): SerializedRoad => {
    const path = `/roads${pointerSegment(i)}`;
    if (!Array.isArray(entry) || entry.length !== ROAD_ENTRY_LENGTH) {
      throw new WorldStateError(path, 'musí byť dvojica [index bunky, vrstva]');
    }
    const [index, layer] = entry as [unknown, unknown];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= grid.cellCount) {
      throw new WorldStateError(`${path}/0`, `index bunky musí byť celé číslo 0…${String(grid.cellCount - 1)}, dostal ${describeValue(index)}`);
    }
    if (typeof layer !== 'string' || !Object.hasOwn(SERIALIZED_ROAD_LAYERS, layer)) {
      throw new WorldStateError(`${path}/1`, `vrstva musí byť 'road' alebo 'rail', dostal ${describeValue(layer)}`);
    }
    if (seen.has(index)) throw new WorldStateError(`${path}/0`, `duplicitná bunka ${String(index)}`);
    seen.add(index);
    const { terrain } = grid.atIndex(index);
    if (!isRoadBuildable(terrain)) {
      const { x, y } = grid.coordOf(index);
      throw new WorldStateError(`${path}/0`, `bunka (${String(x)}, ${String(y)}) má terén ${terrain}, cesta/koľaj tam nemôže byť`);
    }
    return [index, layer as SerializedRoadLayer];
  });
}

function parseParcels(value: unknown, map: LoadedMap): Map<string, ParcelOwnership> {
  if (!isPlainObject(value)) throw new WorldStateError('/parcels', `musí byť objekt, dostal ${describeValue(value)}`);
  const byId = new Map(map.parcels.map((parcel) => [parcel.id, parcel] as const));
  for (const [id, ownership] of Object.entries(value)) {
    const path = `/parcels${pointerSegment(id)}`;
    const parcel = byId.get(id);
    if (parcel === undefined) throw new WorldStateError(path, `mapa '${map.id}' nemá parcelu '${id}'`);
    if (typeof ownership !== 'string' || !Object.hasOwn(PARCEL_OWNERSHIPS, ownership)) {
      throw new WorldStateError(path, `vlastníctvo musí byť 'none', 'owned' alebo 'leased', dostal ${describeValue(ownership)}`);
    }
    if (ownership === 'leased' && !parcel.leasable) {
      throw new WorldStateError(path, `parcela '${id}' nie je na prenájom (leasable: false)`);
    }
  }
  // Výsledok v poradí mapy (nie vstupu) — deterministické poradie iterácie aj opätovnej serializácie.
  const ownership = new Map<string, ParcelOwnership>();
  for (const { id } of map.parcels) {
    if (!Object.hasOwn(value, id)) throw new WorldStateError(`/parcels${pointerSegment(id)}`, 'chýba vlastníctvo parcely mapy');
    ownership.set(id, value[id] as ParcelOwnership);
  }
  return ownership;
}

/**
 * Overí `raw` ako `WorldState` v1 pre danú mapu a defy a obnoví jadrové objekty. Kontroly v poradí kľúčov:
 * tvar (presne kľúče v1), `version`, `mapId === map.id`, `seed` uint32, `rng` (4× uint32, nie nulový), `clock`
 * (tick ≥ 0, rýchlosť v `time.speeds`), `ids`, `cashCents` (bezpečné celé číslo), `roads` (index v mape, vrstva,
 * bez duplicít, terén unesie cestu), `parcels` (presne parcely mapy, platné vlastníctvo, `leased` len pri
 * `leasable`). Vstup sa nemení a výsledok s ním nezdieľa meniteľné objekty.
 */
export function parseWorldState(raw: unknown, defs: DefRegistry, map: LoadedMap): ParsedWorldState {
  const state = checkKeys(raw, WORLD_STATE_KEYS, '');
  if (state.version !== WORLD_STATE_VERSION) {
    throw new WorldStateError('/version', `nepodporovaná verzia ${describeValue(state.version)} (podporovaná ${String(WORLD_STATE_VERSION)})`);
  }
  if (state.mapId !== map.id) {
    throw new WorldStateError('/mapId', `stav patrí mape ${describeValue(state.mapId)}, načítaná je '${map.id}'`);
  }
  const seed = state.seed as number;
  restore('/seed', () => new Rng(seed));
  const rng = restore('/rng', () => Rng.fromState(state.rng as RngState));

  const clockState = checkKeys(state.clock, CLOCK_KEYS, '/clock') as unknown as SimClockState;
  const clock = restore('/clock', () => SimClock.fromState(defs.time, clockState));
  if (!defs.time.speeds.includes(clock.speed)) {
    throw new WorldStateError('/clock/speed', `rýchlosť ${String(clock.speed)} nie je v time.speeds [${defs.time.speeds.join(', ')}]`);
  }
  const idsState = checkKeys(state.ids, IDS_KEYS, '/ids') as unknown as EntityIdAllocatorState;
  const ids = restore('/ids', () => EntityIdAllocator.fromState(idsState));

  const { cashCents } = state;
  if (typeof cashCents !== 'number' || !Number.isSafeInteger(cashCents)) {
    throw new WorldStateError('/cashCents', `musí byť bezpečné celé číslo (centy), dostal ${describeValue(cashCents)}`);
  }
  const roads = parseRoads(state.roads, map);
  const ownership = parseParcels(state.parcels, map);
  return { seed, clock, rng, ids, cashCents, roads, ownership };
}
