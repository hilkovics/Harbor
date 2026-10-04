/**
 * Obnova entít zo save (ARCHITECTURE §14, ADR-014, ADR-016, ADR-017, ADR-018): moduly v poradí save (= poradie
 * umiestnenia) cez `ModuleRegistry` a `World.addModule`, lode vzostupne podľa id cez `World.addShip` (pred kontrolou
 * držiteľov nákladu — `on_ship` číta `world.ships`) s obnovou `BerthModule.dockedShipId` z `berthIds`, hneď potom trasy
 * lodí podľa stavu a rezervácie lodí na mape bez prekryvu (`checkShipRoutes`, ADR-029 addendum), vozidlá
 * vzostupne podľa id cez `World.addVehicle` (T03-04; depo dostane `vehicleIds` v poradí id = poradí nákupu), potom
 * kontrola držiteľov a slotov nákladu (slot v kapacite apronu/skladu, náklad vozidla v jeho kapacite a kategóriách),
 * joby vzostupne podľa id (T03-05: vozidlo a stav jobu sa odvodia z vozidla s daným `jobId` a z polohy nákladu,
 * `World.addJob`, rezervácia miesta v cieli — slot skladu, staging dock rampy — cez `cargoDropTarget().restoreReservation`,
 * ADR-018, ADR-023), náklad vozidla patrí jeho jobu, pohyb vozidla zodpovedá stavu
 * (trasa, odpočet, cesty — `vehicleMotionProblem`), rezervácie apronov
 * z `reservedSlot` žeriavov, držané jednotky žeriavov z `in_crane` a hodiny throttlov (`lastBlockedHour`,
 * `lastNoStorageHour`) nie sú v budúcnosti. Obsadenie apronov, skladov a dockov rámp sa neobnovuje — čítajú ho z ledgera
 * (ADR-017, ADR-022); jednotky na rampe musia ležať na docku v rozsahu a v jeho kapacite (`checkRampUnits`), staging
 * rezervácie dockov obnovia outbound joby (`staged + reserved ≤ stagingPerDock`, inak chyba jobu). Pozemné
 * moduly (T04-02) obnovia `runtime` (brána: fronta a počítadlá); strany brán a prevádzkovosť rámp odvodí svet po obnove.
 * Kamióny (T04-04, ADR-024) vzostupne podľa id cez `World.addTruck` po vozidlách (pred kontrolou držiteľov — `in_truck`
 * číta `world.trucks`); väzby na rampu, bránu a stojisko a rozsah docku a bay sa overia pred tým s cestou poľa
 * (`checkTruckRefs`, T06-07): kamión znovu drží svoj bay (index zo save), dock a nárok na náklad docku podľa stavu (ADR-029);
 * potom náklad kamióna (kapacita, kategória, stav prázdny/nakládka/plný), väzba na rampu (def vozí jej kategóriu,
 * kamión s dockom má na docku a v sebe aspoň kapacitu; po obnove jobov nároky docku ≤ pripravené + vezené), fronta brány = presne kamióny v `gate_queue*` tejto brány, súlad prechodu brány s frontou (runtime
 * brány), pohyb (`truckMotionProblem`), kamión vo fronte na svojej strane brány, odpočet zarovnaný najviac na taký,
 * aký stav nastaví podľa aktuálnych defov (`truckWaitLimit`, T06-07; zarovnanie T06-08b) a hodina posledného
 * `NoWaitingBay` rampy nie je v budúcnosti.
 * Kontrakty (ADR-026): jednotka s `contractId` patrí kontraktu s loďou a jeho nákladu, jednotka na lodi kontraktu pred
 * vyložením patrí tomuto kontraktu (`checkContracts`); počet jednotiek na palube a počítadlá overí krok 12.
 * Na koniec beží `findWorldViolation` ako poistka. Každá chyba je `WorldStateError` s JSON pointerom.
 */
