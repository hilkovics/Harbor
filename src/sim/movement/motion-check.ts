/**
 * Súlad pohybu nosiča so stavom (ARCHITECTURE §6 krok 12, §14; ADR-019, ADR-020, ADR-021, ADR-024) — spoločná kontrola
 * pre vozidlá aj kamióny, ktorú volá krok 12 aj obnova save. Stav FSM dodá volajúci len ako vlastnosti (`MotionTraits`)
 * a cieľ (`MotionTarget`), takže kontrola nepozná triedu nosiča.
 *
 * Zvyšok trasy sa číta cez `Carrier.routeCellAt` bez kópie (review T03-13); pozícia `i` v pomocníkoch nižšie =
 * `routeCellAt(i)`, dĺžka = `cellsAhead + 1`. V platnom stave kontrola nealokuje — správy sa skladajú až pri porušení.
 */
import { directionOfStep } from '../grid/grid';
import { isRoadStepAllowed } from '../grid/road-direction';
import type { Rotation } from '../grid/rotation';
import { isAccessCell } from '../logistics/module-access';
import type { Module } from '../modules/module';
import { CELL_CENTER_OFFSET, cardinalHeading } from '../ships/ship-route';
import { carrierPosition, isValidProgress, type Carrier } from './carrier';
import { isDrivableCell, type MovementWorld } from './route-planning';

/**
 * Pohyb nosiča v stave: `park` — stojí v strede bunky bez ďalšej trasy (`route = [cell]`, progres 0); `drive` — ide po
 * platnej trase k cieľu (aspoň jedna cieľová bunka); `halt` — stojí bez cesty (`no_path`): v strede bunky (`[cell]`)
 * alebo uprostred rozbehnutého úseku (`[cell, nextCell]`, progres > 0).
 */
export type CarrierMotion = 'park' | 'drive' | 'halt';

/** Vlastnosti stavu, ktoré kontrola pohybu potrebuje (tabuľky vlastností stavov vozidla aj kamióna ich spĺňajú). */
export interface MotionTraits {
  readonly motion: CarrierMotion;
  /** Stav s odpočtom `waitTicks ≥ 1`; ostatné stavy majú `waitTicks = 0`. */
  readonly waits: boolean;
}

/**
 * Cieľ jazdy alebo miesto pobytu: modul (ľubovoľná jeho prístupová bunka — vonkajšia bunka cestného konektora s cestou,
 * ADR-017) alebo konkrétna bunka (index; napr. road portál).
 */
export type MotionTarget = Module | number;

/** Pole záznamu nosiča v save, ku ktorému patrí problém pohybu (rovnaké mená vo `SerializedVehicle` aj `SerializedTruck`). */
export type MotionField = 'progress' | 'route' | 'x' | 'heading' | 'waitTicks' | 'replan';

/** Problém pohybu nosiča s poľom záznamu v save, ku ktorému patrí (krok 12, obnova). */
export interface MotionProblem {
  readonly field: MotionField;
  readonly problem: string;
}

function routeCell(carrier: Carrier, offset: number): number {
  return carrier.routeCellAt(offset) ?? -1;
}

/** Je bunka cieľom (prístupová bunka modulu, resp. presne cieľová bunka)? */
function isAtTarget(world: MovementWorld, target: MotionTarget, cell: number): boolean {
  return typeof target === 'number' ? cell === target : isAccessCell(world.grid, target, cell);
}

/** Je bunka cieľom jazdy alebo medzicieľom `via`? */
function isAtGoal(world: MovementWorld, target: MotionTarget, via: MotionTarget | undefined, cell: number): boolean {
  return isAtTarget(world, target, cell) || (via !== undefined && isAtTarget(world, via, cell));
}

/** Popis cieľa do správy o porušení. */
function targetLabel(target: MotionTarget): string {
  return typeof target === 'number' ? `cieľovej bunke ${String(target)}` : `prístupovej bunke ${target.label}`;
}

/** Popis nosiča do správy o porušení — skladá sa až pri porušení (krok 12 overuje každý nosič v každom ticku). */
function whereOf(carrier: Carrier, state: string): string {
  return `${carrier.label} v stave '${state}'`;
}

