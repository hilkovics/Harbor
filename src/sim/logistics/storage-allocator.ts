/**
 * StorageAllocator (ARCHITECTURE §7.3 bod 1, §7.7; rozhodnutie orchestrátora F3 č. 6; ADR-018) — výber skladu pre
 * jednotku z kotviska (inbound).
 *
 * Kandidát = `StorageModule` s kategóriou nákladu, ktorý prijme smer jednotky (`acceptsDirection` — depo prázdnych
 * neprijme import, F6c, ADR-034), voľnou kapacitou (`stored + reserved < capacity`, t. j. `freeCount > 0`),
 * pripojený k ceste a dosiahnuteľný po ceste zo zdroja. Vyhráva najmenšia cestná vzdialenosť
 * zdroj → sklad (`distanceBetweenModules`, `DistanceMatrix`), pri zhode menšie id (moduly sa prechádzajú vzostupne
 * podľa id a berie sa len ostro menšia vzdialenosť). Rezerváciu slotu robí volajúci (`StorageModule.reserve`) — výber
 * sám svet nemení a nealokuje.
 */
import type { CargoDirection } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import type { Module } from '../modules/module';
import { StorageModule } from '../modules/storage-module';
import { distanceBetweenModules, type ModuleAccessEnv } from './module-access';

/** Časť sveta, ktorú alokátor číta (`World` ju spĺňa). */
export interface StorageAllocatorEnv extends ModuleAccessEnv {
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/**
 * Najbližší vhodný sklad pre náklad kategórie `category` a smeru `direction` (predvolene `import`) zo zdroja `source` (viď
 * hlavička); inak `undefined`.
 */
export function allocateStorage(env: StorageAllocatorEnv, source: Module, category: CargoCategory, direction: CargoDirection = 'import'): StorageModule | undefined {
  let best: StorageModule | undefined;
  let bestDistance = Infinity;
  for (const module of env.modules.values()) {
    if (!(module instanceof StorageModule) || module.category !== category || !module.acceptsDirection(direction) || module.freeCount <= 0) continue;
    const distance = distanceBetweenModules(env, source, module);
    if (distance < bestDistance) {
      best = module;
      bestDistance = distance;
    }
  }
  return best;
}
