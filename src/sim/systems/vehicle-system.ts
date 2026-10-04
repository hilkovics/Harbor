/**
 * VehicleSystem — krok 6 ticku (ARCHITECTURE §6, §7.3 bod 4, §7.8; docs/tasks/phase-03.md rozhodnutia 1, 2, 7 a 8;
 * ADR-011, ADR-019): FSM vozidiel, pohyb po trase, pobyt v module a load/unload. Vozidlá sa spracúvajú vzostupne podľa
 * id, krok podľa stavu je tabuľka `VEHICLE_STEPS` (nie switch) a stav mení len `changeVehicleState`.
 *
 * - `to_pickup` / `to_dropoff`: ak sa od plánu zmenila cestná sieť (`replanPending`), vozidlo preplánuje z kotvy
 *   (bunka, pri pohybe medzi bunkami cieľová bunka úseku); bez cesty `no_path`. Potom sa posunie o `speedCellsPerTick`
 *   × `speedFactor` typu cieľovej bunky každého úseku (zdieľaný `advanceCarrier`, `World.roadSpeeds`, ADR-020, ADR-024) a na konci trasy —
 *   prístupovej bunke modulu jobu — prejde do `loading` / `unloading` s pobytom
 *   `internalTicks` modulu (inak `logistics.defaultInternalTicks`) + `loadTicks` / `unloadTicks` prvej jednotky.
 * - `loading`: po odpočte presun jednotky zo zdroja do vozidla (`on_apron → in_vehicle` — slot apronu sa uvoľní sám,
 *   ADR-017; `in_storage → in_vehicle`) a `Module.recordTaken` zdroja (sklad `unitsOut`, ADR-023); ďalšia jednotka
 *   jobu `loadTicks`, inak job `moving` a jazda k cieľu (`startTrip`, bez pohybu v tomto ticku).
 * - `unloading`: po odpočte cez `cargoDropTarget()` cieľa `assertCommittable` → `in_vehicle → job.to` (slot skladu,
 *   dock rampy) → `commit` (prázdny kontajner v sklade: `EmptyStored` + kontrola v depe, F6c); posledná jednotka = job `done`, `removeJob`, `JobDone`, vozidlo `idle` (stojí na mieste).
 * - `no_path`: po odpočte nový pokus o trasu k modulu jobu (`RESUME_AFTER_NO_PATH`); úspech = návrat do pôvodného `to_*`
 *   (bez pohybu v tomto ticku), inak ďalší odpočet `repathIntervalTicks`.
 * **Pod hákom** (F6a, ADR-033): vozidlo, ktorého job má koncový bod `in_crane` (hák žeriava), čaká po príchode v `loading`
 * (vykládka — jednotku mu odovzdá žeriav) alebo `unloading` (nakládka — žeriav ju zdvihne) s `waitTicks` pripnutým na
 * `HOOK_WAIT_TICKS`; tick čakania sa pripočíta žeriavu (`vehicleWaitTicks`), samotné odovzdanie robí `CraneSystem` (krok 4).
 * Tick vstupu do stavu s odpočtom je jeho nultý tick a stav končí v ticku, keď `waitTicks` klesne na 0 (ako fázy
 * žeriavu, ADR-016) — pobyt v module trvá presne `internalTicks + k × loadTicks` tickov (ADR-011).
 */
import { isSameLocation, slotOf, type CargoLocation } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import type { VehicleDef } from '../defs/types';
import { onEmptyStored } from '../logistics/empty-depot-service';
import { hookCraneOf, isHookDropoff, isHookPickup } from '../logistics/job-source';
import type { JobState, TransportJob } from '../logistics/transport-job';
import { CraneModule } from '../modules/crane-module';
import { advanceCarrier } from '../movement/route-planning';
import type { Vehicle } from '../vehicles/vehicle';
import { VehicleError } from '../vehicles/vehicle-error';
import { HOOK_WAIT_TICKS, RESUME_AFTER_NO_PATH, VEHICLE_STATE_TRAITS, changeVehicleState, type VehicleState } from '../vehicles/vehicle-fsm';
import { enterNoPath, jobModule, jobOfVehicle, planRoute, startTrip } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';

