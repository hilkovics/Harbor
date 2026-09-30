/**
 * Spoločná báza príkazov nad vrstvou dopravy `Cell.road` (ARCHITECTURE §5.1, §12.2; ADR-006, ADR-008, ADR-012, ADR-020):
 * `PlaceRoad`, `RemoveRoad` a od F10 `PlaceRail`/`RemoveRail` — nový príkaz = podtrieda, nie `switch` (pravidlo 7).
 *
 * Príkaz nesie zoznam buniek (napr. ťah myšou) a je **atomický**: jedna neplatná bunka odmietne celý príkaz
 * a nič sa nezmení. Vyhodnotenie (`plan`) je čisté čítanie sveta — `validate` ho vráti ako `ValidationResult`,
 * `quote` navyše s rozpadom ceny, `apply` ho zopakuje nad tým istým stavom a vykoná:
 * 0. Neplatný tvar príkazu (`shapeProblems`, napr. neznámy typ cesty) → len tieto dôvody, `cells = []`, cena 0;
 *    bunky sa vtedy neposudzujú (ako `invalid_rotation` pri `PlaceModule`, ADR-015).
 * 1. Bunky sa prechádzajú v poradí zoznamu; bunka mimo mapy → `out_of_bounds`, duplicitná bunka sa vynechá
 *    (platí jej prvý výskyt — aj pre údaje po bunkách, napr. smer jednosmerky).
 * 2. Podtrieda posúdi bunku (`inspectCell`): zmeniť / preskočiť bez chyby a bez ceny / dôvody odmietnutia.
 * 3. Žiadna bunka na zmenu a žiadny iný dôvod (prázdny zoznam, všetko preskočené) → `empty`.
 * 4. Cena (`priceOf`: stavba − refundácia) > 0 a vyššia než hotovosť → `insufficient_funds`. Záporná cena = príjem.
 * 5. `apply`: podtrieda zapíše zmenené bunky (`writeCell`), `world.markRoadsChanged()` (zneplatní cache ciest a označí
 *    jazdiace vozidlá na preplánovanie, ADR-019), práve jeden `RoadChanged` (presne zmenené bunky) a potom `MoneyChanged`
 *    podľa `ledgerEntries` podtriedy — každý zápis zmení hotovosť a nesie nový stav (`PlaceRoad`/`RemoveRoad` majú vždy
 *    práve jeden hlavný zápis, aj s nulovou deltou; prestavba pridá pred stavbu refundáciu, ADR-020).
 */
import type { Cell, CellCoord } from '../grid/grid';
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

/** Žiadny problém tvaru príkazu. */
export const NO_SHAPE_PROBLEMS: readonly ValidationReason[] = Object.freeze([]);

/** Bunka, ktorú príkaz zmení. */
export interface PlannedCell {
  readonly x: number;
  readonly y: number;
  /** Row-major index bunky. */
  readonly index: number;
  /** Poradie prvého výskytu bunky v `cells` príkazu (index údajov po bunkách, napr. `PlaceRoad.dirs`). */
  readonly position: number;
}

/** Peňažný rozpad príkazu (ADR-012, ADR-020); oboje celé ≥ 0, čistá cena `costCents = buildCents − refundCents`. */
export interface RoadPrice {
  /** Cena nových a prestavaných buniek (`road_capex`). */
  readonly buildCents: number;
  /** Refundácia odstránených a prestavaných buniek (`road_sale`), zaokrúhlená nadol raz za príkaz. */
  readonly refundCents: number;
}

/** `validate` s rozpadom ceny — ghost v UI môže ukázať stavbu a refundáciu prestavby zvlášť (T03-20). */
export interface RoadQuote extends ValidationResult, RoadPrice {}

/** Jeden pohyb peňazí pri `apply` — `Economy.post(deltaCents, reason)` (zápis do knihy + `MoneyChanged`, ADR-025). */
export interface RoadPosting {
  readonly reason: LedgerCategory;
  /** Zmena hotovosti (záporná = výdavok). */
  readonly deltaCents: number;
}

const NO_PRICE: RoadPrice = Object.freeze({ buildCents: 0, refundCents: 0 });
const NO_CELLS: readonly CellCoord[] = Object.freeze([]);
const NO_CHANGES: readonly PlannedCell[] = Object.freeze([]);

interface Plan {
  readonly quote: RoadQuote;
  readonly changes: readonly PlannedCell[];
}

/** Zoznam buniek `{ type, cells }` zo serializovaného tvaru (pre statické `fromJSON` podtried). */
export function parseCellCommand(json: SerializedCommand, type: string): readonly CellCoord[] {
  return parseCellList(readPayload(json, type, CELL_COMMAND_KEYS)['cells'], type, '/cells');
}

export abstract class RoadLayerCommand implements Command {
  abstract readonly type: string;
  /** Bunky v poradí zadania, vrátane duplicít (zmrazená kópia vstupu — `toJSON` ho vráti bez zmeny). */
  readonly cells: readonly CellCoord[];

