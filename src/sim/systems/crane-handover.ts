/**
 * Odovzdávanie žeriav ↔ vozidlo (F6a, ADR-032 bod 9–11, ADR-033) — to, čo sa v cykle žeriava líši podľa režimu kotviska
 * (`BerthParams.handoverMode`): dve stratégie v tabuľke `HANDOVERS` (pravidlo 7, bez vetvenia podľa režimu v `CraneSystem`).
 *
 * - **`apron`** (F2–F5): vykládka — jednotka z lode `in_crane → on_apron` na slot rezervovaný pri štarte cyklu; nakládka — jednotka
 *   `on_apron → in_crane` z apronu (dispatcher ju tam dovezie vozidlom, job `in_storage → on_apron`). Apron je zdieľaný buffer;
 *   rezerva `apronReserveSlots` chráni opačný smer pred zablokovaním.
 * - **`under_hook`** (ADR-033): vykládka — vozidlo čaká pod hákom (job `in_crane → in_storage` vznikne už pri štarte cyklu) a jednotka
 *   prejde `in_crane → in_vehicle`; keď pod hákom nikto nečaká a je voľný buffer (`craneBufferSlots`), žeriav ju odloží na apron
 *   (`in_crane → on_apron`) a job presmeruje na slot; inak žeriav s jednotkou čaká (`craneWaitForVehicleTicks`). Nakládka — vozidlo
 *   s jednotkou čaká pod hákom (job `in_storage → in_crane`) a žeriav ju zdvihne priamo `in_vehicle → in_crane`.
 *
 * Vlastnosti stratégie (`reservesUnloadSlot`, `plansUnloadTarget`) čítajú aj invarianty sveta (`world-invariants.ts`) a dispatcher
 * (`logistics/export-load.ts`) — režim sa nikde mimo tejto tabuľky nevetví podľa literálu (T6A-09b, pravidlo 7). Cyklus vykládky
 * začatý v režime `apron` a načítaný pod kotvisko `under_hook` (save spred ADR-033) prevedie obnova (`world-restore.ts`).
 *
 * Funkcie nemenia stav FSM žeriava (to robí `CraneSystem`); presuny nákladu idú výlučne cez `CargoLedger.move` (pravidlo 2).
 */
import { compareStowageOrder } from '../cargo/stowage';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { HandoverMode } from '../defs/types';
import { apronDirectionCap, bothDirections, importApronUsage } from '../logistics/apron-usage';
import { firstUnloadableOnShip, isLoadable, isOutboundOnShip } from '../logistics/voyage-cargo';
import { BerthModule } from '../modules/berth-module';
import { CRANE_CYCLE_TRAITS, CraneModule } from '../modules/crane-module';
import { ModuleError } from '../modules/module-error';
import type { Contract } from '../contracts/contract';
import type { Ship } from '../ships/ship';
import { changeVehicleState } from '../vehicles/vehicle-fsm';
import { startTrip } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';

/** Kontext cyklu žeriava: kotvisko, dokovaná loď a žeriav. */
export interface CraneEnv {
  readonly world: World;
  readonly crane: CraneModule;
  readonly berth: BerthModule;
  readonly ship: Ship;
}

/** Stratégia odovzdávania pre režim kotviska (viď hlavička súboru). */
export interface Handover {
  /**
   * Vykládka rezervuje slot apronu od `grabbing` (`CRANE_CYCLE_TRAITS.reservesFrom`) a jednotku z lode vyberie až koniec `grabbing`
   * (apron: áno), alebo nerezervuje nič a pri štarte cyklu vyberie cieľ cyklu `targetUnitId` (hook: nie).
   */
  readonly reservesUnloadSlot: boolean;
  /**
   * Cieľ cyklu a job `in_crane → in_storage` vopred pre vykládku (hook: áno — vozidlo príde pod hák skôr než žeriav jednotku zdvihne;
   * apron: nie, job vznikne až pre jednotku na aprone). Invarianty sveta (cieľ cyklu) a dispatcher (`createHookUnloadJobs`) ho čítajú tu.
   */
  readonly plansUnloadTarget: boolean;
  /**
   * Plán vykládky z lode: `undefined` = žeriav ju teraz nemôže začať (apron: bez voľného slotu v rámci smerového limitu, hook: na
   * lodi nie je jednotka importu pre tento žeriav); inak cieľ cyklu — jednotka importu (hook), alebo `null` (apron: jednotku
   * vyberie koniec `grabbing`). `continuation` = druhá polovica dual cyklu (apron: slot uvoľnený exportom je už rezervovaný).
   */
  planUnload(env: CraneEnv, continuation: boolean): EntityId | null | undefined;
  /** Začiatok vykládky po `planUnload`: apron rezervuje slot (pri dual cykle už rezervovaný), hook nič. */
  reserveUnload(env: CraneEnv): void;
  /** Žeriav s importom na lodi, ktorý vykládku nemôže začať, je `blocked` (apron: plný apron); hook nikdy — import berú iné žeriavy. */
  readonly blocksWhenNotReady: boolean;
  /** Koniec `grabbing` vykládky: jednotka importu, ktorú žeriav zdvihne z lode (apron: prvá, hook: cieľ cyklu). */
  unloadUnit(env: CraneEnv): EntityId | undefined;
  /**
   * Koniec `placing` vykládky: odovzdá jednotku v žeriave (`heldUnitId`) apronu / vozidlu / bufferu. `false` = zatiaľ sa nedá
   * (hook: pod hákom nikto nečaká a buffer je plný) — žeriav čaká a skúsi to v ďalšom ticku.
   */
  deliver(env: Pick<CraneEnv, 'world' | 'crane' | 'berth'>): boolean;
  /** Najlepšia (min kľúč stowage plánu) jednotka exportu pripravená na nakládku pre tento žeriav, alebo `undefined`. */
  loadable(env: CraneEnv, bookings: readonly Contract[]): EntityId | undefined;
  /** Koniec `grabbing` nakládky: zdvihne jednotku `crane.targetUnitId` (apron / vozidlo) do žeriava. */
  lift(env: CraneEnv): void;
  /** Čaká nečinný žeriav na vozidlo (hook: job nakládky mieri na tento žeriav, ale vozidlo ešte nie je pod hákom)? */
  idleWaits(env: CraneEnv): boolean;
}

