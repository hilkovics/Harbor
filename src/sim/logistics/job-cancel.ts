/**
 * Zrušenie jobu (ADR-023; dodatok TR2-06b): uvoľnenie rezervácie cieľa, `→ cancelled`, odstránenie zo sveta a `JobCancelled`. Spoločné pre dispatcher
 * (`open` job bez vozidla) a rehandling bez cieľa v bloku (`picking` job vozidla, ktoré sa uvoľní — `logistics/yard-rehandle.ts`).
 */
import { slotOf } from '../cargo/cargo-location';
import type { World } from '../world/world';
import { JobError } from './job-error';
import type { JobCancelReason, TransportJob } from './transport-job';

/**
 * Uvoľní rezerváciu cieľa jobu (jedna na jednotku jobu, `cargoDropTarget().release`). Hák žeriava (`in_crane`, nakládka pod hákom,
 * ADR-033) nič nerezervuje — nie je čo uvoľniť. Cieľ bez `cargoDropTarget` → `JobError('invalid_input')` (svet je nekonzistentný).
 */
export function releaseTarget(world: World, job: TransportJob): void {
  if (job.to.kind === 'in_crane') return;
  const target = world.modules.get(job.toModuleId)?.cargoDropTarget();
  const place = slotOf(job.to);
  if (target === undefined || target.kind !== job.to.kind || place === null) {
    throw new JobError('invalid_input', `${job.label}: cieľ #${String(job.toModuleId)} nemá miesto '${job.to.kind}' na uvoľnenie`);
  }
  for (let i = 0; i < job.unitIds.length; i++) target.release(place);
}

/**
 * Zruší job: uvoľní rezerváciu v cieli (`releaseTarget`), `→ cancelled` (z `open`, alebo z `picking` — vozidlo jobu sa uvoľňuje samo, volajúci mu
 * vynuluje `jobId`), `World.removeJob` a `JobCancelled`. Cieľ bez `cargoDropTarget` → `JobError('invalid_input')`, job sa nezmení.
 */
export function cancelJob(world: World, job: TransportJob, reason: JobCancelReason): void {
  releaseTarget(world, job);
  job.transition('cancelled');
  world.removeJob(job.id);
  world.events.emit({ type: 'JobCancelled', jobId: job.id, reason });
}
