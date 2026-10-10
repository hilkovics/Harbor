/**
 * World — koreň simulácie (ARCHITECTURE §5, §6). Vlastní hodiny, mriežku, parcely, ekonomiku (hotovosť + kniha), jediný `Rng`,
 * alokátor ID, zbernicu udalostí, `CargoLedger`, moduly so skupinami kotvísk a lode; prezentácia ho len číta
 * a mení ho výlučne cez `Command` (pravidlo 5).
 *
 * Tick pipeline (§6): príkazy z fronty → krok 1 (`clock.advance()` + udalosti hraníc) → krok 2 (`ContractSystem`: pool,
 * lode kontraktov, SLA, penalizácie, výplata — ADR-026) → krok 3 (`ShipSystem`) →
 * krok 4 (`CraneSystem`) → krok 5 (`DispatcherSystem`) → krok 6a (`TrafficSystem`: pohyb všetkých nosičov pod pruhovými slotmi, ADR-037, ADR-038) → krok 6b (`VehicleSystem`) → krok 6c (`YardMachineSystem`: stroje blokov RTG, ADR-040) → krok 6d (`ReeferSystem`: napájanie reeferov, ADR-042) →
 * krok 8 (`LandsideSystem`: kamióny, brány, spawn, export) → krok 9 (`EconomySystem`: údržba, mzdy, súhrny, bankrot — ADR-025) → krok 11 (`MetricsSystem`, traffic) → krok 12 (`assertInvariants()`, ak je zapnuté
 * `checkInvariants`) → krok 13 (`events.flush()`). Ďalšie kroky pribúdajú so systémami na označenom mieste v `tick()`; poradie §6 je záväzné
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
 * `vehicleOnCell` hovorí, či bunku zaberá vozidlo, `carrierOnCell` vozidlo alebo kamión (`RemoveRoad` → `occupied`).
 *
 * Kamióny (T04-04, ADR-024): `addTruck`/`removeTruck` sú štrukturálne operácie pre spawn a export v `LandsideSystem`
 * (krok 8) a obnovu zo save — kamión pri pridaní drží svoj bay stojiska (`bay`), dock rampy a nárok na náklad docku
 * podľa stavu (ADR-029); frontu brány spravuje brána (runtime v save). Pohyb zdieľa `Carrier` s vozidlami (`src/sim/movement`).
 *
 * Joby (T03-05, ADR-018, ADR-023): `addJob`/`removeJob` sú štrukturálne operácie pre dispatcher (krok 5: vznik inbound
 * aj outbound jobov, zrušenie `open` outbound jobu), `VehicleSystem` a obnovu zo save; `jobOfUnit` je index jednotka →
 * aktívny job (odvodený, neukladá sa).
 *
 * Sklady a depá (ADR-017): moduly vznikajú s ledgerom na čítanie (`ModuleEnv.cargo`) — apron a sklad držia len
 * rezervácie, obsadenie čítajú z `cargo`. Pripojenie modulu k ceste (`isConnected`, `connectorCells`) sa počíta
 * z mriežky pri každom volaní.
 *
 * Cestná sieť (T03-03): `roadVersion` je počítadlo zmien vrstvy ciest (`markRoadsChanged` volá `PlaceRoad`/`RemoveRoad`
 * a `deserialize`); `pathfinder` (A*), `paths` (`PathCache`) a `distances` (`DistanceMatrix`) vznikajú lenivo pri prvom
 * použití a cache sa pri zmene `roadVersion` samy vyprázdnia — bez odberu udalostí. Nič z toho nie je v save.
 * `markRoadsChanged` zároveň označí jazdiace vozidlá na preplánovanie (`Vehicle.replanPending`, ide do save — ADR-019).
 *
 * Pozemný reťazec (T04-02, ADR-022): `moduleVersion` je počítadlo zmien množiny modulov (`addModule`/`removeModule`);
 * `landside` (`LandsideNetwork`) z ciest a modulov lenivo počíta strany brán, priechody stojiskami a prevádzkovosť rámp
 * (zneplatní sa zmenou `roadVersion` alebo `moduleVersion`). Dotazy `isRampOperational`, `rampStatus`, `landsideRoutes`,
 * `gateSides` sú vždy aktuálne. Po každom aplikovanom príkaze (a na konci príkazovej fázy ticku) svet výsledok
 * **zverejní** do modulov (`TruckGate.entrySide`/`exitSide`, `LoadingRamp.operational`/`inoperativeReason`) a pri zmene
 * stavu rampy emituje `RampOperationalChanged` — po udalostiach príkazu, ktorý zmenu spôsobil — a urovná fronty brán
 * (`settleGateQueues`, dodatok ADR-024). `create` a `deserialize` zverejňujú bez udalostí. Register pozemných modulov
 * `landsideModules` (brány, stojiská, rampy podľa `LandExportModule.enlist`) sa obnoví pri zmene `moduleVersion`.
 * Typy ciest (T03-18, ADR-020): prestavba typu alebo smeru bunky je tiež zmena siete (`markRoadsChanged`); A* ide po
 * smerových hranách s cenou bunky `roadSpeeds.cellCost` (= 1 / `speedFactor`) a vozidlá jazdia rýchlosťou
 * `roadSpeeds.speedFactor` cieľovej bunky úseku.
 */
