/**
 * Joby nakládky a vykládky pod hákom (F6a, ADR-032 bod 9, ADR-033; F6c, ADR-034 bod 10–11; dispatcher krok 5):
 *
 * - **Nakládka** (`createExportLoadJobs`): pre každú dokovanú loď s bookingom, ktorý sa nakladá (`Contract.acceptsLoading`: export a repositioning
 *   v `exporting`, prekládka na loď B v `unloading` / `exporting`), sa jednotky lode berú **v poradí stowage plánu** (`compareStowageOrder`:
 *   plné heavy → medium → light, potom id, **po nich prázdne**) a každá dostane job k žeriavu kotviska lode: režim `apron` — `in_storage →
 *   on_apron` s rezervovaným slotom apronu (smerový limit `apronSlots − apronReserveSlots`, kým má loď aj import; ADR-032 bod 10), režim
 *   `under_hook` — `in_storage → in_crane` na žeriav s najmenším počtom jobov nakládky v obehu (počet jobov v obehu na kotvisko je
 *   ohraničený rovnako ako sloty apronu). Jednotky nakládky podľa druhu bookingu (`LOAD_SCAN`, tabuľka): export — jednotky kontraktu v sklade
 *   (mimo hold), prekládka — jednotky kontraktu v sklade (vyložené z lode A), repositioning — dostupné prázdne linky z depa (`findAvailableEmpty`),
 *   najviac `Contract.loadsToAssign`; pridelenie nakládke zapíše `Contract.assignLoad`. Job vzniká až pri dokovanej lodi (`docked`; od `lashing` sa
 *   nenakladá) a len pre kotvisko so žeriavom kategórie nákladu.
 * - **Vykládka pod hákom** (`createHookUnloadJobs`): joby `in_crane → in_storage` s rezervovaným slotom skladu vznikajú **vopred** —
 *   pre jednotku, ktorú žeriav práve vykladá, aj pre ďalšie jednotky na vykládku (import, prekládka z lode A) dokovanej lode — aby dispatcher poslal
 *   vozidlá k háku skôr, než žeriav jednotku zdvihne, a žeriav nečakal (`NoStorageAvailable`, keď sklad nie je); blok a stoh vyberá plánovač skladu
 *   (`reserveYardSlot`, ADR-039: prekládka zoskupene podľa kontraktu).
 *
 * Funkcie nemenia ledger; vznik jobu rieši `openJob` z dispatchera (`JobCreated`, `World.addJob`). Hot path bez alokácií: jednotky
 * nakládky sa vyberajú po jednej (najlepšia podľa stowage plánu, bez poľa a triedenia — poradie je úplné, takže je rovnaké ako pri
 * triedení) a polia kotvísk / žeriavov sú znovupoužiteľné na úrovni modulu (vzor `BOOKINGS`).
 */
import { compareStowageClass } from '../cargo/stowage';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import type { ContractKind } from '../contracts/contract-fsm';
import type { EntityId } from '../core/entity-id';
import type { HandoverMode } from '../defs/types';
import { BerthModule } from '../modules/berth-module';
import { CRANE_CYCLE_TRAITS, CraneModule } from '../modules/crane-module';
import { YardBlock } from '../modules/yard-block';
import { HANDOVERS } from '../systems/crane-handover';
import { apronDirectionCap, bothDirections, exportApronUsage } from './apron-usage';
import { findAvailableEmpty } from './empty-stock';
import { collectLoadBerths, storageReaches } from './load-access';
import { distanceBetweenModules } from './module-access';
import type { JobCancelReason, TransportJob } from './transport-job';
import { reserveYardSlot, unitPickable } from './yard-planner';
import { isOutboundOnShip, loadingStopped, openLoadBookings } from './voyage-cargo';
import type { CargoLocation } from '../cargo/cargo-location';
import type { Ship } from '../ships/ship';
import type { World } from '../world/world';

/** Podklady jobu pre `openJob` dispatchera. */
export interface LoadJobSpec {
  readonly unitIds: readonly EntityId[];
  readonly from: CargoLocation;
  readonly to: CargoLocation;
  /** Modul zdroja / cieľa, ak sa líši od držiteľa lokácie (hák žeriava → kotvisko, ADR-033). */
  readonly fromModuleId?: EntityId;
  readonly toModuleId?: EntityId;
}

