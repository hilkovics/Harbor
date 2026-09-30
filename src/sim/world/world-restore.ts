/**
 * Obnova entít zo save (ARCHITECTURE §14, ADR-014, ADR-016, ADR-017): moduly v poradí save (= poradie umiestnenia) cez
 * `ModuleRegistry` a `World.addModule` (sklad obnoví svoje rezervácie z `runtime`), lode vzostupne podľa id cez
 * `World.addShip` (pred kontrolou držiteľov nákladu — `on_ship` číta `world.ships`) s obnovou
 * `BerthModule.dockedShipId` z `berthIds`, potom kontrola držiteľov a slotov nákladu (slot v kapacite apronu/skladu),
 * rezervácie apronov z `reservedSlot` žeriavov a držané jednotky žeriavov z `in_crane`. Obsadenie apronov a skladov
 * sa neobnovuje — čítajú ho z ledgera (ADR-017). Na koniec beží `findWorldViolation` ako poistka. Každá chyba je
 * `WorldStateError` s JSON pointerom.
 */
import { holderIdOf, holderSpecOf, uniqueSlotOf } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { CRANE_STATE_TRAITS, CraneModule } from '../modules/crane-module';
import { ModuleError, ModuleStateError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import { mooringProblem, shipRoute } from '../ships/ship-route';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import { WorldStateError, pointerSegment } from './state-check';
import type { World } from './world';
import { findWorldViolation } from './world-invariants';
import type { ParsedModuleEntry, ParsedShipEntry } from './world-state';

const modulePath = (index: number): string => `/modules${pointerSegment(index)}`;
const unitPath = (index: number): string => `/cargo/units${pointerSegment(index)}`;

/** Chyba modulu → `WorldStateError` s cestou modulu (stav triedy pod `/runtime`). */
function asStateError(error: unknown, path: string): unknown {
  if (error instanceof ModuleStateError) return new WorldStateError(`${path}/runtime${error.path}`, error.problem);
  if (error instanceof ModuleError) return new WorldStateError(path, error.message);
  return error;
}

function restoreModules(world: World, entries: readonly ParsedModuleEntry[]): void {
  entries.forEach((entry, index) => {
    const path = modulePath(index);
    try {
      const def = world.defs.modules.get(entry.spec.defId);
      const module = moduleRegistry.create(def, entry.spec, entry.id, entry.purchaseCostCents, { grid: world.grid, cargo: world.cargo });
      module.restoreRuntimeState(entry.runtime);
      world.addModule(module);
    } catch (error) {
      throw asStateError(error, path);
    }
  });
}

const shipPath = (index: number): string => `/ships${pointerSegment(index)}`;

/** Kotviská lode: existujúce berthy, ktoré nedrží iná loď; zapíše im `dockedShipId` (neukladá sa, ADR-014). */
function claimShipBerths(world: World, ship: Ship, path: string): void {
  ship.berthIds.forEach((berthId, i) => {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) throw new WorldStateError(`${path}/berthIds${pointerSegment(i)}`, `#${String(berthId)} nie je kotvisko vo svete`);
    if (berth.dockedShipId !== null) {
      throw new WorldStateError(`${path}/berthIds${pointerSegment(i)}`, `${berth.label} už drží loď #${String(berth.dockedShipId)}`);
    }
    berth.dockedShipId = ship.id;
  });
}

/**
 * Lode vzostupne podľa id: inštancia `Ship` (triedu a náklad overil `parseWorldState`), kotviská (`claimShipBerths`),
 * dokovaná loď presne v polohe a s kurzom pri kotvisku (`mooringProblem`, T02-14), jedinečná anchorage
 * a `waypointIndex` najviac dĺžka trasy stavu; potom `World.addShip` (`ShipError` → `WorldStateError`).
 */
