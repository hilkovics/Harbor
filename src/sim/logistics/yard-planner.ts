/**
 * YardPlanner (TOS; ADR-039 bod 7, 8) — vyberá blok a stoh pre každú jednotku, ktorá ide do skladu, a rezervuje jej bunku ako doteraz slot
 * (dispatcher, `SlotReservations`). Výber je deterministický; jediný `Rng` sa používa len v režime `logistics.yardPlanner: "random"`
 * (akceptačný test: planned < 0,3 a random > 1 rehandlov na výber).
 *
 * 1. **Filter:** typ bloku (prázdne do depa, inak bežný blok; fallback ako doteraz — návrat z vnútrozemia len do depa, ak vo svete je),
 *    kategória a smer, voľné TEU, dosiahnuteľnosť po ceste; stoh, ktorý pravidlá dovolia (rovnaká veľkosť, výška < `maxTier`, 40′ na pár stohov).
 * 2. **Segregácia** (`sameGroup`): export `(voyage, cieľový prístav, hmotnostná trieda, veľkosť)`, import podľa odhadu odchodu, prekládka podľa
 *    lode B (kontrakt), prázdne `(linka, veľkosť)`.
 * 3. **Bez zavalenia** (`plannedDepartureTick`): stoh rovnakej skupiny, ktorého vrch odchádza neskôr alebo rovnako → prázdny stoh → stoh inej
 *    skupiny, ktorého vrch odchádza neskôr → inak najmenšia penalizácia (počet kontajnerov, ktoré by sa zavalili); medzi rovnakými vyššie plný stoh.
 * 4. **Vzdialenosť:** bližší blok má prednosť.
 *
 * Poradie porovnania: `(trieda, penalizácia, −výška, [vzdialenosť bay od pôvodného pri rehandlingu], vzdialenosť bloku, id bloku, bay, row)`.
 * Stohy počítajú aj rezervácie rozbehnutých jobov (`YardBlock.effectiveHeight`), takže rezervovaná bunka je platná aj vzhľadom na ostatné rezervácie.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import { teuOf } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { EmptyDepot } from '../modules/empty-depot';
import { LoadingRamp } from '../modules/loading-ramp';
import type { Module } from '../modules/module';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import { emptyReturnRoom } from './empty-stock';
import { distanceBetweenModules } from './module-access';
import { plannedDepartureTick } from './planned-departure';

/** Rezervovaná pozícia v bloku: modul a slot bunky (`YardBlock.slotOf`). */
export interface YardChoice {
  readonly moduleId: EntityId;
  readonly slot: number;
}

/** Trieda stohu pre jednotku (menšie = lepšie). */
const CLASS_SAME_GROUP = 0;
const CLASS_EMPTY = 1;
const CLASS_OTHER_GROUP = 2;
const CLASS_BURY = 3;

/** Kandidát na stoh: skóre a poloha. */
interface Candidate {
  block: YardBlock | undefined;
  cls: number;
  penalty: number;
  height: number;
  bayGap: number;
  distance: number;
  moduleId: number;
  bay: number;
  row: number;
}

const BEST: Candidate = { block: undefined, cls: 0, penalty: 0, height: 0, bayGap: 0, distance: 0, moduleId: 0, bay: 0, row: 0 };
const CURRENT: Candidate = { block: undefined, cls: 0, penalty: 0, height: 0, bayGap: 0, distance: 0, moduleId: 0, bay: 0, row: 0 };
const COLUMN_UNITS: EntityId[] = [];

function resetBest(): void {
  BEST.block = undefined;
}

/** Majú jednotky rovnakú skupinu segregácie (viď hlavička súboru)? */
export function sameGroup(a: CargoUnit, b: CargoUnit): boolean {
  if (a.direction !== b.direction || a.sizeFt !== b.sizeFt) return false;
  switch (a.direction) {
    case 'export':
      return a.voyageId === b.voyageId && a.destinationPort === b.destinationPort && a.weightClass === b.weightClass;
    case 'tranship':
      return a.contractId === b.contractId;
    case 'empty':
      return a.lineId === b.lineId;
    case 'import':
      return true;
  }
}

