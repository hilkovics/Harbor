/**
 * Jazda kamióna po pozemnom reťazci (ARCHITECTURE §7.4, §7.5; rozhodnutia orchestrátora F4 č. 2, 3, 6; ADR-022,
 * ADR-024): ciele jazdy podľa stavu, plánovanie trasy (zdieľané s vozidlami, `src/sim/movement`), prechod do `no_path`
 * a súlad pohybu so stavom (krok 12, obnova save).
 *
 * Ciele sa odvodzujú z aktuálnych ciest a modulov pri každom plánovaní (`World.gateSides`, `World.landsideRoutes`,
 * `World.landside.portalCell`), takže prestavba siete sa prejaví pri najbližšom preplánovaní:
 * - `to_gate` → prístupová bunka **vstupnej** strany brány (fronta dnu),
 * - `to_bay` → vstupná bunka stojiska trasy (brána, stojisko) rampy,
 * - `to_dock` → prístupová bunka konektora docku (dock `d` = `d`-tý cestný konektor rampy v poradí defu); bez cesty
 *   k nemu najbližšia prístupová bunka rampy (dock je logické miesto, ADR-022),
 * - `to_gate_out` → prístupová bunka **výstupnej** strany brány (fronta von); keď k nej od rampy nevedie cesta priamo
 *   (stojisko je jediné spojenie), cez **spätný priechod stojiskom** trasy: jazda k výstupnej bunke stojiska, prechod
 *   telom (okamžitý, bez bay — ADR-011, ADR-024) na jeho vstupnú bunku a odtiaľ k bráne,
 * - `to_portal` → bunka road portálu (`roadPortals[0]`).
 * Bez cieľa alebo cesty kamión prejde do `no_path` a skúša znova každých `logistics.repathIntervalTicks` (ADR-019).
 */
import type { Grid } from '../grid/grid';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { LoadingRamp } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import { TruckGate } from '../modules/truck-gate';
import { WaitingArea } from '../modules/waiting-area';
import { carrierMotionProblem, type MotionProblem, type MotionTarget } from '../movement/motion-check';
import { planRouteToCell, planRouteToModule } from '../movement/route-planning';
import { cardinalHeading } from '../ships/ship-route';
import type { LandsideRoute } from '../world/landside';
import type { World } from '../world/world';
import { TruckError } from './truck-error';
import { TRUCK_STATE_TRAITS, changeTruckState, type TruckGateSide, type TruckState, type TruckStop, type TruckTravelState } from './truck-fsm';
import type { Truck } from './truck';

/** Brána kamióna; chýbajúca → `TruckError('inconsistent')`. */
export function gateOfTruck(world: World, truck: Truck): TruckGate {
  const gate = world.modules.get(truck.gateId);
  if (!(gate instanceof TruckGate)) throw new TruckError('inconsistent', `${truck.label}: brána #${String(truck.gateId)} vo svete nie je`);
  return gate;
}

/** Stojisko kamióna; chýbajúce → `TruckError('inconsistent')`. */
export function waitingAreaOfTruck(world: World, truck: Truck): WaitingArea {
  const area = world.modules.get(truck.waitingAreaId);
  if (!(area instanceof WaitingArea)) throw new TruckError('inconsistent', `${truck.label}: stojisko #${String(truck.waitingAreaId)} vo svete nie je`);
  return area;
}

/** Rampa kamióna; chýbajúca → `TruckError('inconsistent')`. */
export function rampOfTruck(world: World, truck: Truck): LoadingRamp {
  const ramp = world.modules.get(truck.rampId);
  if (!(ramp instanceof LoadingRamp)) throw new TruckError('inconsistent', `${truck.label}: rampa #${String(truck.rampId)} vo svete nie je`);
  return ramp;
}

/** Trasa (brána, stojisko) kamióna medzi aktuálnymi trasami jeho rampy; zaniknutá → `undefined`. */
export function truckRoute(world: World, truck: Truck): LandsideRoute | undefined {
  const ramp = world.modules.get(truck.rampId);
  if (!(ramp instanceof LoadingRamp)) return undefined;
  for (const route of world.landsideRoutes(ramp)) {
    if (route.gateId === truck.gateId && route.waitingAreaId === truck.waitingAreaId) return route;
  }
  return undefined;
}

