/**
 * Jazda vozidla k modulu jobu (ARCHITECTURE §7.3, §7.4; docs/tasks/phase-03.md rozhodnutia 1, 2 a 7; ADR-019):
 * plánovanie trasy k prístupovej bunke modulu, začiatok jazdy (dispatcher, `VehicleSystem`), prechod do `no_path`
 * a súlad pohybu so stavom (krok 12, obnova save).
 *
 * - Cieľ trasy = **prístupová bunka** modulu (vonkajšia bunka cestného konektora s cestou, `accessCellIndex`) s
 *   najlacnejšou cestou (`Pathfinder.routeCost`: 1 / `speedFactor` za bunku, ADR-020; pri samých dvojpruhových cestách
 *   = počet krokov) z **kotvy** vozidla: `cell`, pri pohybe medzi bunkami `nextCell` — rozbehnutý úsek vozidlo
 *   dokončí; ak nová cesta z `nextCell` vedie hneď späť do `cell`, vozidlo sa otočí uprostred úseku (`turnAround`),
 *   aby sa v ticku reálne pohlo. Pri zhode cien vyhrá prvý konektor v poradí defu. Cesty dáva `PathCache`
 *   (deterministický A* po smerových hranách, ADR-018, ADR-020).
 * - Obrat uprostred úseku `cell → nextCell` nastane len vtedy, keď A* z `nextCell` smie ísť hneď do `cell` — teda keď je
 *   povolený krok `nextCell → cell` (`isRoadStepAllowed`). Na jednosmerke sa vozidlo proti smeru neotočí; cesta z
 *   `nextCell` potom vedie dopredu (obchádzkou), alebo nie je žiadna a vozidlo prejde do `no_path` uprostred úseku.
 * - Bez cesty vozidlo prejde do `no_path`, zahodí zvyšok trasy (`halt`) a skúsi znova o `logistics.repathIntervalTicks`.
 */
import { directionOfStep } from '../grid/grid';
import { isRoadStepAllowed } from '../grid/road-direction';
import type { Rotation } from '../grid/rotation';
import type { Module } from '../modules/module';
import { NO_ACCESS, accessCellIndex, isAccessCell } from '../logistics/module-access';
import type { TransportJob } from '../logistics/transport-job';
import { cardinalHeading } from '../ships/ship-route';
import type { World } from '../world/world';
import { VehicleError } from './vehicle-error';
import { VEHICLE_STATE_TRAITS, changeVehicleState, type VehicleDestination } from './vehicle-fsm';
import { isValidProgress, vehiclePosition, type SerializedVehicle, type Vehicle } from './vehicle';

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

/**
 * Naplánuje trasu z kotvy vozidla k najbližšej prístupovej bunke modulu (viď hlavička) a nastaví ju vozidlu
 * (`followRoute`, pri ceste späť cez `cell` `turnAround`). `false` = modul nemá prístupovú bunku, ku ktorej vedie cesta
 * (vozidlo sa nezmení). Alokuje len pri pohybe medzi bunkami bez obratu (trasa `[cell, …cesta]`); inak použije zmrazenú
 * cestu z cache.
 */
export function planRoute(world: World, vehicle: Vehicle, module: Module): boolean {
  const between = vehicle.progress > 0;
  const anchor = between ? vehicle.nextCell : vehicle.cell;
  if (anchor === undefined) return false;
  let best: readonly number[] | null = null;
  let bestCost = Infinity;
  for (const connector of module.connectors) {
    const access = accessCellIndex(world.grid, connector);
    if (access === NO_ACCESS) continue;
    const path = world.paths.get(anchor, access);
    if (path === null) continue;
    const cost = world.pathfinder.routeCost(path);
    if (cost < bestCost) {
      best = path;
      bestCost = cost;
    }
  }
  if (best === null) return false;
  if (between && best[1] === vehicle.cell) vehicle.turnAround(best, world.grid.width);
  else vehicle.followRoute(between ? Object.freeze([vehicle.cell, ...best]) : best);
  return true;
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
  const module = jobModule(world, jobOfVehicle(world, vehicle), destination);
  changeVehicleState(world.events, vehicle, travel);
  if (!planRoute(world, vehicle, module)) enterNoPath(world, vehicle);
}