/** Vytvorí job `open` z podkladov (rezervácie cieľa už urobil volajúci). */
export type OpenJob = (spec: LoadJobSpec) => void;

/** Zruší job bez vozidla (uvoľní rezerváciu cieľa, `JobCancelled`) — `cancelJob` dispatchera. */
export type CancelJob = (job: TransportJob, reason: JobCancelReason) => void;

/** Hláška „žiadny sklad" z kotviska (`NoStorageAvailable`, najviac raz za hernú hodinu). */
export type EmitNoStorage = (world: World, berth: BerthModule, cargoTypeId: string) => void;

/** Znovupoužiteľné pole bookingov lode (hot path; obsah sa vždy najprv vyprázdni). */
const BOOKINGS: Contract[] = [];
/** Znovupoužiteľné pole kotvísk nakládky lode (`collectLoadBerths`; obsah sa vždy najprv vyprázdni). */
const BERTHS: BerthModule[] = [];

/** Žeriav kotviska s kategóriou nákladu lode (obsluhuje loď). */
function craneFor(world: World, berth: BerthModule, ship: Ship): CraneModule | undefined {
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (crane instanceof CraneModule && crane.category === ship.cargoCategory) return crane;
  }
  return undefined;
}

/** Počet jobov nakládky pod hákom v obehu pre žeriav (cieľ `in_crane` tohto žeriava). */
function hookLoadJobs(world: World, crane: CraneModule): number {
  let count = 0;
  for (const job of world.jobs.values()) if (job.to.kind === 'in_crane' && job.to.craneId === crane.id) count += 1;
  return count;
}

/** Počet kontajnerov nad jednotkou v jej bloku so stohmi (0 = navrchu, mimo bloku); rehandling je drahší než čakanie. */
function burialOf(world: World, unit: CargoUnit): number {
  const block = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  return block instanceof YardBlock ? block.burialDepth(unit.id) : 0;
}

/**
 * Poradie nakládky dvoch jednotiek (záporné = `a` skôr): trieda stowage plánu (plné pred prázdnymi, ťažké skôr — `compareStowageClass`); v rámci triedy
 * (jednotky sú zameniteľné, sklad ich segreguje) tá, nad ktorou je menej kontajnerov, potom menšie id. Nakladať zospodu stohu by zbytočne spúšťalo rehandling.
 */
function compareLoadOrder(world: World, a: CargoUnit, b: CargoUnit): number {
  const byClass = compareStowageClass(a, b);
  if (byClass !== 0) return byClass;
  const depth = burialOf(world, a) - burialOf(world, b);
  return depth !== 0 ? depth : a.id - b.id;
}

/**
 * Najlepšia (min kľúč stowage plánu) uskladnená jednotka kontraktu smeru `direction` mimo hold a bez jobu, ktorá leží v sklade s cestou
 * ku kotvisku nakládky (`berths`, T6C-07b: odrezaný sklad nie je zdrojom), alebo `undefined`. Dosiahnuteľnosť skladu sa overuje raz za sklad
 * (jednotky skupiny idú podľa skladu vzostupne) a len pre jednotku, ktorá by predbehla doterajšiu najlepšiu.
 */
function bestStoredOf(world: World, contract: Contract, direction: CargoUnit['direction'], berths: readonly BerthModule[]): CargoUnit | undefined {
  const group = world.storedCargo.groupOf(contract.id);
  if (group === undefined) return undefined;
  let best: CargoUnit | undefined;
  let checkedStorage: EntityId | undefined;
  let reachable = false;
  for (let i = 0; i < group.units.length; i++) {
    const unit = world.cargo.get(group.units[i]);
    if (unit === undefined || unit.direction !== direction || unit.hold !== null || world.jobOfUnit(unit.id) !== undefined) continue;
    if (best !== undefined && compareLoadOrder(world, unit, best) >= 0) continue;
    if (!unitPickable(world, unit)) continue;
    if (group.storages[i] !== checkedStorage) {
      checkedStorage = group.storages[i];
      reachable = storageReaches(world, checkedStorage, berths);
    }
    if (reachable) best = unit;
  }
  return best;
}

