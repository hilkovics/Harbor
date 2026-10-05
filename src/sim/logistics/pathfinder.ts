/**
 * Pathfinder — A* nad cestnou sieťou (ARCHITECTURE §7.4; rozhodnutie orchestrátora F3 č. 5).
 *
 * - Uzly sú bunky s `road === 'road'` (row-major index `y * width + x`), hrany vedú k 4 susedom v poradí
 *   `DIRECTIONS_4` (N, E, S, W). `Grid.neighbors4` sa nepoužíva — alokoval by pole pri každej bunke.
 * - **Hrany sú smerové** (ADR-020): krok A → B je povolený len podľa `isRoadStepAllowed` (z jednosmerky len v jej smere,
 *   do jednosmerky nie proti smeru). Bez jednosmeriek je graf symetrický ako vo F3 pred T03-18.
 * - Cena vstupu do bunky dáva `CellCostFn` (predvolene `BASE_CELL_COST` = 1; svet dáva `1 / speedFactor` typu cesty,
 *   ADR-020; F11 pridá penalizáciu kongescie §7.6). Cena musí byť ≥ `BASE_CELL_COST`, inak `RangeError` — heuristika
 *   Manhattan × `BASE_CELL_COST` potom ostáva prípustná aj konzistentná (aj na smerovom grafe), takže uzavretý uzol sa
 *   už nikdy neotvára a prvý výber cieľa je optimálny.
 * - **Deterministický výber** z open setu: menšie `f = g + h`, pri zhode menšie `h` (bližšie k cieľu), potom menší
 *   index bunky. Rovnaký vstup (cesty, `from`, `to`, cena) dá vždy tú istú cestu — nezávisle od histórie volaní,
 *   takže `PathCache` je čisté memo a determinizmus simulácie nezávisí od toho, či cache zasiahla.
 * - **Bez alokácie na volanie** okrem výsledného poľa `findPath`: pracovné polia (`g`, `h`, `f`, rodič, generačné
 *   pečiatky „videný"/„uzavretý", halda s pozíciami) vzniknú raz v konštruktore pre `cellCount` buniek. Nové hľadanie
 *   len zvýši generáciu — hodnoty z minulého hľadania sú neplatné bez mazania polí.
 * - **Nábrežie pod hákom** (F6d, ADR-033 dodatok T6D-02): voliteľné `QuayCells` — bunky kotvísk s odovzdávaním pod hákom, po ktorých smie
 *   ísť vozidlo k žeriavu. Uzlom grafu je bunka nábrežia len v hľadaní, ktorého **začiatok alebo koniec** leží v nábreží toho istého kotviska
 *   (`owners[from]` / `owners[to]`); hľadanie medzi dvoma cestnými bunkami nábrežím nikdy neprejde, takže cestná sieť (kamióny, vozidlá mimo
 *   háku) sa nespája cez nábrežie a bez nábrežia je A* bitovo zhodný s F3–F6c.
 * - Cesta sa neukladá do sveta ani do save; pri zmene ciest ju treba hľadať znova (`PathCache` a `DistanceMatrix`
 *   sa zneplatnia podľa `World.roadVersion`).
 */
import { DIRECTIONS_4, type Cell } from '../grid/grid';
import { isRoadStepAllowed } from '../grid/road-direction';
import { IndexedBinaryHeap } from './binary-heap';

/** Časť mriežky, ktorú A* číta (`Grid` ju spĺňa); mriežka sa počas hľadania nemení. */
export interface RoadGraph {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  atIndex(index: number): Readonly<Cell>;
}

/**
 * Nábrežie kotvísk pod hákom (F6d): `owners()` = pole podľa indexu bunky — id kotviska, ktorého nábrežie bunku tvorí, inak 0. Pole smie
 * zdroj pri volaní obnoviť (zmena modulov); A* ho číta počas jedného hľadania a nemení ho.
 */
export interface QuayCells {
  owners(): Readonly<Int32Array>;
}

/** Cena vstupu do bunky s daným indexom; musí byť ≥ `BASE_CELL_COST` (volá sa len pre cestné bunky). */
export type CellCostFn = (index: number) => number;

/** Základná cena vstupu do cestnej bunky (§7.4 „cena bunky 1 + congestionPenalty") a najmenšia povolená cena. */
export const BASE_CELL_COST = 1;

/** Cena bez penalizácie kongescie (F3): každá cestná bunka stojí `BASE_CELL_COST`. */
export const unitCellCost: CellCostFn = () => BASE_CELL_COST;

/** Diagnostika pre testy a ladenie výkonu (čísla, nie referencie na pracovné polia). */
export interface PathfinderDiagnostics {
  /** Počet buniek, pre ktoré sú pracovné polia (= `cellCount` mriežky). */
  readonly capacity: number;
  /** Počet hľadaní od vytvorenia (`findPath` + `findCost`). */
  readonly searches: number;
  /** Koľkokrát vznikli pracovné polia — po konštruktore 1 a viac nikdy (znovupoužitie bufferov). */
  readonly bufferAllocations: number;
  /** Počet uzavretých (expandovaných) buniek pri poslednom hľadaní. */
  readonly lastExpanded: number;
}

