/**
 * Zásoba prázdnych kontajnerov prístavu (F6c, ADR-034 + dodatok T6C-02) — dotazy nad modulmi a indexom `World.storedCargo`:
 * - `hasEmptyDepot` — má prístav aspoň jedno depo prázdnych? Tok prázdnych (návrat z vnútrozemia, výdaj exportérovi) sa plánuje len
 *   v takom prístave (dodatok T6C-02, odchýlka 7: bez depa by sa prázdne hromadili v dvore bez východu);
 * - `emptyCargoTypeId` — typ nákladu prázdneho kontajnera (prvý typ kategórie depa, `container`);
 * - `emptyReturnRoom` — koľko ďalších návratov z vnútrozemia depo prijme: Σ voľné miesta dosiahnuteľných dep − rozbehnuté návraty (T6C-07b, M1;
 *   bez depa `Infinity`); krok 8 návrat bez miesta zahodí (`EmptyReturnDeclined`), takže sa bežný dvor prázdnymi nezaplní;
 * - `allocateReturnStorage` — kam uloží prázdny z docku rampy (návrat z vnútrozemia): najbližšie depo s voľným miestom; **fallback do bežného
 *   dvora len keď depo chýba**, inak (depo je, ale nemá miesto alebo je nedosiahnuteľné) prázdny čaká na docku;
 * - `allocateEmptyStorage` — kam uloží prázdny vrátený z apronu (po uzavretí bookingu repositioningu): depo s voľným miestom po odpočítaní
 *   rozbehnutých návratov, inak najbližší bežný dvor (ohraničené počtom slotov apronu — prázdny nesmie navždy blokovať apron);
 * - `countAvailableEmpties` — koľko ich je (loď repositioningu na ne počká, kým nie sú pridelené nakládke);
 * - `findAvailableEmpty` — prázdny kontajner linky, ktorý možno vydať: v sklade, stav `available`, bez aktívneho jobu; depo pred
 *   bežným skladom, v rámci toho najmenšie id (nezávisí od poradia indexu, takže ho obnova save nemení). Obe vedia obmedziť výber na sklady
 *   s cestou k cieľu (`targets`: kotvisko nakládky, rampa výdaja; `load-access.ts`, T6C-07b).
 */
import { EMPTY_WEIGHT_CLASS, type CargoUnit, type CargoUnitLabels } from '../cargo/cargo-unit';
import type { DefRegistry } from '../defs/def-registry';
import type { CargoCategory } from '../defs/types';
import { EMPTY_DEPOT_CATEGORY, EmptyDepot } from '../modules/empty-depot';
import type { Module } from '../modules/module';
import { StorageModule } from '../modules/storage-module';
import type { World } from '../world/world';
import type { EntityId } from '../core/entity-id';
import { storageReaches } from './load-access';
import { distanceBetweenModules } from './module-access';
import type { StorageAllocatorEnv } from './storage-allocator';

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

