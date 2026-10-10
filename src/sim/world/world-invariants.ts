/**
 * Invarianty sveta nad rámec ledgera (ARCHITECTURE §6 krok 12, §16; ADR-014): moduly, mriežka, žeriavy, aprony
 * a skupiny kotvísk musia zodpovedať sebe navzájom aj `CargoLedger`. `World.assertInvariants()` ich volá po
 * `cargo.assertConservation()`; krok 12 ticku ho spustí od T02-05, loader save ho volá ako poslednú poistku.
 *
 * Kontroly (prvé porušenie vyhráva, správa pomenuje entity):
 * 1. každá jednotka nákladu je u existujúceho držiteľa (`CARGO_HOLDER_SOURCES`);
 * 2. mriežka: bunky modulu (okrem žeriavu) majú `moduleId` modulu a žiadnu cestu, iné bunky nemajú `moduleId`;
 *    typ cesty (ADR-020): koľaj má `DEFAULT_ROAD_KIND` a žiadny smer, cestná bunka má známy typ a smer práve vtedy,
 *    keď je jednosmerná (`ROAD_KIND_TRAITS.oneWay`), a smer je N/E/S/W (prázdne bunky sa kvôli cene kroku 12
 *    nekontrolujú — ich normalizovaný stav zaručujú zápisy `createCell`, `RemoveRoad` a `World.deserialize`);
 * 3. žeriav: stojí celý na svojom berthe, má jeho rotáciu, berth ho eviduje, držaná jednotka, rezervácia a fáza
 *    zodpovedajú ledgeru, apronu a `CRANE_STATE_TRAITS` (`cranePhaseProblem`); berth: `craneIds` = jeho žeriavy v poradí umiestnenia,
 *    najviac `maxCranes`, bez prekryvu, rezervácie apronu = rezervácie jeho žeriavov + sloty `to` jobov nakládky na apron (F6a;
 *    v režime `under_hook` žeriav pri vykládke slot nerezervuje, ADR-033);
 * 4. sloty modulov (`Module.cargoSlots()`: apron, sklad; ADR-017): obsadenie je v ledgeri, modul drží len rezervácie —
 *    rezervovaný slot nie je obsadený, rezervácie ≤ kapacita, `stored + reserved ≤ capacity`, slot jednotky v rozsahu
 *    (`SlotReservations.findProblem`); kapacita apronu = `apronSlots`, skladu = `capacityUnits`; v sklade len jednotky
 *    jeho kategórie;
 * 5. `berthGroups` a `groupId` = prepočet `computeBerthGroups`;
 * 6. lode (ADR-016, ADR-029): kľúč = id, vzostupne podľa id, stav bez `despawned`; `berthIds` podľa
 *    `SHIP_STATE_TRAITS.berths`, ležia za sebou v jednej skupine v poradí po pobreží a každý berth má `dockedShipId` = loď;
 *    dokovaná loď stojí presne v `dockPoint` s kurzom `DOCKED_HEADING` (`mooringProblem`, T02-14);
 *    každý `dockedShipId` patrí existujúcej lodi, ktorá ho má v `berthIds` (súlad `dockedShipId` ↔ `berthIds`);
 *    `anchorageIndex` podľa `anchorage` (nie spolu s kotviskami), v mape a jedinečný; loď, ktorá stojí na rejde,
 *    má jednotný kurz `map.anchorageHeading` (`anchoringProblem`, T6D-03); **dve lode na mape nezdieľajú
 *    bunku** (`shipOverlapProblem`, bez výnimiek); na palube najviac `capacityUnits` TEU (20′ = 1, 40′ = 2; ADR-039), všetky
 *    typu `cargoTypeId`; loď s nákladom, ktorá drží kotviská, má na nich aspoň jeden žeriav kategórie svojho nákladu
 *    (inak by pri kotvisku ostala naveky, T02-14); žeriav v `grabbing` má na kotvisku dokovanú loď s nákladom
 *    svojej kategórie a žeriavov v `grabbing` nad loďou nie je viac ako jednotiek na jej palube (každý má čo zdvihnúť);
 * 7. depo vozidiel (ADR-017): `vehicleIds` bez duplicít a najviac `capacity`;
 * 8. vozidlá (T03-04): kľúč = id, vzostupne podľa id, depo existuje a je `VehicleDepot`, `vehicleIds` každého depa =
 *    jeho vozidlá vzostupne podľa id (poradie nákupu), job zodpovedá stavu (`VEHICLE_STATE_TRAITS.hasJob`), existuje
 *    a patrí vozidlu, stav jobu zodpovedá stavu vozidla (`jobStates`), poloha je konečná v rozsahu mapy, náklad vo
 *    vozidle najviac `capacityUnits`, len kategórií z `cargoCategories` a len jednotky vlastného jobu v stave
 *    s nákladom vo vozidle (`idle` vozidlo nevezie nič — rozhodnutie orchestrátora F3 č. 5); pohyb zodpovedá stavu
 *    (`vehicleMotionProblem`, ADR-019: trasa po susedných bunkách, poloha na trase, tvar trasy a odpočet podľa stavu,
 *    cesta pod vozidlom, jazda po ceste k prístupovej bunke modulu jobu — žiadne vozidlo v `to_*` bez platnej cesty);
 * 9. joby (T03-05, ADR-018, ADR-023): kľúč = id, vzostupne podľa id, aktívny stav (hotový aj zrušený job sa hneď
 *    odstráni), index `jobOfUnit` = jednotky jobov (žiadna jednotka v dvoch aktívnych joboch), jednotky ležia podľa
 *    stavu na `from` alebo vo vozidle jobu, vozidlo podľa `JOB_STATE_TRAITS.hasVehicle` existuje a má tento job, cieľ
 *    je modul s `cargoDropTarget()` druhu `to` (sklad pre inbound, rampa pre outbound) kategórie nákladu a miesto `to`
 *    (slot, dock) je rezervované; rezervované sloty každého skladu = presne sloty `to` jeho aktívnych jobov (slot jobu
 *    rezervovaný + počet, súčet a súčet štvorcov slotov — bez kópií a triedenia, ADR-021); rezervácie každého docku
 *    rampy = počet jednotiek aktívnych outbound jobov na tento dock (outbound job drží rezerváciu celý život, T04-03)
 *    plus jednotky, ktoré ešte vezie vykladajúci delivery kamión (`holdsIntake`, ADR-032 bod 13); job `at_ramp → in_storage`
 *    (prijatie exportu) drží rezerváciu slotu v sklade ako inbound; joby pod hákom (ADR-033): zdroj `in_crane` (jednotka je
 *    v žeriave, alebo ešte na lodi pri dispatchi vopred, alebo na aprone po presmerovaní `rebindSource`) a cieľ `in_crane`
 *    (jednotka sa nakladá z vozidla; držiteľ = žeriav, bez rezervácie slotu);
 * 10. vnútorný stav modulov (`Module.findRuntimeProblem`, T04-02, ADR-022): fronta brány bez duplicít, bays stojiska
 *    (počítadlá, obsadený bay má kamión, kamión drží najviac jeden bay), staging dockov rampy (jednotka na docku
 *    v rozsahu, súčet rezervácií, `staged + reserved ≤ stagingPerDock` na každom docku, držitelia dockov); na rampe len
 *    jednotky jej kategórie;
 * 11. kamióny (T04-04, ADR-024): kľúč = id, vzostupne podľa id, stav bez `exited`, brána / stojisko / rampa existujú
 *    a sú toho druhu, dock v rozsahu, poloha v mape; **bays ↔ kamióny**: kamión drží bay práve v stavoch s `holdsBay`,
 *    bay ho má ako držiteľa a je obsadený práve v `waiting`, súčet držaných bays všetkých stojísk = počet kamiónov
 *    s bay; **dock nemá dva kamióny**: kamión v stave s `holdsDock` je držiteľom svojho docku (inak nie), súčet
 *    držaných dockov všetkých rámp = počet takých kamiónov; **fronta ↔ kamióny v `gate_queue*` a `gate_pass*`**: kamión je vo fronte
 *    svojej brány práve v stavoch vo fronte a v prechode bránou (čelo fronty zostáva vo fronte, kým prechod neskončí a kamión nevyjde), súčet dĺžok front = počet takých kamiónov (fronta je bez duplicít);
 *    **`in_truck` ↔ kamión**: náklad len v existujúcom kamióne (bod 1), najviac `capacityUnits`, len jeho kategórie
 *    a podľa stavu (pred nakládkou 0, po nej plný); **rampa**: def kamióna vozí kategóriu rampy a kamión s dockom má
 *    na docku a v sebe spolu aspoň `capacityUnits` jednotiek (`truckRampProblem`); **nároky na náklad** (ADR-029):
 *    nárok každého docku = Σ `capacityUnits − in_truck` kamiónov docku v stavoch s `claimsCargo` a nárok nepresahuje
 *    pripravené (náklad na odvoz — export na prijatie sa nepočíta, `World.isPickupCargo`) + vozidlami vezené jednotky docku
 *    (`DockSupply`) — žiadny kamión nečaká na jednotku, ktorá nepríde,
 *    a dva kamióny nečakajú na tú istú; pohyb zodpovedá stavu
 *    (`truckMotionProblem`); kamión vo fronte stojí na svojej strane brány (`truckQueueSideProblem`, dodatok
 *    ADR-024); súlad prechodu brány s frontou kontroluje brána (`gatePassProblem`, bod 10). O(kamióny + moduly);
 * 12. tok prázdnych kontajnerov (F6c, ADR-034 + dodatok T6C-02; `checkEmptyFlow`): každé poverenie `World.emptyFlow.errands` patrí
 *    kamiónu misie `collect` a kamión misie `collect` má poverenie, kým neodíde naprázdno (vzdal sa, `leavesEmpty`); poverenie patrí kontraktu v knihe a jeho linke, pridelený prázdny kontajner je
 *    prázdny tej istej linky, pridelený práve jednému kamiónu a leží v ceste na dock kamióna (v sklade / vozidle s aktívnym jobom
 *    na jeho dock, na docku, v kamióne); depo prázdnych drží len prázdne kontajnery. O(poverenia + depá).
 *
 * Krok 12 beží v DEV/testoch každý tick, preto kontroly v bežnom (platnom) stave nealokujú, kde to ide (review T03-13):
 * trasy vozidiel cez `Vehicle.routeCellAt`, depá kurzorom, rezervácie súčtami; podrobné správy sa skladajú až pri
 * porušení. Jednotky skladu sa čítajú jednou kópiou (`units()`) — pri stovkách jednotiek lacnejšie než `unitAtIndex`.
 */