/** Rodič štartovej bunky (koniec rekonštrukcie cesty). */
const NO_PARENT = -1;

/** Žiadna zakázaná bunka (`findPathAvoiding`). */
const NO_AVOIDED = -1;

/** Pečiatka „nikdy" — generácia hľadania začína od 1. */
const NEVER = 0;

/** Najvyššia generácia pred vynulovaním pečiatok (hranica `Int32Array`). */
const MAX_GENERATION = 0x7fffffff;

/** Index bunky je celé číslo `0 … cellCount − 1`, inak `RangeError` (chyba volajúceho, nie „bez cesty"). */
export function assertCellIndex(index: number, cellCount: number, caller: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= cellCount) {
    throw new RangeError(`${caller}: index bunky musí byť celé číslo 0…${String(cellCount - 1)}, dostal ${String(index)}`);
  }
}

export class Pathfinder {
  private readonly grid: RoadGraph;
  private readonly cellCost: CellCostFn;
  private readonly g: Float64Array;
  private readonly h: Float64Array;
  private readonly f: Float64Array;
  private readonly parent: Int32Array;
  private readonly seen: Int32Array;
  private readonly closed: Int32Array;
  private readonly open: IndexedBinaryHeap;
  private readonly quay: QuayCells | undefined;
  private avoided = NO_AVOIDED;
  private generation = NEVER;
  private searchCount = 0;
  private expanded = 0;
  private allocations = 0;

  /**
   * @param grid mriežka (rozmery sa nemenia; cesty áno — hľadanie číta aktuálny stav)
   * @param cellCost cena vstupu do cestnej bunky (predvolene `unitCellCost`)
   * @param quay nábrežie kotvísk pod hákom (F6d; viď hlavička súboru); bez neho sú uzlami len cestné bunky
   */
  constructor(grid: RoadGraph, cellCost: CellCostFn = unitCellCost, quay?: QuayCells) {
    this.grid = grid;
    this.cellCost = cellCost;
    this.quay = quay;
    const n = grid.cellCount;
    this.g = new Float64Array(n);
    this.h = new Float64Array(n);
    this.f = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.closed = new Int32Array(n);
    const { f, h } = this;
    this.open = new IndexedBinaryHeap(n, (a, b) => f[a] < f[b] || (f[a] === f[b] && (h[a] < h[b] || (h[a] === h[b] && a < b))));
    this.allocations += 1;
  }

  /** Počet buniek mriežky (platné indexy `0 … cellCount − 1`). */
  get cellCount(): number {
    return this.grid.cellCount;
  }

  /** Je bunka cestná (uzol grafu)? Index mimo mriežky → `RangeError`. */
  isRoadCell(index: number): boolean {
    assertCellIndex(index, this.grid.cellCount, 'Pathfinder.isRoadCell');
    return this.grid.atIndex(index).road === 'road';
  }

  /**
   * Najlacnejšia cesta z `from` do `to` po cestných bunkách: indexy buniek v poradí jazdy vrátane `from` aj `to`
   * (zmrazené pole), `from === to` na ceste → `[from]`. Bez cesty (niektorá z buniek nie je cestná alebo nie sú
   * spojené) → `null`. Index mimo mriežky → `RangeError`. Jediná alokácia je výsledné pole.
   */
  findPath(from: number, to: number): readonly number[] | null {
    if (!this.search(from, to, 'Pathfinder.findPath')) return null;
    let length = 0;
    for (let at = to; at !== NO_PARENT; at = this.parent[at]) length += 1;
    const path = new Array<number>(length);
    let i = length;
    for (let at = to; at !== NO_PARENT; at = this.parent[at]) {
      i -= 1;
      path[i] = at;
    }
    return Object.freeze(path);
  }

  /**
   * Najlacnejšia cesta z `from` do `to`, ktorá nevedie cez bunku `avoid` (ADR-037, preplánovanie pri zápche): ako
   * `findPath`, ale bunka `avoid` nie je uzol grafu — ak je cieľom, cesta neexistuje. Výsledok nepatrí do `PathCache`
   * (kľúč cache nepozná zakázanú bunku). Bez `avoid` v inom volaní je A* bitovo zhodný s `findPath`.
   */
  findPathAvoiding(from: number, to: number, avoid: number): readonly number[] | null {
    this.avoided = avoid;
    try {
      return this.findPath(from, to);
    } finally {
      this.avoided = NO_AVOIDED;
    }
  }

  /**
   * Cena najlacnejšej cesty z `from` do `to` (súčet cien vstupu do buniek po `from`; pri `unitCellCost` = počet
   * krokov = dĺžka `findPath` − 1), `from === to` na ceste → 0, bez cesty → `Infinity`. Bez alokácie.
   */
  findCost(from: number, to: number): number {
    return this.search(from, to, 'Pathfinder.findCost') ? this.g[to] : Infinity;
  }

