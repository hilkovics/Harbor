/**
 * Pruh nosiča v bunke (ADR-037, rozhodnutie orchestrátora R1 č. 3). Konce `two_lane` bunky `e0 < e1` sú smery
 * (N = 0, E = 1, S = 2, W = 3) k jazdným susedom:
 * - vjazd zo strany `e0` = pruh 0, inak pruh 1 (protismerné nosiče sa tak nikdy nestretnú v jednom slote);
 * - slepá bunka (jediný koniec `e0`): vjazd z `e0` je pruh 0, výjazd späť cez `e0` (otočka) pruh 1;
 * - bez strany vjazdu (spawn, výjazd z modulu, štart jazdy zo státia) určuje pruh strana výjazdu: výjazd k `e1` je pruh 0,
 *   výjazd k `e0` pruh 1;
 * - bunky s jedným slotom (`single`, `junction`, `none`) majú vždy pruh 0.
 */
import type { CellLaneKind, CellLanes } from './cell-lanes';
import { NO_SIDE } from './cell-lanes';

/** Čo `cellLaneKind` a `laneFor` čítajú zo sveta (`World` to spĺňa). */
export interface LaneWorld {
  readonly cellLanes: CellLanes;
}

/** Pruh v `two_lane` bunke podľa koncov bunky a strán vjazdu a výjazdu (`NO_SIDE` = neznáma). */
export function laneOf(lanes: CellLanes, cell: number, entrySide: number, exitSide: number): 0 | 1 {
  if (lanes.kindOf(cell) !== 'two_lane') return 0;
  if (entrySide !== NO_SIDE) return entrySide === lanes.end0(cell) ? 0 : 1;
  if (exitSide !== NO_SIDE) return exitSide === lanes.end1(cell) ? 0 : 1;
  return 0;
}

/** Druh bunky: `two_lane` (2 sloty), `single` (1 slot), `junction` (križovatka, 1 slot) alebo `none`. */
export function cellLaneKind(world: LaneWorld, cell: number): CellLaneKind {
  return world.cellLanes.kindOf(cell);
}

/**
 * Pruh (0 | 1) nosiča v bunke `cell` podľa strany vjazdu (`entrySide`: smer z bunky k bunke, z ktorej nosič prišiel)
 * a strany výjazdu (`exitSide`), `null` = neznáma strana.
 */
export function laneFor(world: LaneWorld, cell: number, entrySide: number | null, exitSide: number | null): 0 | 1 {
  return laneOf(world.cellLanes, cell, entrySide ?? NO_SIDE, exitSide ?? NO_SIDE);
}