import { holderIdOf, holderSpecOf, isSameLocation, slotOf, uniqueSlotOf, type CargoLocation } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS, type ContractKind } from '../contracts/contract-fsm';
import type { ContractId, EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import { JobError, type JobErrorCode } from '../logistics/job-error';
import { unitAtJobSource } from '../logistics/job-source';
import { JOB_STATE_TRAITS, TransportJob, type JobState } from '../logistics/transport-job';
import { BerthModule } from '../modules/berth-module';
import { CRANE_STATE_TRAITS, CraneModule } from '../modules/crane-module';
import { LoadingRamp } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import { ModuleError, ModuleStateError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import { legacyShipRoute, mooringProblem, shipRouteProblem } from '../ships/ship-route';
import { TruckGate } from '../modules/truck-gate';
import { WaitingArea } from '../modules/waiting-area';
import { DockSupply } from '../trucks/dock-supply';
import { Truck } from '../trucks/truck';
import { TruckError, type TruckErrorCode } from '../trucks/truck-error';
import { TRUCK_STATE_TRAITS } from '../trucks/truck-fsm';
import { truckMotionProblem } from '../trucks/truck-trip';
import { truckWaitLimit } from '../trucks/truck-wait';
import { Vehicle } from '../vehicles/vehicle';
import { VehicleError, type VehicleErrorCode } from '../vehicles/vehicle-error';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';
import { vehicleMotionProblem } from '../vehicles/vehicle-trip';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import { WorldStateError, pointerSegment } from './state-check';
import type { World } from './world';
import { findWorldViolation, truckQueueSideProblem, truckRampProblem } from './world-invariants';
import type { ParsedJobEntry, ParsedModuleEntry, ParsedShipEntry, ParsedTruckEntry, ParsedVehicleEntry, ParsedWorldState } from './world-state';

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
      const module = moduleRegistry.create(def, entry.spec, entry.id, entry.purchaseCostCents, { grid: world.grid, cargo: world.cargo, pickupCargo: world.isPickupCargo });
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
      const init = {
        id: entry.id,
        def: world.defs.ships.get(entry.classId),
        cargoType: world.defs.cargoTypes.get(entry.cargoTypeId),
        state: entry.state,
        x: entry.x,
        y: entry.y,
        heading: entry.heading,
        berthIds: entry.berthIds,
        anchorageIndex: entry.anchorageIndex,
      };
      // Save v5 trasy neukladal: odvodí sa podľa pravidiel pred ADR-029 (kotviská sú už obnovené).
      const route = entry.route ?? legacyShipRoute(new Ship(init), world);
      if (entry.waypointIndex > route.length) {
        throw new WorldStateError(`${path}/waypointIndex`, `trasa stavu '${entry.state}' má ${String(route.length)} bodov, index ${String(entry.waypointIndex)}`);
      }
      ship = new Ship({ ...init, waypointIndex: entry.waypointIndex, route, lashingTicksLeft: entry.lashingTicksLeft });
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
    try {
      world.addShip(ship);
    } catch (error) {
      // Tvar id overil `parseWorldState`; toto je posledná poistka, aby aj tu vznikla chyba save s cestou.
      if (error instanceof ShipError) throw new WorldStateError(`${path}/id`, error.message);
      throw error;
    }
  });
}

/**
 * Trasy lodí po obnove (ADR-029 addendum, review T5B-04b) — fail-fast namiesto porušenia kroku 12 o pár tickov:
 * súlad uloženej (alebo pre save v5 odvodenej) trasy so stavom (`shipRouteProblem`: prázdna trasa stojacej lode, plavba
 * dnu po celej sea lane, koniec trasy v cieli stavu, poloha na aktuálnom úseku) a rezervácie lodí na mape (obdĺžnik
 * a zvyšok trasy, pri `undocking` aj sea lane von) bez spoločnej bunky — `ShipTraffic.reservationConflict`, chyba na
 * trase lode s vyšším id. Lode sú vo `world.ships` v poradí save (vzostupne podľa id), index = index v `/ships`.
 */
