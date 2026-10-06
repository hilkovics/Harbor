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

/** Usadí rezerváciu cieľa jobu (viď hlavička); pre cieľ, ktorý nie je blok so stohmi, nerobí nič. */
export function settleYardDrop(world: World, job: TransportJob): void {
  const to = job.to;
  if (to.kind !== 'in_storage') return;
  const block = world.modules.get(job.toModuleId);
  if (!(block instanceof YardBlock)) return;
  const settled = block.settleReservation(to.slot);
  if (settled.slot === to.slot) return;
  if (settled.displaced !== null) {
    let other: TransportJob | undefined;
    for (const candidate of world.jobs.values()) {
      if (candidate !== job && candidate.to.kind === 'in_storage' && candidate.toModuleId === block.id && candidate.to.slot === settled.slot) {
        other = candidate;
        break;
      }
    }
    if (other === undefined) throw new VehicleError('inconsistent', `${job.label}: slot ${String(settled.slot)} bloku ${block.label} držala rezervácia bez jobu`);
    other.rebindStorageTarget(settled.displaced);
  }
  job.rebindStorageTarget(settled.slot);
}
