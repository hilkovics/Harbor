/**
 * Geometria a pohyb lode (ARCHITECTURE §7.4; rozhodnutia orchestrátora 6 v docs/tasks/phase-02.md; ADR-016).
 *
 * - Loď sa pohybuje po úsečkách medzi bodmi trasy rýchlosťou `speedCellsPerTick`; zvyšok kroku sa prenáša do ďalšieho
 *   úseku tej istej trasy, na konci trasy loď zastane presne v poslednom bode (zvyšok kroku prepadne).
 * - Dĺžka úseku = `Math.sqrt` (IEEE presná na všetkých enginoch). **Žiadna trigonometria** (`sin/cos/atan2` nie sú
 *   bit-presné naprieč enginmi) — kurz je kardinálny podľa dominantnej osi úseku (`cardinalHeading`).
 * - Trasa stavu je uložená v lodi (`Ship.route`, save v6, ADR-029): trasy cez prístav vznikajú pri rezervácii A* po
 *   vode (`ShipTraffic`, `WaterNavigator`) a závisia od polohy ostatných lodí v tej chvíli, preto sa nedajú odvodiť.
 *   Pravidlá pred ADR-029 ostali len pre migráciu save v5 (`legacyShipRoute`).
 * - Poloha pri kotvisku (`dockPoint`) = stred obdĺžnika `lengthCells × widthCells` tesne pred hranou pri vode, od prvého
 *   obsadeného kotviska po pobreží; kurz pri kotvisku je rovnobežný s hranou (`DOCKED_HEADING`).
 * - **Bod priblíženia** (`approachPoint`, ADR-029) = `dockPoint` posunutý o `frontWaterCells` od brehu, teda tesne za
 *   pás vody kotviska. Úsek medzi bodom priblíženia a kotviskom loď prejde **bokom** s kurzom `DOCKED_HEADING` (bod
 *   trasy s pevným kurzom, `ShipPoint.heading`) — ostane vo vlastnom páse vody a nezasiahne susedné kotviská.
 */
import type { EntityId } from '../core/entity-id';
import type { ShipClassDef, Side } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import type { Rotation } from '../grid/rotation';
import { BerthModule } from '../modules/berth-module';
import type { Module } from '../modules/module';
import { SIDE_STEPS, edgeCells } from '../modules/module-geometry';
import type { Ship } from './ship';
import { ShipError } from './ship-error';
import { SHIP_STATE_TRAITS, type ShipState } from './ship-fsm';

/** Bod na vode v bunkách (float). */
export interface ShipPoint {
  readonly x: number;
  readonly y: number;
  /**
   * Pevný kurz úseku, ktorý v tomto bode končí (loď sa posúva bokom — priblíženie ku kotvisku a odchod od neho,
   * ADR-029); chýba = kardinálny kurz podľa smeru úseku (`cardinalHeading`).
   */
  readonly heading?: Rotation;
}

/** Posun od ľavého horného rohu bunky k jej stredu. */
export const CELL_CENTER_OFFSET = 0.5;

/** Stred bunky: (cx + 0.5, cy + 0.5). */
export function cellCenter(cell: CellCoord): ShipPoint {
  return { x: cell.x + CELL_CENTER_OFFSET, y: cell.y + CELL_CENTER_OFFSET };
}

/**
 * Kardinálny kurz pohybu o (dx, dy) podľa dominantnej osi: |dx| ≥ |dy| → 90 (východ) / 270 (západ), inak 180 (juh,
 * väčšie y) / 0 (sever). Nulový vektor nemá kurz → `null` (loď si ponechá doterajší).
 */
export function cardinalHeading(dx: number, dy: number): Rotation | null {
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 90 : 270;
  return dy > 0 ? 180 : 0;
}

/**
 * Kurz lode pri kotvisku podľa strany hrany pri vode: rovnobežne s hranou, nábrežie po pravoboku (rot 0 = strana `n`
 * → loď pláva na východ, 90).
 */
export const DOCKED_HEADING: { readonly [S in Side]: Rotation } = Object.freeze({ n: 90, e: 180, s: 270, w: 0 });

