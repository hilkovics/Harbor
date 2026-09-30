/**
 * Serializovaný stav sveta (ARCHITECTURE §14; ADR-013, ADR-014): čistý JSON bez tried — `JSON.parse(JSON.stringify(s))`
 * je hlboko rovný `s`. Statické dáta mapy (terén, `depthClass`, `parcelId`, geometria a ceny parciel) sa neukladajú;
 * pri načítaní ich dodá `LoadedMap` s rovnakým `mapId`.
 *
 * v2 = v1 + `traffic`, `modules`, `cargo`, `ships`. Ukladá sa len to, čo sa nedá odvodiť: `cell.moduleId` vznikne
 * z footprintov modulov, obsadenie apronov a skladov a držané jednotky žeriavov z ledgera, rezervácie slotov apronu
 * z `reservedSlot` žeriavov a skupiny kotvísk prepočtom. Sklad (T03-02, ADR-017) ukladá v `runtime` len rezervácie
 * slotov a počítadlá `unitsIn`/`unitsOut`, depo `{}` (vozidlá depa sa odvodia z vozidiel, T03-04) — tvar `WorldState`
 * sa tým nemení, verzia ostáva 2 (v3 s vozidlami a jobmi príde v T03-04/T03-05). Staršie verzie prevedie
 * `migrateWorldState` (migrate.ts).
 *
 * Lode (ADR-016) sa ukladajú s polohou, stavom FSM, kotviskami, anchorage a indexom bodu trasy; trasa sa odvodí zo stavu
 * a mapy, `BerthModule.dockedShipId` z `berthIds`.
 *
 * `parseWorldState` overí tvar a hodnoty (fail-fast, `WorldStateError` s JSON pointerom); vzťahy medzi modulmi,
 * nákladom a loďami overí pri obnove `restoreEntities` (world-restore.ts).
 */
import { parseCargoLedgerState, type CargoLedgerState } from '../cargo/cargo-ledger-state';
import { CargoStateError } from '../cargo/cargo-error';
import { EntityIdAllocator, type EntityId, type EntityIdAllocatorState } from '../core/entity-id';
import { Rng, type RngState } from '../core/rng';
import { SimClock, type SimClockState } from '../core/sim-clock';
import type { DefRegistry } from '../defs/def-registry';
import type { Grid, RoadLayer } from '../grid/grid';
import type { PlacedModuleSpec } from '../grid/map-def';
import type { LoadedMap } from '../grid/map-loader';
import type { ParcelOwnership } from '../grid/parcel';
import { isRotation, type Rotation } from '../grid/rotation';
import { isRoadBuildable } from '../grid/terrain';
import type { ModuleRuntimeState } from '../modules/runtime-state';
import { SERIALIZED_SHIP_KEYS, type SerializedShip } from '../ships/ship';
import { SHIP_STATES, SHIP_STATE_TRAITS, type ShipState } from '../ships/ship-fsm';
import { WORLD_STATE_V1_KEYS, WORLD_STATE_VERSION } from './migrate';
import { WorldStateError, checkArray, checkInteger, checkKeys, describeValue, isPlainObject, pointerSegment } from './state-check';

export { WORLD_STATE_VERSION } from './migrate';
export { WorldStateError } from './state-check';

/** Vrstva dopravy v save — bunky s `road: 'none'` sa neukladajú. */
export type SerializedRoadLayer = Exclude<RoadLayer, 'none'>;

/** Bunka s cestou alebo koľajou: `[row-major index bunky, vrstva]`. */
export type SerializedRoad = readonly [index: number, layer: SerializedRoadLayer];

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

/** `WorldState` v1 (F1, ADR-013) — vstup migrácie. */
export interface WorldStateV1 {
  readonly version: 1;
  readonly mapId: string;
  readonly seed: number;
  readonly rng: RngState;
  readonly clock: SimClockState;
  readonly ids: EntityIdAllocatorState;
  readonly cashCents: number;
  readonly roads: readonly SerializedRoad[];
  readonly parcels: Readonly<Record<string, ParcelOwnership>>;
}

/** Aktuálny `WorldState` (v2). */
export interface WorldState extends Omit<WorldStateV1, 'version'> {
  readonly version: typeof WORLD_STATE_VERSION;
  /** Bunky s nenulovým `cell.traffic` vzostupne podľa indexu (vo F2 vždy prázdne; F3 vozidlá). */
  readonly traffic: readonly SerializedTraffic[];
  readonly modules: readonly SerializedModule[];
  /** Stav `CargoLedger` (`getState()`): len živé jednotky, exportované sú v `exportedCount` (ADR-014). */
  readonly cargo: CargoLedgerState;
  /** Lode vzostupne podľa id (`Ship.toState()`, ADR-016); `dockedShipId` kotvísk a trasy sa odvodia pri obnove. */
  readonly ships: readonly SerializedShip[];
}

/** Ľubovoľná podporovaná verzia (vstup `World.deserialize`). */
export type AnyWorldState = WorldState | WorldStateV1;

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

/** Overený stav pripravený na zostavenie `World` (jadrové objekty už vytvorené z uložených stavov). */
export interface ParsedWorldState {
  readonly seed: number;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  readonly cashCents: number;
  readonly roads: readonly SerializedRoad[];
  readonly traffic: readonly SerializedTraffic[];
  /** Vlastníctvo pre každú parcelu mapy. */
  readonly ownership: ReadonlyMap<string, ParcelOwnership>;
  /** Moduly v poradí save (= poradie umiestnenia). */
  readonly modules: readonly ParsedModuleEntry[];
  readonly cargo: CargoLedgerState;
  /** Lode vzostupne podľa id (= poradie spawnu). */
  readonly ships: readonly ParsedShipEntry[];
}

