/**
 * WaterNavigator — trasy lodí po vode (ARCHITECTURE §7.4; ADR-029). Mapy s mólami a kanálmi (T5B-01) nedovoľujú priamu
 * úsečku z konca sea lane ku každému kotvisku, preto lode medzi koncom dráhy, anchorage a kotviskami plávajú po trase
 * z A* nad vodnými bunkami.
 *
 * - **Stav** = (bunka, os lode): stred lode v strede bunky, dĺžka lode pozdĺž osi `x` (kurz 90/270) alebo `y` (0/180).
 *   Stav je priechodný, keď celý obdĺžnik lode (`shipBox`) leží v mape na vode a nezasahuje do žiadnej prekážky
 *   (obdĺžniky lodí, ktoré stoja alebo sa na miesto chystajú — `obstacles`). Štartový stav je priechodný vždy (loď tam
 *   už je).
 * - **Hrany**: krok k susednej bunke pozdĺž osi (1 pohyb), krok **bokom** (kolmo na os, 1 pohyb + 1 manéver — loď
 *   s vlečnými člnmi; dlhá loď sa inak nedostane k nábrežiu v plytkej zátoke) a otočenie na mieste (1 manéver). Pri
 *   posune medzi stredmi dvoch buniek zaberie loď len bunky obdĺžnikov v oboch koncoch, takže priechodnosť stavov stačí
 *   na celú trasu; pri otočení musia byť priechodné obe osi.
 * - **Cena** je lexikografická: najprv počet pohybov, potom počet manévrov (kódovaná ako `pohyby × MANÉVRE_MAX +
 *   manévre`, kde `MANÉVRE_MAX` > najväčší možný počet manévrov — štrukturálna konštanta z veľkosti mriežky, nie
 *   balans). Najkratšia trasa teda vyhráva vždy a z nich tá s najmenej otočeniami a krokmi bokom. Heuristika
 *   Manhattan × `MANÉVRE_MAX` je prípustná aj konzistentná.
 * - **Deterministický výber** z open setu ako pri cestách (§7.4): menšie `f`, pri zhode menšie `h`, potom menší index
 *   stavu. Rovnaký vstup dá vždy tú istú trasu.
 * - Výsledok sú stredy buniek, v ktorých loď mení smer, a cieľ. Úsek dopredu nemá pevný kurz (kurz dá smer úseku),
 *   úsek bokom má pevný kurz lode (`ShipPoint.heading`). Pracovné polia vzniknú raz na navigátor; tabuľky priechodnosti
 *   vody sú memo podľa rozmerov lode (terén je statický).
 */
import { IndexedBinaryHeap } from '../logistics/binary-heap';
import type { Rotation } from '../grid/rotation';
import { TERRAIN_TRAITS, type TerrainType } from '../grid/terrain';
import { CELL_CENTER_OFFSET, shipBox, type CellBox, type ShipDimensions, type ShipPoint } from './ship-route';

/** Os lode: 0 = dĺžka pozdĺž `x` (kurz 90/270), 1 = pozdĺž `y` (kurz 0/180). */
export type ShipAxis = 0 | 1;

/** Os lode pri danom kurze. */
export const AXIS_OF_HEADING: { readonly [R in Rotation]: ShipAxis } = Object.freeze({ 0: 1, 90: 0, 180: 1, 270: 0 });

/** Reprezentatívny kurz osi (na výpočet obdĺžnika lode). */
const HEADING_OF_AXIS: readonly [Rotation, Rotation] = [90, 0];

/** Počet osí (stavov na bunku). */
const AXES = 2;

/** Čo navigátor z mriežky číta (`Grid` to spĺňa); terén sa nemení. */
export interface WaterGrid {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  atIndex(index: number): { readonly terrain: TerrainType };
}

const NO_PARENT = -1;
const NEVER = 0;

export class WaterNavigator {
  private readonly grid: WaterGrid;
  /** Rozmery lode `L×W` → priechodnosť vody stavu (bunka × os). */
  private readonly fitsByDims = new Map<string, Uint8Array>();
  /** Prefixové súčty ne-vodných buniek (`(width + 1) × (height + 1)`) — test obdĺžnika v O(1). */
  private readonly dry: Int32Array;
  private readonly g: Float64Array;
  private readonly h: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Int32Array;
  private readonly closed: Int32Array;
  private readonly open: IndexedBinaryHeap;
  private readonly turnScale: number;
  private generation = NEVER;