/** Je kandidát `a` lepší než `b`? Úplné usporiadanie (id bloku, bay, row rozhodnú vždy). */
function better(a: Candidate, b: Candidate): boolean {
  if (a.cls !== b.cls) return a.cls < b.cls;
  if (a.penalty !== b.penalty) return a.penalty < b.penalty;
  if (a.height !== b.height) return a.height > b.height;
  if (a.bayGap !== b.bayGap) return a.bayGap < b.bayGap;
  if (a.distance !== b.distance) return a.distance < b.distance;
  if (a.moduleId !== b.moduleId) return a.moduleId < b.moduleId;
  if (a.bay !== b.bay) return a.bay < b.bay;
  return a.row < b.row;
}

/** Vyplní `into` skóre stohu `(bay, row)` bloku pre `unit`, alebo vráti `false`, ak pravidlá stohu jednotku nepustia. */
function scoreColumn(world: World, block: YardBlock, unit: CargoUnit, bay: number, row: number, into: Candidate, strict: boolean): boolean {
  const { maxTier } = block.geometry;
  const wide = unit.sizeFt === 40;
  const height = block.effectiveHeight(bay, row);
  // Bunka musí ležať v kapacite bloku (def môže kapacitu znížiť pod `bays × rows × maxTier`; sloty sú po stĺpcoch).
  if (height >= maxTier || block.slotOf(bay, row, height) + (wide ? block.geometry.maxTier : 0) >= block.capacity) return false;
  if (wide) {
    if (bay + 1 >= block.geometry.bays || block.effectiveHeight(bay + 1, row) !== height) return false;
    if (height > 0 && (block.effectiveTopSize(bay, row) !== 40 || block.effectiveTopSize(bay + 1, row) !== 40)) return false;
  } else if (height > 0 && block.effectiveTopSize(bay, row) !== 20) {
    return false;
  }
  into.height = height;
  into.penalty = 0;
  if (height === 0) {
    into.cls = CLASS_EMPTY;
    // Prázdny stoh v ešte celom páre bays by zbytočne znemožnil 40′ — radšej stoh v už načatom páre.
    const partner = bay % 2 === 0 ? bay + 1 : bay - 1;
    into.penalty = wide || (partner < block.geometry.bays && block.effectiveHeight(partner, row) === 0) ? 1 : 0;
    return true;
  }
  const departure = plannedDepartureTick(world, unit);
  COLUMN_UNITS.length = 0;
  block.columnUnits(bay, row, COLUMN_UNITS);
  let earlier = 0;
  for (const id of COLUMN_UNITS) {
    const other = world.cargo.get(id);
    if (other === undefined) continue;
    // Kontajner s rozbehnutým jobom zo skladu sa nezavaľuje (kruh čakania: job drží rampu, zavalený by ho vozidlo nevybralo bez rehandlingu).
    if (strict && world.jobOfUnit(id)?.from.kind === 'in_storage') return false;
    if (plannedDepartureTick(world, other) < departure) earlier += 1;
  }
  if (earlier > 0) {
    // Plánovač nezavaľuje skôr odchádzajúci kontajner (bez rehandlingu v bežnom režime); bury ostáva poslednou možnosťou pri rehandlingu a v režime `random`.
    if (strict) return false;
    into.cls = CLASS_BURY;
    into.penalty = earlier;
    return true;
  }
  const topId = block.effectiveTopUnit(bay, row);
  const top = topId === null ? undefined : world.cargo.get(topId);
  into.cls = top !== undefined && sameGroup(top, unit) ? CLASS_SAME_GROUP : CLASS_OTHER_GROUP;
  return true;
}

/** Prejde stohy bloku a najlepší, ktorý je lepší než `BEST`, zapíše do `BEST` (alebo všetky do `onlyCollect`); `origin` (rehandling) vynechá pôvodný stoh. */
function scanBlock(world: World, block: YardBlock, unit: CargoUnit, distance: number, origin: { readonly bay: number; readonly row: number } | undefined, onlyCollect: Candidate[] | undefined, strict: boolean): void {
  const { bays, rows } = block.geometry;
  const wide = unit.sizeFt === 40;
  const step = wide ? 2 : 1;
  for (let row = 0; row < rows; row++) {
    for (let bay = 0; bay < bays; bay += step) {
      if (origin !== undefined && origin.row === row && origin.bay === bay) continue;
      if (!scoreColumn(world, block, unit, bay, row, CURRENT, strict)) continue;
      CURRENT.block = block;
      CURRENT.distance = distance;
      CURRENT.moduleId = block.id;
      CURRENT.bay = bay;
      CURRENT.row = row;
      CURRENT.bayGap = origin === undefined ? 0 : Math.abs(bay - origin.bay);
      if (onlyCollect !== undefined) {
        onlyCollect.push({ ...CURRENT });
      } else if (BEST.block === undefined || better(CURRENT, BEST)) {
        Object.assign(BEST, CURRENT);
      }
    }
  }
}

