/**
 * Obnova entít zo save (ARCHITECTURE §14, ADR-014, ADR-016, ADR-017, ADR-018): moduly v poradí save (= poradie
 * umiestnenia) cez `ModuleRegistry` a `World.addModule`, lode vzostupne podľa id cez `World.addShip` (pred kontrolou
 * držiteľov nákladu — `on_ship` číta `world.ships`) s obnovou `BerthModule.dockedShipId` z `berthIds`, vozidlá
 * vzostupne podľa id cez `World.addVehicle` (T03-04; depo dostane `vehicleIds` v poradí id = poradí nákupu), potom
 * kontrola držiteľov a slotov nákladu (slot v kapacite apronu/skladu, náklad vozidla v jeho kapacite a kategóriách),
 * joby vzostupne podľa id (T03-05: vozidlo a stav jobu sa odvodia z vozidla s daným `jobId` a z polohy nákladu,
 * `World.addJob`, rezervácia slotu v cieľovom sklade), náklad vozidla patrí jeho jobu, pohyb vozidla zodpovedá stavu
 * (trasa, odpočet, cesty — `vehicleMotionProblem`), rezervácie apronov
 * z `reservedSlot` žeriavov, držané jednotky žeriavov z `in_crane` a hodiny throttlov (`lastBlockedHour`,
 * `lastNoStorageHour`) nie sú v budúcnosti. Obsadenie apronov, skladov a dockov rámp sa neobnovuje — čítajú ho z ledgera
 * (ADR-017, ADR-022); jednotky na rampe musia ležať na docku v rozsahu a v jeho kapacite (`checkRampUnits`). Pozemné
 * moduly (T04-02) obnovia `runtime` (brána: fronta a počítadlá); strany brán a prevádzkovosť rámp odvodí svet po obnove.
 * Na koniec beží `findWorldViolation` ako poistka. Každá chyba je `WorldStateError` s JSON pointerom.
 */
