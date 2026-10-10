// Pathfinder (T03-03, ARCHITECTURE §7.4, rozhodnutie orchestrátora F3 č. 5): A* po cestných bunkách — najkratšia cesta
// na známom bludisku, bez cesty null, deterministický tie-break (f, potom h, potom index), cena bunky (príprava F11),
// zhoda s nezávislým BFS, determinizmus nezávislý od histórie, znovupoužitie bufferov a výkon.
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/core';
import { BASE_CELL_COST, Pathfinder } from '@sim/logistics';
import { bfsDistance, gridWith, pathProblem, randomRoadGrid, roadCells, roadGrid, serpentineGrid } from './road-fixtures';

/**
 * Bludisko s jedinou cestou S (0,0) → T (6,4): odbočka doprava z (2,2) končí slepo na (6,1), takže A* musí ísť
 * doľava a dole (14 krokov).
 */
const MAZE = [
  '...#...', // y0
  '##.#.#.', // y1
  '.....##', // y2
  '.######', // y3
  '.......', // y4
];
const MAZE_WIDTH = MAZE[0].length;
const at = (x: number, y: number, width = MAZE_WIDTH): number => y * width + x;

describe('Pathfinder.findPath — známe bludisko', () => {
  const grid = roadGrid(MAZE);
  const pathfinder = new Pathfinder(grid);

  it('najkratšia cesta S → T: presné bunky, dĺžka 15 (14 krokov), obe koncové bunky v ceste', () => {
    const path = pathfinder.findPath(at(0, 0), at(6, 4));
    const expected = [
      [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 3],
      [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4],
    ].map(([x, y]) => at(x, y));
    expect(path).toEqual(expected);
    expect(pathfinder.findCost(at(0, 0), at(6, 4))).toBe(14);
    expect(bfsDistance(grid, at(0, 0), at(6, 4))).toBe(14);
  });

  it('cesta do slepej odbočky a späť (T → koniec odbočky (6,1)) je platná a najkratšia', () => {
    const path = pathfinder.findPath(at(6, 4), at(6, 1));
    expect(path).not.toBeNull();
    expect(pathProblem(grid, path ?? [], at(6, 4), at(6, 1))).toBeNull();
    expect((path ?? []).length - 1).toBe(bfsDistance(grid, at(6, 4), at(6, 1)));
  });

  it('výsledok je zmrazené pole (cache ho zdieľa medzi vozidlami)', () => {
    const path = pathfinder.findPath(at(0, 0), at(6, 4));
    expect(Object.isFrozen(path)).toBe(true);
  });
});

describe('Pathfinder — bez cesty a hraničné prípady', () => {
  it('nespojené ostrovy ciest → null a findCost Infinity', () => {
    const grid = roadGrid(['..#..', '..#..']);
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.findPath(at(0, 0, 5), at(4, 1, 5))).toBeNull();
    expect(pathfinder.findCost(at(0, 0, 5), at(4, 1, 5))).toBe(Infinity);
  });

  it('štart alebo cieľ bez cesty → null (aj keď susedí s cestou)', () => {
    const grid = roadGrid(['.#.', '...']);
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.isRoadCell(1)).toBe(false);
    expect(pathfinder.findPath(1, 0)).toBeNull();
    expect(pathfinder.findPath(0, 1)).toBeNull();
    expect(pathfinder.findCost(0, 1)).toBe(Infinity);
  });

  it('from === to: na ceste [from] a cena 0, bez cesty null', () => {
    const grid = roadGrid(['.#']);
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.findPath(0, 0)).toEqual([0]);
    expect(pathfinder.findCost(0, 0)).toBe(0);
    expect(pathfinder.findPath(1, 1)).toBeNull();
    expect(pathfinder.findCost(1, 1)).toBe(Infinity);
  });

  it('index mimo mriežky alebo necelý → RangeError (chyba volajúceho, nie „bez cesty")', () => {
    const pathfinder = new Pathfinder(roadGrid(['...']));
    expect(pathfinder.cellCount).toBe(3);
    for (const [from, to] of [[-1, 0], [0, 3], [0.5, 1], [0, Number.NaN]]) {
      expect(() => pathfinder.findPath(from, to)).toThrow(RangeError);
      expect(() => pathfinder.findCost(from, to)).toThrow(RangeError);
    }
    expect(() => pathfinder.isRoadCell(3)).toThrow(RangeError);
  });

  it('číta aktuálne cesty mriežky: pridaná bunka spojí ostrovy, odobratá ich rozpojí', () => {
    const grid = roadGrid(['..#..']);
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.findPath(0, 4)).toBeNull();
    grid.at(2, 0).road = 'road';
    expect(pathfinder.findPath(0, 4)).toEqual([0, 1, 2, 3, 4]);
    grid.at(3, 0).road = 'rail'; // koľaj nie je cesta
    expect(pathfinder.findPath(0, 4)).toBeNull();
  });
});

