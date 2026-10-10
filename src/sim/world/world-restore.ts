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
import type { Module } from '../modules/module';
import { ModuleError, ModuleStateError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import { anchoringProblem, mooringProblem, shipRouteProblem } from '../ships/ship-route';
import { PreGateBuffer } from '../modules/pre-gate-buffer';
import { TruckHolding } from '../modules/truck-holding';
import { YardBlock } from '../modules/yard-block';
import { TruckGate } from '../modules/truck-gate';
import { slotKeyOf } from '../traffic/lane-slots';
import { Truck } from '../trucks/truck';
import { TruckError, type TruckErrorCode } from '../trucks/truck-error';
import { truckMotionProblem } from '../trucks/truck-trip';
import { Vehicle } from '../vehicles/vehicle';
import { VehicleError, type VehicleErrorCode } from '../vehicles/vehicle-error';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';
import { vehicleMotionProblem } from '../vehicles/vehicle-trip';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import { WorldStateError, pointerSegment } from './state-check';
import type { World } from './world';
import { findWorldViolation, inGateQueue, queueGateIdOf, truckQueueSideProblem } from './world-invariants';
import { heldByMachine, restoreMachines } from './machines-state';
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
      const { route } = entry;
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
    const anchoring = anchoringProblem(ship, world);
    if (anchoring !== undefined) throw new WorldStateError(`${path}/${anchoring.field}`, anchoring.problem);
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
 * súlad uloženej trasy so stavom (`shipRouteProblem`: prázdna trasa stojacej lode, plavba
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
  slot_taken: 'body',
  unknown_vehicle: 'id',
  has_cargo: 'id',
  busy: 'state',
  invalid_transition: 'state',
  inconsistent: 'state',
};

/** Vstup `Vehicle` zo záznamu v save (`restoreVehicles`). */
function vehicleInit(world: World, entry: ParsedVehicleEntry): ConstructorParameters<typeof Vehicle>[0] {
  return {
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
    body: entry.body.map(slotKeyOf),
    ahead: entry.ahead.map(slotKeyOf),
    blockedTicks: entry.blockedTicks,
    rerouteCooldown: entry.rerouteCooldown,
  };
}

/**
 * Vozidlá vzostupne podľa id: inštancia `Vehicle` (def a stav overil `parseWorldState`), potom `World.addVehicle` (depo existuje a má voľné
 * státie; `VehicleError` → `WorldStateError` s poľom záznamu). Job vozidla overí `restoreJobs`.
 */
function restoreVehicles(world: World, entries: readonly ParsedVehicleEntry[]): void {
  entries.forEach((entry, index) => {
    const path = vehiclePath(index);
    try {
      world.addVehicle(new Vehicle(vehicleInit(world, entry)));
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
  unknown_module: 'blockId',
  tp_taken: 'tpCell',
  stall_taken: 'stall',
  slot_taken: 'body',
  unknown_truck: 'id',
  has_cargo: 'id',
  busy: 'state',
  invalid_transition: 'state',
  inconsistent: 'state',
};

/** Modul väzby kamióna je modul daného druhu vo svete (pole záznamu, ktoré naň odkazuje). */
interface TruckModuleRef {
  readonly field: 'blockId' | 'gateId' | 'gateOutId' | 'preGateId' | 'holdingId';
  readonly label: string;
  readonly matches: (module: Module | undefined) => boolean;
}

/** Väzby kamióna na moduly v poradí kontroly (tabuľka, nie switch). */
const TRUCK_MODULE_REFS: readonly TruckModuleRef[] = [
  { field: 'blockId', label: 'blok', matches: (module) => module instanceof YardBlock },
  { field: 'gateId', label: 'brána', matches: (module) => module instanceof TruckGate },
  { field: 'gateOutId', label: 'výstupný pruh', matches: (module) => module instanceof TruckGate },
  { field: 'preGateId', label: 'predbránová plocha', matches: (module) => module instanceof PreGateBuffer },
  { field: 'holdingId', label: 'odstavná plocha', matches: (module) => module instanceof TruckHolding },
];

/**
 * Väzby záznamu kamióna pred `World.addTruck` (T06-07): blok, brána, predbránová a odstavná plocha sú moduly toho druhu vo svete a státie je v rozsahu `stalls` plochy.
 * Chyba patrí poľu, ktoré odkazuje zle (`/trucks/<i>/<pole>`); obsadenosť TP a státia overí `World.addTruck`.
 */
function checkTruckRefs(world: World, entry: ParsedTruckEntry, path: string): void {
  for (const ref of TRUCK_MODULE_REFS) {
    const id = entry[ref.field];
    if (id === null) continue;
    const module = world.modules.get(id);
    if (!ref.matches(module)) {
      throw new WorldStateError(`${path}/${ref.field}`, `${ref.label} #${String(id)} vo svete nie je${module === undefined ? '' : ` (${module.label})`}`);
    }
  }
}

/**
 * Kamióny vzostupne podľa id: väzby na moduly (`checkTruckRefs`), inštancia `Truck` (def, stav, `resume`, token a fáza podľa
 * stavu overil `parseWorldState`), potom `World.addTruck` (TP a státie voľné). `TruckError` → `WorldStateError` s poľom záznamu.
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
          blockId: entry.blockId,
          jobId: entry.jobId,
          unitId: entry.unitId,
          tpCell: entry.tpCell,
          holdingId: entry.holdingId,
          stall: entry.stall,
          phase: entry.phase,
          gateInTick: entry.gateInTick,
          gateId: entry.gateId,
          gateOutId: entry.gateOutId,
          preGateId: entry.preGateId,
          row: entry.row,
          resume: entry.resume,
          route: entry.route,
          progress: entry.progress,
          waitTicks: entry.waitTicks,
          replanPending: entry.replan,
          body: entry.body.map(slotKeyOf),
          ahead: entry.ahead.map(slotKeyOf),
          blockedTicks: entry.blockedTicks,
          rerouteCooldown: entry.rerouteCooldown,
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
 * Fronta každej brány = presne kamióny v `gate_queue*` a `gate_pass*` tejto brány (ADR-024, ADR-037): id vo fronte je kamión vo fronte svojej
 * brány (`/modules/<i>/runtime/queue/<k>`), kamión vo fronte je vo fronte svojej brány (`/trucks/<i>/state`).
 */
function checkGateQueues(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const gate of world.landsideModules.gates) {
    gate.queuedTruckIds.forEach((truckId, k) => {
      const truck = world.trucks.get(truckId);
      if (truck === undefined || queueGateIdOf(truck) !== gate.id || !inGateQueue(truck)) {
        throw new WorldStateError(
          `${modulePath(indexOf.get(gate.id) ?? -1)}/runtime/queue${pointerSegment(k)}`,
          `${gate.label}: kamión #${String(truckId)} vo fronte ${truck === undefined ? 'vo svete neexistuje' : `je v stave '${truck.state}' s pruhom #${String(queueGateIdOf(truck))}`}`,
        );
      }
    });
  }
  let index = 0;
  for (const truck of world.trucks.values()) {
    const gateId = queueGateIdOf(truck);
    const gate = gateId === null ? undefined : world.modules.get(gateId);
    if (inGateQueue(truck) && !(gate instanceof TruckGate && gate.isQueued(truck.id))) {
      throw new WorldStateError(`${truckPath(index)}/state`, `${truck.label} v stave '${truck.state}' nie je vo fronte pruhu brány #${String(gateId)}`);
    }
    index += 1;
  }
  for (const buffer of world.landsideModules.preGates) {
    buffer.getRuntimeState().rows.forEach((row, r) =>
      row.forEach((truckId, k) => {
        const truck = world.trucks.get(truckId as EntityId);
        if (truck === undefined || truck.state !== 'pre_gate' || truck.preGateId !== buffer.id || truck.row !== r) {
          throw new WorldStateError(
            `${modulePath(indexOf.get(buffer.id) ?? -1)}/runtime/rows${pointerSegment(r)}${pointerSegment(k)}`,
            `${buffer.label}: kamión #${String(truckId)} v rade ${String(r)} ${truck === undefined ? 'vo svete neexistuje' : `je v stave '${truck.state}' (rad ${String(truck.row)}, plocha #${String(truck.preGateId)})`}`,
          );
        }
      }),
    );
  }
}

/**
 * Pohyb kamiónov zodpovedá stavu (`truckMotionProblem`, ADR-019, ADR-024 — aj odpočet ≥ 1 práve v stavoch s čakaním)
 * a kamión vo fronte stojí na svojej strane brány (`truckQueueSideProblem`, dodatok ADR-024 — `/trucks/<i>/route`).
 * Odpočet `no_path` nad aktuálny `repathIntervalTicks` sa zarovná (T06-08b, ADR-031 dodatok); záporný či neceločíselný odpočet odmietne už parser (`/trucks/<i>/waitTicks`).
 */
function checkTruckMotion(world: World): void {
  let index = 0;
  for (const truck of world.trucks.values()) {
    const problem = truckMotionProblem(world, truck);
    if (problem !== undefined) throw new WorldStateError(`${truckPath(index)}/${problem.field}`, problem.problem);
    const side = truckQueueSideProblem(world, truck);
    if (side !== undefined) throw new WorldStateError(`${truckPath(index)}/route`, side);
    // Odpočet `no_path` nad aktuálny `repathIntervalTicks` (balans sa od uloženia zmenil) sa zarovná — kamión nečaká dlhšie, než stav dovolí (T06-08b).
    if (truck.state === 'no_path') truck.waitTicks = Math.min(truck.waitTicks, world.defs.logistics.repathIntervalTicks);
    index += 1;
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
    if (!atExpected && !heldByMachine(world, unit)) {
      throw new WorldStateError(unitPathInJob, `jednotka #${String(unitId)} jobu v stave '${job.state}' má byť na ${place === 'vehicle' ? 'vozidle jobu' : 'zdroji jobu'}`);
    }
  });
}

/**
 * Rezervácia miesta v cieli jobu (ADR-018, ADR-023): cieľ je modul s `cargoDropTarget()` druhu `to` a kategórie nákladu,
 * miesto sa rezervuje raz na jednotku jobu (`restoreReservation`: sklad `reserveSlot` — v rozsahu, voľný, nie dvakrát); cieľ `in_truck` nič nerezervuje. Chyby → `/jobs/<i>/to/<držiteľ | miesto>`.
 */
function restoreJobReservation(world: World, job: TransportJob, category: CargoCategory | undefined, path: string): void {
  const spec = holderSpecOf(job.to.kind);
  const holderPath = `${path}/to/${spec?.holderKey ?? 'kind'}`;
  if (job.to.kind === 'in_truck') {
    // Cieľ jobu je kamión na TP (ADR-041): nič sa nerezervuje, kamión však musí vo svete byť (držiteľ lokácie `in_truck`).
    if (world.trucks.get(job.to.truckId) === undefined) throw new WorldStateError(holderPath, `kamión #${String(job.to.truckId)} vo svete nie je`);
    return;
  }
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
    for (const unitId of job.unitIds) target.restoreReservation(slotOf(job.to) ?? -1, unitId);
  } catch (error) {
    if (error instanceof ModuleError) throw new WorldStateError(`${path}/to/${spec?.slotKey ?? 'kind'}`, error.message);
    throw error;
  }
}

/**
 * Modul koncového bodu jobu, ku ktorému vozidlo jazdí: držiteľ lokácie, pri háku žeriava (`in_crane`) kotvisko žeriava
 * (ADR-033), pri kamióne na TP (`in_truck`) blok jeho zastávky. Neexistujúci žeriav alebo držiteľ → `undefined` (chybu ohlási `World.addJob` / `restoreJobReservation`).
 */
function endpointModuleId(world: World, location: CargoLocation): EntityId | undefined {
  const holder = holderIdOf(location);
  // Kamión na TP (`in_truck`, ADR-041): modul koncového bodu je blok jeho aktuálnej zastávky.
  if (location.kind === 'in_truck') return holder === null ? undefined : world.trucks.get(holder)?.blockId;
  if (location.kind !== 'in_crane' || holder === null) return holder ?? undefined;
  const crane = world.modules.get(holder);
  return crane instanceof CraneModule ? crane.berthId : undefined;
}

/**
 * Joby vzostupne podľa id (ADR-018, ADR-023): vozidlo = vozidlo s týmto `jobId`, stav odvodený (`deriveJobState`),
 * náklad na mieste podľa stavu, vozidlo vozí kategóriu nákladu, `World.addJob` a rezervácia miesta v cieli
 * (`restoreJobReservation`: slot skladu). Chyby → `/jobs/<i>…` (resp. `/vehicles/<v>/jobId`).
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
 * pri importe `null`) — chyba na `/cargo/units/<j>/<pole>`; jednotka bez kontraktu je import bez voyage alebo prázdny kontajner
 * linky (ADR-034); jednotka kontraktu má jeho linku. Import (aj prekládka na lodi A) na lodi kontraktu, ktorý vlastní náklad
 * na palube (`carriesShipCargo`), patrí tomuto kontraktu; naložený export (aj prekládka na lodi A alebo B) patrí bookingu tej istej lode. Počet jednotiek v hold
 * bookingu = `booking.heldUnits` (`/contracts/<i>/booking/heldUnits`). Kontrakty jednej voyage sa zhodujú na triede
 * lode, príchode a lodi (`/contracts/<i>/voyageId`). Počet jednotiek na palube overí `findWorldViolation` (krok 12).
 */
const UNITS_FROM: { readonly [K in ContractKind]: (contract: Contract) => boolean } = Object.freeze({
  import: (contract: Contract) => CONTRACT_STATE_TRAITS[contract.state].ship === 'required',
  export: (contract: Contract) => CONTRACT_STATE_TRAITS[contract.state].plan === 'required',
  // Repositioning nemá jednotky s kontraktom (prázdne nesú len linku); prekládka má jednotky od spawnu lode A (ako import).
  empty_repositioning: () => false,
  tranship: (contract: Contract) => CONTRACT_STATE_TRAITS[contract.state].ship === 'required',
});

function checkContracts(world: World, units: readonly CargoUnit[]): void {
  const shipContract = new Map<EntityId, ContractId>();
  const held = new Map<ContractId, number>();
  for (const contract of world.contractBook.openContracts.values()) {
    if (contract.shipId !== undefined && contract.carriesShipCargo) shipContract.set(contract.shipId, contract.id);
  }
  units.forEach((unit, index) => {
    const path = `/cargo/units${pointerSegment(index)}`;
    // Import na lodi patrí kontraktu, ktorý vlastní náklad na palube; naložený export (smer `export`) patrí bookingu tej istej lode.
    const arrivesByShip = unit.direction === 'import' || unit.direction === 'tranship';
    const owner = unit.location.kind === 'on_ship' && arrivesByShip ? shipContract.get(unit.location.shipId) : undefined;
    if (owner !== undefined && unit.contractId !== owner) throw new WorldStateError(`${path}/contractId`, `jednotka na lodi kontraktu #${String(owner)} má contractId ${String(unit.contractId)}`);
    if (unit.location.kind === 'on_ship' && (unit.direction === 'export' || unit.direction === 'tranship') && unit.contractId !== null) {
      const booking = world.contracts.get(unit.contractId);
      if (booking?.shipId !== unit.location.shipId && booking?.tranship?.outShipId !== unit.location.shipId) {
        throw new WorldStateError(`${path}/contractId`, `${unit.direction} na lodi #${String(unit.location.shipId)} patrí kontraktu #${String(unit.contractId)}, ktorý k tejto lodi nepatrí`);
      }
    }
    if (unit.contractId === null) {
      if (unit.direction !== 'import' && unit.direction !== 'empty') throw new WorldStateError(`${path}/direction`, 'jednotka bez kontraktu je import alebo prázdny kontajner');
      if (unit.voyageId !== null) throw new WorldStateError(`${path}/voyageId`, 'jednotka bez kontraktu nemá voyage');
      return;
    }
    const contract = world.contracts.get(unit.contractId);
    if (contract === undefined) throw new WorldStateError(`${path}/contractId`, `kontrakt #${String(unit.contractId)} nie je v contracts`);
    if (!UNITS_FROM[contract.kind](contract)) throw new WorldStateError(`${path}/contractId`, `${contract.label} v stave ${contract.state} ešte nemá náklad`);
    if (contract.cargoTypeId !== unit.typeId) throw new WorldStateError(`${path}/contractId`, `${contract.label} vozí '${contract.cargoTypeId}', jednotka je '${unit.typeId}'`);
    if (unit.direction !== contract.kind) throw new WorldStateError(`${path}/direction`, `${contract.label} je '${contract.kind}', jednotka '${unit.direction}'`);
    if (unit.voyageId !== contract.voyageId) throw new WorldStateError(`${path}/voyageId`, `${contract.label} patrí voyage ${String(contract.voyageId)}, jednotka ${String(unit.voyageId)}`);
    if (unit.lineId !== contract.lineId) throw new WorldStateError(`${path}/lineId`, `${contract.label} patrí linke ${contract.lineId}, jednotka ${String(unit.lineId)}`);
    const port = contract.booking?.destinationPort ?? null;
    if (unit.destinationPort !== port) throw new WorldStateError(`${path}/destinationPort`, `${contract.label} má cieľ ${String(port)}, jednotka ${String(unit.destinationPort)}`);
    if (unit.hold !== null) held.set(contract.id, (held.get(contract.id) ?? 0) + 1);
  });
  checkVoyages(world, held);
}

/**
 * Plán výdajov prázdnych (`emptyFlow.pickupPlan`, T6C-07b, m5): výdaj plánuje `AcceptContract` export bookingu, takže každá položka ukazuje na kontrakt
 * druhu `export` v knihe a nesie linku jeho bookingu. Zlý odkaz by spawnol kamión po prázdny pre cudziu linku alebo pre kontrakt iného druhu (booking
 * `bookingOpen` len zahodí výdaj zaniknutého kontraktu — kontrakt mimo knihy, ktorý nikdy neexistoval, je poškodený save). Fail-fast s pointerom.
 */
function checkPickupPlan(world: World): void {
  const { pickupPlan } = world.emptyFlow;
  for (let i = 0; i < pickupPlan.length; i++) {
    const entry = pickupPlan[i];
    const path = `/emptyFlow/pickupPlan${pointerSegment(i)}`;
    const contract = world.contracts.get(entry.contractId as ContractId);
    if (contract === undefined) throw new WorldStateError(`${path}/contractId`, `výdaj prázdneho ukazuje na kontrakt #${String(entry.contractId)}, ktorý nie je v knihe`);
    if (contract.kind !== 'export') throw new WorldStateError(`${path}/contractId`, `výdaj prázdneho ukazuje na ${contract.label} druhu '${contract.kind}', očakáva sa export`);
    if (contract.lineId !== entry.lineId) throw new WorldStateError(`${path}/lineId`, `výdaj prázdneho linky ${entry.lineId} ukazuje na ${contract.label} linky ${contract.lineId}`);
  }
}

/** Kontrakty jednej voyage sa zhodujú na lodi (trieda, príchod, loď); `heldUnits` bookingu = jednotky v hold. */
function checkVoyages(world: World, held: ReadonlyMap<ContractId, number>): void {
  let index = 0;
  for (const contract of world.contracts.values()) {
    const path = `/contracts${pointerSegment(index)}`;
    // Prekládka zachránená na túto voyage (ADR-034) je v jej indexe, ale voyage jej nepatrí — porovnávajú sa len kontrakty s vlastnou voyage.
    const first = world.contractBook.voyageContracts(contract.voyageId).find((mate) => mate.voyageId === contract.voyageId);
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

export function restoreEntities(world: World, parsed: Pick<ParsedWorldState, 'modules' | 'ships' | 'vehicles' | 'jobs' | 'trucks' | 'machines' | 'cargo'>): void {
  const entries = parsed.modules;
  const { units } = parsed.cargo;
  restoreModules(world, entries);
  restoreShips(world, parsed.ships);
  checkShipRoutes(world);
  restoreVehicles(world, parsed.vehicles);
  restoreTrucks(world, parsed.trucks);
  restoreMachines(world, parsed.machines, world.defs);
  const indexOf = new Map<EntityId, number>(entries.map((entry, index) => [entry.id, index]));
  const unitIndexOf = new Map<EntityId, number>(units.map((unit, index) => [unit.id, index]));
  checkHolders(world, units);
  checkVehicleCargo(world, units);
  checkUnitSlots(world, units);
  checkTruckCargo(world, units);
  checkGateQueues(world, indexOf);
  restoreJobs(world, parsed.jobs);
  checkVehicleCargoJobs(world, units);
  checkVehicleMotion(world);
  checkTruckMotion(world);
  checkBerthHours(world, indexOf);
  restoreCraneReservations(world, indexOf, unitIndexOf);
  restoreHeldCargo(world, units);
  checkCraneHolding(world, indexOf);
  checkContracts(world, units);
  checkPickupPlan(world);
  // Index uskladneného nákladu (ADR-027) sa neukladá: poradie sklad ↑, FIFO sa odvodí z obnoveného ledgera.
  world.storedCargo.rebuild(world.cargo, world.modules.keys());
  // Index zadržaných jednotiek (VGM hold, ADR-032) sa tiež neukladá: zostaví sa z jednotiek s `hold`.
  world.holdIndex.rebuild(units);
  // Index sledovaných reeferov (ADR-042) sa neukladá: zostaví sa z jednotiek so stavom `reefer`.
  world.reeferIndex.rebuild(units);
  const violation = findWorldViolation(world);
  if (violation !== undefined) throw new WorldStateError('', violation);
}