import { holderIdOf, holderSpecOf, isSameLocation, uniqueSlotOf } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { JobError, type JobErrorCode } from '../logistics/job-error';
import { JOB_STATE_TRAITS, TransportJob, type JobState } from '../logistics/transport-job';
import { BerthModule } from '../modules/berth-module';
import { CRANE_STATE_TRAITS, CraneModule } from '../modules/crane-module';
import { LoadingRamp } from '../modules/loading-ramp';
import { ModuleError, ModuleStateError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import { StorageModule } from '../modules/storage-module';
import { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import { mooringProblem, shipRoute } from '../ships/ship-route';
import { Vehicle } from '../vehicles/vehicle';
import { VehicleError, type VehicleErrorCode } from '../vehicles/vehicle-error';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';
import { vehicleMotionProblem } from '../vehicles/vehicle-trip';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import { WorldStateError, pointerSegment } from './state-check';
import type { World } from './world';
import { findWorldViolation } from './world-invariants';
import type { ParsedJobEntry, ParsedModuleEntry, ParsedShipEntry, ParsedVehicleEntry, ParsedWorldState } from './world-state';

const modulePath = (index: number): string => `/modules${pointerSegment(index)}`;
const unitPath = (index: number): string => `/cargo/units${pointerSegment(index)}`;

/** Chyba modulu → `WorldStateError` s cestou modulu (stav triedy pod `/runtime`). */
function asStateError(error: unknown, path: string): unknown {
  if (error instanceof ModuleStateError) return new WorldStateError(`${path}/runtime${error.path}`, error.problem);
  if (error instanceof ModuleError) return new WorldStateError(path, error.message);
  return error;
}

function restoreModules(world: World, entries: readonly ParsedModuleEntry[]): void {
  entries.forEach((entry, index) => {
    const path = modulePath(index);
    try {
      const def = world.defs.modules.get(entry.spec.defId);
      const module = moduleRegistry.create(def, entry.spec, entry.id, entry.purchaseCostCents, { grid: world.grid, cargo: world.cargo });
      module.restoreRuntimeState(entry.runtime);
      world.addModule(module);
    } catch (error) {
      throw asStateError(error, path);
    }
  });
}

const shipPath = (index: number): string => `/ships${pointerSegment(index)}`;

/** Kotviská lode: existujúce berthy, ktoré nedrží iná loď; zapíše im `dockedShipId` (neukladá sa, ADR-014). */
function claimShipBerths(world: World, ship: Ship, path: string): void {
  ship.berthIds.forEach((berthId, i) => {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) throw new WorldStateError(`${path}/berthIds${pointerSegment(i)}`, `#${String(berthId)} nie je kotvisko vo svete`);
    if (berth.dockedShipId !== null) {
      throw new WorldStateError(`${path}/berthIds${pointerSegment(i)}`, `${berth.label} už drží loď #${String(berth.dockedShipId)}`);
    }
    berth.dockedShipId = ship.id;
  });
}

/**
 * Lode vzostupne podľa id: inštancia `Ship` (triedu a náklad overil `parseWorldState`), kotviská (`claimShipBerths`),
 * dokovaná loď presne v polohe a s kurzom pri kotvisku (`mooringProblem`, T02-14), jedinečná anchorage
 * a `waypointIndex` najviac dĺžka trasy stavu; potom `World.addShip` (`ShipError` → `WorldStateError`).
 */
function restoreShips(world: World, entries: readonly ParsedShipEntry[]): void {
  const anchorages = new Map<number, number>();
  entries.forEach((entry, index) => {
    const path = shipPath(index);
    let ship: Ship;
    try {
      ship = new Ship({
        id: entry.id,
        def: world.defs.ships.get(entry.classId),
        cargoType: world.defs.cargoTypes.get(entry.cargoTypeId),
        state: entry.state,
        x: entry.x,
        y: entry.y,
        heading: entry.heading,
        berthIds: entry.berthIds,
        anchorageIndex: entry.anchorageIndex,
        waypointIndex: entry.waypointIndex,
      });
    } catch (error) {
      if (error instanceof ShipError) throw new WorldStateError(path, error.message);
      throw error;
    }
    claimShipBerths(world, ship, path);
    const mooring = mooringProblem(ship, world);
    if (mooring !== undefined) throw new WorldStateError(`${path}/${mooring.field}`, mooring.problem);
    if (ship.anchorageIndex !== null) {
      const holder = anchorages.get(ship.anchorageIndex);
      if (holder !== undefined) throw new WorldStateError(`${path}/anchorageIndex`, `anchorage ${String(ship.anchorageIndex)} už obsadila loď #${String(holder)}`);
      anchorages.set(ship.anchorageIndex, ship.id);
    }
    const routeLength = shipRoute(ship, world).length;
    if (ship.waypointIndex > routeLength) {
      throw new WorldStateError(`${path}/waypointIndex`, `trasa stavu '${ship.state}' má ${String(routeLength)} bodov, index ${String(ship.waypointIndex)}`);
    }
    try {
      world.addShip(ship);
    } catch (error) {
      // Tvar id overil `parseWorldState`; toto je posledná poistka, aby aj tu vznikla chyba save s cestou.
      if (error instanceof ShipError) throw new WorldStateError(`${path}/id`, error.message);
      throw error;
    }
  });
}

const vehiclePath = (index: number): string => `/vehicles${pointerSegment(index)}`;

/** Pole záznamu vozidla, ku ktorému patrí chyba `World.addVehicle` (depo vs. id). */
const VEHICLE_ERROR_FIELD: { readonly [C in VehicleErrorCode]: string } = {
  invalid_input: 'id',
  duplicate_id: 'id',
  unknown_depot: 'depotId',
  depot_full: 'depotId',
  unknown_vehicle: 'id',
  has_cargo: 'id',
  busy: 'state',
  invalid_transition: 'state',
  inconsistent: 'state',
};

/**
 * Vozidlá vzostupne podľa id: inštancia `Vehicle` (def a stav overil `parseWorldState`), potom `World.addVehicle`
 * (depo existuje a má voľné státie; `VehicleError` → `WorldStateError` s poľom záznamu). Job vozidla overí
 * `restoreJobs`.
 */
function restoreVehicles(world: World, entries: readonly ParsedVehicleEntry[]): void {
  entries.forEach((entry, index) => {
    const path = vehiclePath(index);
    try {
      world.addVehicle(
        new Vehicle({
          id: entry.id,
          def: world.defs.vehicles.get(entry.defId),
          depotId: entry.depotId,
          state: entry.state,
          x: entry.x,
          y: entry.y,
          heading: entry.heading,
          jobId: entry.jobId,
          purchaseCostCents: entry.purchaseCostCents,
          route: entry.route,
          progress: entry.progress,
          waitTicks: entry.waitTicks,
          replanPending: entry.replan,
        }),
      );
    } catch (error) {
      if (error instanceof VehicleError) throw new WorldStateError(`${path}/${VEHICLE_ERROR_FIELD[error.code]}`, error.message);
      throw error;
    }
  });
}

const jobPath = (index: number): string => `/jobs${pointerSegment(index)}`;

/** Pole záznamu jobu, ku ktorému patrí chyba `World.addJob` / `TransportJob`. */
const JOB_ERROR_FIELD: { readonly [C in JobErrorCode]: string } = {
  invalid_input: '',
  invalid_transition: '',
  duplicate_id: '/id',
  unknown_unit: '/unitIds',
  unit_busy: '/unitIds',
  unknown_job: '/id',
  not_done: '',
};

/**
 * Vozidlá podľa jobu v `jobId` (vzostupne podľa id); dve vozidlá s tým istým jobom a vozidlo s jobom, ktorý v save nie
 * je, sú chyba vozidla (`/vehicles/<v>/jobId`).
 */
function vehiclesByJob(world: World, entries: readonly ParsedJobEntry[]): Map<EntityId, Vehicle> {
  const known = new Set<EntityId>(entries.map((entry) => entry.id));
  const byJob = new Map<EntityId, Vehicle>();
  let index = 0;
  for (const vehicle of world.vehicles.values()) {
    const { jobId } = vehicle;
    if (jobId !== null) {
      const path = `${vehiclePath(index)}/jobId`;
      if (!known.has(jobId)) throw new WorldStateError(path, `job #${String(jobId)} vo svete neexistuje`);
      const other = byJob.get(jobId);
      if (other !== undefined) throw new WorldStateError(path, `job #${String(jobId)} už má vozidlo ${other.label}`);
      byJob.set(jobId, vehicle);
    }
    index += 1;
  }
  return byJob;
}

/**
 * Stav jobu odvodený z vozidla (ADR-018): bez vozidla `open`, inak jediný stav z `VEHICLE_STATE_TRAITS.jobStates`
 * stavu vozidla, pri `no_path` ten, ktorého `cargoAt` zodpovedá polohe prvej jednotky (vo vozidle → `moving`).
 */
function deriveJobState(world: World, entry: ParsedJobEntry, vehicle: Vehicle | undefined): JobState {
  if (vehicle === undefined) return 'open';
  const candidates = VEHICLE_STATE_TRAITS[vehicle.state].jobStates;
  const location = world.cargo.get(entry.unitIds[0])?.location;
  const place = location?.kind === 'in_vehicle' && location.vehicleId === vehicle.id ? 'vehicle' : 'source';
  return candidates.find((state) => JOB_STATE_TRAITS[state].cargoAt === place) ?? candidates[0] ?? 'open';
}

/** Jednotky jobu existujú a ležia tam, kde ich stav jobu hovorí (`cargoAt`: na `from` alebo vo vozidle jobu). */
function checkJobCargo(world: World, job: TransportJob, path: string): void {
  const place = JOB_STATE_TRAITS[job.state].cargoAt;
  job.unitIds.forEach((unitId, k) => {
    const unitPathInJob = `${path}/unitIds${pointerSegment(k)}`;
    const unit = world.cargo.get(unitId);
    if (unit === undefined) throw new WorldStateError(unitPathInJob, `jednotka #${String(unitId)} v save nie je`);
    const expected = place === 'vehicle' && job.vehicleId !== null ? { kind: 'in_vehicle' as const, vehicleId: job.vehicleId } : job.from;
    if (!isSameLocation(unit.location, expected)) {
      throw new WorldStateError(unitPathInJob, `jednotka #${String(unitId)} jobu v stave '${job.state}' má byť na ${place === 'vehicle' ? 'vozidle jobu' : 'zdroji jobu'}`);
    }
  });
}

/**
 * Joby vzostupne podľa id (ADR-018): vozidlo = vozidlo s týmto `jobId`, stav odvodený (`deriveJobState`), náklad na
 * mieste podľa stavu, vozidlo vozí kategóriu nákladu, `World.addJob`, cieľ je sklad kategórie nákladu a jeho slot
 * sa rezervuje (`reserveSlot`: v rozsahu, voľný, nie dvakrát). Chyby → `/jobs/<i>…` (resp. `/vehicles/<v>/jobId`).
 */
function restoreJobs(world: World, entries: readonly ParsedJobEntry[]): void {
  const byJob = vehiclesByJob(world, entries);
  entries.forEach((entry, index) => {
    const path = jobPath(index);
    const vehicle = byJob.get(entry.id);
    let job: TransportJob;
    try {
      job = new TransportJob({ ...entry, state: deriveJobState(world, entry, vehicle), vehicleId: vehicle?.id ?? null });
    } catch (error) {
      if (error instanceof JobError) throw new WorldStateError(path, error.message);
      throw error;
    }
    checkJobCargo(world, job, path);
    const unit = world.cargo.get(job.unitIds[0]);
    const category = unit === undefined ? undefined : world.defs.cargoTypes.get(unit.typeId).category;
    if (vehicle !== undefined && (category === undefined || !vehicle.def.cargoCategories.includes(category))) {
      throw new WorldStateError(`${path}/unitIds/0`, `${vehicle.label} nevozí náklad kategórie '${String(category)}'`);
    }
    try {
      world.addJob(job);
    } catch (error) {
      if (error instanceof JobError) throw new WorldStateError(`${path}${JOB_ERROR_FIELD[error.code]}`, error.message);
      throw error;
    }
    const storage = world.modules.get(job.toModuleId);
    if (!(storage instanceof StorageModule)) throw new WorldStateError(`${path}/to/moduleId`, `#${String(job.toModuleId)} nie je sklad vo svete`);
    if (storage.category !== category) {
      throw new WorldStateError(`${path}/to/moduleId`, `${storage.label} (kategória '${storage.category}') neprijme náklad kategórie '${String(category)}'`);
    }
    try {
      storage.reserveSlot(uniqueSlotOf(job.to) ?? -1);
    } catch (error) {
      if (error instanceof ModuleError) throw new WorldStateError(`${path}/to/slot`, error.message);
      throw error;
    }
  });
}

/**
 * Náklad vozidla patrí jeho jobu v stave s nákladom vo vozidle (rozhodnutie orchestrátora F3 č. 5: `idle` vozidlo
 * nevezie nič). Volá sa po `restoreJobs`; chyba patrí jednotke (`/cargo/units/<j>/location/vehicleId`).
 */
function checkVehicleCargoJobs(world: World, units: readonly CargoUnit[]): void {
  units.forEach((unit, index) => {
    if (unit.location.kind !== 'in_vehicle') return;
    const { vehicleId } = unit.location;
    const job = world.jobOfUnit(unit.id);
    if (job?.vehicleId !== vehicleId || JOB_STATE_TRAITS[job.state].cargoAt !== 'vehicle') {
      throw new WorldStateError(`${unitPath(index)}/location/vehicleId`, `vozidlo #${String(vehicleId)} vezie jednotku #${String(unit.id)} bez svojho jobu s nákladom vo vozidle`);
    }
  });
}

/**
 * Náklad vozidiel (`in_vehicle`): najviac `capacityUnits` jednotiek na vozidlo a len kategórie z `cargoCategories`
 * defu. Volá sa po `checkHolders` (vozidlo existuje); chyba patrí jednotke (`/cargo/units/<j>/location/vehicleId`).
 */
function checkVehicleCargo(world: World, units: readonly CargoUnit[]): void {
  const loaded = new Map<EntityId, number>();
  units.forEach((unit, index) => {
    if (unit.location.kind !== 'in_vehicle') return;
    const vehicle = world.vehicles.get(unit.location.vehicleId);
    if (vehicle === undefined) return;
    const path = `${unitPath(index)}/location/vehicleId`;
    const count = (loaded.get(vehicle.id) ?? 0) + 1;
    loaded.set(vehicle.id, count);
    if (count > vehicle.def.capacityUnits) {
      throw new WorldStateError(path, `${vehicle.label} unesie ${String(vehicle.def.capacityUnits)} jednotiek, v save ich má viac`);
    }
    const { category } = world.defs.cargoTypes.get(unit.typeId);
    if (!vehicle.def.cargoCategories.includes(category)) {
      throw new WorldStateError(path, `${vehicle.label} nevozí náklad kategórie '${category}' (jednotka #${String(unit.id)})`);
    }
  });
}

/**
 * Rezervácie apronov z `reservedSlot` žeriavov; hodina posledného `CraneBlocked` nesmie byť v budúcnosti. Rezervovaný
 * slot, na ktorom podľa ledgera leží jednotka, je chyba **jednotky** (`/cargo/units/<j>/location/slot`) — rovnako ako
 * pred T03-02, keď apron obsadenie ešte zrkadlil.
 */
function restoreCraneReservations(world: World, indexOf: ReadonlyMap<EntityId, number>, unitIndexOf: ReadonlyMap<EntityId, number>): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const path = `${modulePath(indexOf.get(module.id) ?? -1)}/runtime`;
    if (module.lastBlockedHour !== null && module.lastBlockedHour > world.clock.gameHour) {
      throw new WorldStateError(`${path}/lastBlockedHour`, `hodina ${String(module.lastBlockedHour)} je po aktuálnej ${String(world.clock.gameHour)}`);
    }
    const berth = world.modules.get(module.berthId);
    const slot = module.reservedSlot;
    if (slot === null || !(berth instanceof BerthModule)) continue;
    const occupant = slot < berth.apron.capacity ? berth.apron.unitAt(slot) : null;
    if (occupant !== null) {
      throw new WorldStateError(
        `${unitPath(unitIndexOf.get(occupant) ?? -1)}/location/slot`,
        `apron ${berth.label}: slot ${String(slot)} je rezervovaný žeriavom ${module.label}`,
      );
    }
    try {
      berth.apron.reserveSlot(slot);
    } catch (error) {
      if (error instanceof ModuleError) throw new WorldStateError(`${path}/reservedSlot`, `apron ${berth.label}: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Pohyb vozidiel zodpovedá stavu (`vehicleMotionProblem`, ADR-019): tvar trasy a odpočet podľa stavu, cesty pod
 * vozidlom a pod trasou, cieľ trasy / miesto pobytu na prístupovej bunke modulu jobu. Volá sa po `restoreJobs`.
 */
function checkVehicleMotion(world: World): void {
  let index = 0;
  for (const vehicle of world.vehicles.values()) {
    const problem = vehicleMotionProblem(world, vehicle);
    if (problem !== undefined) throw new WorldStateError(`${vehiclePath(index)}/${problem.field}`, problem.problem);
    index += 1;
  }
}

/** Hodina posledného `NoStorageAvailable` kotviska nesmie byť v budúcnosti (ADR-018). */
function checkBerthHours(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof BerthModule) || module.lastNoStorageHour === null || module.lastNoStorageHour <= world.clock.gameHour) continue;
    throw new WorldStateError(
      `${modulePath(indexOf.get(module.id) ?? -1)}/runtime/lastNoStorageHour`,
      `hodina ${String(module.lastNoStorageHour)} je po aktuálnej ${String(world.clock.gameHour)}`,
    );
  }
}

/** Každá jednotka je u existujúceho držiteľa (`CARGO_HOLDER_SOURCES`). */
function checkHolders(world: World, units: readonly CargoUnit[]): void {
  const holders = new Map<string, ReadonlySet<EntityId>>();
  units.forEach((unit, index) => {
    const { kind } = unit.location;
    const spec = holderSpecOf(kind);
    const holderId = holderIdOf(unit.location);
    if (spec === undefined || holderId === null) return;
    let ids = holders.get(kind);
    if (ids === undefined) {
      ids = new Set(CARGO_HOLDER_SOURCES[kind as keyof typeof CARGO_HOLDER_SOURCES](world));
      holders.set(kind, ids);
    }
    if (!ids.has(holderId)) {
      throw new WorldStateError(`${unitPath(index)}/location/${spec.holderKey}`, `držiteľ '${kind}' #${String(holderId)} vo svete neexistuje`);
    }
  });
}

