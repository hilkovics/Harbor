/**
 * Obnova entít zo save (ARCHITECTURE §14, ADR-014): moduly v poradí save (= poradie umiestnenia) cez
 * `ModuleRegistry` a `World.addModule`, potom stav odvodený z ledgera a žeriavov — rezervácie apronov
 * z `reservedSlot`, obsadenie apronov (FIFO = poradie jednotiek v save) a držané jednotky žeriavov z `in_crane`.
 * Na koniec beží `findWorldViolation` ako poistka. Každá chyba je `WorldStateError` s JSON pointerom.
 */
import { holderIdOf, holderSpecOf, slotOf } from '../cargo/cargo-location';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { CRANE_STATE_TRAITS, CraneModule } from '../modules/crane-module';
import { ModuleError, ModuleStateError } from '../modules/module-error';
import { moduleRegistry } from '../modules/module-registry';
import { CARGO_HOLDER_SOURCES } from './cargo-holders';
import { WorldStateError, pointerSegment } from './state-check';
import type { World } from './world';
import { findWorldViolation } from './world-invariants';
import type { ParsedModuleEntry } from './world-state';

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
      const module = moduleRegistry.create(def, entry.spec, entry.id, entry.purchaseCostCents, { grid: world.grid });
      module.restoreRuntimeState(entry.runtime);
      world.addModule(module);
    } catch (error) {
      throw asStateError(error, path);
    }
  });
}

/** Rezervácie apronov z `reservedSlot` žeriavov; hodina posledného `CraneBlocked` nesmie byť v budúcnosti. */
function restoreCraneReservations(world: World, indexOf: ReadonlyMap<EntityId, number>): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule)) continue;
    const path = `${modulePath(indexOf.get(module.id) ?? -1)}/runtime`;
    if (module.lastBlockedHour !== null && module.lastBlockedHour > world.clock.gameHour) {
      throw new WorldStateError(`${path}/lastBlockedHour`, `hodina ${String(module.lastBlockedHour)} je po aktuálnej ${String(world.clock.gameHour)}`);
    }
    const berth = world.modules.get(module.berthId);
    if (module.reservedSlot === null || !(berth instanceof BerthModule)) continue;
    try {
      berth.apron.reserveSlot(module.reservedSlot);
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

/** Obsadenie apronov (poradie save = FIFO) a držané jednotky žeriavov z ledgera. */
function restoreHeldCargo(world: World, units: readonly CargoUnit[]): void {
  units.forEach((unit, index) => {
    const path = `${unitPath(index)}/location`;
    const holderId = holderIdOf(unit.location);
    const holder = holderId === null ? undefined : world.modules.get(holderId);
    if (unit.location.kind === 'on_apron' && holder instanceof BerthModule) {
      const slot = slotOf(unit.location) ?? -1;
      try {
        holder.apron.reserveSlot(slot);
        holder.apron.commit(slot, unit.id);
      } catch (error) {
        if (error instanceof ModuleError) throw new WorldStateError(`${path}/slot`, `apron ${holder.label}: ${error.message}`);
        throw error;
      }
    }
    if (unit.location.kind === 'in_crane' && holder instanceof CraneModule) {
      if (holder.heldUnitId !== null) {
        throw new WorldStateError(`${path}/craneId`, `${holder.label} už drží jednotku #${String(holder.heldUnitId)}`);
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
 * Obnoví moduly a stav odvodený z ledgera do čerstvého `world` (prázdne moduly, ledger už obnovený z `units`).
 * Chyby → `WorldStateError`: modul (hranice, obsadenie, žeriav na berthe, `runtime`) → `/modules/<i>…`, náklad
 * u neexistujúceho držiteľa alebo na neplatnom/rezervovanom slote → `/cargo/units/<j>/location…`, iné porušenie
 * invariantov → `''`.
 */
export function restoreEntities(world: World, entries: readonly ParsedModuleEntry[], units: readonly CargoUnit[]): void {
  restoreModules(world, entries);
  const indexOf = new Map<EntityId, number>(entries.map((entry, index) => [entry.id, index]));
  restoreCraneReservations(world, indexOf);
  checkHolders(world, units);
  restoreHeldCargo(world, units);
  checkCraneHolding(world, indexOf);
  const violation = findWorldViolation(world);
  if (violation !== undefined) throw new WorldStateError('', violation);
}