  constructor(grid: WaterGrid) {
    this.grid = grid;
    const states = grid.cellCount * AXES;
    this.turnScale = states + 1;
    this.dry = new Int32Array((grid.width + 1) * (grid.height + 1));
    const stride = grid.width + 1;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const wet = TERRAIN_TRAITS[grid.atIndex(y * grid.width + x).terrain].water ? 0 : 1;
        this.dry[(y + 1) * stride + (x + 1)] = wet + this.dry[y * stride + (x + 1)] + this.dry[(y + 1) * stride + x] - this.dry[y * stride + x];
      }
    }
    this.g = new Float64Array(states);
    this.h = new Float64Array(states);
    this.parent = new Int32Array(states);
    this.seen = new Int32Array(states);
    this.closed = new Int32Array(states);
    const { g, h } = this;
    this.open = new IndexedBinaryHeap(states, (a, b) => {
      const fa = g[a] + h[a];
      const fb = g[b] + h[b];
      if (fa !== fb) return fa < fb;
      if (h[a] !== h[b]) return h[a] < h[b];
      return a < b;
    });
  }

  /** Leží obdĺžnik buniek celý v mape a na vode? */
  isWater(box: CellBox): boolean {
    const { width, height } = this.grid;
    if (box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height) return false;
    const stride = width + 1;
    const dry = this.dry[box.y1 * stride + box.x1] - this.dry[box.y0 * stride + box.x1] - this.dry[box.y1 * stride + box.x0] + this.dry[box.y0 * stride + box.x0];
    return dry === 0;
  }

  /** Obdĺžnik lode so stredom v strede bunky `cell` a osou `axis`. */
  boxAt(dims: ShipDimensions, cell: number, axis: ShipAxis): CellBox {
    const { width } = this.grid;
    return shipBox(dims, (cell % width) + CELL_CENTER_OFFSET, Math.floor(cell / width) + CELL_CENTER_OFFSET, HEADING_OF_AXIS[axis]);
  }

  /** Stred bunky ako bod trasy. */
  centerOf(cell: number): ShipPoint {
    const { width } = this.grid;
    return { x: (cell % width) + CELL_CENTER_OFFSET, y: Math.floor(cell / width) + CELL_CENTER_OFFSET };
  }

  /** Index bunky, v ktorej leží bod (orezaný do mapy). */
  cellOf(point: { readonly x: number; readonly y: number }): number {
    const { width, height } = this.grid;
    const x = Math.min(width - 1, Math.max(0, Math.floor(point.x)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(point.y)));
    return y * width + x;
  }

  /** Priechodnosť vody stavov pre rozmery lode (memo; terén je statický). */
  private fits(dims: ShipDimensions): Uint8Array {
    const key = `${String(dims.lengthCells)}x${String(dims.widthCells)}`;
    const known = this.fitsByDims.get(key);
    if (known !== undefined) return known;
    const table = new Uint8Array(this.grid.cellCount * AXES);
    for (let cell = 0; cell < this.grid.cellCount; cell++) {
      for (let axis = 0 as ShipAxis; axis < AXES; axis = (axis + 1) as ShipAxis) {
        table[cell * AXES + axis] = this.isWater(this.boxAt(dims, cell, axis)) ? 1 : 0;
      }
    }
    this.fitsByDims.set(key, table);
    return table;
  }

  /** Je stav priechodný (voda a bez prekážky)? */
  private passable(dims: ShipDimensions, fits: Uint8Array, state: number, obstacles: readonly CellBox[]): boolean {
    if (fits[state] === 0) return false;
    if (obstacles.length === 0) return true;
    const box = this.boxAt(dims, Math.floor(state / AXES), (state % AXES) as ShipAxis);
    for (const obstacle of obstacles) {
      if (box.x0 < obstacle.x1 && obstacle.x0 < box.x1 && box.y0 < obstacle.y1 && obstacle.y0 < box.y1) return false;
    }
    return true;
  }

  private heuristic(cell: number, goal: number): number {
    const { width } = this.grid;
    return (Math.abs((cell % width) - (goal % width)) + Math.abs(Math.floor(cell / width) - Math.floor(goal / width))) * this.turnScale;
  }

  /**
   * Trasa stredu lode z bunky `from` s kurzom `fromHeading` do bunky `to` (s osou `toAxis`, `null` = ľubovoľná) po vode
   * mimo `obstacles`: stredy buniek, v ktorých loď mení smer, a cieľ (prvý bod je prvý zlom alebo cieľ, nie štart).
   * `null` = cesta neexistuje. Štart = cieľ so správnou osou → prázdna trasa.
   */
  findRoute(dims: ShipDimensions, from: number, fromHeading: Rotation, to: number, toAxis: ShipAxis | null, obstacles: readonly CellBox[]): ShipPoint[] | null {
    const fromAxis = AXIS_OF_HEADING[fromHeading];
    const fits = this.fits(dims);
    const { width, height } = this.grid;
    this.generation += 1;
    const stamp = this.generation;
    const { g, h, parent, seen, closed, open } = this;
    open.clear();
    const start = from * AXES + fromAxis;
    seen[start] = stamp;
    g[start] = 0;
    h[start] = this.heuristic(from, to);
    parent[start] = NO_PARENT;
    open.push(start);
    let found = -1;
    while (!open.isEmpty()) {
      const state = open.pop();
      if (closed[state] === stamp) continue;
      closed[state] = stamp;
      const cell = Math.floor(state / AXES);
      const axis = (state % AXES) as ShipAxis;
      if (cell === to && (toAxis === null || axis === toAxis)) {
        found = state;
        break;
      }
      // Otočenie na mieste.
      const turned = cell * AXES + (1 - axis);
      this.relax(state, turned, g[state] + 1, to, dims, fits, obstacles, stamp);
      // Posun o bunku (4 smery): pozdĺž osi dopredu/dozadu, kolmo bokom s manévrom navyše.
      const x = cell % width;
      const y = Math.floor(cell / width);
      const along = g[state] + this.turnScale;
      const sideways = along + 1;
      if (x > 0) this.relax(state, (cell - 1) * AXES + axis, axis === 0 ? along : sideways, to, dims, fits, obstacles, stamp);
      if (x < width - 1) this.relax(state, (cell + 1) * AXES + axis, axis === 0 ? along : sideways, to, dims, fits, obstacles, stamp);
      if (y > 0) this.relax(state, (cell - width) * AXES + axis, axis === 1 ? along : sideways, to, dims, fits, obstacles, stamp);
      if (y < height - 1) this.relax(state, (cell + width) * AXES + axis, axis === 1 ? along : sideways, to, dims, fits, obstacles, stamp);
    }
    if (found < 0) return null;
    return this.points(found, fromHeading);
  }

  private relax(from: number, to: number, cost: number, goal: number, dims: ShipDimensions, fits: Uint8Array, obstacles: readonly CellBox[], stamp: number): void {
    if (this.closed[to] === stamp) return;
    if (!this.passable(dims, fits, to, obstacles)) return;
    if (this.seen[to] === stamp && this.g[to] <= cost) return;
    this.g[to] = cost;
    this.h[to] = this.heuristic(Math.floor(to / AXES), goal);
    this.parent[to] = from;
    if (this.seen[to] === stamp && this.open.has(to)) this.open.decreaseKey(to);
    else this.open.push(to);
    this.seen[to] = stamp;
  }

  /**
   * Body trasy z reťaze rodičov: bunky, kde sa mení smer alebo spôsob pohybu (dopredu / bokom), a cieľ; úseky bokom
   * nesú pevný kurz lode (kurz posledného úseku dopredu, na začiatku `fromHeading`).
   */
  private points(goal: number, fromHeading: Rotation): ShipPoint[] {
    const states: number[] = [];
    for (let state = goal; state !== NO_PARENT; state = this.parent[state]) states.push(state);
    states.reverse();
    const { width } = this.grid;
    const points: ShipPoint[] = [];
    let heading = fromHeading;
    let segmentStep = 0;
    let segmentHeading: Rotation | undefined;
    for (let i = 1; i < states.length; i++) {
      const fromCell = Math.floor(states[i - 1] / AXES);
      const cell = Math.floor(states[i] / AXES);
      const axis = (states[i] % AXES) as ShipAxis;
      if (cell === fromCell) {
        // Otočenie na mieste: kurz novej osi (presný smer určí ďalší úsek dopredu, úsek bokom ho prevezme).
        if (AXIS_OF_HEADING[heading] !== axis) heading = HEADING_OF_AXIS[axis];
        continue;
      }
      const step = cell - fromCell;
      const horizontal = step === 1 || step === -1;
      const forward = (axis === 0) === horizontal;
      if (forward) heading = horizontal ? (step > 0 ? 90 : 270) : step > 0 ? 180 : 0;
      const pinned = forward ? undefined : heading;
      if (points.length > 0 && step === segmentStep && pinned === segmentHeading) {
        points[points.length - 1] = this.pointAt(cell, pinned, width);
      } else {
        points.push(this.pointAt(cell, pinned, width));
        segmentStep = step;
        segmentHeading = pinned;
      }
    }
    return points;
  }

  /** Stred bunky ako bod trasy, voliteľne s pevným kurzom (úsek bokom). */
  private pointAt(cell: number, heading: Rotation | undefined, width: number): ShipPoint {
    const x = (cell % width) + CELL_CENTER_OFFSET;
    const y = Math.floor(cell / width) + CELL_CENTER_OFFSET;
    return heading === undefined ? { x, y } : { x, y, heading };
  }
}