/** Najlepšia jednotka na nakládku pre kontrakt (podľa druhu bookingu; viď hlavička súboru), alebo `undefined`; `berths` = kotviská nakládky lode. */
type LoadScan = (world: World, contract: Contract, berths: readonly BerthModule[]) => CargoUnit | undefined;

const LOAD_SCAN: { readonly [K in ContractKind]: LoadScan } = {
  import: () => undefined,
  export: (world, contract, berths) => bestStoredOf(world, contract, 'export', berths),
  tranship: (world, contract, berths) => bestStoredOf(world, contract, 'tranship', berths),
  // Prázdne nemajú kontrakt: dostupný prázdny linky z depa (alebo záložného dvora), najviac toľko, koľko je bookovaných.
  empty_repositioning: (world, contract, berths) => {
    const unit = contract.loadsToAssign > 0 ? findAvailableEmpty(world, contract.lineId, berths) : undefined;
    // Zavalený prázdny bez miesta na rehandling sa nenakladá (vozidlo by uviazlo, TR2-06b) — job vznikne, až keď sa blok uvoľní.
    return unit !== undefined && unitPickable(world, unit) ? unit : undefined;
  },
};

/** Jednotky plných bookingov lode (export, prekládka), ktoré sú prijaté, ale ešte nenaložené ani vrátené (mimo hold) — pred nimi sa prázdne nenakladajú. */
function fullUnitsPending(bookings: readonly Contract[]): number {
  let pending = 0;
  for (const contract of bookings) {
    const booking = contract.booking;
    if (booking === null || contract.loadsAfterFullUnits) continue;
    pending += Math.max(0, booking.arrivedUnits - booking.loadedUnits - booking.returnedUnits - booking.heldUnits);
  }
  return pending;
}

/**
 * Najlepšia jednotka na nakládku (podľa stowage plánu: plné pred prázdnymi) cez bookingy lode, ktoré sa nakladajú (`acceptsLoading`, pred
 * lehotou zlyhania); bez nej `undefined`. Prázdne (`Contract.loadsAfterFullUnits`) dostanú nakládku až keď loď nemá žiadnu prijatú a nenaloženú
 * plnú jednotku — vozidlá s plnými a prázdnymi jednotkami by sa inak predbiehali pod hákom a stowage „plné, potom prázdne“ by sa porušil.
 * Bez poľa a triedenia (úplné usporiadanie).
 */
function bestLoadable(world: World, bookings: readonly Contract[], berths: readonly BerthModule[]): CargoUnit | undefined {
  let best: CargoUnit | undefined;
  let fullPending = -1;
  for (const contract of bookings) {
    if (!contract.acceptsLoading || loadingStopped(world, contract)) continue;
    if (contract.loadsAfterFullUnits) {
      fullPending = fullPending < 0 ? fullUnitsPending(bookings) : fullPending;
      if (fullPending > 0) continue;
    }
    const unit = LOAD_SCAN[contract.kind](world, contract, berths);
    if (unit !== undefined && (best === undefined || compareLoadOrder(world, unit, best) < 0)) best = unit;
  }
  return best;
}

/** Zdroj → cieľ nakládky v režime `apron`: rezervuje slot apronu (limit smeru), inak `undefined`. */
function apronTarget(world: World, berth: BerthModule, ship: Ship): CargoLocation | undefined {
  if (berth.apron.freeUnreservedCount <= 0) return undefined;
  if (exportApronUsage(world, berth) >= apronDirectionCap(berth, bothDirections(world, ship))) return undefined;
  return { kind: 'on_apron', berthId: berth.id, slot: berth.apron.reserve() };
}

/**
 * Cieľ nakládky v režime `under_hook`: hák žeriava s najmenším počtom jobov nakládky v obehu, inak `undefined`. Každý žeriav má v obehu najviac
 * `logistics.hookJobLookahead` jobov nakládky (okno dopredného plánovania, TR3-02d: ťahače sa pred žeriavom zaradia do pruhu kotviska vopred); kým má loď aj import
 * na vykládku (`bothDirections`, ADR-033 bod 4), je limit `logistics.hookPairedLoadJobs` — vozidlo s exportom čaká pod hákom popri vozidlách s importom, takže žeriav
 * robí dual cycle a nakládka nevyčerpá vozidlá vykládky.
 */