  /**
   * @param type typ príkazu (pre správy chýb)
   * @param cells bunky s celočíselnými súradnicami (mimo mapy smú byť — to hlási `validate`); inak `CommandError`
   */
  protected constructor(type: string, cells: readonly CellCoord[]) {
    this.cells = copyCellList(cells, type, '/cells');
  }

  /** Problémy tvaru príkazu nezávislé od buniek (neznámy typ cesty, zlé smery); predvolene žiadne. */
  protected shapeProblems(): readonly ValidationReason[] {
    return NO_SHAPE_PROBLEMS;
  }

  /**
   * Posúdi jednu bunku v mape s row-major indexom `index` a poradím prvého výskytu `position` (volá sa raz pre každú
   * unikátnu bunku). Nesmie meniť svet. `CHANGE_CELL` = bunka sa zmení, `'skip'` = bez zmeny a bez chyby, inak dôvody.
   */
  protected abstract inspectCell(world: World, cell: Readonly<Cell>, index: number, position: number): CellVerdict;

  /** Cena zmeny buniek `changes` podľa ich **aktuálneho** stavu (pred zápisom). Nesmie meniť svet. */
  protected abstract priceOf(world: World, changes: readonly PlannedCell[]): RoadPrice;

  /** Zapíše cieľový stav do bunky (`apply`, len bunky z plánu). */
  protected abstract writeCell(cell: Cell, change: PlannedCell): void;

  /** Zápisy `MoneyChanged` pri `apply` v poradí emitovania (súčet delt = −čistá cena). */
  protected abstract ledgerEntries(price: RoadPrice): readonly RoadPosting[];

  /**
   * `ok` len bez dôvodov; `cells` = unikátne bunky, ktoré `apply` zmení (v poradí prvého výskytu) — pri odmietnutí
   * tie z nich, ktoré by samy prešli; `costCents` = ich čistá cena. Svet sa nemení, `Rng` sa nepoužije.
   */
  validate(world: World): ValidationResult {
    const { ok, reasons, cells, costCents } = this.plan(world).quote;
    return Object.freeze({ ok, reasons, cells, costCents });
  }

  /** Ako `validate`, navyše s rozpadom ceny na stavbu a refundáciu (`costCents = buildCents − refundCents`). */
  quote(world: World): RoadQuote {
    return this.plan(world).quote;
  }

  /** Vykoná príkaz; svet ho volá len po úspešnom `validate` nad tým istým stavom (inak `Error`, nič nezmení). */
  apply(world: World): void {
    const { quote, changes } = this.plan(world);
    if (!quote.ok) {
      throw new Error(`${this.type}.apply: príkaz nie je platný (${quote.reasons.join(', ')}) — volaj apply len po úspešnom validate`);
    }
    const entries = this.ledgerEntries(quote);
    for (const change of changes) this.writeCell(world.grid.atIndex(change.index), change);
    world.markRoadsChanged();
    world.events.emit({ type: 'RoadChanged', cells: quote.cells });
    for (const { reason, deltaCents } of entries) world.economy.post(deltaCents, reason);
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

  private plan(world: World): Plan {
    const shape = this.shapeProblems();
    if (shape.length > 0) {
      const quote: RoadQuote = Object.freeze({ ok: false, reasons: orderReasons(new Set(shape)), cells: NO_CELLS, costCents: 0, ...NO_PRICE });
      return { quote, changes: NO_CHANGES };
    }
    const { grid } = world;
    const found = new Set<ValidationReason>();
    const seen = new Set<number>();
    const changed: CellCoord[] = [];
    const changes: PlannedCell[] = [];
    this.cells.forEach(({ x, y }, position) => {
      if (!grid.inBounds(x, y)) {
        found.add('out_of_bounds');
        return;
      }
      const index = grid.index(x, y);
      if (seen.has(index)) return;
      seen.add(index);
      const verdict = this.inspectCell(world, grid.at(x, y), index, position);
      if (verdict === 'skip') return;
      if (verdict.length === 0) {
        changed.push(Object.freeze({ x, y }));
        changes.push(Object.freeze({ x, y, index, position }));
      }
      for (const reason of verdict) found.add(reason);
    });
    if (changed.length === 0 && found.size === 0) found.add('empty');
    const price = this.priceOf(world, changes);
    const costCents = price.buildCents - price.refundCents;
    if (costCents > 0 && costCents > world.cashCents) found.add('insufficient_funds');
    const quote: RoadQuote = Object.freeze({
      ok: found.size === 0,
      reasons: orderReasons(found),
      cells: Object.freeze(changed),
      costCents,
      buildCents: price.buildCents,
      refundCents: price.refundCents,
    });
    return { quote, changes: Object.freeze(changes) };
  }
}