/** Problém pohybu vozidla s poľom záznamu v save, ku ktorému patrí (krok 12, obnova). */
export interface VehicleMotionProblem {
  readonly field: keyof SerializedVehicle;
  readonly problem: string;
}

/** Úsek trasy vedie po susedných bunkách mriežky (4-susednosť) v jej rozsahu. */
function routeProblem(world: World, route: readonly number[]): string | undefined {
  const { width, cellCount } = world.grid;
  for (let i = 0; i < route.length; i++) {
    const cell = route[i];
    if (cell >= cellCount) return `bunka ${String(cell)} je mimo mapy`;
    if (i === 0) continue;
    const previous = route[i - 1];
    const dx = Math.abs((cell % width) - (previous % width));
    const dy = Math.abs((cell - (cell % width)) / width - (previous - (previous % width)) / width);
    if (dx + dy !== 1) return `bunky ${String(previous)} → ${String(cell)} nie sú susedné`;
  }
  return undefined;
}

/** Sú všetky bunky trasy od `from` cestné? */
function allRoads(world: World, route: readonly number[], from: number, to: number): number | undefined {
  for (let i = from; i < to; i++) if (world.grid.atIndex(route[i]).road !== 'road') return route[i];
  return undefined;
}

/**
 * Prvý krok trasy `route[i − 1] → route[i]` pre `i < to`, ktorý porušuje smer jednosmerky (`isRoadStepAllowed`, ADR-020);
 * index jeho cieľovej bunky v trase, inak `undefined`. Susednosť overil `routeProblem`.
 */
function wrongWayStep(world: World, route: readonly number[], to: number): number | undefined {
  const { width } = world.grid;
  for (let i = 1; i < to; i++) {
    const a = route[i - 1];
    const b = route[i];
    const direction = directionOfStep((b % width) - (a % width), (b - (b % width)) / width - (a - (a % width)) / width);
    if (direction === undefined || !isRoadStepAllowed(world.grid.atIndex(a), world.grid.atIndex(b), direction)) return i;
  }
  return undefined;
}

/** Modul jobu, ku ktorému vozidlo v danom stave ide / pri ktorom stojí (bez vyhadzovania); inak `undefined`. */
function destinationOf(world: World, vehicle: Vehicle): Module | undefined {
  const destination = VEHICLE_STATE_TRAITS[vehicle.state].destination;
  const job = destination === null || vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
  if (job === undefined || destination === null) return undefined;
  return world.modules.get(destination === 'source' ? job.fromModuleId : job.toModuleId);
}

/** Kardinálny kurz úseku `from → to` (susedné bunky); nulový úsek → `null`. */
function segmentHeadingOf(width: number, from: number, to: number): Rotation | null {
  return cardinalHeading((to % width) - (from % width), (to - (to % width)) / width - (from - (from % width)) / width);
}

/**
 * Súlad pohybu vozidla so stavom (ADR-019), alebo `undefined`:
 * progres 0 alebo v (`PROGRESS_NOISE`, 1) (`isValidProgress`, ADR-021 — šum by obrat zmenil na neplatný progres 1);
 * trasa po susedných bunkách v mape; poloha = `vehiclePosition` trasy a progresu; rozbehnuté vozidlo má kurz svojho
 * úseku (`cardinalHeading`, ADR-021); tvar trasy podľa
 * `VEHICLE_STATE_TRAITS.motion` (`park` `[cell]`, `drive` aspoň jedna cieľová bunka — alebo žiadna, ak vozidlo už stojí
 * na prístupovej bunke cieľa a príchod spracuje najbližší krok 6, `halt` `[cell]` alebo `[cell, nextCell]` s progresom
 * > 0); `waitTicks ≥ 1` práve v stavoch s `waits`; príznak preplánovania len pri jazde; bunka vozidla (a pri pohybe
 * medzi bunkami aj cieľová bunka úseku) má cestu a rozbehnutý úsek smie ísť v smere jednosmerky (bunky pod vozidlom
 * nejde prestavať, ADR-020); jazda bez čakajúceho preplánovania vedie celá po ceste v povolených smeroch a končí na
 * prístupovej bunke modulu jobu; pri `loading`/`unloading` vozidlo stojí na prístupovej bunke modulu jobu. Job musí
 * existovať (overí sa skôr, `checkVehicle` / `restoreJobs`).
 */