function checkShipRoutes(world: World): void {
  const indexOf = new Map<EntityId, number>();
  let index = 0;
  for (const ship of world.ships.values()) {
    const path = shipPath(index);
    indexOf.set(ship.id, index);
    index += 1;
    const problem = shipRouteProblem(ship, world);
    if (problem !== undefined) throw new WorldStateError(`${path}/${problem.field}`, problem.problem);
  }
  const conflict = world.shipTraffic.reservationConflict();
  if (conflict === undefined) return;
  const { earlier, later } = conflict;
  throw new WorldStateError(
    `${shipPath(indexOf.get(later.id) ?? 0)}/route`,
    `trasa lode ${later.label} (${later.state}) sa prekrýva s rezerváciou lode ${earlier.label} (${earlier.state}) — lode by sa zrazili (ADR-029)`,
  );
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

const truckPath = (index: number): string => `/trucks${pointerSegment(index)}`;

/** Pole záznamu kamióna, ku ktorému patrí chyba `Truck` / `World.addTruck`. */
const TRUCK_ERROR_FIELD: { readonly [C in TruckErrorCode]: string } = {
  invalid_input: 'id',
  duplicate_id: 'id',
  unknown_module: 'rampId',
  bay_taken: 'bay',
  dock_taken: 'dock',
  unknown_truck: 'id',
  has_cargo: 'id',
  busy: 'state',
  invalid_transition: 'state',
  inconsistent: 'state',
};

/** Modul väzby kamióna je modul daného druhu vo svete (pole záznamu, ktoré naň odkazuje). */
interface TruckModuleRef {
  readonly field: 'rampId' | 'gateId' | 'waitingAreaId';
  readonly label: string;
  readonly matches: (module: Module | undefined) => boolean;
}

/** Väzby kamióna na moduly v poradí kontroly (tabuľka, nie switch). */
const TRUCK_MODULE_REFS: readonly TruckModuleRef[] = [
  { field: 'rampId', label: 'rampa', matches: (module) => module instanceof LoadingRamp },
  { field: 'gateId', label: 'brána', matches: (module) => module instanceof TruckGate },
  { field: 'waitingAreaId', label: 'stojisko', matches: (module) => module instanceof WaitingArea },
];

/**
 * Väzby záznamu kamióna pred `World.addTruck` (T06-07): rampa, brána a stojisko sú moduly toho druhu vo svete, dock je
 * v rozsahu `docks` rampy a bay v rozsahu `bays` stojiska. Chyba patrí poľu, ktoré odkazuje zle (`/trucks/<i>/<pole>`);
 * obsadenosť bay a docku overí `World.addTruck`.
 */
function checkTruckRefs(world: World, entry: ParsedTruckEntry, path: string): void {
  for (const ref of TRUCK_MODULE_REFS) {
    const id = entry[ref.field];
    const module = world.modules.get(id);
    if (!ref.matches(module)) {
      throw new WorldStateError(`${path}/${ref.field}`, `${ref.label} #${String(id)} vo svete nie je${module === undefined ? '' : ` (${module.label})`}`);
    }
  }
  const ramp = world.modules.get(entry.rampId);
  if (ramp instanceof LoadingRamp && entry.dock >= ramp.docks) {
    throw new WorldStateError(`${path}/dock`, `dock ${String(entry.dock)} je mimo 0…${String(ramp.docks - 1)} ${ramp.label}`);
  }
  const area = world.modules.get(entry.waitingAreaId);
  if (area instanceof WaitingArea && entry.bay !== null && entry.bay >= area.bays) {
    throw new WorldStateError(`${path}/bay`, `bay ${String(entry.bay)} je mimo 0…${String(area.bays - 1)} ${area.label}`);
  }
}

/**
 * Kamióny vzostupne podľa id: väzby na moduly (`checkTruckRefs`), inštancia `Truck` (def, stav, `resume` a `bay` podľa
 * stavu overil `parseWorldState`), potom `World.addTruck` (bay a dock voľné; kamión znovu drží bay — v `waiting`
 * obsadený — a dock podľa stavu). `TruckError` → `WorldStateError` s poľom záznamu.
 */
function restoreTrucks(world: World, entries: readonly ParsedTruckEntry[]): void {
  entries.forEach((entry, index) => {
    const path = truckPath(index);
    checkTruckRefs(world, entry, path);
    try {
      world.addTruck(
        new Truck({
          id: entry.id,
          def: world.defs.trucks.get(entry.defId),
          mission: entry.mission,
          state: entry.state,
          x: entry.x,
          y: entry.y,
          heading: entry.heading,
          rampId: entry.rampId,
          dock: entry.dock,
          gateId: entry.gateId,
          waitingAreaId: entry.waitingAreaId,
          bay: entry.bay,
          resume: entry.resume,
          route: entry.route,
          progress: entry.progress,
          waitTicks: entry.waitTicks,
          replanPending: entry.replan,
        }),
      );
    } catch (error) {
      if (error instanceof TruckError) throw new WorldStateError(`${path}/${TRUCK_ERROR_FIELD[error.code]}`, error.message);
      throw error;
    }
  });
}

/**
 * Náklad kamiónov (`in_truck`): najviac `capacityUnits` jednotiek, len kategórie z `cargoCategories` defu a počet podľa
 * stavu (`TRUCK_STATE_TRAITS.cargo` efektívneho stavu: pred nakládkou 0, počas nej ≤ kapacita, po nej = kapacita). Volá
 * sa po `checkHolders` (kamión existuje); chyba patrí jednotke (`/cargo/units/<j>/location/truckId`), chýbajúci náklad
 * plného kamióna kamiónu (`/trucks/<i>/state`).
 */
function checkTruckCargo(world: World, units: readonly CargoUnit[]): void {
  const loaded = new Map<EntityId, number>();
  units.forEach((unit, index) => {
    if (unit.location.kind !== 'in_truck') return;
    const truck = world.trucks.get(unit.location.truckId);
    if (truck === undefined) return;
    const path = `${unitPath(index)}/location/truckId`;
    const count = (loaded.get(truck.id) ?? 0) + 1;
    loaded.set(truck.id, count);
    const { cargo } = truck.bonds;
    const limit = cargo === 'empty' ? 0 : truck.def.capacityUnits;
    // Delivery kamión pred vykládkou (`loaded`, ADR-032) nesie 1 … kapacita jednotiek; prázdny overí cyklus nižšie.
    if (count > limit) throw new WorldStateError(path, `${truck.label} v stave '${truck.state}' unesie ${String(limit)} jednotiek, v save ich má viac`);
    const { category } = world.defs.cargoTypes.get(unit.typeId);
    if (!truck.def.cargoCategories.includes(category)) {
      throw new WorldStateError(path, `${truck.label} nevozí náklad kategórie '${category}' (jednotka #${String(unit.id)})`);
    }
  });
  let index = 0;
  for (const truck of world.trucks.values()) {
    const count = loaded.get(truck.id) ?? 0;
    if (truck.bonds.cargo === 'full' && count !== truck.def.capacityUnits) {
      throw new WorldStateError(`${truckPath(index)}/state`, `${truck.label} v stave '${truck.state}' má byť plný (${String(truck.def.capacityUnits)} jednotiek), vezie ${String(count)}`);
    }
    if (truck.bonds.cargo === 'loaded' && count === 0) {
      throw new WorldStateError(`${truckPath(index)}/state`, `${truck.label} (${truck.mission}) v stave '${truck.state}' má viezť export, je prázdny`);
    }
    index += 1;
  }
}

/**
 * Fronta každej brány = presne kamióny v `gate_queue*` tejto brány (ADR-024): id vo fronte je kamión vo fronte svojej
 * brány (`/modules/<i>/runtime/queue/<k>`), kamión vo fronte je vo fronte svojej brány (`/trucks/<i>/state`).
 */
function checkGateQueues(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const gate of world.landsideModules.gates) {
    gate.queuedTruckIds.forEach((truckId, k) => {
      const truck = world.trucks.get(truckId);
      if (truck === undefined || truck.gateId !== gate.id || !TRUCK_STATE_TRAITS[truck.state].queued) {
        throw new WorldStateError(
          `${modulePath(indexOf.get(gate.id) ?? -1)}/runtime/queue${pointerSegment(k)}`,
          `${gate.label}: kamión #${String(truckId)} vo fronte ${truck === undefined ? 'vo svete neexistuje' : `je v stave '${truck.state}' s bránou #${String(truck.gateId)}`}`,
        );
      }
    });
  }
  let index = 0;
  for (const truck of world.trucks.values()) {
    const gate = world.modules.get(truck.gateId);
    if (TRUCK_STATE_TRAITS[truck.state].queued && !(gate instanceof TruckGate && gate.isQueued(truck.id))) {
      throw new WorldStateError(`${truckPath(index)}/state`, `${truck.label} v stave '${truck.state}' nie je vo fronte brány #${String(truck.gateId)}`);
    }
    index += 1;
  }
}

