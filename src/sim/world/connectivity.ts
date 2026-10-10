/**
 * Pripojenie modulov k cestnej sieti (rozhodnutie orchestrátora F3 č. 2 a 3; ARCHITECTURE §8 bod 5; ADR-017).
 *
 * - **Vonkajšia bunka konektora** (`connectorOutside`) = susedná bunka konektora na strane `side`, mimo footprintu —
 *   tam vozidlo stojí pri vstupe do modulu a tam musí byť cesta.
 * - **Pripojený modul** má aspoň jeden konektor typu `road`, ktorého vonkajšia bunka leží v mape a má `road === 'road'`.
 *   Počíta sa vždy z mriežky (žiadna cache), takže `RoadChanged` sa prejaví okamžite. Modul bez cestných konektorov
 *   (žeriav) pripojený nie je — vozidlá doň nevchádzajú.
 * - **§8 bod 5** (`connector_blocked` v `module-rules.ts`): modul s cestnými konektormi sa dá postaviť, len ak aspoň
 *   jeden z nich má vonkajšiu bunku s cestou alebo **voľnú pre cestu** (`isOutsideUsable`) — inak by nešiel pripojiť
 *   nikdy (bez odstránenia iných stavieb). Vlastníctvo parcely sa nevyžaduje (parcelu možno dokúpiť).
 *
 * Funkcie sú čisté (len čítajú mriežku), `World.isConnected` / `World.connectorCells` ich len zverejňujú.
 */
import type { CellCoord, Grid } from '../grid/grid';
import { isRoadBuildable } from '../grid/terrain';
import type { Module } from '../modules/module';
import { SIDE_STEPS, connectorOutside, type PlacedConnector } from '../modules/module-geometry';

/** Konektor modulu vo svete s vonkajšou bunkou a stavom cesty na nej (UI badge „Nepripojené", dispatcher). */
export interface ConnectorCell {
  /** Konektor po rotácii (bunka footprintu, strana, typ). */
  readonly connector: PlacedConnector;
  /** Vonkajšia bunka (môže byť mimo mapy). */
  readonly outside: CellCoord;
  /** Vonkajšia bunka je v mape a má `road === 'road'` (bez ohľadu na typ konektora). */
  readonly hasRoad: boolean;
}

/** Je na bunke `(x, y)` v mape cesta? Mimo mapy `false`. */
function hasRoadAt(grid: Grid, x: number, y: number): boolean {
  return grid.inBounds(x, y) && grid.at(x, y).road === 'road';
}

/** Konektory modulu v poradí defu s vonkajšou bunkou a `hasRoad` (nová kópia pri každom volaní). */
export function connectorCellsOf(grid: Grid, module: Module): readonly ConnectorCell[] {
  return Object.freeze(
    module.connectors.map((connector): ConnectorCell => {
      const outside = connectorOutside(connector);
      return Object.freeze({ connector, outside, hasRoad: hasRoadAt(grid, outside.x, outside.y) });
    }),
  );
}

/** Je modul pripojený (cestný konektor s cestou na vonkajšej bunke)? Bez alokácie — volá ho dispatcher každý tick. */
export function isModuleConnected(grid: Grid, module: Module): boolean {
  for (const connector of module.connectors) {
    if (connector.type !== 'road') continue;
    const { dx, dy } = SIDE_STEPS[connector.side];
    if (hasRoadAt(grid, connector.x + dx, connector.y + dy)) return true;
  }
  return false;
}

/**
 * Dá sa vonkajšia bunka cestného konektora (niekedy) pripojiť (§8 bod 5)? Áno, ak je v mape a má cestu, alebo je
 * voľná pre cestu: terén ju unesie (`isRoadBuildable`), nie je vo footprinte žiadneho modulu (ani umiestňovaného —
 * `ownFootprint`) a nie je na nej koľaj. Parcela sa neoveruje (dá sa dokúpiť).
 */
export function isOutsideUsable(grid: Grid, outside: CellCoord, ownFootprint: (x: number, y: number) => boolean): boolean {
  if (!grid.inBounds(outside.x, outside.y) || ownFootprint(outside.x, outside.y)) return false;
  const cell = grid.at(outside.x, outside.y);
  if (cell.road === 'road') return true;
  return cell.road === 'none' && cell.moduleId === null && isRoadBuildable(cell.terrain);
}
