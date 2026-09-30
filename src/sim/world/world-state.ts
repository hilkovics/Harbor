/**
 * Serializovaný stav sveta (ARCHITECTURE §14; ADR-013, ADR-014): čistý JSON bez tried — `JSON.parse(JSON.stringify(s))`
 * je hlboko rovný `s`. Statické dáta mapy (terén, `depthClass`, `parcelId`, geometria a ceny parciel) sa neukladajú;
 * pri načítaní ich dodá `LoadedMap` s rovnakým `mapId`.
 *
 * v2 = v1 + `traffic`, `modules`, `cargo`, `ships`. Ukladá sa len to, čo sa nedá odvodiť: `cell.moduleId` vznikne
 * z footprintov modulov, obsadenie apronov a skladov a držané jednotky žeriavov z ledgera, rezervácie slotov apronu
 * z `reservedSlot` žeriavov a skupiny kotvísk prepočtom. Sklad (T03-02, ADR-017) ukladal v `runtime` rezervácie slotov
 * a počítadlá `unitsIn`/`unitsOut`, depo `{}` (v3: rezervácie sa odvodia z jobov, ADR-018).
 *
 * v3 (T03-04…T03-06, docs/tasks/phase-03.md rozhodnutie 10) = v2 + `vehicles` (vzostupne podľa id: id, def, depo,
 * stav, poloha, kurz, job, zaplatená cena, zvyšok trasy, progres úseku, odpočet a príznak preplánovania — ADR-019)
 * a `jobs` (aktívne joby vzostupne podľa id: id, jednotky, `from`, `to`,
 * `createdTick` — ADR-018). `VehicleDepot.vehicleIds` sa neukladá — odvodí sa z `depotId` vozidiel v poradí id
 * (= poradie nákupu). Vozidlo jobu a jeho stav sa odvodia z vozidla s daným `jobId` a z polohy nákladu, rezervácie
 * slotov skladu z `to` aktívnych jobov (runtime skladu = len počítadlá) a kotvisko ukladá hodinu posledného
 * `NoStorageAvailable` (ADR-018). Staršie verzie prevedie `migrateWorldState` (migrate.ts).
 *
 * v4 (T04-04, ADR-024) = v3 + `trucks` (vzostupne podľa id: id, def, stav, poloha, kurz, rampa a dock, brána,
 * stojisko, držaný bay, stav na návrat z `no_path`, zvyšok trasy, progres, odpočet, príznak preplánovania). Brána
 * ukladá frontu, odpočet prechodu a počítadlo v `runtime` (už od v3), rampa `lastNoWaitingBayHour`. Neukladá sa
 * odvoditeľné: držitelia bays a dockov (z kamiónov), strany brán a trasy (z ciest a modulov).
 *
 * Lode (ADR-016) sa ukladajú s polohou, stavom FSM, kotviskami, anchorage a indexom bodu trasy; trasa sa odvodí zo stavu
 * a mapy, `BerthModule.dockedShipId` z `berthIds`.
 *
 * Cesty (T03-18, ADR-020): záznam `[index, vrstva, typ?, smer?]` — dvojpruhová cesta a koľaj ako doteraz `[index, vrstva]`,
 * iný typ cesty `[index, 'road', typ]`, jednosmerka `[index, 'road', 'one_way', smer]`. v3 ešte nebola vydaná, preto sa
 * formát rozšíril bez migrácie; save v1/v2 majú len dvojice = dvojpruhové cesty (štartové cesty mapy sú `two_lane`).
 *
 * `parseWorldState` overí tvar a hodnoty (fail-fast, `WorldStateError` s JSON pointerom); vzťahy medzi modulmi,
 * nákladom a loďami overí pri obnove `restoreEntities` (world-restore.ts).
 */
import { parseCargoLedgerState, type CargoLedgerState } from '../cargo/cargo-ledger-state';
import { normalizeLocation, uniqueSlotOf, type CargoLocation } from '../cargo/cargo-location';
import { CargoStateError } from '../cargo/cargo-error';
import { EntityIdAllocator, type EntityId, type EntityIdAllocatorState } from '../core/entity-id';
import { Rng, type RngState } from '../core/rng';
import { SimClock, type SimClockState } from '../core/sim-clock';
import type { DefRegistry } from '../defs/def-registry';
import type { Direction4Name, Grid, RoadLayer } from '../grid/grid';
import { isDirection4Name } from '../grid/road-direction';
import { DEFAULT_ROAD_KIND, ROAD_KINDS, ROAD_KIND_TRAITS, isRoadKind, type RoadKind } from '../grid/road-kind';
import type { PlacedModuleSpec } from '../grid/map-def';
import type { LoadedMap } from '../grid/map-loader';
import type { ParcelOwnership } from '../grid/parcel';
import { isRotation, type Rotation } from '../grid/rotation';
import { isRoadBuildable } from '../grid/terrain';
import { SERIALIZED_JOB_KEYS, isJobRoute, type SerializedJob } from '../logistics/transport-job';
import type { ModuleRuntimeState } from '../modules/runtime-state';
import { SERIALIZED_SHIP_KEYS, type SerializedShip } from '../ships/ship';
import { SHIP_STATES, SHIP_STATE_TRAITS, type ShipState } from '../ships/ship-fsm';
import { SERIALIZED_TRUCK_KEYS, type SerializedTruck } from '../trucks/truck';
import { TRUCK_STATES, TRUCK_STATE_TRAITS, TRUCK_TRAVEL_STATES, isTruckState, isTruckTravelState, type TruckState, type TruckTravelState } from '../trucks/truck-fsm';
import { SERIALIZED_VEHICLE_KEYS, vehiclePosition, type SerializedVehicle } from '../vehicles/vehicle';
import { VEHICLE_STATES, VEHICLE_STATE_TRAITS, isVehicleState, type VehicleState } from '../vehicles/vehicle-fsm';
import { WORLD_STATE_V2, WORLD_STATE_V3, WORLD_STATE_V4_KEYS, WORLD_STATE_VERSION } from './migrate';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, isPlainObject, pointerSegment } from './state-check';

