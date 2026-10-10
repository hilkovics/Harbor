/**
 * Stráž skladu so stohmi pre `CargoLedger.move` (ADR-039 bod 5): ledger pred každým presunom do skladu / zo skladu zavolá
 * `assertCanPlace` / `assertCanTake` (porušenie pravidiel stohu = chyba, nič sa nezmení) a po úspešnom presune `placed` / `taken`,
 * ktorými sklad udržiava odvodenú cache stohov (`StackGrid`). Rozhranie je v `cargo/`, aby ledger nezávisel od modulov;
 * implementuje ho `YardBlock`, svet ho ledgeru zapája cez `CargoLedgerDeps.storageGuard`.
 */
import type { EntityId } from '../core/entity-id';
import type { CargoUnit } from './cargo-unit';

export interface StorageGuard {
  /** Smie sa `unit` uložiť na `slot`? Inak chyba (`ModuleError('stack_rule' | 'invalid_slot' | 'slot_occupied')`). Stav nemení. */
  assertCanPlace(unit: CargoUnit, slot: number): void;
  /** Smie sa `unit` (leží v tomto sklade) odobrať — je navrchu stohu? Inak `ModuleError('not_top')`. Stav nemení. */
  assertCanTake(unit: CargoUnit): void;
  /** Po presune: jednotka leží na `slot`. Nesmie vyhodiť. */
  placed(unit: CargoUnit, slot: number): void;
  /** Po presune: jednotka (podľa polohy pred presunom) opustila sklad. Nesmie vyhodiť. */
  taken(unit: CargoUnit): void;
}

/** Stráž skladu s id `moduleId`, alebo `undefined`, ak sklad nemá stohy (alebo neexistuje). */
export type StorageGuards = (moduleId: EntityId) => StorageGuard | undefined;
