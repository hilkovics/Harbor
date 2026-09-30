/**
 * Autotile pre cesty a koľaje (ARCHITECTURE §15.1, DESIGN_BRIEF §5.2): maska susedov → tvar + rotácia.
 *
 * Čistý modul bez Pixi — testovateľný v Node. Tvar a rotácia sú oddelené od kreslenia, takže neskoršia výmena
 * dočasných `Graphics` za sprity (`assets/infra/road_{straight,corner,t,cross,end}.svg`) sa týka iba `RoadLayer`.
 *
 * Maska susedov: N=1, E=2, S=4, W=8 (`DIRECTIONS_4[i].bit`). Sused sa počíta, ak leží v mape a má rovnakú vrstvu dopravy
 * (`Cell.road`); susedia mimo mapy sa nepočítajú.
 *
 * Základné orientácie sprity (rotácia 0): `straight` zvislá, `corner` N→E, `t` bez juhu, `end` otvorený na sever.
 * Rotácia je v stupňoch v smere hodinových ručičiek.
 */
import { DIRECTIONS_4, type CellCoord, type Grid, type Rotation, type RoadLayer } from '@sim/grid';

export type AutotileShape = 'end' | 'straight' | 'corner' | 't' | 'cross';

export interface AutotileTile {
  readonly shape: AutotileShape;
  /** Rotácia základnej orientácie tvaru v smere hodinových ručičiek. */
  readonly rotation: Rotation;
}

const [BIT_N, BIT_E, BIT_S, BIT_W] = DIRECTIONS_4.map((direction) => direction.bit);

/** Maska všetkých štyroch susedov. */
const MASK_ALL = BIT_N | BIT_E | BIT_S | BIT_W;

/** Maska susedov základnej orientácie každého tvaru (rotácia 0). */
export const AUTOTILE_SHAPE_BASE_MASK: Readonly<Record<AutotileShape, number>> = Object.freeze({
  end: BIT_N,
  straight: BIT_N | BIT_S,
  corner: BIT_N | BIT_E,
  t: BIT_N | BIT_E | BIT_W,
  cross: MASK_ALL,
});

const tile = (shape: AutotileShape, rotation: Rotation): AutotileTile => Object.freeze({ shape, rotation });

/**
 * Tabuľka maska → tvar + rotácia (docs/tasks/phase-01.md, T01-08); index poľa = maska.
 * Maska 0 (izolovaná cesta) sa kreslí ako `end` v základnej orientácii.
 */
export const AUTOTILE_TABLE: readonly AutotileTile[] = Object.freeze([
  tile('end', 0), //       0  ·
  tile('end', 0), //       1  N
  tile('end', 90), //      2  E
  tile('corner', 0), //    3  N E
  tile('end', 180), //     4  S
  tile('straight', 0), //  5  N S
  tile('corner', 90), //   6  E S
  tile('t', 90), //        7  N E S
  tile('end', 270), //     8  W
  tile('corner', 270), //  9  N W
  tile('straight', 90), // 10 E W
  tile('t', 0), //         11 N E W
  tile('corner', 180), //  12 S W
  tile('t', 270), //       13 N S W
  tile('t', 180), //       14 E S W
  tile('cross', 0), //     15 N E S W
]);

/** Otočí masku susedov o `rotation` stupňov v smere hodinových ručičiek (N→E→S→W→N). */
export function rotateMask(mask: number, rotation: Rotation): number {
  const bits = [BIT_N, BIT_E, BIT_S, BIT_W];
  const quarterTurns = rotation / 90;
  let rotated = 0;
  for (let i = 0; i < bits.length; i++) {
    if ((mask & bits[i]) !== 0) rotated |= bits[(i + quarterTurns) % bits.length];
  }
  return rotated;
}

/** Tvar a rotácia pre masku susedov 0…15; iná hodnota je `RangeError`. */
export function autotileShape(mask: number): AutotileTile {
  if (!Number.isInteger(mask) || mask < 0 || mask >= AUTOTILE_TABLE.length) {
    throw new RangeError(`autotileShape: maska ${String(mask)} je mimo 0…${String(AUTOTILE_TABLE.length - 1)}`);
  }
  return AUTOTILE_TABLE[mask];
}

/**
 * Maska susedov bunky (x, y) pre vrstvu `layer`: bit je nastavený, ak sused v danom smere leží v mape
 * a má `road === layer`. Samotná bunka sa nekontroluje. Bunka mimo mapy je `RangeError`.
 *
 * `extraMask` (predvolene 0) pridá smery, v ktorých cesta nemá suseda-cestu, ale pripája sa na konektor modulu
 * (`module-connectors.ts`): bunka pred konektorom tak dostane rameno až po okraj bunky modulu, nie zaoblený koniec.
 */
export function autotileMask(grid: Grid, x: number, y: number, layer: RoadLayer, extraMask = 0): number {
  if (!grid.inBounds(x, y)) {
    throw new RangeError(`autotileMask: bunka (${String(x)}, ${String(y)}) je mimo mapy ${String(grid.width)}×${String(grid.height)}`);
  }
  let mask = 0;
  for (const { dx, dy, bit } of DIRECTIONS_4) {
    const nx = x + dx;
    const ny = y + dy;
    if (grid.inBounds(nx, ny) && grid.at(nx, ny).road === layer) mask |= bit;
  }
  return mask | extraMask;
}

/**
 * Tvar a rotácia dlaždice bunky (x, y), alebo `null`, ak bunka nemá vrstvu `layer` (nič sa nekreslí). `extraMask` viď
 * `autotileMask` (ramená k konektorom modulov).
 */
export function autotileTile(grid: Grid, x: number, y: number, layer: RoadLayer, extraMask = 0): AutotileTile | null {
  if (grid.at(x, y).road !== layer) return null;
  return autotileShape(autotileMask(grid, x, y, layer, extraMask));
}

/**
 * Bunky, ktoré treba prekresliť po zmene `cells`: každá zmenená bunka a jej 4 susedia v mape (susedia menia
 * masku). Bez duplicít; poradie je deterministické (vstupné poradie, pre každú bunku ona sama a potom N, E, S, W).
 * Bunky mimo mapy vo vstupe sa ignorujú.
 */
export function autotileAffected(grid: Grid, cells: readonly CellCoord[]): CellCoord[] {
  const seen = new Set<number>();
  const affected: CellCoord[] = [];
  const add = (x: number, y: number): void => {
    if (!grid.inBounds(x, y)) return;
    const index = grid.index(x, y);
    if (seen.has(index)) return;
    seen.add(index);
    affected.push({ x, y });
  };
  for (const { x, y } of cells) {
    if (!grid.inBounds(x, y)) continue;
    add(x, y);
    for (const direction of DIRECTIONS_4) add(x + direction.dx, y + direction.dy);
  }
  return affected;
}
