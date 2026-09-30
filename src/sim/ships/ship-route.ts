/**
 * Geometria a pohyb lode (ARCHITECTURE §7.4; rozhodnutia orchestrátora 6 v docs/tasks/phase-02.md; ADR-016).
 *
 * - Loď sa pohybuje po úsečkách medzi bodmi trasy rýchlosťou `speedCellsPerTick`; zvyšok kroku sa prenáša do ďalšieho
 *   úseku tej istej trasy, na konci trasy loď zastane presne v poslednom bode (zvyšok kroku prepadne).
 * - Dĺžka úseku = `Math.sqrt` (IEEE presná na všetkých enginoch). **Žiadna trigonometria** (`sin/cos/atan2` nie sú
 *   bit-presné naprieč enginmi) — kurz je kardinálny podľa dominantnej osi úseku (`cardinalHeading`).
 * - Trasa stavu (`shipRoute`) sa odvodzuje zo stavu lode, mapy (`seaLane`, `anchorage`) a obsadených kotvísk, preto sa
 *   neukladá — v save je len `waypointIndex`.
 * - Poloha pri kotvisku (`dockPoint`) = stred obdĺžnika `lengthCells × widthCells` tesne pred hranou pri vode, od prvého
 *   obsadeného kotviska po pobreží; kurz pri kotvisku je rovnobežný s hranou (`DOCKED_HEADING`).
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
}

/** Posun od ľavého horného rohu bunky k jej stredu. */
const CELL_CENTER_OFFSET = 0.5;

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

/** Os, pozdĺž ktorej leží dĺžka lode pri danom kurze. */
const LENGTH_AXIS: { readonly [R in Rotation]: 'x' | 'y' } = Object.freeze({ 0: 'y', 90: 'x', 180: 'y', 270: 'x' });

/**
 * Bunky, ktoré prekrýva obdĺžnik lode (stred `x`, `y`, dĺžka pozdĺž osi kurzu, šírka naprieč) — row-major. Pri
 * kotvisku sú to presne bunky obdĺžnika z `dockPoint`. Slúži pravidlu `water_blocked` (loď v páse kotviska).
 */
export function shipCells(ship: Pick<Ship, 'x' | 'y' | 'heading'> & { readonly def: ShipDimensions }): readonly CellCoord[] {
  const alongX = LENGTH_AXIS[ship.heading] === 'x';
  const w = alongX ? ship.def.lengthCells : ship.def.widthCells;
  const h = alongX ? ship.def.widthCells : ship.def.lengthCells;
  const x0 = Math.floor(ship.x - w / 2);
  const x1 = Math.ceil(ship.x + w / 2);
  const y0 = Math.floor(ship.y - h / 2);
  const y1 = Math.ceil(ship.y + h / 2);
  const cells: CellCoord[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) cells.push({ x, y });
  }
  return cells;
}

/** Čo trasa potrebuje zo sveta (`World` to spĺňa cez `map` a `modules`). */
export interface ShipRouteEnv {
  readonly map: { readonly seaLane: readonly CellCoord[]; readonly anchorage: readonly CellCoord[] };
  readonly modules: ReadonlyMap<EntityId, Module>;
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

/** Trasa podľa stavu (tabuľka, nie switch). Loď vždy začína v prvom bode alebo na konci predošlej trasy. */
const SHIP_ROUTES: { readonly [S in ShipState]: RouteOf } = {
  // Spawn na seaLane[0] → po vrcholoch dráhy na jej koniec.
  inbound: (_ship, env) => env.map.seaLane.map(cellCenter),
  // Na pridelenú bunku anchorage; bez nej loď stojí (koniec seaLane).
  waiting_anchorage: (ship, env) => {
    const cell = ship.anchorageIndex === null ? undefined : env.map.anchorage[ship.anchorageIndex];
    return cell === undefined ? NO_ROUTE : [cellCenter(cell)];
  },
  // Priama úsečka k polohe pri kotvisku (§7.4: voda je otvorená, bez A*).
  berthing: (ship, env) => [dockPoint(firstBerthOf(ship, env), ship.def)],
  docked: () => NO_ROUTE,
  // Späť na koniec seaLane.
  undocking: (_ship, env) => {
    const last = env.map.seaLane[env.map.seaLane.length - 1];
    return last === undefined ? NO_ROUTE : [cellCenter(last)];
  },
  // Po seaLane späť k jej začiatku (okraj mapy).
  outbound: (_ship, env) => [...env.map.seaLane].reverse().map(cellCenter),
  despawned: () => NO_ROUTE,
};

/** Body trasy aktuálneho stavu lode. */
export function shipRoute(ship: Ship, env: ShipRouteEnv): readonly ShipPoint[] {
  return SHIP_ROUTES[ship.state](ship, env);
}

/**
 * Posunie loď po `route` od bodu `ship.waypointIndex` najviac o `budget` buniek: úsek, na ktorý rozpočet stačí, loď
 * prejde celý (poloha = presne bod trasy) a zvyšok pokračuje ďalším úsekom; inak sa posunie o zvyšok pozdĺž úseku.
 * Kurz = `cardinalHeading` úseku, po ktorom sa loď pohla (nulový úsek kurz nemení). Vráti `true`, keď loď dosiahla
 * posledný bod trasy (aj pri prázdnej trase).
 */
export function advanceAlongRoute(ship: Ship, route: readonly ShipPoint[], budget: number): boolean {
  let remaining = budget;
  while (ship.waypointIndex < route.length) {
    const target = route[ship.waypointIndex];
    const dx = target.x - ship.x;
    const dy = target.y - ship.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= remaining) {
      ship.heading = cardinalHeading(dx, dy) ?? ship.heading;
      ship.x = target.x;
      ship.y = target.y;
      remaining -= distance;
      ship.waypointIndex += 1;
      continue;
    }
    if (remaining > 0) {
      ship.heading = cardinalHeading(dx, dy) ?? ship.heading;
      const fraction = remaining / distance;
      ship.x += dx * fraction;
      ship.y += dy * fraction;
    }
    return false;
  }
  return true;
}