import { teuOf } from '../cargo/cargo-unit';
import { CARGO_HOLDER_KINDS, holderIdOf, slotOf, uniqueSlotOf } from '../cargo/cargo-location';
import { OPPOSITE_DIRECTION } from '../grid/road-direction';
import { DEFAULT_ROAD_KIND, ROAD_KIND_TRAITS, isRoadKind } from '../grid/road-kind';
import type { Contract } from '../contracts/contract';
import { CONTRACT_STATE_TRAITS, type ContractKind } from '../contracts/contract-fsm';
import { importAboard } from '../logistics/voyage-cargo';
import type { ContractId, EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import type { Cell } from '../grid/grid';
import { unitAtJobSource } from '../logistics/job-source';
import { JOB_STATE_TRAITS, type TransportJob } from '../logistics/transport-job';
import { BerthModule } from '../modules/berth-module';
import { computeBerthGroups } from '../modules/berth-group';
import { CRANE_CYCLE_TRAITS, CRANE_STATE_TRAITS, CraneModule, craneReservesApronSlot, cranePhaseProblem } from '../modules/crane-module';
import { EmptyDepot } from '../modules/empty-depot';
import { RailTerminal } from '../modules/rail-terminal';
import { RtgBlock } from '../modules/rtg-block';
import { StorageModule, storageSlotCapacity } from '../modules/storage-module';
import { PreGateBuffer } from '../modules/pre-gate-buffer';
import { TruckHolding } from '../modules/truck-holding';
import { YardBlock } from '../modules/yard-block';
import { isTruckJob, truckJobBlock, truckOfJob } from '../logistics/truck-jobs';
import { tpCellsOf } from '../trucks/tp-points';
import { TruckGate } from '../modules/truck-gate';
import { VehicleDepot } from '../modules/vehicle-depot';
import { hasCompatibleCrane } from '../ships/berth-allocator';
import type { Ship } from '../ships/ship';
import { SHIP_STATE_TRAITS, holdingAllows } from '../ships/ship-fsm';
import { shipOverlapProblem } from '../ships/ship-traffic';
import { anchoringProblem, mooringProblem } from '../ships/ship-route';
import { HANDOVERS } from '../systems/crane-handover';
import type { Truck } from '../trucks/truck';
import { TRUCK_STATE_TRAITS } from '../trucks/truck-fsm';
import { gateNearSideCell, isOffQueueSide, truckMotionProblem } from '../trucks/truck-trip';
import type { Vehicle } from '../vehicles/vehicle';
import { carrierOverlapProblem } from '../traffic/overlap-check';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';
import { vehicleMotionProblem } from '../vehicles/vehicle-trip';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import { heldByMachine } from './machines-state';
import type { World } from './world';

/** Porušený invariant sveta (moduly, mriežka, aprony, žeriavy, skupiny kotvísk). */
export class WorldInvariantError extends Error {
  constructor(violation: string) {
    super(`World: porušený invariant — ${violation}`);
    this.name = 'WorldInvariantError';
  }
}

type Check = (world: World) => string | undefined;

function cellLabel(x: number, y: number): string {
  return `(${String(x)}, ${String(y)})`;
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function berths(world: World): BerthModule[] {
  return [...world.modules.values()].filter((module): module is BerthModule => module instanceof BerthModule);
}

function cranes(world: World): CraneModule[] {
  return [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule);
}

const checkCargoHolders: Check = (world) => {
  for (const kind of CARGO_HOLDER_KINDS) {
    let held = 0;
    for (const holderId of CARGO_HOLDER_SOURCES[kind](world)) held += world.cargo.countAt(kind, holderId);
    const total = world.cargo.countByKind(kind);
    if (held !== total) return `${String(total - held)} jednotiek v '${kind}' je u neexistujúceho držiteľa`;
  }
  return undefined;
};

/** Tabuľky typov ciest ako lokálne väzby modulu — slučka kroku 12 nad celou mriežkou ich číta bez importných getterov. */
const ROAD_TRAITS: Readonly<Record<string, { readonly oneWay: boolean } | undefined>> = ROAD_KIND_TRAITS;
const ROAD_DIRECTIONS: Readonly<Record<string, string | undefined>> = OPPOSITE_DIRECTION;
const DEFAULT_KIND: string = DEFAULT_ROAD_KIND;

/**
 * Je typ a smer cesty bunky s vrstvou dopravy v poriadku (ADR-020)? Koľaj má predvolený typ bez smeru, cesta známy typ
 * a smer N/E/S/W práve pri jednosmerke. Bez alokácie (každý tick nad cestnými bunkami).
 */
function isUsualRoadCell(cell: Readonly<Cell>): boolean {
  const { road, roadKind, roadDir } = cell;
  if (road !== 'road') return roadKind === DEFAULT_KIND && roadDir === null;
  const oneWay = ROAD_TRAITS[roadKind]?.oneWay;
  return roadDir === null ? oneWay === false : oneWay === true && ROAD_DIRECTIONS[roadDir] !== undefined;
}

/** Popis porušenia typu a smeru cesty bunky, ktorá neprešla `isUsualRoadCell`. */
function roadCellProblem(world: World, index: number): string {
  const { road, roadKind, roadDir } = world.grid.atIndex(index);
  const oneWay = ROAD_TRAITS[roadKind]?.oneWay;
  const { x, y } = world.grid.coordOf(index);
  if (road !== 'road') return `bunka ${cellLabel(x, y)} s vrstvou '${road}' má typ cesty '${roadKind}' a smer ${String(roadDir)}`;
  if (!isRoadKind(roadKind)) return `bunka ${cellLabel(x, y)} má neznámy typ cesty '${String(roadKind)}'`;
  const expected = oneWay === true ? 'jednosmerka musí mať smer N/E/S/W' : 'len jednosmerka má smer';
  return `cesta na ${cellLabel(x, y)} typu '${roadKind}' má smer ${String(roadDir)} (${expected})`;
}

const checkModuleCells: Check = (world) => {
  const { grid } = world;
  for (const [id, module] of world.modules) {
    if (module.id !== id) return `world.modules: kľúč ${String(id)} ukazuje na ${module.label}`;
    if (!grid.rectInBounds({ x: module.origin.x, y: module.origin.y, w: module.size.w, h: module.size.h })) {
      return `${module.label} presahuje mapu`;
    }
    if (module instanceof CraneModule) continue;
    for (const { x, y } of module.cells) {
      const cell = grid.at(x, y);
      if (cell.moduleId !== module.id) return `bunka ${cellLabel(x, y)} modulu ${module.label} má moduleId ${String(cell.moduleId)}`;
      if (cell.road !== 'none') return `pod modulom ${module.label} je na ${cellLabel(x, y)} vrstva '${cell.road}'`;
    }
  }
  // Jeden prechod mriežkou pre odkazy `moduleId` aj typ a smer cesty (ADR-020). Krok 12 beží každý tick, preto sa
  // typ kontroluje len na bunkách s vrstvou dopravy; normalizovaný stav prázdnej bunky (`DEFAULT_ROAD_KIND`, bez
  // smeru) zaručujú jediné zápisy `road = 'none'` v sime — `createCell`, `RemoveRoad` a `World.deserialize`.
  for (let i = 0; i < grid.cellCount; i++) {
    const cell = grid.atIndex(i);
    if (cell.road !== 'none' && !isUsualRoadCell(cell)) return roadCellProblem(world, i);
    const moduleId = cell.moduleId;
    if (moduleId === null) continue;
    const { x, y } = grid.coordOf(i);
    const owner = world.modules.get(moduleId);
    if (owner === undefined) return `bunka ${cellLabel(x, y)} odkazuje na neexistujúci modul #${String(moduleId)}`;
    if (owner instanceof CraneModule || !owner.containsCell(x, y)) {
      return `bunka ${cellLabel(x, y)} odkazuje na ${owner.label}, ktorý ju nezaberá`;
    }
  }
  return undefined;
};

/**
 * Cieľ cyklu žeriava (`targetUnitId`, ADR-032/033): mimo cyklu `null`; v cykle ho má nakládka vždy (jednotka na zdroji) a vykládka
 * len pod hákom (jednotka importu vybraná pri štarte, aby dispatcher poslal vozidlo vopred) — vykládka na apron cieľ nemá. V `grabbing`
 * leží cieľ na zdroji cyklu (nakládka: apron kotviska alebo vozidlo; vykládka pod hákom: loď), po zdvihnutí ho žeriav drží.
 */
function craneTargetProblem(world: World, crane: CraneModule, berth: BerthModule): string | undefined {
  const target = crane.targetUnitId;
  if (crane.state === 'idle' || crane.state === 'blocked') return target === null ? undefined : `${crane.label} mimo cyklu má cieľ #${String(target)}`;
  const loads = CRANE_CYCLE_TRAITS[crane.cycle].direction === 'load';
  const expects = loads || HANDOVERS[berth.params.handoverMode].plansUnloadTarget;
  if (expects !== (target !== null)) return `${crane.label} v stave '${crane.state}' cyklu '${crane.cycle}' (${berth.params.handoverMode}) ${expects ? 'nemá' : 'má'} cieľ cyklu`;
  if (target === null) return undefined;
  if (crane.state !== 'grabbing') return crane.heldUnitId === target ? undefined : `${crane.label} drží #${String(crane.heldUnitId)}, cieľ cyklu je #${String(target)}`;
  const at = world.cargo.get(target)?.location;
  if (at === undefined) return `${crane.label}: cieľ cyklu #${String(target)} nie je v ledgeri`;
  const onSource = loads ? (at.kind === 'on_apron' && at.berthId === berth.id) || at.kind === 'in_vehicle' : at.kind === 'on_ship';
  return onSource ? undefined : `${crane.label}: cieľ cyklu #${String(target)} je na '${at.kind}', nie na zdroji cyklu '${crane.cycle}'`;
}

function checkCrane(world: World, crane: CraneModule): string | undefined {
  const berth = world.modules.get(crane.berthId);
  if (!(berth instanceof BerthModule)) return `${crane.label} stojí na #${String(crane.berthId)}, ktorý nie je berth`;
  if (crane.rotation !== berth.rotation) return `${crane.label} má rotáciu ${String(crane.rotation)}, berth ${berth.label} ${String(berth.rotation)}`;
  const outside = crane.cells.find(({ x, y }) => world.grid.at(x, y).moduleId !== berth.id);
  if (outside !== undefined) return `${crane.label}: bunka ${cellLabel(outside.x, outside.y)} nepatrí berthu ${berth.label}`;
  if (!berth.craneIds.includes(crane.id)) return `${crane.label} chýba v craneIds berthu ${berth.label}`;

  const held = world.cargo.unitsAt('in_crane', crane.id);
  if (held.length > 1) return `${crane.label} drží ${String(held.length)} jednotiek (${held.join(', ')})`;
  if (crane.heldUnitId !== (held[0] ?? null)) {
    return `${crane.label}: heldUnitId ${String(crane.heldUnitId)}, ledger in_crane ${String(held[0] ?? null)}`;
  }
  const traits = CRANE_STATE_TRAITS[crane.state];
  if (traits.holdsUnit !== (crane.heldUnitId !== null)) {
    return `${crane.label} v stave '${crane.state}' ${traits.holdsUnit ? 'nedrží' : 'drží'} jednotku`;
  }
  // Rezervovaný slot apronu: v režime `apron` ho drží stav cyklu podľa `CRANE_CYCLE_TRAITS.reservesFrom`, v `under_hook` nikdy.
  const reserves = HANDOVERS[berth.params.handoverMode].reservesUnloadSlot && craneReservesApronSlot(crane.cycle, crane.state);
  if (reserves !== (crane.reservedSlot !== null)) {
    return `${crane.label} v stave '${crane.state}' cyklu '${crane.cycle}' (${berth.params.handoverMode}) ${reserves ? 'nemá' : 'má'} rezervovaný slot`;
  }
  const targetProblem = craneTargetProblem(world, crane, berth);
  if (targetProblem !== undefined) return targetProblem;
  const slot = crane.reservedSlot;
  if (slot !== null && (slot >= berth.apron.capacity || !berth.apron.isReserved(slot))) {
    return `${crane.label}: slot ${String(slot)} nie je rezervovaný na aprone ${berth.label}`;
  }
  if (crane.phaseTicksLeft > crane.phaseTicksTotal) {
    return `${crane.label}: phaseTicksLeft ${String(crane.phaseTicksLeft)} > phaseTicksTotal ${String(crane.phaseTicksTotal)}`;
  }
  const phase = cranePhaseProblem(crane.state, crane.phaseTicksTotal, crane.phaseTicksLeft);
  return phase === undefined ? undefined : `${crane.label}: ${phase.problem}`;
}

function checkBerthCranes(world: World, berth: BerthModule, all: readonly CraneModule[]): string | undefined {
  const own = all.filter((crane) => crane.berthId === berth.id);
  if (!sameIds(berth.craneIds, own.map((crane) => crane.id))) {
    return `${berth.label}: craneIds [${berth.craneIds.join(', ')}] ≠ žeriavy na berthe [${own.map((c) => c.id).join(', ')}]`;
  }
  if (own.length > berth.params.maxCranes) return `${berth.label} má ${String(own.length)} žeriavov (maxCranes ${String(berth.params.maxCranes)})`;
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const overlap = own[i].cells.find(({ x, y }) => own[j].containsCell(x, y));
      if (overlap !== undefined) return `${own[i].label} a ${own[j].label} sa prekrývajú na ${cellLabel(overlap.x, overlap.y)}`;
    }
  }
  // Rezervácie apronu: sloty žeriavov (vykládka na apron) + sloty jobov nakládky exportu `in_storage → on_apron` (ADR-032 bod 9).
  const expected = own.map((crane) => crane.reservedSlot).filter((slot): slot is number => slot !== null);
  for (const job of world.jobs.values()) {
    if (job.to.kind === 'on_apron' && job.to.berthId === berth.id) expected.push(job.to.slot);
  }
  expected.sort((a, b) => a - b);
  const reserved = berth.apron.reservedSlots();
  if (reserved.length !== expected.length || reserved.some((slot, i) => slot !== expected[i])) {
    return `${berth.label}: rezervované sloty apronu [${reserved.join(', ')}] ≠ rezervácie žeriavov a jobov [${expected.join(', ')}]`;
  }
  return undefined;
}

