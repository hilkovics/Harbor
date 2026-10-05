/**
 * Jazda vozidla k modulu jobu (ARCHITECTURE §7.3, §7.4; docs/tasks/phase-03.md rozhodnutia 1, 2 a 7; ADR-019, ADR-024):
 * plánovanie trasy k prístupovej bunke modulu, začiatok jazdy (dispatcher, `VehicleSystem`), prechod do `no_path`
 * a súlad pohybu so stavom (krok 12, obnova save). Samotné plánovanie, pohyb a kontrola pohybu sú zdieľané s kamiónmi
 * (`src/sim/movement`): tu je len väzba na job a FSM vozidla.
 *
 * - Cieľ trasy = **prístupová bunka** modulu (vonkajšia bunka cestného konektora s cestou, `accessCellIndex`) s
 *   najlacnejšou cestou (`Pathfinder.routeCost`: 1 / `speedFactor` za bunku, ADR-020; pri samých dvojpruhových cestách
 *   = počet krokov) z **kotvy** vozidla: `cell`, pri pohybe medzi bunkami `nextCell` — rozbehnutý úsek vozidlo
 *   dokončí; ak nová cesta z `nextCell` vedie hneď späť do `cell`, vozidlo sa otočí uprostred úseku (`turnAround`),
 *   aby sa v ticku reálne pohlo. Pri zhode cien vyhrá prvý konektor v poradí defu (`planRouteToModule`).
 * - Obrat uprostred úseku `cell → nextCell` nastane len vtedy, keď A* z `nextCell` smie ísť hneď do `cell` — teda keď je
 *   povolený krok `nextCell → cell` (`isRoadStepAllowed`). Na jednosmerke sa vozidlo proti smeru neotočí; cesta z
 *   `nextCell` potom vedie dopredu (obchádzkou), alebo nie je žiadna a vozidlo prejde do `no_path` uprostred úseku.
 * - Bez cesty vozidlo prejde do `no_path`, zahodí zvyšok trasy (`halt`) a skúsi znova o `logistics.repathIntervalTicks`.
 * - **Pod hákom** (F6d, ADR-033 dodatok T6D-02): ak je koncovým bodom jobu hák žeriava v kotvisku s jazdným nábrežím, cieľom jazdy nie je
 *   prístupová bunka kotviska, ale **bunka pod hákom** (`hookCellIndex`) — vozidlo vojde na nábrežie a zastane pod žeriavom (`planJobRoute`).
 */
import { BerthModule } from '../modules/berth-module';
import type { EntityId } from '../core/entity-id';
import type { Module } from '../modules/module';
import type { TransportJob } from '../logistics/transport-job';
import { carrierMotionProblem, type MotionProblem, type MotionTarget } from '../movement/motion-check';
import { planRouteToCell, planRouteToModule } from '../movement/route-planning';
import type { World } from '../world/world';
import { VehicleError } from './vehicle-error';
import { VEHICLE_STATE_TRAITS, changeVehicleState, type VehicleDestination } from './vehicle-fsm';
import type { Vehicle } from './vehicle';

/** Stav jazdy (`VEHICLE_STATE_TRAITS.motion === 'drive'`). */
export type TravelState = 'to_pickup' | 'to_dropoff';

/** Aktívny job vozidla; vozidlo bez neho → `VehicleError('inconsistent')`. */
export function jobOfVehicle(world: World, vehicle: Vehicle): TransportJob {
  const job = vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
  if (job === undefined) throw new VehicleError('inconsistent', `${vehicle.label} v stave '${vehicle.state}' nemá job #${String(vehicle.jobId)}`);
  return job;
}

/** Modul jobu podľa cieľa (`source` = zdroj `from`, `target` = cieľ `to`); chýbajúci → `VehicleError('inconsistent')`. */
export function jobModule(world: World, job: TransportJob, destination: VehicleDestination): Module {
  const moduleId = destination === 'source' ? job.fromModuleId : job.toModuleId;
  const module = world.modules.get(moduleId);
  if (module === undefined) throw new VehicleError('inconsistent', `${job.label}: modul #${String(moduleId)} (${destination}) vo svete nie je`);
  return module;
}

/** Bunka pod hákom žeriava `craneId`, ak jeho kotvisko má jazdné nábrežie (F6d); inak `undefined`. */
export function hookCellOfCrane(world: World, craneId: EntityId): number | undefined {
  return world.quay.hookCellOf(craneId); // odvodená cache v `QuayLanes` (T6D-05b), bez alokácie pri každom pláne trasy
}

/**
 * Bunka pod hákom žeriava, ak je ňou cieľ jazdy `destination` jobu (zdroj `in_crane` pri `source`, cieľ `in_crane` pri `target`) a kotvisko
 * má jazdné nábrežie; inak `undefined` (cieľom jazdy je prístupová bunka modulu jobu).
 */
export function hookCellOfJob(world: World, job: TransportJob, destination: VehicleDestination): number | undefined {
  const end = destination === 'source' ? job.from : job.to;
  return end.kind === 'in_crane' ? hookCellOfCrane(world, end.craneId) : undefined;
}

/**
 * Cieľ jazdy alebo miesta pobytu vozidla podľa jobu a smeru (`destination`): bunka pod hákom (index), inak modul jobu (jeho prístupová
 * bunka). Pre kontrolu pohybu (`vehicleMotionProblem`) a plánovanie (`planJobRoute`).
 */
export function jobTarget(world: World, job: TransportJob, destination: VehicleDestination): MotionTarget {
  return hookCellOfJob(world, job, destination) ?? jobModule(world, job, destination);
}