/** Úsek trasy vedie po susedných bunkách mriežky (4-susednosť) v jej rozsahu. */
function routeProblem(world: MovementWorld, carrier: Carrier): string | undefined {
  const { width, cellCount } = world.grid;
  const length = carrier.cellsAhead + 1;
  for (let i = 0; i < length; i++) {
    const cell = routeCell(carrier, i);
    if (cell >= cellCount) return `bunka ${String(cell)} je mimo mapy`;
    if (i === 0) continue;
    const previous = routeCell(carrier, i - 1);
    const dx = Math.abs((cell % width) - (previous % width));
    const dy = Math.abs((cell - (cell % width)) / width - (previous - (previous % width)) / width);
    if (dx + dy !== 1) return `bunky ${String(previous)} → ${String(cell)} nie sú susedné`;
  }
  return undefined;
}

/** Prvá bunka trasy na pozíciách `from … to − 1` bez cesty (ani nábrežia kotviska pod hákom, F6d), inak `undefined`. */
function allRoads(world: MovementWorld, carrier: Carrier, from: number, to: number): number | undefined {
  for (let i = from; i < to; i++) {
    const cell = routeCell(carrier, i);
    if (!isDrivableCell(world, cell)) return cell;
  }
  return undefined;
}

/**
 * Prvý krok trasy `i − 1 → i` pre `i < to`, ktorý porušuje smer jednosmerky (`isRoadStepAllowed`, ADR-020); pozícia
 * jeho cieľovej bunky v trase, inak `undefined`. Susednosť overil `routeProblem`.
 */
function wrongWayStep(world: MovementWorld, carrier: Carrier, to: number): number | undefined {
  const { width } = world.grid;
  for (let i = 1; i < to; i++) {
    const a = routeCell(carrier, i - 1);
    const b = routeCell(carrier, i);
    const direction = directionOfStep((b % width) - (a % width), (b - (b % width)) / width - (a - (a % width)) / width);
    if (direction === undefined || !isRoadStepAllowed(world.grid.atIndex(a), world.grid.atIndex(b), direction)) return i;
  }
  return undefined;
}

const AXIS_X = 0;
const AXIS_Y = 1;

/**
 * Jedna súradnica polohy na úseku bez alokácie (krok 12): `start` = súradnica bunky, `+ 0,5`, pri pohybe `+ (cieľ −
 * start) × progres` — rovnaké poradie operácií ako `Carrier.place` / `carrierPosition`, takže výsledok je bitovo zhodný.
 */
function routeAxis(start: number, next: number | undefined, progress: number, width: number, axis: number): number {
  let value = start + CELL_CENTER_OFFSET;
  if (next === undefined || progress === 0) return value;
  const target = axis === AXIS_X ? next % width : (next - (next % width)) / width;
  value += (target - start) * progress;
  return value;
}

/** Kardinálny kurz úseku `from → to` (susedné bunky); nulový úsek → `null`. */
function segmentHeadingOf(width: number, from: number, to: number): Rotation | null {
  return cardinalHeading((to % width) - (from % width), (to - (to % width)) / width - (from - (from % width)) / width);
}

/**
 * Súlad pohybu nosiča so stavom (ADR-019), alebo `undefined`. `state` slúži len do správy (`… v stave 'to_pickup'`),
 * `traits` = vlastnosti stavu, `target` = cieľ jazdy / miesto pobytu podľa stavu (`undefined` = stav cieľ nemá alebo
 * závisí od niečoho, čo tu nie je — napr. `no_path`), `via` = voliteľný medzicieľ jazdy (trasa smie končiť aj na ňom —
 * kamión pred spätným priechodom stojiskom, ADR-024):
 * progres 0 alebo v (`PROGRESS_NOISE`, 1) (`isValidProgress`, ADR-021 — šum by obrat zmenil na neplatný progres 1);
 * trasa po susedných bunkách v mape; poloha = `carrierPosition` trasy a progresu; rozbehnutý nosič má kurz svojho úseku
 * (`cardinalHeading`, ADR-021); tvar trasy podľa `traits.motion` (`park` `[cell]`, `drive` aspoň jedna cieľová bunka —
 * alebo žiadna, ak nosič už stojí na cieli a príchod spracuje najbližší krok systému, `halt` `[cell]` alebo
 * `[cell, nextCell]` s progresom > 0); `waitTicks ≥ 1` práve v stavoch s `waits`; príznak preplánovania len pri jazde;
 * bunka nosiča (a pri pohybe medzi bunkami aj cieľová bunka úseku) má cestu a rozbehnutý úsek smie ísť v smere
 * jednosmerky (bunky pod nosičom nejde prestavať, ADR-020); jazda bez čakajúceho preplánovania vedie celá po ceste
 * v povolených smeroch a končí na cieli; pri `park` nosič stojí na cieli.
 */