export function vehicleMotionProblem(world: World, vehicle: Vehicle): VehicleMotionProblem | undefined {
  const route = vehicle.remainingRoute();
  const traits = VEHICLE_STATE_TRAITS[vehicle.state];
  const where = `${vehicle.label} v stave '${vehicle.state}'`;
  if (!isValidProgress(vehicle.progress)) {
    return { field: 'progress', problem: `${where}: progres ${String(vehicle.progress)} musí byť 0 alebo v (PROGRESS_NOISE, 1)` };
  }
  const shape = routeProblem(world, route);
  if (shape !== undefined) return { field: 'route', problem: `${where}: trasa — ${shape}` };
  const expected = vehiclePosition(vehicle.cell, vehicle.nextCell, vehicle.progress, world.grid.width);
  if (expected.x !== vehicle.x || expected.y !== vehicle.y) {
    return { field: 'x', problem: `${where}: poloha (${String(vehicle.x)}, ${String(vehicle.y)}) ≠ poloha na trase (${String(expected.x)}, ${String(expected.y)})` };
  }
  const module = destinationOf(world, vehicle);
  const ahead = vehicle.cellsAhead;
  const moving = vehicle.progress > 0;
  const next = vehicle.nextCell;
  if (moving && next !== undefined && segmentHeadingOf(world.grid.width, vehicle.cell, next) !== vehicle.heading) {
    return { field: 'heading', problem: `${where}: kurz ${String(vehicle.heading)} nezodpovedá rozbehnutému úseku ${String(vehicle.cell)} → ${String(next)}` };
  }
  if (traits.motion === 'park' && ahead !== 0) return { field: 'route', problem: `${where} stojí, ale má pred sebou ${String(ahead)} buniek trasy` };
  if (traits.motion === 'drive' && ahead === 0 && (module === undefined || !isAccessCell(world.grid, module, vehicle.cell))) {
    return { field: 'route', problem: `${where} nemá trasu (žiadna cieľová bunka) a nestojí pri cieli` };
  }
  if (traits.motion === 'halt' && (ahead > 1 || (ahead === 1) !== moving)) {
    return { field: 'route', problem: `${where}: bez cesty smie mať len rozbehnutý úsek, má ${String(ahead)} buniek pred sebou (progres ${String(vehicle.progress)})` };
  }
  if (traits.waits !== vehicle.waitTicks > 0) return { field: 'waitTicks', problem: `${where}: waitTicks ${String(vehicle.waitTicks)} ${traits.waits ? 'musí byť ≥ 1' : 'musí byť 0'}` };
  if (vehicle.replanPending && traits.motion !== 'drive') return { field: 'replan', problem: `${where}: preplánovanie čaká len pri jazde` };
  const offRoad = allRoads(world, route, 0, moving ? 2 : 1);
  if (offRoad !== undefined) return { field: 'route', problem: `${where} stojí na bunke ${String(offRoad)} bez cesty` };
  if (moving && wrongWayStep(world, route, 2) !== undefined) {
    return { field: 'route', problem: `${where}: rozbehnutý úsek ${String(route[0])} → ${String(route[1])} ide proti smeru jednosmerky` };
  }
  if (module === undefined) return undefined;
  if (traits.motion === 'park' && !isAccessCell(world.grid, module, vehicle.cell)) {
    return { field: 'route', problem: `${where} nestojí na prístupovej bunke ${module.label}` };
  }
  if (traits.motion === 'drive' && !vehicle.replanPending) {
    const blocked = allRoads(world, route, 0, route.length);
    if (blocked !== undefined) return { field: 'route', problem: `${where}: trasa vedie cez bunku ${String(blocked)} bez cesty` };
    const wrongWay = wrongWayStep(world, route, route.length);
    if (wrongWay !== undefined) {
      return { field: 'route', problem: `${where}: krok trasy ${String(route[wrongWay - 1])} → ${String(route[wrongWay])} ide proti smeru jednosmerky` };
    }
    if (!isAccessCell(world.grid, module, route[route.length - 1])) return { field: 'route', problem: `${where}: trasa nekončí na prístupovej bunke ${module.label}` };
  }
  return undefined;
}