/**
 * Pohyb kamiónov zodpovedá stavu (`truckMotionProblem`, ADR-019, ADR-024 — aj odpočet ≥ 1 práve v stavoch s čakaním)
 * a kamión vo fronte stojí na svojej strane brány (`truckQueueSideProblem`, dodatok ADR-024 — `/trucks/<i>/route`).
 * Odpočet nad hodnotu, akú stav nastaví podľa **aktuálnych** defov (`truckWaitLimit`, T06-07), sa zarovná na ňu
 * (T06-08b, ADR-031 dodatok): platný save spred zmeny balansu (kratší `repathIntervalTicks`, pobyt stojiska, nakládka)
 * sa načíta a kamión nečaká dlhšie, než stav dovolí. Hranica stavu s čakaním je ≥ 1 (`MIN_STAY_TICKS`, schéma), takže
 * zarovnanie invariant odpočtu neporuší; záporný či neceločíselný odpočet odmietne už parser (`/trucks/<i>/waitTicks`).
 */
function checkTruckMotion(world: World): void {
  let index = 0;
  for (const truck of world.trucks.values()) {
    const problem = truckMotionProblem(world, truck);
    if (problem !== undefined) throw new WorldStateError(`${truckPath(index)}/${problem.field}`, problem.problem);
    const side = truckQueueSideProblem(world, truck);
    if (side !== undefined) throw new WorldStateError(`${truckPath(index)}/route`, side);
    truck.waitTicks = Math.min(truck.waitTicks, truckWaitLimit(world, truck));
    index += 1;
  }
}

