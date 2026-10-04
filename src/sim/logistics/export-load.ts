/**
 * Joby nakládky a vykládky pod hákom (F6a, ADR-032 bod 9, ADR-033; dispatcher krok 5):
 *
 * - **Nakládka exportu** (`createExportLoadJobs`): pre každú dokovanú loď s bookingom v stave `exporting` sa jednotky voyage v sklade
 *   (mimo hold, bez jobu) berú **v poradí stowage plánu** (`compareStowageOrder`: heavy → medium → light, potom id) a každá dostane
 *   job k žeriavu kotviska lode: režim `apron` — `in_storage → on_apron` s rezervovaným slotom apronu (smerový limit
 *   `apronSlots − apronReserveSlots`, kým má loď aj import; ADR-032 bod 10), režim `under_hook` — `in_storage → in_crane`
 *   na žeriav s najmenším počtom jobov nakládky v obehu (počet jobov v obehu na kotvisko je ohraničený rovnako ako sloty apronu).
 *   Job vzniká až pri dokovanej lodi (`docked`; od `lashing` sa nenakladá) a len pre kotvisko so žeriavom kategórie nákladu.
 * - **Vykládka pod hákom** (`createHookUnloadJobs`): joby `in_crane → in_storage` s rezervovaným slotom skladu vznikajú **vopred** —
 *   pre jednotku, ktorú žeriav práve vykladá, aj pre ďalšie jednotky importu dokovanej lode — aby dispatcher poslal vozidlá k háku
 *   skôr, než žeriav jednotku zdvihne, a žeriav nečakal (`NoStorageAvailable`, keď sklad nie je).
 *
 * Funkcie nemenia ledger; vznik jobu rieši `openJob` z dispatchera (`JobCreated`, `World.addJob`). Hot path bez alokácií: jednotky
 * nakládky sa vyberajú po jednej (najlepšia podľa stowage plánu, bez poľa a triedenia — poradie je úplné, takže je rovnaké ako pri
 * triedení) a polia kotvísk / žeriavov sú znovupoužiteľné na úrovni modulu (vzor `BOOKINGS`).
 */
import { compareStowageOrder } from '../cargo/stowage';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import type { EntityId } from '../core/entity-id';
import type { HandoverMode } from '../defs/types';
import { BerthModule } from '../modules/berth-module';
import { CRANE_CYCLE_TRAITS, CraneModule } from '../modules/crane-module';
import { HANDOVERS } from '../systems/crane-handover';
import { apronDirectionCap, bothDirections, exportApronUsage } from './apron-usage';
import { loadingStopped, openExportBookings } from './voyage-cargo';
import type { CargoLocation } from '../cargo/cargo-location';
import type { Ship } from '../ships/ship';
import type { World } from '../world/world';
import { allocateStorage } from './storage-allocator';

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

/** Hláška „žiadny sklad" z kotviska (`NoStorageAvailable`, najviac raz za hernú hodinu). */
export type EmitNoStorage = (world: World, berth: BerthModule, cargoTypeId: string) => void;

/** Znovupoužiteľné pole bookingov lode (hot path; obsah sa vždy najprv vyprázdni). */
const BOOKINGS: Contract[] = [];

/**
 * Najviac jobov nakládky pod hákom v obehu na žeriav, kým má loď aj import na vykládku (ADR-033 bod 4): vozidlo s exportom čaká pod
 * hákom popri vozidlách s importom, takže žeriav robí dual cycle a nakládka nevyčerpá vozidlá vykládky.
 */
export const PAIRED_HOOK_LOAD_JOBS_PER_CRANE = 1;

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

/**
 * Najlepšia jednotka voyage v sklade, ktorá smie na nakládku (export, mimo hold, bez jobu), podľa stowage plánu
 * (`compareStowageOrder`: heavy → medium → light, potom id); bez nej `undefined`. Bez poľa a triedenia (úplné usporiadanie).
 */
