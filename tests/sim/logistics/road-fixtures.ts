// Pomôcky testov pathfindingu (T03-03): mriežka z ASCII bludiska, nezávislé BFS a kontrola platnosti cesty.
import { Rng } from '@sim/core';
import { DIRECTIONS_4, Grid } from '@sim/grid';

/** Znak cestnej bunky v ASCII bludisku; všetko ostatné je pevnina bez cesty. */
export const ROAD_CHAR = '.';

/** Mriežka z riadkov bludiska: `.` = cesta, iný znak = pevnina bez cesty. Všetky riadky musia mať rovnakú dĺžku. */
export function roadGrid(rows: readonly string[]): Grid {
  const width = rows[0].length;
  if (rows.some((row) => row.length !== width)) throw new Error('roadGrid: riadky majú rôznu dĺžku');
  const grid = new Grid(width, rows.length, () => ({ terrain: 'land' }));
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) if (row[x] === ROAD_CHAR) grid.at(x, y).road = 'road';
  });
  return grid;
}

/** Prázdna mriežka `width × height` (pevnina) s cestami podľa predikátu. */
export function gridWith(width: number, height: number, isRoad: (x: number, y: number) => boolean): Grid {
  const grid = new Grid(width, height, () => ({ terrain: 'land' }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (isRoad(x, y)) grid.at(x, y).road = 'road';
  }
  return grid;
}

/** Náhodné cesty s pravdepodobnosťou `density` (deterministický `Rng`). */
export function randomRoadGrid(width: number, height: number, density: number, seed: number): Grid {
  const rng = new Rng(seed);
  return gridWith(width, height, () => rng.next() < density);
}

/**
 * Hadovité bludisko: párne riadky celé cestou, nepárne len jedna bunka na striedajúcom sa okraji — jediná dlhá
 * chodba cez celú mriežku (najhorší prípad pre A*: veľa expanzií a dlhé cesty).
 */
export function serpentineGrid(width: number, height: number): Grid {
  return gridWith(width, height, (x, y) => y % 2 === 0 || (Math.floor(y / 2) % 2 === 0 ? x === width - 1 : x === 0));
}

/** Indexy všetkých cestných buniek (row-major). */
export function roadCells(grid: Grid): number[] {
  const cells: number[] = [];
  for (let i = 0; i < grid.cellCount; i++) if (grid.atIndex(i).road === 'road') cells.push(i);
  return cells;
}

/** Nezávislé BFS po cestách (4-susednosť): počet krokov z `from` do `to`, bez cesty `Infinity`. */
export function bfsDistance(grid: Grid, from: number, to: number): number {
  if (grid.atIndex(from).road !== 'road' || grid.atIndex(to).road !== 'road') return Infinity;
  const distance = new Map<number, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    const d = distance.get(current) ?? 0;
    if (current === to) return d;
    const { x, y } = grid.coordOf(current);
    for (const { dx, dy } of DIRECTIONS_4) {
      if (!grid.inBounds(x + dx, y + dy)) continue;
      const next = grid.index(x + dx, y + dy);
      if (distance.has(next) || grid.atIndex(next).road !== 'road') continue;
      distance.set(next, d + 1);
      queue.push(next);
    }
  }
  return Infinity;
}

/** Problém cesty (začiatok, koniec, susednosť krokov, len cestné bunky, bez opakovania), alebo `null`. */
export function pathProblem(grid: Grid, path: readonly number[], from: number, to: number): string | null {
  if (path[0] !== from) return `začína ${String(path[0])}, nie ${String(from)}`;
  if (path.at(-1) !== to) return `končí ${String(path.at(-1))}, nie ${String(to)}`;
  if (new Set(path).size !== path.length) return 'bunka sa opakuje';
  for (let i = 0; i < path.length; i++) {
    if (grid.atIndex(path[i]).road !== 'road') return `bunka ${String(path[i])} nie je cesta`;
    if (i === 0) continue;
    const a = grid.coordOf(path[i - 1]);
    const b = grid.coordOf(path[i]);
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return `krok ${String(path[i - 1])} → ${String(path[i])} nie je 4-susedný`;
  }
  return null;
}