/**
 * Jednotky na slotoch modulov (apron, sklad — `Module.cargoSlots()`) ležia na slote v rozsahu kapacity držiteľa; ledger
 * rozsah nepozná (ADR-017). Volá sa po `checkHolders`, takže držiteľ existuje.
 */
function checkUnitSlots(world: World, units: readonly CargoUnit[]): void {
  units.forEach((unit, index) => {
    const holderId = holderIdOf(unit.location);
    const holder = holderId === null ? undefined : world.modules.get(holderId);
    const slots = holder?.cargoSlots();
    if (holder === undefined || slots?.kind !== unit.location.kind) return;
    const slot = uniqueSlotOf(unit.location) ?? -1;
    if (slot >= slots.capacity) {
      throw new WorldStateError(`${unitPath(index)}/location/slot`, `${holder.label}: slot ${String(slot)} je mimo 0…${String(slots.capacity - 1)}`);
    }
  });
}

/**
 * Jednotky na rampe (`at_ramp`, T04-02, ADR-022): dock v rozsahu `docks` a na každom docku najviac `stagingPerDock`
 * jednotiek — ledger rozsah ani kapacitu docku nepozná. Volá sa po `checkHolders`; chyba patrí jednotke
 * (`/cargo/units/<j>/location/dock`). Rezervácie staging miest obnovia outbound joby (T04-03).
 */