/**
 * Prístupová bunka docku: vonkajšia bunka `dock`-tého cestného konektora rampy v poradí defu (pri viac dockoch než
 * konektorov cyklicky), ak má cestu; inak `NO_ACCESS`. Bez alokácie.
 */
export function dockAccessCell(grid: Grid, ramp: LoadingRamp, dock: number): number {
  let roads = 0;
  for (const connector of ramp.connectors) if (connector.type === 'road') roads += 1;
  if (roads === 0) return NO_ACCESS;
  let wanted = dock % roads;
  for (const connector of ramp.connectors) {
    if (connector.type !== 'road') continue;
    if (wanted === 0) return accessCellIndex(grid, connector);
    wanted -= 1;
  }
  return NO_ACCESS;
}

/** Prístupová bunka strany brány (`NO_ACCESS`, keď strana chýba). */
function gateSideCell(world: World, gate: TruckGate, side: TruckGateSide | null): number {
  if (side === null) return NO_ACCESS;
  const sides = world.gateSides(gate);
  return side === 'entry' ? sides.entryCell : sides.exitCell;
}

/** Druhá strana brány. */
const OTHER_SIDE: { readonly [S in TruckGateSide]: TruckGateSide } = Object.freeze({ entry: 'exit', exit: 'entry' });

/** Bunka, na ktorej kamión po prechode bránou (z fronty v stave `state`) vyjde; `NO_ACCESS`, ak strana chýba. */
export function gateFarSideCell(world: World, gate: TruckGate, state: TruckState): number {
  const side = TRUCK_STATE_TRAITS[state].gateSide;
  return side === null ? NO_ACCESS : gateSideCell(world, gate, OTHER_SIDE[side]);
}

type TargetCellFn = (world: World, truck: Truck, travel: TruckTravelState) => number;

/** Cieľová bunka jazdy podľa cieľa stavu (tabuľka, nie switch — pravidlo 7); `NO_ACCESS` = cieľ nie je. */
const TARGET_CELLS: { readonly [S in TruckStop]: TargetCellFn } = Object.freeze({
  gate: (world: World, truck: Truck, travel: TruckTravelState) => gateSideCell(world, gateOfTruck(world, truck), TRUCK_STATE_TRAITS[travel].gateSide),
  waiting_area: (world: World, truck: Truck) => truckRoute(world, truck)?.waitingEntryCell ?? NO_ACCESS,
  ramp: (world: World, truck: Truck) => dockAccessCell(world.grid, rampOfTruck(world, truck), truck.dock),
  portal: (world: World) => world.landside.portalCell,
});

/** Cieľová bunka jazdy v stave `travel` (viď hlavička; pri `to_dock` bunka docku); `NO_ACCESS` = cieľ nie je. */
function targetCell(world: World, truck: Truck, travel: TruckTravelState): number {
  const stop = TRUCK_STATE_TRAITS[travel].stop;
  return stop === null ? NO_ACCESS : TARGET_CELLS[stop](world, truck, travel);
}

/** Spätný priechod stojiskom trasy kamióna: z výstupnej bunky (`from`) na vstupnú (`to`); slepé parkovisko ho nemá. */
export interface PassageBack {
  readonly from: number;
  readonly to: number;
}

/** Spätný priechod stojiskom trasy kamióna (viď hlavička), alebo `undefined` (trasa zanikla, slepé parkovisko). */
export function passageBackOf(world: World, truck: Truck): PassageBack | undefined {
  const route = truckRoute(world, truck);
  if (route === undefined || route.waitingExitCell === route.waitingEntryCell) return undefined;
  return { from: route.waitingExitCell, to: route.waitingEntryCell };
}

/** Plán k spätnému priechodu stojiskom, keď za ním vedie cesta k cieľu jazdy (`passageBack`). */
function planPassageBack(world: World, truck: Truck, travel: TruckTravelState): boolean {
  const passage = passageBackOf(world, truck);
  const target = targetCell(world, truck, travel);
  if (passage === undefined || target === NO_ACCESS || world.paths.get(passage.to, target) === null) return false;
  return planRouteToCell(world, truck, passage.from);
}

/**
 * Naplánuje kamiónu trasu k cieľu jazdy `travel` z jeho kotvy (zdieľané `planRouteToCell` / `planRouteToModule`) a
 * nastaví ju: priamo k cieľovej bunke; pri `to_dock` inak k najbližšej prístupovej bunke rampy, pri `to_gate_out` inak
 * k spätnému priechodu stojiskom. `false` = cieľ nie je alebo k nemu nevedie cesta (kamión sa nezmení).
 */
