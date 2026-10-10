/**
 * Trasy vlakov (R6, ADR-043): z koľajového portálu mapy po koncové bunky koľají železničných terminálov. Trasa = najkratšia cesta po koľajiach mapy (`Cell.road = 'rail'`, BFS so
 * štvorsmerným susedstvom v poradí N, E, S, W — deterministická) od bunky portálu po vonkajšiu bunku vjazdu koľaje terminálu + bunky koľaje terminálu (bay 0 … posledný). Čisté čítanie mriežky a modulov.
 * Koľaj, ku ktorej z portálu nevedie súvislá koľaj, trasu nemá (terminál nie je „napojený“); bez trasy sa vlak nespawnuje a `railShare` kontraktov sa nelosuje.
 */
import type { EntityId } from '../core/entity-id';
import { DIRECTIONS_4, type CellCoord, type Grid } from '../grid/grid';
import type { Module } from '../modules/module';
import { RailTerminal } from '../modules/rail-terminal';

export interface RailRoute {
  readonly terminalId: EntityId;
  readonly track: number;
  /** Indexy buniek od portálu (`cells[0]`) po koniec koľaje terminálu. */
  readonly cells: readonly number[];
}

/** Najkratšia cesta po koľajiach z bunky `from` do `to` (obe musia mať koľaj) ako indexy buniek vrátane oboch koncov; `undefined`, keď neexistuje. */
export function findRailPath(grid: Grid, from: CellCoord, to: CellCoord): readonly number[] | undefined {
  if (!grid.inBounds(from.x, from.y) || !grid.inBounds(to.x, to.y)) return undefined;
  if (grid.at(from.x, from.y).road !== 'rail' || grid.at(to.x, to.y).road !== 'rail') return undefined;
  const start = grid.index(from.x, from.y);
  const goal = grid.index(to.x, to.y);
  const previous = new Map<number, number>([[start, -1]]);
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === goal) break;
    const at = grid.coordOf(current);
    for (const { dx, dy } of DIRECTIONS_4) {
      const x = at.x + dx;
      const y = at.y + dy;
      if (!grid.inBounds(x, y) || grid.at(x, y).road !== 'rail') continue;
      const next = grid.index(x, y);
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(goal)) return undefined;
  const path: number[] = [];
  for (let cell = goal; cell !== -1; cell = previous.get(cell) as number) path.push(cell);
  return path.reverse();
}

/**
 * Trasy portál → koľaj terminálu pre všetky železničné terminály vo svete (vzostupne podľa id modulu, potom podľa koľaje); koľaje bez napojenia chýbajú.
 * `portal` je bunka koľajového portálu mapy (`undefined` = mapa ho nemá → žiadne trasy).
 */
export function computeRailRoutes(grid: Grid, portal: CellCoord | undefined, modules: Iterable<Module>): readonly RailRoute[] {
  if (portal === undefined) return [];
  const terminals = [...modules].filter((module): module is RailTerminal => module instanceof RailTerminal).sort((a, b) => a.id - b.id);
  const routes: RailRoute[] = [];
  for (const terminal of terminals) {
    for (let track = 0; track < terminal.tracks; track++) {
      const approach = findRailPath(grid, portal, terminal.trackEntry(track));
      if (approach === undefined) continue;
      const cells = [...approach, ...terminal.trackCells(track).map(({ x, y }) => grid.index(x, y))];
      routes.push(Object.freeze({ terminalId: terminal.id, track, cells: Object.freeze(cells) }));
    }
  }
  return routes;
}