/**
 * Znovupoužiteľné pole „zabraných“ jednotiek (cieľ cyklu iných žeriavov) — hot path bez alokácie (vzor `BOOKINGS`). Používa ho
 * naraz jediný dotaz (`loadable` / `planUnload`), ktorý ho najprv vyprázdni a pred návratom prestane čítať; nevnára sa.
 */
const CLAIMED: EntityId[] = [];

/** Do `CLAIMED` zapíše jednotky exportu, ktoré si už zabral iný žeriav kotviska (`targetUnitId` cyklov nakládky v `grabbing`). */
function claimLoads(world: World, berth: BerthModule, self: CraneModule): readonly EntityId[] {
  CLAIMED.length = 0;
  for (const craneId of berth.craneIds) {
    const other = world.modules.get(craneId);
    if (other instanceof CraneModule && other !== self && other.targetUnitId !== null) CLAIMED.push(other.targetUnitId);
  }
  return CLAIMED;
}

/** Je jednotka naložiteľný náklad niektorého z bookingov lode (export, prekládka podľa kontraktu, prázdne podľa linky; mimo hold, dostupná)? */
function isBookingUnit(unit: CargoUnit, bookings: readonly Contract[]): boolean {
  return isLoadable(unit) && bookings.some((contract) => contract.loadsUnit(unit));
}

/** Lepšia z dvoch jednotiek podľa stowage plánu (`undefined` = žiadna). */
function better(a: CargoUnit | undefined, b: CargoUnit): CargoUnit {
  return a === undefined || compareStowageOrder(b, a) < 0 ? b : a;
}

// ---------------------------------------------------------------------------------------------------------
// Režim `apron`
// ---------------------------------------------------------------------------------------------------------

/** Môže sa na aprone obsadiť ďalší slot importom (voľný slot v rámci smerového limitu)? */
function apronUnloadSlot({ world, berth, ship }: CraneEnv): boolean {
  if (berth.apron.freeUnreservedCount <= 0) return false;
  if (!world.contractBook.hasOpenExports || !bothDirections(world, ship)) return true;
  return importApronUsage(world, berth) < apronDirectionCap(berth, true);
}