/** Existuje depo prázdnych kategórie `category`? (Na rozdiel od `hasEmptyDepot` pre konkrétnu kategóriu.) */
function hasDepotOf(env: Pick<StorageAllocatorEnv, 'modules'>, category: CargoCategory): boolean {
  for (const module of env.modules.values()) if (module instanceof EmptyDepot && module.category === category) return true;
  return false;
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

/** Najbližší bežný sklad (nie depo) kategórie `category`, ktorý prijme prázdny kontajner, s voľným miestom dosiahnuteľný zo zdroja `source`. */
function nearestYard(env: StorageAllocatorEnv, source: Module, category: CargoCategory): StorageModule | undefined {
  let best: StorageModule | undefined;
  let bestDistance = Infinity;
  for (const module of env.modules.values()) {
    if (!(module instanceof StorageModule) || module instanceof EmptyDepot || module.category !== category || !module.acceptsDirection('empty') || module.freeCount <= 0) continue;
    const distance = distanceBetweenModules(env, source, module);
    if (distance < bestDistance) {
      best = module;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Prázdne kontajnery, ktoré ešte nemajú rezervované miesto v depe, ale budú ho potrebovať — **rozbehnuté návraty**: jednotka v kamióne
 * misie `delivery` (prešla bránou alebo čaká) a jednotka na docku rampy bez jobu a bez poverenia kamiónom `collect` (čaká na job prijatia).
 * Jednotka s jobom (`in_vehicle`, `at_ramp` s jobom) už drží rezerváciu, takže je v `freeCount` depa. Prechod trucks a ramp — volá sa len pri
 * rozhodovaní o návrate (zriedka), nie v každom ticku.
 */
function emptiesAwaitingDepot(world: World): number {
  let count = 0;
  for (const truck of world.trucks.values()) {
    if (truck.mission !== 'delivery') continue;
    const aboard = world.cargo.countAt('in_truck', truck.id);
    for (let i = 0; i < aboard; i++) {
      const unitId = world.cargo.unitAtIndex('in_truck', truck.id, i);
      if (unitId !== undefined && world.cargo.get(unitId)?.direction === 'empty') count += 1;
    }
  }
  for (const ramp of world.landsideModules.ramps) {
    const docked = world.cargo.countAt('at_ramp', ramp.id);
    for (let i = 0; i < docked; i++) {
      const unitId = world.cargo.unitAtIndex('at_ramp', ramp.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit !== undefined && unit.direction === 'empty' && world.jobOfUnit(unit.id) === undefined && world.emptyFlow.errandOfUnit(unit.id) === undefined) count += 1;
    }
  }
  return count;
}

/** Súčet voľných miest dep kategórie `category` dosiahnuteľných zo zdroja `source`, alebo `undefined`, keď také depo vo svete nie je. */
function depotFreeSlots(env: StorageAllocatorEnv, source: Module, category: CargoCategory): number | undefined {
  let free = 0;
  let depots = 0;
  for (const module of env.modules.values()) {
    if (!(module instanceof EmptyDepot) || module.category !== category) continue;
    depots += 1;
    if (distanceBetweenModules(env, source, module) !== Infinity) free += module.freeCount;
  }
  return depots === 0 ? undefined : free;
}

/**
 * Koľko ďalších návratov prázdneho z vnútrozemia (kamión na rampu `source`) depo kategórie `category` prijme (viď hlavička): Σ voľné miesta
 * dosiahnuteľných dep − rozbehnuté návraty (`emptiesAwaitingDepot`), nie pod 0; vo svete bez depa `Infinity` (platí fallback do dvora).
 */
export function emptyReturnRoom(world: World, source: Module, category: CargoCategory): number {
  const free = depotFreeSlots(world, source, category);
  return free === undefined ? Infinity : Math.max(0, free - emptiesAwaitingDepot(world));
}

/**
 * Sklad pre prázdny kontajner z docku rampy `source` (návrat z vnútrozemia; viď hlavička): najbližšie depo s voľným miestom; bez depa vo svete
 * najbližší bežný sklad kategórie s voľným miestom (`EmptyStored.fallback`); keď depo je, ale nemá miesto alebo je nedosiahnuteľné, `undefined`
 * (prázdny počká na docku — návrat sa pri vzniku kamióna povoľuje len s miestom v depe, takže nastáva len po zmene sveta, napr. zbúranej ceste).
 */
export function allocateReturnStorage(env: StorageAllocatorEnv, source: Module, category: CargoCategory): StorageModule | undefined {
  return nearestDepot(env, source, category) ?? (hasDepotOf(env, category) ? undefined : nearestYard(env, source, category));
}

/**
 * Sklad pre prázdny kontajner vrátený z apronu zo zdroja `source` (viď hlavička): depo s voľným miestom, ktoré nie je sľúbené rozbehnutým
 * návratom (`emptyReturnRoom > 0`), inak najbližší bežný sklad s voľným miestom; inak `undefined` (jednotka čaká na aprone).
 */
export function allocateEmptyStorage(world: World, source: Module, category: CargoCategory): StorageModule | undefined {
  const depot = nearestDepot(world, source, category);
  if (depot !== undefined && emptyReturnRoom(world, source, category) > 0) return depot;
  return nearestYard(world, source, category);
}

/** Rozhodnutie o výbere: depo (0) pred bežným skladom (1). */
function storageRank(world: Pick<World, 'modules'>, unit: CargoUnit): number {
  const holder = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  return holder instanceof EmptyDepot ? 0 : 1;
}

/**
 * Prázdny kontajner linky `lineId`, ktorý možno vydať (viď hlavička), alebo `undefined`. Poškodený a opravovaný kontajner sa
 * nevydáva (stav ≠ `available`), kontajner s aktívnym jobom (pridelený inému kamiónu / nakládke) tiež nie. S `targets` (kotvisko nakládky lode,
 * rampa kamióna `collect`) sa berú len kontajnery zo skladov s cestou k niektorému z nich (T6C-07b, M2: odrezané depo nie je zdrojom). Bez alokácie.
 */
export function findAvailableEmpty(world: Pick<World, 'storedCargo' | 'cargo' | 'modules' | 'jobOfUnit' | 'grid' | 'distances'>, lineId: string, targets?: readonly Module[]): CargoUnit | undefined {
  let best: CargoUnit | undefined;
  let bestRank = Infinity;
  let checkedStorage: EntityId | undefined;
  let reachable = false;
  for (const unitId of world.storedCargo.emptiesOf(lineId)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || unit.status !== 'available' || world.jobOfUnit(unitId) !== undefined) continue;
    const rank = storageRank(world, unit);
    if (best !== undefined && (rank > bestRank || (rank === bestRank && unit.id > best.id))) continue;
    if (targets !== undefined && unit.location.kind === 'in_storage') {
      if (unit.location.moduleId !== checkedStorage) {
        checkedStorage = unit.location.moduleId;
        reachable = storageReaches(world, checkedStorage, targets);
      }
      if (!reachable) continue;
    }
    best = unit;
    bestRank = rank;
  }
  return best;
}

/**
 * Počet prázdnych kontajnerov linky `lineId`, ktoré možno prideliť nakládke (uskladnené, `available`, bez jobu, s cestou k `targets`, ak sú
 * zadané); ako `findAvailableEmpty`, bez alokácie.
 */
export function countAvailableEmpties(world: Pick<World, 'storedCargo' | 'cargo' | 'modules' | 'jobOfUnit' | 'grid' | 'distances'>, lineId: string, targets?: readonly Module[]): number {
  let count = 0;
  let checkedStorage: EntityId | undefined;
  let reachable = false;
  for (const unitId of world.storedCargo.emptiesOf(lineId)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || unit.status !== 'available' || world.jobOfUnit(unitId) !== undefined) continue;
    if (targets !== undefined && unit.location.kind === 'in_storage') {
      if (unit.location.moduleId !== checkedStorage) {
        checkedStorage = unit.location.moduleId;
        reachable = storageReaches(world, checkedStorage, targets);
      }
      if (!reachable) continue;
    }
    count += 1;
  }
  return count;
}