export { WORLD_STATE_VERSION } from './migrate';
export { WorldStateError } from './state-check';

/** Vrstva dopravy v save — bunky s `road: 'none'` sa neukladajú. */
export type SerializedRoadLayer = Exclude<RoadLayer, 'none'>;

/** Bunka s cestou alebo koľajou v save v1/v2: `[row-major index bunky, vrstva]`. */
export type SerializedRoadV1 = readonly [index: number, layer: SerializedRoadLayer];

/**
 * Bunka s cestou alebo koľajou (v3, ADR-020): `[index, vrstva]` pre koľaj a dvojpruhovú cestu, `[index, 'road', typ]`
 * pre iný obojsmerný typ, `[index, 'road', 'one_way', smer]` pre jednosmerku. Typ sa uvádza len mimo
 * `DEFAULT_ROAD_KIND` a smer len pri jednosmerke — kanonický tvar (`serialize` iný nevytvorí, `parseWorldState` iný
 * neprijme).
 */
export type SerializedRoad =
  | SerializedRoadV1
  | readonly [index: number, layer: 'road', kind: RoadKind]
  | readonly [index: number, layer: 'road', kind: RoadKind, dir: Direction4Name];

/** Cesta alebo koľaj zo save s overeným tvarom a normalizovaným typom (bez typu = predvolený, smer len pri jednosmerke). */
export interface ParsedRoadEntry {
  readonly index: number;
  readonly layer: SerializedRoadLayer;
  readonly kind: RoadKind;
  readonly dir: Direction4Name | null;
}

/** Bunka s nenulovým `traffic` (heatmapa §7.6): `[row-major index bunky, hodnota > 0]`. */
export type SerializedTraffic = readonly [index: number, value: number];

/** Modul v save v poradí umiestnenia (`world.modules`). */
export interface SerializedModule {
  readonly id: number;
  readonly defId: string;
  /** Ľavý horný roh footprintu po rotácii. */
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
  /** Skutočne zaplatená cena (starter moduly 0) — základ refundácie. */
  readonly purchaseCostCents: number;
  /** Dynamický stav triedy (`Module.getRuntimeState()`); moduly bez stavu `{}`. */
  readonly runtime: ModuleRuntimeState;
}

export type { SerializedShip } from '../ships/ship';
export type { SerializedVehicle } from '../vehicles/vehicle';

export type { SerializedJob } from '../logistics/transport-job';

export type { SerializedTruck } from '../trucks/truck';

/** `WorldState` v1 (F1, ADR-013) — vstup migrácie. */
export interface WorldStateV1 {
  readonly version: 1;
  readonly mapId: string;
  readonly seed: number;
  readonly rng: RngState;
  readonly clock: SimClockState;
  readonly ids: EntityIdAllocatorState;
  readonly cashCents: number;
  readonly roads: readonly SerializedRoadV1[];
  readonly parcels: Readonly<Record<string, ParcelOwnership>>;
}

/** `WorldState` v2 (F2, ADR-014) — vstup migrácie v2 → v3. */
export interface WorldStateV2 extends Omit<WorldStateV1, 'version'> {
  readonly version: typeof WORLD_STATE_V2;
  /** Bunky s nenulovým `cell.traffic` vzostupne podľa indexu (vo F2 vždy prázdne; F3 vozidlá). */
  readonly traffic: readonly SerializedTraffic[];
  readonly modules: readonly SerializedModule[];
  /** Stav `CargoLedger` (`getState()`): len živé jednotky, exportované sú v `exportedCount` (ADR-014). */
  readonly cargo: CargoLedgerState;
  /** Lode vzostupne podľa id (`Ship.toState()`, ADR-016); `dockedShipId` kotvísk a trasy sa odvodia pri obnove. */
  readonly ships: readonly SerializedShip[];
}

/** `WorldState` v3 (F3, ADR-017 až ADR-021) — vstup migrácie v3 → v4. */
export interface WorldStateV3 extends Omit<WorldStateV2, 'version' | 'roads'> {
  readonly version: typeof WORLD_STATE_V3;
  /** Cesty a koľaje vzostupne podľa indexu bunky; typ cesty a smer jednosmerky len mimo predvoleného stavu (ADR-020). */
  readonly roads: readonly SerializedRoad[];
  /** Vozidlá vzostupne podľa id (`Vehicle.toState()`, T03-04); `VehicleDepot.vehicleIds` sa odvodí pri obnove. */
  readonly vehicles: readonly SerializedVehicle[];
  /** Aktívne transportné joby vzostupne podľa id (`TransportJob.toState()`, ADR-018). */
  readonly jobs: readonly SerializedJob[];
}

/** Aktuálny `WorldState` (v4, ADR-024). */
export interface WorldState extends Omit<WorldStateV3, 'version'> {
  readonly version: typeof WORLD_STATE_VERSION;
  /** Kamióny na mape vzostupne podľa id (`Truck.toState()`); bays a docky ich držiteľov sa odvodia pri obnove. */
  readonly trucks: readonly SerializedTruck[];
}

/** Ľubovoľná podporovaná verzia (vstup `World.deserialize`). */
export type AnyWorldState = WorldState | WorldStateV3 | WorldStateV2 | WorldStateV1;

/** Modul zo save s overeným tvarom; vzťahy k mriežke a iným modulom overí `restoreEntities`. */
export interface ParsedModuleEntry {
  readonly id: EntityId;
  readonly spec: PlacedModuleSpec;
  readonly purchaseCostCents: number;
  /** Surový `runtime` — overí ho `Module.restoreRuntimeState`. */
  readonly runtime: unknown;
}

/** Loď zo save s overeným tvarom (známa trieda aj náklad, stav bez `despawned`); vzťahy k svetu overí `restoreEntities`. */
export interface ParsedShipEntry {
  readonly id: EntityId;
  readonly classId: string;
  readonly cargoTypeId: string;
  readonly state: ShipState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly berthIds: readonly EntityId[];
  readonly anchorageIndex: number | null;
  readonly waypointIndex: number;
}

