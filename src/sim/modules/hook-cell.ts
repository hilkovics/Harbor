/**
 * Bunka pod hákom žeriava (F6d, ADR-033 dodatok T6D-02): miesto na nábreží kotviska, kde stojí vozidlo pri odovzdaní jednotky
 * žeriavu (vykládka: žeriav ju spustí na vozidlo, nakládka: žeriav ju zdvihne z vozidla).
 *
 * Bunka leží vo footprinte žeriava v **pevninskom riadku** (okraj footprintu odvrátený od vody) na osi výložníka: pozdĺž nábrežia v strede
 * šírky (pri párnej šírke ľavá z dvoch stredných buniek, `⌊(w − 1) / 2⌋`). Vozidlo tak zastane v zadnom prejazde portálu žeriava (pod
 * výložníkom nie je nič, čo by ho zakrylo), hneď za nábrežím, kam sa dostane z cesty bez prejazdu hlbšie pod žeriav; vozík ide na
 * pevninský koniec výložníka a kontajner spustí o bunku späť. Poloha závisí len od geometrie žeriava a kotviska (strana pri vode po
 * rotácii), nie od stavu sveta.
 */
import type { CellCoord, Grid } from '../grid/grid';
import type { Rotation } from '../grid/rotation';
import type { BerthModule } from './berth-module';
import type { CraneModule } from './crane-module';
import { edgeCells, rotateSide } from './module-geometry';

/** Otočenie o pol otáčky: strana pri súši je opačná k strane pri vode. */
const HALF_TURN: Rotation = 180;

/** Stred rozsahu `count` buniek: index `⌊(count − 1) / 2⌋`. */
function middle(count: number): number {
  return Math.floor((count - 1) / 2);
}

/** Súradnice bunky pod hákom žeriava `crane` na kotvisku `berth` (bunka footprintu žeriava). */
export function hookCellCoord(crane: CraneModule, berth: BerthModule): CellCoord {
  const landEdge = edgeCells(crane.origin, crane.size, rotateSide(berth.waterSide, HALF_TURN));
  return landEdge[middle(landEdge.length)];
}

/** Index bunky pod hákom žeriava `crane` v mriežke `grid` (row-major). */
export function hookCellIndex(grid: Grid, crane: CraneModule, berth: BerthModule): number {
  const { x, y } = hookCellCoord(crane, berth);
  return grid.index(x, y);
}
