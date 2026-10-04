/**
 * Joby prázdnych kontajnerov (F6c, ADR-034 bod 6, 8 + dodatok T6C-02; dispatcher krok 5):
 * - **Prijatie do depa** (`createEmptyIntakeJobs`): prázdny kontajner, ktorý práve vyložil kamión z vnútrozemia na dock rampy
 *   (`at_ramp`, bez jobu a bez poverenia kamiónom `collect`), dostane job `at_ramp → in_storage` do najbližšieho depa s voľným miestom
 *   (`allocateEmptyStorage`); keď depo chýba, je plné alebo nedosiahnuteľné, do bežného skladu (fallback, `EmptyStored.fallback`). Sklad
 *   rezervuje slot pri vzniku jobu. Bez skladu job nevznikne a prázdny čaká na docku (kamión s prázdnym vtedy čaká v stojisku).
 * - **Výdaj exportérovi** (`createEmptyPickupJobs`): kamión misie `collect` bez prideleného prázdneho dostane dostupný prázdny kontajner
 *   jeho linky (`findAvailableEmpty`: depo pred dvorom, najmenšie id; poškodený a opravovaný nie) — job `in_storage → at_ramp` na dock
 *   kamióna (rezervuje staging miesto) a poverenie `errand.unitId`. Zrušený job (rampa stratila prevádzkovosť) pridelenie uvoľní:
 *   jednotka je stále v sklade bez jobu → poverenie sa vráti do stavu bez prideleného a prázdny sa pridelí znovu.
 *
 * Poradie: rampy vzostupne podľa id, jednotky docku vo FIFO poradí ledgera; poverenia vzostupne podľa `truckId`. Bez alokácie okrem
 * jobu samotného. Job vytvorí volajúci (`openJob` dispatchera) so spec-om `{ unitId, from, to }`.
 */
import type { CargoLocation } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import { LoadingRamp } from '../modules/loading-ramp';
import type { World } from '../world/world';
import { allocateEmptyStorage, findAvailableEmpty } from './empty-stock';
import { distanceBetweenModules } from './module-access';

/** Podklady jobu prázdneho: jednotka, zdroj a rezervovaný cieľ (dispatcher z toho vytvorí job `open`). */
export interface EmptyJobSpec {
  readonly unitId: EntityId;
  readonly from: CargoLocation;
  readonly to: CargoLocation;
}

/** Prijatie prázdnych z docku do depa (viď hlavička). Vracia počet vytvorených jobov. */
export function createEmptyIntakeJobs(world: World, openJob: (spec: EmptyJobSpec) => void): number {
  let created = 0;
  for (const ramp of world.landsideModules.ramps) {
    const count = world.cargo.countAt('at_ramp', ramp.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('at_ramp', ramp.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit === undefined || unit.direction !== 'empty' || world.jobOfUnit(unit.id) !== undefined || world.emptyFlow.errandOfUnit(unit.id) !== undefined) continue;
      const storage = allocateEmptyStorage(world, ramp, world.defs.cargoTypes.get(unit.typeId).category);
      if (storage === undefined) continue;
      const slot = storage.reserve();
      openJob({ unitId: unit.id, from: unit.location, to: { kind: 'in_storage', moduleId: storage.id, slot } });
      created += 1;
    }
  }
  return created;
}

/**
 * Pridelenie jednotky kamiónu `collect` sa stratilo (job zo skladu sa zrušil a jednotka ešte leží v sklade bez jobu)? Vtedy sa
 * poverenie vráti do stavu bez prideleného.
 */
function releaseLostAssignment(world: World, truckId: EntityId, unitId: number): void {
  const unit = world.cargo.get(unitId as EntityId);
  if (unit?.location.kind === 'in_storage' && world.jobOfUnit(unit.id) === undefined) world.emptyFlow.assignErrandUnit(truckId, null);
}

/** Výdaj prázdnych kamiónom `collect` (viď hlavička). Vracia počet vytvorených jobov. */
export function createEmptyPickupJobs(world: World, openJob: (spec: EmptyJobSpec) => void): number {
  let created = 0;
  for (const errand of world.emptyFlow.errands) {
    const truckId = errand.truckId as EntityId;
    if (errand.unitId !== null) {
      releaseLostAssignment(world, truckId, errand.unitId);
      if (world.emptyFlow.errandOfTruck(truckId)?.unitId !== null) continue;
    }
    const truck = world.trucks.get(truckId);
    const ramp = truck === undefined ? undefined : world.modules.get(truck.rampId);
    if (truck === undefined || !(ramp instanceof LoadingRamp) || ramp.freeAt(truck.dock) <= 0 || !world.isRampOperational(ramp)) continue;
    const unit = findAvailableEmpty(world, errand.lineId);
    const storage = unit?.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
    if (unit === undefined || storage === undefined || distanceBetweenModules(world, storage, ramp) === Infinity) continue;
    ramp.reserve(truck.dock);
    openJob({ unitId: unit.id, from: unit.location, to: { kind: 'at_ramp', rampId: ramp.id, dock: truck.dock } });
    world.emptyFlow.assignErrandUnit(truckId, unit.id);
    created += 1;
  }
  return created;
}
