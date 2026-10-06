/**
 * Zásoba prázdnych kontajnerov prístavu (F6c, ADR-034 + dodatok T6C-02) — dotazy nad modulmi a indexom `World.storedCargo`:
 * - `hasEmptyDepot` — má prístav aspoň jedno depo prázdnych? Tok prázdnych (návrat z vnútrozemia, výdaj exportérovi) sa plánuje len
 *   v takom prístave (dodatok T6C-02, odchýlka 7: bez depa by sa prázdne hromadili v dvore bez východu);
 * - `emptyCargoTypeId` — typ nákladu prázdneho kontajnera (prvý typ kategórie depa, `container`);
 * - `emptyReturnRoom` — koľko ďalších návratov z vnútrozemia depo prijme: Σ voľné miesta dosiahnuteľných dep − rozbehnuté návraty (T6C-07b, M1;
 *   bez depa `Infinity`); krok 8 návrat bez miesta zahodí (`EmptyReturnDeclined`), takže sa bežný dvor prázdnymi nezaplní;
 * - kam sa prázdny uloží (depo / fallback do dvora) rozhoduje `YardPlanner` (`logistics/yard-planner.ts`, `candidateTiers`); staré alokátory
 *   `allocateReturnStorage` a `allocateEmptyStorage` odstránil TR2-06b;
 * - `countAvailableEmpties` — koľko ich je (loď repositioningu na ne počká, kým nie sú pridelené nakládke);
 * - `findAvailableEmpty` — prázdny kontajner linky, ktorý možno vydať: v sklade, stav `available`, bez aktívneho jobu; depo pred
 *   bežným skladom, v rámci toho kontajner navrchu stohu (najmenej kontajnerov nad ním, ADR-039), potom najmenšie id (nezávisí od poradia indexu, takže ho obnova save nemení). Obe vedia obmedziť výber na sklady
 *   s cestou k cieľu (`targets`: kotvisko nakládky, rampa výdaja; `load-access.ts`, T6C-07b).
 */
import { DEFAULT_CONTAINER_LABELS, EMPTY_WEIGHT_CLASS, teuOf, type CargoUnit, type CargoUnitLabels, type ContainerSize } from '../cargo/cargo-unit';
import type { DefRegistry } from '../defs/def-registry';
import type { CargoCategory } from '../defs/types';
import { EMPTY_DEPOT_CATEGORY, EmptyDepot } from '../modules/empty-depot';
import type { Module } from '../modules/module';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import type { EntityId } from '../core/entity-id';
import { storageReaches } from './load-access';
import { distanceBetweenModules } from './module-access';
import type { ModuleAccessEnv } from './module-access';

/** Má svet aspoň jedno depo prázdnych (modul `EmptyDepot`)? O(moduly) — volá sa pri plánovaní, nie v hot path ticku. */
export function hasEmptyDepot(world: Pick<World, 'modules'>): boolean {
  for (const module of world.modules.values()) if (module instanceof EmptyDepot) return true;
  return false;
}

/** Typ nákladu prázdneho kontajnera podľa registra defov (memo — `DefRegistry` je po vytvorení nemenný; krok 8 ho pýta pri každom splatnom návrate / výdaji). */
const EMPTY_CARGO_TYPES = new WeakMap<DefRegistry, string | undefined>();

/** Typ nákladu prázdneho kontajnera: prvý typ v poradí `cargo_types.json`, ktorého kategória je kategória depa prázdnych. */
export function emptyCargoTypeId(defs: DefRegistry): string | undefined {
  if (EMPTY_CARGO_TYPES.has(defs)) return EMPTY_CARGO_TYPES.get(defs);
  let typeId: string | undefined;
  for (const def of defs.cargoTypes.items) {
    if (def.category !== EMPTY_DEPOT_CATEGORY) continue;
    typeId = def.id;
    break;
  }
  EMPTY_CARGO_TYPES.set(defs, typeId);
  return typeId;
}

/**
 * Štítky novej jednotky prázdneho kontajnera linky `lineId` (bez kontraktu, voyage a prístavu; hmotnostná trieda bez `Rng`). Veľkosť `sizeFt` zdedí
 * od importu, ktorý odišiel (`ReturnPlanEntry.sizeFt`, ADR-039); typ `dry` a bez nadrozmeru.
 */
