/**
 * Je zastávka kamióna pripravená (R4, ADR-041 bod 5)? Job `deliver` (vyloženie) je pripravený vždy; job `receive` (odvoz) len keď jednotka leží v sklade a dá sa vybrať (`unitPickable`).
 * Spoločné pre zavolanie z odstavnej plochy (`trucks/holding.ts`) a prednosť čakajúcich pri rezervácii TP (`trucks/destination.ts`).
 */
import { unitPickable } from '../logistics/yard-planner';
import type { World } from '../world/world';
import type { Truck } from './truck';

/** Je jednotka zastávky kamióna pripravená (viď hlavička)? */
export function stopReady(world: World, truck: Truck): boolean {
  const job = truck.jobId === null ? undefined : world.jobs.get(truck.jobId);
  if (job === undefined) return false;
  if (job.from.kind !== 'in_storage') return true;
  const unit = world.cargo.get(job.unitIds[0]);
  return unit !== undefined && unit.location.kind === 'in_storage' && unitPickable(world, unit);
}