const checkCranes: Check = (world) => {
  const all = cranes(world);
  for (const crane of all) {
    const violation = checkCrane(world, crane);
    if (violation !== undefined) return violation;
  }
  for (const berth of berths(world)) {
    const violation = checkBerthCranes(world, berth, all);
    if (violation !== undefined) return violation;
  }
  return undefined;
};

/** Kapacita slotov podľa triedy modulu: apron = `apronSlots`, sklad = `capacityUnits`; iné moduly sloty nemajú. */
function expectedSlotCapacity(world: World, moduleId: EntityId): number | undefined {
  const module = world.modules.get(moduleId);
  if (module instanceof BerthModule) return module.params.apronSlots;
  if (module instanceof StorageModule) return storageSlotCapacity(module.params);
  return undefined;
}

/** Kategória typu nákladu jednotky; neznáma jednotka alebo typ → `undefined`. */
function unitCategory(world: World, unitId: EntityId | undefined): CargoCategory | undefined {
  const typeId = unitId === undefined ? undefined : world.cargo.get(unitId)?.typeId;
  return typeId === undefined || !world.defs.cargoTypes.has(typeId) ? undefined : world.defs.cargoTypes.get(typeId).category;
}

/** V sklade ležia len jednotky jeho kategórie (kompatibilitu strážia systémy, §7.1 — tu poistka). */
function checkStorageCategory(world: World, storage: StorageModule): string | undefined {
  for (const unitId of storage.units()) {
    const typeId = world.cargo.get(unitId)?.typeId;
    const category = typeId === undefined || !world.defs.cargoTypes.has(typeId) ? undefined : world.defs.cargoTypes.get(typeId).category;
    if (category !== storage.category) {
      return `${storage.label} (kategória '${storage.category}') drží jednotku #${String(unitId)} kategórie '${String(category)}'`;
    }
  }
  return undefined;
}

const checkCargoSlots: Check = (world) => {
  for (const module of world.modules.values()) {
    const slots = module.cargoSlots();
    if (slots === undefined) continue;
    if (slots.holderId !== module.id) return `${module.label}: sloty patria držiteľovi #${String(slots.holderId)}`;
    const capacity = expectedSlotCapacity(world, module.id);
    if (slots.capacity !== capacity) return `${module.label}: kapacita slotov ${String(slots.capacity)} ≠ def ${String(capacity)}`;
    const problem = slots.findProblem();
    if (problem !== undefined) return problem;
    if (module instanceof StorageModule) {
      const foreign = checkStorageCategory(world, module);
      if (foreign !== undefined) return foreign;
    }
  }
  return undefined;
};

/** Obsahuje zoznam id duplicitu? O(n²) bez alokácie — zoznam depa má najviac `capacity` položiek. */
function hasDuplicate(ids: readonly EntityId[]): boolean {
  for (let i = 1; i < ids.length; i++) {
    for (let j = 0; j < i; j++) if (ids[i] === ids[j]) return true;
  }
  return false;
}

/** Podrobná správa, keď `vehicleIds` depa nesedí s jeho vozidlami (len pri porušení — alokuje). */
function depotMismatch(world: World, depot: VehicleDepot): string {
  const own = [...world.vehicles.values()].filter((vehicle) => vehicle.depotId === depot.id).map((vehicle) => vehicle.id);
  return `${depot.label}: vehicleIds [${depot.vehicleIds.join(', ')}] ≠ vozidlá depa podľa id [${own.join(', ')}]`;
}

/**
 * Každé depo jedným prechodom vozidiel bez kópií (review T03-13): `vehicleIds` bez duplicít, najviac `capacity`
 * a položka po položke = vozidlá depa v poradí `world.vehicles` (vzostupne podľa id = poradie nákupu) — kurzor v
 * `vehicleIds` postupuje s každým vozidlom depa. Pri porušení podrobná správa (`depotMismatch`).
 */
const checkDepots: Check = (world) => {
  for (const module of world.modules.values()) {
    if (!(module instanceof VehicleDepot)) continue;
    const ids = module.vehicleIds;
    if (hasDuplicate(ids)) return `${module.label}: vehicleIds [${ids.join(', ')}] obsahujú duplicitu`;
    if (ids.length > module.capacity) return `${module.label} má ${String(ids.length)} vozidiel (capacity ${String(module.capacity)})`;
    let cursor = 0;
    for (const vehicle of world.vehicles.values()) {
      if (vehicle.depotId !== module.id) continue;
      if (ids[cursor] !== vehicle.id) return depotMismatch(world, module);
      cursor += 1;
    }
    if (cursor !== ids.length) return depotMismatch(world, module);
  }
  return undefined;
};

/**
 * Náklad vozidla: najviac `capacityUnits` jednotiek, len kategórie, ktoré vozidlo vozí, a len jednotky vlastného jobu
 * v stave s nákladom vo vozidle (`idle` vozidlo nevezie nič).
 */
function checkVehicleCargo(world: World, vehicle: Vehicle): string | undefined {
  const count = world.cargo.countAt('in_vehicle', vehicle.id);
  if (count > vehicle.def.capacityUnits) {
    return `${vehicle.label} vezie ${String(count)} jednotiek (capacityUnits ${String(vehicle.def.capacityUnits)})`;
  }
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('in_vehicle', vehicle.id, i);
    const category = unitCategory(world, unitId);
    if (unitId === undefined || category === undefined || !vehicle.def.cargoCategories.includes(category)) {
      return `${vehicle.label} vezie jednotku #${String(unitId)} kategórie '${String(category)}', ktorú nevozí`;
    }
    const job = world.jobOfUnit(unitId);
    if (job?.vehicleId !== vehicle.id || JOB_STATE_TRAITS[job.state].cargoAt !== 'vehicle') {
      return `${vehicle.label} v stave '${vehicle.state}' vezie jednotku #${String(unitId)} mimo svojho jobu s nákladom vo vozidle`;
    }
  }
  return undefined;
}

/** Súradnica polohy je konečná v `[0, max]`. */
function isWithin(value: number, max: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= max;
}