describe('Pathfinder — deterministický tie-break (menšie f, potom menšie h, potom menší index)', () => {
  const open3 = (): Pathfinder => new Pathfinder(gridWith(3, 3, () => true));

  it('3×3 bez prekážok (0,0) → (2,2): najprv na východ, potom na juh', () => {
    // f je všade 4; menšie h ťahá k cieľu, pri rovnakom h vyhrá menší index ((1,0) = 1 pred (0,1) = 3).
    expect(open3().findPath(0, 8)).toEqual([0, 1, 2, 5, 8]);
  });

  it('3×3 bez prekážok (2,2) → (0,0): najprv na sever, potom na západ', () => {
    expect(open3().findPath(8, 0)).toEqual([8, 5, 2, 1, 0]);
  });
});

describe('Pathfinder — cena bunky (API pre penalizáciu kongescie F11)', () => {
  const grid = gridWith(5, 3, () => true);
  const from = at(0, 1, 5);
  const to = at(4, 1, 5);
  const middle = at(2, 1, 5);

  it('predvolená cena BASE_CELL_COST = 1: priama cesta, cena = počet krokov', () => {
    expect(BASE_CELL_COST).toBe(1);
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.findPath(from, to)).toEqual([5, 6, 7, 8, 9]);
    expect(pathfinder.findCost(from, to)).toBe(4);
  });

  it('drahá bunka v strede → obchádzka s cenou 6 namiesto 4 + 9', () => {
    const pathfinder = new Pathfinder(grid, (index) => (index === middle ? 10 : BASE_CELL_COST));
    const path = pathfinder.findPath(from, to) ?? [];
    expect(path).not.toContain(middle);
    expect(pathProblem(grid, path, from, to)).toBeNull();
    expect(path.length - 1).toBe(6);
    expect(pathfinder.findCost(from, to)).toBe(6);
  });

  it('cena < BASE_CELL_COST, NaN alebo Infinity → RangeError (heuristika by prestala byť prípustná)', () => {
    for (const cost of [0.5, 0, -1, Number.NaN, Infinity]) {
      const pathfinder = new Pathfinder(grid, () => cost);
      expect(() => pathfinder.findPath(from, to), `cena ${String(cost)}`).toThrow(RangeError);
    }
  });
});

describe('Pathfinder — zhoda s nezávislým BFS na náhodných mriežkach', () => {
  it.each([
    { seed: 11, density: 0.55 },
    { seed: 12, density: 0.7 },
    { seed: 13, density: 0.85 },
  ])('seed $seed, hustota $density: 300 dvojíc — null ⇔ BFS nedosiahne, inak platná cesta dĺžky BFS', ({ seed, density }) => {
    const grid = randomRoadGrid(30, 20, density, seed);
    const cells = roadCells(grid);
    const pathfinder = new Pathfinder(grid);
    const rng = new Rng(seed);
    for (let i = 0; i < 300; i++) {
      const from = rng.pick(cells);
      const to = rng.pick(cells);
      const expected = bfsDistance(grid, from, to);
      const path = pathfinder.findPath(from, to);
      if (expected === Infinity) {
        expect(path, `${String(from)} → ${String(to)}`).toBeNull();
      } else {
        expect(path, `${String(from)} → ${String(to)}`).not.toBeNull();
        expect(pathProblem(grid, path ?? [], from, to)).toBeNull();
        expect((path ?? []).length - 1).toBe(expected);
      }
      expect(pathfinder.findCost(from, to)).toBe(expected);
    }
  });
});