/** Krok pozdĺž pobrežia v poradí `edgeCells` (stúpajúce `x` pri n/s, `y` pri e/w — rovnako ako `BerthGroup`). */
const ALONG_COAST: { readonly [S in Side]: { readonly dx: number; readonly dy: number } } = Object.freeze({
  n: Object.freeze({ dx: 1, dy: 0 }),
  e: Object.freeze({ dx: 0, dy: 1 }),
  s: Object.freeze({ dx: 1, dy: 0 }),
  w: Object.freeze({ dx: 0, dy: 1 }),
});

/** Rozmery lode potrebné na geometriu. */
export type ShipDimensions = Pick<ShipClassDef, 'lengthCells' | 'widthCells'>;

/**
 * Stred lode pri kotvisku: obdĺžnik `lengthCells` buniek pozdĺž pobrežia (od prvej bunky hrany `first`) × `widthCells`
 * riadkov pred hranou pri vode (bunky 1 … `widthCells` pásu `frontWaterBand`). Stred bunky hrany `c0`, krok pozdĺž
 * pobrežia `a`, krok od brehu `o`: stred = `c0 + a·(L − 1)/2 + o·(W + 1)/2`. Súradnice sú násobky 0,5 — presné v double.
 */
export function dockPoint(first: BerthModule, ship: ShipDimensions): ShipPoint {
  const side = first.waterSide;
  const [start] = edgeCells(first.origin, first.size, side);
  const along = ALONG_COAST[side];
  const out = SIDE_STEPS[side];
  const c0 = cellCenter(start);
  const alongOffset = (ship.lengthCells - 1) / 2;
  const outOffset = (ship.widthCells + 1) / 2;
  return { x: c0.x + along.dx * alongOffset + out.dx * outOffset, y: c0.y + along.dy * alongOffset + out.dy * outOffset };
}

/**
 * Bod priblíženia ku kotvisku (ADR-029): `dockPoint` posunutý od brehu o `frontWaterCells` prvého kotviska — obdĺžnik
 * lode tam leží tesne za pásom vody kotviska (pás má `frontWaterCells ≥ widthCells` riadkov). Súradnice sa orežú do
 * rozsahu mapy (`bounds`), aby loď nikdy nevyplávala z mapy.
 */
export function approachPoint(first: BerthModule, ship: ShipDimensions, bounds: { readonly width: number; readonly height: number }): ShipPoint {
  const dock = dockPoint(first, ship);
  const out = SIDE_STEPS[first.waterSide];
  const offset = first.params.frontWaterCells;
  return {
    x: Math.min(bounds.width, Math.max(0, dock.x + out.dx * offset)),
    y: Math.min(bounds.height, Math.max(0, dock.y + out.dy * offset)),
  };
}

/** Os, pozdĺž ktorej leží dĺžka lode pri danom kurze. */
const LENGTH_AXIS: { readonly [R in Rotation]: 'x' | 'y' } = Object.freeze({ 0: 'y', 90: 'x', 180: 'y', 270: 'x' });

/** Rozmer obdĺžnika lode pozdĺž osi `x` pri kurze `heading` (dĺžka pri 90/270, inak šírka). */
export function shipExtentX(ship: ShipDimensions, heading: Rotation): number {
  return LENGTH_AXIS[heading] === 'x' ? ship.lengthCells : ship.widthCells;
}

/** Rozmer obdĺžnika lode pozdĺž osi `y` pri kurze `heading` (šírka pri 90/270, inak dĺžka). */
export function shipExtentY(ship: ShipDimensions, heading: Rotation): number {
  return LENGTH_AXIS[heading] === 'x' ? ship.widthCells : ship.lengthCells;
}

/**
 * Bunky, ktoré prekrýva obdĺžnik lode (stred `x`, `y`, dĺžka pozdĺž osi kurzu, šírka naprieč) — row-major. Pri
 * kotvisku sú to presne bunky obdĺžnika z `dockPoint`. Slúži pravidlu `water_blocked` (loď v páse kotviska).
 */
export function shipCells(ship: Pick<Ship, 'x' | 'y' | 'heading'> & { readonly def: ShipDimensions }): readonly CellCoord[] {
  const box = shipBox(ship.def, ship.x, ship.y, ship.heading);
  const cells: CellCoord[] = [];
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) cells.push({ x, y });
  }
  return cells;
}