function checkRampUnits(world: World, units: readonly CargoUnit[]): void {
  const perDock = new Map<string, number>();
  units.forEach((unit, index) => {
    if (unit.location.kind !== 'at_ramp') return;
    const { rampId, dock } = unit.location;
    const ramp = world.modules.get(rampId);
    if (!(ramp instanceof LoadingRamp)) return;
    const path = `${unitPath(index)}/location/dock`;
    if (dock >= ramp.docks) throw new WorldStateError(path, `${ramp.label}: dock ${String(dock)} je mimo 0…${String(ramp.docks - 1)}`);
    const key = `${String(rampId)}:${String(dock)}`;
    const count = (perDock.get(key) ?? 0) + 1;
    perDock.set(key, count);
    if (count > ramp.stagingPerDock) {
      throw new WorldStateError(path, `${ramp.label}: dock ${String(dock)} unesie ${String(ramp.stagingPerDock)} jednotiek, v save ich má viac`);
    }
  });
}

/** Držané jednotky žeriavov z ledgera (`in_crane`). */
function restoreHeldCargo(world: World, units: readonly CargoUnit[]): void {
  units.forEach((unit, index) => {
    const holderId = holderIdOf(unit.location);
    const holder = holderId === null ? undefined : world.modules.get(holderId);
    if (unit.location.kind === 'in_crane' && holder instanceof CraneModule) {
      if (holder.heldUnitId !== null) {
        throw new WorldStateError(`${unitPath(index)}/location/craneId`, `${holder.label} už drží jednotku #${String(holder.heldUnitId)}`);
      }
      holder.heldUnitId = unit.id;
    }
  });
}

