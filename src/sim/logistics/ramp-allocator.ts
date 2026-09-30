/**
 * RampAllocator (ARCHITECTURE §7.3 bod 2, §7.5; rozhodnutia orchestrátora F4 č. 1 a 4; ADR-022, ADR-023) — výber rampy
 * pre outbound job zo skladu.
 *
 * Kandidát = `LoadingRamp` s kategóriou nákladu, voľným staging miestom (`freeCount > 0`, t. j. niektorý dock má
 * `staged + reserved < stagingPerDock`), **prevádzková** (`isRampOperational`: cesta portál → brána → stojisko → rampa,
 * ADR-022) a dosiahnuteľná po ceste zo skladu. Vyhráva najmenšia cestná vzdialenosť sklad → rampa
 * (`distanceBetweenModules`, `DistanceMatrix`), pri zhode menšie id (kandidáti idú vzostupne podľa id a berie sa len
 * ostro menšia vzdialenosť). Rezerváciu miesta robí volajúci (`LoadingRamp.reserve(firstFreeDock())`) — výber sám svet
 * nemení a nealokuje.
 */
import type { EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import { LoadingRamp } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import { distanceBetweenModules, type ModuleAccessEnv } from './module-access';

/** Časť sveta, ktorú alokátor číta (`World` ju spĺňa). */
export interface RampAllocatorEnv extends ModuleAccessEnv {
  readonly modules: ReadonlyMap<EntityId, Module>;
  /** Aktuálna prevádzkovosť rampy (ADR-022) — bez alokácie pri nezmenenej sieti. */
  isRampOperational(ramp: Module): boolean;
}

/** Môže rampa ešte dostať outbound job pre náklad kategórie `category` (bez ohľadu na zdroj)? */
export function acceptsOutbound(env: RampAllocatorEnv, ramp: LoadingRamp, category: CargoCategory): boolean {
  return ramp.category === category && ramp.freeCount > 0 && env.isRampOperational(ramp);
}

/**
 * Najbližšia vhodná rampa (viď hlavička) pre náklad kategórie `category` zo skladu `source`; inak `undefined`.
 * `candidates` (predvolene všetky moduly sveta vzostupne podľa id) môže byť predvýber rámp v tom istom poradí —
 * dispatcher ich zbiera raz za tick (`collectOutboundRamps`); podmienky kandidáta sa overia aj tak.
 */
export function allocateRamp(
  env: RampAllocatorEnv,
  source: Module,
  category: CargoCategory,
  candidates: Iterable<Module> = env.modules.values(),
): LoadingRamp | undefined {
  let best: LoadingRamp | undefined;
  let bestDistance = Infinity;
  for (const module of candidates) {
    if (!(module instanceof LoadingRamp) || !acceptsOutbound(env, module, category)) continue;
    const distance = distanceBetweenModules(env, source, module);
    if (distance < bestDistance) {
      best = module;
      bestDistance = distance;
    }
  }
  return best;
}