function checkVehicle(world: World, vehicle: Vehicle): string | undefined {
  const depot = world.modules.get(vehicle.depotId);
  if (!(depot instanceof VehicleDepot)) return `${vehicle.label} patrí #${String(vehicle.depotId)}, ktorý nie je depo vozidiel`;
  if (!depot.vehicleIds.includes(vehicle.id)) return `${vehicle.label} chýba vo vehicleIds depa ${depot.label}`;
  const traits = VEHICLE_STATE_TRAITS[vehicle.state];
  if (traits.hasJob !== (vehicle.jobId !== null)) {
    return `${vehicle.label} v stave '${vehicle.state}' ${traits.hasJob ? 'nemá job' : `má job #${String(vehicle.jobId)}`}`;
  }
  const job = vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
  if (vehicle.jobId !== null && job === undefined) return `${vehicle.label}: job #${String(vehicle.jobId)} neexistuje`;
  if (job !== undefined && job.vehicleId !== vehicle.id) return `${vehicle.label}: ${job.label} patrí vozidlu #${String(job.vehicleId)}`;
  if (job !== undefined && !traits.jobStates.includes(job.state)) {
    return `${vehicle.label} v stave '${vehicle.state}' má ${job.label} v stave '${job.state}' (očakávané: ${traits.jobStates.join(', ')})`;
  }
  const { width, height } = world.grid;
  if (!isWithin(vehicle.x, width) || !isWithin(vehicle.y, height)) {
    return `${vehicle.label} stojí mimo mapy (${String(vehicle.x)}, ${String(vehicle.y)})`;
  }
  return checkVehicleCargo(world, vehicle) ?? vehicleMotionProblem(world, vehicle)?.problem;
}

/**
 * Stroje blokov (ADR-040; TERMINAL_2 §10.4): stroj stojí na RTG bloku (najviac jeden na blok), v `idle` nemá cyklus ani nesie nič, v cykle drží najviac jednu jednotku
 * (`in_handler`) — práve jednotku cyklu — a po zdvihu ju nesie len v fázach po `lift` (`shift`, `trolley`, `lower`), pred zdvihom (`travel`, `lift`) ju nenesie; vozidlo cyklu
 * `put` / `take` existuje a čaká na TP v `unloading` / `loading` s jobom cyklu; poloha je v rozsahu bloku.
 */
const checkMachines: Check = (world) => {
  const blocks = new Set<number>();
  for (const [id, machine] of world.machines) {
    if (machine.id !== id) return `world.machines: kľúč ${String(id)} ukazuje na ${machine.label}`;
    const block = world.modules.get(machine.blockId);
    if (!(block instanceof RtgBlock)) return `${machine.label}: blok #${String(machine.blockId)} nie je RTG blok`;
    if (blocks.has(block.id)) return `${machine.label}: blok ${block.label} má viac strojov`;
    blocks.add(block.id);
    const held = world.cargo.countAt('in_handler', machine.id);
    const { cycle, state } = machine;
    if (state === 'idle') {
      if (cycle !== null || held > 0) return `${machine.label} v stave 'idle' má cyklus alebo drží ${String(held)} jednotiek`;
    } else {
      if (cycle === null) return `${machine.label} v stave '${state}' nemá cyklus`;
      // `put` s vozidlom v cykle je pred zdvihom (`shift` je čakanie nad TP, predzásobenie) — jednotka je ešte vo vozidle.
      const carrying = (state === 'shift' || state === 'trolley' || state === 'lower') && !(cycle.kind === 'put' && cycle.vehicleId !== null);
      if (held > 1) return `${machine.label} drží ${String(held)} jednotiek (najviac 1)`;
      if (held === 1 && world.cargo.unitAtIndex('in_handler', machine.id, 0) !== cycle.unitId) return `${machine.label} drží inú jednotku než #${String(cycle.unitId)} cyklu ${cycle.kind}`;
      if (carrying !== (held === 1)) return `${machine.label} v stave '${state}' ${held === 1 ? 'drží jednotku skôr, než ju zdvihol' : 'nedrží jednotku po zdvihu'}`;
      // `put` po zdvihu je bez vozidla a jobu (ťahač je voľný hneď po zdvihu, ADR-040 dodatok TR3-02); inak vozidlo cyklu čaká na TP.
      if (cycle.kind === 'put' && cycle.vehicleId === null) {
        if (!carrying || cycle.jobId !== null) return `${machine.label}: cyklus put bez vozidla musí byť po zdvihu a bez jobu`;
      } else if (cycle.kind !== 'relocate' && cycle.truck) {
        // Kamión na TP vo fáze `handling` s jobom cyklu (ADR-041 bod 4); stroj naňho nikdy nečaká prefetchom.
        const truck = world.trucks.get(cycle.vehicleId as EntityId);
        if (truck === undefined || truck.state !== 'at_tp' || truck.phase !== 'handling' || truck.jobId !== cycle.jobId) {
          return `${machine.label}: kamión #${String(cycle.vehicleId)} cyklu ${cycle.kind} nestojí na TP vo fáze handling s jobom #${String(cycle.jobId)}`;
        }
      } else if (cycle.kind !== 'relocate') {
        const vehicle = world.vehicles.get(cycle.vehicleId as EntityId);
        // `take` s predzásobením (ťahač ešte ide k TP, `prefetchCells`) smie mať vozidlo na ceste (`to_pickup`, po zmene ciest `no_path`), kým stroj nezačne `lower`.
        const approaching = (cycle.kind === 'take' ? vehicle?.state === 'to_pickup' && state !== 'lower' : vehicle?.state === 'to_dropoff' && (state === 'travel' || state === 'shift')) || vehicle?.state === 'no_path' && state !== 'lower' && state !== 'lift';
        const wanted = cycle.kind === 'put' ? 'unloading' : 'loading';
        if (vehicle === undefined || (vehicle.state !== wanted && !approaching) || vehicle.jobId !== cycle.jobId) return `${machine.label}: vozidlo #${String(cycle.vehicleId)} cyklu ${cycle.kind} nečaká na TP v stave '${wanted}' s jobom #${String(cycle.jobId)}`;
      }
    }
    const { gantry, trolley, hoist } = machine.restPose;
    if (!isWithin(gantry, block.geometry.bays) || trolley < -1 || trolley > block.geometry.rows - 1 || !isWithin(hoist, block.geometry.maxTier)) {
      return `${machine.label} stojí mimo bloku (bay ${String(gantry)}, rad ${String(trolley)}, vrstva ${String(hoist)})`;
    }
  }
  return undefined;
};

const checkVehicles: Check = (world) => {
  let previous = 0;
  for (const [id, vehicle] of world.vehicles) {
    if (vehicle.id !== id) return `world.vehicles: kľúč ${String(id)} ukazuje na ${vehicle.label}`;
    if (id <= previous) return `world.vehicles: ${vehicle.label} nie je vzostupne podľa id (po #${String(previous)})`;
    previous = id;
    const violation = checkVehicle(world, vehicle);
    if (violation !== undefined) return violation;
  }
  return undefined;
};

/** Jednotky jobu ležia tam, kde to hovorí jeho stav (`cargoAt`: na `from` alebo vo vozidle jobu) a index ich pozná. */
function checkJobUnits(world: World, job: TransportJob): string | undefined {
  const place = JOB_STATE_TRAITS[job.state].cargoAt;
  for (const unitId of job.unitIds) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined) return `${job.label}: jednotka #${String(unitId)} v ledgeri nie je`;
    if (world.jobOfUnit(unitId) !== job) return `${job.label}: index jobOfUnit(#${String(unitId)}) ukazuje na ${world.jobOfUnit(unitId)?.label ?? 'nič'}`;
    const atSource = unitAtJobSource(world, job, unit);
    const inVehicle = unit.location.kind === 'in_vehicle' && unit.location.vehicleId === job.vehicleId;
    if (((place === 'source' && !atSource) || (place === 'vehicle' && !inVehicle)) && !heldByMachine(world, unit)) {
      return `${job.label} v stave '${job.state}': jednotka #${String(unitId)} nie je na ${place === 'source' ? 'zdroji' : 'vozidle'} jobu`;
    }
  }
  return undefined;
}

/**
 * Cieľ jobu (ADR-018, ADR-023): modul s `cargoDropTarget()` druhu `to` (sklad pre inbound, rampa pre outbound), miesto
 * `to` (slot, dock) má rezerváciu a cieľ prijíma kategóriu nákladu jobu.
 */
function checkJobTarget(world: World, job: TransportJob, category: CargoCategory | undefined): string | undefined {
  // Kamión na TP (R4, ADR-041 bod 4): cieľ `in_truck` nerezervuje miesto; kamión musí existovať a mať tento job (väzby na blok overuje `checkTruckJob`).
  if (job.to.kind === 'in_truck') return truckOfJob(world, job)?.jobId === job.id ? undefined : `${job.label}: kamión #${String(job.to.truckId)} tento job nemá`;
  // Držiteľ cieľa: modul `to` (sklad, berth), pri háku žeriava samotný žeriav (vozidlo jazdí ku kotvisku — `toModuleId`).
  const module = world.modules.get(holderIdOf(job.to) ?? job.toModuleId);
  const target = module?.cargoDropTarget();
  if (module === undefined || target?.kind !== job.to.kind) return `${job.label}: cieľ #${String(job.toModuleId)} neprijíma náklad do '${job.to.kind}'`;
  if (target.reserves) {
    const place = slotOf(job.to);
    if (place === null || target.reservationsAt(place) < 1) return `${job.label}: miesto ${String(place)} ('${job.to.kind}') nie je rezervované v ${module.label}`;
  }
  if (target.category !== null && category !== target.category) return `${job.label}: ${module.label} (kategória '${target.category}') pre náklad kategórie '${String(category)}'`;
  return undefined;
}