export function carrierMotionProblem(
  world: MovementWorld,
  carrier: Carrier,
  state: string,
  traits: MotionTraits,
  target: MotionTarget | undefined,
  via?: MotionTarget,
): MotionProblem | undefined {
  if (!isValidProgress(carrier.progress)) {
    return { field: 'progress', problem: `${whereOf(carrier, state)}: progres ${String(carrier.progress)} musí byť 0 alebo v (PROGRESS_NOISE, 1)` };
  }
  const shape = routeProblem(world, carrier);
  if (shape !== undefined) return { field: 'route', problem: `${whereOf(carrier, state)}: trasa — ${shape}` };
  const { width } = world.grid;
  const expectedX = routeAxis(carrier.cell % width, carrier.nextCell, carrier.progress, width, AXIS_X);
  const expectedY = routeAxis((carrier.cell - (carrier.cell % width)) / width, carrier.nextCell, carrier.progress, width, AXIS_Y);
  if (expectedX !== carrier.x || expectedY !== carrier.y) {
    const expected = carrierPosition(carrier.cell, carrier.nextCell, carrier.progress, width);
    return { field: 'x', problem: `${whereOf(carrier, state)}: poloha (${String(carrier.x)}, ${String(carrier.y)}) ≠ poloha na trase (${String(expected.x)}, ${String(expected.y)})` };
  }
  const ahead = carrier.cellsAhead;
  const length = ahead + 1;
  const moving = carrier.progress > 0;
  const next = carrier.nextCell;
  if (moving && next !== undefined && segmentHeadingOf(world.grid.width, carrier.cell, next) !== carrier.heading) {
    return { field: 'heading', problem: `${whereOf(carrier, state)}: kurz ${String(carrier.heading)} nezodpovedá rozbehnutému úseku ${String(carrier.cell)} → ${String(next)}` };
  }
  if (traits.motion === 'park' && ahead !== 0) return { field: 'route', problem: `${whereOf(carrier, state)} stojí, ale má pred sebou ${String(ahead)} buniek trasy` };
  if (traits.motion === 'drive' && ahead === 0 && (target === undefined || !isAtGoal(world, target, via, carrier.cell))) {
    return { field: 'route', problem: `${whereOf(carrier, state)} nemá trasu (žiadna cieľová bunka) a nestojí pri cieli` };
  }
  if (traits.motion === 'halt' && (ahead > 1 || (ahead === 1) !== moving)) {
    return { field: 'route', problem: `${whereOf(carrier, state)}: bez cesty smie mať len rozbehnutý úsek, má ${String(ahead)} buniek pred sebou (progres ${String(carrier.progress)})` };
  }
  if (traits.waits !== carrier.waitTicks > 0) return { field: 'waitTicks', problem: `${whereOf(carrier, state)}: waitTicks ${String(carrier.waitTicks)} ${traits.waits ? 'musí byť ≥ 1' : 'musí byť 0'}` };
  if (carrier.replanPending && traits.motion !== 'drive') return { field: 'replan', problem: `${whereOf(carrier, state)}: preplánovanie čaká len pri jazde` };
  const offRoad = allRoads(world, carrier, 0, moving ? 2 : 1);
  if (offRoad !== undefined) return { field: 'route', problem: `${whereOf(carrier, state)} stojí na bunke ${String(offRoad)} bez cesty` };
  if (moving && wrongWayStep(world, carrier, 2) !== undefined) {
    return { field: 'route', problem: `${whereOf(carrier, state)}: rozbehnutý úsek ${String(carrier.cell)} → ${String(next)} ide proti smeru jednosmerky` };
  }
  if (target === undefined) return undefined;
  if (traits.motion === 'park' && !isAtTarget(world, target, carrier.cell)) {
    return { field: 'route', problem: `${whereOf(carrier, state)} nestojí na ${targetLabel(target)}` };
  }
  if (traits.motion === 'drive' && !carrier.replanPending) {
    const blocked = allRoads(world, carrier, 0, length);
    if (blocked !== undefined) return { field: 'route', problem: `${whereOf(carrier, state)}: trasa vedie cez bunku ${String(blocked)} bez cesty` };
    const wrongWay = wrongWayStep(world, carrier, length);
    if (wrongWay !== undefined) {
      return { field: 'route', problem: `${whereOf(carrier, state)}: krok trasy ${String(routeCell(carrier, wrongWay - 1))} → ${String(routeCell(carrier, wrongWay))} ide proti smeru jednosmerky` };
    }
    if (!isAtGoal(world, target, via, routeCell(carrier, ahead))) return { field: 'route', problem: `${whereOf(carrier, state)}: trasa nekončí na ${targetLabel(target)}` };
  }
  return undefined;
}
