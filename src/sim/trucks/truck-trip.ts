/**
 * Jazda kamióna po pozemnom reťazci (ARCHITECTURE §7.4, §7.5; ADR-022, ADR-024, ADR-041): ciele jazdy podľa stavu, plánovanie trasy (zdieľané s vozidlami, `src/sim/movement`),
 * prechod do `no_path` a súlad pohybu so stavom (krok 12, obnova save).
 *
 * Ciele sa odvodzujú z aktuálnych ciest a modulov pri každom plánovaní, takže prestavba siete sa prejaví pri najbližšom preplánovaní. Strany pruhu brány dáva
 * `LandsideNetwork.gateSides` (prvý konektor = vonkajšia, druhý = vnútorná strana):
 * - `to_pre_gate` → prístupová bunka vjazdu predbránovej plochy kamióna (`preGateId`),
 * - `to_gate` → prístupová bunka **vonkajšej** strany vstupného pruhu kamióna (`gateId`; fronta dnu),
 * - `to_holding` → prístupová bunka vjazdu odstavnej plochy kamióna (`holdingId`),
 * - `to_tp` → rezervované TP kamióna (`tpCell`: bunka pruhu RTG bloku, alebo vonkajšia bunka konektora bloku),
 * - `to_gate_out` → prístupová bunka vonkajšej strany výstupného pruhu kamióna (`gateOutId`, vyberie sa podľa odhadu času pri prvom plánovaní; fronta von),
 * - `to_portal` → najbližší portál výjazdu (`out` alebo `both`, ADR-037 dodatok R1, ADR-041 bod 3).
 * Bez cieľa alebo cesty kamión prejde do `no_path` a skúša znova každých `logistics.repathIntervalTicks` (ADR-019).
 */
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import type { Module } from '../modules/module';
import { PreGateBuffer } from '../modules/pre-gate-buffer';
import { TruckHolding } from '../modules/truck-holding';
import { TruckGate } from '../modules/truck-gate';
import { carrierMotionProblem, type MotionProblem, type MotionTarget } from '../movement/motion-check';
import { findRouteToCell, routeAnchor, takePath } from '../movement/route-planning';
import { cardinalHeading } from '../ships/ship-route';
import { exitSlotKey, headSlotKey } from '../traffic/head-slot';
import type { World } from '../world/world';
import { laneLoad } from './gate-choice';
import { TruckError } from './truck-error';
import { TRUCK_STATE_TRAITS, changeTruckState, type TruckGateSide, type TruckStop, type TruckTravelState } from './truck-fsm';
import type { Truck } from './truck';

/** Vstupný pruh brány kamióna (`gateId`); chýbajúci → `TruckError('inconsistent')`. */
export function gateOfTruck(world: World, truck: Truck): TruckGate {
  const gate = world.modules.get(truck.gateId);
  if (!(gate instanceof TruckGate)) throw new TruckError('inconsistent', `${truck.label}: brána #${String(truck.gateId)} vo svete nie je`);
  return gate;
}

/** Výstupný pruh brány kamióna (`gateOutId`); kamión ho ešte nemá alebo modul chýba → `TruckError('inconsistent')`. */
export function gateOutOfTruck(world: World, truck: Truck): TruckGate {
  const gate = truck.gateOutId === null ? undefined : world.modules.get(truck.gateOutId);
  if (!(gate instanceof TruckGate)) throw new TruckError('inconsistent', `${truck.label}: výstupný pruh #${String(truck.gateOutId)} vo svete nie je`);
  return gate;
}

/** Predbránová plocha kamióna (`preGateId`); chýbajúca → `TruckError('inconsistent')`. */
export function preGateOfTruck(world: World, truck: Truck): PreGateBuffer {
  const buffer = truck.preGateId === null ? undefined : world.modules.get(truck.preGateId);
  if (!(buffer instanceof PreGateBuffer)) throw new TruckError('inconsistent', `${truck.label}: predbránová plocha #${String(truck.preGateId)} vo svete nie je`);
  return buffer;
}