function checkJob(world: World, job: TransportJob): string | undefined {
  const traits = JOB_STATE_TRAITS[job.state];
  if (!traits.active) return `${job.label} v stave '${job.state}' je stále vo world.jobs`;
  if (traits.hasVehicle !== (job.vehicleId !== null)) return `${job.label} v stave '${job.state}' ${traits.hasVehicle ? 'nemá vozidlo' : 'má vozidlo'}`;
  const vehicle = job.vehicleId === null ? undefined : world.vehicles.get(job.vehicleId);
  if (job.vehicleId !== null && vehicle?.jobId !== job.id) return `${job.label}: vozidlo #${String(job.vehicleId)} tento job nemá`;
  if (isTruckJob(job) && (truckOfJob(world, job) === undefined || truckJobBlock(world, job) === undefined)) return `${job.label}: kamión alebo blok jobu vo svete nie je`;
  const category = unitCategory(world, job.unitIds[0]);
  const target = checkJobTarget(world, job, category);
  if (target !== undefined) return target;
  if (vehicle !== undefined && (category === undefined || !vehicle.def.cargoCategories.includes(category))) {
    return `${job.label}: ${vehicle.label} nevozí náklad kategórie '${String(category)}'`;
  }
  return checkJobUnits(world, job);
}

/** Podrobná správa, keď rezervácie skladu nesedia so slotmi jeho aktívnych jobov (len pri porušení — alokuje). */
function reservationMismatch(world: World, storage: StorageModule): string {
  const want: number[] = [];
  for (const job of world.jobs.values()) {
    const slot = uniqueSlotOf(job.to);
    if (job.toModuleId === storage.id && slot !== null) want.push(slot);
  }
  for (const machine of world.machines.values()) {
    const cycle = machine.cycle;
    if (machine.blockId === storage.id && cycle?.kind === 'put' && cycle.jobId === null && cycle.toSlot !== null) want.push(cycle.toSlot);
  }
  want.sort((a, b) => a - b);
  return `${storage.label}: rezervované sloty [${storage.reservedSlots().join(', ')}] ≠ sloty aktívnych jobov [${want.join(', ')}]`;
}

/**
 * Rezervované sloty každého skladu = presne sloty `to` aktívnych jobov s cieľom v ňom (ADR-018) — bez kópií a triedenia
 * (review T03-13): slot každého jobu je v sklade rezervovaný (`isReserved`, `checkJob`), počet jobov = `reservedCount`
 * a súčet aj súčet štvorcov slotov jobov = súčty rezervovaných slotov. Pri porušení podrobná správa
 * (`reservationMismatch`).
 */
function checkStorageReservations(world: World): string | undefined {
  for (const module of world.modules.values()) {
    if (!(module instanceof StorageModule)) continue;
    let count = 0;
    let sum = 0;
    let squares = 0;
    for (const job of world.jobs.values()) {
      const slot = uniqueSlotOf(job.to);
      if (job.toModuleId !== module.id || slot === null) continue;
      count += 1;
      sum += slot;
      squares += slot * slot;
    }
    // `put` po zdvihu drží rezerváciu slotu v cykle stroja, nie v jobe (ťahač je voľný, ADR-040 dodatok TR3-02).
    for (const machine of world.machines.values()) {
      const cycle = machine.cycle;
      if (machine.blockId !== module.id || cycle?.kind !== 'put' || cycle.jobId !== null || cycle.toSlot === null) continue;
      count += 1;
      sum += cycle.toSlot;
      squares += cycle.toSlot * cycle.toSlot;
    }
    const reserved = module.reservedCount;
    let found = 0;
    for (let slot = 0; slot < module.capacity && found < reserved; slot++) {
      if (!module.isReserved(slot)) continue;
      found += 1;
      sum -= slot;
      squares -= slot * slot;
    }
    if (count !== reserved || sum !== 0 || squares !== 0) return reservationMismatch(world, module);
  }
  return undefined;
}

const checkJobs: Check = (world) => {
  let previous = 0;
  let units = 0;
  for (const [id, job] of world.jobs) {
    if (job.id !== id) return `world.jobs: kľúč ${String(id)} ukazuje na ${job.label}`;
    if (id <= previous) return `world.jobs: ${job.label} nie je vzostupne podľa id (po #${String(previous)})`;
    previous = id;
    units += job.unitIds.length;
    const violation = checkJob(world, job);
    if (violation !== undefined) return violation;
  }
  if (world.jobUnitCount !== units) return `index jobOfUnit má ${String(world.jobUnitCount)} jednotiek, joby ${String(units)}`;
  return checkStorageReservations(world);
};

const checkBerthGroups: Check = (world) => {
  const all = berths(world);
  const expected = computeBerthGroups(all);
  if (JSON.stringify(world.berthGroups) !== JSON.stringify(expected)) {
    return `berthGroups ${JSON.stringify(world.berthGroups)} ≠ prepočet ${JSON.stringify(expected)}`;
  }
  for (const berth of all) {
    const group = expected.find((candidate) => candidate.berthIds.includes(berth.id));
    if (berth.groupId !== group?.id) return `${berth.label}: groupId ${String(berth.groupId)}, patrí do skupiny ${String(group?.id)}`;
  }
  return undefined;
};

/** Kotviská lode ležia za sebou v jednej skupine (poradie po pobreží) a držia ju (`dockedShipId`). */
function checkShipBerths(world: World, ship: Ship): string | undefined {
  const [first] = ship.berthIds;
  if (first === undefined) return undefined;
  const group = world.berthGroups.find((candidate) => candidate.berthIds.includes(first));
  const start = group?.berthIds.indexOf(first) ?? -1;
  if (group === undefined || !sameIds(group.berthIds.slice(start, start + ship.berthIds.length), ship.berthIds)) {
    return `${ship.label}: kotviská [${ship.berthIds.join(', ')}] neležia za sebou v jednej skupine kotvísk`;
  }
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) return `${ship.label}: #${String(berthId)} z berthIds nie je kotvisko`;
    if (berth.dockedShipId !== ship.id) return `${ship.label}: ${berth.label} má dockedShipId ${String(berth.dockedShipId)}`;
  }
  return undefined;
}

/** Náklad na palube: najviac `capacityUnits` TEU (ADR-039), všetky jednotky typu lode. */
function checkShipCargo(world: World, ship: Ship): string | undefined {
  const aboard = world.cargo.unitsOnShip(ship.id);
  const aboardTeu = world.cargo.teuAt('on_ship', ship.id);
  if (aboardTeu > ship.def.capacityUnits) return `${ship.label} má na palube ${String(aboardTeu)} TEU v ${String(aboard.length)} jednotkách (capacityUnits ${String(ship.def.capacityUnits)} TEU)`;
  const foreign = aboard.find((unitId) => world.cargo.get(unitId)?.typeId !== ship.cargoTypeId);
  return foreign === undefined ? undefined : `${ship.label}: jednotka #${String(foreign)} nie je typu '${ship.cargoTypeId}'`;
}

/**
 * Loď s nákladom, ktorá drží kotviská, má na nich žeriav kategórie svojho nákladu — alokátor to zaručí pri pridelení
 * a `ship_docked` zakáže odstrániť žeriav pod loďou; save v rozpore by loď nechal pri kotvisku naveky (T02-14).
 */
function checkShipCranes(world: World, ship: Ship): string | undefined {
  if (ship.berthIds.length === 0 || world.cargo.countAt('on_ship', ship.id) === 0) return undefined;
  const served = ship.berthIds.some((berthId) => {
    const berth = world.modules.get(berthId);
    return berth instanceof BerthModule && hasCompatibleCrane(world, berth, ship.cargoCategory);
  });
  if (served) return undefined;
  return `${ship.label} s nákladom drží kotviská [${ship.berthIds.join(', ')}], na ktorých nie je žeriav kategórie '${ship.cargoCategory}'`;
}

function checkShip(world: World, ship: Ship, anchorages: Map<number, Ship>): string | undefined {
  const traits = SHIP_STATE_TRAITS[ship.state];
  if (ship.state === 'despawned') return `${ship.label} v stave 'despawned' je stále vo world.ships`;
  if (!holdingAllows(traits.berths, ship.berthIds.length)) {
    return `${ship.label} v stave '${ship.state}' ${traits.berths === 'always' ? 'nedrží kotviská' : `drží kotviská [${ship.berthIds.join(', ')}]`}`;
  }
  const index = ship.anchorageIndex;
  if (index === null && traits.anchorage === 'always') return `${ship.label} v stave '${ship.state}' nedrží anchorage`;
  if (index !== null) {
    if (traits.anchorage === 'never') return `${ship.label} v stave '${ship.state}' má anchorage ${String(index)}`;
    if (ship.berthIds.length > 0) return `${ship.label} drží kotviská aj anchorage ${String(index)} (ADR-029)`;
    if (index >= world.map.anchorage.length) return `${ship.label}: anchorage ${String(index)} mimo mapy`;
    const holder = anchorages.get(index);
    if (holder !== undefined) return `${ship.label} a ${holder.label} obsadili tú istú anchorage ${String(index)}`;
    anchorages.set(index, ship);
  }
  return checkShipBerths(world, ship) ?? mooringProblem(ship, world)?.problem ?? anchoringProblem(ship, world)?.problem ?? checkShipCargo(world, ship) ?? checkShipCranes(world, ship);
}

/**
 * Žeriav v `grabbing` má čo zdvihnúť: dokovaná loď na jeho kotvisku s nákladom jeho kategórie (inak by koniec fázy
 * v `tick()` nenašiel jednotku, T02-14) a s dosť jednotkami pre všetky zdvíhajúce žeriavy.
 */
function checkGrabbingCranes(world: World): string | undefined {
  const claims = new Map<Ship, number>();
  for (const crane of cranes(world)) {
    if (crane.state !== 'grabbing') continue;
    const berth = world.modules.get(crane.berthId);
    const ship = berth instanceof BerthModule && berth.dockedShipId !== null ? world.ships.get(berth.dockedShipId) : undefined;
    if (ship?.state !== 'docked') return `${crane.label} v stave 'grabbing' nemá na kotvisku dokovanú loď`;
    if (ship.cargoCategory !== crane.category) {
      return `${crane.label} (kategória '${crane.category}') v stave 'grabbing' nad ${ship.label} s nákladom kategórie '${ship.cargoCategory}'`;
    }
    if (CRANE_CYCLE_TRAITS[crane.cycle].direction === 'unload') claims.set(ship, (claims.get(ship) ?? 0) + 1);
  }
  for (const [ship, count] of claims) {
    const aboard = importAboard(world, ship.id);
    if (count > aboard) return `${String(count)} žeriavov zdvíha z ${ship.label}, na palube je len ${String(aboard)} jednotiek importu`;
  }
  return undefined;
}