/** Čo sa stane pri príchode na koniec trasy (`to_*`): stav vozidla, stav jobu a trvanie manipulácie jednotky. */
interface ArrivalRule {
  readonly vehicle: VehicleState;
  readonly job: JobState;
  readonly handlingTicks: (def: Readonly<VehicleDef>) => number;
  /** Koniec trasy je hák žeriava (ADR-033): vozidlo čaká pod hákom na odovzdanie, nie na pobyt v module. */
  readonly underHook: (job: TransportJob) => boolean;
}

const ARRIVALS: Readonly<Partial<Record<VehicleState, ArrivalRule>>> = Object.freeze({
  to_pickup: Object.freeze({ vehicle: 'loading', job: 'picking', handlingTicks: (def: Readonly<VehicleDef>) => def.loadTicks, underHook: isHookPickup }),
  to_dropoff: Object.freeze({ vehicle: 'unloading', job: 'dropping', handlingTicks: (def: Readonly<VehicleDef>) => def.unloadTicks, underHook: isHookDropoff }),
});

/** Jeden tick odpočtu; `true`, keď práve skončil. */
function countDown(vehicle: Vehicle): boolean {
  vehicle.waitTicks = Math.max(0, vehicle.waitTicks - 1);
  return vehicle.waitTicks === 0;
}

/** Prvá jednotka jobu na mieste `location` (zdroj alebo vozidlo); `undefined`, ak tam žiadna nie je. */
function firstUnitAt(world: World, job: TransportJob, location: CargoLocation): EntityId | undefined {
  for (const unitId of job.unitIds) {
    const unit = world.cargo.get(unitId);
    if (unit !== undefined && isSameLocation(unit.location, location)) return unitId;
  }
  return undefined;
}

/** Koniec trasy: pobyt v module jobu (`internalTicks` + manipulácia prvej jednotky). */
function arrive(vehicle: Vehicle, world: World): void {
  const rule = ARRIVALS[vehicle.state];
  const destination = VEHICLE_STATE_TRAITS[vehicle.state].destination;
  if (rule === undefined || destination === null) throw new VehicleError('inconsistent', `${vehicle.label}: príchod v stave '${vehicle.state}'`);
  const job = jobOfVehicle(world, vehicle);
  const module = jobModule(world, job, destination);
  job.transition(rule.job);
  vehicle.waitTicks = rule.underHook(job) ? HOOK_WAIT_TICKS : (module.vehicleInternalTicks() ?? world.defs.logistics.defaultInternalTicks) + rule.handlingTicks(vehicle.def);
  changeVehicleState(world.events, vehicle, rule.vehicle);
}

/**
 * Tick čakania pod hákom (ADR-033): odpočet sa nemení (`HOOK_WAIT_TICKS`), vozidlo sa pripočíta do metriky `vehicleWaitTicks`
 * žeriava háku. Odovzdanie robí žeriav v kroku 4 (`CraneSystem`), preto tu nie je žiadny presun nákladu.
 */
function waitUnderHook(vehicle: Vehicle, world: World): void {
  const job = jobOfVehicle(world, vehicle);
  const craneId = hookCraneOf(job);
  const crane = craneId === undefined ? undefined : world.modules.get(craneId);
  if (!(crane instanceof CraneModule)) throw new VehicleError('inconsistent', `${vehicle.label}: čaká pod hákom, ale ${job.label} nemá žeriav`);
  crane.vehicleWaitTicks += 1;
}

/** Jazda: preplánovanie po zmene ciest, pohyb, príchod. */
function drive(vehicle: Vehicle, world: World): void {
  if (vehicle.replanPending) {
    const destination = VEHICLE_STATE_TRAITS[vehicle.state].destination;
    if (destination === null) throw new VehicleError('inconsistent', `${vehicle.label}: jazda v stave '${vehicle.state}' bez cieľa`);
    if (!planRoute(world, vehicle, jobModule(world, jobOfVehicle(world, vehicle), destination))) {
      enterNoPath(world, vehicle);
      return;
    }
  }
  if (advanceCarrier(world, vehicle, vehicle.def.speedCellsPerTick)) arrive(vehicle, world);
}

/**
 * Koniec manipulácie v `loading`: jednotka zo zdroja do vozidla a zápis výdaja v module zdroja (`recordTaken` — sklad
 * `unitsOut`, apron nič); ďalšia jednotka alebo jazda k cieľu.
 */
