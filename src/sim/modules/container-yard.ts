/**
 * Kontajnerový dvor (ARCHITECTURE §5.3 `container_yard_*`; ADR-017) — sklad kategórie `container`. Sloty = stohové
 * pozície (`params.capacityUnits` = `slots × layers` v manifeste); správanie je celé v `StorageModule`, trieda určuje
 * kategóriu a je miestom pre budúce špecifiká dvora (pravidlo 7, §17).
 */
import { StorageModule } from './storage-module';
import type { ModuleInit } from './module';

/** Kategória nákladu, ktorú dvor skladuje. */
export const CONTAINER_YARD_CATEGORY = 'container';

export class ContainerYard extends StorageModule {
  /** Def musí byť druhu `storage` s `params.category = 'container'` (inak `DefError` / `ModuleError('invalid_input')`). */
  constructor(init: ModuleInit) {
    super(init, CONTAINER_YARD_CATEGORY);
  }
}
