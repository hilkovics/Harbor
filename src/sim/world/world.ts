/**
 * World — koreň simulácie (ARCHITECTURE §5, §6). Vlastní hodiny, mriežku, parcely, hotovosť, jediný `Rng`,
 * alokátor ID, zbernicu udalostí, `CargoLedger`, moduly so skupinami kotvísk a lode; prezentácia ho len číta
 * a mení ho výlučne cez `Command` (pravidlo 5).
 *
 * Tick pipeline (§6): príkazy z fronty → krok 1 (`clock.advance()` + udalosti hraníc) → krok 3 (`ShipSystem`) →
 * krok 4 (`CraneSystem`) → krok 5 (`DispatcherSystem`) → krok 6 (`VehicleSystem`) → krok 11 (`MetricsSystem`, traffic)
 * → krok 12 (`assertInvariants()`, ak je zapnuté `checkInvariants`) → krok 13 (`events.flush()`). Ďalšie kroky pribúdajú so systémami na označenom mieste v `tick()`; poradie §6 je záväzné
 * a mení sa len cez ADR.
 *
 * Moduly (ADR-014): `addModule`/`removeModule` sú štrukturálne operácie pre príkazy (`PlaceModule`/`RemoveModule`,
 * T02-04) a obnovu zo save — zapisujú `cell.moduleId`, spravujú `craneIds` berthov a prepočítajú `berthGroups`.
 * Pravidlá umiestnenia (§8: terén, parcela, voda, cena) overuje príkaz vopred; tieto metódy strážia len
 * konzistenciu sveta a pri porušení vyhodia `ModuleError` bez zmeny stavu. Udalosti emituje príkaz.
 *
 * Lode (ADR-016): `addShip`/`removeShip` sú štrukturálne operácie pre `SpawnShipDebug`, `ShipSystem` a obnovu zo save;
 * pohyb, kotviská a FSM riadi `ShipSystem`.
 *
 * Vozidlá (T03-04, T03-06): `addVehicle`/`removeVehicle` sú štrukturálne operácie pre `BuyVehicle`/`SellVehicle` a obnovu
 * zo save — spravujú aj `VehicleDepot.vehicleIds`; FSM, pohyb a load/unload riadi `VehicleSystem` (krok 6, ADR-019).
 * `vehicleOnCell` hovorí, či bunku zaberá vozidlo (`RemoveRoad` → `occupied`).
 *
 * Joby (T03-05, ADR-018): `addJob`/`removeJob` sú štrukturálne operácie pre dispatcher (krok 5), `VehicleSystem`
 * a obnovu zo save; `jobOfUnit` je index jednotka → aktívny job (odvodený, neukladá sa).
 *
 * Sklady a depá (ADR-017): moduly vznikajú s ledgerom na čítanie (`ModuleEnv.cargo`) — apron a sklad držia len
 * rezervácie, obsadenie čítajú z `cargo`. Pripojenie modulu k ceste (`isConnected`, `connectorCells`) sa počíta
 * z mriežky pri každom volaní.
 *
 * Cestná sieť (T03-03): `roadVersion` je počítadlo zmien vrstvy ciest (`markRoadsChanged` volá `PlaceRoad`/`RemoveRoad`
 * a `deserialize`); `pathfinder` (A*), `paths` (`PathCache`) a `distances` (`DistanceMatrix`) vznikajú lenivo pri prvom
 * použití a cache sa pri zmene `roadVersion` samy vyprázdnia — bez odberu udalostí. Nič z toho nie je v save.
 * `markRoadsChanged` zároveň označí jazdiace vozidlá na preplánovanie (`Vehicle.replanPending`, ide do save — ADR-019).
 * Typy ciest (T03-18, ADR-020): prestavba typu alebo smeru bunky je tiež zmena siete (`markRoadsChanged`); A* ide po
 * smerových hranách s cenou bunky `roadSpeeds.cellCost` (= 1 / `speedFactor`) a vozidlá jazdia rýchlosťou
 * `roadSpeeds.speedFactor` cieľovej bunky úseku.
 */
