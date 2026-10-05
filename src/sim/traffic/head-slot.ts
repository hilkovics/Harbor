/**
 * Slot hlavy nosiča pri vstupe na cestu (ADR-037, rozhodnutie orchestrátora R1 č. 3): nosič, ktorý nevstupuje do bunky
 * zvonku (spawn na portáli, výjazd z modulu, nosič bez slotov), nemá stranu vjazdu — pruh určuje strana výjazdu, teda smer
 * prvého kroku trasy; bez ďalšej bunky na trase je to pruh 0. Zdieľa ho `TrafficSystem` (nosič bez tela), spawn na portáli
 * a výjazdy z modulov (stojisko, dock, brána).
 */
import type { Grid } from '../grid/grid';
import type { Carrier } from '../movement/carrier';
import { NO_SIDE, sideBetween, type CellLanes } from './cell-lanes';
import { laneOf } from './lane-for';
import { slotKey } from './lane-slots';

/** Čo výpočet slotu hlavy číta zo sveta (`World` to spĺňa). */
export interface HeadSlotWorld {
  readonly grid: Pick<Grid, 'width'>;
  readonly cellLanes: CellLanes;
}

/** Slot nosiča, ktorý sa objaví v strede bunky `cell` a ide ďalej do bunky `next` (`undefined` = nikam). */
export function exitSlotKey(world: HeadSlotWorld, cell: number, next: number | undefined): number {
  const exitSide = next === undefined ? NO_SIDE : sideBetween(world.grid.width, cell, next);
  return slotKey(cell, laneOf(world.cellLanes, cell, NO_SIDE, exitSide));
}

/** Slot hlavy nosiča podľa jeho bunky a prvého kroku jeho trasy. */
export function headSlotKey(world: HeadSlotWorld, carrier: Carrier): number {
  return exitSlotKey(world, carrier.cell, carrier.nextCell);
}