/** Stav žeriavu zodpovedá tomu, či drží jednotku (`CRANE_STATE_TRAITS.holdsUnit`). */
function checkCraneHolding(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const { holdsUnit } = CRANE_STATE_TRAITS[module.state];
    if (holdsUnit !== (module.heldUnitId !== null)) {
      throw new WorldStateError(
        `${modulePath(indexOf.get(module.id) ?? -1)}/runtime/state`,
        holdsUnit ? `stav '${module.state}' vyžaduje jednotku in_crane, ledger žiadnu nemá` : `stav '${module.state}' nedrží jednotku, ledger má #${String(module.heldUnitId)}`,
      );
    }
  }
}

/**
 * Obnoví moduly, lode, vozidlá, joby a stav odvodený z ledgera do čerstvého `world` (prázdne moduly, lode, vozidlá aj
 * joby, ledger už obnovený z `parsed.cargo`). Chyby → `WorldStateError`: modul (hranice, obsadenie, žeriav na berthe,
 * `runtime`) → `/modules/<i>…`, loď (kotvisko, anchorage, index trasy) → `/ships/<k>…`, vozidlo (depo, státie, job) →
 * `/vehicles/<v>…`, job (jednotky, stav, sklad, slot) → `/jobs/<i>…`, náklad u neexistujúceho držiteľa (aj `in_vehicle`
 * bez vozidla), nad kapacitou vozidla, vo vozidle bez jobu alebo na neplatnom/rezervovanom slote →
 * `/cargo/units/<j>/location…`, iné porušenie invariantov → `''`.
 */
export function restoreEntities(world: World, parsed: Pick<ParsedWorldState, 'modules' | 'ships' | 'vehicles' | 'jobs' | 'cargo'>): void {
  const entries = parsed.modules;
  const { units } = parsed.cargo;
  restoreModules(world, entries);
  restoreShips(world, parsed.ships);
  restoreVehicles(world, parsed.vehicles);
  const indexOf = new Map<EntityId, number>(entries.map((entry, index) => [entry.id, index]));
  const unitIndexOf = new Map<EntityId, number>(units.map((unit, index) => [unit.id, index]));
  checkHolders(world, units);
  checkVehicleCargo(world, units);
  checkUnitSlots(world, units);
  checkRampUnits(world, units);
  restoreJobs(world, parsed.jobs);
  checkVehicleCargoJobs(world, units);
  checkVehicleMotion(world);
  checkBerthHours(world, indexOf);
  restoreCraneReservations(world, indexOf, unitIndexOf);
  restoreHeldCargo(world, units);
  checkCraneHolding(world, indexOf);
  const violation = findWorldViolation(world);
  if (violation !== undefined) throw new WorldStateError('', violation);
}
