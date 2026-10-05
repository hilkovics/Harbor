/**
 * Rehandling pri výbere zo skladu so stohmi (ADR-039 bod 6): ak cieľová jednotka jobu nie je navrchu, vozidlo, ktoré prišlo poň, najprv preloží
 * kontajnery nad ňou v tom istom bloku. Každý presun je `in_storage → in_vehicle → in_storage` cez `CargoLedger.move` (oba kroky v jednom ticku,
 * na vozidle nič nezostane) a trvá `logistics.rehandleTicks` (vozidlo ostáva v `loading`, odpočet beží ďalej). Cieľ bunky vyberá plánovač
 * (`chooseRehandleSlot`: prednostne rovnaký bay, stoh s neskorším odchodom vrchu). Presunutá jednotka s jobom zo skladu dostane nový slot zdroja.
 * Počíta sa len `rehandles` bloku (nie `unitsIn` / `unitsOut` — kontajner sklad neopúšťa).
 */
import type { EntityId } from '../core/entity-id';
import { YardBlock } from '../modules/yard-block';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';
import { chooseRehandleSlot } from './yard-planner';
import type { TransportJob } from './transport-job';

/**
 * Pripraví výber jednotky `unitId` zo zdroja jobu: `true` = je navrchu (alebo zdroj nemá stohy), možno ju naložiť hneď. `false` = vozidlo preložilo jeden
 * kontajner nad ňou (alebo nemá kam) a čaká `rehandleTicks`; po odpočte sa volá znova.
 */
export function prepareYardTake(world: World, vehicle: Vehicle, job: TransportJob, unitId: EntityId): boolean {
  const block = world.modules.get(job.fromModuleId);
  if (!(block instanceof YardBlock)) return true;
  const blockerId = block.topBlockerOf(unitId);
  if (blockerId === null) return true;
  const blocker = world.cargo.get(blockerId);
  if (blocker === undefined || blocker.location.kind !== 'in_storage') return true;
  const origin = block.positionOfSlot(blocker.location.slot);
  const slot = chooseRehandleSlot(world, block, blocker, origin);
  vehicle.waitTicks = world.defs.logistics.rehandleTicks;
  if (slot === null) return false;
  world.cargo.move(blockerId, { kind: 'in_vehicle', vehicleId: vehicle.id });
  const target = { kind: 'in_storage', moduleId: block.id, slot } as const;
  world.cargo.move(blockerId, target);
  block.recordRehandle();
  const blockerJob = world.jobOfUnit(blockerId);
  if (blockerJob?.from.kind === 'in_storage') blockerJob.rebindStorageSource(slot);
  return false;
}