function restoreShips(world: World, entries: readonly ParsedShipEntry[]): void {
  const anchorages = new Map<number, number>();
  entries.forEach((entry, index) => {
    const path = shipPath(index);
    let ship: Ship;
    try {
      ship = new Ship({
        id: entry.id,
        def: world.defs.ships.get(entry.classId),
        cargoType: world.defs.cargoTypes.get(entry.cargoTypeId),
        state: entry.state,
        x: entry.x,
        y: entry.y,
        heading: entry.heading,
        berthIds: entry.berthIds,
        anchorageIndex: entry.anchorageIndex,
        waypointIndex: entry.waypointIndex,
      });
    } catch (error) {
      if (error instanceof ShipError) throw new WorldStateError(path, error.message);
      throw error;
    }
    claimShipBerths(world, ship, path);
    const mooring = mooringProblem(ship, world);
    if (mooring !== undefined) throw new WorldStateError(`${path}/${mooring.field}`, mooring.problem);
    if (ship.anchorageIndex !== null) {
      const holder = anchorages.get(ship.anchorageIndex);
      if (holder !== undefined) throw new WorldStateError(`${path}/anchorageIndex`, `anchorage ${String(ship.anchorageIndex)} už obsadila loď #${String(holder)}`);
      anchorages.set(ship.anchorageIndex, ship.id);
    }
    const routeLength = shipRoute(ship, world).length;
    if (ship.waypointIndex > routeLength) {
      throw new WorldStateError(`${path}/waypointIndex`, `trasa stavu '${ship.state}' má ${String(routeLength)} bodov, index ${String(ship.waypointIndex)}`);
    }
    try {
      world.addShip(ship);
    } catch (error) {
      // Tvar id overil `parseWorldState`; toto je posledná poistka, aby aj tu vznikla chyba save s cestou.
      if (error instanceof ShipError) throw new WorldStateError(`${path}/id`, error.message);
      throw error;
    }
  });
}

/**
 * Rezervácie apronov z `reservedSlot` žeriavov; hodina posledného `CraneBlocked` nesmie byť v budúcnosti. Rezervovaný
 * slot, na ktorom podľa ledgera leží jednotka, je chyba **jednotky** (`/cargo/units/<j>/location/slot`) — rovnako ako
 * pred T03-02, keď apron obsadenie ešte zrkadlil.
 */
function restoreCraneReservations(world: World, indexOf: ReadonlyMap<EntityId, number>, unitIndexOf: ReadonlyMap<EntityId, number>): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const path = `${modulePath(indexOf.get(module.id) ?? -1)}/runtime`;
    if (module.lastBlockedHour !== null && module.lastBlockedHour > world.clock.gameHour) {
      throw new WorldStateError(`${path}/lastBlockedHour`, `hodina ${String(module.lastBlockedHour)} je po aktuálnej ${String(world.clock.gameHour)}`);
    }
    const berth = world.modules.get(module.berthId);
    const slot = module.reservedSlot;
    if (slot === null || !(berth instanceof BerthModule)) continue;
    const occupant = slot < berth.apron.capacity ? berth.apron.unitAt(slot) : null;
    if (occupant !== null) {
      throw new WorldStateError(
        `${unitPath(unitIndexOf.get(occupant) ?? -1)}/location/slot`,
        `apron ${berth.label}: slot ${String(slot)} je rezervovaný žeriavom ${module.label}`,
      );
    }
    try {
      berth.apron.reserveSlot(slot);
    } catch (error) {
      if (error instanceof ModuleError) throw new WorldStateError(`${path}/reservedSlot`, `apron ${berth.label}: ${error.message}`);
      throw error;
    }
  }
}

/** Každá jednotka je u existujúceho držiteľa (`CARGO_HOLDER_SOURCES`). */
function checkHolders(world: World, units: readonly CargoUnit[]): void {
  const holders = new Map<string, ReadonlySet<EntityId>>();
  units.forEach((unit, index) => {
    const { kind } = unit.location;
    const spec = holderSpecOf(kind);
    const holderId = holderIdOf(unit.location);
    if (spec === undefined || holderId === null) return;
    let ids = holders.get(kind);
    if (ids === undefined) {
      ids = new Set(CARGO_HOLDER_SOURCES[kind as keyof typeof CARGO_HOLDER_SOURCES](world));
      holders.set(kind, ids);
    }
    if (!ids.has(holderId)) {
      throw new WorldStateError(`${unitPath(index)}/location/${spec.holderKey}`, `držiteľ '${kind}' #${String(holderId)} vo svete neexistuje`);
    }
  });
}

