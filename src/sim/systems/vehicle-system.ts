/**
 * VehicleSystem — krok 6b ticku (ARCHITECTURE §6, §7.3 bod 4, §7.8; docs/tasks/phase-03.md rozhodnutia 1, 2, 7 a 8;
 * ADR-011, ADR-019, ADR-038): FSM vozidiel bez pohybu — príchody, pobyt v module a load/unload. Pohyb po trase robí
 * `TrafficSystem` (krok 6a, ADR-037): preplánovanie a jazda vozidiel (`replanVehicle`, `advanceVehicle`) idú pod pruhovými slotmi.
 * Vozidlá sa spracúvajú vzostupne podľa id, krok podľa stavu je tabuľka `VEHICLE_STEPS` (nie switch) a stav mení len
 * `changeVehicleState`. Vozidlo, ktorému sa stav zmenil už v kroku 6a (`no_path`), v tomto ticku krok FSM nerobí (ADR-016).
 *
 * - `to_pickup` / `to_dropoff`: vozidlo, ktoré (po pohybe v kroku 6a) stojí na konci trasy — prístupovej bunke modulu jobu —
 *   prejde do `loading` / `unloading` s pobytom `internalTicks` modulu (inak `logistics.defaultInternalTicks`) +
 *   `loadTicks` / `unloadTicks` prvej jednotky. Pohyb: ak sa od plánu zmenila cestná sieť (`replanPending`), vozidlo preplánuje z kotvy
 *   (bunka, pri pohybe medzi bunkami cieľová bunka úseku); bez cesty `no_path`. Potom sa posunie o `speedCellsPerTick`
 *   × `speedFactor` typu cieľovej bunky každého úseku (zdieľaný `advanceCarrier`, `World.roadSpeeds`, ADR-020, ADR-024).
 * - `rehandling` (R2, TR2-06b): cieľ v bloku so stohmi nie je navrchu — vozidlo prekladá kontajnery nad ním (`logistics/yard-rehandle.ts`), potom späť `loading`,
 *   alebo bez cieľa presunu po `rehandleGiveUpTicks` job zruší a ide `idle`.
 * - `loading`: po odpočte presun jednotky zo zdroja do vozidla (`on_apron → in_vehicle` — slot apronu sa uvoľní sám,
 *   ADR-017; `in_storage → in_vehicle`) a `Module.recordTaken` zdroja (sklad `unitsOut`, ADR-023); ďalšia jednotka
 *   jobu `loadTicks`, inak job `moving` a jazda k cieľu (`startTrip`, bez pohybu v tomto ticku).
 * - `unloading`: po odpočte cez `cargoDropTarget()` cieľa `assertCommittable` → `in_vehicle → job.to` (slot skladu,
 *   dock rampy) → `commit` (prázdny kontajner v sklade: `EmptyStored` + kontrola v depe, F6c); posledná jednotka = job `done`, `removeJob`, `JobDone`, vozidlo `idle` (stojí na mieste).
 * - `idle` → `to_depot` → `parked` (po `idleParkDelayTicks`), `depot_exit` → `to_pickup` (voľný slot prístupovej bunky depa): ADR-037 bod 7.
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
import { isMachineEndpoint } from '../logistics/handling-chains';
import { hookCraneOf, isHookDropoff, isHookPickup } from '../logistics/job-source';
import { rehandleStep, startYardTake } from '../logistics/yard-rehandle';
import { settleYardDrop } from '../logistics/yard-settle';
import type { JobState, TransportJob } from '../logistics/transport-job';
import { CraneModule } from '../modules/crane-module';
import { advanceCarrier } from '../movement/route-planning';
import type { Vehicle } from '../vehicles/vehicle';
import { VehicleError } from '../vehicles/vehicle-error';
import { HOOK_WAIT_TICKS, RESUME_AFTER_NO_PATH, VEHICLE_STATE_TRAITS, changeVehicleState, type VehicleState } from '../vehicles/vehicle-fsm';
import { enterNoPath, jobModule, jobOfVehicle, planDepotRoute, planJobRoute, startDepotTrip, startTrip, startVacateTrip, tryLeaveDepot } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';

/** Čo sa stane pri príchode na koniec trasy (`to_*`): stav vozidla, stav jobu a trvanie manipulácie jednotky. */
interface ArrivalRule {
  readonly vehicle: 'loading' | 'unloading';
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
  if (rule === undefined || destination === null || destination === 'depot') throw new VehicleError('inconsistent', `${vehicle.label}: príchod v stave '${vehicle.state}'`);
  const job = jobOfVehicle(world, vehicle);
  const module = jobModule(world, job, destination);
  job.transition(rule.job);
  // Pod hákom, alebo na TP RTG bloku (ADR-040): vozidlo čaká na odovzdanie od žeriavu / stroja, nie na pobyt v module (odpočet pripnutý ako pod hákom).
  const handedOver = rule.underHook(job) || isMachineEndpoint(world, job, rule.vehicle);
  vehicle.waitTicks = handedOver ? HOOK_WAIT_TICKS : (module.vehicleInternalTicks() ?? world.defs.logistics.defaultInternalTicks) + rule.handlingTicks(vehicle.def);
  changeVehicleState(world.events, vehicle, rule.vehicle);
  vehicle.releaseTail();
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

/**
 * Preplánovanie vozidla v jazdnom stave po zmene ciest (volá `TrafficSystem` pred získaním slotov a pohybom, krok 6a,
 * ADR-038): nová trasa z kotvy k cieľu jobu, bez cesty `no_path`. `false` = vozidlo prešlo do `no_path`. Bez čakajúceho
 * preplánovania nič nerobí (`true`).
 */
export function replanVehicle(vehicle: Vehicle, world: World): boolean {
  if (!vehicle.replanPending) return true;
  const destination = VEHICLE_STATE_TRAITS[vehicle.state].destination;
  if (vehicle.state === 'to_vacate') return replanVacate(vehicle, world);
  if (destination === 'depot') return replanToDepot(vehicle, world);
  if (destination === null) throw new VehicleError('inconsistent', `${vehicle.label}: jazda v stave '${vehicle.state}' bez cieľa`);
  if (planJobRoute(world, vehicle, jobOfVehicle(world, vehicle), destination)) return true;
  enterNoPath(world, vehicle);
  return false;
}

/**
 * Preplánovanie cesty do depa (`to_depot`) po zmene ciest: bez cesty sa nič nestane, kým vozidlo stojí v strede bunky, prejde do `idle`
 * (a o `idleParkDelayTicks` to skúsi znova); uprostred úseku počká s nedokončeným preplánovaním (každý tick nový pokus).
 * `false` = vozidlo sa v tomto ticku nehýbe.
 */
function replanToDepot(vehicle: Vehicle, world: World): boolean {
  if (planDepotRoute(world, vehicle)) return true;
  if (vehicle.progress === 0) {
    vehicle.halt();
    vehicle.waitTicks = 0;
    changeVehicleState(world.events, vehicle, 'idle');
  }
  return false;
}

/**
 * Preplánovanie `to_vacate` po zmene ciest: cieľ nie je modul, takže po zmene ciest vozidlo zastane (v strede bunky hneď, uprostred úseku po jeho dokončení) a prejde do `idle`
 * (nový pokus o depo, prípadne o uvoľnenie vjazdu). `false` = vozidlo sa v tomto ticku nehýbe.
 */
function replanVacate(vehicle: Vehicle, world: World): boolean {
  if (vehicle.progress === 0) {
    vehicle.halt();
    vehicle.waitTicks = 0;
    changeVehicleState(world.events, vehicle, 'idle');
  }
  return false;
}

/**
 * Jeden tick jazdy vozidla po trase (volá `TrafficSystem`, krok 6a): sloty ďalších buniek stráži brána sveta (`advanceCarrier`,
 * ADR-037). Príchod na koniec trasy spracuje až FSM krok vozidla (`arriveWhenThere`).
 */
export function advanceVehicle(vehicle: Vehicle, world: World): void {
  advanceCarrier(world, vehicle, vehicle.def.speedCellsPerTick);
}

/** Jazdný stav (FSM krok bez pohybu): vozidlo, ktoré stojí na konci trasy, dorazilo k modulu jobu. */
function arriveWhenThere(vehicle: Vehicle, world: World): void {
  if (vehicle.cellsAhead === 0) arrive(vehicle, world);
}

/**
 * Koniec manipulácie v `loading`: jednotka zo zdroja do vozidla a zápis výdaja v module zdroja (`recordTaken` — sklad
 * `unitsOut`, apron nič); ďalšia jednotka alebo jazda k cieľu.
 */
function loadUnit(vehicle: Vehicle, world: World): void {
  const job = jobOfVehicle(world, vehicle);
  const source = jobModule(world, job, 'source');
  const unitId = firstUnitAt(world, job, job.from);
  if (unitId === undefined) {
    // Jednotku práve prekladá stroj bloku (rehandling RTG, ADR-040): vozidlo počká o tick.
    if (job.unitIds.some((id) => world.cargo.get(id)?.location.kind === 'in_handler')) {
      vehicle.waitTicks = HOOK_WAIT_TICKS;
      return;
    }
    throw new VehicleError('inconsistent', `${vehicle.label}: ${job.label} nemá jednotku na zdroji`);
  }
  // Blok so stohmi: kontajnery nad cieľom sa najprv preložia (`rehandling`, ADR-039 bod 6); bez cieľa presunu sa job zruší a vozidlo uvoľní (TR2-06b).
  if (startYardTake(world, vehicle, job, unitId) !== 'ready') return;
  world.cargo.move(unitId, { kind: 'in_vehicle', vehicleId: vehicle.id });
  // Výdaj skladu (`unitsOut`) sa zapisuje len pri zdvihu zo stohu; zdvih z kamióna (vyloženie na TP, ADR-041) sklad nevydáva.
  if (job.from.kind === 'in_storage') source.recordTaken(unitId);
  completeLoad(world, vehicle, job, vehicle.def.loadTicks);
}

/**
 * Po naložení jednej jednotky do vozidla (vlastný zdvih, alebo odovzdanie strojom RTG, ADR-040): ďalšia jednotka jobu na zdroji = vozidlo ostáva v `loading` s odpočtom
 * `nextWaitTicks`, inak job `moving` a jazda k cieľu (`startTrip`, bez pohybu v tomto ticku).
 */
export function completeLoad(world: World, vehicle: Vehicle, job: TransportJob, nextWaitTicks: number): void {
  if (firstUnitAt(world, job, job.from) !== undefined) {
    vehicle.waitTicks = nextWaitTicks;
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
  // Odovzdanie na kamión na TP (ADR-041 bod 4): jednotka z vozidla do `in_truck`, bez rezervácie miesta (kamión drží job, nie slot).
  if (job.to.kind === 'in_truck') {
    if (unitId === undefined) throw new VehicleError('inconsistent', `${vehicle.label}: ${job.label} nemá jednotku vo vozidle`);
    world.cargo.move(unitId, job.to);
    completeDrop(world, vehicle, job, vehicle.def.unloadTicks);
    return;
  }
  const target = jobModule(world, job, 'target').cargoDropTarget();
  // Blok so stohmi: rezervácia sa usadí na skutočnú vrstvu stohu (vozidlá prichádzajú v inom poradí než rezervácie).
  settleYardDrop(world, job);
  const place = slotOf(job.to);
  if (unitId === undefined || target === undefined || target.kind !== job.to.kind || place === null) {
    throw new VehicleError('inconsistent', `${vehicle.label}: ${job.label} nemá jednotku vo vozidle alebo cieľ s miestom '${job.to.kind}'`);
  }
  target.assertCommittable(place, unitId);
  world.cargo.move(unitId, job.to);
  target.commit(place, unitId);
  // Prázdny kontajner v sklade: `EmptyStored` a v depe kontrola (`damageChance`, ADR-034).
  if (job.to.kind === 'in_storage') onEmptyStored(world, unitId, jobModule(world, job, 'target'));
  completeDrop(world, vehicle, job, vehicle.def.unloadTicks);
}

/**
 * Po vyložení jednej jednotky z vozidla (vlastné uloženie, alebo odovzdanie strojom RTG, ADR-040): ďalšia jednotka vo vozidle = vozidlo ostáva v `unloading` s odpočtom
 * `nextWaitTicks`, inak job `done`, `JobDone` a vozidlo `idle` (stojí na mieste).
 */
export function completeDrop(world: World, vehicle: Vehicle, job: TransportJob, nextWaitTicks: number): void {
  const inVehicle: CargoLocation = { kind: 'in_vehicle', vehicleId: vehicle.id };
  if (firstUnitAt(world, job, inVehicle) !== undefined) {
    vehicle.waitTicks = nextWaitTicks;
    return;
  }
  job.transition('done');
  world.removeJob(job.id);
  vehicle.jobId = null;
  world.events.emit({ type: 'JobDone', jobId: job.id });
  vehicle.waitTicks = world.defs.logistics.traffic.idleParkDelayTicks;
  changeVehicleState(world.events, vehicle, 'idle');
}

/** Nový pokus o trasu z `no_path`; úspech = návrat do `to_*`, z ktorého vozidlo vypadlo. */
function retry(vehicle: Vehicle, world: World): void {
  const job = jobOfVehicle(world, vehicle);
  const travel = RESUME_AFTER_NO_PATH[job.state];
  const destination = travel === undefined ? null : VEHICLE_STATE_TRAITS[travel].destination;
  if (travel === undefined || destination === null || destination === 'depot') throw new VehicleError('inconsistent', `${vehicle.label}: no_path s ${job.label} v stave '${job.state}'`);
  if (planJobRoute(world, vehicle, job, destination)) {
    changeVehicleState(world.events, vehicle, travel);
  } else {
    vehicle.waitTicks = world.defs.logistics.repathIntervalTicks;
  }
}

/** Príchod `to_depot` na prístupovú bunku depa: vozidlo zaparkuje (mimo cesty, nedrží sloty). */
function parkWhenThere(vehicle: Vehicle, world: World): void {
  if (vehicle.cellsAhead === 0) changeVehicleState(world.events, vehicle, 'parked');
}

/** Príchod `to_vacate` na voľnú bunku mimo vjazdov (`startVacateTrip`, TR5-06b): `idle` s dlhším odstupom ďalšieho pokusu o depo. */
function vacateWhenThere(vehicle: Vehicle, world: World): void {
  if (vehicle.cellsAhead !== 0) return;
  vehicle.waitTicks = world.defs.logistics.traffic.strandedRetryTicks;
  changeVehicleState(world.events, vehicle, 'idle');
}

/**
 * `idle`: odpočet `idleParkDelayTicks` a odchod do depa (`to_depot`). Vozidlo bez odpočtu (vytvorené priamo v `idle`, načítané zo save)
 * ho začne v tomto kroku; bez cesty k depu odpočet beží znova.
 */
function idleStep(vehicle: Vehicle, world: World): void {
  const delay = world.defs.logistics.traffic.idleParkDelayTicks;
  if (vehicle.waitTicks === 0) vehicle.waitTicks = delay;
  vehicle.waitTicks -= 1;
  if (vehicle.waitTicks > 0) return;
  vehicle.waitTicks = 0;
  if (startDepotTrip(world, vehicle)) return;
  // Bez cesty k depu (cesty sa po stavbe upravili, TR5-06b): vozidlo nesmie ostať na vjazde modulu — odíde na najbližšiu voľnú bunku mimo vjazdov a skúša depo s dlhším odstupom.
  vehicle.waitTicks = world.defs.logistics.traffic.strandedRetryTicks;
  if (startVacateTrip(world, vehicle)) vehicle.waitTicks = 0;
}

/** `depot_exit`: vozidlo čaká na voľný slot prístupovej bunky depa a skúša výjazd každý tick (`tryLeaveDepot`). */
function leaveDepot(vehicle: Vehicle, world: World): void {
  tryLeaveDepot(world, vehicle);
}

type VehicleStep = (vehicle: Vehicle, world: World) => void;

const VEHICLE_STEPS: { readonly [S in VehicleState]: VehicleStep } = {
  idle: idleStep,
  to_depot: parkWhenThere,
  to_vacate: vacateWhenThere,
  parked: () => undefined,
  depot_exit: leaveDepot,
  to_pickup: arriveWhenThere,
  to_dropoff: arriveWhenThere,
  loading: (vehicle, world) => {
    const job = jobOfVehicle(world, vehicle);
    if (isHookPickup(job)) waitUnderHook(vehicle, world);
    else if (!isMachineEndpoint(world, job, 'loading') && countDown(vehicle)) loadUnit(vehicle, world);
  },
  rehandling: (vehicle, world) => {
    const job = jobOfVehicle(world, vehicle);
    const unitId = firstUnitAt(world, job, job.from);
    if (unitId === undefined) throw new VehicleError('inconsistent', `${vehicle.label}: ${job.label} nemá jednotku na zdroji počas rehandlingu`);
    rehandleStep(world, vehicle, job, unitId);
  },
  unloading: (vehicle, world) => {
    const job = jobOfVehicle(world, vehicle);
    if (isHookDropoff(job)) waitUnderHook(vehicle, world);
    else if (!isMachineEndpoint(world, job, 'unloading') && countDown(vehicle)) unloadUnit(vehicle, world);
  },
  no_path: (vehicle, world) => {
    if (countDown(vehicle)) retry(vehicle, world);
  },
};

export class VehicleSystem {
  /** Krok 6b: jeden krok FSM každého vozidla vzostupne podľa id (pohyb po cestách robí `TrafficSystem` v kroku 6a, ADR-038). */
  tick(world: World): void {
    for (const vehicle of world.vehicles.values()) {
      if (!world.traffic.changedState(vehicle.id)) VEHICLE_STEPS[vehicle.state](vehicle, world);
    }
  }
}