function hookTarget(world: World, berth: BerthModule, ship: Ship): CargoLocation | undefined {
  let best: CraneModule | undefined;
  let bestJobs = Infinity;
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (!(crane instanceof CraneModule) || crane.category !== ship.cargoCategory) continue;
    const jobs = hookLoadJobs(world, crane);
    if (jobs < bestJobs) {
      best = crane;
      bestJobs = jobs;
    }
  }
  if (best === undefined || bestJobs >= (bothDirections(world, ship) ? world.defs.logistics.hookPairedLoadJobs : world.defs.logistics.hookJobLookahead)) return undefined;
  return { kind: 'in_crane', craneId: best.id };
}

/** Cieľ nakládky podľa režimu kotviska (tabuľka, nie switch). */
const LOAD_TARGET: { readonly [M in HandoverMode]: (world: World, berth: BerthModule, ship: Ship) => CargoLocation | undefined } = {
  apron: apronTarget,
  under_hook: hookTarget,
};

/**
 * Pre jednotku `unit` nájde kotvisko lode s cieľom nakládky (`LOAD_TARGET` podľa režimu) a otvorí job; `false` = žiadne kotvisko nemá
 * kapacitu. Kotviská lode vzostupne, len so žeriavom kategórie nákladu a s cestou zo skladu jednotky (T6C-07b); prvé s voľnou kapacitou
 * berie jednotku.
 */
function openLoadJob(world: World, ship: Ship, unit: CargoUnit, openJob: OpenJob): boolean {
  const storage = unit.location.kind === 'in_storage' ? world.modules.get(unit.location.moduleId) : undefined;
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule) || craneFor(world, berth, ship) === undefined) continue;
    if (storage !== undefined && distanceBetweenModules(world, storage, berth) === Infinity) continue;
    const target = LOAD_TARGET[berth.params.handoverMode](world, berth, ship);
    if (target === undefined) continue;
    openJob({ unitIds: [unit.id], from: unit.location, to: target, ...(target.kind === 'in_crane' ? { toModuleId: berth.id } : {}) });
    return true;
  }
  return false;
}

/** Priradí jednotku nakládke prvého bookingu, ktorý ju nakladá a smie ešte prideľovať (`Contract.assignLoad`); bookingy v poradí id, bez alokácie. */
function assignToBooking(world: World, bookings: readonly Contract[], unit: CargoUnit): void {
  for (const contract of bookings) {
    if (!contract.acceptsLoading || loadingStopped(world, contract) || contract.loadsToAssign <= 0 || !contract.loadsUnit(unit)) continue;
    contract.assignLoad(unit);
    return;
  }
}

/**
 * Vráti pridelenie nakládky bookingu (`Contract.releaseLoad`) pri zrušení jobu nakládky, ktorý už mal vozidlo (rehandling bez cieľa, TR2-06b); iný job nič nerobí.
 * Booking sa hľadá ako pri zastavenej nakládke — prvý neukončený booking dokovanej lode, ktorý jednotku nakladá.
 */
export function releaseLoadAssignment(world: World, job: TransportJob): void {
  if (job.from.kind !== 'in_storage' || (job.to.kind !== 'on_apron' && job.to.kind !== 'in_crane')) return;
  const berth = world.modules.get(job.toModuleId);
  const unit = world.cargo.get(job.unitIds[0]);
  if (!(berth instanceof BerthModule) || berth.dockedShipId === null || unit === undefined) return;
  for (const contract of openLoadBookings(world, berth.dockedShipId, BOOKINGS)) {
    if (!contract.loadsUnit(unit)) continue;
    contract.releaseLoad(unit);
    return;
  }
}

/**
 * Nakládka bookingov lode sa zastavila (`loadingStopped`: po lehote zlyhania sa nové joby nezačínajú)? Otvorené joby nakládky jednotiek týchto
 * bookingov, ktoré ešte nemajú vozidlo (`open`), sa zrušia (`loading_stopped`) a booking dostane pridelenie späť (`Contract.releaseLoad`) — job,
 * ku ktorému sa vozidlo nedostane (odrezaný sklad, chýbajúce vozidlá), by inak navždy držal `loadingInFlight` a loď s kotviskom by neodišli
 * (T6C-07b, M2). Job s vozidlom sa nezruší — vozidlo ho dokončí. Prechod jobmi len keď niektorý booking lode je zastavený.
 */
