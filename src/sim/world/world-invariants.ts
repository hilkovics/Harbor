/**
 * Invarianty sveta nad rámec ledgera (ARCHITECTURE §6 krok 12, §16; ADR-014): moduly, mriežka, žeriavy, aprony
 * a skupiny kotvísk musia zodpovedať sebe navzájom aj `CargoLedger`. `World.assertInvariants()` ich volá po
 * `cargo.assertConservation()`; krok 12 ticku ho spustí od T02-05, loader save ho volá ako poslednú poistku.
 *
 * Kontroly (prvé porušenie vyhráva, správa pomenuje entity):
 * 1. každá jednotka nákladu je u existujúceho držiteľa (`CARGO_HOLDER_SOURCES`);
 * 2. mriežka: bunky modulu (okrem žeriavu) majú `moduleId` modulu a žiadnu cestu, iné bunky nemajú `moduleId`;
 * 3. žeriav: stojí celý na svojom berthe, má jeho rotáciu, berth ho eviduje, držaná jednotka, rezervácia a fáza
 *    zodpovedajú ledgeru, apronu a `CRANE_STATE_TRAITS` (`cranePhaseProblem`); berth: `craneIds` = jeho žeriavy v poradí umiestnenia,
 *    najviac `maxCranes`, bez prekryvu, rezervácie apronu = rezervácie jeho žeriavov;
 * 4. sloty modulov (`Module.cargoSlots()`: apron, sklad; ADR-017): obsadenie je v ledgeri, modul drží len rezervácie —
 *    rezervovaný slot nie je obsadený, rezervácie ≤ kapacita, `stored + reserved ≤ capacity`, slot jednotky v rozsahu
 *    (`SlotReservations.findProblem`); kapacita apronu = `apronSlots`, skladu = `capacityUnits`; v sklade len jednotky
 *    jeho kategórie;
 * 5. `berthGroups` a `groupId` = prepočet `computeBerthGroups`;
 * 6. lode (ADR-016): kľúč = id, vzostupne podľa id, stav bez `despawned`; `berthIds` neprázdne práve pri
 *    `holdsBerths`, ležia za sebou v jednej skupine v poradí po pobreží a každý berth má `dockedShipId` = loď;
 *    dokovaná loď stojí presne v `dockPoint` s kurzom `DOCKED_HEADING` (`mooringProblem`, T02-14);
 *    každý `dockedShipId` patrí existujúcej lodi, ktorá ho má v `berthIds` (súlad `dockedShipId` ↔ `berthIds`);
 *    `anchorageIndex` len pri `waitsForBerth`, v mape a jedinečný; na palube najviac `capacityUnits` jednotiek, všetky
 *    typu `cargoTypeId`; loď s nákladom, ktorá drží kotviská, má na nich aspoň jeden žeriav kategórie svojho nákladu
 *    (inak by pri kotvisku ostala naveky, T02-14); žeriav v `grabbing` má na kotvisku dokovanú loď s nákladom
 *    svojej kategórie a žeriavov v `grabbing` nad loďou nie je viac ako jednotiek na jej palube (každý má čo zdvihnúť);
 * 7. depo vozidiel (ADR-017): `vehicleIds` bez duplicít a najviac `capacity`;
 * 8. vozidlá (T03-04): kľúč = id, vzostupne podľa id, depo existuje a je `VehicleDepot`, `vehicleIds` každého depa =
 *    jeho vozidlá vzostupne podľa id (poradie nákupu), job zodpovedá stavu (`VEHICLE_STATE_TRAITS.hasJob`) a existuje
 *    (joby pribudnú v T03-05 — dovtedy je každý `jobId` visiaci), poloha je konečná v rozsahu mapy, náklad vo vozidle
 *    najviac `capacityUnits` a len kategórií z `cargoCategories`.
 */
import { CARGO_HOLDER_KINDS } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { computeBerthGroups } from '../modules/berth-group';
import { CRANE_STATE_TRAITS, CraneModule, cranePhaseProblem } from '../modules/crane-module';
import { StorageModule } from '../modules/storage-module';
import { VehicleDepot } from '../modules/vehicle-depot';
import { hasCompatibleCrane } from '../ships/berth-allocator';
import type { Ship } from '../ships/ship';
import { SHIP_STATE_TRAITS } from '../ships/ship-fsm';
import { mooringProblem } from '../ships/ship-route';
import type { Vehicle } from '../vehicles/vehicle';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
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

