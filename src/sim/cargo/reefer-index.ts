/**
 * Index sledovaných reeferov (R5, ADR-042) — odvodená cache pre `systems/reefer-system.ts`, **nie je v save**: vzostupne zoradené id jednotiek so stavom `reefer`, ktoré sa
 * pohli (háčik `CargoLedger.move`), alebo ktoré STS preskočil. Jednotka na palube, ktorá sa nehla a nečaká, nemá čo meniť, takže jej chýbanie v indexe je bez účinku; obnova save
 * zostaví index zo všetkých jednotiek s `reefer` (`rebuild`). Zaniknutú jednotku systém vyradí sám (`remove`).
 */
import type { EntityId } from '../core/entity-id';
import type { CargoUnit } from './cargo-unit';

export class ReeferIndex {
  private readonly sorted: EntityId[] = [];

  /** Počet sledovaných jednotiek. */
  get size(): number {
    return this.sorted.length;
  }

  /** Sledované id vzostupne (kópia — dá sa iterovať počas `remove`). */
  ids(): readonly EntityId[] {
    return [...this.sorted];
  }

  /** Je jednotka v indexe (binárne vyhľadanie)? */
  has(unitId: EntityId): boolean {
    let low = 0;
    let high = this.sorted.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (this.sorted[mid] === unitId) return true;
      if (this.sorted[mid] < unitId) low = mid + 1;
      else high = mid - 1;
    }
    return false;
  }

  /** Zaradí jednotku (binárne vyhľadanie; duplicita sa ignoruje). */
  add(unitId: EntityId): void {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.sorted[mid] < unitId) low = mid + 1;
      else high = mid;
    }
    if (this.sorted[low] !== unitId) this.sorted.splice(low, 0, unitId);
  }

  /** Vyradí jednotku; neznáma sa ignoruje. */
  remove(unitId: EntityId): void {
    const at = this.sorted.indexOf(unitId);
    if (at >= 0) this.sorted.splice(at, 1);
  }

  /** Obnova zo save: všetky jednotky s `reefer !== null`. */
  rebuild(units: Iterable<CargoUnit>): void {
    this.sorted.length = 0;
    for (const unit of units) if (unit.reefer !== null) this.add(unit.id);
  }
}
