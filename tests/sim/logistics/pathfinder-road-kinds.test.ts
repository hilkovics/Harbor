// Pathfinder s typmi ciest (T03-18, ADR-020): smerové hrany jednosmeriek (protismer → obchádzka alebo null, vjazd zboku),
// cena bunky 1 / speedFactor (A* obíde jednopruhovú cestu pri rovnako dlhej dvojpruhovej, vyberie najlacnejšiu, nie
// najkratšiu cestu), routeCost = findCost bitovo, optimálnosť voči nezávislému Dijkstrovi na náhodných sieťach
// a RoadSpeeds (faktor a cena podľa typu bunky).
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/core';
import { DEFS } from '../world/world-fixtures';
import { DIRECTIONS_4, DIRECTION_NAMES, ROAD_KINDS, isRoadStepAllowed, type Direction4Name, type Grid, type RoadKind } from '@sim/grid';
import { BASE_CELL_COST, Pathfinder, RoadSpeeds, UNIT_SPEED_FACTOR } from '@sim/logistics';
import { gridWith, roadGrid } from './road-fixtures';

const KINDS = DEFS.infrastructure.roadKinds;

function setKind(grid: Grid, cells: readonly (readonly [number, number])[], kind: RoadKind, dir: Direction4Name | null = null): void {
  for (const [x, y] of cells) {
    const cell = grid.at(x, y);
    cell.roadKind = kind;
    cell.roadDir = dir;
  }
}

/** Pathfinder s cenou podľa typu cesty z bundled defov (ako vo svete). */
function worldLikePathfinder(grid: Grid): Pathfinder {
  return new Pathfinder(grid, new RoadSpeeds(grid, KINDS).cellCost);
}

/**
 * Okruh 5 × 3: horný riadok y0 a dolný y2 celé cestou, stĺpce x0 a x4 spájajú na y1.
 * ```
 * .....
 * .###.
 * .....
 * ```
 */
const LOOP = ['.....', '.###.', '.....'];
const W = LOOP[0].length;
const at = (x: number, y: number): number => y * W + x;
const coords = (path: readonly number[] | null): [number, number][] => (path ?? []).map((i) => [i % W, Math.floor(i / W)]);

describe('Pathfinder — jednosmerky (smerové hrany)', () => {
  it('rovná jednosmerka: po smere cesta, proti smeru null', () => {
    const grid = roadGrid(['.....']);
    setKind(grid, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], 'one_way', 'E');
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.findPath(0, 4)).toEqual([0, 1, 2, 3, 4]);
    expect(pathfinder.findPath(4, 0)).toBeNull();
    expect(pathfinder.findCost(4, 0)).toBe(Infinity);
    expect(pathfinder.findPath(2, 2)).toEqual([2]);
  });

  it('protismer na okruhu → obchádzka druhou stranou (10 krokov namiesto 2)', () => {
    const grid = roadGrid(LOOP);
    setKind(grid, [[1, 0], [2, 0], [3, 0]], 'one_way', 'E');
    const pathfinder = new Pathfinder(grid);
    expect(coords(pathfinder.findPath(at(3, 0), at(1, 0)))).toEqual([
      [3, 0], [4, 0], [4, 1], [4, 2], [3, 2], [2, 2], [1, 2], [0, 2], [0, 1], [0, 0], [1, 0],
    ]);
    expect(pathfinder.findCost(at(3, 0), at(1, 0))).toBe(10);
    expect(coords(pathfinder.findPath(at(1, 0), at(3, 0)))).toEqual([[1, 0], [2, 0], [3, 0]]);
  });

  it('do jednosmerky sa smie vojsť zboku, nie proti smeru; z nej len v jej smere', () => {
    // Kríž: stred (1,1) je jednosmerka na juh.
    //  #.#   y0
    //  ...   y1
    //  #.#   y2
    const grid = roadGrid(['#.#', '...', '#.#']);
    setKind(grid, [[1, 1]], 'one_way', 'S');
    const w = 3;
    const cell = (x: number, y: number): number => y * w + x;
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.findPath(cell(0, 1), cell(1, 2))).toEqual([cell(0, 1), cell(1, 1), cell(1, 2)]); // zboku, von v smere
    expect(pathfinder.findPath(cell(1, 0), cell(1, 2))).toEqual([cell(1, 0), cell(1, 1), cell(1, 2)]); // po smere
    expect(pathfinder.findPath(cell(0, 1), cell(2, 1))).toBeNull(); // von zo stredu len na juh
    expect(pathfinder.findPath(cell(1, 2), cell(1, 0))).toBeNull(); // vjazd proti smeru
    expect(pathfinder.findPath(cell(1, 2), cell(1, 1))).toBeNull();
  });
});