function sameIds(a: readonly EntityId[], b: readonly EntityId[]): boolean {
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
  for (let i = 0; i < grid.cellCount; i++) {
    const { moduleId } = grid.atIndex(i);
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
  if (traits.hasReservation !== (crane.reservedSlot !== null)) {
    return `${crane.label} v stave '${crane.state}' ${traits.hasReservation ? 'nemá' : 'má'} rezervovaný slot`;
  }
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
  const expected = own
    .map((crane) => crane.reservedSlot)
    .filter((slot): slot is number => slot !== null)
    .sort((a, b) => a - b);
  const reserved = berth.apron.reservedSlots();
  if (reserved.length !== expected.length || reserved.some((slot, i) => slot !== expected[i])) {
    return `${berth.label}: rezervované sloty apronu [${reserved.join(', ')}] ≠ rezervácie žeriavov [${expected.join(', ')}]`;
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
  if (module instanceof StorageModule) return module.params.capacityUnits;
  return undefined;
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

const checkDepots: Check = (world) => {
  for (const module of world.modules.values()) {
    if (!(module instanceof VehicleDepot)) continue;
    const ids = module.vehicleIds;
    if (new Set(ids).size !== ids.length) return `${module.label}: vehicleIds [${ids.join(', ')}] obsahujú duplicitu`;
    if (ids.length > module.capacity) return `${module.label} má ${String(ids.length)} vozidiel (capacity ${String(module.capacity)})`;
    const own = [...world.vehicles.values()].filter((vehicle) => vehicle.depotId === module.id).map((vehicle) => vehicle.id);
    if (!sameIds(ids, own)) return `${module.label}: vehicleIds [${ids.join(', ')}] ≠ vozidlá depa podľa id [${own.join(', ')}]`;
  }
  return undefined;
};

/** Náklad vozidla: najviac `capacityUnits` jednotiek a len kategórie, ktoré vozidlo vozí. */
function checkVehicleCargo(world: World, vehicle: Vehicle): string | undefined {
  const held = world.cargo.unitsAt('in_vehicle', vehicle.id);
  if (held.length > vehicle.def.capacityUnits) {
    return `${vehicle.label} vezie ${String(held.length)} jednotiek (capacityUnits ${String(vehicle.def.capacityUnits)})`;
  }
  for (const unitId of held) {
    const typeId = world.cargo.get(unitId)?.typeId;
    const category = typeId === undefined || !world.defs.cargoTypes.has(typeId) ? undefined : world.defs.cargoTypes.get(typeId).category;
    if (category === undefined || !vehicle.def.cargoCategories.includes(category)) {
      return `${vehicle.label} vezie jednotku #${String(unitId)} kategórie '${String(category)}', ktorú nevozí`;
    }
  }
  return undefined;
}

function checkVehicle(world: World, vehicle: Vehicle): string | undefined {
  const depot = world.modules.get(vehicle.depotId);
  if (!(depot instanceof VehicleDepot)) return `${vehicle.label} patrí #${String(vehicle.depotId)}, ktorý nie je depo vozidiel`;
  if (!depot.vehicleIds.includes(vehicle.id)) return `${vehicle.label} chýba vo vehicleIds depa ${depot.label}`;
  const { hasJob } = VEHICLE_STATE_TRAITS[vehicle.state];
  if (hasJob !== (vehicle.jobId !== null)) {
    return `${vehicle.label} v stave '${vehicle.state}' ${hasJob ? 'nemá job' : `má job #${String(vehicle.jobId)}`}`;
  }
  // Joby pribudnú v T03-05 (`world.jobs`); dovtedy každý jobId odkazuje na neexistujúci job.
  if (vehicle.jobId !== null) return `${vehicle.label}: job #${String(vehicle.jobId)} neexistuje`;
  const { width, height } = world.grid;
  const inMap = (value: number, max: number): boolean => Number.isFinite(value) && value >= 0 && value <= max;
  if (!inMap(vehicle.x, width) || !inMap(vehicle.y, height)) {
    return `${vehicle.label} stojí mimo mapy (${String(vehicle.x)}, ${String(vehicle.y)})`;
  }
  return checkVehicleCargo(world, vehicle);
}

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

/** Náklad na palube: najviac `capacityUnits`, všetky jednotky typu lode. */
function checkShipCargo(world: World, ship: Ship): string | undefined {
  const aboard = world.cargo.unitsOnShip(ship.id);
  if (aboard.length > ship.def.capacityUnits) return `${ship.label} má na palube ${String(aboard.length)} jednotiek (capacityUnits ${String(ship.def.capacityUnits)})`;
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
  if (traits.holdsBerths !== ship.berthIds.length > 0) {
    return `${ship.label} v stave '${ship.state}' ${traits.holdsBerths ? 'nedrží kotviská' : `drží kotviská [${ship.berthIds.join(', ')}]`}`;
  }
  const index = ship.anchorageIndex;
  if (index !== null) {
    if (!traits.waitsForBerth) return `${ship.label} v stave '${ship.state}' má anchorage ${String(index)}`;
    if (index >= world.map.anchorage.length) return `${ship.label}: anchorage ${String(index)} mimo mapy`;
    const holder = anchorages.get(index);
    if (holder !== undefined) return `${ship.label} a ${holder.label} obsadili tú istú anchorage ${String(index)}`;
    anchorages.set(index, ship);
  }
  return checkShipBerths(world, ship) ?? mooringProblem(ship, world)?.problem ?? checkShipCargo(world, ship) ?? checkShipCranes(world, ship);
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
    claims.set(ship, (claims.get(ship) ?? 0) + 1);
  }
  for (const [ship, count] of claims) {
    const aboard = world.cargo.countAt('on_ship', ship.id);
    if (count > aboard) return `${String(count)} žeriavov zdvíha z ${ship.label}, na palube je len ${String(aboard)} jednotiek`;
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
  return checkGrabbingCranes(world);
};

const CHECKS: readonly Check[] = [
  checkCargoHolders,
  checkModuleCells,
  checkCranes,
  checkCargoSlots,
  checkBerthGroups,
  checkShips,
  checkDepots,
  checkVehicles,
];

/** Prvé porušenie invariantov sveta (viď hlavička súboru), alebo `undefined`. Svet nemení. */
export function findWorldViolation(world: World): string | undefined {
  for (const check of CHECKS) {
    const violation = check(world);
    if (violation !== undefined) return violation;
  }
  return undefined;
}
