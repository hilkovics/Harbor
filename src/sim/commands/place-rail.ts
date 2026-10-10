/**
 * `PlaceRail { cells }` — stavba koľaje po bunkách (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-043).
 *
 * Koľaj je vrstva `Cell.road = 'rail'`; cez bunku s cestou vedie ako **úrovňové priecestie** (`Rail.crossings`, ADR-043 TR6-02: bunka ostáva cestou). Bunka (unikátna, v mape):
 * - **bez vrstvy**: terén unesie koľaj (`land`/`quay`, ako cesta; inak `terrain`), nie je pod modulom (`occupied`), je verejná alebo na parcele `owned`/`leased`
 *   (`parcel_not_owned`);
 * - **s koľajou**: preskočí sa bez chyby a bez ceny;
 * - **s cestou**: stane sa priecestím (rovnaké pravidlá terénu, modulu a parcely; bunka je už priecestie → preskočí sa).
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

  protected inspectCell(world: World, cell: Readonly<Cell>, index: number): CellVerdict {
    if (cell.road === 'rail' || world.rail.isCrossing(index)) return 'skip';
    const reasons: ValidationReason[] = [];
    if (!isRoadBuildable(cell.terrain)) reasons.push('terrain');
    // Cesta nie je prekážka: koľaj ju kríži úrovňovým priecestím (vlak ho rezervuje, vozidlá čakajú pri závore); pod modulom nie.
    if (cell.moduleId !== null) reasons.push('occupied');
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  protected priceOf(world: World, changes: readonly PlannedCell[]): RoadPrice {
    return { buildCents: changes.length * world.defs.infrastructure.rail.costPerCellCents, refundCents: 0 };
  }

  protected writeCell(cell: Cell): void {
    cell.road = 'rail';
  }

  /** Bunka s cestou sa stane priecestím (cesta ostáva, koľaj sa zapíše do `Rail.crossings`); inak koľaj. */
  protected override commitCell(world: World, cell: Cell, change: PlannedCell): void {
    if (cell.road === 'road') world.rail.crossings.add(change.index);
    else this.writeCell(cell);
  }

  protected ledgerEntries(price: RoadPrice): readonly RoadPosting[] {
    return [{ reason: 'road_capex', deltaCents: 0 - price.buildCents }];
  }
}