const checkShips: Check = (world) => {
  const anchorages = new Map<number, Ship>();
  let previous = 0;
  for (const [id, ship] of world.ships) {
    if (ship.id !== id) return `world.ships: kľúč ${String(id)} ukazuje na ${ship.label}`;
    if (id <= previous) return `world.ships: ${ship.label} nie je vzostupne podľa id (po #${String(previous)})`;
    previous = id;
    const violation = checkShip(world, ship, anchorages);
    if (violation !== undefined) return violation;
  }
  for (const berth of berths(world)) {
    if (berth.dockedShipId === null) continue;
    const ship = world.ships.get(berth.dockedShipId);
    if (ship === undefined) return `${berth.label}: dockedShipId ${String(berth.dockedShipId)} — loď neexistuje`;
    if (!ship.berthIds.includes(berth.id)) return `${berth.label}: dockedShipId ${String(ship.id)}, ale ${ship.label} ho nemá v berthIds`;
  }
  return checkGrabbingCranes(world) ?? shipOverlapProblem(world.ships);
};

/** Vnútorný stav každého modulu (`findRuntimeProblem`, bod 10 hlavičky). */
const checkModuleRuntime: Check = (world) => {
  for (const module of world.modules.values()) {
    const problem = module.findRuntimeProblem();
    if (problem !== undefined) return problem;
  }
  return undefined;
};

/** Náklad kamióna podľa stavu (efektívneho): pred nakládkou 0, najviac kapacita, po nej plný; len jeho kategórie. */
function checkTruckCargo(world: World, truck: Truck): string | undefined {
  const count = world.cargo.countAt('in_truck', truck.id);
  const capacity = truck.def.capacityUnits;
  const { cargo } = truck.bonds;
  if (cargo === 'empty' && count !== 0) return `${truck.label} v stave '${truck.state}' pred nakládkou vezie ${String(count)} jednotiek`;
  if (count > capacity) return `${truck.label} vezie ${String(count)} jednotiek (capacityUnits ${String(capacity)})`;
  if (cargo === 'full' && count !== capacity) return `${truck.label} v stave '${truck.state}' má byť plný (${String(capacity)}), vezie ${String(count)}`;
  if (cargo === 'loaded' && count === 0) return `${truck.label} (${truck.mission}) v stave '${truck.state}' má viezť export, je prázdny`;
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('in_truck', truck.id, i);
    const category = unitCategory(world, unitId);
    if (category === undefined || !truck.def.cargoCategories.includes(category)) {
      return `${truck.label} vezie jednotku #${String(unitId)} kategórie '${String(category)}', ktorú nevozí`;
    }
  }
  return undefined;
}

/**
 * Väzby kamióna na pruhy brány (vstupný `gateId`, výstupný `gateOutId`), predbránovú plochu (rad, R4), blok zastávky, token cieľa (TP, státie) a job zastávky (bod 11 hlavičky): kamión je vo
 * fronte vstupného pruhu práve v stavoch s bránou `entry`, vo fronte výstupného práve v stavoch s bránou `exit`; v stave `pre_gate` stojí v rade `row` svojej plochy, inak na žiadnej ploche nie je;
 * TP kamióna je TP jeho bloku, státie existuje v jeho odstavnej ploche; job zastávky patrí kamiónu a jeho bloku a existuje práve v stavoch pred odovzdaním (fáza `handling` vrátane).
 */
function checkTruckBonds(world: World, truck: Truck, gate: TruckGate, block: YardBlock): string | undefined {
  const { bonds } = truck;
  if (bonds.holdsToken !== (truck.tpCell !== null || truck.stall !== null)) return `${truck.label} v stave '${truck.effectiveState}' ${bonds.holdsToken ? 'nedrží token (TP ani státie)' : 'drží token (TP alebo státie)'}`;
  if (truck.tpCell !== null && !tpCellsOf(world, block).includes(truck.tpCell)) return `${truck.label}: TP (bunka ${String(truck.tpCell)}) nie je TP bloku ${block.label}`;
  if (truck.holdingId !== null) {
    const holding = world.modules.get(truck.holdingId);
    if (!(holding instanceof TruckHolding) || truck.stall === null || truck.stall >= holding.stalls) return `${truck.label}: státie ${String(truck.stall)} odstavnej plochy #${String(truck.holdingId)} neexistuje`;
  }
  if (truck.effectiveState === 'holding' && truck.stall === null) return `${truck.label} v stave 'holding' nedrží státie`;
  if (truck.traits.atTp !== (truck.phase !== null)) return `${truck.label} v stave '${truck.state}' ${truck.phase === null ? 'nemá fázu TP' : `má fázu '${truck.phase}'`}`;
  const jobProblem = checkTruckJob(world, truck, block);
  if (jobProblem !== undefined) return jobProblem;
  const queued = inGateQueue(truck);
  const side = TRUCK_STATE_TRAITS[truck.state].gateSide;
  if (gate.isQueued(truck.id) !== (queued && side === 'entry')) return `${truck.label} v stave '${truck.state}' ${queued && side === 'entry' ? 'nie je' : 'je'} vo fronte ${gate.label}`;
  if (truck.gateOutId !== null) {
    const out = world.modules.get(truck.gateOutId);
    if (!(out instanceof TruckGate)) return `${truck.label}: výstupný pruh #${String(truck.gateOutId)} vo svete nie je`;
    if (out.isQueued(truck.id) !== (queued && side === 'exit')) return `${truck.label} v stave '${truck.state}' ${queued && side === 'exit' ? 'nie je' : 'je'} vo fronte ${out.label}`;
  } else if (queued && side === 'exit') return `${truck.label} v stave '${truck.state}' nemá výstupný pruh`;
  return checkTruckPreGate(world, truck);
}

/** Fázy TP, v ktorých kamión drží job zastávky (odovzdanie ešte neskončilo); po nich a po odchode z TP je `jobId` `null`. */
const PHASES_WITH_JOB: readonly (string | null)[] = ['safe_in', 'unlash', 'handling'];

/** Job zastávky kamióna (R4, ADR-041 bod 4): pred TP vždy, na TP do konca odovzdania, potom žiadny; job patrí kamiónu a jeho bloku a nesie jeho jednotku. */
function checkTruckJob(world: World, truck: Truck, block: YardBlock): string | undefined {
  const state = truck.effectiveState;
  const beforeTp = state !== 'at_tp' && state !== 'at_edge_tp' && truck.bonds.holdsToken;
  const expectsJob = beforeTp || (truck.traits.atTp && PHASES_WITH_JOB.includes(truck.phase));
  if (expectsJob !== (truck.jobId !== null)) return `${truck.label} v stave '${truck.state}'${truck.phase === null ? '' : ` (fáza ${truck.phase})`} ${expectsJob ? 'nemá job zastávky' : `má job #${String(truck.jobId)}`}`;
  if (truck.jobId === null) return truck.bonds.holdsToken && truck.unitId === null && !truck.traits.atTp ? `${truck.label} bez jobu nemá jednotku zastávky` : undefined;
  const job = world.jobs.get(truck.jobId);
  if (job === undefined) return `${truck.label}: job #${String(truck.jobId)} zastávky vo svete nie je`;
  if (truckOfJob(world, job)?.id !== truck.id || truckJobBlock(world, job)?.id !== block.id) return `${truck.label}: ${job.label} nepatrí jemu a jeho bloku ${block.label}`;
  if (job.unitIds[0] !== truck.unitId) return `${truck.label}: jednotka jobu #${String(job.unitIds[0])} ≠ jednotka zastávky #${String(truck.unitId)}`;
  return undefined;
}

/** Kamión v `pre_gate` stojí v rade `row` svojej predbránovej plochy; kamión v inom stave na žiadnej ploche nie je (R4, ADR-041 bod 2). */
function checkTruckPreGate(world: World, truck: Truck): string | undefined {
  const onPreGate = truck.state === 'pre_gate';
  if (truck.preGateId === null) return undefined;
  const buffer = world.modules.get(truck.preGateId);
  if (!(buffer instanceof PreGateBuffer)) return `${truck.label}: predbránová plocha #${String(truck.preGateId)} vo svete nie je`;
  const row = buffer.rowOf(truck.id);
  if (onPreGate && (row < 0 || row !== truck.row)) return `${truck.label} v stave 'pre_gate' (rad ${String(truck.row)}) nie je v tomto rade ${buffer.label}`;
  if (!onPreGate && row >= 0) return `${truck.label} v stave '${truck.state}' je na ploche ${buffer.label}`;
  return undefined;
}

/** Je kamión v zozname fronty svojej brány — čaká v nej (`gate_queue*`) alebo ako jej čelo prechádza bránou (`gate_pass*`, ADR-037)? */
export function inGateQueue(truck: Truck): boolean {
  const traits = TRUCK_STATE_TRAITS[truck.state];
  return traits.queued || traits.passing;
}

/** Pruh brány, v ktorého fronte kamión stojí v aktuálnom stave: vstupný (`gateId`) pri bráne `entry`, výstupný (`gateOutId`) pri bráne `exit`; stav bez brány → `gateId`. */
export function queueGateIdOf(truck: Truck): EntityId | null {
  return TRUCK_STATE_TRAITS[truck.state].gateSide === 'exit' ? truck.gateOutId : truck.gateId;
}

/** Kamión vo fronte stojí na svojej strane brány, ak je určená (`isOffQueueSide`, dodatok ADR-024); kamión v prechode (`gate_pass*`) sa nekontroluje. */
export function truckQueueSideProblem(world: World, truck: Truck): string | undefined {
  if (!isOffQueueSide(world, truck)) return undefined;
  return `${truck.label} v stave '${truck.state}' stojí na bunke ${String(truck.cell)}, nie na svojej strane brány (${String(gateNearSideCell(world, truck))})`;
}

function checkTruck(world: World, truck: Truck): string | undefined {
  if (truck.state === 'exited') return `${truck.label} v stave 'exited' je stále vo world.trucks`;
  const gate = world.modules.get(truck.gateId);
  const block = world.modules.get(truck.blockId);
  if (!(gate instanceof TruckGate)) return `${truck.label}: brána #${String(truck.gateId)} vo svete nie je`;
  if (!(block instanceof YardBlock)) return `${truck.label}: blok #${String(truck.blockId)} vo svete nie je`;
  const { width, height } = world.grid;
  if (!isWithin(truck.x, width) || !isWithin(truck.y, height)) return `${truck.label} stojí mimo mapy (${String(truck.x)}, ${String(truck.y)})`;
  return checkTruckBonds(world, truck, gate, block) ?? checkTruckCargo(world, truck) ?? truckMotionProblem(world, truck)?.problem ?? truckQueueSideProblem(world, truck);
}