export function planTruckRoute(world: World, truck: Truck, travel: TruckTravelState): boolean {
  if (planRouteToCell(world, truck, targetCell(world, truck, travel))) return true;
  const traits = TRUCK_STATE_TRAITS[travel];
  if (traits.stop === 'ramp') return planRouteToModule(world, truck, rampOfTruck(world, truck));
  return traits.passageBack && planPassageBack(world, truck, travel);
}

/** Je kamión na cieľovej bunke jazdy `travel` (napr. výstupná strana brány pri `to_gate_out`)? */
export function isAtTravelTarget(world: World, truck: Truck, travel: TruckTravelState): boolean {
  return truck.progress === 0 && truck.cell === targetCell(world, truck, travel);
}

/** Stojaci kamión sa natočí do smeru prvého úseku trasy (po spawne a po prechode modulom); bez trasy kurz ostáva. */
export function faceRoute(world: World, truck: Truck): void {
  const next = truck.nextCell;
  if (next === undefined || truck.progress !== 0) return;
  const { width } = world.grid;
  const cell = truck.cell;
  truck.heading = cardinalHeading((next % width) - (cell % width), (next - (next % width)) / width - (cell - (cell % width)) / width) ?? truck.heading;
}

/** Kamión nemá cestu: `no_path` (zapamätá si jazdný stav), zvyšok trasy zahodí, nový pokus o `repathIntervalTicks`. */
export function enterTruckNoPath(world: World, truck: Truck): void {
  changeTruckState(world.events, truck, 'no_path');
  truck.halt();
  truck.waitTicks = world.defs.logistics.repathIntervalTicks;
}

/** Začne jazdu: prechod do `travel` (`TruckStateChanged`) a plán trasy; bez cesty hneď `no_path`. Pohyb až v ďalšom ticku. */
export function startTruckTrip(world: World, truck: Truck, travel: TruckTravelState): void {
  changeTruckState(world.events, truck, travel);
  if (planTruckRoute(world, truck, travel)) faceRoute(world, truck);
  else enterTruckNoPath(world, truck);
}

/** Cieľ pre krok 12 podľa cieľa stavu (tabuľka): modul väzby kamióna alebo bunka portálu. */
const MOTION_TARGETS: { readonly [S in TruckStop]: (world: World, truck: Truck) => MotionTarget | undefined } = Object.freeze({
  gate: (world: World, truck: Truck): Module | undefined => world.modules.get(truck.gateId),
  waiting_area: (world: World, truck: Truck): Module | undefined => world.modules.get(truck.waitingAreaId),
  ramp: (world: World, truck: Truck): Module | undefined => world.modules.get(truck.rampId),
  portal: (world: World): number => world.landside.portalCell,
});

/**
 * Cieľ jazdy / miesto pobytu kamióna pre krok 12: modul podľa `TRUCK_STATE_TRAITS.stop` (ľubovoľná jeho prístupová
 * bunka — robustné voči prestavbe siete, ktorá strany brány alebo trasu zmení) alebo bunka portálu; `undefined` =
 * stav cieľ nemá (`no_path`) alebo modul chýba (to hlási kontrola väzieb).
 */
export function truckMotionTarget(world: World, truck: Truck): MotionTarget | undefined {
  const stop = TRUCK_STATE_TRAITS[truck.state].stop;
  return stop === null ? undefined : MOTION_TARGETS[stop](world, truck);
}

/**
 * Súlad pohybu kamióna so stavom (ADR-019, ADR-024), alebo `undefined` — zdieľaná `carrierMotionProblem` s vlastnosťami
 * stavu `TRUCK_STATE_TRAITS` a cieľom `truckMotionTarget` (fronta brány stojí na prístupovej bunke brány, `waiting` na
 * prístupovej bunke stojiska, `loading` na prístupovej bunke rampy; jazda končí na cieli, pri `to_gate_out` smie končiť
 * aj na prístupovej bunke stojiska pred spätným priechodom).
 */
export function truckMotionProblem(world: World, truck: Truck): MotionProblem | undefined {
  const traits = TRUCK_STATE_TRAITS[truck.state];
  const via = traits.passageBack ? world.modules.get(truck.waitingAreaId) : undefined;
  return carrierMotionProblem(world, truck, truck.state, traits, truckMotionTarget(world, truck), via);
}