/**
 * Väzba kamióna na rampu (`truckRampProblem`, review T04-11): def vozí kategóriu rampy (`/trucks/<i>/defId`) a kamión
 * s dockom má na docku a v sebe spolu aspoň `capacityUnits` jednotiek (`/trucks/<i>/dock`). Po `checkTruckCargo`.
 */
function checkTruckRamps(world: World): void {
  let index = 0;
  for (const truck of world.trucks.values()) {
    const ramp = world.modules.get(truck.rampId);
    const problem = ramp instanceof LoadingRamp ? truckRampProblem(world, truck, ramp) : undefined;
    if (problem !== undefined) throw new WorldStateError(`${truckPath(index)}/${problem.field}`, problem.problem);
    index += 1;
  }
}

/**
 * Nároky kamiónov na náklad dockov (ADR-029): na každom docku súčet nárokov (`capacityUnits − in_truck` kamiónov
 * s `claimsCargo`) nepresahuje pripravené + vozidlami vezené jednotky (outbound joby s vozidlom, `DockSupply`). Chyba
 * patrí kamiónu, ktorého nárok (vzostupne podľa id) súčet prekročí (`/trucks/<i>/dock`). Po `restoreJobs`.
 */
function checkTruckClaims(world: World): void {
  const supply = new DockSupply();
  supply.refresh(world);
  const claimed = new Map<string, number>();
  let index = 0;
  for (const truck of world.trucks.values()) {
    const ramp = world.modules.get(truck.rampId);
    const owed = truck.def.capacityUnits - world.cargo.countAt('in_truck', truck.id);
    if (truck.bonds.claimsCargo && owed > 0 && ramp instanceof LoadingRamp) {
      const key = `${String(ramp.id)}:${String(truck.dock)}`;
      const total = (claimed.get(key) ?? 0) + owed;
      claimed.set(key, total);
      const supplied = supply.suppliedAt(ramp, truck.dock);
      if (total > supplied) {
        throw new WorldStateError(
          `${truckPath(index)}/dock`,
          `${truck.label}: nároky kamiónov na dock ${String(truck.dock)} ${ramp.label} (${String(total)}) prevyšujú pripravené a vezené jednotky (${String(supplied)})`,
        );
      }
    }
    index += 1;
  }
}

