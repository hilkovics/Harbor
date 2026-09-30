/**
 * Jednotka nákladu (ARCHITECTURE §4.1, §5): jedna dávka `quantity = unitsPerBatch` jedného typu (ADR-003).
 * Readonly hodnota — `CargoLedger` pri presune vytvorí novú zmrazenú jednotku s novou `location`, takže objekt
 * získaný z `get()` je snímka, ktorá sa už nezmení.
 */
import type { EntityId } from '../core/entity-id';
import type { CargoLocation } from './cargo-location';

export interface CargoUnit {
  /** Id z `world.ids` (spoločný alokátor všetkých entít). */
  readonly id: EntityId;
  /** Id z `cargo_types.json`. */
  readonly typeId: string;
  /** Kontrakt, ku ktorému jednotka patrí (F4+); `null` = bez kontraktu (napr. ladiaca loď). */
  readonly contractId: EntityId | null;
  /** Množstvo v jednotkách typu (`unitsPerBatch`: 1 TEU, 25 t…). */
  readonly quantity: number;
  /** Jediná poloha jednotky; mení ju výlučne `CargoLedger.move` (pravidlo 2). */
  readonly location: CargoLocation;
}
