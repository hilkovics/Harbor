/**
 * Spoločná báza príkazov nad vrstvou dopravy `Cell.road` (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-008, ADR-012):
 * `PlaceRoad`, `RemoveRoad` a od F10 `PlaceRail`/`RemoveRail` — nový príkaz = podtrieda, nie `switch` (pravidlo 7).
 *
 * Príkaz nesie zoznam buniek (napr. ťah myšou) a je **atomický**: jedna neplatná bunka odmietne celý príkaz
 * a nič sa nezmení. Vyhodnotenie (`plan`) je čisté čítanie sveta — `validate` ho vráti ako `ValidationResult`,
 * `apply` ho zopakuje nad tým istým stavom a vykoná:
 * 1. Bunky sa prechádzajú v poradí zoznamu; bunka mimo mapy → `out_of_bounds`, duplicitná bunka sa vynechá.
 * 2. Podtrieda posúdi bunku (`inspectCell`): zmeniť / preskočiť bez chyby a bez ceny / dôvody odmietnutia.
 * 3. Žiadna bunka na zmenu a žiadny iný dôvod (prázdny zoznam, všetko preskočené) → `empty`.
 * 4. Cena (`costForCells`) > 0 a vyššia než hotovosť → `insufficient_funds`. Záporná cena = príjem (refundácia).
 * 5. `apply`: vrstva zmenených buniek = `targetLayer`, `world.markRoadsChanged()` (zneplatní cache ciest, T03-03),
 *    hotovosť −= cena, práve jeden `RoadChanged` (presne zmenené bunky) a práve jeden `MoneyChanged`
 *    (`deltaCents = −cena`, kategória `ledgerCategory`).
 */
import type { Cell, CellCoord, RoadLayer } from '../grid/grid';
import type { LedgerCategory } from '../economy/ledger-category';
import type { World } from '../world/world';
import type { Command, SerializedCommand } from './command';
import { copyCellList, parseCellList, readPayload } from './payload';
import { orderReasons, type ValidationReason, type ValidationResult } from './validation';

/** Kľúče serializovaného tvaru `{ type, cells }`. */
const CELL_COMMAND_KEYS: readonly string[] = ['type', 'cells'];

/** Výsledok posúdenia bunky: zoznam dôvodov (prázdny = bunka sa zmení) alebo `'skip'` (už je v cieľovom stave). */
export type CellVerdict = readonly ValidationReason[] | 'skip';

/** Posúdenie bunky, ktorá sa zmení (bez dôvodov odmietnutia). */
export const CHANGE_CELL: CellVerdict = Object.freeze([]);

/** Zoznam buniek `{ type, cells }` zo serializovaného tvaru (pre statické `fromJSON` podtried). */
export function parseCellCommand(json: SerializedCommand, type: string): readonly CellCoord[] {
  return parseCellList(readPayload(json, type, CELL_COMMAND_KEYS)['cells'], type, '/cells');
}

export abstract class RoadLayerCommand implements Command {
  abstract readonly type: string;
  /** Bunky v poradí zadania, vrátane duplicít (zmrazená kópia vstupu — `toJSON` ho vráti bez zmeny). */
  readonly cells: readonly CellCoord[];

  /** Vrstva, ktorú `apply` zapíše do zmenených buniek. */
  protected abstract readonly targetLayer: RoadLayer;
  /** Kategória účtovnej knihy pre `MoneyChanged` (§9.2). */
  protected abstract readonly ledgerCategory: LedgerCategory;

  /**
   * @param type typ príkazu (pre správy chýb)
   * @param cells bunky s celočíselnými súradnicami (mimo mapy smú byť — to hlási `validate`); inak `CommandError`
   */
  protected constructor(type: string, cells: readonly CellCoord[]) {
    this.cells = copyCellList(cells, type, '/cells');
  }

  /**
   * Posúdi jednu bunku v mape (volá sa raz pre každú unikátnu bunku). Nesmie meniť svet.
   * `CHANGE_CELL` = bunka sa zmení, `'skip'` = bez zmeny a bez chyby, inak dôvody odmietnutia.
   */
  protected abstract inspectCell(world: World, cell: Readonly<Cell>): CellVerdict;

  /** Cena v centoch za `cellCount` menených buniek; záporná = príjem (refundácia). Nesmie meniť svet. */
  protected abstract costForCells(world: World, cellCount: number): number;

  /**
   * `ok` len bez dôvodov; `cells` = unikátne bunky, ktoré `apply` zmení (v poradí prvého výskytu) — pri odmietnutí
   * tie z nich, ktoré by samy prešli; `costCents` = ich cena. Svet sa nemení, `Rng` sa nepoužije.
   */
  validate(world: World): ValidationResult {
    return this.plan(world);
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const plan = this.plan(world);
    if (!plan.ok) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${plan.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    for (const { x, y } of plan.cells) world.grid.at(x, y).road = this.targetLayer;
    world.markRoadsChanged();
    const deltaCents = 0 - plan.costCents;
    world.cashCents += deltaCents;
    world.events.emit({ type: 'RoadChanged', cells: plan.cells });
    world.events.emit({ type: 'MoneyChanged', cashCents: world.cashCents, deltaCents, reason: this.ledgerCategory });
  }

  toJSON(): SerializedCommand {
    return { type: this.type, cells: this.cells.map(({ x, y }) => ({ x, y })) };
  }

  /**
   * ADR-008: infraštruktúra smie ležať na verejnej bunke (`parcelId === null`) alebo na parcele `owned`/`leased`,
   * nie na parcele na predaj (`ownership: 'none'`). Neznáma parcela sa berie ako nevlastnená (fail-safe).
   */
  protected parcelAllowsInfrastructure(world: World, cell: Readonly<Cell>): boolean {
    if (cell.parcelId === null) return true;
    const ownership = world.parcels.get(cell.parcelId)?.ownership ?? 'none';
    return ownership !== 'none';
  }

  private plan(world: World): ValidationResult {
    const { grid } = world;
    const found = new Set<ValidationReason>();
    const seen = new Set<number>();
    const changed: CellCoord[] = [];
    for (const { x, y } of this.cells) {
      if (!grid.inBounds(x, y)) {
        found.add('out_of_bounds');
        continue;
      }
      const index = grid.index(x, y);
      if (seen.has(index)) continue;
      seen.add(index);
      const verdict = this.inspectCell(world, grid.at(x, y));
      if (verdict === 'skip') continue;
      if (verdict.length === 0) changed.push(Object.freeze({ x, y }));
      for (const reason of verdict) found.add(reason);
    }
    if (changed.length === 0 && found.size === 0) found.add('empty');
    const costCents = this.costForCells(world, changed.length);
    if (costCents > 0 && costCents > world.cashCents) found.add('insufficient_funds');
    return Object.freeze({
      ok: found.size === 0,
      reasons: orderReasons(found),
      cells: Object.freeze(changed),
      costCents,
    });
  }
}