/** Hodina posledného `NoWaitingBay` rampy nesmie byť v budúcnosti (ADR-024). */
function checkRampHours(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.lastNoWaitingBayHour === null || ramp.lastNoWaitingBayHour <= world.clock.gameHour) continue;
    throw new WorldStateError(
      `${modulePath(indexOf.get(ramp.id) ?? -1)}/runtime/lastNoWaitingBayHour`,
      `hodina ${String(ramp.lastNoWaitingBayHour)} je po aktuálnej ${String(world.clock.gameHour)}`,
    );
  }
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
    const atExpected =
      place === 'vehicle' && job.vehicleId !== null ? isSameLocation(unit.location, { kind: 'in_vehicle', vehicleId: job.vehicleId }) : unitAtJobSource(world, job, unit);
    if (!atExpected) {
      throw new WorldStateError(unitPathInJob, `jednotka #${String(unitId)} jobu v stave '${job.state}' má byť na ${place === 'vehicle' ? 'vozidle jobu' : 'zdroji jobu'}`);
    }
  });
}

/**
 * Rezervácia miesta v cieli jobu (ADR-018, ADR-023): cieľ je modul s `cargoDropTarget()` druhu `to` a kategórie nákladu,
 * miesto sa rezervuje raz na jednotku jobu (`restoreReservation`: sklad `reserveSlot` — v rozsahu, voľný, nie dvakrát;
 * rampa `reserve(dock)` — v rozsahu, `staged + reserved ≤ stagingPerDock`). Chyby → `/jobs/<i>/to/<držiteľ | miesto>`.
 */
function restoreJobReservation(world: World, job: TransportJob, category: CargoCategory | undefined, path: string): void {
  const spec = holderSpecOf(job.to.kind);
  const holderPath = `${path}/to/${spec?.holderKey ?? 'kind'}`;
  const module = world.modules.get(holderIdOf(job.to) ?? job.toModuleId);
  const target = module?.cargoDropTarget();
  if (module === undefined || target?.kind !== job.to.kind) {
    throw new WorldStateError(holderPath, `#${String(job.toModuleId)} vo svete neprijíma náklad jobu do '${job.to.kind}'`);
  }
  if (target.category !== null && target.category !== category) {
    throw new WorldStateError(holderPath, `${module.label} (kategória '${target.category}') neprijme náklad kategórie '${String(category)}'`);
  }
  if (!target.reserves) return;
  try {
    for (let i = 0; i < job.unitIds.length; i++) target.restoreReservation(slotOf(job.to) ?? -1);
  } catch (error) {
    if (error instanceof ModuleError) throw new WorldStateError(`${path}/to/${spec?.slotKey ?? 'kind'}`, error.message);
    throw error;
  }
}

/**
 * Modul koncového bodu jobu, ku ktorému vozidlo jazdí: držiteľ lokácie, pri háku žeriava (`in_crane`) kotvisko žeriava
 * (ADR-033). Neexistujúci žeriav alebo držiteľ → `undefined` (chybu ohlási `World.addJob` / `restoreJobReservation`).
 */
function endpointModuleId(world: World, location: CargoLocation): EntityId | undefined {
  const holder = holderIdOf(location);
  if (location.kind !== 'in_crane' || holder === null) return holder ?? undefined;
  const crane = world.modules.get(holder);
  return crane instanceof CraneModule ? crane.berthId : undefined;
}

/**
 * Joby vzostupne podľa id (ADR-018, ADR-023): vozidlo = vozidlo s týmto `jobId`, stav odvodený (`deriveJobState`),
 * náklad na mieste podľa stavu, vozidlo vozí kategóriu nákladu, `World.addJob` a rezervácia miesta v cieli
 * (`restoreJobReservation`: slot skladu, staging dock rampy). Chyby → `/jobs/<i>…` (resp. `/vehicles/<v>/jobId`).
 */