/**
 * Vozidlo zo save s overeným tvarom (známy def, stav, job podľa stavu, trasa po susedných bunkách, poloha na trase,
 * tvar trasy a odpočet podľa stavu); depo, job, náklad a cesty pod trasou overí `restoreEntities`.
 */
export interface ParsedVehicleEntry {
  readonly id: EntityId;
  readonly defId: string;
  readonly depotId: EntityId;
  readonly state: VehicleState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly jobId: EntityId | null;
  readonly purchaseCostCents: number;
  readonly route: readonly number[];
  readonly progress: number;
  readonly waitTicks: number;
  readonly replan: boolean;
}

/**
 * Kamión zo save s overeným tvarom (známy def, stav bez `exited`, `resume` práve v `no_path`, `bay` podľa stavu, trasa
 * po susedných bunkách, poloha na trase); moduly, bay, dock, fronta brány, náklad a cesty pod trasou overí obnova.
 */
export interface ParsedTruckEntry {
  readonly id: EntityId;
  readonly defId: string;
  readonly state: TruckState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly rampId: EntityId;
  readonly dock: number;
  readonly gateId: EntityId;
  readonly waitingAreaId: EntityId;
  readonly bay: number | null;
  readonly resume: TruckTravelState | null;
  readonly route: readonly number[];
  readonly progress: number;
  readonly waitTicks: number;
  readonly replan: boolean;
}

/** Job zo save s overeným tvarom (lokácie, dvojica druhov, jednotky); stav, vozidlo a vzťahy k svetu odvodí obnova. */
export interface ParsedJobEntry {
  readonly id: EntityId;
  readonly unitIds: readonly EntityId[];
  readonly from: CargoLocation;
  readonly to: CargoLocation;
  readonly createdTick: number;
}

/** Overený stav pripravený na zostavenie `World` (jadrové objekty už vytvorené z uložených stavov). */
export interface ParsedWorldState {
  readonly seed: number;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  readonly cashCents: number;
  readonly roads: readonly ParsedRoadEntry[];
  readonly traffic: readonly SerializedTraffic[];
  /** Vlastníctvo pre každú parcelu mapy. */
  readonly ownership: ReadonlyMap<string, ParcelOwnership>;
  /** Moduly v poradí save (= poradie umiestnenia). */
  readonly modules: readonly ParsedModuleEntry[];
  readonly cargo: CargoLedgerState;
  /** Lode vzostupne podľa id (= poradie spawnu). */
  readonly ships: readonly ParsedShipEntry[];
  /** Vozidlá vzostupne podľa id (= poradie nákupu). */
  readonly vehicles: readonly ParsedVehicleEntry[];
  /** Aktívne joby vzostupne podľa id (= poradie vzniku). */
  readonly jobs: readonly ParsedJobEntry[];
  /** Kamióny vzostupne podľa id (= poradie spawnu). */
  readonly trucks: readonly ParsedTruckEntry[];
}

/** Kľúče aktuálnej verzie (v4) v poradí `serialize()`; iné kľúče sú chyba (stav nemá voliteľné polia). */
export const WORLD_STATE_KEYS: readonly (keyof WorldState)[] = WORLD_STATE_V4_KEYS;
const CLOCK_KEYS: readonly (keyof SimClockState)[] = ['tick', 'speed'];
const IDS_KEYS: readonly (keyof EntityIdAllocatorState)[] = ['nextId'];
const MODULE_KEYS: readonly (keyof SerializedModule)[] = ['id', 'defId', 'x', 'y', 'rotation', 'purchaseCostCents', 'runtime'];

/** Tabuľky platných hodnôt — `Record` nad úniou vynúti úplnosť pri kompilácii. */
const SERIALIZED_ROAD_LAYERS: Readonly<Record<SerializedRoadLayer, true>> = { road: true, rail: true };
const PARCEL_OWNERSHIPS: Readonly<Record<ParcelOwnership, true>> = { none: true, owned: true, leased: true };

/** Dĺžka záznamu bunky `[index, hodnota]` (traffic; cesta bez typu). */
const CELL_ENTRY_LENGTH = 2;
/** Najdlhší záznam cesty `[index, 'road', typ, smer]` (ADR-020). */
const ROAD_ENTRY_MAX_LENGTH = 4;
/** Pozícia typu a smeru v zázname cesty. */
const ROAD_KIND_POSITION = 2;
const ROAD_DIR_POSITION = 3;

/** Validáciu rozsahov robia jadrové triedy (`RangeError`); tu sa ich chyba preloží na `WorldStateError` s cestou. */
function restore<T>(path: string, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) throw new WorldStateError(path, error.message);
    throw error;
  }
}

/**
 * Záznam bunky `[index, hodnota, …]`: pole dĺžky `CELL_ENTRY_LENGTH … maxLength` s platným indexom, bez duplicít
 * (`seen`). Vráti index a hodnotu (ďalšie položky číta volajúci).
 */
function parseCellEntry(entry: unknown, path: string, grid: Grid, seen: Set<number>, maxLength = CELL_ENTRY_LENGTH): readonly [number, unknown] {
  if (!Array.isArray(entry) || entry.length < CELL_ENTRY_LENGTH || entry.length > maxLength) {
    throw new WorldStateError(path, maxLength === CELL_ENTRY_LENGTH ? 'musí byť dvojica [index bunky, hodnota]' : 'musí byť [index bunky, vrstva, typ?, smer?]');
  }
  const [index, value] = entry as [unknown, unknown];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= grid.cellCount) {
    throw new WorldStateError(`${path}/0`, `index bunky musí byť celé číslo 0…${String(grid.cellCount - 1)}, dostal ${describeValue(index)}`);
  }
  if (seen.has(index)) throw new WorldStateError(`${path}/0`, `duplicitná bunka ${String(index)}`);
  seen.add(index);
  return [index, value];
}

