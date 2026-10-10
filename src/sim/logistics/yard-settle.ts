/**
 * Usadenie rezervácie pri vykládke do bloku so stohmi (ADR-039 bod 6): vozidlá s rezerváciou jedného stohu prídu v inom poradí, než sa rezervovalo, ale
 * kontajner sa smie uložiť len na vrchol stohu. Pred `assertCommittable` sa preto rezervácia presunie na skutočnú vrstvu (výška stohu) a ak ju držal
 * iný job, jobom sa sloty vymenia — množina rezervovaných slotov sa nezmení, takže invarianty rezervácií ostávajú splnené. Vozidlo nikdy nečaká
 * (čakanie na vozidlo, ktoré uviazlo za ním v rade na prístupovej bunke, by uzamklo dopravu).
 */
import { VehicleError } from '../vehicles/vehicle-error';
import { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import type { TransportJob } from './transport-job';

/**
 * Usadí rezerváciu `slot` bloku na skutočnú vrstvu stohu (viď hlavička) a vráti skutočný slot. Rezerváciu, ktorú pritom vytlačí, drží vždy job (stroj naraz usadzuje len jeden cyklus);
 * `owner` je job, ktorému rezervácia patrí (`null` = rezerváciu drží cyklus stroja bez jobu — export z vlaka, TR6-02): jeho slot cieľa sa po usadení presmeruje.
 */
export function settleYardSlot(world: World, block: YardBlock, slot: number, owner: TransportJob | null): number {
  const settled = block.settleReservation(slot);
  if (settled.slot === slot) return slot;
  if (settled.displaced !== null) {
    let other: TransportJob | undefined;
    for (const candidate of world.jobs.values()) {
      if (candidate !== owner && candidate.to.kind === 'in_storage' && candidate.toModuleId === block.id && candidate.to.slot === settled.slot) {
        other = candidate;
        break;
      }
    }
    if (other === undefined) throw new VehicleError('inconsistent', `${block.label}: slot ${String(settled.slot)} držala rezervácia bez jobu`);
    other.rebindStorageTarget(settled.displaced);
  }
  owner?.rebindStorageTarget(settled.slot);
  return settled.slot;
}

/** Usadí rezerváciu cieľa jobu (viď hlavička); pre cieľ, ktorý nie je blok so stohmi, nerobí nič. */
export function settleYardDrop(world: World, job: TransportJob): void {
  const to = job.to;
  if (to.kind !== 'in_storage') return;
  const block = world.modules.get(job.toModuleId);
  if (!(block instanceof YardBlock)) return;
  settleYardSlot(world, block, to.slot, job);
}