describe('Pathfinder — determinizmus a znovupoužitie bufferov', () => {
  const grid = randomRoadGrid(40, 30, 0.7, 99);
  const cells = roadCells(grid);
  const rng = new Rng(4242);
  const queries = Array.from({ length: 200 }, () => [rng.pick(cells), rng.pick(cells)] as const);

  it('dve inštancie aj opačné poradie dotazov dajú rovnaké cesty (výsledok nezávisí od histórie volaní)', () => {
    const a = new Pathfinder(grid);
    const b = new Pathfinder(grid);
    const forward = queries.map(([from, to]) => a.findPath(from, to));
    const backward = [...queries].reverse().map(([from, to]) => b.findPath(from, to)).reverse();
    expect(backward).toEqual(forward);
    expect(queries.map(([from, to]) => a.findPath(from, to))).toEqual(forward);
  });

  it('pracovné polia vzniknú raz: po 1 000 hľadaniach bufferAllocations = 1, capacity = cellCount', () => {
    const pathfinder = new Pathfinder(grid);
    expect(pathfinder.diagnostics()).toEqual({ capacity: grid.cellCount, searches: 0, bufferAllocations: 1, lastExpanded: 0 });
    for (let i = 0; i < 1000; i++) {
      const [from, to] = queries[i % queries.length];
      if (i % 2 === 0) pathfinder.findPath(from, to);
      else pathfinder.findCost(from, to);
    }
    const diagnostics = pathfinder.diagnostics();
    expect(diagnostics.searches).toBe(1000);
    expect(diagnostics.bufferAllocations).toBe(1);
    expect(diagnostics.capacity).toBe(grid.cellCount);
  });

  it('lastExpanded: A* s Manhattan heuristikou na priamke neexpanduje nič mimo cesty', () => {
    const line = new Pathfinder(gridWith(20, 5, () => true));
    line.findPath(40, 59); // (0,2) → (19,2)
    expect(line.diagnostics().lastExpanded).toBe(19);
  });
});

/**
 * Výkon: 1 000 hľadaní (`findPath` s výsledným poľom) na mriežke 96×64 (rozmer harbor_01). Namerané pri T03-03
 * (Node 22, vývojový kontajner): hadovité bludisko ~0,15 s (priemerne ~1 500 expanzií na hľadanie), náhodná sieť
 * 65 % ~0,18 s, otvorená sieť ~0,02 s. Limit 4 s je zámerne ~20× nad tým, aby test nebol krehký na pomalom
 * alebo vyťaženom CI — stráži rádový regres (alokácie v cykle, lineárna namiesto binárnej haldy, opakované
 * otváranie uzlov), nie milisekundy.
 */
const PERF_SEARCHES = 1000;
const PERF_LIMIT_MS = 4000;

describe('Pathfinder — výkon (1 000 hľadaní na 96×64)', () => {
  it.each([
    { name: 'hadovité bludisko (dlhé cesty, najviac expanzií)', grid: serpentineGrid(96, 64) },
    { name: 'otvorená sieť (všetko cesta)', grid: gridWith(96, 64, () => true) },
    { name: 'náhodná sieť 65 %', grid: randomRoadGrid(96, 64, 0.65, 2026) },
  ])(`$name do ${String(PERF_LIMIT_MS)} ms`, ({ grid }) => {
    const cells = roadCells(grid);
    const rng = new Rng(96_64);
    const pairs = Array.from({ length: PERF_SEARCHES }, () => [rng.pick(cells), rng.pick(cells)] as const);
    const pathfinder = new Pathfinder(grid);
    pathfinder.findPath(pairs[0][0], pairs[0][1]); // zahriatie JIT
    const start = performance.now();
    let found = 0;
    for (const [from, to] of pairs) if (pathfinder.findPath(from, to) !== null) found += 1;
    const elapsed = performance.now() - start;
    expect(found).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(PERF_LIMIT_MS);
  });
});

describe('Pathfinder.findPathAvoiding — A* s dočasne zakázanou bunkou (preplánovanie pri zápche, ADR-037)', () => {
  // Kruh 3 × 3 s obvodom ciest: z (0,0) do (2,0) vedie rovno cez (1,0), alebo dookola cez (0,1), (0,2), (1,2), (2,2), (2,1).
  const RING = ['...', '.#.', '...'];
  const grid = roadGrid(RING);
  const pathfinder = new Pathfinder(grid);

  it('bez zakázanej bunky ide najkratšou cestou, so zakázanou prostrednou bunkou obchádzkou; cieľ sa nemení', () => {
    expect(pathfinder.findPath(at(0, 0, 3), at(2, 0, 3))).toEqual([at(0, 0, 3), at(1, 0, 3), at(2, 0, 3)]);
    const around = pathfinder.findPathAvoiding(at(0, 0, 3), at(2, 0, 3), at(1, 0, 3));
    expect(around).toEqual([[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0]].map(([x, y]) => at(x, y, 3)));
  });

  it('zakázaný je aj cieľ → bez cesty; po volaní je zákaz zrušený (ďalšie findPath je bitovo ako predtým)', () => {
    expect(pathfinder.findPathAvoiding(at(0, 0, 3), at(2, 0, 3), at(2, 0, 3))).toBeNull();
    expect(pathfinder.findPath(at(0, 0, 3), at(2, 0, 3))).toEqual([at(0, 0, 3), at(1, 0, 3), at(2, 0, 3)]);
  });

  it('bez obchádzky (jediná cesta vedie cez zakázanú bunku) → null', () => {
    const line = new Pathfinder(roadGrid(['....']));
    expect(line.findPathAvoiding(0, 3, 1)).toBeNull();
  });
});
