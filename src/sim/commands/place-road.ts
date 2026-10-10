/**
 * `PlaceRoad { cells, kind?, dirs? }` — stavba a prestavba cesty po bunkách (ARCHITECTURE §5.1, §12.2; ADR-006,
 * ADR-008, ADR-012, ADR-020).
 *
 * - `kind` — typ cesty z `ROAD_KINDS` (`two_lane` / `one_lane` / `one_way`); bez neho `DEFAULT_ROAD_KIND` (`two_lane`),
 *   takže JSON z F1–F3 bez `kind` sa správa ako doteraz. Neznámy typ → `invalid_road_kind`.
 * - `dirs` — smer (`N`/`E`/`S`/`W`) pre každú položku `cells` na rovnakom indexe, len pri jednosmerke
 *   (`ROAD_KIND_TRAITS.oneWay`); UI ho odvodí z ťahu (`dragDirections`). `dirs` pri inom type, chýbajúce pri jednosmerke,
 *   iná dĺžka než `cells` alebo iný smer → `invalid_direction`. Pri duplicitnej bunke platí smer jej prvého výskytu.
 * Pri `invalid_road_kind`/`invalid_direction` sa bunky neposudzujú (`cells = []`, cena 0).
 *
 * Bunka (unikátna, v mape):
 * - **bez cesty**: terén unesie cestu (`land`/`quay`, nie voda ani `blocked` → `terrain`), nie je pod modulom ani na nej
 *   nie je koľaj (→ `occupied`), je verejná alebo na parcele `owned`/`leased` (na predaj → `parcel_not_owned`);
 * - **s cestou rovnakého typu aj smeru**: preskočí sa bez chyby a bez ceny (ako doteraz);
 * - **s cestou iného typu alebo smeru**: **prestavba** — atomický ekvivalent `RemoveRoad + PlaceRoad` (rozhodnutie 12):
 *   nesmie ju zaberať vozidlo ani kamión — stojace, ako cieľ rozbehnutého úseku ani pod telom či slotom vpredu (`occupied`, `World.carrierOnCell`, ADR-019, ADR-024)
 *   a platí pravidlo parcely (ADR-008).
 * Napojenie na existujúcu cestu sa nevyžaduje.
 *
 * Cena (`quote`): stavba = zmenené bunky × `roadKinds[kind].costPerCellCents` (`road_capex`); refundácia = `refundCents(
 * Σ roadKinds[starý typ].costPerCellCents prestavaných buniek, economy.removalRefundRate)` raz za príkaz (`road_sale`,
 * ADR-012, ADR-015); `costCents` = stavba − refundácia. `apply` pri refundácii > 0 emituje najprv `MoneyChanged(road_sale)`
 * a potom vždy `MoneyChanged(road_capex)` (ako `RemoveRoad` a potom `PlaceRoad`). Zmena typu alebo smeru zvýši
 * `roadVersion` a jazdiace vozidlá preplánujú (`markRoadsChanged`) rovnako ako pri `RemoveRoad`. Spoločné pravidlá
 * (atomickosť, `empty`, `insufficient_funds`, `RoadChanged`): `RoadLayerCommand`.
 */
import type { Cell, CellCoord, Direction4Name } from '../grid/grid';
import { isDirection4Name } from '../grid/road-direction';
import { DEFAULT_ROAD_KIND, ROAD_KIND_TRAITS, isRoadKind, type RoadKind } from '../grid/road-kind';
import { isRoadBuildable } from '../grid/terrain';
import type { World } from '../world/world';
import type { SerializedCommand } from './command';
import { checkString, checkStringList, parseCellList, readPayload } from './payload';
import { refundCents } from './refund';
import {
  CHANGE_CELL,
  NO_SHAPE_PROBLEMS,
  RoadLayerCommand,
  type CellVerdict,
  type RoadPosting,
  type PlannedCell,
  type RoadPrice,
} from './road-layer-command';
import type { ValidationReason } from './validation';

/** Povinné kľúče serializovaného tvaru v poradí `toJSON`. */
const PLACE_ROAD_KEYS: readonly string[] = ['type', 'cells'];
/** Voliteľné kľúče (`toJSON` ich vráti, len ak boli na vstupe). */
const PLACE_ROAD_OPTIONAL_KEYS: readonly string[] = ['kind', 'dirs'];

const INVALID_ROAD_KIND: readonly ValidationReason[] = Object.freeze(['invalid_road_kind']);
const INVALID_DIRECTION: readonly ValidationReason[] = Object.freeze(['invalid_direction']);

export class PlaceRoadCommand extends RoadLayerCommand {
  static readonly TYPE = 'PlaceRoad';

  readonly type = PlaceRoadCommand.TYPE;
  /** Typ cesty zo vstupu; `undefined` = predvolený `two_lane`. Neznámy reťazec odmietne `validate` (`invalid_road_kind`). */
  readonly kind: string | undefined;
  /** Smery jednosmerky pre `cells` (rovnaký index) zo vstupu; neplatné odmietne `validate` (`invalid_direction`). */
  readonly dirs: readonly string[] | undefined;

  /**
   * @param cells bunky ťahu v ľubovoľnom poradí, aj s duplicitami; súradnice musia byť celé čísla (`CommandError`)
   * @param kind typ cesty (reťazec, inak `CommandError`); bez neho `two_lane`
   * @param dirs smery po bunkách (pole reťazcov, inak `CommandError`); len pri `one_way`
   */
  constructor(cells: readonly CellCoord[], kind?: string, dirs?: readonly string[]) {
    super(PlaceRoadCommand.TYPE, cells);
    this.kind = kind === undefined ? undefined : checkString(kind, PlaceRoadCommand.TYPE, '/kind');
    this.dirs = dirs === undefined ? undefined : checkStringList(dirs, PlaceRoadCommand.TYPE, '/dirs');
  }