function loadUnit(vehicle: Vehicle, world: World): void {
  const job = jobOfVehicle(world, vehicle);
  const source = jobModule(world, job, 'source');
  const unitId = firstUnitAt(world, job, job.from);
  if (unitId === undefined) throw new VehicleError('inconsistent', `${vehicle.label}: ${job.label} nemá jednotku na zdroji`);
  world.cargo.move(unitId, { kind: 'in_vehicle', vehicleId: vehicle.id });
  source.recordTaken(unitId);
  if (firstUnitAt(world, job, job.from) !== undefined) {
    vehicle.waitTicks = vehicle.def.loadTicks;
    return;
  }
  job.transition('moving');
  startTrip(world, vehicle, 'to_dropoff');
}

/**
 * Koniec manipulácie v `unloading`: jednotka z vozidla na rezervované miesto cieľa (`cargoDropTarget()`: slot skladu,
 * dock rampy — ADR-023); posledná jednotka dokončí job.
 */
function unloadUnit(vehicle: Vehicle, world: World): void {
  const job = jobOfVehicle(world, vehicle);
  const inVehicle: CargoLocation = { kind: 'in_vehicle', vehicleId: vehicle.id };
  const unitId = firstUnitAt(world, job, inVehicle);
  const target = jobModule(world, job, 'target').cargoDropTarget();
  const place = slotOf(job.to);
  if (unitId === undefined || target === undefined || target.kind !== job.to.kind || place === null) {
    throw new VehicleError('inconsistent', `${vehicle.label}: ${job.label} nemá jednotku vo vozidle alebo cieľ s miestom '${job.to.kind}'`);
  }
  target.assertCommittable(place, unitId);
  world.cargo.move(unitId, job.to);
  target.commit(place, unitId);
  // Prázdny kontajner v sklade: `EmptyStored` a v depe kontrola (`damageChance`, ADR-034).
  if (job.to.kind === 'in_storage') onEmptyStored(world, unitId, jobModule(world, job, 'target'));
  if (firstUnitAt(world, job, inVehicle) !== undefined) {
    vehicle.waitTicks = vehicle.def.unloadTicks;
    return;
  }
  job.transition('done');
  world.removeJob(job.id);
  vehicle.jobId = null;
  world.events.emit({ type: 'JobDone', jobId: job.id });
  changeVehicleState(world.events, vehicle, 'idle');
}

/** Nový pokus o trasu z `no_path`; úspech = návrat do `to_*`, z ktorého vozidlo vypadlo. */
function retry(vehicle: Vehicle, world: World): void {
  const job = jobOfVehicle(world, vehicle);
  const travel = RESUME_AFTER_NO_PATH[job.state];
  const destination = travel === undefined ? null : VEHICLE_STATE_TRAITS[travel].destination;
  if (travel === undefined || destination === null) throw new VehicleError('inconsistent', `${vehicle.label}: no_path s ${job.label} v stave '${job.state}'`);
  if (planRoute(world, vehicle, jobModule(world, job, destination))) {
    changeVehicleState(world.events, vehicle, travel);
  } else {
    vehicle.waitTicks = world.defs.logistics.repathIntervalTicks;
  }
}

type VehicleStep = (vehicle: Vehicle, world: World) => void;

const VEHICLE_STEPS: { readonly [S in VehicleState]: VehicleStep } = {
  idle: () => undefined,
  to_pickup: drive,
  to_dropoff: drive,
  loading: (vehicle, world) => {
    if (isHookPickup(jobOfVehicle(world, vehicle))) waitUnderHook(vehicle, world);
    else if (countDown(vehicle)) loadUnit(vehicle, world);
  },
  unloading: (vehicle, world) => {
    if (isHookDropoff(jobOfVehicle(world, vehicle))) waitUnderHook(vehicle, world);
    else if (countDown(vehicle)) unloadUnit(vehicle, world);
  },
  no_path: (vehicle, world) => {
    if (countDown(vehicle)) retry(vehicle, world);
  },
};

export class VehicleSystem {
  /** Krok 6: jeden krok FSM každého vozidla vzostupne podľa id. */
  tick(world: World): void {
    for (const vehicle of world.vehicles.values()) VEHICLE_STEPS[vehicle.state](vehicle, world);
  }
}