/**
 * Kamióny a ich väzby (bod 11 hlavičky) jedným prechodom kamiónov a jedným prechodom modulov: každý kamión drží token (TP alebo státie) práve podľa stavu, TP a státia nemajú dvoch držiteľov,
 * kamión je držiteľom miesta vo fronte brány a v predbránovej ploche práve podľa stavu a súčty držaných miest v moduloch sa rovnajú počtom kamiónov.
 */
const checkTrucks: Check = (world) => {
  let previous = 0;
  let queued = 0;
  let preGated = 0;
  const tps = new Set<number>();
  const stalls = new Set<number>();
  for (const [id, truck] of world.trucks) {
    if (truck.id !== id) return `world.trucks: kľúč ${String(id)} ukazuje na ${truck.label}`;
    if (id <= previous) return `world.trucks: ${truck.label} nie je vzostupne podľa id (po #${String(previous)})`;
    previous = id;
    const violation = checkTruck(world, truck);
    if (violation !== undefined) return violation;
    if (truck.tpCell !== null) {
      if (tps.has(truck.tpCell)) return `TP (bunka ${String(truck.tpCell)}) drží viac kamiónov (aj ${truck.label})`;
      tps.add(truck.tpCell);
    }
    if (truck.holdingId !== null && truck.stall !== null) {
      const key = truck.holdingId * 1000 + truck.stall;
      if (stalls.has(key)) return `státie ${String(truck.stall)} odstavnej plochy #${String(truck.holdingId)} drží viac kamiónov (aj ${truck.label})`;
      stalls.add(key);
    }
    if (inGateQueue(truck)) queued += 1;
    if (truck.state === 'pre_gate') preGated += 1;
  }
  let queueLength = 0;
  const { gates, preGates } = world.landsideModules;
  let preGateHeld = 0;
  for (const buffer of preGates) preGateHeld += buffer.occupied;
  for (const gate of gates) queueLength += gate.queueLength;
  if (preGateHeld !== preGated) return `predbránové plochy držia ${String(preGateHeld)} kamiónov, v pre_gate je ${String(preGated)}`;
  if (queueLength !== queued) return `fronty pruhov brán majú ${String(queueLength)} kamiónov, v gate_queue* a gate_pass* je ${String(queued)}`;
  return undefined;
};

/**
 * Kontrakty (ADR-026, ADR-032, ADR-034), O(neukončené kontrakty) bez alokácie: počet ponúk po skupinách voyage (import ≤
 * `offersPerDay`, booking ≤ `bookingOffersPerDay`, repositioning ≤ `repositioningOffersPerDay`, prekládka ≤ `transhipOffersPerDay`,
 * `ContractBook.offeredGroups`); počítadlá podľa druhu (`Contract.countersProblem` — import `unitsExported ≤ unitsUnloaded ≤ volumeUnits`,
 * `exporting` má vyložený celý objem; export booking pozri `ExportContract`); index zadržaných jednotiek = Σ `heldUnits` bookingov;
 * kontrakt, ktorý vlastní náklad na palube (`carriesShipCargo`: import a prekládka v `ship_en_route`, `unloading`), má loď na mape s triedou
 * a nákladom kontraktu a na jej palube práve `volumeUnits − unitsUnloaded` jednotiek na vykládku (naložený náklad lode sa nepočíta);
 * otvorený booking s loďou na mape, na ktorú nakladá (`loadShipId`), má `loadedUnits` = počet jednotiek jeho nákladu na jej palube
 * (`Contract.loadsUnit`: export podľa kontraktu, prázdne repositioningu podľa linky; T6A-09b; prekládka najviac — po záchrane zmeškanej prekládky
 * sú dávky naložené na predchádzajúcu loď už `shipped`); po odchode lode, keď sú jednotky `shipped`, sa neoveruje — booking sa uzavrie
 * v nasledujúcom ticku); index uskladneného nákladu (`World.storedCargo`, ADR-027) má toľko jednotiek, koľko ich je `in_storage`. Väzbu
 * jednotka → kontrakt overuje obnova save (`checkContracts` vo world-restore).
 */
/** Počet jednotiek nákladu kontraktu `contract` na palube lode `shipId` (`Contract.loadsUnit`, bez alokácie). */
function loadedAboardOf(world: World, shipId: EntityId, contract: Contract): number {
  const count = world.cargo.countAt('on_ship', shipId);
  let units = 0;
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', shipId, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined && contract.loadsUnit(unit)) units += 1;
  }
  return units;
}

/**
 * Dva bookingy repositioningu jednej lode a linky nakladajú tie isté prázdne (prázdne nemajú kontrakt) — ich naložené jednotky sa sčítajú.
 * Súčty zbiera `collectSharedEmpties` jedným prechodom kontraktov (T6C-07b: predtým prechod všetkých kontraktov pre každý kontrakt, O(n²));
 * záznamy sú paralelné polia znovupoužiteľné medzi tickami (kľúč = loď a linka, hodnota = Σ `loadedUnits`).
 */
const SHARED_SHIP: (EntityId | undefined)[] = [];
const SHARED_LINE: string[] = [];
const SHARED_LOADED: number[] = [];

/** Dvojica bookingov repositioningu s rovnakou loďou a linkou nakladá tie isté prázdne (súčet `loadedUnits`)? */
function sharesEmpties(contract: Contract, ship: EntityId | undefined, line: string): boolean {
  return contract.kind === 'empty_repositioning' && contract.loadShipId === ship && contract.lineId === line;
}

/** Zbiera Σ `loadedUnits` bookingov repositioningu podľa dvojice (loď, linka) do polí `SHARED_*`; jeden prechod kontraktov. */
function collectSharedEmpties(world: World): void {
  SHARED_SHIP.length = 0;
  SHARED_LINE.length = 0;
  SHARED_LOADED.length = 0;
  for (const contract of world.contractBook.openContracts.values()) {
    if (contract.kind !== 'empty_repositioning') continue;
    let at = 0;
    while (at < SHARED_SHIP.length && !sharesEmpties(contract, SHARED_SHIP[at], SHARED_LINE[at])) at += 1;
    if (at === SHARED_SHIP.length) {
      SHARED_SHIP.push(contract.loadShipId);
      SHARED_LINE.push(contract.lineId);
      SHARED_LOADED.push(0);
    }
    SHARED_LOADED[at] += contract.booking?.loadedUnits ?? 0;
  }
}

/** `loadedUnits` bookingu zvýšené o `loadedUnits` ostatných bookingov, s ktorými nakladá tie isté prázdne (iba repositioning; ostatné vlastné). */
function loadedWithShared(contract: Contract, own: number): number {
  if (contract.kind !== 'empty_repositioning') return own;
  for (let at = 0; at < SHARED_SHIP.length; at++) if (sharesEmpties(contract, SHARED_SHIP[at], SHARED_LINE[at])) return SHARED_LOADED[at];
  return own;
}

/** Naložené jednotky bookingu na jeho lodi: export a prázdne presne (`exact`), prekládka najviac (`at_most` — záchrana nakladá ďalšiu loď). */
const LOADED_ABOARD_CHECK: { readonly [K in ContractKind]: 'exact' | 'at_most' } = Object.freeze({
  import: 'exact',
  export: 'exact',
  empty_repositioning: 'exact',
  tranship: 'at_most',
});

/** Porušenie vzťahu `loadedUnits` bookingu k jednotkám na jeho lodi (viď hlavička kontraktov), alebo `undefined`. */
function loadedProblem(world: World, contract: Contract): string | undefined {
  const booking = contract.booking;
  const ship = contract.loadShipId === undefined ? undefined : world.ships.get(contract.loadShipId);
  if (booking === null || ship === undefined) return undefined;
  const aboard = loadedAboardOf(world, ship.id, contract);
  const loaded = loadedWithShared(contract, booking.loadedUnits);
  const ok = LOADED_ABOARD_CHECK[contract.kind] === 'exact' ? aboard === loaded : aboard <= loaded;
  return ok ? undefined : `${contract.label}: loadedUnits ${String(loaded)}, na ${ship.label} je ${String(aboard)} jednotiek nákladu bookingu`;
}

const checkContracts: Check = (world) => {
  collectSharedEmpties(world);
  let offers = 0;
  for (const contract of world.contractBook.openContracts.values()) {
    const { label, state } = contract;
    if (CONTRACT_STATE_TRAITS[state].offer) offers += 1;
    const counters = contract.countersProblem();
    if (counters !== undefined) return `${label}: ${counters}`;
    const loaded = loadedProblem(world, contract);
    if (loaded !== undefined) return loaded;
    if (!contract.carriesShipCargo) continue;
    const ship = contract.shipId === undefined ? undefined : world.ships.get(contract.shipId);
    if (ship === undefined) return `${label}: loď kontraktu #${String(contract.shipId)} nie je na mape`;
    if (ship.classId !== contract.shipClassId || ship.cargoTypeId !== contract.cargoTypeId) return `${label}: ${ship.label} nemá triedu a náklad kontraktu`;
    const aboard = importAboard(world, ship.id);
    if (aboard !== contract.volumeUnits - contract.unitsUnloaded) {
      return `${label}: na ${ship.label} je ${String(aboard)} import jednotiek, očakávané volume − unloaded = ${String(contract.volumeUnits - contract.unitsUnloaded)}`;
    }
  }
  const groups = world.contractBook.offeredGroups();
  const { offersPerDay, bookingOffersPerDay, repositioningOffersPerDay, transhipOffersPerDay } = world.defs.economy;
  if (groups.import > offersPerDay) return `pool má ${String(groups.import)} import ponúk > offersPerDay ${String(offersPerDay)} (ponúk spolu ${String(offers)})`;
  if (groups.booking > bookingOffersPerDay) return `pool má ${String(groups.booking)} booking ponúk > bookingOffersPerDay ${String(bookingOffersPerDay)}`;
  if (groups.repositioning > repositioningOffersPerDay) return `pool má ${String(groups.repositioning)} ponúk repositioningu > repositioningOffersPerDay ${String(repositioningOffersPerDay)}`;
  if (groups.tranship > transhipOffersPerDay) return `pool má ${String(groups.tranship)} ponúk prekládky > transhipOffersPerDay ${String(transhipOffersPerDay)}`;
  let held = 0;
  for (const contract of world.contractBook.contracts.values()) held += contract.booking?.heldUnits ?? 0;
  if (world.holdIndex.size !== held) return `index zadržaných jednotiek má ${String(world.holdIndex.size)} záznamov, kontrakty ${String(held)} jednotiek v hold`;
  const stored = world.cargo.countByKind('in_storage');
  return world.storedCargo.size === stored ? undefined : `index uskladneného nákladu má ${String(world.storedCargo.size)} jednotiek, sklady ${String(stored)}`;
};