export function emptyLabels(lineId: string, sizeFt: ContainerSize = DEFAULT_CONTAINER_LABELS.sizeFt): CargoUnitLabels {
  return { direction: 'empty', voyageId: null, lineId, destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS, ...DEFAULT_CONTAINER_LABELS, sizeFt };
}

/**
 * Prázdne kontajnery (v TEU — 40′ zaberá 2 bunky depa), ktoré ešte nemajú rezervované miesto v depe, ale budú ho potrebovať — **rozbehnuté návraty**: jednotka v kamióne
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
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit?.direction === 'empty') count += teuOf(unit);
    }
  }
  for (const ramp of world.landsideModules.ramps) {
    const docked = world.cargo.countAt('at_ramp', ramp.id);
    for (let i = 0; i < docked; i++) {
      const unitId = world.cargo.unitAtIndex('at_ramp', ramp.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit !== undefined && unit.direction === 'empty' && world.jobOfUnit(unit.id) === undefined && world.emptyFlow.errandOfUnit(unit.id) === undefined) count += teuOf(unit);
    }
  }
  return count;
}

/** Časť sveta, ktorú čítajú dotazy na depá (`World` ju spĺňa). */
interface DepotEnv extends ModuleAccessEnv {
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/** Súčet voľných miest dep kategórie `category` dosiahnuteľných zo zdroja `source`, alebo `undefined`, keď také depo vo svete nie je. */
export function depotFreeSlots(env: DepotEnv, source: Module, category: CargoCategory): number | undefined {
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

/** Rozhodnutie o výbere: depo (0) pred bežným skladom (1). */
function storageRank(world: Pick<World, 'modules'>, unit: CargoUnit): number {
  const holder = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  return holder instanceof EmptyDepot ? 0 : 1;
}

/** Počet kontajnerov nad jednotkou v jej bloku so stohmi (0 = navrchu alebo mimo bloku). */
function burialOf(world: Pick<World, 'modules'>, unit: CargoUnit): number {
  const holder = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  return holder instanceof YardBlock ? holder.burialDepth(unit.id) : 0;
}

/**
 * Prázdny kontajner linky `lineId`, ktorý možno vydať (viď hlavička), alebo `undefined`. Poškodený a opravovaný kontajner sa
 * nevydáva (stav ≠ `available`), kontajner s aktívnym jobom (pridelený inému kamiónu / nakládke) tiež nie. S `targets` (kotvisko nakládky lode,
 * rampa kamióna `collect`) sa berú len kontajnery zo skladov s cestou k niektorému z nich (T6C-07b, M2: odrezané depo nie je zdrojom). Bez alokácie.
 */
export function findAvailableEmpty(world: Pick<World, 'storedCargo' | 'cargo' | 'modules' | 'jobOfUnit' | 'grid' | 'distances'>, lineId: string, targets?: readonly Module[]): CargoUnit | undefined {
  let best: CargoUnit | undefined;
  let bestRank = Infinity;
  let bestDepth = Infinity;
  let checkedStorage: EntityId | undefined;
  let reachable = false;
  for (const unitId of world.storedCargo.emptiesOf(lineId)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || unit.status !== 'available' || world.jobOfUnit(unitId) !== undefined) continue;
    const rank = storageRank(world, unit);
    if (best !== undefined && rank > bestRank) continue;
    // V rámci poradia skladu prednosť kontajneru navrchu stohu (menej kontajnerov nad ním = menej rehandlingu), potom najmenšie id.
    const depth = burialOf(world, unit);
    if (best !== undefined && rank === bestRank && (depth > bestDepth || (depth === bestDepth && unit.id > best.id))) continue;
    if (targets !== undefined && unit.location.kind === 'in_storage') {
      if (unit.location.moduleId !== checkedStorage) {
        checkedStorage = unit.location.moduleId;
        reachable = storageReaches(world, checkedStorage, targets);
      }
      if (!reachable) continue;
    }
    best = unit;
    bestRank = rank;
    bestDepth = depth;
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
