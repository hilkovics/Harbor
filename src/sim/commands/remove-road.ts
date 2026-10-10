/**
 * `RemoveRoad { cells }` — odstránenie cesty z buniek (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-008, ADR-012, ADR-020).
 *
 * Každá unikátna bunka v mape musí mať cestu (`road === 'road'`; bez cesty alebo s koľajou → `no_road`), platí
 * pravidlo parcely ako pri stavbe (parcela na predaj → `parcel_not_owned`, ADR-008) a nesmie ju zaberať vozidlo ani
 * kamión — stojace, ako cieľ rozbehnutého úseku ani pod telom či slotom vpredu (`occupied`, `World.carrierOnCell`, ADR-019, ADR-024). Refundácia (ADR-012, ADR-015,
 * ADR-020): `refundCents(Σ roadKinds[typ bunky].costPerCellCents, economy.removalRefundRate)` z celého príkazu naraz
 * (celočíselne v bázických bodoch), kategória `road_sale`; vo `ValidationResult.costCents` je záporná (príjem).
 * Odstránená bunka sa vráti do normalizovaného stavu (`DEFAULT_ROAD_KIND`, bez smeru). Spoločné pravidlá:
 * `RoadLayerCommand`.
 */
import type { Cell, CellCoord } from '../grid/grid';
import { DEFAULT_ROAD_KIND } from '../grid/road-kind';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { refundCents } from './refund';
import { CHANGE_CELL, RoadLayerCommand, parseCellCommand, type CellVerdict, type RoadPosting, type PlannedCell, type RoadPrice } from './road-layer-command';
import type { ValidationReason } from './validation';

export class RemoveRoadCommand extends RoadLayerCommand {
  static readonly TYPE = 'RemoveRoad';

  readonly type = RemoveRoadCommand.TYPE;

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
    if (world.carrierOnCell(index) !== undefined || world.rail.occupancy[index] !== 0) reasons.push('occupied');
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  /** Refundácia podľa typu každej bunky; zaokrúhlenie nadol z celého príkazu, nie po bunkách (ADR-012, ADR-015). */
  protected priceOf(world: World, changes: readonly PlannedCell[]): RoadPrice {
    const { roadKinds } = world.defs.infrastructure;
    let priceCents = 0;
    for (const { index } of changes) priceCents += roadKinds[world.grid.atIndex(index).roadKind].costPerCellCents;
    return { buildCents: 0, refundCents: refundCents(priceCents, world.defs.economy.removalRefundRate) };
  }

  /** Priecestie po odstránení cesty ostane koľajou (`Rail.crossings` sa vyprázdni); inak bunka bez vrstvy. */
  protected override commitCell(world: World, cell: Cell, change: PlannedCell): void {
    this.writeCell(cell);
    if (world.rail.crossings.delete(change.index)) cell.road = 'rail';
  }

  protected writeCell(cell: Cell): void {
    cell.road = 'none';
    cell.roadKind = DEFAULT_ROAD_KIND;
    cell.roadDir = null;
  }

  /** Vždy práve jeden `MoneyChanged(road_sale)`, aj s nulovou refundáciou (ADR-015 bod 6). */
  protected ledgerEntries(price: RoadPrice): readonly RoadPosting[] {
    return [{ reason: 'road_sale', deltaCents: price.refundCents - price.buildCents }];
  }
}
