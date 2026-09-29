/**
 * `PlaceRoad { cells }` — stavba cesty po bunkách (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-008).
 *
 * Bunka (unikátna, v mape) je platná, ak: terén unesie cestu (`land`/`quay`, nie voda ani `blocked` → `terrain`),
 * nie je pod modulom ani na nej nie je koľaj (→ `occupied`), je verejná alebo na parcele `owned`/`leased`
 * (na predaj → `parcel_not_owned`). Bunka, ktorá cestu už má, sa preskočí bez chyby a bez ceny. Napojenie
 * na existujúcu cestu sa nevyžaduje. Cena = nové bunky × `infrastructure.road.costPerCellCents`, kategória
 * `road_capex`. Spoločné pravidlá (atomickosť, `empty`, `insufficient_funds`, udalosti): `RoadLayerCommand`.
 */
import type { Cell, CellCoord } from '../grid/grid';
import { isRoadBuildable } from '../grid/terrain';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { CHANGE_CELL, RoadLayerCommand, parseCellCommand, type CellVerdict } from './road-layer-command';
import type { ValidationReason } from './validation';

export class PlaceRoadCommand extends RoadLayerCommand {
  static readonly TYPE = 'PlaceRoad';

  readonly type = PlaceRoadCommand.TYPE;
  protected readonly targetLayer = 'road';
  protected readonly ledgerCategory = 'road_capex';

  /** @param cells bunky ťahu v ľubovoľnom poradí, aj s duplicitami; súradnice musia byť celé čísla (`CommandError`). */
  constructor(cells: readonly CellCoord[]) {
    super(PlaceRoadCommand.TYPE, cells);
  }

  /** Príkaz z tvaru `{ type: 'PlaceRoad', cells: [{ x, y }, …] }`; iný tvar → `CommandError`. */
  static fromJSON(json: SerializedCommand): PlaceRoadCommand {
    return new PlaceRoadCommand(parseCellCommand(json, PlaceRoadCommand.TYPE));
  }

  protected inspectCell(world: World, cell: Readonly<Cell>): CellVerdict {
    if (cell.road === 'road') return 'skip';
    const reasons: ValidationReason[] = [];
    if (!isRoadBuildable(cell.terrain)) reasons.push('terrain');
    if (cell.moduleId !== null || cell.road === 'rail') reasons.push('occupied');
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  protected costForCells(world: World, cellCount: number): number {
    return cellCount * world.defs.infrastructure.road.costPerCellCents;
  }
}
