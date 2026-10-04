/**
 * Zásoba prázdnych kontajnerov prístavu (F6c, ADR-034 + dodatok T6C-02) — dotazy nad modulmi a indexom `World.storedCargo`:
 * - `hasEmptyDepot` — má prístav aspoň jedno depo prázdnych? Tok prázdnych (návrat z vnútrozemia, výdaj exportérovi) sa plánuje len
 *   v takom prístave (dodatok T6C-02, odchýlka 7: bez depa by sa prázdne hromadili v dvore bez východu);
 * - `emptyCargoTypeId` — typ nákladu prázdneho kontajnera (prvý typ kategórie depa, `container`);
 * - `allocateEmptyStorage` — kam uloží prázdny z rampy: najbližšie depo s voľným miestom; **fallback** (depo chýba, je plné alebo
 *   nedosiahnuteľné) najbližší bežný sklad kategórie s voľným miestom (`EmptyStored.fallback`);
 * - `findAvailableEmpty` — prázdny kontajner linky, ktorý možno vydať: v sklade, stav `available`, bez aktívneho jobu; depo pred
 *   bežným skladom, v rámci toho najmenšie id (nezávisí od poradia indexu, takže ho obnova save nemení).
 */
import { EMPTY_WEIGHT_CLASS, type CargoUnit, type CargoUnitLabels } from '../cargo/cargo-unit';
import type { DefRegistry } from '../defs/def-registry';
import type { CargoCategory } from '../defs/types';
import { EMPTY_DEPOT_CATEGORY, EmptyDepot } from '../modules/empty-depot';
import type { Module } from '../modules/module';
import { StorageModule } from '../modules/storage-module';
import type { World } from '../world/world';
import { distanceBetweenModules } from './module-access';
import { allocateStorage, type StorageAllocatorEnv } from './storage-allocator';

/** Má svet aspoň jedno depo prázdnych (modul `EmptyDepot`)? O(moduly) — volá sa pri plánovaní, nie v hot path ticku. */
export function hasEmptyDepot(world: Pick<World, 'modules'>): boolean {
  for (const module of world.modules.values()) if (module instanceof EmptyDepot) return true;
  return false;
}

/** Typ nákladu prázdneho kontajnera: prvý typ v poradí `cargo_types.json`, ktorého kategória je kategória depa prázdnych. */
export function emptyCargoTypeId(defs: DefRegistry): string | undefined {
  return defs.cargoTypes.items.find((def) => def.category === EMPTY_DEPOT_CATEGORY)?.id;
}

/** Štítky novej jednotky prázdneho kontajnera linky `lineId` (bez kontraktu, voyage a prístavu; hmotnostná trieda bez `Rng`). */
export function emptyLabels(lineId: string): CargoUnitLabels {
  return { direction: 'empty', voyageId: null, lineId, destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS };
}

/** Najbližšie depo prázdnych kategórie `category` s voľným miestom dosiahnuteľné zo zdroja `source`; inak `undefined`. */
function nearestDepot(env: StorageAllocatorEnv, source: Module, category: CargoCategory): EmptyDepot | undefined {
  let best: EmptyDepot | undefined;
  let bestDistance = Infinity;
  for (const module of env.modules.values()) {
    if (!(module instanceof EmptyDepot) || module.category !== category || module.freeCount <= 0) continue;
    const distance = distanceBetweenModules(env, source, module);
    if (distance < bestDistance) {
      best = module;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Sklad pre prázdny kontajner z rampy `source` (viď hlavička): najbližšie depo s voľným miestom, inak najbližší bežný sklad
 * kategórie s voľným miestom (`allocateStorage` pre smer `empty` — depo, ktoré je plné, preskočí); inak `undefined` (prázdny
 * ostane na docku a kamión s prázdnym vtedy čaká v stojisku — nič sa nestratí).
 */
export function allocateEmptyStorage(env: StorageAllocatorEnv, source: Module, category: CargoCategory): StorageModule | undefined {
  return nearestDepot(env, source, category) ?? allocateStorage(env, source, category, 'empty');
}

/** Rozhodnutie o výbere: depo (0) pred bežným skladom (1). */
function storageRank(world: Pick<World, 'modules'>, unit: CargoUnit): number {
  const holder = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  return holder instanceof EmptyDepot ? 0 : 1;
}

/**
 * Prázdny kontajner linky `lineId`, ktorý možno vydať (viď hlavička), alebo `undefined`. Poškodený a opravovaný kontajner sa
 * nevydáva (stav ≠ `available`), kontajner s aktívnym jobom (pridelený inému kamiónu / nakládke) tiež nie. Bez alokácie.
 */
export function findAvailableEmpty(world: Pick<World, 'storedCargo' | 'cargo' | 'modules' | 'jobOfUnit'>, lineId: string): CargoUnit | undefined {
  let best: CargoUnit | undefined;
  let bestRank = Infinity;
  for (const unitId of world.storedCargo.emptiesOf(lineId)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || unit.status !== 'available' || world.jobOfUnit(unitId) !== undefined) continue;
    const rank = storageRank(world, unit);
    if (best === undefined || rank < bestRank || (rank === bestRank && unit.id < best.id)) {
      best = unit;
      bestRank = rank;
    }
  }
  return best;
}
