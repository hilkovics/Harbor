/**
 * Odstavná plocha v prevádzke (R4, ADR-041 bod 5; docs/TERMINAL_2.md §8.4): kamión, ktorý prišiel pred termínom alebo nemal voľné TP (token = státie, `trucks/destination.ts`), čaká
 * v stave `holding` mimo cesty. **TOS ho zavolá k TP** (`callFromHolding`), keď je jeho jednotka pripravená (job `receive`: jednotka leží v sklade a dá sa vybrať — `unitPickable`; job `deliver`
 * je pripravený vždy) a nejaké TP bloku je voľné s cestou tam aj von. Kamióny sa volajú v poradí id (= poradie vzniku, FIFO). Státie sa pri zavolaní uvoľní a kamión opustí plochu
 * výjazdovým konektorom (`holding → to_tp`) len so zabraným slotom výjazdovej bunky, inak čaká ďalší tick.
 */
import type { World } from '../world/world';
import { YardBlock } from '../modules/yard-block';
import { slotOf } from '../cargo/cargo-location';
import { unitPickable } from '../logistics/yard-planner';
import { NO_ACCESS } from '../logistics/module-access';
import { holdingCell, nearBayOfSlot } from './destination';
import { chooseTp } from './tp-points';
import type { Truck } from './truck';
import { canExitTo, exitTo, holdingOfTruck } from './truck-trip';

/** Je jednotka zastávky kamióna pripravená (viď hlavička)? */
function stopReady(world: World, truck: Truck): boolean {
  const job = truck.jobId === null ? undefined : world.jobs.get(truck.jobId);
  if (job === undefined) return false;
  if (job.from.kind !== 'in_storage') return true;
  const unit = world.cargo.get(job.unitIds[0]);
  return unit !== undefined && unit.location.kind === 'in_storage' && unitPickable(world, unit);
}

/** Bay, ku ktorému má kamión mieriť: bay jednotky (odvoz), alebo bay rezervovaného slotu (vyloženie). */
function nearBayOf(world: World, truck: Truck, block: YardBlock): number | undefined {
  const job = truck.jobId === null ? undefined : world.jobs.get(truck.jobId);
  if (job === undefined) return undefined;
  const end = job.from.kind === 'in_storage' ? job.from : job.to;
  const slot = slotOf(end);
  return slot === null ? undefined : nearBayOfSlot(block, slot);
}

/** Jeden tick kamióna v odstavnej ploche: zavolanie k TP, keď je pripravený a TP voľné (viď hlavička). */
export function callFromHolding(world: World, truck: Truck): void {
  const block = world.modules.get(truck.blockId);
  if (!(block instanceof YardBlock) || !stopReady(world, truck)) return;
  const holding = holdingOfTruck(world, truck);
  const exit = holdingCell(world, holding, 'exit');
  if (exit === NO_ACCESS) return;
  const tp = chooseTp(world, block, nearBayOf(world, truck, block), truck.id, (cell) => world.distances.distance(exit, cell) < Infinity && world.landside.reachesOut(cell), exit);
  if (tp === NO_ACCESS) return;
  const previous = { holdingId: truck.holdingId, stall: truck.stall };
  truck.tpCell = tp;
  truck.holdingId = null;
  truck.stall = null;
  if (!canExitTo(world, truck, exit, 'to_tp')) {
    truck.tpCell = null;
    truck.holdingId = previous.holdingId;
    truck.stall = previous.stall;
    return;
  }
  truck.waitTicks = 0;
  exitTo(world, truck, exit, 'to_tp');
}