/** Jednotka pridelená poverenému kamiónu je v ceste na jeho TP (viď bod 12 hlavičky); `undefined` = v poriadku. */
function errandUnitProblem(world: World, truck: Truck, unitId: EntityId): string | undefined {
  const unit = world.cargo.get(unitId);
  if (unit === undefined) return `${truck.label}: pridelený prázdny #${String(unitId)} v ledgeri nie je`;
  if (unit.direction !== 'empty') return `${truck.label}: pridelená jednotka #${String(unitId)} nie je prázdny kontajner (${unit.direction})`;
  const { location } = unit;
  if (location.kind === 'in_truck') return location.truckId === truck.id ? undefined : `${truck.label}: pridelený prázdny #${String(unitId)} vezie iný kamión`;
  if (location.kind !== 'in_storage' && location.kind !== 'in_vehicle' && location.kind !== 'in_handler') return `${truck.label}: pridelený prázdny #${String(unitId)} je v '${location.kind}'`;
  // Kým kamión nenaložil, jednotka má job `receive` práve tohto kamióna (po zdvihu strojom je v `in_handler` a job ešte beží).
  const job = world.jobOfUnit(unitId);
  if (job?.to.kind !== 'in_truck' || job.to.truckId !== truck.id) return `${truck.label}: pridelený prázdny #${String(unitId)} nemá job na tento kamión`;
  return undefined;
}

/** Znovupoužiteľná množina pridelených prázdnych pre `checkEmptyFlow` (hot path kroku 12; pred použitím sa vyprázdni). */
const TAKEN_EMPTIES = new Set<number>();

/** Tok prázdnych kontajnerov (bod 12 hlavičky). */
const checkEmptyFlow: Check = (world) => {
  const { errands } = world.emptyFlow;
  for (const truck of world.trucks.values()) {
    if (truck.mission === 'collect' && world.emptyFlow.errandOfTruck(truck.id) === undefined) {
      return `${truck.label} (collect) v stave '${truck.state}' nemá poverenie v emptyFlow`;
    }
  }
  const taken = TAKEN_EMPTIES;
  taken.clear();
  for (const errand of errands) {
    const truck = world.trucks.get(errand.truckId as EntityId);
    if (truck?.mission !== 'collect') return `poverenie kamióna #${String(errand.truckId)}: kamión nie je misie collect`;
    const contract = world.contractBook.get(errand.contractId as ContractId);
    if (contract === undefined || contract.lineId !== errand.lineId) return `${truck.label}: poverenie ukazuje na kontrakt #${String(errand.contractId)} inej linky alebo mimo knihy`;
    if (errand.unitId === null) return `${truck.label}: poverenie nemá pridelený prázdny kontajner (pridelí sa pri vzniku kamióna)`;
    if (taken.has(errand.unitId)) return `prázdny #${String(errand.unitId)} je pridelený dvom kamiónom`;
    taken.add(errand.unitId);
    const problem = errandUnitProblem(world, truck, errand.unitId as EntityId);
    if (problem !== undefined) return problem;
    if (world.cargo.get(errand.unitId as EntityId)?.lineId !== errand.lineId) return `${truck.label}: pridelený prázdny #${String(errand.unitId)} patrí inej linke než poverenie ${errand.lineId}`;
  }
  for (const module of world.modules.values()) {
    if (!(module instanceof EmptyDepot)) continue;
    const count = world.cargo.countAt('in_storage', module.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('in_storage', module.id, i);
      const direction = unitId === undefined ? undefined : world.cargo.get(unitId)?.direction;
      if (direction !== 'empty') return `${module.label} drží jednotku #${String(unitId)} smeru '${String(direction)}', depo prijíma len prázdne`;
    }
  }
  return undefined;
};

/** Doprava bez prekrývania (ADR-037): sloty = telá nosičov, žiadny prekryv, nosič mimo cesty nič nedrží. */
const checkCarrierOverlap: Check = (world) => carrierOverlapProblem(world) ?? undefined;

/**
 * Reefery (R5, ADR-042): jednotka stojí v sklade len na pozícii so zásuvkou (kontroluje `YardBlock.findStackProblem` cez `checkModuleRuntime`), blok so zásuvkami drží len jednotky, ktoré zásuvku
 * potrebujú, reefer mimo lode je v indexe `world.reeferIndex` a zapojený reefer leží v sklade (na palube ho napája loď) — inak by hodiny bez napájania nikdy neboli spustené.
 */
const checkReefers: Check = (world) => {
  for (const unit of world.cargo.liveUnits()) {
    const reefer = unit.reefer;
    if (reefer === null) continue;
    const { kind } = unit.location;
    if (kind !== 'on_ship' && !world.reeferIndex.has(unit.id)) return `reefer #${String(unit.id)} (${kind}) nie je v indexe reeferov`;
    if (reefer.plugged && kind !== 'on_ship' && kind !== 'in_storage') return `reefer #${String(unit.id)} je zapojený mimo lode a skladu (${kind})`;
  }
  for (const module of world.modules.values()) {
    if (!(module instanceof YardBlock) || !module.hasSockets) continue;
    const count = world.cargo.countAt('in_storage', module.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('in_storage', module.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit !== undefined && unit.reefer === null) return `${module.label} (zásuvky) drží jednotku #${String(unitId)} typu '${unit.containerType}', ktorá zásuvku nepotrebuje`;
    }
  }
  return undefined;
};

/**
 * Vlaky (R6, ADR-043): terminál existuje a má koľaj vlaku, každá koľaj najviac jeden vlak, najviac jeden pohyblivý vlak (žetón pohybu), poloha v rozsahu trasy (pobyt = koniec trasy), bunky trasy sú
 * mapové koľaje alebo koľaje terminálu a obsadenie `rail.occupancy` presne zodpovedá polohám vlakov (žiadne prekrytie dvoch vlakov). Náklad vo vlaku: miesto v rozsahu vlaku, jednotka sa
 * zmestí do jedného vagóna (40′ nepresahuje vagón) a jednotky sa neprekrývajú (druhá polovica 40′ je tiež obsadená).
 */
const checkTrains: Check = (world) => {
  const { rail } = world;
  const expected = new Int32Array(rail.occupancy.length);
  const tracks = new Set<string>();
  let movers = 0;
  for (const [id, train] of rail.trains) {
    if (train.id !== id) return `world.trains: kľúč ${String(id)} ukazuje na ${train.label}`;
    const terminal = world.modules.get(train.terminalId);
    if (!(terminal instanceof RailTerminal) || train.track >= terminal.tracks) return `${train.label}: terminál #${String(train.terminalId)} s koľajou ${String(train.track)} vo svete nie je`;
    const trackKey = `${String(train.terminalId)}:${String(train.track)}`;
    if (tracks.has(trackKey)) return `${train.label}: koľaj ${trackKey} má viac vlakov`;
    tracks.add(trackKey);
    if (train.moving) movers += 1;
    if (train.posMilli > train.stopMilli || train.posMilli < 0) return `${train.label}: poloha ${String(train.posMilli)} je mimo trasy`;
    if (train.state === 'dwelling' && (train.posMilli !== train.stopMilli || train.stoppedTick === null || train.departAtTick === null)) return `${train.label}: v pobyte stojí na konci trasy a má plán odchodu`;
    const { lo, hi } = train.occupiedRangeAt(train.posMilli);
    for (let i = lo; i <= hi; i++) {
      const cell = train.route[i];
      if (expected[cell] !== 0) return `${train.label} sa prekrýva s vlakom #${String(expected[cell])} na bunke ${String(cell)}`;
      expected[cell] = train.id;
    }
    const taken: boolean[] = new Array<boolean>(train.slotCount).fill(false);
    for (const unitId of world.cargo.unitsAt('in_train', train.id)) {
      const unit = world.cargo.get(unitId);
      if (unit === undefined || unit.location.kind !== 'in_train') continue;
      const first = unit.location.slot;
      const teu = teuOf(unit);
      if (first + teu > train.slotCount || train.wagonOfSlot(first) !== train.wagonOfSlot(first + teu - 1)) return `${train.label}: jednotka #${String(unitId)} (${String(teu)} TEU) na mieste ${String(first)} nepatrí do jedného vagóna`;
      for (let i = first; i < first + teu; i++) {
        if (taken[i]) return `${train.label}: miesto ${String(i)} zaberá viac jednotiek`;
        taken[i] = true;
      }
    }
  }
  if (movers > 1) return `po koľajisku jazdí ${String(movers)} vlakov naraz (najviac jeden)`;
  for (let cell = 0; cell < expected.length; cell++) {
    if (expected[cell] !== rail.occupancy[cell]) return `obsadenie koľajiska: bunka ${String(cell)} má vlak #${String(rail.occupancy[cell])}, má #${String(expected[cell])}`;
  }
  return undefined;
};

const CHECKS: readonly Check[] = [
  checkCargoHolders,
  checkModuleCells,
  checkCranes,
  checkCargoSlots,
  checkModuleRuntime,
  checkBerthGroups,
  checkShips,
  checkDepots,
  checkVehicles,
  checkMachines,
  checkJobs,
  checkTrucks,
  checkTrains,
  checkCarrierOverlap,
  checkEmptyFlow,
  checkContracts,
  checkReefers,
];

/** Prvé porušenie invariantov sveta (viď hlavička súboru), alebo `undefined`. Svet nemení. */
export function findWorldViolation(world: World): string | undefined {
  for (const check of CHECKS) {
    const violation = check(world);
    if (violation !== undefined) return violation;
  }
  return undefined;
}