  /**
   * Cena danej cesty (napr. z `findPath`/`PathCache`): súčet cien vstupu do buniek po prvej, v poradí jazdy — tá istá
   * postupnosť sčítaní ako `g` v A*, takže pre cestu z `findPath(from, to)` je výsledok bitovo rovný `findCost(from, to)`.
   * Prázdna alebo jednoprvková cesta → 0. Susednosť ani smery nekontroluje. Bez alokácie.
   */
  routeCost(path: readonly number[]): number {
    let cost = 0;
    for (let i = 1; i < path.length; i++) {
      assertCellIndex(path[i], this.grid.cellCount, 'Pathfinder.routeCost');
      cost += this.stepCost(path[i]);
    }
    return cost;
  }

  /** Diagnostika (nová kópia čísel pri každom volaní — nie pre hot path). */
  diagnostics(): PathfinderDiagnostics {
    return { capacity: this.grid.cellCount, searches: this.searchCount, bufferAllocations: this.allocations, lastExpanded: this.expanded };
  }

  /** A* z `from` do `to`; `true` = cieľ uzavretý (`g[to]` a rodičia platia v aktuálnej generácii). */
  private search(from: number, to: number, caller: string): boolean {
    const { width, height, cellCount } = this.grid;
    assertCellIndex(from, cellCount, caller);
    assertCellIndex(to, cellCount, caller);
    this.searchCount += 1;
    this.expanded = 0;
    // Nábrežie (F6d): bunky kotviska, v ktorého nábreží leží začiatok alebo koniec hľadania (0 = žiadne).
    const owners = this.quay?.owners();
    const quayFrom = owners === undefined ? 0 : owners[from];
    const quayTo = owners === undefined ? 0 : owners[to];
    if (!(this.isRoad(from) || quayFrom !== 0) || !(this.isRoad(to) || quayTo !== 0)) return false;

    const generation = this.nextGeneration();
    const { g, h, f, parent, seen, closed, open } = this;
    const toX = to % width;
    const toY = (to - toX) / width;
    open.clear();
    seen[from] = generation;
    g[from] = 0;
    h[from] = this.heuristic(from % width, (from - (from % width)) / width, toX, toY);
    f[from] = h[from];
    parent[from] = NO_PARENT;
    open.push(from);

    while (!open.isEmpty()) {
      const current = open.pop();
      closed[current] = generation;
      if (current === to) return true;
      this.expanded += 1;
      const x = current % width;
      const y = (current - x) / width;
      const currentCell = this.grid.atIndex(current);
      for (let k = 0; k < DIRECTIONS_4.length; k++) {
        const direction = DIRECTIONS_4[k];
        const nx = x + direction.dx;
        const ny = y + direction.dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (closed[next] === generation || next === this.avoided) continue;
        const nextCell = this.grid.atIndex(next);
        if (nextCell.road !== 'road' && (owners === undefined || owners[next] === 0 || (owners[next] !== quayFrom && owners[next] !== quayTo))) continue;
        if (!isRoadStepAllowed(currentCell, nextCell, direction.name)) continue;
        const tentative = g[current] + this.stepCost(next);
        if (seen[next] !== generation) {
          seen[next] = generation;
          g[next] = tentative;
          h[next] = this.heuristic(nx, ny, toX, toY);
          f[next] = tentative + h[next];
          parent[next] = current;
          open.push(next);
        } else if (tentative < g[next]) {
          // Pri rovnakej cene ostáva prvý nájdený rodič — poradie expanzie je deterministické.
          g[next] = tentative;
          f[next] = tentative + h[next];
          parent[next] = current;
          open.decreaseKey(next);
        }
      }
    }
    return false;
  }

  private isRoad(index: number): boolean {
    return this.grid.atIndex(index).road === 'road';
  }

  /** Manhattan × najmenšia cena bunky — prípustná a konzistentná pri cene ≥ `BASE_CELL_COST`. */
  private heuristic(x: number, y: number, toX: number, toY: number): number {
    return (Math.abs(x - toX) + Math.abs(y - toY)) * BASE_CELL_COST;
  }

  private stepCost(index: number): number {
    const cost = this.cellCost(index);
    if (!(cost >= BASE_CELL_COST) || cost === Infinity) {
      throw new RangeError(`Pathfinder: cena bunky ${String(index)} musí byť konečné číslo ≥ ${String(BASE_CELL_COST)}, dostal ${String(cost)}`);
    }
    return cost;
  }

  /** Nová generácia pečiatok; po `MAX_GENERATION` hľadaniach sa pečiatky vynulujú (`fill`, bez alokácie). */
  private nextGeneration(): number {
    if (this.generation === MAX_GENERATION) {
      this.seen.fill(NEVER);
      this.closed.fill(NEVER);
      this.generation = NEVER;
    }
    this.generation += 1;
    return this.generation;
  }
}