describe('Pathfinder — cena 1 / speedFactor (ADR-020)', () => {
  it('rovnako dlhé cesty: A* obíde jednopruhovú a vyberie dvojpruhovú (obe strany okruhu)', () => {
    const top = roadGrid(LOOP);
    setKind(top, [[1, 0], [2, 0], [3, 0], [4, 0]], 'one_lane');
    expect(coords(worldLikePathfinder(top).findPath(at(0, 0), at(4, 2)))).toEqual([[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2]]);
    expect(worldLikePathfinder(top).findCost(at(0, 0), at(4, 2))).toBe(6);

    const bottom = roadGrid(LOOP);
    setKind(bottom, [[0, 1], [0, 2], [1, 2], [2, 2], [3, 2]], 'one_lane');
    expect(coords(worldLikePathfinder(bottom).findPath(at(0, 0), at(4, 2)))).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2]]);
  });

  it('vyberá najlacnejšiu, nie najkratšiu cestu (jednopruhová spojka vs. obchádzka o 2 bunky)', () => {
    // Dva riadky 7 × 2 celé cestou; A (0,0) → B (6,0). Priamo = spojka v y0, obchádzka = dole, y1, hore (8 krokov).
    const slow = (count: number): Grid => {
      const grid = roadGrid(['.......', '.......']);
      setKind(grid, Array.from({ length: count }, (_, i) => [1 + i, 0] as const), 'one_lane');
      return grid;
    };
    const factor = KINDS.one_lane.speedFactor;
    // 4 jednopruhové bunky: 4 / 0,7 + 2 ≈ 7,71 < 8 → priamo (kratšia aj lacnejšia).
    const four = worldLikePathfinder(slow(4));
    expect(four.findPath(0, 6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(four.findCost(0, 6)).toBeCloseTo(4 / factor + 2, 12);
    // 5 jednopruhových buniek: 5 / 0,7 + 1 ≈ 8,14 > 8 → obchádzka (dlhšia, ale lacnejšia).
    const five = worldLikePathfinder(slow(5));
    const w = 7;
    expect(five.findPath(0, 6)).toEqual([0, ...Array.from({ length: 7 }, (_, x) => w + x), 6]);
    expect(five.findCost(0, 6)).toBe(8);
  });

  it('dvojpruhová sieť: cena = počet krokov (bitovo ako unitCellCost)', () => {
    const grid = roadGrid(LOOP);
    const unit = new Pathfinder(grid);
    const priced = worldLikePathfinder(grid);
    for (let from = 0; from < grid.cellCount; from++) {
      for (let to = 0; to < grid.cellCount; to++) {
        expect(priced.findPath(from, to)).toEqual(unit.findPath(from, to));
        expect(priced.findCost(from, to)).toBe(unit.findCost(from, to));
      }
    }
  });

  it('routeCost(findPath) === findCost bitovo; prázdna a jednoprvková cesta 0', () => {
    const grid = randomKindGrid(24, 16, 0.7, 77);
    const pathfinder = worldLikePathfinder(grid);
    const rng = new Rng(78);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const from = rng.int(0, grid.cellCount - 1);
      const to = rng.int(0, grid.cellCount - 1);
      const path = pathfinder.findPath(from, to);
      if (path === null) continue;
      expect(Object.is(pathfinder.routeCost(path), pathfinder.findCost(from, to))).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
    expect(pathfinder.routeCost([])).toBe(0);
    expect(pathfinder.routeCost([3])).toBe(0);
  });
});

/** Náhodná sieť s náhodnými typmi a smermi (deterministický `Rng`). */
function randomKindGrid(width: number, height: number, density: number, seed: number): Grid {
  const rng = new Rng(seed);
  const grid = gridWith(width, height, () => rng.next() < density);
  for (let i = 0; i < grid.cellCount; i++) {
    const cell = grid.atIndex(i);
    if (cell.road !== 'road') continue;
    cell.roadKind = ROAD_KINDS[rng.int(0, ROAD_KINDS.length - 1)];
    cell.roadDir = cell.roadKind === 'one_way' ? DIRECTION_NAMES[rng.int(0, DIRECTION_NAMES.length - 1)] : null;
  }
  return grid;
}

