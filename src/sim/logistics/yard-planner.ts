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
 *    skupiny, ktorého vrch odchádza neskôr, medzi nimi najtesnejšie pasujúci (`gap`) → inak najmenšia penalizácia (počet kontajnerov, ktoré by sa zavalili) —
 *    zavalenie len v bloku, ktorý ostane voľný aspoň na `logistics.buryReserveColumns` stĺpcov (rehandling potrebuje kam preložiť; kontajner s jobom sa nezavaľuje nikdy);
 *    bez vhodného stohu jednotka čaká (`null`, `NoStorageAvailable`).
 * 3b. **Typy (R5, ADR-042):** reefer len do bloku so zásuvkami a len na stoh so zásuvkou (a ten blok prijíma len reefery), OOG len do bloku, ktorý ho prijíma; na flat rack ani na OOG sa neukladá.
 * 4. **Vzdialenosť:** bližší blok má prednosť; vzdialenosť bloku s RTG sa zväčší o `logistics.yardMachineLoadWeight` × (fronta stroja + rozbehnutý cyklus), takže
 *    práca sa rozloží medzi stroje (ADR-040 dodatok TR3-02c); bloky bez stroja (strádl) sa nemenia.
 *
 * Poradie porovnania: `(trieda, [penalizácia zavalenia], vzdialenosť bloku, rozdiel odchodu vrchu (najtesnejšie pasujúci stoh), [vzdialenosť bay od pôvodného pri rehandlingu], penalizácia, plnenie stohu, id bloku, bay, row)`.
 * Stohy počítajú aj rezervácie rozbehnutých jobov (`YardBlock.effectiveHeight`), takže rezervovaná bunka je platná aj vzhľadom na ostatné rezervácie.
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import { needsPlug, teuOf } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { EmptyDepot } from '../modules/empty-depot';
import { RailTerminal } from '../modules/rail-terminal';
import { TruckGate } from '../modules/truck-gate';
import type { Module } from '../modules/module';
import { YardBlock, coversBlocked } from '../modules/yard-block';
import type { World } from '../world/world';
import { emptyReturnRoom } from './empty-stock';
import { distanceBetweenModules } from './module-access';
import { plannedDepartureTick } from './planned-departure';
import { railTerminalTakes } from './rail-units';

/** Rezervovaná pozícia v bloku: modul a slot bunky (`YardBlock.slotOf`). */
export interface YardChoice {
  readonly moduleId: EntityId;
  readonly slot: number;
}

/** Triedy stohu pre jednotku (menšie = lepšie): rovnaká skupina, prázdny stoh, iná skupina, zavalenie (len rehandling / `random`). */
interface ClassRanks {
  readonly sameGroup: number;
  readonly empty: number;
  readonly otherGroup: number;
}

const CLASS_BURY = 3;

/**
 * Režim výberu stohu: `place` bežné ukladanie plánovačom (nezavaľuje kontajner s jobom ani pri nízkej voľnej kapacite bloku), `relocate` preklad
 * kontajnera nad cieľom (rehandling — zavaľuje len v nevyhnutnosti, nikdy kontajner, ktorý práve nakladá vozidlo), `random` náhodné ukladanie.
 */
type PlacementMode = 'place' | 'relocate' | 'random';

/**
 * Poradie tried podľa smeru: náklad, ktorý stojí v sklade (export, prekládka, prázdne), sa skladá do stohu svojej skupiny skôr než do prázdneho (aj vo
 * vzdialenejšom bloku). Import odchádza kamiónom hneď po vykládke, preto sa najprv rozloží po prázdnych stohoch (aj medzi blokmi — rozloží dopravu
 * k prístupovým bunkám; stoh sa vyberá po jednej jednotke zhora, vrstvenie by zdržalo odvoz) a vrství sa až keď prázdne stohy dôjdu.
 */
const CLASS_RANKS: { readonly [D in CargoUnit['direction']]: ClassRanks } = {
  import: { empty: 0, sameGroup: 1, otherGroup: 2 },
  export: { sameGroup: 0, empty: 1, otherGroup: 2 },
  tranship: { sameGroup: 0, empty: 1, otherGroup: 2 },
  empty: { sameGroup: 0, empty: 1, otherGroup: 2 },
};

/** Kandidát na stoh: skóre a poloha. */
interface Candidate {
  block: YardBlock | undefined;
  cls: number;
  penalty: number;
  /** Výška stohu (vrátane rezervácií) = vrstva, na ktorú sa ukladá. */
  height: number;
  /** Rozdiel odchodu vrchu stohu a jednotky (najtesnejšie pasujúci stoh nechá ostatným voľnejšie): menšie = lepšie; prázdny stoh 0. */
  gap: number;
  /** Poradie plnenia stohu pri rovnakej triede: import radšej nižší stoh (rozloženie), ostatné vyšší (zhustenie). */
  fill: number;
  bayGap: number;
  distance: number;
  moduleId: number;
  bay: number;
  row: number;
}