import { CargoLedger } from '../cargo/cargo-ledger';
import type { CargoLedgerState } from '../cargo/cargo-ledger-state';
import { HoldIndex } from '../cargo/hold-index';
import { ReeferIndex } from '../cargo/reefer-index';
import type { CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { StorageGuard } from '../cargo/storage-guard';
import { EntityIdAllocator, type ContractId, type EntityId } from '../core/entity-id';
import { EventBus } from '../core/event-bus';
import { INITIAL_SPEED, SimClock, type ClockBoundaries } from '../core/sim-clock';
import { Rng } from '../core/rng';
import type { Command } from '../commands/command';
import { withGameOver } from '../commands/sim-command';
import { ContractBook, type ContractBookState } from '../contracts/contract-book';
import type { Contract } from '../contracts/contract';
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
import { TruckGate } from '../modules/truck-gate';
import { TruckHolding } from '../modules/truck-holding';
import { YardBlock } from '../modules/yard-block';
import { RtgBlock } from '../modules/rtg-block';
import { MachineError } from '../machines/machine-error';
import { ReachStacker } from '../machines/reach-stacker';
import { RmgCrane } from '../machines/rmg-crane';
import { RailTerminal } from '../modules/rail-terminal';
import { RtgCrane } from '../machines/rtg-crane';
import type { YardMachine } from '../machines/yard-machine';
import { ReeferSystem } from '../systems/reefer-system';
import { RailSystem } from '../systems/rail-system';
import { Rail, type RailRuntimeState } from '../rail/rail';
import { releaseCrossings, syncCrossings } from '../rail/rail-crossings';
import { computeRailRoutes, type RailRoute } from '../rail/rail-routes';
import type { Train } from '../rail/train';
import { YardMachineSystem } from '../systems/yard-machine-system';
import { VehicleDepot } from '../modules/vehicle-depot';
import type { AdvanceGate, Carrier } from '../movement/carrier';
import type { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import { DistanceMatrix } from '../logistics/distance-matrix';
import { JobError } from '../logistics/job-error';
import { unitAtJobSource } from '../logistics/job-source';
import { PathCache } from '../logistics/path-cache';
import { Pathfinder } from '../logistics/pathfinder';
import { QuayLanes, hasQuayLane } from '../logistics/quay-lanes';
import { RoadSpeeds } from '../logistics/road-speed';
import { EmptyFlow, type EmptyFlowState } from '../logistics/empty-flow';
import { Hinterland, type HinterlandState } from '../trucks/hinterland';
import { StoredCargoIndex } from '../logistics/stored-cargo-index';
import { JOB_STATE_TRAITS, type TransportJob } from '../logistics/transport-job';
import { Economy, type EconomyState } from '../economy/economy';
import { ContractSystem } from '../systems/contract-system';
import { CraneSystem } from '../systems/crane-system';
import { DispatcherSystem } from '../systems/dispatcher-system';
import { EconomySystem } from '../systems/economy-system';
import { LandsideSystem, settleGateQueues } from '../systems/landside-system';
import { MetricsSystem } from '../systems/metrics-system';
import { VehicleSystem } from '../systems/vehicle-system';
import { CellLanes } from '../traffic/cell-lanes';
import { LaneSlots } from '../traffic/lane-slots';
import { TrafficSystem } from '../traffic/traffic-system';
import { ShipSystem } from '../systems/ship-system';
import { StatResolver } from '../tech/stat-resolver';
import { ShipTraffic } from '../ships/ship-traffic';
import type { Truck } from '../trucks/truck';
import { TruckError } from '../trucks/truck-error';
import { TruckIndex } from '../trucks/truck-index';
import { TRUCK_STATE_TRAITS } from '../trucks/truck-fsm';
import type { Vehicle } from '../vehicles/vehicle';
import { VehicleError } from '../vehicles/vehicle-error';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';
import { connectorCellsOf, isModuleConnected, type ConnectorCell } from './connectivity';
import { LandsideNetwork, type GateSides } from './landside';
import { LandsideRosterCache, type LandsideModules } from './landside-roster';
import { PLACEMENT_RULE_ERROR, attachesToHost, findPlacementViolations, findRemovalViolations } from './module-rules';
import { WorldInvariantError, findWorldViolation } from './world-invariants';
import { restoreEntities } from './world-restore';
import {
  WORLD_STATE_VERSION,
  parseWorldState,
  serializeRoad,
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
  /** Uložený stav ekonomiky (overený `parseWorldState`); `null` = prázdna kniha novej hry. */
  readonly economy: EconomyState | null;
  /** Kniha kontraktov zo save (v5, ADR-026); `null` = nová hra bez kontraktov. */
  readonly contracts: ContractBookState | null;
  /** Uložený stav ledgera (overený `parseWorldState`); `null` = prázdny ledger novej hry. */
  readonly cargo: CargoLedgerState | null;
  /** Uložený plán prázdnych kontajnerov (v8, ADR-034); `null` = prázdny plán novej hry. */
  readonly emptyFlow: EmptyFlowState | null;
  /** Uložené počítadlá vnútrozemia (v9, ADR-035); `null` = nulové počítadlá novej hry. */
  readonly hinterland: HinterlandState | null;
  /** Cestovný poriadok a súčty železnice (R6); `null` = nová hra. */
  readonly rail: RailRuntimeState | null;
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
  /** Kamióny na mape vzostupne podľa id (= poradie spawnu); meniť len cez `addTruck`/`removeTruck` (ADR-024). */
  readonly trucks: ReadonlyMap<EntityId, Truck>;
  /** Stroje blokov (RTG, ADR-040) vzostupne podľa id; meniť len cez `addMachine`/`removeMachine` (stroj RTG bloku vzniká s blokom v `placeModule`). */
  readonly machines: ReadonlyMap<EntityId, YardMachine>;
  /** Vlaky na koľajisku (R6, ADR-043) vzostupne podľa id; obsadenie a plán drží `rail`. */
  readonly trains: ReadonlyMap<EntityId, Train>;
  /** Železnica: vlaky, cestovný poriadok, obsadenie buniek (R6, ADR-043). */
  readonly rail: Rail;
  /** Štatistiky entít po modifikátoroch (§10); vo F2 základ z defov. */
  readonly stats: StatResolver;
  /**
   * Rýchlostný faktor a cena bunky podľa typu cesty (`infrastructure.roadKinds`, ADR-020) nad `grid` — A* (`pathfinder`)
   * aj pohyb vozidiel (`VehicleSystem`) čítajú typ bunky pri každom volaní.
   */
  readonly roadSpeeds: RoadSpeeds;
  /**
   * Pruhové sloty ciest (ADR-037): kto drží ktorý slot bunky; odvodená cache z `body` a `ahead` nosičov (nie je v save,
   * po obnove sa prepočíta). Zapisujú ju len nosiče (`Carrier`) pod `TrafficSystem`.
   */
  readonly laneSlots: LaneSlots;
  /**
   * Hotovosť a účtovná kniha (§9.2, ADR-025): jediná cesta zmeny hotovosti je `economy.post(amountCents, category, refId?)`
   * (zápis do knihy + `MoneyChanged`); denné a mesačné súhrny a bankrot uzatvára krok 9 (`EconomySystem`).
   */
  readonly economy: Economy;
  /**
   * Kontrakty, XP a počet dokončených (§9.1, §10, ADR-026): ponuky poolu, prebiehajúce, dokončené a zlyhané kontrakty;
   * stav mení `ContractSystem` (krok 2) a príkazy `AcceptContract` / `DeclineContract`. Fasády `contracts`, `xp`,
   * `completedContracts`, `tier`.
   */
  readonly contractBook: ContractBook;
  /**
   * Uskladnené jednotky podľa kontraktu v poradí sklad ↑, FIFO (ADR-027) — odvodená cache pre outbound joby dispatchera,
   * nie je v save (obnova ju zostaví z ledgera). Udržiava ju háčik `CargoLedger.move`.
   */
  readonly storedCargo = new StoredCargoIndex();
  /**
   * Zadržané jednotky (VGM hold, ADR-032) podľa `(untilTick, id)` — odvodená cache pre uvoľnenie v kroku 2, nie je v save
   * (obnova ju zostaví z jednotiek s `hold`). Plní ju brána (krok 8), mazať z nej smie len `ContractSystem`.
   */
  readonly holdIndex = new HoldIndex();
  /**
   * Sledované reefery (R5, ADR-042) — odvodená cache pre krok 6d (`ReeferSystem`), nie je v save (obnova ju zostaví z jednotiek so stavom `reefer`). Plní ju háčik `CargoLedger.move`
   * a STS pri preskočení reeferu.
   */
  readonly reeferIndex = new ReeferIndex();
  /**
   * Plán toku prázdnych kontajnerov (F6c, ADR-034): naplánované návraty z vnútrozemia a výdaje prázdneho exportérovi, zoradené
   * podľa ticku, a poverenia kamiónov misie `collect` (`errands`). Je v save (`emptyFlow`); plánuje ho krok 8 (`trucks/empty-plan.ts`:
   * odchod importu kamiónom, `AcceptContract` export bookingu) a spotrebúva krok 8 (`trucks/empty-trucks.ts`); v prístave bez depa prázdnych
   * ostáva prázdny.
   */
  readonly emptyFlow: EmptyFlow;
  /**
   * Počítadlá vnútrozemia (F6d, ADR-035): čakanie kamiónov pred vjazdom do prístavu podľa misie a nedostatok stojísk pre odvoz. Je v save
   * (`hinterland`); čakajúce kamióny samotné sú splatné položky plánov (`emptyFlow`, `arrivalPlan`), vpúšťa ich krok 8 (`trucks/hinterland-admit.ts`).
   */
  readonly hinterland: Hinterland;
  /** Krok 12 ticku zapnutý (`WorldOptions.checkInvariants`, predvolene `true`). */
  readonly checkInvariants: boolean;

  private readonly pendingCommands: Command[] = [];
  private readonly moduleMap = new Map<EntityId, Module>();
  private readonly shipMap = new Map<EntityId, Ship>();
  private readonly vehicleMap = new Map<EntityId, Vehicle>();
  private readonly jobMap = new Map<EntityId, TransportJob>();
  private readonly truckMap = new Map<EntityId, Truck>();
  /** Odvodený index obsadenia TP, státí a smerovania kamiónov (nie je v save; viď `trucks/truck-index.ts`). */
  readonly truckIndex = new TruckIndex(this.truckMap);
  private readonly machineMap = new Map<EntityId, YardMachine>();
  /** Jednotka → jej aktívny job (odvodený index nad `jobMap`). */
  private readonly unitJobs = new Map<EntityId, TransportJob>();
  /** Najväčšie id vo `vehicleMap` / `jobMap` (= posledné vložené; poradie pridania = vzostupne podľa id) bez prechodu kľúčov. */
  private lastVehicleId: EntityId | undefined;
  private lastJobId: EntityId | undefined;
  private lastTruckId: EntityId | undefined;
  private groups: readonly BerthGroup[] = NO_GROUPS;
  private readonly contractSystem = new ContractSystem();
  private readonly shipSystem = new ShipSystem();
  private readonly craneSystem = new CraneSystem();
  private readonly dispatcherSystem = new DispatcherSystem();
  private readonly trafficSystem = new TrafficSystem();
  private readonly vehicleSystem = new VehicleSystem();
  private readonly yardMachineSystem = new YardMachineSystem();
  private readonly reeferSystem = new ReeferSystem();
  private readonly railSystem = new RailSystem();
  private railRoutesCache: readonly RailRoute[] | undefined;
  private railRoutesKey = '';
  private readonly landsideSystem = new LandsideSystem();
  private readonly economySystem = new EconomySystem();
  private readonly metricsSystem = new MetricsSystem();
  private roadChanges = 0;
  private moduleChanges = 0;
  private shipChanges = 0;
  private shipTrafficInstance: ShipTraffic | undefined;
  /** Verzie ciest a modulov, pri ktorých svet naposledy zverejnil pozemný reťazec do modulov (`publishLandside`). */
  private publishedRoadVersion = Number.NaN;
  private publishedModuleVersion = Number.NaN;
  private landsideNetwork: LandsideNetwork | undefined;
  private readonly landsideRoster = new LandsideRosterCache();
  private pathfinderInstance: Pathfinder | undefined;
  private quayInstance: QuayLanes | undefined;
  private cellLaneInstance: CellLanes | undefined;
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
    const economyEnv = { events: this.events, clock: parts.clock };
    const entriesKept = parts.defs.economy.ledgerEntriesKept;
    this.economy =
      parts.economy === null
        ? new Economy(economyEnv, parts.cashCents, entriesKept)
        : Economy.fromState(economyEnv, parts.cashCents, entriesKept, parts.economy);
    const bookEnv = { events: this.events, clock: parts.clock };
    this.contractBook = parts.contracts === null ? new ContractBook(bookEnv) : ContractBook.fromState(bookEnv, parts.contracts);
    this.emptyFlow = parts.emptyFlow === null ? new EmptyFlow() : EmptyFlow.fromState(parts.emptyFlow);
    this.hinterland = parts.hinterland === null ? new Hinterland() : Hinterland.fromState(parts.hinterland);
    const { contractBook, storedCargo, holdIndex, reeferIndex } = this;
    // Počítadlá jednotiek kontraktov (ADR-026), index uskladneného nákladu pre outbound (ADR-027) a index zadržaných
    // jednotiek (ADR-032: zadržaná jednotka, ktorá opustí mapu, z neho vypadne) z háčika ledgera — bez skenu nákladu v ticku.
    const observer = {
      cargoMoved(unit: CargoUnit, to: CargoLocation): void {
        contractBook.cargoMoved(unit, to);
        storedCargo.cargoMoved(unit, to);
        if (unit.hold !== null && (to.kind === 'exported' || to.kind === 'shipped')) holdIndex.remove(unit.id);
        if (unit.reefer !== null) reeferIndex.add(unit.id);
      },
    };
    // Stráž skladov so stohmi (ADR-039): ledger pri presune do / zo skladu overí pravidlá stohu a udržiava `StackGrid` bloku.
    const storageGuard = (moduleId: EntityId): StorageGuard | undefined => {
      const module = this.moduleMap.get(moduleId);
      return module instanceof YardBlock ? module : undefined;
    };
    const deps = { cargoTypes: parts.defs.cargoTypes, containerTypes: parts.defs.containerTypes, ids: parts.ids, events: this.events, clock: parts.clock, observer, storageGuard };
    this.cargo = parts.cargo === null ? new CargoLedger(deps) : CargoLedger.fromState(parts.cargo, deps);
    this.modules = this.moduleMap;
    this.ships = this.shipMap;
    this.vehicles = this.vehicleMap;
    this.jobs = this.jobMap;
    this.trucks = this.truckMap;
    this.machines = this.machineMap;
    this.rail = new Rail(parts.defs.rail, parts.clock, parts.grid.cellCount, parts.rail ?? undefined);
    this.trains = this.rail.trains;
    this.stats = new StatResolver(parts.defs);
    this.roadSpeeds = new RoadSpeeds(parts.grid, parts.defs.infrastructure.roadKinds);
    this.laneSlots = new LaneSlots(parts.grid.cellCount);
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
        economy: null,
        contracts: null,
        cargo: null,
        emptyFlow: null,
        hinterland: null,
        rail: null,
      },
      options,
    );
    world.placeStarterModules();
    world.publishLandside(false);
    return world;
  }

  /**
   * Obnoví svet zo `serialize()` (aj po `JSON.parse`); inú verziu než `WORLD_STATE_VERSION` odmietne `UnsupportedSaveVersionError` (clean break, ADR-036 — migrácie nie sú). Terén a parcely berie z `map` (musí mať
   * `id === state.mapId`), vrstvu dopravy celú z `state.roads` (aj typ a smer cesty, ADR-020) — starter cesta, ktorú hráč odstránil, sa neobnoví;
   * moduly, lode, vozidlá, náklad a odvodený stav obnoví `restoreEntities`. Neplatný stav → `WorldStateError` (pozri `parseWorldState`, `restoreEntities`). Výsledok
   * nezdieľa meniteľný stav so `state` ani s `map`. `options` ako pri `create`.
   */
  static deserialize(defs: DefRegistry, map: LoadedMap, state: WorldState, options: WorldOptions = {}): World {
    const grid = map.createGrid();
    const parsed = parseWorldState(state, defs, map, grid);
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
        economy: parsed.economy,
        contracts: parsed.contracts,
        cargo: parsed.cargo,
        emptyFlow: parsed.emptyFlow,
        hinterland: parsed.hinterland,
        rail: parsed.rail,
      },
      options,
    );
    // Cesty prišli zo save — cache ciest vytvorené počas obnovy by patrili predchádzajúcemu stavu mriežky.
    world.markRoadsChanged();
    restoreEntities(world, parsed);
    // Zverejnený stav pozemného reťazca sa neukladá: originál ho mal zverejnený po poslednom príkaze, obnova ho odvodí ticho.
    world.publishLandside(false);
    return world;
  }

  /**
   * Trasy vlakov portál → koľaje terminálov (`computeRailRoutes`), prepočítané len pri zmene ciest/koľají alebo modulov (R6, ADR-043). Prázdne = žiadny terminál nie je napojený na koľajový portál.
   */
  get railRoutes(): readonly RailRoute[] {
    const key = `${String(this.roadChanges)}:${String(this.moduleChanges)}`;
    if (this.railRoutesCache === undefined || key !== this.railRoutesKey) {
      this.railRoutesCache = computeRailRoutes(this.grid, this.map.railPortals[0]?.cell, this.moduleMap.values(), this.rail.crossings);
      this.railRoutesKey = key;
    }
    return this.railRoutesCache;
  }

  /** Je vo svete železničný terminál napojený súvislou koľajou na koľajový portál (vlaky jazdia, `railShare` kontraktov sa losuje)? */
  get hasRailService(): boolean {
    return this.railRoutes.length > 0;
  }

  /** Leží bunka mapy na trase niektorého vlaku? (`RemoveRail` ju vtedy odmietne.) */
  railCellInUse(index: number): boolean {
    return this.rail.cellInUse(index);
  }

  /** Pridá vlak (nový z `RailSystem` alebo obnovený zo save): id musí pridelil alokátor a ešte nesmie existovať (`Error`). */
  addTrain(train: Train): void {
    if (train.id >= this.ids.getState().nextId) throw new Error(`World.addTrain: ${train.label}: id nepridelil alokátor sveta`);
    this.rail.addTrain(train);
    syncCrossings(this, train);
  }

  /** Odstráni vlak (odchod cez portál) a uvoľní jeho bunky. */
  removeTrain(trainId: EntityId): Train {
    const train = this.rail.trains.get(trainId);
    if (train === undefined) throw new Error(`World.removeTrain: vlak #${String(trainId)} neexistuje`);
    releaseCrossings(this, train);
    this.rail.removeTrain(train);
    return train;
  }

  /**
   * Hotovosť v centoch (USD), môže byť záporná — fasáda nad `economy.cashCents` len na čítanie (prezentácia, validácia
   * `insufficient_funds`). Zapisuje sa výlučne cez `economy.post` (ADR-025).
   */
  get cashCents(): number {
    return this.economy.cashCents;
  }

  /**
   * Hra skončila bankrotom (`GameOver`, ADR-025): `tick()` odvtedy aplikuje len frontu príkazov, neposúva čas
   * a netickuje systémy. Fasáda nad `economy.gameOver` (je v save).
   */
  get gameOver(): boolean {
    return this.economy.gameOver;
  }

  /** Kontrakty okrem expirovaných vzostupne podľa id (ponuky, prebiehajúce, dokončené, zlyhané; ADR-026). */
  get contracts(): ReadonlyMap<ContractId, Contract> {
    return this.contractBook.contracts;
  }

  /** Nazbierané XP (§10). */
  get xp(): number {
    return this.contractBook.xp;
  }

  /** Počet dokončených kontraktov za hru. */
  get completedContracts(): number {
    return this.contractBook.completedContracts;
  }

  /** `tier = ⌊completedContracts / economy.contractsPerTier⌋` (filter `minTier` poolu). */
  get tier(): number {
    return this.contractBook.tier(this.defs.economy.contractsPerTier);
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
   * Verzia množiny modulov: rastie pri každom `addModule` / `removeModule` (neukladá sa, význam má len zmena) —
   * `landside` podľa nej (a `roadVersion`) zistí, že sa brány, stojiská alebo rampy mohli zmeniť.
   */
  get moduleVersion(): number {
    return this.moduleChanges;
  }

  /**
   * Verzia množiny lodí: rastie pri každom `addShip` / `removeShip` (neukladá sa — memo neúspešných pokusov lodnej
   * dopravy, `ShipTraffic`, ADR-029).
   */
  get shipVersion(): number {
    return this.shipChanges;
  }

  /**
   * Riadenie lodnej dopravy bez prekrývania (`ShipTraffic`, ADR-029): rezervácie trás lodí, A* po vode. Vznikne pri
   * prvom použití; nie je stav simulácie (memo navigátora a neúspešných pokusov), do save nepatrí.
   */
  get shipTraffic(): ShipTraffic {
    this.shipTrafficInstance ??= new ShipTraffic(this);
    return this.shipTrafficInstance;
  }

  /**
   * Pozemný exportný reťazec (`LandsideNetwork`, ADR-022): strany brán, priechody stojiskami, trasy kamiónov
   * a prevádzkovosť rámp, lenivo prepočítané pri zmene `roadVersion` alebo `moduleVersion`. Nie je v save.
   */
  get landside(): LandsideNetwork {
    this.landsideNetwork ??= new LandsideNetwork(this);
    return this.landsideNetwork;
  }

  /**
   * Register pozemných modulov (brány, stojiská, rampy vzostupne podľa id; `LandExportModule.enlist`, pravidlo 7) —
   * obnoví sa lenivo pri zmene `moduleVersion`, čítanie pri nezmenených moduloch nealokuje. Nie je v save.
   */
  get landsideModules(): LandsideModules {
    return this.landsideRoster.refresh(this.moduleMap, this.moduleChanges);
  }

  /** Aktuálne strany brány (konektory a prístupové bunky; `null` / `NO_ACCESS`, keď strana chýba). */
  gateSides(gate: TruckGate): GateSides {
    return this.landside.gateSides(gate);
  }

  /**
   * Zapíše zmenu cestnej siete (volá `PlaceRoad`/`RemoveRoad` po zápise `cell.road` / `roadKind` / `roadDir` —
   * aj prestavba typu alebo smeru, ADR-020 — a `deserialize` po obnove ciest). Kto mení tieto polia inou cestou, musí
   * ho zavolať tiež, inak cache ciest ostanú zastarané a vozidlá by jazdili po starej trase. Jazdiace vozidlá
   * (`motion: 'drive'`) dostanú `replanPending` — preplánujú v najbližšom kroku 6; jazdiace kamióny rovnako v kroku 8.
   */
  markRoadsChanged(): void {
    this.roadChanges += 1;
    for (const vehicle of this.vehicleMap.values()) {
      if (VEHICLE_STATE_TRAITS[vehicle.state].motion === 'drive') vehicle.replanPending = true;
    }
    for (const truck of this.truckMap.values()) {
      if (TRUCK_STATE_TRAITS[truck.state].motion === 'drive') truck.replanPending = true;
    }
  }

  /**
   * A* nad cestami tohto sveta (§7.4) so smerovými hranami a cenou bunky podľa typu cesty (ADR-020); vznikne pri prvom
   * použití (pracovné polia pre celú mriežku).
   */
  get pathfinder(): Pathfinder {
    this.pathfinderInstance ??= new Pathfinder(this.grid, this.roadSpeeds.cellCost, this.quay);
    return this.pathfinderInstance;
  }

  /**
   * Nábrežie kotvísk pod hákom (F6d, ADR-033 dodatok T6D-02): jazdné bunky vozidla pri odovzdávaní žeriavu, odvodené z modulov
   * (`QuayLanes`, nie je v save). Režim `apron` ho nemá.
   */
  get quay(): QuayLanes {
    this.quayInstance ??= new QuayLanes(this.grid.width, this.grid.cellCount, this);
    return this.quayInstance;
  }

  /**
   * Druhy buniek a úseky `one_lane` pre pruhové sloty (ADR-037), odvodené z ciest a nábrežia; prepočítajú sa po zmene
   * `roadVersion` alebo `moduleVersion` (nie je v save).
   */
  get cellLanes(): CellLanes {
    this.cellLaneInstance ??= new CellLanes(this);
    return this.cellLaneInstance;
  }

  /** Brána úseku dopravy bez prekrývania (ADR-037): `TrafficSystem` ju nastaví na nosič, ktorý sa práve hýbe. */
  get trafficGate(): AdvanceGate {
    return this.trafficSystem;
  }

  /** Systém dopravy (krok 6a, ADR-038); `tick()` sveta ho volá sám, testy dopravy ho smú tikať samostatne. */
  get traffic(): TrafficSystem {
    return this.trafficSystem;
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
    // RTG blok sa stavia aj so svojím strojom (ADR-040 bod 3): stroj je súčasť ceny bloku.
    // OOG plocha (R5, ADR-042 TR5-02) má reach stacker namiesto RTG.
    if (module instanceof RtgBlock) {
      this.addMachine(module instanceof RailTerminal ? RmgCrane.create(this.ids.next(), module.id, this.defs.equipment.rmg, module.geometry.maxTier) : module.acceptsOog ? ReachStacker.create(this.ids.next(), module.id, this.defs.equipment.reachStacker, module.geometry.maxTier) : RtgCrane.create(this.ids.next(), module.id, this.defs.equipment.rtg, module.geometry.maxTier));
    }
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
    this.moduleChanges += 1;
    this.refreshBerthGroups();
    // Nábrežie pod hákom (F6d) mení uzly A*: cache ciest a vzdialeností sa zneplatnia a jazdiace vozidlá preplánujú.
    if (hasQuayLane(module)) this.markRoadsChanged();
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
    const machine = this.machineOfBlock(moduleId);
    if (machine !== undefined) this.removeMachine(machine.id);
    this.moduleMap.delete(moduleId);
    this.moduleChanges += 1;
    this.refreshBerthGroups();
    if (hasQuayLane(module)) this.markRoadsChanged();
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
    if (this.shipMap.has(ship.id) || this.moduleMap.has(ship.id) || this.vehicleMap.has(ship.id) || this.jobMap.has(ship.id) || this.truckMap.has(ship.id)) {
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
    this.shipChanges += 1;
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
    this.shipChanges += 1;
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
    if (this.vehicleMap.has(id) || this.moduleMap.has(id) || this.shipMap.has(id) || this.jobMap.has(id) || this.truckMap.has(id) || this.cargo.get(id) !== undefined) {
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
    const taken = this.slotConflict(vehicle);
    if (taken !== undefined) throw new VehicleError('slot_taken', `World.addVehicle: ${vehicle.label}: ${taken}`);
    depot.attachVehicle(id);
    vehicle.attachSlots(this.laneSlots);
    this.vehicleMap.set(id, vehicle);
    this.lastVehicleId = id;
  }

  /**
   * Odstráni vozidlo (predaj `SellVehicle`) a odpojí ho od depa. Chyby (`VehicleError`, svet sa nezmení): neznáme id
   * (`unknown_vehicle`), vozidlo vezie náklad — jednotky `in_vehicle` by stratili držiteľa (`has_cargo`), vozidlo nie je
   * voľné (`idle`, `to_depot`, `parked`) alebo má job (`busy`), depo vozidla vo svete nie je (`unknown_depot`).
   */
  removeVehicle(vehicleId: EntityId): Vehicle {
    const vehicle = this.vehicleMap.get(vehicleId);
    if (vehicle === undefined) throw new VehicleError('unknown_vehicle', `World.removeVehicle: vozidlo #${String(vehicleId)} neexistuje`);
    const aboard = this.cargo.countAt('in_vehicle', vehicleId);
    if (aboard > 0) throw new VehicleError('has_cargo', `World.removeVehicle: ${vehicle.label} vezie ${String(aboard)} jednotiek`);
    if (!VEHICLE_STATE_TRAITS[vehicle.state].free || vehicle.jobId !== null) {
      throw new VehicleError('busy', `World.removeVehicle: ${vehicle.label} je v stave '${vehicle.state}' (job ${String(vehicle.jobId)})`);
    }
    this.depotOf(vehicle, 'World.removeVehicle').detachVehicle(vehicleId);
    vehicle.leaveRoad();
    this.vehicleMap.delete(vehicleId);
    if (vehicleId === this.lastVehicleId) this.lastVehicleId = lastKeyOf(this.vehicleMap);
    return vehicle;
  }

  // -------------------------------------------------------------------------------------------------------
  // Stroje blokov (ADR-040)
  // -------------------------------------------------------------------------------------------------------

  /** Stroj bloku `blockId` (RTG bloku), alebo `undefined`. */
  machineOfBlock(blockId: EntityId): YardMachine | undefined {
    for (const machine of this.machineMap.values()) if (machine.blockId === blockId) return machine;
    return undefined;
  }

  /**
   * Pridá stroj (`placeModule` RTG bloku, obnova zo save). Chyby (`MachineError`, svet sa nezmení): id už vo svete má iná entita (`duplicate_id`), id nepridelené
   * alokátorom alebo nejde vzostupne (`invalid_input`), blok nie je RTG blok vo svete, alebo už má stroj (`unknown_block`).
   */
  addMachine(machine: YardMachine): void {
    const { id } = machine;
    if (this.machineMap.has(id) || this.moduleMap.has(id) || this.shipMap.has(id) || this.vehicleMap.has(id) || this.jobMap.has(id) || this.truckMap.has(id) || this.cargo.get(id) !== undefined) {
      throw new MachineError('duplicate_id', `World.addMachine: id ${String(id)} už vo svete je`);
    }
    if (id >= this.ids.getState().nextId) {
      throw new MachineError('invalid_input', `World.addMachine: id ${String(id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    if (!(this.moduleMap.get(machine.blockId) instanceof RtgBlock) || this.machineOfBlock(machine.blockId) !== undefined) {
      throw new MachineError('unknown_block', `World.addMachine: ${machine.label}: blok #${String(machine.blockId)} nie je RTG blok bez stroja`);
    }
    this.machineMap.set(id, machine);
  }

  /** Odstráni stroj (zánik bloku) a vráti ho; stroj v cykle alebo s frontou sa neodstráni (`busy`), neznáme id → `unknown_machine`. */
  removeMachine(machineId: EntityId): YardMachine {
    const machine = this.machineMap.get(machineId);
    if (machine === undefined) throw new MachineError('unknown_machine', `World.removeMachine: stroj #${String(machineId)} neexistuje`);
    if (machine.state !== 'idle' || machine.cycle !== null || machine.queue.length > 0) {
      throw new MachineError('busy', `World.removeMachine: ${machine.label} je v stave '${machine.state}' (fronta ${String(machine.queue.length)})`);
    }
    this.machineMap.delete(machineId);
    return machine;
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
    if (this.jobMap.has(id) || this.moduleMap.has(id) || this.shipMap.has(id) || this.vehicleMap.has(id) || this.truckMap.has(id) || this.cargo.get(id) !== undefined) {
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
      if (traits.cargoAt === 'source' && !unitAtJobSource(this, job, unit)) {
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
   * Odstráni ukončený job — hotový (`done`, `VehicleSystem` po vykládke) alebo zrušený (`cancelled`, dispatcher, ADR-023)
   * — a vráti ho. Rezerváciu v cieli uvoľňuje volajúci (pri `done` ju už premenil `commit`). Chyby (`JobError`, svet sa
   * nezmení): neznáme id (`unknown_job`), job je ešte aktívny (`not_done`).
   */
  removeJob(jobId: EntityId): TransportJob {
    const job = this.jobMap.get(jobId);
    if (job === undefined) throw new JobError('unknown_job', `World.removeJob: job #${String(jobId)} neexistuje`);
    if (JOB_STATE_TRAITS[job.state].active) throw new JobError('not_done', `World.removeJob: ${job.label} je v aktívnom stave '${job.state}'`);
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

  // -------------------------------------------------------------------------------------------------------
  // Kamióny (T04-04, ADR-024)
  // -------------------------------------------------------------------------------------------------------

  /**
   * Pridá kamión (spawn v `LandsideSystem`, obnova zo save): kamión s lístkom drží token cieľa — rezervované TP (`tpCell`), alebo státie odstavnej plochy (`holdingId` + `stall`). Chyby
   * (`TruckError`, svet sa nezmení): id už vo svete má kamión, vozidlo, modul, loď, job alebo jednotka (`duplicate_id`), id nepridelil alokátor sveta alebo je menšie ako id posledného
   * kamióna — poradie spawnu (`invalid_input`), blok, brána alebo odstavná plocha nie sú moduly toho druhu vo svete alebo státie je mimo rozsahu (`unknown_module`), TP alebo státie
   * drží iný kamión (`tp_taken`, `stall_taken`), konflikt pruhových slotov (`slot_taken`). Frontu brány a obsadenie predbránovej plochy spravuje volajúci.
   */
  addTruck(truck: Truck): void {
    const { id } = truck;
    if (this.truckMap.has(id) || this.moduleMap.has(id) || this.shipMap.has(id) || this.vehicleMap.has(id) || this.jobMap.has(id) || this.cargo.get(id) !== undefined) {
      throw new TruckError('duplicate_id', `World.addTruck: id ${String(id)} už vo svete je`);
    }
    if (id >= this.ids.getState().nextId) {
      throw new TruckError('invalid_input', `World.addTruck: id ${String(id)} nepridelil alokátor sveta (nextId ${String(this.ids.getState().nextId)})`);
    }
    const last = this.lastTruckId;
    if (last !== undefined && id < last) throw new TruckError('invalid_input', `World.addTruck: ${truck.label} má menšie id ako posledný kamión #${String(last)}`);
    const block = this.moduleMap.get(truck.blockId);
    const gate = this.moduleMap.get(truck.gateId);
    if (!(block instanceof YardBlock) || !(gate instanceof TruckGate)) {
      throw new TruckError('unknown_module', `World.addTruck: ${truck.label}: blok #${String(truck.blockId)} alebo brána #${String(truck.gateId)} vo svete nie je`);
    }
    if (truck.holdingId !== null) {
      const holding = this.moduleMap.get(truck.holdingId);
      if (!(holding instanceof TruckHolding) || truck.stall === null || truck.stall >= holding.stalls) {
        throw new TruckError('unknown_module', `World.addTruck: ${truck.label}: odstavná plocha #${String(truck.holdingId)} alebo státie ${String(truck.stall)} vo svete nie je`);
      }
      const other = this.truckIndex.stallHolder(truck.holdingId, truck.stall);
      if (other !== undefined) throw new TruckError('stall_taken', `World.addTruck: ${truck.label}: státie ${String(truck.stall)} ${holding.label} drží kamión #${String(other.id)}`);
    }
    if (truck.tpCell !== null) {
      const other = this.truckIndex.tpHolder(truck.tpCell);
      if (other !== undefined) throw new TruckError('tp_taken', `World.addTruck: ${truck.label}: TP (bunka ${String(truck.tpCell)}) drží kamión #${String(other.id)}`);
    }
    const taken = this.slotConflict(truck);
    if (taken !== undefined) throw new TruckError('slot_taken', `World.addTruck: ${truck.label}: ${taken}`);
    truck.attachSlots(this.laneSlots);
    this.truckMap.set(id, truck);
    truck.watchChanges(() => {
      this.truckIndex.invalidate();
    });
    this.truckIndex.invalidate();
    this.lastTruckId = id;
  }

  /**
   * Odstráni kamión (export na portáli) a vráti ho. Chyby (`TruckError`, svet sa nezmení): neznáme id (`unknown_truck`),
   * kamión vezie náklad — jednotky `in_truck` by stratili držiteľa (`has_cargo`), kamión drží token (TP, státie) alebo job, alebo stojí vo fronte brány (`busy`).
   */
  removeTruck(truckId: EntityId): Truck {
    const truck = this.truckMap.get(truckId);
    if (truck === undefined) throw new TruckError('unknown_truck', `World.removeTruck: kamión #${String(truckId)} neexistuje`);
    const aboard = this.cargo.countAt('in_truck', truckId);
    if (aboard > 0) throw new TruckError('has_cargo', `World.removeTruck: ${truck.label} vezie ${String(aboard)} jednotiek`);
    const gate = this.moduleMap.get(truck.gateId);
    if (truck.tpCell !== null || truck.stall !== null || truck.jobId !== null || (gate instanceof TruckGate && gate.isQueued(truckId))) {
      throw new TruckError('busy', `World.removeTruck: ${truck.label} v stave '${truck.state}' drží TP, státie alebo job, alebo stojí vo fronte brány`);
    }
    truck.leaveRoad();
    this.truckMap.delete(truckId);
    truck.watchChanges(null);
    this.truckIndex.invalidate();
    if (truckId === this.lastTruckId) this.lastTruckId = lastKeyOf(this.truckMap);
    return truck;
  }

  /** Popis konfliktu slotov nosiča s inými nosičmi (`body`, `ahead` pri pridaní / obnove), alebo `undefined`. */
  private slotConflict(carrier: Carrier): string | undefined {
    for (const key of [...carrier.body, ...carrier.ahead]) {
      if (!this.laneSlots.isFreeFor(key, carrier.id)) {
        return `slot ${String(key)} (bunka ${String(key >> 1)}, pruh ${String(key & 1)}) drží #${String(this.laneSlots.holderOfKey(key))}`;
      }
    }
    return undefined;
  }

  /**
   * Vozidlo, ktoré zaberá bunku s indexom `index` — stojí na nej (`vehicle.cell`), je to cieľová bunka jeho
   * rozbehnutého úseku (ADR-019), alebo ju drží jeho telo či slot vpredu (`Carrier.occupiesCell`, ADR-037); inak `undefined`. Prechádza vozidlá vzostupne podľa id (príkazy, nie hot path).
   */
  vehicleOnCell(index: number): Vehicle | undefined {
    for (const vehicle of this.vehicleMap.values()) {
      if (vehicle.occupiesCell(index)) return vehicle;
    }
    return undefined;
  }

  /**
   * Nosič (vozidlo, potom kamión), ktorý zaberá bunku `index` — stojí na nej, je to cieľová bunka jeho rozbehnutého
   * úseku (ADR-019, ADR-024), alebo ju drží jeho telo či slot vpredu (ADR-037); inak `undefined`. `RemoveRoad` a prestavba `PlaceRoad` takú bunku odmietnu (`occupied`).
   * Príkazy, nie hot path.
   */
  carrierOnCell(index: number): Carrier | undefined {
    const vehicle = this.vehicleOnCell(index);
    if (vehicle !== undefined) return vehicle;
    for (const truck of this.truckMap.values()) {
      if (truck.occupiesCell(index)) return truck;
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
   * `CargoMoved`, pri uzavretí dňa `MoneyChanged` údržby a miezd, `DayClosedSummary`, `MonthlyReport`, `GameOver`).
   * Po bankrote (`gameOver`) aplikuje len príkazy a vráti ich udalosti (čas stojí).
   * Pri zapnutom `checkInvariants` krok 12 pri porušení vyhodí `CargoConservationError` / `WorldInvariantError`.
   */
  tick(): readonly SimEvent[] {
    // Príkazy z fronty sa aplikujú pred krokom 1 (§6).
    this.applyQueuedCommands();

    // Po bankrote (GameOver, ADR-025) sa čas neposúva a systémy netickujú — tick vráti len udalosti príkazov.
    if (this.economy.gameOver) return this.events.flush();

    // 1. clock.advance() — tick++, hranice hodiny/dňa/mesiaca.
    const closed = this.advanceClock();

    // 2. contractSystem — spawn lodí prijatých kontraktov, loď pri kotvisku, penalizácie, dokončenie, zlyhanie,
    //    expirácia ponúk a doplnenie poolu pri štarte hry a pri DayClosed (ADR-026).
    this.contractSystem.tick(this, closed);

    // 3. shipSystem — pohyb po sea lane, alokácia kotvísk, docking/undocking.
    this.shipSystem.tick(this);

    // 4. craneSystem — cyklus žeriavov loď → apron.
    this.craneSystem.tick(this);

    // 5. dispatcher — zrušenie nepoužiteľných outbound jobov, inbound joby s rezerváciou skladu, outbound joby
    //    s rezerváciou staging miesta rampy, priradenie voľných vozidiel inbound pred outbound (ADR-018, ADR-023).
    this.dispatcherSystem.tick(this);

    // 6a. trafficSystem — pohyb všetkých nosičov na cestách (vozidlá aj kamióny) pod pruhovými slotmi, zápchy (ADR-037, ADR-038).
    this.trafficSystem.tick(this);

    // 6b. vehicleSystem — FSM vozidiel bez pohybu: príchody, pobyt v module, load/unload (ADR-019).
    this.vehicleSystem.tick(this);

    // 6c. yardMachineSystem — stroje blokov (RTG): fronta TP, cykly zdvih / pojazd / odklad, odovzdanie vozidlu (ADR-040; poradie §6 rozšírené o krok 6c).
    this.yardMachineSystem.tick(this);

    // 6d. reeferSystem — napájanie reeferov (zapojenie, odpojenie, hodiny bez prúdu), alarmy a technici, reklamácie, elektrina (ADR-042; poradie §6 rozšírené o krok 6d).
    this.reeferSystem.tick(this, closed);

    // 6e. railSystem — vlaky: cestovný poriadok a vznik na koľajovom portáli, jazda po koľaji (jeden pohyblivý vlak, bez prekrytia), pobyt v termináli, odchod cez portál (ADR-043; poradie §6 rozšírené o krok 6e).
    this.railSystem.tick(this);

    // 7. flowSystem — pribudne s potrubiami (F9) presne na tomto mieste §6.

    // 8. landsideSystem — kamióny (FSM, pohyb, nakládka, export), brány (FIFO, priepustnosť), spawn (ADR-024).
    this.landsideSystem.tick(this);

    // 9. economySystem — pri DayClosed údržba, mzdy, DaySummary, pri MonthClosed MonthSummary, bankrot (ADR-025).
    this.economySystem.tick(this, closed);

    // 10. techSystem — pribudne s tech stromom (F8) presne na tomto mieste §6.

    // 11. metricsSystem — traffic pod vozidlami po pohybe, decay pri HourClosed.
    this.metricsSystem.tick(this, closed.hourClosed);

    // 12. invarianty (DEV/testy): konzervácia nákladu + konzistencia modulov, apronov, žeriavov a lodí.
    if (this.checkInvariants) this.assertInvariants();

    // 13. events.flush() — udalosti ticku pre prezentáciu.
    return this.events.flush();
  }

  /**
   * Čistý JSON stav v9 (§14; tvar pozri `WorldState`, ADR-032, ADR-034, ADR-035): v1 polia (cesty s typom a smerom, ADR-020) + `traffic`, `modules` (poradie umiestnenia),
   * `cargo` (`cargo.getState()`), `ships` (vzostupne podľa id, `Ship.toState()`), `vehicles` (vzostupne podľa id,
   * `Vehicle.toState()`), `jobs` (aktívne joby vzostupne podľa id, `TransportJob.toState()`, ADR-018) a `trucks` (vzostupne podľa
   * id, `Truck.toState()`, ADR-024), `economy` (`Economy.getState()`: kniha, súčty otvoreného dňa, súhrny, bankrot — ADR-025;
   * hotovosť ostáva v `cashCents`) a kniha kontraktov (`contracts`, `xp`, `completedContracts`, `nextContractId`,
   * `nextVoyageId` — ADR-026, ADR-032), `emptyFlow` (plán prázdnych kontajnerov, ADR-034) a `hinterland` (počítadlá vnútrozemia, ADR-035). Fronta príkazov sa neukladá, preto musí byť prázdna —
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
      cashCents: this.economy.cashCents,
      roads,
      parcels,
      traffic,
      modules,
      cargo: this.cargo.getState(),
      ships: [...this.shipMap.values()].map((ship) => ship.toState()),
      vehicles: [...this.vehicleMap.values()].map((vehicle) => vehicle.toState()),
      jobs: [...this.jobMap.values()].map((job) => job.toState()),
      trucks: [...this.truckMap.values()].map((truck) => truck.toState()),
      machines: [...this.machineMap.values()].map((machine) => machine.toState()),
      trains: [...this.rail.trains.values()].map((train) => train.toState()),
      rail: this.rail.getState(),
      economy: this.economy.getState(),
      ...this.contractBook.getState(),
      emptyFlow: this.emptyFlow.getState(),
      hinterland: this.hinterland.getState(),
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
    const roadChangesBefore = this.roadChanges; // starter kotvisko pri vzniku sveta cestnú sieť nemení (cache ciest ešte neexistujú, nie sú vozidlá)
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
    this.roadChanges = roadChangesBefore;
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
   * Príkazy vo fronte v poradí vloženia: `validate` nad aktuálnym stavom (vidí účinok predchádzajúcich príkazov; po
   * `GameOver` vždy `game_over`, `withGameOver`), pri úspechu `apply`, inak `CommandRejected` bez zmeny stavu.
   * Spracujú sa len príkazy zaradené pred začiatkom kola; príkaz zaradený počas `apply` počká na ďalšie kolo.
   */
  private applyQueuedCommands(): void {
    const count = this.pendingCommands.length;
    for (let i = 0; i < count; i++) {
      // `shift` po jednom: ak `apply` vyhodí výnimku, zvyšné príkazy ostanú vo fronte.
      const command = this.pendingCommands.shift() as Command;
      // Po GameOver sa neaplikuje nič — aj príkaz mimo základu `SimCommand` (ADR-027).
      const result = withGameOver(this, command.validate(this));
      if (result.ok) {
        command.apply(this);
        this.publishLandside(true);
      } else {
        this.events.emit({ type: 'CommandRejected', commandType: command.type, reasons: Object.freeze([...result.reasons]) });
      }
    }
    // Zmeny ciest alebo modulov mimo príkazov (priame volania štrukturálnych operácií) sa zverejnia najneskôr tu.
    this.publishLandside(true);
  }

  /**
   * Zverejní pozemný reťazec do modulov (ADR-022), ak sa od posledného zverejnenia zmenili cesty alebo moduly: bránam
   * strany (`TruckGate.setSides`). V príkazovej fáze (`emit`) potom urovná
   * fronty brán (`settleGateQueues`, dodatok ADR-024): kamión vo fronte, pod ktorým sa strany brány preklopili, ide
   * ďalej bez prechodu — invariant „kamión vo fronte stojí na svojej strane" tak platí po každom príkaze aj ticku.
   * `create` a `deserialize` (bez `emit`) fronty nemenia (obnova overila strany front). Pri nezmenených verziách nerobí nič.
   */
  private publishLandside(emit: boolean): void {
    if (this.roadChanges === this.publishedRoadVersion && this.moduleChanges === this.publishedModuleVersion) return;
    this.publishedRoadVersion = this.roadChanges;
    this.publishedModuleVersion = this.moduleChanges;
    const { landside } = this;
    const { gates } = this.landsideModules;
    for (const gate of gates) {
      const sides = landside.gateSides(gate);
      gate.setSides(sides.entry, sides.exit);
    }
    if (emit) settleGateQueues(this);
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