/**
 * Jednotky na slotoch modulov (apron, sklad — `Module.cargoSlots()`) ležia na slote v rozsahu kapacity držiteľa; ledger
 * rozsah nepozná (ADR-017). Volá sa po `checkHolders`, takže držiteľ existuje.
 */
function checkUnitSlots(world: World, units: readonly CargoUnit[]): void {
  units.forEach((unit, index) => {
    const holderId = holderIdOf(unit.location);
    const holder = holderId === null ? undefined : world.modules.get(holderId);
    const slots = holder?.cargoSlots();
    if (holder === undefined || slots?.kind !== unit.location.kind) return;
    const slot = uniqueSlotOf(unit.location) ?? -1;
    if (slot >= slots.capacity) {
      throw new WorldStateError(`${unitPath(index)}/location/slot`, `${holder.label}: slot ${String(slot)} je mimo 0…${String(slots.capacity - 1)}`);
    }
  });
}

/** Držané jednotky žeriavov z ledgera (`in_crane`). */
function restoreHeldCargo(world: World, units: readonly CargoUnit[]): void {
  units.forEach((unit, index) => {
    const holderId = holderIdOf(unit.location);
    const holder = holderId === null ? undefined : world.modules.get(holderId);
    if (unit.location.kind === 'in_crane' && holder instanceof CraneModule) {
      if (holder.heldUnitId !== null) {
        throw new WorldStateError(`${unitPath(index)}/location/craneId`, `${holder.label} už drží jednotku #${String(holder.heldUnitId)}`);
      }
      holder.heldUnitId = unit.id;
    }
  });
}

/** Stav žeriavu zodpovedá tomu, či drží jednotku (`CRANE_STATE_TRAITS.holdsUnit`). */
function checkCraneHolding(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const { holdsUnit } = CRANE_STATE_TRAITS[module.state];
    if (holdsUnit !== (module.heldUnitId !== null)) {
      throw new WorldStateError(
        `${modulePath(indexOf.get(module.id) ?? -1)}/runtime/state`,
        holdsUnit ? `stav '${module.state}' vyžaduje jednotku in_crane, ledger žiadnu nemá` : `stav '${module.state}' nedrží jednotku, ledger má #${String(module.heldUnitId)}`,
      );
    }
  }
}

/**
 * Obnoví moduly, lode a stav odvodený z ledgera do čerstvého `world` (prázdne moduly aj lode, ledger už obnovený
 * z `units`). Chyby → `WorldStateError`: modul (hranice, obsadenie, žeriav na berthe, `runtime`) → `/modules/<i>…`,
 * loď (kotvisko, anchorage, index trasy) → `/ships/<k>…`, náklad u neexistujúceho držiteľa alebo na neplatnom/
 * rezervovanom slote → `/cargo/units/<j>/location…`, iné porušenie invariantov → `''`.
 */
export function restoreEntities(
  world: World,
  entries: readonly ParsedModuleEntry[],
  ships: readonly ParsedShipEntry[],
  units: readonly CargoUnit[],
): void {
  restoreModules(world, entries);
  restoreShips(world, ships);
  const indexOf = new Map<EntityId, number>(entries.map((entry, index) => [entry.id, index]));
  const unitIndexOf = new Map<EntityId, number>(units.map((unit, index) => [unit.id, index]));
  checkHolders(world, units);
  checkUnitSlots(world, units);
  restoreCraneReservations(world, indexOf, unitIndexOf);
  restoreHeldCargo(world, units);
  checkCraneHolding(world, indexOf);
  const violation = findWorldViolation(world);
  if (violation !== undefined) throw new WorldStateError('', violation);
}