/**
 * Typ a smer cesty zo záznamu `[index, vrstva, typ?, smer?]` v kanonickom tvare (ADR-020): bez typu = predvolený;
 * typ len pri vrstve `road` a mimo `DEFAULT_ROAD_KIND`; smer práve pri jednosmerke.
 */
function parseRoadKind(entry: readonly unknown[], layer: SerializedRoadLayer, path: string): { kind: RoadKind; dir: Direction4Name | null } {
  if (entry.length <= ROAD_KIND_POSITION) return { kind: DEFAULT_ROAD_KIND, dir: null };
  const kindPath = `${path}/${String(ROAD_KIND_POSITION)}`;
  const kind = entry[ROAD_KIND_POSITION];
  if (layer !== 'road') throw new WorldStateError(kindPath, `typ cesty smie mať len vrstva 'road', nie '${layer}'`);
  if (!isRoadKind(kind)) throw new WorldStateError(kindPath, `typ cesty musí byť jeden z: ${ROAD_KINDS.join(', ')}, dostal ${describeValue(kind)}`);
  if (kind === DEFAULT_ROAD_KIND) throw new WorldStateError(kindPath, `predvolený typ '${DEFAULT_ROAD_KIND}' sa neukladá`);
  const dirPath = `${path}/${String(ROAD_DIR_POSITION)}`;
  if (!ROAD_KIND_TRAITS[kind].oneWay) {
    if (entry.length > ROAD_DIR_POSITION) throw new WorldStateError(dirPath, `smer má len jednosmerka, nie '${kind}'`);
    return { kind, dir: null };
  }
  const dir = entry[ROAD_DIR_POSITION];
  if (!isDirection4Name(dir)) throw new WorldStateError(dirPath, `jednosmerka musí mať smer N, E, S alebo W, dostal ${describeValue(dir)}`);
  return { kind, dir };
}

/** `grid` = mriežka počiatočného stavu mapy (z `map.createGrid()`); číta sa z nej len statický terén. */
function parseRoads(value: unknown, grid: Grid): ParsedRoadEntry[] {
  const seen = new Set<number>();
  return checkArray(value, '/roads').map((entry: unknown, i): ParsedRoadEntry => {
    const path = `/roads${pointerSegment(i)}`;
    const [index, layer] = parseCellEntry(entry, path, grid, seen, ROAD_ENTRY_MAX_LENGTH);
    if (typeof layer !== 'string' || !Object.hasOwn(SERIALIZED_ROAD_LAYERS, layer)) {
      throw new WorldStateError(`${path}/1`, `vrstva musí byť 'road' alebo 'rail', dostal ${describeValue(layer)}`);
    }
    const { terrain } = grid.atIndex(index);
    if (!isRoadBuildable(terrain)) {
      const { x, y } = grid.coordOf(index);
      throw new WorldStateError(`${path}/0`, `bunka (${String(x)}, ${String(y)}) má terén ${terrain}, cesta/koľaj tam nemôže byť`);
    }
    const { kind, dir } = parseRoadKind(entry as readonly unknown[], layer as SerializedRoadLayer, path);
    return { index, layer: layer as SerializedRoadLayer, kind, dir };
  });
}

/** Záznam cesty/koľaje bunky pre save v kanonickom tvare (`SerializedRoad`, ADR-020). */
export function serializeRoad(index: number, layer: SerializedRoadLayer, kind: RoadKind, dir: Direction4Name | null): SerializedRoad {
  if (layer !== 'road' || kind === DEFAULT_ROAD_KIND) return [index, layer];
  return ROAD_KIND_TRAITS[kind].oneWay && dir !== null ? [index, layer, kind, dir] : [index, layer, kind];
}

