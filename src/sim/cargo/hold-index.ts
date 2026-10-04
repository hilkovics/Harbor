/**
 * Index zadržaných jednotiek (VGM hold, ADR-032 bod 5, 7) — odvodená cache pre krok 2, **nie je v save**: zoznam
 * `(untilTick, unitId)` vzostupne, z ktorého `ContractSystem` v ticku `≥ untilTick` uvoľní hold bez skenu ledgera. Plní ho
 * brána (`add` po `CargoLedger.setHold`), obnova save ho zostaví z jednotiek s `hold !== null` (`rebuild`), poradie je
 * teda deterministické a obnovený svet uvoľňuje holdy rovnako ako originál.
 */
import type { EntityId } from '../core/entity-id';
import type { CargoUnit } from './cargo-unit';

/** Záznam indexu: do ktorého ticku je jednotka zadržaná. */
export interface HoldEntry {
  readonly untilTick: number;
  readonly unitId: EntityId;
}

/** Porovnanie podľa (`untilTick`, `unitId`). */
function compare(a: HoldEntry, b: HoldEntry): number {
  return a.untilTick !== b.untilTick ? a.untilTick - b.untilTick : a.unitId - b.unitId;
}

export class HoldIndex {
  private entries: HoldEntry[] = [];

  /** Počet zadržaných jednotiek v indexe (= jednotky s `hold !== null`, kontroluje krok 12). */
  get size(): number {
    return this.entries.length;
  }

  /** Zadržané jednotky vzostupne podľa (`untilTick`, id) — pre kontrolu a testy (kópia). */
  get all(): readonly HoldEntry[] {
    return [...this.entries];
  }

  /** Zaradí jednotku zadržanú do `untilTick` (binárne vyhľadanie pozície; duplicita rovnakej jednotky sa nekontroluje). */
  add(untilTick: number, unitId: EntityId): void {
    const entry: HoldEntry = { untilTick, unitId };
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compare(this.entries[mid], entry) < 0) low = mid + 1;
      else high = mid;
    }
    this.entries.splice(low, 0, entry);
  }

  /**
   * Vyberie záznamy s `untilTick ≤ tick` (vzostupne) do `into` (najprv ho nezmení — pridáva na koniec) a z indexu ich
   * odstráni. Bez splatných záznamov nič nealokuje.
   */
  takeDue(tick: number, into: HoldEntry[]): void {
    let due = 0;
    while (due < this.entries.length && this.entries[due].untilTick <= tick) due += 1;
    if (due === 0) return;
    for (let i = 0; i < due; i++) into.push(this.entries[i]);
    this.entries.splice(0, due);
  }

  /** Zostaví index nanovo z jednotiek (obnova save): len jednotky s `hold !== null`. */
  rebuild(units: Iterable<CargoUnit>): void {
    this.entries = [];
    for (const unit of units) {
      if (unit.hold !== null) this.entries.push({ untilTick: unit.hold.untilTick, unitId: unit.id });
    }
    this.entries.sort(compare);
  }
}
