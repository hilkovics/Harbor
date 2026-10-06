/**
 * Kontajnerový dvor (ARCHITECTURE §5.3 `container_yard_*`; ADR-017, ADR-039) — straddle blok kategórie `container` so stohmi
 * (`bays × rows × maxTier` z `params`); správanie je v `YardBlock`, trieda určuje kategóriu a je miestom pre budúce špecifiká dvora (pravidlo 7, §17).
 */
import { YardBlock } from './yard-block';
import type { ModuleInit } from './module';

/** Kategória nákladu, ktorú dvor skladuje. */
export const CONTAINER_YARD_CATEGORY = 'container';

export class ContainerYard extends YardBlock {
  /** Def musí byť druhu `storage` s `params.category = 'container'` (inak `DefError` / `ModuleError('invalid_input')`). */
  constructor(init: ModuleInit) {
    super(init, CONTAINER_YARD_CATEGORY);
  }
}
