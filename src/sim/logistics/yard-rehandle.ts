/**
 * Rehandling pri výbere zo skladu so stohmi (ADR-039 bod 6, dodatok TR2-06b): ak cieľová jednotka jobu nie je navrchu, vozidlo, ktoré prišlo poň, najprv preloží
 * kontajnery nad ňou v tom istom bloku. Každý presun je `in_storage → in_vehicle → in_storage` cez `CargoLedger.move` (oba kroky v jednom ticku,
 * na vozidle nič nezostane) a trvá `logistics.rehandleTicks`. Cieľ bunky vyberá plánovač (`chooseRehandleSlot`: stoh s neskorším odchodom vrchu, pri
 * rovnakom odchode bližší bay). Presunutá jednotka s jobom zo skladu dostane nový slot zdroja. Počíta sa len `rehandles` bloku (nie `unitsIn` / `unitsOut` —
 * kontajner sklad neopúšťa).
 *
 * **FSM vozidla** (`loading ↔ rehandling`): po pobyte v `loading` (`startYardTake`) je cieľ buď navrchu (`ready`, vozidlo nakladá), alebo vozidlo prejde do
 * `rehandling`. V ňom `waitTicks` je zvyšná **trpezlivosť** `P` = `rehandleGiveUpTicks` zaokrúhlené nahor na celé cykly `rehandleTicks` (bez ďalšieho stavu v save).
 * Každý dokončený cyklus (`waitTicks` je násobok `rehandleTicks`) vozidlo presunie jeden kontajner (úspech vráti trpezlivosť na `P`); po poslednom presune sa vráti
 * do `loading` a naloží. Keď sa v cykle nenájde cieľ a trpezlivosť klesne na 0, job sa zruší (`picking → cancelled`, `rehandle_stalled`), vozidlo ide `idle`
 * (`rehandling → idle`), blok zapíše `rehandleStalls` a nič sa neteleportuje — jednotka ostáva v sklade. Dispatcher job znova nezaloží ani nepridelí, kým pre
 * kontajnery nad jednotkou nie je miesto (`unitPickable`); preto zrušenie zároveň slúži ako backoff. Pri príchode sa `unitPickable` kontroluje znova —
 * od založenia jobu mohol blok zaplniť iný príchod — a jednotku, ktorú nemožno vybrať, vozidlo hneď uvoľní.
 *
 * **Zásoba docku** (ADR-023 bod 7, ADR-029 bod 11): job do rampy s nákladom na odvoz je zásoba docku — nárok kamiónov nesmie presiahnuť pripravené + vezené
 * jednotky. Takýto job sa zruší len keď po jeho odpočítaní nárok stále platí (`releasable`); inak vozidlo čaká ďalej s novou trpezlivosťou (kamión na dock
 * čaká na jednotku tak či tak) a vyčerpanie trpezlivosti sa aj tak zapíše do `rehandleStalls`.
 */
import type { EntityId } from '../core/entity-id';
import { YardBlock } from '../modules/yard-block';
import type { Vehicle } from '../vehicles/vehicle';
import { VehicleError } from '../vehicles/vehicle-error';
import { changeVehicleState } from '../vehicles/vehicle-fsm';
import type { World } from '../world/world';
import { releaseLoadAssignment } from './export-load';
import { DockSupply } from '../trucks/dock-supply';
import { LoadingRamp } from '../modules/loading-ramp';
import { cancelJob } from './job-cancel';
import type { TransportJob } from './transport-job';
import { chooseRehandleSlot, unitPickable } from './yard-planner';

/** Výsledok `startYardTake`: cieľ je navrchu (naložiť), vozidlo prekladá (`rehandling`), alebo job zrušilo a uvoľnilo sa (`abandoned`). */
export type YardTakeResult = 'ready' | 'rehandling' | 'abandoned';

/** Trpezlivosť rehandlingu v tickoch: `rehandleGiveUpTicks` zaokrúhlené nahor na celé cykly `rehandleTicks` (aspoň jeden cyklus). */
function patienceTicks(world: World): number {
  const { rehandleTicks, rehandleGiveUpTicks } = world.defs.logistics;
  return Math.max(1, Math.ceil(rehandleGiveUpTicks / rehandleTicks)) * rehandleTicks;
}

/**
 * Smie sa job zrušiť bez porušenia zásoby docku (viď hlavička)? Job mimo rampy alebo bez nákladu na odvoz (prázdny kontajner pre kamión `collect`) áno;
 * job do docku len keď nárok kamiónov docku ostane ≤ pripravené + vezené jednotky bez jednotky jobu. Volá sa zriedka (vyčerpaná trpezlivosť), alokuje.
 */
function releasable(world: World, job: TransportJob): boolean {
  const { to } = job;
  if (to.kind !== 'at_ramp') return true;
  const ramp = world.modules.get(job.toModuleId);
  if (!(ramp instanceof LoadingRamp)) return true;
  let carried = 0;
  for (const unitId of job.unitIds) if (world.cargo.get(unitId)?.direction !== 'empty') carried += 1;
  if (carried === 0) return true;
  const supply = new DockSupply();
  supply.refresh(world);
  return ramp.claimedAt(to.dock) <= supply.suppliedAt(ramp, to.dock) - carried;
}