function parseTraffic(value: unknown, grid: Grid): SerializedTraffic[] {
  const seen = new Set<number>();
  return checkArray(value, '/traffic').map((entry: unknown, i): SerializedTraffic => {
    const path = `/traffic${pointerSegment(i)}`;
    const [index, amount] = parseCellEntry(entry, path, grid, seen);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new WorldStateError(`${path}/1`, `traffic musí byť konečné číslo > 0 (nulové bunky sa neukladajú), dostal ${describeValue(amount)}`);
    }
    return [index, amount];
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
 * Tvar modulov: presne kľúče `SerializedModule`, id celé 1…`nextId − 1` a jedinečné, známy `defId`, celé `x`/`y` ≥ 0,
 * platná rotácia, `purchaseCostCents` celé ≥ 0, `runtime` objekt. Hranice mapy, obsadenie buniek, žeriav na
 * berthe a obsah `runtime` overí obnova (`restoreEntities`).
 */
function parseModules(value: unknown, defs: DefRegistry, nextId: number): ParsedModuleEntry[] {
  const seen = new Map<number, string>();
  return checkArray(value, '/modules').map((raw: unknown, i): ParsedModuleEntry => {
    const path = `/modules${pointerSegment(i)}`;
    const entry = checkKeys(raw, MODULE_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    const firstPath = seen.get(id);
    if (firstPath !== undefined) throw new WorldStateError(`${path}/id`, `duplicitné id ${String(id)} (${firstPath})`);
    seen.set(id, path);
    const { defId, rotation, runtime } = entry;
    if (typeof defId !== 'string' || !defs.modules.has(defId)) {
      throw new WorldStateError(`${path}/defId`, `neznámy modul ${describeValue(defId)}`);
    }
    const x = checkInteger(entry['x'], 0, `${path}/x`);
    const y = checkInteger(entry['y'], 0, `${path}/y`);
    if (!isRotation(rotation)) {
      throw new WorldStateError(`${path}/rotation`, `rotácia musí byť 0, 90, 180 alebo 270, dostal ${describeValue(rotation)}`);
    }
    const purchaseCostCents = checkInteger(entry['purchaseCostCents'], 0, `${path}/purchaseCostCents`);
    if (!isPlainObject(runtime)) throw new WorldStateError(`${path}/runtime`, `musí byť objekt, dostal ${describeValue(runtime)}`);
    return { id: id as EntityId, spec: { defId, x, y, rotation }, purchaseCostCents, runtime };
  });
}

/** Náklad: tvar a konzervácia podľa `parseCargoLedgerState`; chyba ledgera dostane prefix `/cargo`. */
function parseCargo(value: unknown, defs: DefRegistry, nextId: number): CargoLedgerState {
  try {
    return parseCargoLedgerState(value, defs.cargoTypes, nextId);
  } catch (error) {
    if (error instanceof CargoStateError) throw new WorldStateError(`/cargo${error.path}`, error.problem);
    throw error;
  }
}

/** Konečné číslo v rozsahu `0 … max` (poloha lode v bunkách). */
function checkCoordinate(value: unknown, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new WorldStateError(path, `musí byť konečné číslo 0 … ${String(max)}, dostal ${describeValue(value)}`);
  }
  return value;
}

/** Zoznam jedinečných id (celé ≥ 1). */
function checkIdList(value: unknown, path: string): EntityId[] {
  const seen = new Set<number>();
  return checkArray(value, path).map((raw: unknown, i) => {
    const id = checkInteger(raw, 1, `${path}${pointerSegment(i)}`);
    if (seen.has(id)) throw new WorldStateError(`${path}${pointerSegment(i)}`, `duplicitné id ${String(id)}`);
    seen.add(id);
    return id as EntityId;
  });
}

/**
 * Tvar lodí: presne kľúče `SerializedShip`, id celé 1…`nextId − 1` a ostro rastúce (poradie spawnu = FIFO alokácie),
 * známa trieda a náklad s kategóriou triedy, stav z `SHIP_STATES` okrem `despawned`, poloha v rozsahu mapy, platný
 * kurz, jedinečné `berthIds` neprázdne práve v stavoch s `holdsBerths`, `anchorageIndex` len v stave s `waitsForBerth`
 * a v rozsahu `map.anchorage`, `waypointIndex` celé ≥ 0. Kotviská a dĺžku trasy overí obnova (`restoreEntities`).
 */
function parseShips(value: unknown, defs: DefRegistry, map: LoadedMap, nextId: number): ParsedShipEntry[] {
  let previousId = 0;
  return checkArray(value, '/ships').map((raw: unknown, i): ParsedShipEntry => {
    const path = `/ships${pointerSegment(i)}`;
    const entry = checkKeys(raw, SERIALIZED_SHIP_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    if (id <= previousId) throw new WorldStateError(`${path}/id`, `lode musia byť vzostupne podľa id (poradie spawnu), ${String(id)} ≤ ${String(previousId)}`);
    previousId = id;
    const { classId, cargoTypeId, state, heading } = entry;
    if (typeof classId !== 'string' || !defs.ships.has(classId)) throw new WorldStateError(`${path}/classId`, `neznáma trieda lode ${describeValue(classId)}`);
    if (typeof cargoTypeId !== 'string' || !defs.cargoTypes.has(cargoTypeId)) {
      throw new WorldStateError(`${path}/cargoTypeId`, `neznámy typ nákladu ${describeValue(cargoTypeId)}`);
    }
    const category = defs.cargoTypes.get(cargoTypeId).category;
    if (!defs.ships.get(classId).cargoCategories.includes(category)) {
      throw new WorldStateError(`${path}/cargoTypeId`, `trieda '${classId}' neprevezie náklad kategórie '${category}'`);
    }
    const shipState = SHIP_STATES.find((candidate) => candidate === state);
    if (shipState === undefined || shipState === 'despawned') {
      throw new WorldStateError(`${path}/state`, `stav musí byť jeden z: ${SHIP_STATES.filter((s) => s !== 'despawned').join(', ')}, dostal ${describeValue(state)}`);
    }
    const x = checkCoordinate(entry['x'], map.width, `${path}/x`);
    const y = checkCoordinate(entry['y'], map.height, `${path}/y`);
    if (!isRotation(heading)) throw new WorldStateError(`${path}/heading`, `kurz musí byť 0, 90, 180 alebo 270, dostal ${describeValue(heading)}`);
    const traits = SHIP_STATE_TRAITS[shipState];
    const berthIds = checkIdList(entry['berthIds'], `${path}/berthIds`);
    if (traits.holdsBerths !== berthIds.length > 0) {
      throw new WorldStateError(`${path}/berthIds`, traits.holdsBerths ? `stav '${shipState}' vyžaduje kotviská` : `stav '${shipState}' nesmie držať kotviská`);
    }
    const rawAnchorage = entry['anchorageIndex'];
    const anchorageIndex = rawAnchorage === null ? null : checkInteger(rawAnchorage, 0, `${path}/anchorageIndex`);
    if (anchorageIndex !== null && !traits.waitsForBerth) {
      throw new WorldStateError(`${path}/anchorageIndex`, `stav '${shipState}' nesmie mať anchorage`);
    }
    if (anchorageIndex !== null && anchorageIndex >= map.anchorage.length) {
      throw new WorldStateError(`${path}/anchorageIndex`, `mapa '${map.id}' má ${String(map.anchorage.length)} buniek anchorage, dostal index ${String(anchorageIndex)}`);
    }
    const waypointIndex = checkInteger(entry['waypointIndex'], 0, `${path}/waypointIndex`);
    return { id: id as EntityId, classId, cargoTypeId, state: shipState, x, y, heading, berthIds, anchorageIndex, waypointIndex };
  });
}

/** Trasa vozidla: neprázdny zoznam indexov buniek v mape, susedné za sebou (4-susednosť). */
function parseRoute(value: unknown, path: string, grid: Grid): number[] {
  const route = checkArray(value, path).map((raw: unknown, i) => {
    const cell = checkInteger(raw, 0, `${path}${pointerSegment(i)}`);
    if (cell >= grid.cellCount) throw new WorldStateError(`${path}${pointerSegment(i)}`, `index bunky musí byť 0…${String(grid.cellCount - 1)}, dostal ${String(cell)}`);
    return cell;
  });
  if (route.length === 0) throw new WorldStateError(path, 'trasa musí obsahovať aspoň bunku vozidla');
  for (let i = 1; i < route.length; i++) {
    const a = grid.coordOf(route[i - 1]);
    const b = grid.coordOf(route[i]);
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) {
      throw new WorldStateError(`${path}${pointerSegment(i)}`, `bunka ${String(route[i])} nesusedí s predchádzajúcou ${String(route[i - 1])}`);
    }
  }
  return route;
}

/**
 * Tvar vozidiel: presne kľúče `SerializedVehicle`, id celé 1…`nextId − 1` a ostro rastúce (poradie nákupu = poradie
 * v depe), známy def, `depotId` celé ≥ 1, stav z `VEHICLE_STATES`, platný kurz, `jobId` `null` alebo celé ≥ 1
 * a zodpovedajúci stavu (`VEHICLE_STATE_TRAITS.hasJob`), `purchaseCostCents` celé ≥ 0, trasa (`parseRoute`), progres
 * v `[0, 1)` (> 0 len s ďalšou bunkou), `waitTicks` celé ≥ 0, `replan` boolean; poloha `x`, `y` = poloha na trase
 * (`vehiclePosition`). Tvar trasy, odpočet a príznak podľa stavu, depo, job, náklad a cesty pod trasou overí obnova
 * (`restoreEntities`, `vehicleMotionProblem`).
 */
function parseVehicles(value: unknown, defs: DefRegistry, map: LoadedMap, grid: Grid, nextId: number): ParsedVehicleEntry[] {
  let previousId = 0;
  return checkArray(value, '/vehicles').map((raw: unknown, i): ParsedVehicleEntry => {
    const path = `/vehicles${pointerSegment(i)}`;
    const entry = checkKeys(raw, SERIALIZED_VEHICLE_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    if (id <= previousId) throw new WorldStateError(`${path}/id`, `vozidlá musia byť vzostupne podľa id (poradie nákupu), ${String(id)} ≤ ${String(previousId)}`);
    previousId = id;
    const { defId, state, heading } = entry;
    if (typeof defId !== 'string' || !defs.vehicles.has(defId)) throw new WorldStateError(`${path}/defId`, `neznáme vozidlo ${describeValue(defId)}`);
    const depotId = checkInteger(entry['depotId'], 1, `${path}/depotId`);
    if (!isVehicleState(state)) {
      throw new WorldStateError(`${path}/state`, `stav musí byť jeden z: ${VEHICLE_STATES.join(', ')}, dostal ${describeValue(state)}`);
    }
    const x = checkCoordinate(entry['x'], map.width, `${path}/x`);
    const y = checkCoordinate(entry['y'], map.height, `${path}/y`);
    if (!isRotation(heading)) throw new WorldStateError(`${path}/heading`, `kurz musí byť 0, 90, 180 alebo 270, dostal ${describeValue(heading)}`);
    const rawJob = entry['jobId'];
    const jobId = rawJob === null ? null : checkInteger(rawJob, 1, `${path}/jobId`);
    if (VEHICLE_STATE_TRAITS[state].hasJob !== (jobId !== null)) {
      throw new WorldStateError(`${path}/jobId`, VEHICLE_STATE_TRAITS[state].hasJob ? `stav '${state}' vyžaduje job` : `stav '${state}' nesmie mať job`);
    }
    const purchaseCostCents = checkInteger(entry['purchaseCostCents'], 0, `${path}/purchaseCostCents`);
    const route = parseRoute(entry['route'], `${path}/route`, grid);
    const progress = entry['progress'];
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress >= 1) {
      throw new WorldStateError(`${path}/progress`, `musí byť číslo v [0, 1), dostal ${describeValue(progress)}`);
    }
    if (progress > 0 && route.length < 2) throw new WorldStateError(`${path}/progress`, `progres ${String(progress)} bez ďalšej bunky na trase`);
    const waitTicks = checkInteger(entry['waitTicks'], 0, `${path}/waitTicks`);
    const replan = entry['replan'];
    if (typeof replan !== 'boolean') throw new WorldStateError(`${path}/replan`, `musí byť boolean, dostal ${describeValue(replan)}`);
    const expected = vehiclePosition(route[0], route[1], progress, grid.width);
    if (expected.x !== x || expected.y !== y) {
      throw new WorldStateError(`${path}/x`, `poloha (${String(x)}, ${String(y)}) nie je na trase — očakávaná (${String(expected.x)}, ${String(expected.y)})`);
    }
    return { id: id as EntityId, defId, depotId: depotId as EntityId, state, x, y, heading, jobId: jobId as EntityId | null, purchaseCostCents, route, progress, waitTicks, replan };
  });
}

/** Progres úseku zo save: číslo v `[0, 1)`, `> 0` len s ďalšou bunkou trasy. */
function checkProgress(value: unknown, route: readonly number[], path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new WorldStateError(path, `musí byť číslo v [0, 1), dostal ${describeValue(value)}`);
  }
  if (value > 0 && route.length < 2) throw new WorldStateError(path, `progres ${String(value)} bez ďalšej bunky na trase`);
  return value;
}

/**
 * Tvar kamiónov (ADR-024): presne kľúče `SerializedTruck`, id celé 1…`nextId − 1` a ostro rastúce (poradie spawnu),
 * známy def z `trucks.json`, stav z `TRUCK_STATES` okrem `exited`, platný kurz, `rampId` / `gateId` / `waitingAreaId`
 * celé ≥ 1, `dock` celé ≥ 0, `resume` jazdný stav práve v `no_path`, `bay` celé ≥ 0 práve v stavoch s `holdsBay`
 * (v `no_path` podľa `resume`), trasa (`parseRoute`), progres v `[0, 1)` (> 0 len s ďalšou bunkou), `waitTicks` celé ≥ 0,
 * `replan` boolean, poloha = poloha na trase. Moduly, bay, dock, fronta brány, náklad a cesty overí obnova.
 */
function parseTrucks(value: unknown, defs: DefRegistry, map: LoadedMap, grid: Grid, nextId: number): ParsedTruckEntry[] {
  let previousId = 0;
  return checkArray(value, '/trucks').map((raw: unknown, i): ParsedTruckEntry => {
    const path = `/trucks${pointerSegment(i)}`;
    const entry = checkKeys(raw, SERIALIZED_TRUCK_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    if (id <= previousId) throw new WorldStateError(`${path}/id`, `kamióny musia byť vzostupne podľa id (poradie spawnu), ${String(id)} ≤ ${String(previousId)}`);
    previousId = id;
    const { defId, state, heading, resume } = entry;
    if (typeof defId !== 'string' || !defs.trucks.has(defId)) throw new WorldStateError(`${path}/defId`, `neznámy kamión ${describeValue(defId)}`);
    if (!isTruckState(state) || state === 'exited') {
      throw new WorldStateError(`${path}/state`, `stav musí byť jeden z: ${TRUCK_STATES.filter((s) => s !== 'exited').join(', ')}, dostal ${describeValue(state)}`);
    }
    const x = checkCoordinate(entry['x'], map.width, `${path}/x`);
    const y = checkCoordinate(entry['y'], map.height, `${path}/y`);
    if (!isRotation(heading)) throw new WorldStateError(`${path}/heading`, `kurz musí byť 0, 90, 180 alebo 270, dostal ${describeValue(heading)}`);
    const rampId = checkInteger(entry['rampId'], 1, `${path}/rampId`);
    const dock = checkInteger(entry['dock'], 0, `${path}/dock`);
    const gateId = checkInteger(entry['gateId'], 1, `${path}/gateId`);
    const waitingAreaId = checkInteger(entry['waitingAreaId'], 1, `${path}/waitingAreaId`);
    if (state === 'no_path' ? !isTruckTravelState(resume) : resume !== null) {
      throw new WorldStateError(`${path}/resume`, state === 'no_path' ? `stav no_path vyžaduje jeden z: ${TRUCK_TRAVEL_STATES.join(', ')}` : `stav '${state}' musí mať resume null`);
    }
    const effective: TruckState = isTruckTravelState(resume) ? resume : state;
    const rawBay = entry['bay'];
    const bay = rawBay === null ? null : checkInteger(rawBay, 0, `${path}/bay`);
    if (TRUCK_STATE_TRAITS[effective].holdsBay !== (bay !== null)) {
      throw new WorldStateError(`${path}/bay`, TRUCK_STATE_TRAITS[effective].holdsBay ? `stav '${effective}' vyžaduje bay` : `stav '${effective}' nesmie držať bay`);
    }
    const route = parseRoute(entry['route'], `${path}/route`, grid);
    const progress = checkProgress(entry['progress'], route, `${path}/progress`);
    const waitTicks = checkInteger(entry['waitTicks'], 0, `${path}/waitTicks`);
    const replan = entry['replan'];
    if (typeof replan !== 'boolean') throw new WorldStateError(`${path}/replan`, `musí byť boolean, dostal ${describeValue(replan)}`);
    const expected = vehiclePosition(route[0], route[1], progress, grid.width);
    if (expected.x !== x || expected.y !== y) {
      throw new WorldStateError(`${path}/x`, `poloha (${String(x)}, ${String(y)}) nie je na trase — očakávaná (${String(expected.x)}, ${String(expected.y)})`);
    }
    return {
      id: id as EntityId,
      defId,
      state,
      x,
      y,
      heading,
      rampId: rampId as EntityId,
      dock,
      gateId: gateId as EntityId,
      waitingAreaId: waitingAreaId as EntityId,
      bay,
      resume: isTruckTravelState(resume) ? resume : null,
      route,
      progress,
      waitTicks,
      replan,
    };
  });
}

/** Lokácia jobu v kanonickom tvare (`normalizeLocation`) s držiteľom; inak `WorldStateError` s cestou v nej. */
function parseJobLocation(value: unknown, path: string): CargoLocation {
  const normalized = normalizeLocation(value);
  if (!normalized.ok) throw new WorldStateError(`${path}${normalized.path}`, normalized.problem);
  if (normalized.location.kind === 'exported') throw new WorldStateError(`${path}/kind`, 'lokácia jobu musí mať držiteľa (exported ho nemá)');
  return normalized.location;
}

/**
 * Tvar jobov (ADR-018): presne kľúče `SerializedJob`, id celé 1…`nextId − 1` a ostro rastúce (poradie vzniku),
 * `unitIds` neprázdny zoznam jedinečných id, `from`/`to` lokácie s držiteľom s dvojicou druhov z `JOB_ROUTES`, cieľ
 * s jedinečným slotom len pre jednu jednotku, `createdTick` celé 0…`clock.tick`. Stav, vozidlo, polohu jednotiek
 * a sklad overí obnova (`restoreEntities`).
 */
function parseJobs(value: unknown, nextId: number, tick: number): ParsedJobEntry[] {
  let previousId = 0;
  return checkArray(value, '/jobs').map((raw: unknown, i): ParsedJobEntry => {
    const path = `/jobs${pointerSegment(i)}`;
    const entry = checkKeys(raw, SERIALIZED_JOB_KEYS, path);
    const id = checkInteger(entry['id'], 1, `${path}/id`);
    if (id >= nextId) throw new WorldStateError(`${path}/id`, `id ${String(id)} musí byť menšie ako ids.nextId ${String(nextId)}`);
    if (id <= previousId) throw new WorldStateError(`${path}/id`, `joby musia byť vzostupne podľa id (poradie vzniku), ${String(id)} ≤ ${String(previousId)}`);
    previousId = id;
    const unitIds = checkIdList(entry['unitIds'], `${path}/unitIds`);
    if (unitIds.length === 0) throw new WorldStateError(`${path}/unitIds`, 'job musí mať aspoň jednu jednotku');
    const from = parseJobLocation(entry['from'], `${path}/from`);
    const to = parseJobLocation(entry['to'], `${path}/to`);
    if (!isJobRoute(from.kind, to.kind)) throw new WorldStateError(`${path}/to/kind`, `job ${from.kind} → ${to.kind} nie je povolený (JOB_ROUTES)`);
    if (uniqueSlotOf(to) !== null && unitIds.length !== 1) {
      throw new WorldStateError(`${path}/unitIds`, `cieľ ${to.kind} je jeden jedinečný slot, job má ${String(unitIds.length)} jednotiek`);
    }
    const createdTick = checkInteger(entry['createdTick'], 0, `${path}/createdTick`);
    if (createdTick > tick) throw new WorldStateError(`${path}/createdTick`, `tick vzniku ${String(createdTick)} je po aktuálnom ${String(tick)}`);
    return { id: id as EntityId, unitIds, from, to, createdTick };
  });
}

/** Id entít zdieľajú jeden alokátor — modul, loď, vozidlo, job a jednotka nákladu nesmú mať rovnaké id. */
function checkIdCollisions(
  modules: readonly ParsedModuleEntry[],
  ships: readonly ParsedShipEntry[],
  vehicles: readonly ParsedVehicleEntry[],
  jobs: readonly ParsedJobEntry[],
  trucks: readonly ParsedTruckEntry[],
  cargo: CargoLedgerState,
): void {
  const owners = new Map<number, string>(modules.map((entry) => [entry.id, 'modulu'] as const));
  ships.forEach((ship, i) => {
    if (owners.has(ship.id)) throw new WorldStateError(`/ships${pointerSegment(i)}/id`, `id ${String(ship.id)} už patrí modulu (id entít sú jedinečné)`);
    owners.set(ship.id, 'lodi');
  });
  vehicles.forEach((vehicle, i) => {
    const owner = owners.get(vehicle.id);
    if (owner !== undefined) throw new WorldStateError(`/vehicles${pointerSegment(i)}/id`, `id ${String(vehicle.id)} už patrí ${owner} (id entít sú jedinečné)`);
    owners.set(vehicle.id, 'vozidlu');
  });
  jobs.forEach((job, i) => {
    const owner = owners.get(job.id);
    if (owner !== undefined) throw new WorldStateError(`/jobs${pointerSegment(i)}/id`, `id ${String(job.id)} už patrí ${owner} (id entít sú jedinečné)`);
    owners.set(job.id, 'jobu');
  });
  trucks.forEach((truck, i) => {
    const owner = owners.get(truck.id);
    if (owner !== undefined) throw new WorldStateError(`/trucks${pointerSegment(i)}/id`, `id ${String(truck.id)} už patrí ${owner} (id entít sú jedinečné)`);
    owners.set(truck.id, 'kamiónu');
  });
  cargo.units.forEach((unit, i) => {
    const owner = owners.get(unit.id);
    if (owner !== undefined) {
      throw new WorldStateError(`/cargo/units${pointerSegment(i)}/id`, `id ${String(unit.id)} už patrí ${owner} (id entít sú jedinečné)`);
    }
  });
}

/**
 * Overí `raw` ako `WorldState` **aktuálnej** verzie (staršie najprv prevedie `migrateWorldState`) pre danú mapu
 * a defy a obnoví jadrové objekty. Kontroly v poradí kľúčov: tvar (presne kľúče v4), `version`, `mapId === map.id`,
 * `seed` uint32, `rng` (4× uint32, nie nulový), `clock` (tick ≥ 0, rýchlosť v `time.speeds`), `ids`, `cashCents`
 * (bezpečné celé číslo), `roads` (index v mape, vrstva, bez duplicít, terén unesie cestu, typ a smer cesty v kanonickom
 * tvare — ADR-020), `traffic` (index v mape,
 * bez duplicít, hodnota > 0), `parcels` (presne parcely mapy, platné vlastníctvo, `leased` len pri `leasable`),
 * `modules` (tvar), `cargo` (`parseCargoLedgerState`), `ships` (tvar, `parseShips`), `vehicles` (tvar,
 * `parseVehicles`), `jobs` (tvar, `parseJobs`), `trucks` (tvar, `parseTrucks`), id modulov, lodí, vozidiel, jobov,
 * kamiónov a nákladu sa neprekrývajú.
 * Vstup sa nemení a výsledok s ním nezdieľa meniteľné objekty.
 *
 * `grid` je mriežka počiatočného stavu tej istej mapy (`map.createGrid()`) — z nej sa overuje terén pod cestami;
 * nemení sa.
 */
export function parseWorldState(raw: unknown, defs: DefRegistry, map: LoadedMap, grid: Grid): ParsedWorldState {
  const state = checkKeys(raw, WORLD_STATE_KEYS, '');
  if (state.version !== WORLD_STATE_VERSION) {
    throw new WorldStateError('/version', `nepodporovaná verzia ${describeValue(state.version)} (očakávaná ${String(WORLD_STATE_VERSION)})`);
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
  const { nextId } = ids.getState();

  const { cashCents } = state;
  if (typeof cashCents !== 'number' || !Number.isSafeInteger(cashCents)) {
    throw new WorldStateError('/cashCents', `musí byť bezpečné celé číslo (centy), dostal ${describeValue(cashCents)}`);
  }
  const roads = parseRoads(state.roads, grid);
  const traffic = parseTraffic(state.traffic, grid);
  const ownership = parseParcels(state.parcels, map);
  const modules = parseModules(state.modules, defs, nextId);
  const cargo = parseCargo(state.cargo, defs, nextId);
  const ships = parseShips(state.ships, defs, map, nextId);
  const vehicles = parseVehicles(state.vehicles, defs, map, grid, nextId);
  const jobs = parseJobs(state.jobs, nextId, clock.tick);
  const trucks = parseTrucks(state.trucks, defs, map, grid, nextId);
  checkIdCollisions(modules, ships, vehicles, jobs, trucks, cargo);
  return { seed, clock, rng, ids, cashCents, roads, traffic, ownership, modules, cargo, ships, vehicles, jobs, trucks };
}
