/**
 * `RemoveRail { cells }` — odstránenie koľaje z buniek (ARCHITECTURE §5.1, §12.2; ADR-043).
 *
 * Každá unikátna bunka v mape musí mať koľaj (inak `no_road`), platí pravidlo parcely (`parcel_not_owned`) a bunka nesmie ležať na trase žiadneho vlaku (`occupied`, `World.railCellInUse`) —
 * vlak by stratil cestu k portálu. Refundácia ako pri ceste (`economy.removalRefundRate`, kategória `road_sale`, celé zaokrúhlené raz za príkaz).
 */
import type { Cell, CellCoord } from '../grid/grid';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { refundCents } from './refund';
import { CHANGE_CELL, RoadLayerCommand, parseCellCommand, type CellVerdict, type PlannedCell, type RoadPosting, type RoadPrice } from './road-layer-command';
import type { ValidationReason } from './validation';

export class RemoveRailCommand extends RoadLayerCommand {
  static readonly TYPE = 'RemoveRail';

  readonly type = RemoveRailCommand.TYPE;

  /** @param cells bunky v ľubovoľnom poradí, aj s duplicitami; súradnice musia byť celé čísla (`CommandError`). */
  constructor(cells: readonly CellCoord[]) {
    super(RemoveRailCommand.TYPE, cells);
  }

  /** Príkaz z tvaru `{ type: 'RemoveRail', cells: [{ x, y }, …] }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): RemoveRailCommand {
    return new RemoveRailCommand(parseCellCommand(json, RemoveRailCommand.TYPE));
  }

  protected inspectCell(world: World, cell: Readonly<Cell>, index: number): CellVerdict {
    const reasons: ValidationReason[] = [];
    if (cell.road !== 'rail') reasons.push('no_road');
    if (world.railCellInUse(index)) reasons.push('occupied');
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  protected priceOf(world: World, changes: readonly PlannedCell[]): RoadPrice {
    const priceCents = changes.length * world.defs.infrastructure.rail.costPerCellCents;
    return { buildCents: 0, refundCents: refundCents(priceCents, world.defs.economy.removalRefundRate) };
  }

  protected writeCell(cell: Cell): void {
    cell.road = 'none';
  }

  /** Vždy práve jeden `MoneyChanged(road_sale)`, aj s nulovou refundáciou (ako `RemoveRoad`). */
  protected ledgerEntries(price: RoadPrice): readonly RoadPosting[] {
    return [{ reason: 'road_sale', deltaCents: price.refundCents - price.buildCents }];
  }
}