/**
 * Uvoľní vozidlo od jobu, ktorého jednotku nemožno vybrať (viď hlavička): `picking → cancelled`, vozidlo `rehandling → idle`.
 * `false` = zrušenie by porušilo zásobu docku, nič sa nezmenilo.
 */
function tryAbandonPickup(world: World, vehicle: Vehicle, job: TransportJob): boolean {
  if (!releasable(world, job)) return false;
  releaseLoadAssignment(world, job);
  cancelJob(world, job, 'rehandle_stalled');
  vehicle.jobId = null;
  vehicle.waitTicks = world.defs.logistics.traffic.idleParkDelayTicks;
  changeVehicleState(world.events, vehicle, 'idle');
  return true;
}

/**
 * Koniec pobytu v `loading` pri zdroji jobu: `ready` = jednotka `unitId` je navrchu (alebo zdroj nemá stohy), vozidlo ju môže naložiť hneď. Inak vozidlo prejde do
 * `rehandling` s plnou trpezlivosťou; ak jednotku nemožno vybrať (`unitPickable`), job hneď zruší a uvoľní sa (`abandoned`).
 */
export function startYardTake(world: World, vehicle: Vehicle, job: TransportJob, unitId: EntityId): YardTakeResult {
  const block = world.modules.get(job.fromModuleId);
  if (!(block instanceof YardBlock) || block.topBlockerOf(unitId) === null) return 'ready';
  vehicle.waitTicks = patienceTicks(world);
  changeVehicleState(world.events, vehicle, 'rehandling');
  // Kontrola pri príchode: od založenia jobu mohol iný príchod zaplniť blok (rezervácie sa menia na kontajnery a miesto sa nevracia) — beznádejnú jednotku
  // vozidlo uvoľní hneď, nie po vyčerpaní trpezlivosti (cesta zostáva voľná).
  const unit = world.cargo.get(unitId);
  if (unit !== undefined && unitPickable(world, unit)) return 'rehandling';
  if (!tryAbandonPickup(world, vehicle, job)) return 'rehandling';
  block.recordRehandleStall();
  return 'abandoned';
}

/** Presunie kontajner `blockerId` na slot `slot` toho istého bloku cez vozidlo (viď hlavička); rezervácia rozbehnutého jobu na cieľovej bunke sa posunie nad stoh. */
function relocate(world: World, vehicle: Vehicle, block: YardBlock, blockerId: EntityId, slot: number): void {
  const vacated = block.vacateReservation(slot);
  if (vacated !== null) {
    for (const other of world.jobs.values()) {
      if (other.to.kind === 'in_storage' && other.toModuleId === block.id && other.to.slot === vacated.from) {
        other.rebindStorageTarget(vacated.to);
        break;
      }
    }
  }
  world.cargo.move(blockerId, { kind: 'in_vehicle', vehicleId: vehicle.id });
  world.cargo.move(blockerId, { kind: 'in_storage', moduleId: block.id, slot });
  block.recordRehandle();
  const blockerJob = world.jobOfUnit(blockerId);
  if (blockerJob?.from.kind === 'in_storage') blockerJob.rebindStorageSource(slot);
}

/**
 * Jeden tick stavu `rehandling` (viď hlavička): odpočet trpezlivosti; v cykle (násobok `rehandleTicks`) presun jedného kontajnera, návrat do `loading`
 * po poslednom, alebo zrušenie jobu po vyčerpaní trpezlivosti bez cieľa.
 */
export function rehandleStep(world: World, vehicle: Vehicle, job: TransportJob, unitId: EntityId): void {
  const block = world.modules.get(job.fromModuleId);
  if (!(block instanceof YardBlock)) throw new VehicleError('inconsistent', `${vehicle.label}: rehandling bez bloku so stohmi pri zdroji ${job.label}`);
  vehicle.waitTicks = Math.max(0, vehicle.waitTicks - 1);
  if (vehicle.waitTicks % world.defs.logistics.rehandleTicks !== 0) return;
  const blockerId = block.topBlockerOf(unitId);
  const blocker = blockerId === null ? undefined : world.cargo.get(blockerId);
  if (blocker?.location.kind === 'in_storage') {
    const slot = chooseRehandleSlot(world, block, blocker, block.positionOfSlot(blocker.location.slot));
    if (slot === null) {
      if (vehicle.waitTicks > 0) return;
      // Trpezlivosť sa vyčerpala: job sa zruší, ak to zásoba docku dovolí, inak vozidlo čaká ďalej s novou trpezlivosťou.
      block.recordRehandleStall();
      if (!tryAbandonPickup(world, vehicle, job)) vehicle.waitTicks = patienceTicks(world);
      return;
    }
    relocate(world, vehicle, block, blocker.id, slot);
    vehicle.waitTicks = patienceTicks(world);
    if (block.topBlockerOf(unitId) !== null) return;
  }
  // Nad jednotkou už nič nie je: vozidlo ju naloží ako po príchode (jeden pobyt `loadTicks`).
  vehicle.waitTicks = vehicle.def.loadTicks;
  changeVehicleState(world.events, vehicle, 'loading');
}
