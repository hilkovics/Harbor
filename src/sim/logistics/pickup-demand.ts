/**
 * Dopyt po odvoze (R4, ADR-041 bod 4; nahrádza outbound joby na rampu z ADR-023 a ADR-027): uskladnené jednotky, ktoré smú z prístavu odísť kamiónom (import, vrátený export po uzavretí
 * bookingu, jednotky bez kontraktu), v poradí priority — skupiny `sla` podľa `slaDeadlineTick` ↑, potom id kontraktu ↑; potom `free` kontrakty podľa id ↑ a nakoniec jednotky bez kontraktu;
 * v rámci skupiny FIFO (sklad ↑, v sklade poradie príchodu). Jednotky číta z odvodenej cache `World.storedCargo` (`StoredCargoIndex`, nie je v save).
 *
 * Kandidát (`forEachPickupCandidate`) je jednotka bez jobu (nik si na ňu nenárokoval — kamión ju drží jobom `receive`), nezavalená kontajnerom, ktorý odíde sám, a vybrateľná zo stohu
 * (`unitPickable`, rehandling má kam preložiť). Prázdne kontajnery (`direction: 'empty'`) nie sú náklad na odvoz — dostáva ich kamión `collect` poverením (`logistics/empty-flow.ts`).
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { ContractOutbound } from '../contracts/contract-fsm';
import type { EntityId } from '../core/entity-id';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import type { StoredCargoGroup } from './stored-cargo-index';
import { isRailBound } from './rail-units';
import { unitPickable } from './yard-planner';

/** Znovupoužiteľné pole kontajnerov nad jednotkou pre `blockedByLeavingUnit` (hot path; obsah sa vždy najprv vyprázdni). */
const ABOVE: EntityId[] = [];

/** Znovupoužiteľné pole skupín dopytu (hot path; plní sa pri každom volaní). */
const GROUPS: StoredCargoGroup[] = [];

/** Outbound skupiny uskladneného nákladu: kontrakt jednotiek, alebo bez kontraktu → `free`. */
function outboundOf(world: World, group: StoredCargoGroup): ContractOutbound {
  if (group.contractId === null) return 'free';
  const contract = world.contractBook.get(group.contractId);
  // Kontrakt mimo knihy obnova save odmietne; náklad by inak navždy zaberal sklad. Politiku určuje druh kontraktu (`Contract.outbound`).
  return contract === undefined ? 'free' : contract.outbound;
}

/** Termín kontraktu skupiny (`slaDeadlineTick`), bez neho `Infinity`. */
function deadlineOf(world: World, group: StoredCargoGroup): number {
  return group.contractId === null ? Infinity : (world.contractBook.get(group.contractId)?.slaDeadlineTick ?? Infinity);
}

/** Má skupina `a` prednosť pred `b` (obe smú odísť)? `sla` pred `free`; v `sla` menší termín, potom menšie id kontraktu; vo `free` menšie id a jednotky bez kontraktu na koniec. */
function precedes(world: World, a: StoredCargoGroup, b: StoredCargoGroup): boolean {
  const outboundA = outboundOf(world, a);
  const outboundB = outboundOf(world, b);
  if (outboundA !== outboundB) return outboundA === 'sla';
  if (a.contractId === null) return false;
  if (b.contractId === null) return true;
  if (outboundA === 'sla') {
    const deadlineA = deadlineOf(world, a);
    const deadlineB = deadlineOf(world, b);
    if (deadlineA !== deadlineB) return deadlineA < deadlineB;
  }
  return a.contractId < b.contractId;
}

/** Skupiny, ktoré smú odísť (`ContractOutbound` ≠ `held`), v poradí priority do `GROUPS` (triedenie vkladaním bez alokácie). */
function collectGroups(world: World): readonly StoredCargoGroup[] {
  GROUPS.length = 0;
  for (const group of world.storedCargo.entries) {
    if (outboundOf(world, group) === 'held') continue;
    GROUPS.push(group);
    for (let i = GROUPS.length - 1; i > 0 && precedes(world, GROUPS[i], GROUPS[i - 1]); i--) {
      const swap = GROUPS[i];
      GROUPS[i] = GROUPS[i - 1];
      GROUPS[i - 1] = swap;
    }
  }
  return GROUPS;
}

/** Odíde kontajner `unit` zo skladu sám (nepotrebuje preklad)? Má job zo skladu, alebo je to náklad, ktorý smie odísť. Export booking, prekládka a prázdne čakajú na loď / výdaj. */
export function leavesByItself(world: World, unit: CargoUnit): boolean {
  if (hasLeavingJob(world, unit)) return true;
  if (unit.direction === 'empty') return false;
  const contract = unit.contractId === null ? undefined : world.contractBook.get(unit.contractId);
  return contract === undefined || contract.outbound !== 'held';
}

/** Odíde kontajner `unit` zo skladu práve rozbehnutým jobom (job zo skladu existuje)? */
export function hasLeavingJob(world: World, unit: CargoUnit): boolean {
  return world.jobOfUnit(unit.id)?.from.kind === 'in_storage';
}

/**
 * Zavaľuje jednotku `unit` v bloku so stohmi kontajner, ktorý odíde sám (podľa `leaves`)? Vtedy sa jej nezakladá job / nepriraďuje vozidlo — vybrať sa dá,
 * až keď kontajnery nad ňou odídu (inak by sa zbytočne preskladalo to, čo o chvíľu odíde). Kontajnery, ktoré sami neodídu, sa presúvajú (rehandling).
 */
export function blockedByLeavingUnit(world: World, unit: CargoUnit, leaves: (world: World, unit: CargoUnit) => boolean): boolean {
  const block = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  if (!(block instanceof YardBlock)) return false;
  ABOVE.length = 0;
  block.unitsAbove(unit.id, ABOVE);
  for (const id of ABOVE) {
    const above = world.cargo.get(id);
    if (above !== undefined && leaves(world, above)) return true;
  }
  return false;
}

/**
 * Prejde kandidátov na odvoz v poradí priority (viď hlavička); `visit` vráti `true` = pokračuj, `false` = skonči. Volá sa raz za tick (spawn kamiónov na odvoz) a pri dual transaction —
 * `visit` smie vytvoriť kamión a job (poloha jednotiek v ledgeri sa pritom nemení, takže indexy skupín ostávajú platné), nesmie ale hýbať jednotkami.
 */
export function forEachPickupCandidate(world: World, visit: (unit: CargoUnit, block: YardBlock) => boolean): void {
  for (const group of collectGroups(world)) {
    for (const unitId of group.units) {
      const unit = world.cargo.get(unitId);
      if (unit === undefined || unit.location.kind !== 'in_storage' || unit.direction === 'empty' || world.jobOfUnit(unit.id) !== undefined) continue;
      // Import v buffere železničného terminálu odvezie vlak (RMG), nie kamión (R6, ADR-043 TR6-02).
      if (isRailBound(world, unit)) continue;
      const block = world.modules.get(unit.location.moduleId);
      if (!(block instanceof YardBlock) || blockedByLeavingUnit(world, unit, leavesByItself) || !unitPickable(world, unit)) continue;
      if (!visit(unit, block)) return;
    }
  }
}
