/**
 * Poloha na trase vlaku pre prezentáciu (R6, ADR-043): z polohy stredu vozňa v milli-bunkách (`TrainCarSpan.centerMilli`) a trasy (indexy buniek) vypočíta stred v súradniciach buniek a uhol.
 * Čistá funkcia mimo stavu simulácie (nič z nej sa nevracia do sim), uhol v stupňoch (0 = +x, 90 = +y nadol, smer rastúcej polohy na trase). Pred portálom (`s < 0`) a za koncom trasy sa extrapoluje
 * v smere prvého / posledného úseku, takže vozeň, ktorý ešte nevošiel na mapu, stojí na predĺžení koľaje.
 */
import type { Grid } from '../grid/grid';
import { MILLI_PER_CELL } from './train';

export interface RailPose {
  /** Stred v súradniciach buniek (stred bunky `(x, y)` je `x + 0.5, y + 0.5`). */
  readonly x: number;
  readonly y: number;
  /** Uhol v stupňoch (smer rastúcej polohy na trase). */
  readonly angle: number;
}

const HALF_TURN_DEGREES = 180;

/** Poloha stredu vozňa na trase `route` v mieste `sMilli`. Trasa musí mať aspoň 2 bunky. */
export function railPoseAt(grid: Grid, route: readonly number[], sMilli: number): RailPose {
  const last = route.length - 1;
  const t = sMilli / MILLI_PER_CELL - 0.5;
  const i = Math.max(0, Math.min(last - 1, Math.floor(t)));
  const a = grid.coordOf(route[i]);
  const b = grid.coordOf(route[i + 1]);
  const frac = t - i;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: a.x + 0.5 + dx * frac, y: a.y + 0.5 + dy * frac, angle: (Math.atan2(dy, dx) * HALF_TURN_DEGREES) / Math.PI };
}