const BEST: Candidate = { block: undefined, cls: 0, penalty: 0, height: 0, fill: 0, gap: 0, bayGap: 0, distance: 0, moduleId: 0, bay: 0, row: 0 };
const CURRENT: Candidate = { block: undefined, cls: 0, penalty: 0, height: 0, fill: 0, gap: 0, bayGap: 0, distance: 0, moduleId: 0, bay: 0, row: 0 };
const COLUMN_UNITS: EntityId[] = [];

/** Kam `scanBlock` zapisuje kandidátov: `best` = najlepší do `BEST`, `room` = súčet voľných vrstiev do `roomSum` (bez alokácie), pole = všetkých (režim `random`). */
type Sink = 'best' | 'room' | Candidate[];

/** Súčet voľných vrstiev stohov z posledného `scanBlock` so `sink = 'room'` (`rehandleRoom`; jedno vlákno simulácie, vždy sa najprv vynuluje). */
let roomSum = 0;

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
  if (a.cls === CLASS_BURY && a.penalty !== b.penalty) return a.penalty < b.penalty;
  if (a.distance !== b.distance) return a.distance < b.distance;
  if (a.gap !== b.gap) return a.gap < b.gap;
  if (a.bayGap !== b.bayGap) return a.bayGap < b.bayGap;
  if (a.penalty !== b.penalty) return a.penalty < b.penalty;
  if (a.fill !== b.fill) return a.fill < b.fill;
  if (a.moduleId !== b.moduleId) return a.moduleId < b.moduleId;
  if (a.bay !== b.bay) return a.bay < b.bay;
  return a.row < b.row;
}

/** Vyplní `into` skóre stohu `(bay, row)` bloku pre `unit`, alebo vráti `false`, ak pravidlá stohu jednotku nepustia. */
function scoreColumn(world: World, block: YardBlock, unit: CargoUnit, bay: number, row: number, into: Candidate, mode: PlacementMode): boolean {
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
  // Pravidlá typov (R5, ADR-042): reefer len na stohu so zásuvkou; na flat rack ani na OOG nič neukladáme.
  if (needsPlug(unit, world.defs.containerTypes) && !block.isPowered(bay, row)) return false;
  if (height > 0) {
    const coverId = block.effectiveTopUnit(bay, row);
    const cover = coverId === null ? undefined : world.cargo.get(coverId);
    if (cover !== undefined && coversBlocked(cover, world.cargo.containerTypeOf(cover.id))) return false;
  }
  into.height = height;
  into.fill = unit.direction === 'import' ? height : -height;
  into.penalty = 0;
  into.gap = 0;
  if (height === 0) {
    into.cls = CLASS_RANKS[unit.direction].empty;
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
    // Kontajner s rozbehnutým jobom zo skladu sa nezavaľuje (kruh čakania: job drží rampu, zavalený by ho vozidlo nevybralo bez rehandlingu); pri rehandlingu
    // a v režime `random` aspoň ten, ktorý práve nakladá vozidlo (inak sa dve vozidlá striedavo zavaľujú ping-pongom).
    const job = world.jobOfUnit(id);
    if (job?.from.kind === 'in_storage' && (mode === 'place' || job.state === 'picking')) return false;
    if (plannedDepartureTick(world, other) < departure) earlier += 1;
  }
  if (earlier > 0) {
    // Zavalenie skôr odchádzajúceho kontajnera je poslednou možnosťou („najmenšia penalizácia“). Pri bežnom ukladaní len keď blok ostane voľný aspoň na
    // `logistics.buryReserveColumns` stĺpcov (def) — inak by rehandling nemal kam preložiť kontajnery a vozidlo by uviazlo; pri rehandlingu a v režime `random` bez rezervy.
    if (mode === 'place' && block.freeCount - teuOf(unit) < world.defs.logistics.buryReserveColumns * maxTier) return false;
    into.cls = CLASS_BURY;
    into.penalty = earlier;
    return true;
  }
  const topId = block.effectiveTopUnit(bay, row);
  const top = topId === null ? undefined : world.cargo.get(topId);
  const topDeparture = top === undefined ? Infinity : plannedDepartureTick(world, top);
  into.gap = topDeparture === departure ? 0 : topDeparture - departure;
  const ranks = CLASS_RANKS[unit.direction];
  into.cls = top !== undefined && sameGroup(top, unit) ? ranks.sameGroup : ranks.otherGroup;
  return true;
}

