/**
 * Výjazd z depa (docs/tasks/phase-03.md rozhodnutia 2 a 4): kúpené vozidlo sa objaví `idle` na **vonkajšej bunke**
 * cestného konektora depa (bunka pred konektorom na strane `side`, mimo footprintu — ADR-017), v strede bunky
 * a s kurzom smerom von z depa. Konektory sa skúšajú v poradí defu (po rotácii); použije sa prvý, ktorého vonkajšia
 * bunka má cestu — rovnaké pravidlo ako `World.isConnected`, takže pripojené depo výjazd vždy má.
 */
import type { CellCoord, Grid } from '../grid/grid';
import type { Rotation } from '../grid/rotation';
import type { Module } from '../modules/module';
import { SIDE_STEPS, connectorOutside } from '../modules/module-geometry';
import { cardinalHeading, cellCenter } from '../ships/ship-route';

/** Miesto, kde nové vozidlo stojí: vonkajšia bunka konektora, jej stred a kurz von z modulu. */
export interface DepotExit {
  readonly cell: CellCoord;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
}

/**
 * Výjazd z modulu (depa): prvý konektor typu `road`, ktorého vonkajšia bunka leží v mape a má cestu; kurz = smer
 * z bunky konektora na vonkajšiu bunku (n → 0, e → 90, s → 180, w → 270). Nepripojený modul → `undefined`.
 */
export function depotExit(grid: Grid, depot: Module): DepotExit | undefined {
  for (const connector of depot.connectors) {
    if (connector.type !== 'road') continue;
    const cell = connectorOutside(connector);
    if (!grid.inBounds(cell.x, cell.y) || grid.at(cell.x, cell.y).road !== 'road') continue;
    const { dx, dy } = SIDE_STEPS[connector.side];
    const heading = cardinalHeading(dx, dy);
    if (heading === null) continue;
    const center = cellCenter(cell);
    return Object.freeze({ cell, x: center.x, y: center.y, heading });
  }
  return undefined;
}