/** Pruh brány, ku ktorému sa kamión vzťahuje v stave so stranou `side` (`entry` = vstupný pruh, `exit` = výstupný pruh); výstupný pruh bez výberu → `undefined`. */
function laneOfSide(world: World, truck: Truck, side: TruckGateSide): TruckGate | undefined {
  if (side === 'entry') return gateOfTruck(world, truck);
  return truck.gateOutId === null ? undefined : gateOutOfTruck(world, truck);
}

/** Odstavná plocha kamióna (`holdingId`); chýbajúca → `TruckError('inconsistent')`. */
export function holdingOfTruck(world: World, truck: Truck): TruckHolding {
  const holding = truck.holdingId === null ? undefined : world.modules.get(truck.holdingId);
  if (!(holding instanceof TruckHolding)) throw new TruckError('inconsistent', `${truck.label}: odstavná plocha #${String(truck.holdingId)} vo svete nie je`);
  return holding;
}

/** Koniec pruhu brány: `near` = vonkajšia strana (tu kamión čaká, prvý konektor), `far` = vnútorná strana (tu po prechode vyjde, druhý konektor). */
type LaneEnd = 'near' | 'far';

/** Prístupová bunka konca `end` pruhu brány pre stranu `side` kamióna (`NO_ACCESS`, keď strana alebo pruh chýba). */
function gateEndCell(world: World, truck: Truck, side: TruckGateSide | null, end: LaneEnd, anchor?: number): number {
  if (side === null) return NO_ACCESS;
  const lane = laneOfSide(world, truck, side) ?? (anchor === undefined ? undefined : pickOutLane(world, truck, anchor));
  if (lane === undefined) return NO_ACCESS;
  const sides = world.landside.gateSides(lane);
  return end === 'near' ? sides.entryCell : sides.exitCell;
}

/** Bunka strany brány, pri ktorej kamión vo fronte (stav `gate_queue*`) čaká; `NO_ACCESS`, ak strana chýba alebo nie je vo fronte. */
export function gateNearSideCell(world: World, truck: Truck): number {
  return gateEndCell(world, truck, TRUCK_STATE_TRAITS[truck.state].gateSide, 'near');
}

/** Bunka, na ktorej kamión po prechode pruhom (z fronty v aktuálnom stave) vyjde; `NO_ACCESS`, ak strana chýba. */
export function gateFarSideCell(world: World, truck: Truck): number {
  return gateEndCell(world, truck, TRUCK_STATE_TRAITS[truck.state].gateSide, 'far');
}

/**
 * Výstupný pruh pre kamión z bunky `from` podľa odhadu času (ADR-041 bod 3): cesta k vstupu pruhu v tickoch +
 * záťaž pruhu (fronta a idúci k nemu) × stredný čas obsluhy v jeho režime; pruh bez cesty sa preskočí, pri zhode vyhrá nižšie id. Nič nemení.
 */
export function pickOutLane(world: World, truck: Truck, from: number): TruckGate | undefined {
  let best: TruckGate | undefined;
  let bestEta = Infinity;
  for (const lane of world.landside.outLanes) {
    const entry = world.landside.gateSides(lane).entryCell;
    const cost = world.distances.distance(from, entry);
    if (cost === Infinity) continue;
    const eta = cost / Math.max(truck.def.speedCellsPerTick, Number.MIN_VALUE) + laneLoad(world, lane) * lane.meanServiceTicks(lane.mode);
    if (best === undefined || eta < bestEta) {
      best = lane;
      bestEta = eta;
    }
  }
  return best;
}

/**
 * Kamión vo fronte brány nestojí na svojej strane, hoci je určená (strany sa pod ním preklopili — brána dosiahnuteľná
 * z portálu z oboch strán a zmena cien ciest, alebo prerušenie a obchádzka)? Krok 12, obnova save a urovnanie front
 * po zmene siete (`settleGateQueues`). Mimo fronty `false`.
 */
export function isOffQueueSide(world: World, truck: Truck): boolean {
  if (!TRUCK_STATE_TRAITS[truck.state].queued) return false;
  const near = gateNearSideCell(world, truck);
  return near !== NO_ACCESS && truck.cell !== near;
}

