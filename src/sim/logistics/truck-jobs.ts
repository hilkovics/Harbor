/**
 * Joby kamiónov na odovzdávacom mieste (TP) — TOS `Move` s nohou `truck` (docs/TERMINAL_2.md §5.4, §6.4; ADR-041 bod 4 a 6). Každá zastávka kamióna je jeden `TransportJob` s koncovým bodom
 * `in_truck { truckId }` a modulom bloku, pri ktorého TP kamión stojí:
 * - **`receive`** (odvoz importu, prázdneho pre exportéra): `in_storage → in_truck` — job vzniká pri vzniku kamióna a drží nárok na jednotku (jednotka s jobom nepôjde na žiadny iný presun);
 * - **`deliver`** (export, návrat prázdneho): `in_truck → in_storage(slot)` — job vzniká pri vzniku kamióna a drží rezerváciu slotu v bloku (rovnaká rezervácia, usadenie a rehandling ako pri
 *   vozidlách, `logistics/yard-settle.ts`, `logistics/yard-rehandle.ts`).
 * Job ostáva `open`, kým kamión nie je na TP vo fáze `handling`: potom ho **stroj bloku** (RTG; `open → done`) alebo **straddle carrier** (dispatcher mu job priradí) obslúži. Kamión sám zistí, že
 * odovzdanie skončilo, podľa zániku jobu (`Truck.jobId` už nie je vo `world.jobs`).
 */
import type { EntityId } from '../core/entity-id';
import type { CargoUnit } from '../cargo/cargo-unit';
import { YardBlock } from '../modules/yard-block';
import type { Truck } from '../trucks/truck';
import type { World } from '../world/world';
import { TransportJob } from './transport-job';

/** Vytvorí a zaregistruje job `receive` (`in_storage → in_truck`) pre jednotku `unit` bloku `block` a priradí ho kamiónu (`Truck.jobId`); emituje `JobCreated`. */
export function openReceiveJob(world: World, truck: Truck, unit: CargoUnit, block: YardBlock): TransportJob {
  const job = new TransportJob({
    id: world.ids.next(),
    unitIds: [unit.id],
    from: unit.location,
    to: { kind: 'in_truck', truckId: truck.id },
    toModuleId: block.id,
    createdTick: world.clock.tick,
  });
  return register(world, truck, job);
}

/**
 * Vytvorí a zaregistruje job `deliver` (`in_truck → in_storage`) pre jednotku v kamióne a slot `slot` bloku `block` (rezerváciu slotu už drží volajúci — `YardBlock.reserveFor`).
 * Job sa priradí kamiónu (`Truck.jobId`) a emituje `JobCreated`.
 */
export function openDeliverJob(world: World, truck: Truck, unit: CargoUnit, block: YardBlock, slot: number): TransportJob {
  const job = new TransportJob({
    id: world.ids.next(),
    unitIds: [unit.id],
    from: unit.location,
    to: { kind: 'in_storage', moduleId: block.id, slot },
    fromModuleId: block.id,
    createdTick: world.clock.tick,
  });
  return register(world, truck, job);
}

function register(world: World, truck: Truck, job: TransportJob): TransportJob {
  world.addJob(job);
  truck.jobId = job.id;
  truck.unitId = job.unitIds[0];
  world.events.emit({ type: 'JobCreated', jobId: job.id, unitIds: job.unitIds, fromModuleId: job.fromModuleId, toModuleId: job.toModuleId });
  return job;
}

/** Je job zastávkou kamióna (jeden z jeho koncových bodov je `in_truck`)? */
export function isTruckJob(job: Pick<TransportJob, 'from' | 'to'>): boolean {
  return job.from.kind === 'in_truck' || job.to.kind === 'in_truck';
}

/** Kamión, ktorému job patrí (koncový bod `in_truck`); iný job → `undefined`. */
export function truckOfJob(world: Pick<World, 'trucks'>, job: Pick<TransportJob, 'from' | 'to'>): Truck | undefined {
  const end = job.from.kind === 'in_truck' ? job.from : job.to.kind === 'in_truck' ? job.to : undefined;
  return end === undefined ? undefined : world.trucks.get(end.truckId);
}

/** Blok jobu kamióna (modul, pri ktorého TP kamión stojí); iný job alebo modul → `undefined`. */
export function truckJobBlock(world: Pick<World, 'modules'>, job: Pick<TransportJob, 'from' | 'to' | 'fromModuleId' | 'toModuleId'>): YardBlock | undefined {
  if (!isTruckJob(job)) return undefined;
  const block = world.modules.get(job.from.kind === 'in_truck' ? job.fromModuleId : job.toModuleId);
  return block instanceof YardBlock ? block : undefined;
}

/** Dá sa job kamióna `truck` práve obslúžiť — kamión stojí na TP vo fáze odovzdania (`handling`) a jeho job je tento? */
export function truckReadyForHandling(truck: Truck, jobId: EntityId): boolean {
  return truck.traits.atTp && truck.phase === 'handling' && truck.jobId === jobId;
}