/** Prejde stohy bloku a zapíše kandidátov podľa `sink` (najlepší lepší než `BEST`, súčet voľných vrstiev, alebo všetkých); `origin` (rehandling) vynechá pôvodný stoh. */
function scanBlock(world: World, block: YardBlock, unit: CargoUnit, distance: number, origin: { readonly bay: number; readonly row: number } | undefined, sink: Sink, mode: PlacementMode): void {
  const { bays, rows } = block.geometry;
  const wide = unit.sizeFt === 40;
  const step = wide ? 2 : 1;
  for (let row = 0; row < rows; row++) {
    for (let bay = 0; bay < bays; bay += step) {
      if (origin !== undefined && origin.row === row && origin.bay === bay) continue;
      if (!scoreColumn(world, block, unit, bay, row, CURRENT, mode)) continue;
      CURRENT.block = block;
      CURRENT.distance = distance;
      CURRENT.moduleId = block.id;
      CURRENT.bay = bay;
      CURRENT.row = row;
      CURRENT.bayGap = origin === undefined ? 0 : Math.abs(bay - origin.bay);
      if (sink === 'room') {
        roomSum += block.geometry.maxTier - CURRENT.height;
      } else if (sink !== 'best') {
        sink.push({ ...CURRENT });
      } else if (BEST.block === undefined || better(CURRENT, BEST)) {
        Object.assign(BEST, CURRENT);
      }
    }
  }
}

/** Znovupoužiteľné polia blokov kandidátov (hot path: plánovač beží pre každú jednotku; obsah sa vždy najprv vyprázdni). */
const RAIL_BLOCKS: YardBlock[] = [];
const DEPOT_BLOCKS: YardBlock[] = [];
const YARD_BLOCKS: YardBlock[] = [];
const NO_BLOCKS: YardBlock[] = [];
const TIERS: YardBlock[][] = [];

/**
 * Bloky kandidátov pre jednotku zo zdroja `from` po vrstvách (prvá vrstva s riešením vyhráva; viď hlavička súboru, bod 1) do znovupoužiteľných polí —
 * výsledok platí len do ďalšieho volania.
 */
function candidateTiers(world: World, unit: CargoUnit, from: Module): readonly YardBlock[][] {
  const category = world.defs.cargoTypes.get(unit.typeId).category;
  const teu = teuOf(unit);
  // Blok so zásuvkami prijíma len reefery a reefer smie len do neho; OOG len do bloku, ktorý ho prijíma (R5, ADR-042).
  const plug = needsPlug(unit, world.defs.containerTypes);
  RAIL_BLOCKS.length = 0;
  DEPOT_BLOCKS.length = 0;
  YARD_BLOCKS.length = 0;
  TIERS.length = 0;
  let anyDepot = false;
  for (const module of world.modules.values()) {
    if (!(module instanceof YardBlock) || module.category !== category) continue;
    const isDepot = module instanceof EmptyDepot;
    anyDepot ||= isDepot;
    // Železničný terminál (R6, ADR-043): len import určený na vlak a export privezený vlakom tohto terminálu; ostatné jednotky doň nepatria.
    const isRail = module instanceof RailTerminal;
    if (isRail && !railTerminalTakes(world, module, unit, from)) continue;
    if (!module.acceptsDirection(unit.direction) || module.freeCount < teu || module.hasSockets !== plug || module.acceptsOog !== unit.oog || distanceBetweenModules(world, from, module) === Infinity) continue;
    (isRail ? RAIL_BLOCKS : isDepot ? DEPOT_BLOCKS : YARD_BLOCKS).push(module);
  }
  if (RAIL_BLOCKS.length > 0) {
    // Železničná jednotka najprv do bufferu terminálu (kam ju vlak vezme); export z vlaka len tam; bez miesta v bufferi import ide do bežného bloku a odíde kamiónom.
    TIERS.push(RAIL_BLOCKS);
    if (unit.direction === 'import') TIERS.push(YARD_BLOCKS);
  } else if (unit.direction !== 'empty') {
    TIERS.push(YARD_BLOCKS);
  } else if (from instanceof TruckGate) {
    TIERS.push(anyDepot ? DEPOT_BLOCKS : YARD_BLOCKS);
  } else {
    TIERS.push(emptyReturnRoom(world, from, category) > 0 ? DEPOT_BLOCKS : NO_BLOCKS, YARD_BLOCKS);
  }
  return TIERS;
}