function cancelStoppedLoadJobs(world: World, ship: Ship, bookings: readonly Contract[], cancel: CancelJob): void {
  let stopped = false;
  for (const contract of bookings) {
    if (loadingStopped(world, contract)) {
      stopped = true;
      break;
    }
  }
  if (!stopped) return;
  for (const job of world.jobs.values()) {
    if (job.state !== 'open' || job.from.kind !== 'in_storage' || (job.to.kind !== 'on_apron' && job.to.kind !== 'in_crane') || !ship.berthIds.includes(job.toModuleId)) continue;
    const unit = world.cargo.get(job.unitIds[0]);
    if (unit === undefined) continue;
    for (const contract of bookings) {
      if (!loadingStopped(world, contract) || !contract.loadsUnit(unit)) continue;
      cancel(job, 'loading_stopped');
      contract.releaseLoad(unit);
      break;
    }
  }
}

/**
 * Joby nakládky exportu (viď hlavička súboru). Lode vzostupne podľa id; jednotky voyage v poradí stowage plánu sa priraďujú
 * kotviskám lode vzostupne — prvému s voľnou kapacitou; bez kapacity sa lode preskočí (jednotky počkajú v sklade). Jednotka sa berie len zo skladu
 * s cestou ku kotvisku lode (`load-access.ts`). Job musí zaregistrovať `openJob` (`World.addJob`) — jednotka s jobom už nie je v ďalšom výbere;
 * inak sa lode preskočí (poistka proti slučke). Po zastavení nakládky bookingu sa zrušia jeho otvorené joby bez vozidla (`cancelStoppedLoadJobs`).
 */
export function createExportLoadJobs(world: World, openJob: OpenJob, cancel: CancelJob): void {
  if (!world.contractBook.hasOpenExports) return;
  for (const ship of world.ships.values()) {
    if (ship.state !== 'docked') continue;
    const bookings = openLoadBookings(world, ship.id, BOOKINGS);
    if (bookings.length === 0) continue;
    cancelStoppedLoadJobs(world, ship, bookings, cancel);
    const berths = collectLoadBerths(world, ship, BERTHS);
    for (;;) {
      const unit = bestLoadable(world, bookings, berths);
      if (unit === undefined || !openLoadJob(world, ship, unit, openJob) || world.jobOfUnit(unit.id) === undefined) break;
      assignToBooking(world, bookings, unit);
    }
  }
}

/** Počet jobov vykládky pod hákom v obehu pre žeriav (zdroj `in_crane` tohto žeriava). */
function hookUnloadJobs(world: World, crane: CraneModule): number {
  let count = 0;
  for (const job of world.jobs.values()) if (job.from.kind === 'in_crane' && job.from.craneId === crane.id) count += 1;
  return count;
}

/** Job vykládky pod hákom pre jednotku `unit` z háku `crane` s rezervovaným slotom skladu; bez skladu `false` (+ `NoStorageAvailable`). */
function openUnloadJob(world: World, crane: CraneModule, berth: BerthModule, unit: CargoUnit, openJob: OpenJob, emitNoStorage: EmitNoStorage): boolean {
  const place = reserveYardSlot(world, unit, berth);
  if (place === null) {
    emitNoStorage(world, berth, unit.typeId);
    return false;
  }
  openJob({ unitIds: [unit.id], from: { kind: 'in_crane', craneId: crane.id }, fromModuleId: berth.id, to: { kind: 'in_storage', moduleId: place.moduleId, slot: place.slot } });
  return true;
}