/** Kľúče v2 v poradí `serialize()`; iné kľúče sú chyba (stav nemá voliteľné polia). */
export const WORLD_STATE_KEYS: readonly (keyof WorldState)[] = [...WORLD_STATE_V1_KEYS, 'traffic', 'modules', 'cargo', 'ships'];
const CLOCK_KEYS: readonly (keyof SimClockState)[] = ['tick', 'speed'];
const IDS_KEYS: readonly (keyof EntityIdAllocatorState)[] = ['nextId'];
const MODULE_KEYS: readonly (keyof SerializedModule)[] = ['id', 'defId', 'x', 'y', 'rotation', 'purchaseCostCents', 'runtime'];

/** Tabuľky platných hodnôt — `Record` nad úniou vynúti úplnosť pri kompilácii. */
const SERIALIZED_ROAD_LAYERS: Readonly<Record<SerializedRoadLayer, true>> = { road: true, rail: true };
const PARCEL_OWNERSHIPS: Readonly<Record<ParcelOwnership, true>> = { none: true, owned: true, leased: true };

/** Dĺžka záznamu bunky `[index, hodnota]` (cesta aj traffic). */
const CELL_ENTRY_LENGTH = 2;

/** Validáciu rozsahov robia jadrové triedy (`RangeError`); tu sa ich chyba preloží na `WorldStateError` s cestou. */
function restore<T>(path: string, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) throw new WorldStateError(path, error.message);
    throw error;
  }
}

/** Záznam bunky `[index, hodnota]`: dvojica s platným indexom, bez duplicít (`seen`). Vráti hodnotu. */
function parseCellEntry(entry: unknown, path: string, grid: Grid, seen: Set<number>): readonly [number, unknown] {
  if (!Array.isArray(entry) || entry.length !== CELL_ENTRY_LENGTH) {
    throw new WorldStateError(path, 'musí byť dvojica [index bunky, hodnota]');
  }
  const [index, value] = entry as [unknown, unknown];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= grid.cellCount) {
    throw new WorldStateError(`${path}/0`, `index bunky musí byť celé číslo 0…${String(grid.cellCount - 1)}, dostal ${describeValue(index)}`);
  }
  if (seen.has(index)) throw new WorldStateError(`${path}/0`, `duplicitná bunka ${String(index)}`);
  seen.add(index);
  return [index, value];
}

/** `grid` = mriežka počiatočného stavu mapy (z `map.createGrid()`); číta sa z nej len statický terén. */
function parseRoads(value: unknown, grid: Grid): SerializedRoad[] {
  const seen = new Set<number>();
  return checkArray(value, '/roads').map((entry: unknown, i): SerializedRoad => {
    const path = `/roads${pointerSegment(i)}`;
    const [index, layer] = parseCellEntry(entry, path, grid, seen);
    if (typeof layer !== 'string' || !Object.hasOwn(SERIALIZED_ROAD_LAYERS, layer)) {
      throw new WorldStateError(`${path}/1`, `vrstva musí byť 'road' alebo 'rail', dostal ${describeValue(layer)}`);
    }
    const { terrain } = grid.atIndex(index);
    if (!isRoadBuildable(terrain)) {
      const { x, y } = grid.coordOf(index);
      throw new WorldStateError(`${path}/0`, `bunka (${String(x)}, ${String(y)}) má terén ${terrain}, cesta/koľaj tam nemôže byť`);
    }
    return [index, layer as SerializedRoadLayer];
  });
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

/** Id entít zdieľajú jeden alokátor — modul, loď a jednotka nákladu nesmú mať rovnaké id. */
function checkIdCollisions(modules: readonly ParsedModuleEntry[], ships: readonly ParsedShipEntry[], cargo: CargoLedgerState): void {
  const owners = new Map<number, string>(modules.map((entry) => [entry.id, 'modulu'] as const));
  ships.forEach((ship, i) => {
    if (owners.has(ship.id)) throw new WorldStateError(`/ships${pointerSegment(i)}/id`, `id ${String(ship.id)} už patrí modulu (id entít sú jedinečné)`);
    owners.set(ship.id, 'lodi');
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
 * a defy a obnoví jadrové objekty. Kontroly v poradí kľúčov: tvar (presne kľúče v2), `version`, `mapId === map.id`,
 * `seed` uint32, `rng` (4× uint32, nie nulový), `clock` (tick ≥ 0, rýchlosť v `time.speeds`), `ids`, `cashCents`
 * (bezpečné celé číslo), `roads` (index v mape, vrstva, bez duplicít, terén unesie cestu), `traffic` (index v mape,
 * bez duplicít, hodnota > 0), `parcels` (presne parcely mapy, platné vlastníctvo, `leased` len pri `leasable`),
 * `modules` (tvar), `cargo` (`parseCargoLedgerState`), `ships` (tvar, `parseShips`), id modulov, lodí a nákladu sa
 * neprekrývajú.
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
  checkIdCollisions(modules, ships, cargo);
  return { seed, clock, rng, ids, cashCents, roads, traffic, ownership, modules, cargo, ships };
}