/**
 * Kamión vo fronte (`gate_queue*`) alebo v prechode bránou (`gate_pass*`) nestojí na svojej strane brány, hoci je určená (strany
 * sa pod ním preklopili)? Podklad pre `settleGateQueues`; invariant brány (`isOffQueueSide`) kamión v prechode nekontroluje —
 * ten smie ostať na starej strane, kým ho urovnanie po zmene siete (alebo koniec prechodu) neposunie.
 */
export function isOffGateSide(world: World, truck: Truck): boolean {
  const traits = TRUCK_STATE_TRAITS[truck.state];
  if (!traits.queued && !traits.passing) return false;
  const near = gateNearSideCell(world, truck);
  return near !== NO_ACCESS && truck.cell !== near;
}

type TargetCellFn = (world: World, truck: Truck, travel: TruckTravelState, anchor: number) => number;

/** Cieľová bunka jazdy podľa cieľa stavu (tabuľka, nie switch — pravidlo 7); `NO_ACCESS` = cieľ nie je. */
const TARGET_CELLS: { readonly [S in TruckStop]: TargetCellFn } = Object.freeze({
  pre_gate: (world: World, truck: Truck) => {
    const entry = preGateOfTruck(world, truck).connectors[0];
    return entry === undefined ? NO_ACCESS : accessCellIndex(world.grid, entry);
  },
  gate: (world: World, truck: Truck, travel: TruckTravelState, anchor: number) => gateEndCell(world, truck, TRUCK_STATE_TRAITS[travel].gateSide, 'near', anchor),
  holding: (world: World, truck: Truck) => {
    const entry = holdingOfTruck(world, truck).connectors[0];
    return entry === undefined ? NO_ACCESS : accessCellIndex(world.grid, entry);
  },
  tp: (_world: World, truck: Truck) => truck.tpCell ?? NO_ACCESS,
  portal: (world: World, _truck: Truck, _travel: TruckTravelState, anchor: number) => world.landside.nearestExitPortal(anchor),
});

/** Cieľová bunka jazdy v stave `travel` z kotvy `anchor` (viď hlavička; pri `to_dock` bunka docku); `NO_ACCESS` = cieľ nie je. */
function targetCell(world: World, truck: Truck, travel: TruckTravelState, anchor: number = truck.cell): number {
  const stop = TRUCK_STATE_TRAITS[travel].stop;
  return stop === null ? NO_ACCESS : TARGET_CELLS[stop](world, truck, travel, anchor);
}

/**
 * Cesta kamióna k cieľu jazdy `travel` z bunky `anchor` bez zmeny kamióna (suchý beh plánovania — výjazd z modulu podľa nej zistí, ktorý slot výjazdovej bunky potrebuje).
 * `null` = cieľ nie je alebo k nemu nevedie cesta.
 */
export function findTruckRoute(world: World, truck: Truck, travel: TruckTravelState, anchor: number): readonly number[] | null {
  return findRouteToCell(world, anchor, targetCell(world, truck, travel, anchor));
}

/**
 * Naplánuje kamiónu trasu k cieľu jazdy `travel` z jeho kotvy (`findTruckRoute`) a nastaví ju. `false` = cieľ nie je alebo
 * k nemu nevedie cesta (kamión sa nezmení).
 */
