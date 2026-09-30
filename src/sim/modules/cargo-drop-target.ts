/**
 * Cieľ doručenia jednotky vozidlom (ARCHITECTURE §7.3 bod 4, §7.7; ADR-018, ADR-022, ADR-023) — miesto u modulu, ktoré
 * transportný job rezervuje pri vzniku a vozidlo pri vykládke premení na obsadenie: slot skladu (`in_storage`, inbound)
 * alebo dock rampy (`at_ramp`, outbound). Generický kód (vykládka vo `VehicleSystem`, zrušenie jobu v dispatcheri,
 * obnova rezervácií zo save, invarianty kroku 12) sa pýta `Module.cargoDropTarget()`, nie `instanceof` (pravidlo 7).
 *
 * „Miesto" (`place`) je číslo z lokácie jobu `to` podľa `CARGO_HOLDER_SPECS[kind].slotKey` (`slot`, `dock`). Rezervácie
 * patria jobom: každý aktívny job drží jednu rezerváciu na miesto svojej jednotky (ADR-018, ADR-023), preto sa do save
 * neukladajú — obnova ich vytvorí z `to` jobov (`restoreReservation`).
 *
 * Tok: vznik jobu (konkrétna trieda: `StorageModule.reserve()`, `LoadingRamp.reserve(dock)`) → vozidlo pri vykládke
 * `assertCommittable(place, unit)` → `CargoLedger.move(unit, job.to)` → `commit(place, unit)`; zrušený job
 * `release(place)`. Operácie sú atomické ako pri module (pri chybe `ModuleError` sa nič nezmení).
 */
import type { CargoHolderKind } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';

export interface CargoDropTarget {
  /** Druh lokácie cieľa (`job.to.kind`): `in_storage` (sklad), `at_ramp` (rampa). */
  readonly kind: CargoHolderKind;
  /** Kategória nákladu, ktorú cieľ prijíma. */
  readonly category: CargoCategory;
  /** Počet miest (slotov skladu, dockov rampy) — platné miesto je celé `0 … places − 1`. */
  readonly places: number;
  /** Rezervácie na mieste (slot skladu 0/1, dock rampy 0…`stagingPerDock`); miesto mimo rozsahu → 0 (bez chyby). */
  reservationsAt(place: number): number;
  /** Rezervuje konkrétne miesto — obnova zo save podľa aktívneho jobu; chyby ako rezervácia modulu (`ModuleError`). */
  restoreReservation(place: number): void;
  /** Zruší rezerváciu miesta (zrušený job). */
  release(place: number): void;
  /** Kontrola pred `CargoLedger.move(unit, job.to)`, bez zmeny stavu. */
  assertCommittable(place: number, unitId: EntityId): void;
  /** Po presune na miesto: rezervácia zaniká (sklad navyše `unitsIn += 1`). */
  commit(place: number, unitId: EntityId): void;
}