function restoreJobs(world: World, entries: readonly ParsedJobEntry[]): void {
  const byJob = vehiclesByJob(world, entries);
  entries.forEach((entry, index) => {
    const path = jobPath(index);
    const vehicle = byJob.get(entry.id);
    let job: TransportJob;
    try {
      const fromModuleId = endpointModuleId(world, entry.from);
      const toModuleId = endpointModuleId(world, entry.to);
      if (fromModuleId === undefined) throw new WorldStateError(`${path}/from`, `žeriav #${String(holderIdOf(entry.from))} (hák jobu) vo svete nie je`);
      if (toModuleId === undefined) throw new WorldStateError(`${path}/to`, `žeriav #${String(holderIdOf(entry.to))} (hák jobu) vo svete nie je`);
      job = new TransportJob({ ...entry, fromModuleId, toModuleId, state: deriveJobState(world, entry, vehicle), vehicleId: vehicle?.id ?? null });
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
    restoreJobReservation(world, job, category, path);
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
 * Obnoví moduly, lode, vozidlá, kamióny, joby a stav odvodený z ledgera do čerstvého `world` (prázdne moduly, lode,
 * vozidlá, kamióny aj joby, ledger už obnovený z `parsed.cargo`). Chyby → `WorldStateError`: modul (hranice, obsadenie, žeriav na berthe,
 * `runtime`) → `/modules/<i>…`, loď (kotvisko, anchorage, index trasy) → `/ships/<k>…`, vozidlo (depo, státie, job) →
 * `/vehicles/<v>…`, kamión (moduly, bay, dock, fronta, pohyb) → `/trucks/<i>…`, job (jednotky, stav, sklad, slot) →
 * `/jobs/<i>…`, náklad u neexistujúceho držiteľa (aj `in_vehicle` bez vozidla, `in_truck` bez kamióna), nad kapacitou
 * vozidla či kamióna, vo vozidle bez jobu alebo na neplatnom/rezervovanom slote → `/cargo/units/<j>/location…`, iné
 * porušenie invariantov → `''`.
 */
/**
 * Väzba nákladu na kontrakty (ADR-026, ADR-032): jednotka s `contractId` patrí kontraktu v knihe, ktorý už jednotky smie
 * mať (`UNITS_FROM` podľa druhu: import od lode — `CONTRACT_STATE_TRAITS.ship`, export od prijatia — `plan`), má jeho
 * typ nákladu a štítky kontraktu (`direction` = druh, `voyageId` = voyage kontraktu, `destinationPort` = cieľ bookingu,
 * pri importe `null`) — chyba na `/cargo/units/<j>/<pole>`; jednotka bez kontraktu je import bez voyage. Jednotka na
 * lodi kontraktu, ktorý vlastní náklad na palube (`carriesShipCargo`), patrí tomuto kontraktu. Počet jednotiek v hold
 * bookingu = `booking.heldUnits` (`/contracts/<i>/booking/heldUnits`). Kontrakty jednej voyage sa zhodujú na triede
 * lode, príchode a lodi (`/contracts/<i>/voyageId`). Počet jednotiek na palube overí `findWorldViolation` (krok 12).
 */
const UNITS_FROM: { readonly [K in ContractKind]: (contract: Contract) => boolean } = Object.freeze({
  import: (contract: Contract) => CONTRACT_STATE_TRAITS[contract.state].ship === 'required',
  export: (contract: Contract) => CONTRACT_STATE_TRAITS[contract.state].plan === 'required',
});

function checkContracts(world: World, units: readonly CargoUnit[]): void {
  const shipContract = new Map<EntityId, ContractId>();
  const held = new Map<ContractId, number>();
  for (const contract of world.contractBook.openContracts.values()) {
    if (contract.shipId !== undefined && contract.carriesShipCargo) shipContract.set(contract.shipId, contract.id);
  }
  units.forEach((unit, index) => {
    const path = `/cargo/units${pointerSegment(index)}`;
    const owner = unit.location.kind === 'on_ship' ? shipContract.get(unit.location.shipId) : undefined;
    if (owner !== undefined && unit.contractId !== owner) throw new WorldStateError(`${path}/contractId`, `jednotka na lodi kontraktu #${String(owner)} má contractId ${String(unit.contractId)}`);
    if (unit.contractId === null) {
      if (unit.direction !== 'import') throw new WorldStateError(`${path}/direction`, 'jednotka bez kontraktu je import');
      if (unit.voyageId !== null) throw new WorldStateError(`${path}/voyageId`, 'jednotka bez kontraktu nemá voyage');
      return;
    }
    const contract = world.contracts.get(unit.contractId);
    if (contract === undefined) throw new WorldStateError(`${path}/contractId`, `kontrakt #${String(unit.contractId)} nie je v contracts`);
    if (!UNITS_FROM[contract.kind](contract)) throw new WorldStateError(`${path}/contractId`, `${contract.label} v stave ${contract.state} ešte nemá náklad`);
    if (contract.cargoTypeId !== unit.typeId) throw new WorldStateError(`${path}/contractId`, `${contract.label} vozí '${contract.cargoTypeId}', jednotka je '${unit.typeId}'`);
    if (unit.direction !== contract.kind) throw new WorldStateError(`${path}/direction`, `${contract.label} je '${contract.kind}', jednotka '${unit.direction}'`);
    if (unit.voyageId !== contract.voyageId) throw new WorldStateError(`${path}/voyageId`, `${contract.label} patrí voyage ${String(contract.voyageId)}, jednotka ${String(unit.voyageId)}`);
    const port = contract.booking?.destinationPort ?? null;
    if (unit.destinationPort !== port) throw new WorldStateError(`${path}/destinationPort`, `${contract.label} má cieľ ${String(port)}, jednotka ${String(unit.destinationPort)}`);
    if (unit.hold !== null) held.set(contract.id, (held.get(contract.id) ?? 0) + 1);
  });
  checkVoyages(world, held);
}

/** Kontrakty jednej voyage sa zhodujú na lodi (trieda, príchod, loď); `heldUnits` bookingu = jednotky v hold. */
function checkVoyages(world: World, held: ReadonlyMap<ContractId, number>): void {
  let index = 0;
  for (const contract of world.contracts.values()) {
    const path = `/contracts${pointerSegment(index)}`;
    const [first] = world.contractBook.voyageContracts(contract.voyageId);
    if (first !== undefined && first !== contract) {
      const same = first.shipClassId === contract.shipClassId && first.shipArrivalTick === contract.shipArrivalTick && first.shipId === contract.shipId;
      if (!same) throw new WorldStateError(`${path}/voyageId`, `${contract.label} nesúhlasí s ${first.label} tej istej voyage (trieda lode, príchod, loď)`);
    }
    const booking = contract.booking;
    if (booking !== null && booking.heldUnits !== (held.get(contract.id) ?? 0)) {
      throw new WorldStateError(`${path}/booking/heldUnits`, `${contract.label}: heldUnits ${String(booking.heldUnits)}, jednotiek v hold ${String(held.get(contract.id) ?? 0)}`);
    }
    index += 1;
  }
}

export function restoreEntities(world: World, parsed: Pick<ParsedWorldState, 'modules' | 'ships' | 'vehicles' | 'jobs' | 'trucks' | 'cargo'>): void {
  const entries = parsed.modules;
  const { units } = parsed.cargo;
  restoreModules(world, entries);
  restoreShips(world, parsed.ships);
  checkShipRoutes(world);
  restoreVehicles(world, parsed.vehicles);
  restoreTrucks(world, parsed.trucks);
  const indexOf = new Map<EntityId, number>(entries.map((entry, index) => [entry.id, index]));
  const unitIndexOf = new Map<EntityId, number>(units.map((unit, index) => [unit.id, index]));
  checkHolders(world, units);
  checkVehicleCargo(world, units);
  checkUnitSlots(world, units);
  checkRampUnits(world, units);
  checkTruckCargo(world, units);
  checkTruckRamps(world);
  checkGateQueues(world, indexOf);
  restoreJobs(world, parsed.jobs);
  checkTruckClaims(world);
  checkVehicleCargoJobs(world, units);
  checkVehicleMotion(world);
  checkTruckMotion(world);
  checkBerthHours(world, indexOf);
  checkRampHours(world, indexOf);
  restoreCraneReservations(world, indexOf, unitIndexOf);
  restoreHeldCargo(world, units);
  checkCraneHolding(world, indexOf);
  checkContracts(world, units);
  // Index uskladneného nákladu (ADR-027) sa neukladá: poradie sklad ↑, FIFO sa odvodí z obnoveného ledgera.
  world.storedCargo.rebuild(world.cargo, world.modules.keys());
  // Index zadržaných jednotiek (VGM hold, ADR-032) sa tiež neukladá: zostaví sa z jednotiek s `hold`.
  world.holdIndex.rebuild(units);
  const violation = findWorldViolation(world);
  if (violation !== undefined) throw new WorldStateError('', violation);
}