/** Žeriavy kotvísk s vykládkou pod hákom (`Handover.plansUnloadTarget`) v cykle: jednotka žeriava (cieľ cyklu / v ruke) bez jobu dostane job vždy. */
function ensureCurrentUnitJobs(world: World, openJob: OpenJob, emitNoStorage: EmitNoStorage): void {
  for (const module of world.modules.values()) {
    if (!(module instanceof CraneModule) || module.state === 'idle' || module.state === 'blocked') continue;
    if (CRANE_CYCLE_TRAITS[module.cycle].direction !== 'unload') continue;
    const berth = world.modules.get(module.berthId);
    if (!(berth instanceof BerthModule) || !HANDOVERS[berth.params.handoverMode].plansUnloadTarget) continue;
    const unitId = module.state === 'grabbing' ? module.targetUnitId : module.heldUnitId;
    if (unitId === null || world.jobOfUnit(unitId) !== undefined) continue;
    const unit = world.cargo.get(unitId);
    if (unit !== undefined) openUnloadJob(world, module, berth, unit, openJob, emitNoStorage);
  }
}

/**
 * Vykládka pod hákom (viď hlavička súboru): (1) jednotka, ktorú žeriav v cykle vykladá (cieľ cyklu / v ruke) a nemá job, ho dostane
 * vždy; (2) **dispatch vopred** — pre ďalšie jednotky importu dokovanej lode v poradí id vzniknú joby `in_crane → in_storage` na
 * žeriav kotviska s najmenším počtom takých jobov, kým ich počet na kotvisko nedosiahne limit (`apronDirectionCap`, rovnako ako
 * pri nakládke), takže vozidlá čakajú pod hákom skôr, než žeriav jednotku zdvihne. Bez skladu job nevznikne (`NoStorageAvailable`).
 */
export function createHookUnloadJobs(world: World, openJob: OpenJob, emitNoStorage: EmitNoStorage): void {
  ensureCurrentUnitJobs(world, openJob, emitNoStorage);
  for (const ship of world.ships.values()) {
    if (ship.state !== 'docked') continue;
    for (const berthId of ship.berthIds) {
      const berth = world.modules.get(berthId);
      if (!(berth instanceof BerthModule) || !HANDOVERS[berth.params.handoverMode].plansUnloadTarget) continue;
      aheadUnloadJobs(world, ship, berth, openJob, emitNoStorage);
    }
  }
}

/** Znovupoužiteľné polia žeriavov kotviska a ich jobov vykládky v obehu pre `aheadUnloadJobs` (hot path; plní sa pri každom volaní). */
const AHEAD_CRANES: CraneModule[] = [];
const AHEAD_JOBS: number[] = [];

/** Joby vykládky vopred pre jedno kotvisko lode (viď `createHookUnloadJobs`). */
function aheadUnloadJobs(world: World, ship: Ship, berth: BerthModule, openJob: OpenJob, emitNoStorage: EmitNoStorage): void {
  const count = world.cargo.countAt('on_ship', ship.id);
  if (count === 0) return;
  AHEAD_CRANES.length = 0;
  AHEAD_JOBS.length = 0;
  let inFlight = 0;
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (!(crane instanceof CraneModule) || crane.category !== ship.cargoCategory) continue;
    const jobs = hookUnloadJobs(world, crane);
    AHEAD_CRANES.push(crane);
    AHEAD_JOBS.push(jobs);
    inFlight += jobs;
  }
  if (AHEAD_CRANES.length === 0) return;
  const lookahead = world.defs.logistics.hookJobLookahead;
  // Súčet jobov vykládky na kotvisko ohraničuje aj smerový limit apronu (`apronDirectionCap`, ADR-032 bod 10) — pôvodné správanie, ktoré drží zápchy v scenároch bez RTG (stress_f6) na nule.
  const cap = apronDirectionCap(berth, bothDirections(world, ship));
  for (let i = 0; i < count && inFlight < cap; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', ship.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined || isOutboundOnShip(world, unit, ship.id) || world.jobOfUnit(unit.id) !== undefined) continue;
    let fewest = 0;
    for (let k = 1; k < AHEAD_CRANES.length; k++) if (AHEAD_JOBS[k] < AHEAD_JOBS[fewest]) fewest = k;
    if (AHEAD_JOBS[fewest] >= lookahead) return;
    if (!openUnloadJob(world, AHEAD_CRANES[fewest], berth, unit, openJob, emitNoStorage)) return;
    AHEAD_JOBS[fewest] += 1;
    inFlight += 1;
  }
}