/** Obdĺžnik buniek `[x0, x1) × [y0, y1)` (celé čísla). */
export interface CellBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Bunky obdĺžnika lode so stredom (`x`, `y`) a kurzom `heading` ako obdĺžnik buniek — tie isté bunky ako `shipCells`
 * (každá bunka, do ktorej obdĺžnik zasahuje; pri strede v strede bunky a párnom rozmere aj o polbunku viac).
 */
export function shipBox(ship: ShipDimensions, x: number, y: number, heading: Rotation): CellBox {
  const w = shipExtentX(ship, heading);
  const h = shipExtentY(ship, heading);
  return { x0: Math.floor(x - w / 2), y0: Math.floor(y - h / 2), x1: Math.ceil(x + w / 2), y1: Math.ceil(y + h / 2) };
}

/** Čo trasa potrebuje zo sveta (`World` to spĺňa cez `map` a `modules`). */
export interface ShipRouteEnv {
  readonly map: { readonly width: number; readonly height: number; readonly seaLane: readonly CellCoord[]; readonly anchorage: readonly CellCoord[] };
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/** Kurz lode na začiatku sea lane, keď dráha nemá druhý bod alebo nulový prvý úsek (sever). */
const DEFAULT_LANE_HEADING: Rotation = 0;

/** Kurz lode na začiatku sea lane (smer prvého úseku) — kurz lode pred vstupom (`arriving`) a na začiatku plavby dnu. */
export function laneStartHeading(map: { readonly seaLane: readonly CellCoord[] }): Rotation {
  const [first, second] = map.seaLane;
  if (first === undefined || second === undefined) return DEFAULT_LANE_HEADING;
  return cardinalHeading(second.x - first.x, second.y - first.y) ?? DEFAULT_LANE_HEADING;
}

/** Začiatok dráhy (stred `seaLane[0]`) — poloha lode pred vstupom (`arriving`) a koniec plavby von (`outbound`). */
export function laneStart(env: ShipRouteEnv): ShipPoint | undefined {
  const first = env.map.seaLane[0];
  return first === undefined ? undefined : cellCenter(first);
}

/** Koniec dráhy (stred posledného bodu `seaLane`) — vstup do prístavu a uzol všetkých trás v ňom (ADR-029). */
export function laneEnd(env: ShipRouteEnv): ShipPoint | undefined {
  const last = env.map.seaLane[env.map.seaLane.length - 1];
  return last === undefined ? undefined : cellCenter(last);
}

/** Stred bunky anchorage `index`, alebo `undefined` (index mimo mapy). */
export function anchoragePoint(env: ShipRouteEnv, index: number): ShipPoint | undefined {
  const cell = env.map.anchorage[index];
  return cell === undefined ? undefined : cellCenter(cell);
}

/** Prvé (po pobreží) obsadené kotvisko lode; chýbajúce → `ShipError('inconsistent')`. */
export function firstBerthOf(ship: Ship, env: ShipRouteEnv): BerthModule {
  const [firstId] = ship.berthIds;
  const berth = firstId === undefined ? undefined : env.modules.get(firstId);
  if (!(berth instanceof BerthModule)) {
    throw new ShipError('inconsistent', `${ship.label} v stave '${ship.state}': kotvisko #${String(firstId)} z berthIds neexistuje`);
  }
  return berth;
}

/** Poloha a kurz lode pri kotvisku (ADR-016 bod 3). */
export interface ShipMooring {
  readonly point: ShipPoint;
  readonly heading: Rotation;
}

/**
 * Kde má stáť loď, ktorá drží kotviská, keď k nim dorazí: `dockPoint` prvého kotviska (po pobreží) a `DOCKED_HEADING`
 * jeho strany. Chýbajúce kotvisko → `ShipError('inconsistent')`.
 */
export function mooringOf(ship: Ship, env: ShipRouteEnv): ShipMooring {
  const first = firstBerthOf(ship, env);
  return { point: dockPoint(first, ship.def), heading: DOCKED_HEADING[first.waterSide] };
}

/**
 * Porušenie polohy dokovanej lode (`SHIP_STATE_TRAITS.moored`): súradnica alebo kurz, ktoré sa líšia od `mooringOf`;
 * `undefined` = v poriadku alebo loď nie je pri kotvisku. Súradnice sú násobky 0,5 (presné v double), porovnávajú sa
 * presne — `berthing` končí presne v bode trasy. Používa obnova save (T02-14) aj invarianty.
 */
export function mooringProblem(ship: Ship, env: ShipRouteEnv): { readonly field: 'x' | 'y' | 'heading'; readonly problem: string } | undefined {
  if (!SHIP_STATE_TRAITS[ship.state].moored) return undefined;
  const { point, heading } = mooringOf(ship, env);
  const at = `(${String(point.x)}, ${String(point.y)})`;
  if (ship.x !== point.x) return { field: 'x', problem: `dokovaná ${ship.label} má stáť pri kotvisku v ${at}, x je ${String(ship.x)}` };
  if (ship.y !== point.y) return { field: 'y', problem: `dokovaná ${ship.label} má stáť pri kotvisku v ${at}, y je ${String(ship.y)}` };
  if (ship.heading !== heading) {
    return { field: 'heading', problem: `dokovaná ${ship.label} má pri kotvisku kurz ${String(heading)}, má ${String(ship.heading)}` };
  }
  return undefined;
}

type RouteOf = (ship: Ship, env: ShipRouteEnv) => readonly ShipPoint[];

const NO_ROUTE: readonly ShipPoint[] = Object.freeze([]);

/** Body sea lane (stredy buniek) od okraja mapy po koniec dráhy. */
export function laneRoute(env: ShipRouteEnv): readonly ShipPoint[] {
  return env.map.seaLane.map(cellCenter);
}

/**
 * Trasa stavu podľa pravidiel pred ADR-029 (tabuľka, nie switch) — len pre migráciu save v5 → v6, ktorý trasy lodí
 * neukladal: `inbound` = sea lane, `waiting_anchorage` = pridelená anchorage (bez nej loď stojí), `berthing` = priama
 * úsečka k polohe pri kotvisku s kurzom `DOCKED_HEADING` (review T5B-04b: obdĺžnik pri kotvisku je tak súčasťou
 * rezervácie a loď sa na konci neotočí do susedov), `undocking` = koniec sea lane, `outbound` = sea lane odzadu. Loď
 * bez cieľa (`inbound` bez kotvísk a anchorage, `waiting_anchorage` bez anchorage) sem nepríde — parser save v5 ju
 * presunie pred vstup (`arriving`, ADR-029 addendum).
 */
const LEGACY_ROUTES: { readonly [S in ShipState]: RouteOf } = {
  arriving: () => NO_ROUTE,
  inbound: (_ship, env) => laneRoute(env),
  waiting_anchorage: (ship, env) => {
    const point = ship.anchorageIndex === null ? undefined : anchoragePoint(env, ship.anchorageIndex);
    return point === undefined ? NO_ROUTE : [point];
  },
  berthing: (ship, env) => {
    const first = firstBerthOf(ship, env);
    return [{ ...dockPoint(first, ship.def), heading: DOCKED_HEADING[first.waterSide] }];
  },
  docked: () => NO_ROUTE,
  lashing: () => NO_ROUTE,
  undocking: (_ship, env) => {
    const end = laneEnd(env);
    return end === undefined ? NO_ROUTE : [end];
  },
  outbound: (_ship, env) => [...laneRoute(env)].reverse(),
  despawned: () => NO_ROUTE,
};

/** Trasa stavu lode zo save v5 (pravidlá pred ADR-029, viď `LEGACY_ROUTES`). */
export function legacyShipRoute(ship: Ship, env: ShipRouteEnv): readonly ShipPoint[] {
  return LEGACY_ROUTES[ship.state](ship, env);
}

/** Body trasy aktuálneho stavu lode (uložená trasa `Ship.route`, ADR-029). */
export function shipRoute(ship: Ship): readonly ShipPoint[] {
  return ship.route;
}

/** Cieľ lode s rezerváciou pri vstupe: poloha pri kotviskách, inak anchorage; `undefined` = loď cieľ nemá. */
function targetOf(ship: Ship, env: ShipRouteEnv): ShipPoint | undefined {
  if (ship.berthIds.length > 0) return dockPoint(firstBerthOf(ship, env), ship.def);
  return ship.anchorageIndex === null ? undefined : anchoragePoint(env, ship.anchorageIndex);
}

/** Pravidlo trasy stavu pre kontrolu obnovy save (ADR-029 addendum, review T5B-04b). */
interface RouteRule {
  /** Trasa musí byť prázdna (loď stojí na mieste stavu a nepláva). */
  readonly empty: boolean;
  /** Trasa začína celou sea lane a pokračuje k cieľu; loď je ešte na dráhe (`waypointIndex` ≤ počet bodov dráhy). */
  readonly lanePrefix: boolean;
  /** Kde trasa končí (pri prázdnej trase kde loď stojí); `undefined` = stav bez cieľa → chyba. */
  readonly end: (ship: Ship, env: ShipRouteEnv) => ShipPoint | undefined;
}

const toLaneStart = (_ship: Ship, env: ShipRouteEnv): ShipPoint | undefined => laneStart(env);
const toDock = (ship: Ship, env: ShipRouteEnv): ShipPoint => dockPoint(firstBerthOf(ship, env), ship.def);

/**
 * Trasa podľa stavu (tabuľka, nie switch): `arriving` stojí pred vstupom na začiatku dráhy bez trasy, `inbound` pláva
 * po sea lane k cieľu z rezervácie (kotviská alebo anchorage), `waiting_anchorage` končí na svojej anchorage,
 * `berthing` pri kotvisku, `docked` stojí pri kotvisku bez trasy, `undocking` končí na konci dráhy, `outbound` na jej
 * začiatku.
 */
const ROUTE_RULES: { readonly [S in ShipState]: RouteRule } = {
  arriving: { empty: true, lanePrefix: false, end: toLaneStart },
  inbound: { empty: false, lanePrefix: true, end: targetOf },
  waiting_anchorage: { empty: false, lanePrefix: false, end: (ship, env) => (ship.anchorageIndex === null ? undefined : anchoragePoint(env, ship.anchorageIndex)) },
  berthing: { empty: false, lanePrefix: false, end: toDock },
  docked: { empty: true, lanePrefix: false, end: toDock },
  lashing: { empty: true, lanePrefix: false, end: toDock },
  undocking: { empty: false, lanePrefix: false, end: (_ship, env) => laneEnd(env) },
  outbound: { empty: false, lanePrefix: false, end: toLaneStart },
  despawned: { empty: true, lanePrefix: false, end: () => undefined },
};

/** Porušenie súladu trasy lode so stavom: pole záznamu lode v save a popis. */
export interface ShipRouteProblem {
  readonly field: 'route' | 'waypointIndex' | 'x' | 'y';
  readonly problem: string;
}

function at(point: { readonly x: number; readonly y: number }): string {
  return `(${String(point.x)}, ${String(point.y)})`;
}

/**
 * Súlad uloženej trasy lode so stavom (obnova save, ADR-029 addendum; review T5B-04b) — `undefined` = v poriadku:
 * prázdna trasa v stavoch, v ktorých loď stojí (`ROUTE_RULES.empty`), plavba dnu začína celou sea lane a loď je ešte
 * na nej, trasa končí presne v cieli stavu (pri prázdnej trase tam loď stojí; súradnice sú násobky 0,5 — presné),
 * a poloha leží na aktuálnom úseku: po dosiahnutí bodu `waypointIndex − 1` loď stojí v ňom alebo medzi ním a ďalším
 * bodom (obal úseku — pohyb `advanceAlongRoute` ho nikdy neopustí, kontrola je presná bez tolerancie). Začiatok
 * prvého úseku (`waypointIndex` 0) je poloha pri prechode stavu, ktorá sa neukladá — tam sa poloha neoveruje.
 */
export function shipRouteProblem(ship: Ship, env: ShipRouteEnv): ShipRouteProblem | undefined {
  const rule = ROUTE_RULES[ship.state];
  const { route, waypointIndex } = ship;
  const what = `${ship.label} v stave '${ship.state}'`;
  if (rule.empty && route.length > 0) return { field: 'route', problem: `${what} má mať prázdnu trasu, má ${String(route.length)} bodov` };
  if (rule.lanePrefix) {
    const lane = laneRoute(env);
    for (let i = 0; i <= lane.length; i++) {
      const point = route[i] as ShipPoint | undefined;
      const lanePoint = lane[i] as ShipPoint | undefined;
      if (point === undefined || (lanePoint !== undefined && (point.x !== lanePoint.x || point.y !== lanePoint.y || point.heading !== undefined))) {
        return { field: 'route', problem: `${what}: trasa musí začínať celou sea lane (${String(lane.length)} bodov) a pokračovať k cieľu` };
      }
    }
    if (waypointIndex > lane.length) {
      return { field: 'waypointIndex', problem: `${what} pláva len po sea lane (${String(lane.length)} bodov), index ${String(waypointIndex)}` };
    }
  }
  const expected = rule.end(ship, env);
  if (expected === undefined) return { field: 'route', problem: `${what} nemá cieľ trasy (kotviská ani anchorage)` };
  if (route.length === 0) {
    // Bez trasy loď stojí v cieli stavu (pred vstupom na začiatku dráhy, pri kotvisku, na anchorage).
    if (ship.x !== expected.x) return { field: 'x', problem: `${what} bez trasy má stáť v ${at(expected)}, x je ${String(ship.x)}` };
    if (ship.y !== expected.y) return { field: 'y', problem: `${what} bez trasy má stáť v ${at(expected)}, y je ${String(ship.y)}` };
    return undefined;
  }
  const last = route[route.length - 1];
  if (last.x !== expected.x || last.y !== expected.y) return { field: 'route', problem: `${what} má trasu do ${at(last)}, cieľ stavu je ${at(expected)}` };
  if (waypointIndex === 0) return undefined;
  const from = route[waypointIndex - 1];
  const to = waypointIndex < route.length ? route[waypointIndex] : from;
  const where = `${what} neleží na úseku trasy ${at(from)} → ${at(to)} (bod ${String(waypointIndex)})`;
  if (ship.x < Math.min(from.x, to.x) || ship.x > Math.max(from.x, to.x)) return { field: 'x', problem: `${where}: x je ${String(ship.x)}` };
  if (ship.y < Math.min(from.y, to.y) || ship.y > Math.max(from.y, to.y)) return { field: 'y', problem: `${where}: y je ${String(ship.y)}` };
  return undefined;
}

/** Kurz úseku k bodu `target` o (dx, dy): pevný kurz bodu (`ShipPoint.heading`), inak kardinálny; nulový úsek bez pevného kurzu → `null`. */
export function segmentHeading(target: ShipPoint, dx: number, dy: number): Rotation | null {
  return target.heading ?? cardinalHeading(dx, dy);
}

/**
 * Posunie loď po `route` od bodu `ship.waypointIndex` (po bod `end` bez neho, predvolene celú trasu) najviac o `budget`
 * buniek: úsek, na ktorý rozpočet stačí, loď
 * prejde celý (poloha = presne bod trasy) a zvyšok pokračuje ďalším úsekom; inak sa posunie o zvyšok pozdĺž úseku.
 * Kurz = pevný kurz bodu alebo `cardinalHeading` úseku, po ktorom sa loď pohla (nulový úsek bez pevného kurzu kurz
 * nemení). Vráti `true`, keď loď dosiahla
 * posledný bod trasy (aj pri prázdnej trase).
 */
export function advanceAlongRoute(ship: Ship, route: readonly ShipPoint[], budget: number, end = route.length): boolean {
  let remaining = budget;
  while (ship.waypointIndex < end) {
    const target = route[ship.waypointIndex];
    const dx = target.x - ship.x;
    const dy = target.y - ship.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= remaining) {
      ship.heading = segmentHeading(target, dx, dy) ?? ship.heading;
      ship.x = target.x;
      ship.y = target.y;
      remaining -= distance;
      ship.waypointIndex += 1;
      continue;
    }
    if (remaining > 0) {
      ship.heading = segmentHeading(target, dx, dy) ?? ship.heading;
      const fraction = remaining / distance;
      ship.x += dx * fraction;
      ship.y += dy * fraction;
    }
    return false;
  }
  return true;
}