const APRON_HANDOVER: Handover = {
  reservesUnloadSlot: true,
  plansUnloadTarget: false,
  planUnload: (env, continuation) => (continuation || apronUnloadSlot(env) ? null : undefined),
  reserveUnload: ({ crane, berth }) => {
    // Druhá polovica dual cyklu už nesie slot uvoľnený exportom (`lift`) — nová rezervácia len pri samostatnej vykládke.
    crane.reservedSlot ??= berth.apron.reserve();
  },
  blocksWhenNotReady: true,
  unloadUnit: ({ world, ship }) => firstUnloadableOnShip(world, ship.id),
  deliver: ({ world, crane, berth }) => {
    const unitId = crane.heldUnitId;
    const slot = crane.reservedSlot;
    if (unitId === null || slot === null) {
      throw new ModuleError('invalid_transition', `${crane.label}: koniec placing bez jednotky (${String(unitId)}) alebo slotu (${String(slot)})`);
    }
    berth.apron.assertCommittable(slot, unitId);
    world.cargo.move(unitId, { kind: 'on_apron', berthId: berth.id, slot });
    berth.apron.commit(slot, unitId);
    crane.reservedSlot = null;
    return true;
  },
  loadable: ({ world, crane, berth }, bookings) => {
    const claimed = claimLoads(world, berth, crane);
    let best: CargoUnit | undefined;
    const count = world.cargo.countAt('on_apron', berth.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('on_apron', berth.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit === undefined || claimed.includes(unit.id) || !isBookingUnit(unit, bookings)) continue;
      best = better(best, unit);
    }
    return best?.id;
  },
  lift: ({ world, crane, berth }) => {
    const unitId = crane.targetUnitId;
    const unit = unitId === null ? undefined : world.cargo.get(unitId);
    if (unit === undefined || unit.location.kind !== 'on_apron' || unit.location.berthId !== berth.id) {
      throw new ModuleError('invalid_transition', `${crane.label}: koniec grabbing nakládky, jednotka ${String(unitId)} nie je na aprone ${berth.label}`);
    }
    const { slot } = unit.location;
    world.cargo.move(unit.id, { kind: 'in_crane', craneId: crane.id });
    // Dual cyklus: slot uvoľnený zdvihnutou jednotkou sa hneď rezervuje pre import druhej polovice (nikto ho nepredbehne).
    if (CRANE_CYCLE_TRAITS[crane.cycle].reservesFrom === 'swinging') {
      berth.apron.reserveSlot(slot);
      crane.reservedSlot = slot;
    }
  },
  idleWaits: () => false,
};

// ---------------------------------------------------------------------------------------------------------
// Režim `under_hook`
// ---------------------------------------------------------------------------------------------------------

/**
 * Najlepšia jednotka exportu vo vozidlách, ktoré čakajú pod hákom žeriava `crane` (`unloading` pri jobe s cieľom `in_crane`
 * tohto žeriava), podľa stowage plánu; bez nich `undefined`.
 */
function bestUnderHook(world: World, crane: CraneModule, bookings: readonly Contract[]): CargoUnit | undefined {
  let best: CargoUnit | undefined;
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.state !== 'unloading' || vehicle.jobId === null) continue;
    const job = world.jobs.get(vehicle.jobId);
    if (job === undefined || job.to.kind !== 'in_crane' || job.to.craneId !== crane.id) continue;
    const unitId = world.cargo.firstUnitAt('in_vehicle', vehicle.id);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined && isBookingUnit(unit, bookings)) best = better(best, unit);
  }
  return best;
}

/** Do `CLAIMED` zapíše zabrané jednotky importu na lodi: cieľ cyklu iných žeriavov kotvísk lode v `grabbing` (vykládka pod hákom). */
function claimImports(world: World, ship: Ship, self: CraneModule): readonly EntityId[] {
  CLAIMED.length = 0;
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) continue;
    for (const craneId of berth.craneIds) {
      const other = world.modules.get(craneId);
      if (other instanceof CraneModule && other !== self && other.state === 'grabbing' && CRANE_CYCLE_TRAITS[other.cycle].direction === 'unload' && other.targetUnitId !== null) {
        CLAIMED.push(other.targetUnitId);
      }
    }
  }
  return CLAIMED;
}

/** Čaká pod hákom žeriava vozidlo s jednotkou na nakládku (`unloading` pri jobe s cieľom `in_crane` tohto žeriava)? */
function vehicleWaitsForLoad(world: World, crane: CraneModule): boolean {
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.state !== 'unloading' || vehicle.jobId === null) continue;
    const job = world.jobs.get(vehicle.jobId);
    if (job !== undefined && job.to.kind === 'in_crane' && job.to.craneId === crane.id) return true;
  }
  return false;
}

/** Je na aprone kotviska voľný buffer pre žeriav (`craneBufferSlots × žeriavy`)? Buffer = jednotky na aprone v režime `under_hook`. */
export function hookBufferFree(world: World, berth: BerthModule): boolean {
  const slots = berth.params.craneBufferSlots * berth.craneIds.length;
  return slots > 0 && world.cargo.countAt('on_apron', berth.id) < slots && berth.apron.freeUnreservedCount > 0;
}