export function planTruckRoute(world: World, truck: Truck, travel: TruckTravelState): boolean {
  const anchor = routeAnchor(truck);
  if (anchor === undefined) return false;
  const path = findTruckRoute(world, truck, travel, anchor);
  if (path === null) return false;
  // Výstupný pruh sa vyberie pri prvom úspešnom plánovaní cesty von (odhad času, ADR-041 bod 3) a ďalej sa nemení.
  if (travel === 'to_gate_out' && truck.gateOutId === null) truck.gateOutId = pickOutLane(world, truck, anchor)?.id ?? null;
  takePath(world, truck, path);
  return true;
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

/**
 * Slot, ktorý kamión potrebuje na výjazdovej bunke `cell`, keď z nej pôjde v stave `travel` (ADR-037): pruh podľa smeru prvého
 * kroku trasy (suchý beh plánovania `findTruckRoute`, kamión sa nemení); bez trasy pruh 0 (kamión skončí v `no_path`).
 */
export function exitKeyOf(world: World, truck: Truck, cell: number, travel: TruckTravelState): number {
  const path = findTruckRoute(world, truck, travel, cell);
  return exitSlotKey(world, cell, path === null ? undefined : path[1]);
}

/** Je slot výjazdovej bunky `cell` voľný (alebo vlastný) pre jazdu v stave `travel`? Výjazd z modulu ho vyžaduje (ADR-037). */
export function canExitTo(world: World, truck: Truck, cell: number, travel: TruckTravelState): boolean {
  return world.laneSlots.isFreeFor(exitKeyOf(world, truck, cell, travel), truck.id);
}

/**
 * Výjazd kamióna z modulu na cestu (stojisko, dock, brána; volajúci overil `canExitTo`): kamión sa objaví v strede
 * výjazdovej bunky `cell`, začne jazdu `travel` (`startTruckTrip`) a zaberie slot hlavy (`headSlotKey`). Telo sa „rozvinie"
 * počas jazdy. Pohyb až v ďalšom ticku.
 */
export function exitTo(world: World, truck: Truck, cell: number, travel: TruckTravelState): void {
  truck.jumpTo(cell, world.grid.width);
  startTruckTrip(world, truck, travel);
  truck.reserveHead(headSlotKey(world, truck));
}

/** Cieľ pre krok 12 podľa cieľa stavu (tabuľka): modul väzby kamióna, bunka TP alebo bunka portálu. */
const MOTION_TARGETS: { readonly [S in TruckStop]: (world: World, truck: Truck) => MotionTarget | undefined } = Object.freeze({
  pre_gate: (world: World, truck: Truck): Module | undefined => (truck.preGateId === null ? undefined : world.modules.get(truck.preGateId)),
  gate: (world: World, truck: Truck): Module | undefined => {
    const side = TRUCK_STATE_TRAITS[truck.state].gateSide;
    const id = side === 'exit' ? truck.gateOutId : truck.gateId;
    return id === null ? undefined : world.modules.get(id);
  },
  holding: (world: World, truck: Truck): Module | undefined => (truck.holdingId === null ? undefined : world.modules.get(truck.holdingId)),
  tp: (_world: World, truck: Truck): number | undefined => truck.tpCell ?? undefined,
  portal: (world: World): Int32Array => world.landside.outPortalCells,
});

/**
 * Cieľ jazdy / miesto pobytu kamióna pre krok 12: modul podľa `TRUCK_STATE_TRAITS.stop` (ľubovoľná jeho prístupová bunka — robustné voči prestavbe siete, ktorá strany brány alebo trasu zmení),
 * bunka TP alebo bunka portálu; `undefined` = stav cieľ nemá (`no_path`) alebo modul chýba (to hlási kontrola väzieb).
 */
export function truckMotionTarget(world: World, truck: Truck): MotionTarget | undefined {
  const stop = TRUCK_STATE_TRAITS[truck.state].stop;
  return stop === null ? undefined : MOTION_TARGETS[stop](world, truck);
}

/**
 * Súlad pohybu kamióna so stavom (ADR-019, ADR-024), alebo `undefined` — zdieľaná `carrierMotionProblem` s vlastnosťami stavu `TRUCK_STATE_TRAITS` a cieľom `truckMotionTarget` (fronta
 * brány stojí na prístupovej bunke brány, `holding` na prístupovej bunke odstavnej plochy, `at_tp` / `at_edge_tp` na TP; jazda končí na cieli).
 */
export function truckMotionProblem(world: World, truck: Truck): MotionProblem | undefined {
  return carrierMotionProblem(world, truck, truck.state, TRUCK_STATE_TRAITS[truck.state], truckMotionTarget(world, truck), undefined);
}
