/**
 * Prijatie exportu do skladu (F6a, ADR-032 bod 8; dispatcher krok 5): job `at_ramp → in_storage` pre jednotky exportu, ktoré
 * práve vyložil kamión s exportom na dock rampy a čakajú na vozidlo (`!isPickupCargo`, `logistics/dock-cargo.ts`).
 *
 * **Zoskupenie podľa voyage:** jednotka ide do skladu, v ktorom už ležia jednotky jej kontraktu (jedna voyage = jeden export
 * booking, takže skupina kontraktu `World.storedCargo` = jednotky voyage) alebo kam už mieri job pre jej kontrakt;
 * medzi nimi najbližší od rampy (`DistanceMatrix`), pri zhode menšie id, a len s voľnou kapacitou. Bez takého skladu je
 * to najbližší sklad s voľným miestom (`allocateStorage`). Import a export zdieľajú sklady, bez poradia v stohu (F14).
 * Sklad rezervuje slot hneď pri vzniku jobu (ako inbound), takže po sebe idúce jednotky voyage v jednom ticku sa nerozbehnú
 * do viacerých skladov. Bez skladu job nevznikne a jednotka čaká na docku (kapacitu docku drží, kamióny s exportom
 * vtedy čakajú v stojisku — nič sa nestratí).
 *
 * Poradie: rampy vzostupne podľa id, jednotky docku vo FIFO poradí ledgera (bez kópie — počas prechodu sa ledger nemení,
 * vznikajú len joby).
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import type { LoadingRamp } from '../modules/loading-ramp';
import { StorageModule } from '../modules/storage-module';
import type { World } from '../world/world';
import { allocateStorage } from './storage-allocator';
import { distanceBetweenModules } from './module-access';

/** Znovupoužiteľné pole skladov voyage pre `groupStorages` (hot path bez alokácie; obsah sa vždy najprv vyprázdni). */
const GROUP_STORAGES: EntityId[] = [];

/** Vloží `id` do vzostupne zoradeného `GROUP_STORAGES`, ak tam ešte nie je (vkladanie — polia majú niekoľko prvkov). */
function addGroupStorage(id: EntityId): void {
  if (GROUP_STORAGES.includes(id)) return;
  let at = GROUP_STORAGES.length;
  GROUP_STORAGES.push(id);
  while (at > 0 && GROUP_STORAGES[at - 1] > id) {
    GROUP_STORAGES[at] = GROUP_STORAGES[at - 1];
    at -= 1;
  }
  GROUP_STORAGES[at] = id;
}

/**
 * Sklady, v ktorých leží alebo kam mieri jednotka kontraktu `unit.contractId` (zoradené podľa id, bez duplicít). Vracia zdieľané pole
 * (`GROUP_STORAGES`) — platí len do ďalšieho volania, volajúci ho iba prejde.
 */
function groupStorages(world: World, unit: CargoUnit): readonly EntityId[] {
  GROUP_STORAGES.length = 0;
  const group = world.storedCargo.groupOf(unit.contractId);
  if (group !== undefined) for (const storageId of group.storages) addGroupStorage(storageId);
  for (const job of world.jobs.values()) {
    if (job.to.kind !== 'in_storage') continue;
    const mate = world.cargo.get(job.unitIds[0]);
    if (mate?.contractId === unit.contractId) addGroupStorage(job.toModuleId);
  }
  return GROUP_STORAGES;
}

/**
 * Sklad pre jednotku exportu z rampy `ramp` (viď hlavička): najbližší sklad voyage s voľnou kapacitou a dosiahnuteľný po
 * ceste, inak najbližší sklad s voľným miestom; inak `undefined`.
 */
export function allocateExportStorage(world: World, ramp: LoadingRamp, unit: CargoUnit, category: CargoCategory): StorageModule | undefined {
  let best: StorageModule | undefined;
  let bestDistance = Infinity;
  for (const storageId of groupStorages(world, unit)) {
    const storage = world.modules.get(storageId);
    if (!(storage instanceof StorageModule) || storage.category !== category || storage.freeCount <= 0) continue;
    const distance = distanceBetweenModules(world, ramp, storage);
    if (distance < bestDistance) {
      best = storage;
      bestDistance = distance;
    }
  }
  return best ?? allocateStorage(world, ramp, category);
}

/** Podklady jobu: jednotka, zdroj (dock) a rezervovaný cieľ — dispatcher z toho vytvorí job (`openJob`). */
export interface IntakeJobSpec {
  readonly unitId: EntityId;
  readonly from: CargoUnit['location'];
  readonly to: { readonly kind: 'in_storage'; readonly moduleId: EntityId; readonly slot: number };
}

/**
 * Pre každú jednotku exportu na prijatie bez aktívneho jobu nájde sklad (`allocateExportStorage`), rezervuje v ňom slot
 * a odovzdá podklady jobu `open` (`openJob` dispatchera). Vracia počet vytvorených jobov.
 */
export function createExportIntakeJobs(world: World, openJob: (spec: IntakeJobSpec) => void): number {
  let created = 0;
  for (const ramp of world.landsideModules.ramps) {
    const count = world.cargo.countAt('at_ramp', ramp.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('at_ramp', ramp.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit === undefined || unit.direction !== 'export' || world.isPickupCargo(unit) || world.jobOfUnit(unit.id) !== undefined) continue;
      const category = world.defs.cargoTypes.get(unit.typeId).category;
      const storage = allocateExportStorage(world, ramp, unit, category);
      if (storage === undefined) continue;
      const slot = storage.reserve();
      openJob({ unitId: unit.id, from: unit.location, to: { kind: 'in_storage', moduleId: storage.id, slot } });
      created += 1;
    }
  }
  return created;
}