/** Vyťaženie stroja RTG bloku: položky fronty + rozbehnutý cyklus (blok bez stroja, napr. strádl, = 0; ADR-040 dodatok TR3-02c). */
function machineLoad(world: World, block: YardBlock): number {
  let load = 0;
  for (const machine of world.machines.values()) {
    if (machine.blockId === block.id) load += machine.queue.length + (machine.cycle === null ? 0 : 1);
  }
  return load;
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
      for (const block of blocks) scanBlock(world, block, unit, 0, undefined, all, 'random');
      if (all.length === 0) continue;
      const pick = all[world.rng.int(0, all.length - 1)];
      return { moduleId: pick.moduleId as EntityId, slot: (pick.block as YardBlock).slotOf(pick.bay, pick.row, pick.height) };
    }
    resetBest();
    const weight = world.defs.logistics.yardMachineLoadWeight;
    for (const block of blocks) scanBlock(world, block, unit, distanceBetweenModules(world, from, block) + machineLoad(world, block) * weight, undefined, 'best', 'place');
    const best = BEST.block;
    if (best !== undefined) return { moduleId: best.id, slot: best.slotOf(BEST.bay, BEST.row, BEST.height) };
  }
  return null;
}

/**
 * Najlepší stoh pre `unit` v konkrétnom bloku `block` (slot bunky), alebo `null`, keď tam jednotka nemá kam. Pre RMG: export vyložený z vlaka sa ukladá do bufferu svojho terminálu
 * (`logistics/rail-units.ts`) bez ohľadu na iné bloky. Stav sveta nemení.
 */
export function chooseSlotInBlock(world: World, block: YardBlock, unit: CargoUnit): number | null {
  if (block.freeCount < teuOf(unit)) return null;
  resetBest();
  scanBlock(world, block, unit, 0, undefined, 'best', 'place');
  return BEST.block === undefined ? null : block.slotOf(BEST.bay, BEST.row, BEST.height);
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
  scanBlock(world, block, blocker, 0, origin, 'best', 'relocate');
  // Kontajner sa ukladá na skutočný vrchol stohu; rezervácie rozbehnutých jobov nad ním sa posunú (`YardBlock.vacateReservation`).
  return BEST.block === undefined ? null : block.slotOf(BEST.bay, BEST.row, block.stackHeight(BEST.bay, BEST.row));
}

/**
 * Koľko kontajnerov `blocker` (a rovnakej veľkosti) sa dá preložiť z `origin` v tom istom bloku: súčet voľných vrstiev v stohoch, ktoré rehandling smie použiť
 * (`chooseRehandleSlot`). Čistý dotaz.
 */
export function rehandleRoom(world: World, block: YardBlock, blocker: CargoUnit, origin: { readonly bay: number; readonly row: number }): number {
  roomSum = 0;
  scanBlock(world, block, blocker, 0, origin, 'room', 'relocate');
  return roomSum;
}

/**
 * Dá sa jednotka vybrať zo skladu bez toho, aby vozidlo uviazlo na rehandlingu bez cieľa? Navrchu ležiaca vždy; zavalená len keď blok pre kontajnery nad ňou
 * má dosť miesta (`rehandleRoom`). Kontajnery nad jednotkou sa počítajú uložené aj **rezervované** (`YardBlock.burialDepth`) — rezervovaný kontajner sa nad ňu
 * uloží skôr, než vozidlo dorazí, a bude ho treba preložiť. Dispatcher inak job nezakladá / nepriraďuje vozidlo (job počká, kým sa blok uvoľní — vozidlo čakajúce
 * na prístupovej bunke by zablokovalo dopravu) a vozidlo ju kontroluje znova pri príchode (`logistics/yard-rehandle.ts`). `spare` = rezerva buniek navyše
 * (`logistics.rehandleSpareCells` pri priraďovaní vozidla jobu — plánovač počas cesty vozidla ukladá príchody do tých istých stohov; pri vzniku jobu a pri príchode 0).
 */
export function unitPickable(world: World, unit: CargoUnit, spare = 0): boolean {
  if (unit.location.kind !== 'in_storage') return true;
  const block = world.modules.get(unit.location.moduleId);
  if (!(block instanceof YardBlock)) return true;
  const depth = block.burialDepth(unit.id);
  if (depth === 0) return true;
  const blockerId = block.topBlockerOf(unit.id);
  // Bez uloženého kontajnera nad jednotkou (len rezervácie) je stoh rovnakej veľkosti ako ona — poslúži ako zástupca pri hľadaní miesta.
  const blocker = (blockerId === null ? undefined : world.cargo.get(blockerId)) ?? unit;
  return rehandleRoom(world, block, blocker, block.positionOfSlot(unit.location.slot)) >= depth + spare;
}
