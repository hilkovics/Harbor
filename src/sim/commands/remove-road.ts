/**
 * `RemoveRoad { cells }` — odstránenie cesty z buniek (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-008, ADR-012).
 *
 * Každá unikátna bunka v mape musí mať cestu (`road === 'road'`; bez cesty alebo s koľajou → `no_road`), platí
 * pravidlo parcely ako pri stavbe (parcela na predaj → `parcel_not_owned`, ADR-008) a nesmie ju zaberať vozidlo —
 * stojace ani ako cieľ rozbehnutého úseku (`occupied`, `World.vehicleOnCell`, ADR-019). Refundácia (ADR-012, ADR-015):
 * `refundCents(bunky × infrastructure.road.costPerCellCents, economy.removalRefundRate)` z celého príkazu naraz
 * (celočíselne v bázických bodoch), kategória `road_sale`; vo `ValidationResult.costCents` je záporná (príjem).
 * Spoločné pravidlá: `RoadLayerCommand`.
 */
import type { Cell, CellCoord } from '../grid/grid';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { refundCents } from './refund';
import { CHANGE_CELL, RoadLayerCommand, parseCellCommand, type CellVerdict } from './road-layer-command';
import type { ValidationReason } from './validation';

export class RemoveRoadCommand extends RoadLayerCommand {
  static readonly TYPE = 'RemoveRoad';

  readonly type = RemoveRoadCommand.TYPE;
  protected readonly targetLayer = 'none';
  protected readonly ledgerCategory = 'road_sale';

  /** @param cells bunky v ľubovoľnom poradí, aj s duplicitami; súradnice musia byť celé čísla (`CommandError`). */
  constructor(cells: readonly CellCoord[]) {
    super(RemoveRoadCommand.TYPE, cells);
  }

  /** Príkaz z tvaru `{ type: 'RemoveRoad', cells: [{ x, y }, …] }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): RemoveRoadCommand {
    return new RemoveRoadCommand(parseCellCommand(json, RemoveRoadCommand.TYPE));
  }

  protected inspectCell(world: World, cell: Readonly<Cell>, index: number): CellVerdict {
    const reasons: ValidationReason[] = [];
    if (cell.road !== 'road') reasons.push('no_road');
    if (world.vehicleOnCell(index) !== undefined) reasons.push('occupied');
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  /** Záporná cena = refundácia (ADR-012, ADR-015); zaokrúhlenie nadol z celého príkazu, nie po bunkách. */
  protected costForCells(world: World, cellCount: number): number {
    const priceCents = cellCount * world.defs.infrastructure.road.costPerCellCents;
    return 0 - refundCents(priceCents, world.defs.economy.removalRefundRate);
  }
}