  /**
   * Príkaz z tvaru `{ type: 'PlaceRoad', cells: [{ x, y }, …], kind?: string, dirs?: string[] }`; iný tvar (neznámy
   * kľúč, `kind` nie je reťazec, `dirs` nie je pole reťazcov) → `CommandError`.
   */
  static fromJSON(json: SerializedCommand): PlaceRoadCommand {
    const type = PlaceRoadCommand.TYPE;
    const raw = readPayload(json, type, PLACE_ROAD_KEYS, PLACE_ROAD_OPTIONAL_KEYS);
    const cells = parseCellList(raw['cells'], type, '/cells');
    const kind = Object.hasOwn(raw, 'kind') ? checkString(raw['kind'], type, '/kind') : undefined;
    const dirs = Object.hasOwn(raw, 'dirs') ? checkStringList(raw['dirs'], type, '/dirs') : undefined;
    return new PlaceRoadCommand(cells, kind, dirs);
  }

  /** Typ cesty, ktorý príkaz stavia (`kind` alebo predvolený); neznámy `kind` → `undefined`. */
  get roadKind(): RoadKind | undefined {
    const kind = this.kind ?? DEFAULT_ROAD_KIND;
    return isRoadKind(kind) ? kind : undefined;
  }

  toJSON(): SerializedCommand {
    const json: Record<string, unknown> = { type: this.type, cells: this.cells.map(({ x, y }) => ({ x, y })) };
    if (this.kind !== undefined) json['kind'] = this.kind;
    if (this.dirs !== undefined) json['dirs'] = [...this.dirs];
    return json as SerializedCommand;
  }

  protected shapeProblems(): readonly ValidationReason[] {
    const kind = this.roadKind;
    if (kind === undefined) return INVALID_ROAD_KIND;
    const { dirs } = this;
    if (!ROAD_KIND_TRAITS[kind].oneWay) return dirs === undefined ? NO_SHAPE_PROBLEMS : INVALID_DIRECTION;
    if (dirs?.length !== this.cells.length || !dirs.every(isDirection4Name)) return INVALID_DIRECTION;
    return NO_SHAPE_PROBLEMS;
  }

  protected inspectCell(world: World, cell: Readonly<Cell>, index: number, position: number): CellVerdict {
    const reasons: ValidationReason[] = [];
    if (cell.road === 'road') {
      if (cell.roadKind === this.targetKind() && cell.roadDir === this.dirAt(position)) return 'skip';
      // Prestavba = RemoveRoad + PlaceRoad v jednom kroku: rovnaké pravidlá ako odstránenie (vozidlo, parcela).
      if (world.carrierOnCell(index) !== undefined) reasons.push('occupied');
    } else {
      if (!isRoadBuildable(cell.terrain)) reasons.push('terrain');
      // Koľaj nie je prekážka: cesta ju kríži úrovňovým priecestím (`commitCell`); nie pod modulom a nie pod vlakom, ktorý na bunke práve stojí.
      if (cell.moduleId !== null || (cell.road === 'rail' && world.rail.occupancy[index] !== 0)) reasons.push('occupied');
    }
    if (!this.parcelAllowsInfrastructure(world, cell)) reasons.push('parcel_not_owned');
    return reasons.length === 0 ? CHANGE_CELL : reasons;
  }

  protected priceOf(world: World, changes: readonly PlannedCell[]): RoadPrice {
    const { roadKinds } = world.defs.infrastructure;
    const unitCents = roadKinds[this.targetKind()].costPerCellCents;
    let buildCents = 0;
    let rebuiltPriceCents = 0;
    for (const { index } of changes) {
      buildCents += unitCents;
      const cell = world.grid.atIndex(index);
      if (cell.road === 'road') rebuiltPriceCents += roadKinds[cell.roadKind].costPerCellCents;
    }
    return { buildCents, refundCents: refundCents(rebuiltPriceCents, world.defs.economy.removalRefundRate) };
  }

  /** Cesta na koľaji vytvorí priecestie (koľaj sa zapíše do `Rail.crossings`, bunka sa stane cestou). */
  protected override commitCell(world: World, cell: Cell, change: PlannedCell): void {
    if (cell.road === 'rail') world.rail.crossings.add(change.index);
    this.writeCell(cell, change);
  }

  protected writeCell(cell: Cell, change: PlannedCell): void {
    cell.road = 'road';
    cell.roadKind = this.targetKind();
    cell.roadDir = this.dirAt(change.position);
  }

  /** Prestavba: najprv refundácia starých typov (`road_sale`, len > 0), potom vždy stavba (`road_capex`). */
  protected ledgerEntries(price: RoadPrice): readonly RoadPosting[] {
    const build: RoadPosting = { reason: 'road_capex', deltaCents: 0 - price.buildCents };
    return price.refundCents > 0 ? [{ reason: 'road_sale', deltaCents: price.refundCents }, build] : [build];
  }

  /** Typ cesty po úspešnej kontrole tvaru (`shapeProblems` vylúčil neznámy `kind`). */
  private targetKind(): RoadKind {
    return this.roadKind ?? DEFAULT_ROAD_KIND;
  }

  /** Smer bunky na pozícii `position` pri jednosmerke, inak `null` (tvar overil `shapeProblems`). */
  private dirAt(position: number): Direction4Name | null {
    const dir = this.dirs?.[position];
    return ROAD_KIND_TRAITS[this.targetKind()].oneWay && isDirection4Name(dir) ? dir : null;
  }
}