/** Nezávislý Dijkstra po smerových hranách s cenou podľa typu (referencia, O(n²), bez haldy). */
function dijkstraCost(grid: Grid, from: number, to: number): number {
  const speeds = new RoadSpeeds(grid, KINDS);
  if (grid.atIndex(from).road !== 'road' || grid.atIndex(to).road !== 'road') return Infinity;
  const dist = new Array<number>(grid.cellCount).fill(Infinity);
  const done = new Array<boolean>(grid.cellCount).fill(false);
  dist[from] = 0;
  for (;;) {
    let current = -1;
    for (let i = 0; i < grid.cellCount; i++) if (!done[i] && dist[i] < Infinity && (current < 0 || dist[i] < dist[current])) current = i;
    if (current < 0) return Infinity;
    if (current === to) return dist[to];
    done[current] = true;
    const { x, y } = grid.coordOf(current);
    for (const { dx, dy, name } of DIRECTIONS_4) {
      if (!grid.inBounds(x + dx, y + dy)) continue;
      const next = grid.index(x + dx, y + dy);
      const cell = grid.atIndex(next);
      if (cell.road !== 'road' || !isRoadStepAllowed(grid.atIndex(current), cell, name)) continue;
      dist[next] = Math.min(dist[next], dist[current] + speeds.cellCost(next));
    }
  }
}

describe('Pathfinder — optimálnosť na náhodných sieťach s typmi a jednosmerkami', () => {
  it('cena A* = cena Dijkstru (na 1e-9), dosiahnuteľnosť zhodná; cesta dodrží smery', () => {
    const grid = randomKindGrid(16, 12, 0.72, 2026);
    const pathfinder = worldLikePathfinder(grid);
    const rng = new Rng(9);
    for (let i = 0; i < 150; i++) {
      const from = rng.int(0, grid.cellCount - 1);
      const to = rng.int(0, grid.cellCount - 1);
      const expected = dijkstraCost(grid, from, to);
      const cost = pathfinder.findCost(from, to);
      if (expected === Infinity) {
        expect(cost).toBe(Infinity);
        continue;
      }
      expect(cost).toBeCloseTo(expected, 9);
      const path = pathfinder.findPath(from, to) ?? [];
      for (let k = 1; k < path.length; k++) {
        const a = grid.coordOf(path[k - 1]);
        const b = grid.coordOf(path[k]);
        const direction = DIRECTIONS_4.find((d) => d.dx === b.x - a.x && d.dy === b.y - a.y);
        expect(direction).toBeDefined();
        expect(isRoadStepAllowed(grid.atIndex(path[k - 1]), grid.atIndex(path[k]), direction?.name ?? 'N')).toBe(true);
      }
    }
  });
});

describe('RoadSpeeds', () => {
  it('faktor a cena podľa aktuálneho typu bunky (prestavba sa prejaví hneď)', () => {
    const grid = roadGrid(['...']);
    const speeds = new RoadSpeeds(grid, KINDS);
    expect([speeds.speedFactor(1), speeds.cellCost(1)]).toEqual([1, BASE_CELL_COST]);
    setKind(grid, [[1, 0]], 'one_lane');
    expect(speeds.speedFactor(1)).toBe(KINDS.one_lane.speedFactor);
    expect(speeds.cellCost(1)).toBe(BASE_CELL_COST / KINDS.one_lane.speedFactor);
    setKind(grid, [[1, 0]], 'one_way', 'E');
    expect([speeds.speedFactor(1), speeds.cellCost(1)]).toEqual([KINDS.one_way.speedFactor, BASE_CELL_COST / KINDS.one_way.speedFactor]);
  });

  it.each([0, -0.5, 1.5, Number.NaN])('speedFactor %s mimo (0, 1] → RangeError', (factor) => {
    const grid = roadGrid(['.']);
    expect(() => new RoadSpeeds(grid, { ...KINDS, one_lane: { costPerCellCents: 1, speedFactor: factor } })).toThrow(RangeError);
  });

  it('UNIT_SPEED_FACTOR = 1 pre každú bunku', () => {
    expect(UNIT_SPEED_FACTOR(0)).toBe(1);
    expect(UNIT_SPEED_FACTOR(12345)).toBe(1);
  });
});