/** Bloky kandidátov pre jednotku zo zdroja `from` po vrstvách (prvá vrstva s riešením vyhráva); viď hlavička súboru, bod 1. */
function candidateTiers(world: World, unit: CargoUnit, from: Module): YardBlock[][] {
  const category = world.defs.cargoTypes.get(unit.typeId).category;
  const teu = teuOf(unit);
  const depots: YardBlock[] = [];
  const yards: YardBlock[] = [];
  let anyDepot = false;
  for (const module of world.modules.values()) {
    if (!(module instanceof YardBlock) || module.category !== category) continue;
    const isDepot = module instanceof EmptyDepot;
    anyDepot ||= isDepot;
    if (!module.acceptsDirection(unit.direction) || module.freeCount < teu || distanceBetweenModules(world, from, module) === Infinity) continue;
    (isDepot ? depots : yards).push(module);
  }
  if (unit.direction !== 'empty') return [yards];
  if (from instanceof LoadingRamp) return [anyDepot ? depots : yards];
  return [emptyReturnRoom(world, from, category) > 0 ? depots : [], yards];
}

/**
 * Najlepší stoh pre `unit` zo zdroja `from` (viď hlavička súboru), alebo `null`, keď žiadny blok jednotku neprijme (jednotka čaká, kotvisko
 * hlási `NoStorageAvailable`). Stav sveta nemení; v režime `random` spotrebuje `Rng`.
 */
export function chooseYardSlot(world: World, unit: CargoUnit, from: Module): YardChoice | null {
  const random = world.defs.logistics.yardPlanner === 'random';
  for (const blocks of candidateTiers(world, unit, from)) {
    if (random) {
      const all: Candidate[] = [];
      for (const block of blocks) scanBlock(world, block, unit, 0, undefined, all, false);
      if (all.length === 0) continue;
      const pick = all[world.rng.int(0, all.length - 1)];
      return { moduleId: pick.moduleId as EntityId, slot: (pick.block as YardBlock).slotOf(pick.bay, pick.row, pick.height) };
    }
    resetBest();
    for (const block of blocks) scanBlock(world, block, unit, distanceBetweenModules(world, from, block), undefined, undefined, true);
    const best = BEST.block;
    if (best !== undefined) return { moduleId: best.id, slot: best.slotOf(BEST.bay, BEST.row, BEST.height) };
  }
  return null;
}

/** Vyberie stoh (`chooseYardSlot`) a rezervuje jeho bunku; `null` = žiadny blok jednotku neprijme (nič sa nerezervovalo). */
export function reserveYardSlot(world: World, unit: CargoUnit, from: Module): YardChoice | null {
  const choice = chooseYardSlot(world, unit, from);
  if (choice === null) return null;
  (world.modules.get(choice.moduleId) as YardBlock).reserveFor(choice.slot, unit);
  return choice;
}

/**
 * Bunka v tom istom bloku pre kontajner `blocker`, ktorý treba odložiť z `origin` (rehandling, ADR-039 bod 6): prednostne rovnaký bay,
 * stoh, ktorého vrch odchádza neskôr (rovnaké poradie ako `chooseYardSlot`, vždy deterministicky, bez `Rng`; stoh s rezerváciami je povolený); `null`, keď blok nemá pre
 * kontajner iný vhodný stoh.
 */
export function chooseRehandleSlot(world: World, block: YardBlock, blocker: CargoUnit, origin: { readonly bay: number; readonly row: number }): number | null {
  resetBest();
  scanBlock(world, block, blocker, 0, origin, undefined, false);
  // Kontajner sa ukladá na skutočný vrchol stohu; rezervácie rozbehnutých jobov nad ním sa posunú (`YardBlock.vacateReservation`).
  return BEST.block === undefined ? null : block.slotOf(BEST.bay, BEST.row, block.stackHeight(BEST.bay, BEST.row));
}