const HOOK_HANDOVER: Handover = {
  reservesUnloadSlot: false,
  plansUnloadTarget: true,
  planUnload: ({ world, crane, ship }) => {
    // Jednotka pre tento žeriav: najmenšie id s vozidlom už pod hákom (žeriav nečaká), inak s jobom na tento žeriav (vozidlo je na
    // ceste), inak prvá voľná jednotka importu (job vznikne v kroku 5 toho istého ticku). Jednotky s jobom iného žeriava a zabrané
    // jednotky sa preskočia.
    const claimed = claimImports(world, ship, crane);
    let queued: EntityId | undefined;
    let fresh: EntityId | undefined;
    const count = world.cargo.countAt('on_ship', ship.id);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('on_ship', ship.id, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unitId === undefined || unit === undefined || isOutboundOnShip(world, unit, ship.id) || claimed.includes(unitId)) continue;
      const job = world.jobOfUnit(unitId);
      if (job === undefined) {
        fresh ??= unitId;
        continue;
      }
      if (job.from.kind !== 'in_crane' || job.from.craneId !== crane.id) continue;
      const vehicle = job.vehicleId === null ? undefined : world.vehicles.get(job.vehicleId);
      if (vehicle?.state === 'loading') return unitId;
      queued ??= unitId;
    }
    return queued ?? fresh;
  },
  reserveUnload: () => undefined,
  blocksWhenNotReady: false,
  unloadUnit: ({ world, crane, ship }) => {
    const unitId = crane.targetUnitId;
    const unit = unitId === null ? undefined : world.cargo.get(unitId);
    return unit?.location.kind === 'on_ship' && unit.location.shipId === ship.id ? unit.id : undefined;
  },
  deliver: ({ world, crane, berth }) => {
    const unitId = crane.heldUnitId;
    if (unitId === null) throw new ModuleError('invalid_transition', `${crane.label}: koniec placing vykládky pod hákom bez jednotky v žeriave`);
    const job = world.jobOfUnit(unitId);
    const vehicle = job?.vehicleId === null || job === undefined ? undefined : world.vehicles.get(job.vehicleId);
    if (job !== undefined && vehicle !== undefined && job.from.kind === 'in_crane' && vehicle.state === 'loading') {
      // Priame odovzdanie: vozidlo čaká pod hákom — jednotka prejde `in_crane → in_vehicle`, vozidlo vyráža k skladu.
      world.cargo.move(unitId, { kind: 'in_vehicle', vehicleId: vehicle.id });
      job.transition('moving');
      vehicle.waitTicks = 0;
      startTrip(world, vehicle, 'to_dropoff');
      return true;
    }
    // Buffer: pod hákom nikto nečaká — jednotka na apron a job (ak vznikol) ju odtiaľ vezme vozidlo bežným spôsobom. Protideadlock:
    // ak pod hákom čaká vozidlo s exportom, žeriav s jednotkou v ruke by ho zablokoval (vozidlá viazané na nakládku nedoplnia
    // vozidlo pre túto jednotku) — vtedy sa použije ľubovoľný voľný slot apronu aj nad `craneBufferSlots`.
    if (!hookBufferFree(world, berth) && !(vehicleWaitsForLoad(world, crane) && berth.apron.freeUnreservedCount > 0)) return false;
    const slot = berth.apron.reserve();
    berth.apron.assertCommittable(slot, unitId);
    world.cargo.move(unitId, { kind: 'on_apron', berthId: berth.id, slot });
    berth.apron.commit(slot, unitId);
    job?.rebindSource({ kind: 'on_apron', berthId: berth.id, slot });
    return true;
  },
  loadable: ({ world, crane }, bookings) => bestUnderHook(world, crane, bookings)?.id,
  lift: ({ world, crane }) => {
    const unitId = crane.targetUnitId;
    const unit = unitId === null ? undefined : world.cargo.get(unitId);
    const job = unitId === null ? undefined : world.jobOfUnit(unitId);
    const vehicle = job?.vehicleId === null || job === undefined ? undefined : world.vehicles.get(job.vehicleId);
    if (unit === undefined || job === undefined || vehicle === undefined || unit.location.kind !== 'in_vehicle' || unit.location.vehicleId !== vehicle.id) {
      throw new ModuleError('invalid_transition', `${crane.label}: koniec grabbing nakládky pod hákom, jednotka ${String(unitId)} nie je vo vozidle jobu`);
    }
    world.cargo.move(unit.id, { kind: 'in_crane', craneId: crane.id });
    // Job vozidla je hotový (jednotka je v žeriave); vozidlo je voľné a stojí pod hákom (dual cycle ho môže hneď využiť).
    job.transition('done');
    world.removeJob(job.id);
    vehicle.jobId = null;
    vehicle.waitTicks = 0;
    world.events.emit({ type: 'JobDone', jobId: job.id });
    changeVehicleState(world.events, vehicle, 'idle');
  },
  idleWaits: ({ world, crane }) => {
    for (const job of world.jobs.values()) {
      if (job.to.kind === 'in_crane' && job.to.craneId === crane.id) return true;
    }
    return false;
  },
};

/** Stratégie podľa režimu odovzdávania kotviska (`BerthParams.handoverMode`). */
export const HANDOVERS: { readonly [M in HandoverMode]: Handover } = Object.freeze({ apron: APRON_HANDOVER, under_hook: HOOK_HANDOVER });
