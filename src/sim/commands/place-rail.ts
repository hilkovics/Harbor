/**
 * `PlaceRail { cells }` — stavba koľaje po bunkách (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-043).
 *
 * Koľaj je vrstva `Cell.road = 'rail'` (cesta a koľaj sa na bunke vylučujú; úrovňové priecestie je v BACKLOG.md). Bunka (unikátna, v mape):
 * - **bez vrstvy**: terén unesie koľaj (`land`/`quay`, ako cesta; inak `terrain`), nie je pod modulom (`occupied`), je verejná alebo na parcele `owned`/`leased`
 *   (`parcel_not_owned`);
 * - **s koľajou**: preskočí sa bez chyby a bez ceny;
 * - **s cestou**: `occupied` — koľaj nekríži cestu (rozhodnutie 1 ADR-043).
 * Napojenie na portál ani terminál sa nevyžaduje (hráč môže stavať po častiach). Cena = zmenené bunky × `infrastructure.rail.costPerCellCents` (`road_capex`).
 * Spoločné pravidlá (atomickosť, `empty`, `insufficient_funds`, `RoadChanged`): `RoadLayerCommand`.
 */
import type { Cell, CellCoord } from '../grid/grid';
import { isRoadBuildable } from '../grid/terrain';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { CHANGE_CELL, RoadLayerCommand, parseCellCommand, type CellVerdict, type PlannedCell, type RoadPosting, type RoadPrice } from './road-layer-command';
import type { ValidationReason } from './validation';

export class PlaceRailCommand extends RoadLayerCommand {
  static readonly TYPE = 'PlaceRail';

  readonly type = PlaceRailCommand.TYPE;

  /** @param cells bunky v ľubovoľnom poradí, aj s duplicitami; súradnice musia byť celé čísla (`CommandError`). */
  constructor(cells: readonly CellCoord[]) {
    super(PlaceRailCommand.TYPE, cells);
  }

  /** Príkaz z tvaru `{ type: 'PlaceRail', cells: [{ x, y }, …] }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): PlaceRailCommand {
    return new PlaceRailCommand(parseCellCommand(json, PlaceRailCommand.TYPE));
  }

  protected inspectCell(world: World, cell: Readonly<Cell>): CellVerdict {
    if (cell.road === 'rail') return 'skip';
    const reasons: ValidationReason[] = [];
    if (!isRoadBuildable(cell.terrain)) reasons.push('terrain');
    if (cell.moduleId !== null || cell.road === 'road') reasons.push('occupied');
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  protected priceOf(world: World, changes: readonly PlannedCell[]): RoadPrice {
    return { buildCents: changes.length * world.defs.infrastructure.rail.costPerCellCents, refundCents: 0 };
  }

  protected writeCell(cell: Cell): void {
    cell.road = 'rail';
  }

  protected ledgerEntries(price: RoadPrice): readonly RoadPosting[] {
    return [{ reason: 'road_capex', deltaCents: 0 - price.buildCents }];
  }
}