import { CargoLedger } from '../cargo/cargo-ledger';
import type { CargoLedgerState } from '../cargo/cargo-ledger-state';
import { isSameLocation } from '../cargo/cargo-location';
import { EntityIdAllocator, type EntityId } from '../core/entity-id';
import { EventBus } from '../core/event-bus';
import { INITIAL_SPEED, SimClock, type ClockBoundaries } from '../core/sim-clock';
import { Rng } from '../core/rng';
import type { Command } from '../commands/command';
import { DefError, type DefRegistry } from '../defs/def-registry';
import type { SimEvent } from '../events/sim-event';
import type { Grid } from '../grid/grid';
import { DEFAULT_ROAD_KIND } from '../grid/road-kind';
import type { PlacedModuleSpec } from '../grid/map-def';
import { MapError, pointerSegment } from '../grid/map-error';
import type { LoadedMap } from '../grid/map-loader';
import type { Parcel, ParcelOwnership } from '../grid/parcel';
import { BerthModule } from '../modules/berth-module';
import { computeBerthGroups, type BerthGroup } from '../modules/berth-group';
import { CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';
import { ModuleError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import { VehicleDepot } from '../modules/vehicle-depot';
import type { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import { DistanceMatrix } from '../logistics/distance-matrix';
import { JobError } from '../logistics/job-error';
import { PathCache } from '../logistics/path-cache';
import { Pathfinder } from '../logistics/pathfinder';
import { RoadSpeeds } from '../logistics/road-speed';
import { JOB_STATE_TRAITS, type TransportJob } from '../logistics/transport-job';
import { CraneSystem } from '../systems/crane-system';
import { DispatcherSystem } from '../systems/dispatcher-system';
import { MetricsSystem } from '../systems/metrics-system';
import { VehicleSystem } from '../systems/vehicle-system';
import { ShipSystem } from '../systems/ship-system';
import { StatResolver } from '../tech/stat-resolver';
import type { Vehicle } from '../vehicles/vehicle';
import { VehicleError } from '../vehicles/vehicle-error';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';
import { connectorCellsOf, isModuleConnected, type ConnectorCell } from './connectivity';
import { migrateWorldState } from './migrate';
import { PLACEMENT_RULE_ERROR, attachesToHost, findPlacementViolations, findRemovalViolations } from './module-rules';
import { WorldInvariantError, findWorldViolation } from './world-invariants';
import { restoreEntities } from './world-restore';
import {
  WORLD_STATE_VERSION,
  parseWorldState,
  serializeRoad,
  type AnyWorldState,
  type SerializedModule,
  type SerializedRoad,
  type SerializedTraffic,
  type WorldState,
} from './world-state';

/** Všetko, z čoho sa svet skladá — spoločné pre `create` aj `deserialize`. */
interface WorldParts {
  readonly defs: DefRegistry;
  readonly map: LoadedMap;
  readonly seed: number;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  readonly grid: Grid;
  readonly parcels: ReadonlyMap<string, Parcel>;
  readonly cashCents: number;
  /** Uložený stav ledgera (overený `parseWorldState`); `null` = prázdny ledger novej hry. */
  readonly cargo: CargoLedgerState | null;
}

/** Voľby sveta pri `World.create` / `World.deserialize` (nie sú súčasťou save). */
export interface WorldOptions {
  /**
   * Krok 12 ticku (§6): `assertInvariants()` po každom ticku. Predvolene `true` (testy, `simrun`, DEV); aplikácia
   * v produkcii ho vypne (`false`) kvôli výkonu (ADR-016).
   */
  readonly checkInvariants?: boolean;
}

/** Nezávislé kópie parciel mapy (meniteľné `ownership`); geometria je zmrazená, takže `rect` sa môže zdieľať. */
function copyParcels(map: LoadedMap): Map<string, Parcel> {
  return new Map(
    map.parcels.map((parcel): [string, Parcel] => [
      parcel.id,
      { id: parcel.id, rect: parcel.rect, priceCents: parcel.priceCents, leasable: parcel.leasable, ownership: parcel.ownership },
    ]),
  );
}

const NO_GROUPS: readonly BerthGroup[] = Object.freeze([]);

/**
 * Posledný kľúč mapy v poradí vloženia — pri vzostupnom vkladaní najväčšie prítomné id; prázdna mapa → `undefined`.
 * O(n), preto len pri odstránení doteraz posledného vozidla/jobu (`lastVehicleId`, `lastJobId`).
 */
function lastKeyOf(map: ReadonlyMap<EntityId, unknown>): EntityId | undefined {
  let last: EntityId | undefined;
  for (const key of map.keys()) last = key;
  return last;
}


export class World {
  readonly defs: DefRegistry;
  /** Načítaná mapa — len na čítanie; počiatočný stav mriežky dáva `map.createGrid()`, živá mriežka sveta je `grid`. */
  readonly map: LoadedMap;
  /** Seed novej hry (uint32); ďalší priebeh určuje stav `rng`. */
  readonly seed: number;
  readonly clock: SimClock;
  /** Vlastná mriežka z `map.createGrid()` — menia ju len príkazy a systémy tohto sveta. */
  readonly grid: Grid;
  /** Parcely v poradí mapy; meniteľné je len `ownership` (príkazy kúpy/prenájmu). */
  readonly parcels: ReadonlyMap<string, Parcel>;
  /** Jediný zdroj náhody simulácie (pravidlo 3). */
  readonly rng: Rng;
  readonly ids: EntityIdAllocator;
  /** Udalosti aktuálneho ticku; príkazy a systémy volajú `emit`, `tick()`/`applyPending()` ich vrátia. */
  readonly events = new EventBus<SimEvent>();
  /** Jediný zdroj polohy nákladu (§7.1, pravidlo 2): id jednotiek z `ids`, `CargoMoved` do `events` s `clock.tick`. */
  readonly cargo: CargoLedger;
  /** Moduly v poradí umiestnenia (= vzostupne podľa id); meniť len cez `addModule`/`removeModule`. */
  readonly modules: ReadonlyMap<EntityId, Module>;
  /** Lode vzostupne podľa id (= poradie spawnu); meniť len cez `addShip`/`removeShip`. */
  readonly ships: ReadonlyMap<EntityId, Ship>;
  /** Vozidlá vzostupne podľa id (= poradie nákupu); meniť len cez `addVehicle`/`removeVehicle`. */
  readonly vehicles: ReadonlyMap<EntityId, Vehicle>;
  /** Aktívne transportné joby vzostupne podľa id (= poradie vzniku); meniť len cez `addJob`/`removeJob` (ADR-018). */
  readonly jobs: ReadonlyMap<EntityId, TransportJob>;
  /** Štatistiky entít po modifikátoroch (§10); vo F2 základ z defov. */
  readonly stats: StatResolver;
  /**
   * Rýchlostný faktor a cena bunky podľa typu cesty (`infrastructure.roadKinds`, ADR-020) nad `grid` — A* (`pathfinder`)
   * aj pohyb vozidiel (`VehicleSystem`) čítajú typ bunky pri každom volaní.
   */
  readonly roadSpeeds: RoadSpeeds;
  /** Hotovosť v centoch (USD); môže byť záporná (bankrot rieši F5). */
  cashCents: number;
  /** Krok 12 ticku zapnutý (`WorldOptions.checkInvariants`, predvolene `true`). */
  readonly checkInvariants: boolean;

  private readonly pendingCommands: Command[] = [];
  private readonly moduleMap = new Map<EntityId, Module>();
  private readonly shipMap = new Map<EntityId, Ship>();
  private readonly vehicleMap = new Map<EntityId, Vehicle>();
  private readonly jobMap = new Map<EntityId, TransportJob>();
  /** Jednotka → jej aktívny job (odvodený index nad `jobMap`). */
  private readonly unitJobs = new Map<EntityId, TransportJob>();
  /** Najväčšie id vo `vehicleMap` / `jobMap` (= posledné vložené; poradie pridania = vzostupne podľa id) bez prechodu kľúčov. */
  private lastVehicleId: EntityId | undefined;
  private lastJobId: EntityId | undefined;
  private groups: readonly BerthGroup[] = NO_GROUPS;
  private readonly shipSystem = new ShipSystem();
  private readonly craneSystem = new CraneSystem();
  private readonly dispatcherSystem = new DispatcherSystem();
  private readonly vehicleSystem = new VehicleSystem();
  private readonly metricsSystem = new MetricsSystem();
  private roadChanges = 0;
  private pathfinderInstance: Pathfinder | undefined;
  private pathCache: PathCache | undefined;
  private distanceMatrix: DistanceMatrix | undefined;

  private constructor(parts: WorldParts, options: WorldOptions) {
    this.defs = parts.defs;
    this.map = parts.map;
    this.seed = parts.seed;
    this.clock = parts.clock;
    this.rng = parts.rng;
    this.ids = parts.ids;
    this.grid = parts.grid;
    this.parcels = parts.parcels;
    this.cashCents = parts.cashCents;
    const deps = { cargoTypes: parts.defs.cargoTypes, ids: parts.ids, events: this.events, clock: parts.clock };
    this.cargo = parts.cargo === null ? new CargoLedger(deps) : CargoLedger.fromState(parts.cargo, deps);
    this.modules = this.moduleMap;
    this.ships = this.shipMap;
    this.vehicles = this.vehicleMap;
    this.jobs = this.jobMap;
    this.stats = new StatResolver(parts.defs);
    this.roadSpeeds = new RoadSpeeds(parts.grid, parts.defs.infrastructure.roadKinds);
    this.checkInvariants = options.checkInvariants ?? true;
  }

  /**
   * Nová hra: tick 0 pri rýchlosti `INITIAL_SPEED`, hotovosť `economy.startingCashCents`, `Rng(seed)`, ID od 1,
   * mriežka = nová `map.createGrid()` (so starter cestami), parcely skopírované (`startOwned` → `owned`) a starter
   * moduly mapy (Root modul, ADR-015) umiestnené v poradí mapy s `purchaseCostCents 0` — rovnakými pravidlami ako
   * `PlaceModule` okrem ceny, bez udalostí a bez zmeny hotovosti (dostanú id 1, 2, …).
   * `options.checkInvariants` (predvolene `true`) zapína krok 12 ticku.
   * Chyby: seed nie je uint32 → `RangeError`; `INITIAL_SPEED` chýba v `time.speeds` → `DefError`; starter modul
   * s neznámym defom alebo porušeným pravidlom umiestnenia → `MapError` s cestou `/starter/modules/<i>`.
   */
  static create(defs: DefRegistry, map: LoadedMap, seed: number, options: WorldOptions = {}): World {
    const rng = new Rng(seed);
    const clock = new SimClock(defs.time);
    if (!defs.time.speeds.includes(clock.speed)) {
      throw new DefError('time', '/speeds', `musí obsahovať počiatočnú rýchlosť ${String(INITIAL_SPEED)} (World.create)`);
    }
    const world = new World(
      {
        defs,
        map,
        seed,
        clock,
        rng,
        ids: new EntityIdAllocator(),
        grid: map.createGrid(),
        parcels: copyParcels(map),
        cashCents: defs.economy.startingCashCents,
        cargo: null,
      },
      options,
    );
    world.placeStarterModules();
    return world;
  }

  /**
   * Obnoví svet zo `serialize()` (aj po `JSON.parse`); staršiu verziu najprv prevedie `migrateWorldState` (v1 → v2:
   * bez modulov, lodí a nákladu; v2 → v3: bez vozidiel a jobov, `runtime` skladu bez rezervácií, kotviska s
   * `lastNoStorageHour`). Terén a parcely berie z `map` (musí mať
   * `id === state.mapId`), vrstvu dopravy celú z `state.roads` (aj typ a smer cesty, ADR-020) — starter cesta, ktorú hráč odstránil, sa neobnoví;
   * moduly, lode, vozidlá, náklad a odvodený stav obnoví `restoreEntities`. Neplatný stav → `WorldStateError` (pozri `parseWorldState`, `restoreEntities`). Výsledok
   * nezdieľa meniteľný stav so `state` ani s `map`. `options` ako pri `create`.
   */
  static deserialize(defs: DefRegistry, map: LoadedMap, state: AnyWorldState, options: WorldOptions = {}): World {
    const grid = map.createGrid();
    const parsed = parseWorldState(migrateWorldState(state, defs), defs, map, grid);
    for (let i = 0; i < grid.cellCount; i++) {
      const cell = grid.atIndex(i);
      cell.road = 'none';
      cell.roadKind = DEFAULT_ROAD_KIND;
      cell.roadDir = null;
    }
    for (const { index, layer, kind, dir } of parsed.roads) {
      const cell = grid.atIndex(index);
      cell.road = layer;
      cell.roadKind = kind;
      cell.roadDir = dir;
    }
    for (const [index, value] of parsed.traffic) grid.atIndex(index).traffic = value;
    const parcels = copyParcels(map);
    for (const [id, ownership] of parsed.ownership) {
      const parcel = parcels.get(id);
      if (parcel !== undefined) parcel.ownership = ownership;
    }
    const world = new World(
      {
        defs,
        map,
        seed: parsed.seed,
        clock: parsed.clock,
        rng: parsed.rng,
        ids: parsed.ids,
        grid,
        parcels,
        cashCents: parsed.cashCents,
        cargo: parsed.cargo,
      },
      options,
    );
    // Cesty prišli zo save — cache ciest vytvorené počas obnovy by patrili predchádzajúcemu stavu mriežky.
    world.markRoadsChanged();
    restoreEntities(world, parsed);
    return world;
  }

  /** Skupiny kotvísk (§5.4) v poradí id; prepočítajú sa pri každom `addModule`/`removeModule`. */
  get berthGroups(): readonly BerthGroup[] {
    return this.groups;
  }

  /**
   * Verzia cestnej siete: rastie pri každej zmene vrstvy ciest (`markRoadsChanged`). Význam má len zmena, nie hodnota
   * (neukladá sa; nový aj obnovený svet začínajú od svojej hodnoty) — `PathCache`/`DistanceMatrix` a plánovanie
   * vozidiel podľa nej zistia, že cesta mohla zaniknúť alebo vzniknúť.
   */
  get roadVersion(): number {
    return this.roadChanges;
  }

  /**
   * Zapíše zmenu cestnej siete (volá `PlaceRoad`/`RemoveRoad` po zápise `cell.road` / `roadKind` / `roadDir` —
   * aj prestavba typu alebo smeru, ADR-020 — a `deserialize` po obnove ciest). Kto mení tieto polia inou cestou, musí
   * ho zavolať tiež, inak cache ciest ostanú zastarané a vozidlá by jazdili po starej trase. Jazdiace vozidlá
   * (`motion: 'drive'`) dostanú `replanPending` — preplánujú v najbližšom kroku 6.
   */
  markRoadsChanged(): void {
    this.roadChanges += 1;
    for (const vehicle of this.vehicleMap.values()) {
      if (VEHICLE_STATE_TRAITS[vehicle.state].motion === 'drive') vehicle.replanPending = true;
    }
  }

  /**
   * A* nad cestami tohto sveta (§7.4) so smerovými hranami a cenou bunky podľa typu cesty (ADR-020); vznikne pri prvom
   * použití (pracovné polia pre celú mriežku).
   */
  get pathfinder(): Pathfinder {
    this.pathfinderInstance ??= new Pathfinder(this.grid, this.roadSpeeds.cellCost);
    return this.pathfinderInstance;
  }

  /** Cache ciest (`PathCache`) nad `pathfinder`, zneplatnená podľa `roadVersion`; vznikne pri prvom použití. */
  get paths(): PathCache {
    this.pathCache ??= new PathCache(this.pathfinder, this);
    return this.pathCache;
  }

  /**
   * Lazy matica cien ciest (`DistanceMatrix`) nad cestami z `paths` (cena = `routeCost` tej istej cesty, jeden A* na
   * dvojicu), zneplatnená podľa `roadVersion`.
   */
  get distances(): DistanceMatrix {
    this.distanceMatrix ??= new DistanceMatrix(this.paths, this);
    return this.distanceMatrix;
  }

  /** Počet príkazov čakajúcich vo fronte. */
  get pendingCommandCount(): number {
    return this.pendingCommands.length;
  }

  // -------------------------------------------------------------------------------------------------------
  // Moduly (ADR-014)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Postaví modul: nová inštancia z `moduleRegistry` s id z `ids` a zaplatenou cenou, potom `addModule`.
   * Pravidlá umiestnenia (§8) musí volajúci overiť vopred (`PlaceModule.validate`). Chyby: `ModuleError`
   * (svet sa nezmení, id sa môže spotrebovať) alebo `DefError` pre neznámy `defId`.
   */
  placeModule(spec: PlacedModuleSpec, purchaseCostCents: number): Module {
    const def = this.defs.modules.get(spec.defId);
    const module = moduleRegistry.create(def, spec, this.ids.next(), purchaseCostCents, { grid: this.grid, cargo: this.cargo });
    this.addModule(module);
    return module;
  }

  /**
   * Pridá hotový modul do sveta: zapíše `cell.moduleId` (pripájaný modul — žeriav — sa pripojí k berthu a bunky
   * ostávajú berthu) a prepočíta `berthGroups`. Štrukturálne chyby (`ModuleError`, svet sa nezmení): id už vo svete
   * alebo nepridelené alokátorom (`duplicate_id`, `invalid_input`) a prvé porušenie štrukturálnych pravidiel
   * umiestnenia z `findPlacementViolations` (rovnaká funkcia ako `PlaceModule.validate`): footprint mimo mapy
   * (`out_of_bounds`), bunka obsadená (`occupied`) alebo s cestou (`road`); žeriav nestojí celý na jednom berthe
   * (`no_berth`), iná rotácia (`rotation_mismatch`), berth má `maxCranes` (`max_cranes`), prekryv s iným žeriavom
   * (`crane_overlap`). Pravidlá hráča (terén, parcela, voda, cena) tu nie sú — tie overuje príkaz vopred.
   */
  addModule(module: Module): void {
    if (this.moduleMap.has(module.id)) throw new ModuleError('duplicate_id', `World.addModule: modul #${String(module.id)} už vo svete je`);
    if (module.id >= this.ids.getState().nextId) {
      throw new ModuleError('invalid_input', `World.addModule: id ${String(module.id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    const spec = { x: module.origin.x, y: module.origin.y, rotation: module.rotation };
    const [violation] = findPlacementViolations(this, module.def, spec, 'structural');
    const code = violation === undefined ? null : PLACEMENT_RULE_ERROR[violation.rule];
    if (violation !== undefined && code !== null) throw new ModuleError(code, `World.addModule: ${module.label}: ${violation.detail}`);
    if (attachesToHost(module.def)) {
      this.hostOf(module).attachCrane(module.id);
    } else {
      for (const { x, y } of module.cells) this.grid.at(x, y).moduleId = module.id;
    }
    this.moduleMap.set(module.id, module);
    this.refreshBerthGroups();
  }

  /**
   * Odstráni modul a vráti ho: uvoľní bunky (žeriav: odpojí sa od berthu) a prepočíta `berthGroups`. Príkaz
   * (`RemoveModule`) validuje dôvody vopred rovnakou funkciou `findRemovalViolations`; tu je poistka konzistencie
   * (`ModuleError` s kódom prvého porušenia, svet sa nezmení): neznáme id (`unknown_module`), modul s nákladom alebo
   * rezervovaným slotom (`has_cargo`), berth so žeriavmi (`has_cranes`), berth s loďou alebo žeriav na takom berthe
   * (`ship_docked`), žeriav mimo `idle`/`blocked` (`busy`).
   */
  removeModule(moduleId: EntityId): Module {
    const module = this.moduleMap.get(moduleId);
    if (module === undefined) throw new ModuleError('unknown_module', `World.removeModule: modul #${String(moduleId)} neexistuje`);
    const [violation] = findRemovalViolations(this, module);
    if (violation !== undefined) throw new ModuleError(violation.rule, `World.removeModule: ${violation.detail}`);
    if (attachesToHost(module.def)) {
      this.hostOf(module).detachCrane(module.id);
    } else {
      for (const { x, y } of module.cells) this.grid.at(x, y).moduleId = null;
    }
    this.moduleMap.delete(moduleId);
    this.refreshBerthGroups();
    return module;
  }

  // -------------------------------------------------------------------------------------------------------
  // Lode (ADR-016)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Pridá loď (spawn `SpawnShipDebug`, obnova zo save). Chyby (`ShipError`, svet sa nezmení): id už vo svete má loď,
   * modul, vozidlo alebo job (`duplicate_id`), id nepridelené alokátorom alebo menšie ako id poslednej lode — poradie spawnu = FIFO
   * alokácie kotvísk (`invalid_input`). Kotviská (`dockedShipId`) a náklad zapisuje volajúci.
   */
  addShip(ship: Ship): void {
    if (this.shipMap.has(ship.id) || this.moduleMap.has(ship.id) || this.vehicleMap.has(ship.id) || this.jobMap.has(ship.id)) {
      throw new ShipError('duplicate_id', `World.addShip: id ${String(ship.id)} už vo svete je`);
    }
    if (ship.id >= this.ids.getState().nextId) {
      throw new ShipError('invalid_input', `World.addShip: id ${String(ship.id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    let last: EntityId | undefined;
    for (const id of this.shipMap.keys()) last = id;
    if (last !== undefined && ship.id < last) {
      throw new ShipError('invalid_input', `World.addShip: ${ship.label} má menšie id ako posledná loď #${String(last)}`);
    }
    this.shipMap.set(ship.id, ship);
  }

  /**
   * Odstráni loď (odchod z mapy, `ShipSystem`) a vráti ju. Chyby (`ShipError`, svet sa nezmení): neznáme id
   * (`unknown_ship`), loď má na palube náklad — jednotky `on_ship` by stratili držiteľa (`has_cargo`), drží kotviská
   * (`holds_berths`).
   */
  removeShip(shipId: EntityId): Ship {
    const ship = this.shipMap.get(shipId);
    if (ship === undefined) throw new ShipError('unknown_ship', `World.removeShip: loď #${String(shipId)} neexistuje`);
    const aboard = this.cargo.countAt('on_ship', shipId);
    if (aboard > 0) throw new ShipError('has_cargo', `World.removeShip: ${ship.label} má na palube ${String(aboard)} jednotiek`);
    if (ship.berthIds.length > 0) throw new ShipError('holds_berths', `World.removeShip: ${ship.label} drží kotviská [${ship.berthIds.join(', ')}]`);
    this.shipMap.delete(shipId);
    return ship;
  }

  // -------------------------------------------------------------------------------------------------------
  // Vozidlá (T03-04)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Pridá vozidlo (nákup `BuyVehicle`, obnova zo save) a pripojí ho k depu (`VehicleDepot.attachVehicle`). Chyby
   * (`VehicleError`, svet sa nezmení): id už vo svete má vozidlo, modul, loď, job alebo jednotka nákladu (`duplicate_id`),
   * id nepridelené alokátorom alebo menšie ako id posledného vozidla — poradie nákupu (`invalid_input`), `depotId` nie
   * je depo vo svete (`unknown_depot`), depo nemá voľné státie (`depot_full`). Pravidlá hráča (pripojenie depa,
   * hotovosť) overuje príkaz vopred.
   */
  addVehicle(vehicle: Vehicle): void {
    const { id } = vehicle;
    if (this.vehicleMap.has(id) || this.moduleMap.has(id) || this.shipMap.has(id) || this.jobMap.has(id) || this.cargo.get(id) !== undefined) {
      throw new VehicleError('duplicate_id', `World.addVehicle: id ${String(id)} už vo svete je`);
    }
    if (id >= this.ids.getState().nextId) {
      throw new VehicleError('invalid_input', `World.addVehicle: id ${String(id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    const last = this.lastVehicleId;
    if (last !== undefined && id < last) {
      throw new VehicleError('invalid_input', `World.addVehicle: ${vehicle.label} má menšie id ako posledné vozidlo #${String(last)}`);
    }
    const depot = this.depotOf(vehicle, 'World.addVehicle');
    if (depot.freeStalls <= 0) {
      throw new VehicleError('depot_full', `World.addVehicle: ${depot.label} je plné (${String(depot.vehicleIds.length)}/${String(depot.capacity)})`);
    }
    depot.attachVehicle(id);
    this.vehicleMap.set(id, vehicle);
    this.lastVehicleId = id;
  }

  /**
   * Odstráni vozidlo (predaj `SellVehicle`) a odpojí ho od depa. Chyby (`VehicleError`, svet sa nezmení): neznáme id
   * (`unknown_vehicle`), vozidlo vezie náklad — jednotky `in_vehicle` by stratili držiteľa (`has_cargo`), vozidlo nie je
   * `idle` alebo má job (`busy`), depo vozidla vo svete nie je (`unknown_depot`).
   */
  removeVehicle(vehicleId: EntityId): Vehicle {
    const vehicle = this.vehicleMap.get(vehicleId);
    if (vehicle === undefined) throw new VehicleError('unknown_vehicle', `World.removeVehicle: vozidlo #${String(vehicleId)} neexistuje`);
    const aboard = this.cargo.countAt('in_vehicle', vehicleId);
    if (aboard > 0) throw new VehicleError('has_cargo', `World.removeVehicle: ${vehicle.label} vezie ${String(aboard)} jednotiek`);
    if (vehicle.state !== 'idle' || vehicle.jobId !== null) {
      throw new VehicleError('busy', `World.removeVehicle: ${vehicle.label} je v stave '${vehicle.state}' (job ${String(vehicle.jobId)})`);
    }
    this.depotOf(vehicle, 'World.removeVehicle').detachVehicle(vehicleId);
    this.vehicleMap.delete(vehicleId);
    if (vehicleId === this.lastVehicleId) this.lastVehicleId = lastKeyOf(this.vehicleMap);
    return vehicle;
  }

  // -------------------------------------------------------------------------------------------------------
  // Joby (T03-05, ADR-018)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Pridá aktívny job (dispatcher, obnova zo save) a zaindexuje jeho jednotky. Chyby (`JobError`, svet sa nezmení):
   * id už vo svete má job, modul, loď, vozidlo alebo jednotka (`duplicate_id`), id nepridelené alokátorom alebo menšie
   * ako id posledného jobu — poradie vzniku (`invalid_input`), job v stave `done` (`invalid_input`), jednotka jobu
   * v ledgeri nie je, alebo pri stave s nákladom na zdroji neleží na `from` (`unknown_unit`), jednotka už má aktívny job
   * (`unit_busy`). Rezerváciu slotu v cieli a vozidlo spravuje volajúci.
   */
  addJob(job: TransportJob): void {
    const { id } = job;
    if (this.jobMap.has(id) || this.moduleMap.has(id) || this.shipMap.has(id) || this.vehicleMap.has(id) || this.cargo.get(id) !== undefined) {
      throw new JobError('duplicate_id', `World.addJob: id ${String(id)} už vo svete je`);
    }
    if (id >= this.ids.getState().nextId) {
      throw new JobError('invalid_input', `World.addJob: id ${String(id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    const last = this.lastJobId;
    if (last !== undefined && id < last) throw new JobError('invalid_input', `World.addJob: ${job.label} má menšie id ako posledný job #${String(last)}`);
    const traits = JOB_STATE_TRAITS[job.state];
    if (!traits.active) throw new JobError('invalid_input', `World.addJob: ${job.label} v stave '${job.state}' nie je aktívny`);
    for (const unitId of job.unitIds) {
      const unit = this.cargo.get(unitId);
      if (unit === undefined) throw new JobError('unknown_unit', `World.addJob: ${job.label}: jednotka #${String(unitId)} v ledgeri nie je`);
      if (traits.cargoAt === 'source' && !isSameLocation(unit.location, job.from)) {
        throw new JobError('unknown_unit', `World.addJob: ${job.label}: jednotka #${String(unitId)} neleží na zdroji jobu`);
      }
      const other = this.unitJobs.get(unitId);
      if (other !== undefined) throw new JobError('unit_busy', `World.addJob: jednotka #${String(unitId)} už má ${other.label}`);
    }
    this.jobMap.set(id, job);
    this.lastJobId = id;
    for (const unitId of job.unitIds) this.unitJobs.set(unitId, job);
  }

  /**
   * Odstráni hotový job (`done`, `VehicleSystem` po vykládke) a vráti ho. Chyby (`JobError`, svet sa nezmení): neznáme id
   * (`unknown_job`), job nie je `done` (`not_done`).
   */
  removeJob(jobId: EntityId): TransportJob {
    const job = this.jobMap.get(jobId);
    if (job === undefined) throw new JobError('unknown_job', `World.removeJob: job #${String(jobId)} neexistuje`);
    if (job.state !== 'done') throw new JobError('not_done', `World.removeJob: ${job.label} je v stave '${job.state}'`);
    this.jobMap.delete(jobId);
    if (jobId === this.lastJobId) this.lastJobId = lastKeyOf(this.jobMap);
    for (const unitId of job.unitIds) this.unitJobs.delete(unitId);
    return job;
  }

  /** Aktívny job jednotky (bez alokácie); jednotka bez jobu → `undefined`. */
  jobOfUnit(unitId: EntityId): TransportJob | undefined {
    return this.unitJobs.get(unitId);
  }

  /** Počet jednotiek v indexe `jobOfUnit` (invariant kroku 12: = súčet jednotiek aktívnych jobov). */
  get jobUnitCount(): number {
    return this.unitJobs.size;
  }

  /**
   * Vozidlo, ktoré zaberá bunku s indexom `index` — stojí na nej (`vehicle.cell`), alebo je to cieľová bunka jeho
   * rozbehnutého úseku (ADR-019); inak `undefined`. `RemoveRoad` takú bunku odmietne (`occupied`). Prechádza vozidlá
   * vzostupne podľa id (príkazy, nie hot path).
   */
  vehicleOnCell(index: number): Vehicle | undefined {
    for (const vehicle of this.vehicleMap.values()) {
      if (vehicle.cell === index || (vehicle.progress > 0 && vehicle.nextCell === index)) return vehicle;
    }
    return undefined;
  }

  /**
   * Konektory modulu v poradí defu (po rotácii) s vonkajšou bunkou a `hasRoad` = na vonkajšej bunke v mape je cesta
   * (ADR-017). Počíta sa z aktuálnej mriežky pri každom volaní (nová kópia) — pre UI a ladenie, nie hot path.
   */
  connectorCells(module: Module): readonly ConnectorCell[] {
    return connectorCellsOf(this.grid, module);
  }

  /**
   * Je modul pripojený k ceste: aspoň jeden konektor typu `road` má na vonkajšej bunke cestu (rozhodnutie
   * orchestrátora F3 č. 3, ADR-017). Z mriežky, bez cache a bez alokácie — `RoadChanged` sa prejaví hneď. Nepripojený
   * modul dispatcher ignoruje a UI ukáže „Nepripojené"; modul bez cestných konektorov (žeriav) → `false`.
   */
  isConnected(module: Module): boolean {
    return isModuleConnected(this.grid, module);
  }

  /** Modul, ktorý bunku zaberá (pri žeriave jeho berth); mimo mapy alebo prázdna bunka → `undefined`. */
  moduleAt(x: number, y: number): Module | undefined {
    if (!this.grid.inBounds(x, y)) return undefined;
    const id = this.grid.at(x, y).moduleId;
    return id === null ? undefined : this.moduleMap.get(id);
  }

  /** Berth, ktorého footprint bunku zaberá; inak `undefined`. */
  berthOfCell(x: number, y: number): BerthModule | undefined {
    const module = this.moduleAt(x, y);
    return module instanceof BerthModule ? module : undefined;
  }

  /** Žeriav, ktorého footprint leží na bunke (stojí na berthe pod ňou); inak `undefined`. */
  craneAt(x: number, y: number): CraneModule | undefined {
    const berth = this.berthOfCell(x, y);
    if (berth === undefined) return undefined;
    for (const craneId of berth.craneIds) {
      const crane = this.moduleMap.get(craneId);
      if (crane instanceof CraneModule && crane.containsCell(x, y)) return crane;
    }
    return undefined;
  }

  /**
   * Invarianty sveta (§6 krok 12, §16): `cargo.assertConservation()` (→ `CargoConservationError`) a potom moduly,
   * mriežka, žeriavy, aprony, skupiny kotvísk a lode voči sebe aj ledgeru (→ `WorldInvariantError`). Svet nemení.
   */
  assertInvariants(): void {
    this.cargo.assertConservation();
    const violation = findWorldViolation(this);
    if (violation !== undefined) throw new WorldInvariantError(violation);
  }

  // -------------------------------------------------------------------------------------------------------
  // Príkazy a tick
  // -------------------------------------------------------------------------------------------------------

  /** Zaradí príkaz na koniec fronty; aplikuje sa pri najbližšom `applyPending()` alebo `tick()` (pred krokom 1). */
  enqueue(command: Command): void {
    this.pendingCommands.push(command);
  }

  /**
   * Aplikuje príkazy z fronty bez posunu času (stavba počas pauzy) a vráti udalosti, ktoré vznikli.
   * Ekvivalentné príkazovej časti `tick()`: `applyPending(); tick()` dá rovnaký stav ako samotný `tick()`.
   */
  applyPending(): readonly SimEvent[] {
    this.applyQueuedCommands();
    return this.events.flush();
  }

  /**
   * Jeden tick simulácie (§6). Rýchlosť hry tu nehrá rolu — koľko tickov sa vykoná, riadi `GameLoop`.
   * Vráti udalosti ticku v poradí vzniku: udalosti príkazov, `TickAdvanced`, potom `HourClosed`, `DayClosed`,
   * `MonthClosed` (od najmenšej hranice), ak sa uzavreli, a udalosti krokov 3–12 (lode, žeriavy, joby, vozidlá,
   * `CargoMoved`).
   * Pri zapnutom `checkInvariants` krok 12 pri porušení vyhodí `CargoConservationError` / `WorldInvariantError`.
   */
  tick(): readonly SimEvent[] {
    // Príkazy z fronty sa aplikujú pred krokom 1 (§6).
    this.applyQueuedCommands();

    // 1. clock.advance() — tick++, hranice hodiny/dňa/mesiaca.
    const closed = this.advanceClock();

    // 2. contractSystem — pribudne vo F4/F5.

    // 3. shipSystem — pohyb po sea lane, alokácia kotvísk, docking/undocking.
    this.shipSystem.tick(this);

    // 4. craneSystem — cyklus žeriavov loď → apron.
    this.craneSystem.tick(this);

    // 5. dispatcher — inbound joby s rezerváciou skladu, priradenie voľných vozidiel (ADR-018).
    this.dispatcherSystem.tick(this);

    // 6. vehicleSystem — FSM vozidiel, pohyb po trase, pobyt v module, load/unload (ADR-019).
    this.vehicleSystem.tick(this);

    // 7.–10. flow, landside, economy, tech — pribudnú v ďalších fázach presne v poradí §6.

    // 11. metricsSystem — traffic pod vozidlami po pohybe, decay pri HourClosed.
    this.metricsSystem.tick(this, closed.hourClosed);

    // 12. invarianty (DEV/testy): konzervácia nákladu + konzistencia modulov, apronov, žeriavov a lodí.
    if (this.checkInvariants) this.assertInvariants();

    // 13. events.flush() — udalosti ticku pre prezentáciu.
    return this.events.flush();
  }

  /**
   * Čistý JSON stav v3 (§14; tvar pozri `WorldState`): v1 polia (cesty s typom a smerom, ADR-020) + `traffic`, `modules` (poradie umiestnenia),
   * `cargo` (`cargo.getState()`), `ships` (vzostupne podľa id, `Ship.toState()`), `vehicles` (vzostupne podľa id,
   * `Vehicle.toState()`) a `jobs` (aktívne joby vzostupne podľa id, `TransportJob.toState()`, ADR-018). Fronta príkazov sa neukladá, preto musí byť prázdna —
   * inak `Error` (zavolaj najprv `applyPending()` alebo `tick()`).
   */
  serialize(): WorldState {
    if (this.pendingCommands.length > 0) {
      throw new Error(
        `World.serialize: vo fronte je ${String(this.pendingCommands.length)} neaplikovaných príkazov — najprv applyPending() alebo tick()`,
      );
    }
    const roads: SerializedRoad[] = [];
    const traffic: SerializedTraffic[] = [];
    for (let i = 0; i < this.grid.cellCount; i++) {
      const cell = this.grid.atIndex(i);
      if (cell.road !== 'none') roads.push(serializeRoad(i, cell.road, cell.roadKind, cell.roadDir));
      if (cell.traffic !== 0) traffic.push([i, cell.traffic]);
    }
    const parcels: Record<string, ParcelOwnership> = {};
    for (const [id, parcel] of this.parcels) parcels[id] = parcel.ownership;
    const modules = [...this.moduleMap.values()].map(
      (module): SerializedModule => ({
        id: module.id,
        defId: module.def.id,
        x: module.origin.x,
        y: module.origin.y,
        rotation: module.rotation,
        purchaseCostCents: module.purchaseCostCents,
        runtime: module.getRuntimeState(),
      }),
    );
    return {
      version: WORLD_STATE_VERSION,
      mapId: this.map.id,
      seed: this.seed,
      rng: this.rng.getState(),
      clock: this.clock.getState(),
      ids: this.ids.getState(),
      cashCents: this.cashCents,
      roads,
      parcels,
      traffic,
      modules,
      cargo: this.cargo.getState(),
      ships: [...this.shipMap.values()].map((ship) => ship.toState()),
      vehicles: [...this.vehicleMap.values()].map((vehicle) => vehicle.toState()),
      jobs: [...this.jobMap.values()].map((job) => job.toState()),
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Vnútro
  // -------------------------------------------------------------------------------------------------------

  /**
   * Berth, na ktorom stojí pripájaný modul (žeriav, ADR-014): len `CraneModule` s berthom pod ľavým horným rohom.
   * Iný modul s `mustAttachTo` alebo chýbajúci berth → `ModuleError` (`invalid_input` / `no_berth`).
   */
  private hostOf(module: Module): BerthModule {
    if (!(module instanceof CraneModule)) {
      throw new ModuleError('invalid_input', `World: ${module.label} má placement.mustAttachTo, ale nie je žeriav (craneIds eviduje len žeriavy)`);
    }
    const berth = this.moduleMap.get(module.berthId);
    if (!(berth instanceof BerthModule)) {
      throw new ModuleError('no_berth', `World: ${module.label} stojí na #${String(module.berthId)}, ktorý nie je berth`);
    }
    return berth;
  }

  /** Depo vozidla (`depotId`); modul chýba alebo nie je depo → `VehicleError('unknown_depot')`. */
  private depotOf(vehicle: Vehicle, caller: string): VehicleDepot {
    const depot = this.moduleMap.get(vehicle.depotId);
    if (!(depot instanceof VehicleDepot)) {
      throw new VehicleError('unknown_depot', `${caller}: ${vehicle.label} patrí #${String(vehicle.depotId)}, ktorý nie je depo vozidiel`);
    }
    return depot;
  }

  /**
   * Starter moduly mapy v poradí mapy (`World.create`): každý musí mať def v `modules.json` a spĺňať všetky pravidlá
   * umiestnenia (`findPlacementViolations`, ako `PlaceModule` bez ceny); inak `MapError` s indexom modulu.
   */
  private placeStarterModules(): void {
    this.map.starter.modules.forEach((spec, index) => {
      const path = `/starter/modules${pointerSegment(index)}`;
      if (!this.defs.modules.has(spec.defId)) {
        throw new MapError(this.map.id, `${path}/defId`, `starter modul '${spec.defId}' nie je v modules.json`);
      }
      const violations = findPlacementViolations(this, this.defs.modules.get(spec.defId), spec);
      if (violations.length > 0) {
        const at = `(${String(spec.x)}, ${String(spec.y)}) rot ${String(spec.rotation)}`;
        const why = violations.map(({ rule, detail }) => `${rule}: ${detail}`).join('; ');
        throw new MapError(this.map.id, path, `starter modul '${spec.defId}' na ${at} nespĺňa pravidlá umiestnenia (§8) — ${why}`);
      }
      this.placeModule(spec, 0);
    });
  }

  /** Prepočet skupín kotvísk a `groupId` každého berthu. */
  private refreshBerthGroups(): void {
    const berths = [...this.moduleMap.values()].filter((module): module is BerthModule => module instanceof BerthModule);
    this.groups = computeBerthGroups(berths);
    for (const group of this.groups) {
      for (const berthId of group.berthIds) {
        const berth = this.moduleMap.get(berthId);
        if (berth instanceof BerthModule) berth.groupId = group.id;
      }
    }
  }

  /**
   * Príkazy vo fronte v poradí vloženia: `validate` nad aktuálnym stavom (vidí účinok predchádzajúcich príkazov),
   * pri úspechu `apply`, inak `CommandRejected` bez zmeny stavu. Spracujú sa len príkazy zaradené pred začiatkom
   * kola; príkaz zaradený počas `apply` počká na ďalšie kolo.
   */
  private applyQueuedCommands(): void {
    const count = this.pendingCommands.length;
    for (let i = 0; i < count; i++) {
      // `shift` po jednom: ak `apply` vyhodí výnimku, zvyšné príkazy ostanú vo fronte.
      const command = this.pendingCommands.shift() as Command;
      const result = command.validate(this);
      if (result.ok) {
        command.apply(this);
      } else {
        this.events.emit({ type: 'CommandRejected', commandType: command.type, reasons: Object.freeze([...result.reasons]) });
      }
    }
  }

  /** Krok 1: posun hodín a udalosti `TickAdvanced` + uzavreté hranice; vráti hranice pre neskoršie kroky (krok 11). */
  private advanceClock(): ClockBoundaries {
    const closed = this.clock.advance();
    const tick = this.clock.tick;
    this.events.emit({ type: 'TickAdvanced', tick });
    if (closed.hourClosed) this.events.emit({ type: 'HourClosed', tick });
    if (closed.dayClosed) this.events.emit({ type: 'DayClosed', tick });
    if (closed.monthClosed) this.events.emit({ type: 'MonthClosed', tick });
    return closed;
  }
}