function bestLoadableStored(world: World, bookings: readonly Contract[]): CargoUnit | undefined {
  let best: CargoUnit | undefined;
  for (const contract of bookings) {
    if (contract.state !== 'exporting' || loadingStopped(world, contract)) continue;
    const group = world.storedCargo.groupOf(contract.id);
    if (group === undefined) continue;
    for (const unitId of group.units) {
      const unit = world.cargo.get(unitId);
      if (unit === undefined || unit.direction !== 'export' || unit.hold !== null || world.jobOfUnit(unit.id) !== undefined) continue;
      if (best === undefined || compareStowageOrder(unit, best) < 0) best = unit;
    }
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
 * Cieľ nakládky v režime `under_hook`: hák žeriava s najmenším počtom jobov nakládky v obehu, inak `undefined`. Kým má loď aj import
 * na vykládku (`bothDirections`), má každý žeriav najviac `PAIRED_HOOK_LOAD_JOBS_PER_CRANE` jobov nakládky v obehu. Bez importu je limit ako pri apron:
 * `apronSlots` jobov na kotvisko (`apronDirectionCap`).
 */
function hookTarget(world: World, berth: BerthModule, ship: Ship): CargoLocation | undefined {
  const paired = bothDirections(world, ship);
  let best: CraneModule | undefined;
  let bestJobs = Infinity;
  let total = 0;
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (!(crane instanceof CraneModule) || crane.category !== ship.cargoCategory) continue;
    const jobs = hookLoadJobs(world, crane);
    total += jobs;
    if (jobs < bestJobs) {
      best = crane;
      bestJobs = jobs;
    }
  }
  if (best === undefined || (paired ? bestJobs >= PAIRED_HOOK_LOAD_JOBS_PER_CRANE : total >= apronDirectionCap(berth, false))) return undefined;
  return { kind: 'in_crane', craneId: best.id };
}

/** Cieľ nakládky podľa režimu kotviska (tabuľka, nie switch). */
const LOAD_TARGET: { readonly [M in HandoverMode]: (world: World, berth: BerthModule, ship: Ship) => CargoLocation | undefined } = {
  apron: apronTarget,
  under_hook: hookTarget,
};

/**
 * Pre jednotku `unit` nájde kotvisko lode s cieľom nakládky (`LOAD_TARGET` podľa režimu) a otvorí job; `false` = žiadne kotvisko nemá
 * kapacitu. Kotviská lode vzostupne, len so žeriavom kategórie nákladu; prvé s voľnou kapacitou berie jednotku.
 */
function openLoadJob(world: World, ship: Ship, unit: CargoUnit, openJob: OpenJob): boolean {
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule) || craneFor(world, berth, ship) === undefined) continue;
    const target = LOAD_TARGET[berth.params.handoverMode](world, berth, ship);
    if (target === undefined) continue;
    openJob({ unitIds: [unit.id], from: unit.location, to: target, ...(target.kind === 'in_crane' ? { toModuleId: berth.id } : {}) });
    return true;
  }
  return false;
}

/**
 * Joby nakládky exportu (viď hlavička súboru). Lode vzostupne podľa id; jednotky voyage v poradí stowage plánu sa priraďujú
 * kotviskám lode vzostupne — prvému s voľnou kapacitou; bez kapacity sa lode preskočí (jednotky počkajú v sklade). Job musí
 * zaregistrovať `openJob` (`World.addJob`) — jednotka s jobom už nie je v ďalšom výbere; inak sa lode preskočí (poistka proti slučke).
 */
export function createExportLoadJobs(world: World, openJob: OpenJob): void {
  if (!world.contractBook.hasOpenExports) return;
  for (const ship of world.ships.values()) {
    if (ship.state !== 'docked') continue;
    const bookings = openExportBookings(world, ship.id, BOOKINGS);
    if (bookings.length === 0) continue;
    for (;;) {
      const unit = bestLoadableStored(world, bookings);
      if (unit === undefined || !openLoadJob(world, ship, unit, openJob) || world.jobOfUnit(unit.id) === undefined) break;
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
  const storage = allocateStorage(world, berth, world.defs.cargoTypes.get(unit.typeId).category);
  if (storage === undefined) {
    emitNoStorage(world, berth, unit.typeId);
    return false;
  }
  openJob({ unitIds: [unit.id], from: { kind: 'in_crane', craneId: crane.id }, fromModuleId: berth.id, to: { kind: 'in_storage', moduleId: storage.id, slot: storage.reserve() } });
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
  const cap = apronDirectionCap(berth, bothDirections(world, ship));
  for (let i = 0; i < count && inFlight < cap; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', ship.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined || unit.direction !== 'import' || world.jobOfUnit(unit.id) !== undefined) continue;
    let fewest = 0;
    for (let k = 1; k < AHEAD_CRANES.length; k++) if (AHEAD_JOBS[k] < AHEAD_JOBS[fewest]) fewest = k;
    if (!openUnloadJob(world, AHEAD_CRANES[fewest], berth, unit, openJob, emitNoStorage)) return;
    AHEAD_JOBS[fewest] += 1;
    inFlight += 1;
  }
}