/**
 * Nakládka pod hákom, k ničomu pod hákom nevedie cesta (`no_path`, T6D-05b): vozidlo s jednotkou (job `moving`, cieľ `in_crane`) ju odloží na apron
 * kotviska — job sa presmeruje na voľný slot apronu (`TransportJob.rebindTarget`) a vozidlo ide na prístupovú bunku kotviska (ako v režime `apron`
 * a v F6c), odkiaľ žeriav jednotku zdvihne z apronu. Deterministické, bez `Rng` a bez nového stavu: cieľ jobu je v save, rezerváciu slotu drží job.
 * `false` = nič sa nezmenilo (apron nemá voľný slot, alebo ani k prístupovej bunke nevedie cesta) — vozidlo ostane / vráti sa do `no_path`
 * a o `logistics.repathIntervalTicks` to skúsi znova. Poradie: najprv sa overí slot a trasa, rezervácia a presmerovanie až po úspechu.
 */
function rerouteLoadViaApron(world: World, vehicle: Vehicle, job: TransportJob): boolean {
  if (job.state !== 'moving' || job.to.kind !== 'in_crane') return false;
  const berth = world.modules.get(job.toModuleId);
  if (!(berth instanceof BerthModule) || berth.apron.freeUnreservedCount <= 0) return false;
  if (!planRoute(world, vehicle, berth)) return false;
  job.rebindTarget({ kind: 'on_apron', berthId: berth.id, slot: berth.apron.reserve() });
  return true;
}

/**
 * Naplánuje trasu k cieľu jobu (`destination`): k bunke pod hákom (F6d), inak k najbližšej prístupovej bunke modulu jobu (`planRoute`).
 * Nakládka pod hákom, ku ktorej bunke pod hákom cesta nevedie, sa presmeruje na apron (`rerouteLoadViaApron`; vykládku rieši žeriav, `deliver`).
 * `false` = cieľ nie je dosiahnuteľný (vozidlo sa nezmení).
 */
export function planJobRoute(world: World, vehicle: Vehicle, job: TransportJob, destination: VehicleDestination): boolean {
  const hook = hookCellOfJob(world, job, destination);
  if (hook === undefined) return planRoute(world, vehicle, jobModule(world, job, destination));
  return planRouteToCell(world, vehicle, hook) || (destination === 'target' && rerouteLoadViaApron(world, vehicle, job));
}

/**
 * Naplánuje trasu z kotvy vozidla k najbližšej prístupovej bunke modulu (viď hlavička, `planRouteToModule`) a nastaví ju
 * vozidlu (`followRoute`, pri ceste späť cez `cell` `turnAround`). `false` = modul nemá prístupovú bunku, ku ktorej vedie
 * cesta (vozidlo sa nezmení). Alokuje len pri pohybe medzi bunkami bez obratu (trasa `[cell, …cesta]`); inak použije
 * zmrazenú cestu z cache.
 */
export function planRoute(world: World, vehicle: Vehicle, module: Module): boolean {
  return planRouteToModule(world, vehicle, module);
}

/** Vozidlo nemá cestu: `no_path`, zvyšok trasy zahodí, nový pokus o `repathIntervalTicks`. */
export function enterNoPath(world: World, vehicle: Vehicle): void {
  changeVehicleState(world.events, vehicle, 'no_path');
  vehicle.halt();
  vehicle.waitTicks = world.defs.logistics.repathIntervalTicks;
}

/**
 * Začne jazdu k modulu jobu: prechod do `travel` (`VehicleStateChanged`) a plán trasy; bez cesty hneď `no_path`. Pohyb
 * robí až `VehicleSystem` (krok 6) — pri priradení v kroku 5 ešte v tom istom ticku.
 */
export function startTrip(world: World, vehicle: Vehicle, travel: TravelState): void {
  const destination = VEHICLE_STATE_TRAITS[travel].destination;
  if (destination === null) throw new VehicleError('inconsistent', `${vehicle.label}: stav '${travel}' nemá cieľ`);
  const job = jobOfVehicle(world, vehicle);
  jobModule(world, job, destination); // modul jobu musí existovať (VehicleError('inconsistent') pri poškodenom svete)
  changeVehicleState(world.events, vehicle, travel);
  if (!planJobRoute(world, vehicle, job, destination)) enterNoPath(world, vehicle);
}

/** Problém pohybu vozidla s poľom záznamu v save, ku ktorému patrí (krok 12, obnova) — zdieľaný `MotionProblem`. */
export type VehicleMotionProblem = MotionProblem;

/** Cieľ, ku ktorému vozidlo v danom stave ide / pri ktorom stojí (bez vyhadzovania): bunka pod hákom, alebo modul jobu; inak `undefined`. */
function destinationOf(world: World, vehicle: Vehicle): MotionTarget | undefined {
  const destination = VEHICLE_STATE_TRAITS[vehicle.state].destination;
  const job = destination === null || vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
  if (job === undefined || destination === null) return undefined;
  return hookCellOfJob(world, job, destination) ?? world.modules.get(destination === 'source' ? job.fromModuleId : job.toModuleId);
}

/**
 * Súlad pohybu vozidla so stavom (ADR-019), alebo `undefined` — zdieľaná `carrierMotionProblem` s vlastnosťami stavu
 * `VEHICLE_STATE_TRAITS` a cieľom = modul jobu podľa stavu (`destination`; jazda končí a pobyt `loading`/`unloading`
 * prebieha na jeho prístupovej bunke). Job musí existovať (overí sa skôr, `checkVehicle` / `restoreJobs`).
 */
export function vehicleMotionProblem(world: World, vehicle: Vehicle): VehicleMotionProblem | undefined {
  return carrierMotionProblem(world, vehicle, vehicle.state, VEHICLE_STATE_TRAITS[vehicle.state], destinationOf(world, vehicle));
}
