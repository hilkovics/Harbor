/**
 * Dispatcher (ARCHITECTURE §6 krok 5, §7.3 body 1–3; rozhodnutie orchestrátora F3 č. 6, F4 č. 4 a F5 č. 9; ADR-018, ADR-023, ADR-027, ADR-041) — tvorba a priradenie jobov.
 * `DispatcherSystem` (krok 5) volá v každom ticku `createInboundJobs`, nakládku exportu a vykládku pod hákom a `assignOpenJobs`.
 *
 * **Inbound:** kotviská vzostupne podľa id, jednotky na aprone vo FIFO (poradie príchodu v ledgeri); jednotka bez aktívneho jobu dostane blok a stoh od `YardPlanner`
 * (`reserveYardSlot`, ADR-039), plánovač rezervuje bunku a vznikne job `open` (`JobCreated`). Ak sklad pre jednotku nie je, job nevznikne a jednotka čaká na aprone; kotvisko emituje
 * `NoStorageAvailable` najviac raz za hernú hodinu (`BerthModule.lastNoStorageHour`).
 *
 * **Odvoz a príjem kamiónmi** (R4, ADR-041 bod 4): kamióny sa obsluhujú priamo na odovzdávacom mieste (TP) pri bloku — joby `in_storage ↔ in_truck` vznikajú pri vzniku kamióna
 * (`trucks/truck-spawner.ts`, `trucks/hinterland-entry.ts`; `logistics/truck-jobs.ts`), nie v dispatcheri. Dispatcher z nich priraďuje vozidlu len joby kamiónov na TP na hrane bloku
 * (straddle, depo prázdnych), ktoré už stoja vo fáze odovzdania (`truckJobAssignable`); joby kamiónov v bloku s RTG obsluhuje stroj bloku (krok 6c).
 *
 * **Vykládka z lode a nakládka** (F6c, ADR-034 + dodatok T6C-03): jednotka na aprone dostane blok a stoh od plánovača skladu (`reserveYardSlot`, ADR-039 — segregácia podľa smeru:
 * prekládka z lode A zoskupene podľa kontraktu); jednotka na nakládku dokovanej lode (export, prázdne repositioningu, prekládka čakajúca na loď B) na aprone čaká na žeriav
 * (`awaitsCrane`), kým beží jej booking; joby nakládky vytvára `logistics/export-load.ts` (prázdne po plných jednotkách).
 *
 * **Zrušenie nakládky** (T6C-07b, M2): keď sa nakládka bookingu zastaví (`loadingStopped`), jeho `open` joby nakládky bez vozidla sa zrušia (`loading_stopped`) a
 * booking dostane pridelenie späť (`Contract.releaseLoad`) — job, ku ktorému sa vozidlo nedostane, by inak držal loď a kotvisko (`logistics/export-load.ts`).
 *
 * **Priradenie:** joby `open` podľa priority trasy (`JOB_ROUTES.priority`: inbound pred ostatnými — uvoľnenie apronu chráni žeriav pred blokovaním) a v rámci priority v poradí
 * vzniku (vzostupne podľa id); z voľných (`idle`) vozidiel, ktoré vozia kategóriu nákladu jobu, vyhrá najmenšia cena cesty z bunky vozidla k prístupovej bunke zdroja
 * (`distanceToModule`), pri zhode menšie id. Vozidlo bez cesty k zdroju job nedostane; job bez vozidla ostáva `open`.
 * Priradenie: `job.assign`, `vehicle.jobId`, `JobAssigned` a jazda k zdroju (`startTrip`: `idle → to_pickup` + `VehicleStateChanged` a trasa; pohyb v kroku 6 toho istého ticku, ADR-019).
 *
 * Hot path: žiadne `filter`/`map`/closures v cykle; aprony sa čítajú cez `CargoLedger.countAt`/`unitAtIndex` bez kópie; voľné vozidlá sa zbierajú raz za tick do znovupoužiteľného poľa.
 */
import type { CargoDirection, CargoUnit } from '../cargo/cargo-unit';
import type { CargoCategory } from '../defs/types';
import type { Contract } from '../contracts/contract';
import { BerthModule } from '../modules/berth-module';
import type { Vehicle } from '../vehicles/vehicle';
import { VEHICLE_STATE_TRAITS, changeVehicleState } from '../vehicles/vehicle-fsm';
import { startTrip, tryLeaveDepot } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';
import { cancelJob } from './job-cancel';
import { createExportLoadJobs as createLoadJobs, createHookUnloadJobs as createHookJobs, type LoadJobSpec } from './export-load';
import { gangFilter } from './gang-roster';
import { hookUnreachable } from './load-access';
import { vehicleMayServe } from './handling-chains';
import { distanceToModule } from './module-access';
import { JOB_PRIORITY_LEVELS, TransportJob } from './transport-job';
import { blockedByLeavingUnit, hasLeavingJob } from './pickup-demand';
import { isTruckJob, truckJobBlock, truckOfJob, truckReadyForHandling } from './truck-jobs';
import { reserveYardSlot, unitPickable } from './yard-planner';
import { anyBookingLoads, isOutboundOnShip, openLoadBookings } from './voyage-cargo';

/**
 * Smie vozidlo viezť jednotku (F6c, ADR-034)? Kategória nákladu a smer: `VehicleDef.cargoDirections` (chýba = každý smer;
 * empty handler len `empty`).
 */
export function vehicleCarries(vehicle: Vehicle, category: CargoCategory, direction: CargoDirection): boolean {
  const { cargoCategories, cargoDirections } = vehicle.def;
  return cargoCategories.includes(category) && (cargoDirections === undefined || cargoDirections.includes(direction));
}

/** Kategória nákladu jobu (podľa typu prvej jednotky — job nesie jednotky jedného typu). */
function jobCategory(world: World, job: TransportJob): CargoCategory | undefined {
  const unit = world.cargo.get(job.unitIds[0]);
  return unit === undefined ? undefined : world.defs.cargoTypes.get(unit.typeId).category;
}

/** `NoStorageAvailable` z kotviska najviac raz za hernú hodinu. */
function emitNoStorage(world: World, berth: BerthModule, cargoTypeId: string): void {
  const hour = world.clock.gameHour;
  if (berth.lastNoStorageHour === hour) return;
  berth.lastNoStorageHour = hour;
  world.events.emit({ type: 'NoStorageAvailable', berthId: berth.id, cargoTypeId });
}

/**
 * Čaká jednotka na aprone kotviska `berth` na žeriav (náklad na nakládku dokovanej lode: export, prekládka čakajúca na loď B, prázdne
 * repositioningu — booking beží)? Taká jednotka sa nevracia do skladu; po uzavretí bookingu (vrátenie odosielateľovi) sa spracuje ako
 * každá jednotka na aprone (ADR-032 bod 9). Prekládka z lode A (vykládka na apron) na žeriav nečaká — dostane job do skladu.
 */
function awaitsCrane(world: World, unit: CargoUnit, berth: BerthModule): boolean {
  if (!isOutboundOnShip(world, unit, berth.dockedShipId)) return false;
  if (unit.contractId === null) return berth.dockedShipId !== null && anyBookingLoads(openLoadBookings(world, berth.dockedShipId, AWAITED_BOOKINGS), unit);
  return world.contractBook.get(unit.contractId)?.outbound === 'held';
}

/** Znovupoužiteľné pole bookingov dokovanej lode pre `awaitsCrane` (hot path; obsah sa vždy najprv vyprázdni). */
const AWAITED_BOOKINGS: Contract[] = [];

/** Joby pre jednotky na aprone jedného kotviska (FIFO), ktoré ešte job nemajú. */
function inboundFromBerth(world: World, berth: BerthModule): void {
  const count = world.cargo.countAt('on_apron', berth.id);
  let missingTypeId: string | undefined;
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_apron', berth.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined || world.jobOfUnit(unit.id) !== undefined || awaitsCrane(world, unit, berth)) continue;
    const place = reserveYardSlot(world, unit, berth);
    if (place === null) {
      missingTypeId ??= unit.typeId;
      continue;
    }
    openJob(world, { unitIds: [unit.id], from: unit.location, to: { kind: 'in_storage', moduleId: place.moduleId, slot: place.slot } });
  }
  if (missingTypeId !== undefined) emitNoStorage(world, berth, missingTypeId);
}

/** Inbound (§7.3 bod 1): joby pre jednotky na apronoch všetkých kotvísk (viď hlavička súboru). */
export function createInboundJobs(world: World): void {
  for (const module of world.modules.values()) {
    if (module instanceof BerthModule) inboundFromBerth(world, module);
  }
}

/**
 * Nakládka exportu (ADR-032 bod 9, ADR-033): joby `in_storage → on_apron` / `in_storage → in_crane` pre jednotky voyage dokovanej
 * lode v poradí stowage plánu (`logistics/export-load.ts`).
 */
export function createExportLoadJobs(world: World): void {
  createLoadJobs(
    world,
    (spec) => {
      openJob(world, spec);
    },
    (job, reason) => {
      cancelJob(world, job, reason);
    },
  );
}

/** Vykládka pod hákom (ADR-033): joby `in_crane → in_storage` pre jednotky, ktoré vykladajú žeriavy v režime `under_hook`. */
export function createHookUnloadJobs(world: World): void {
  createHookJobs(
    world,
    (spec) => {
      openJob(world, spec);
    },
    emitNoStorage,
  );
}

/** Vytvorí job `open` s už rezervovaným miestom v cieli, pridá ho do sveta a ohlási `JobCreated`. */
function openJob(world: World, init: LoadJobSpec): void {
  const job = new TransportJob({
    id: world.ids.next(),
    unitIds: init.unitIds,
    from: init.from,
    to: init.to,
    createdTick: world.clock.tick,
    ...(init.fromModuleId === undefined ? {} : { fromModuleId: init.fromModuleId }),
    ...(init.toModuleId === undefined ? {} : { toModuleId: init.toModuleId }),
  });
  world.addJob(job);
  world.events.emit({ type: 'JobCreated', jobId: job.id, unitIds: job.unitIds, fromModuleId: job.fromModuleId, toModuleId: job.toModuleId });
}

/**
 * Smie sa job kamióna priradiť vozidlu? Len keď blok obsluhuje vozidlo (straddle, depo — nie stroj bloku) a kamión stojí na TP vo fáze odovzdania (`handling`): vozidlo tak nikdy nečaká
 * na kamión, ktorý ešte nedorazil, a TP na hrane bloku nezablokuje.
 */
function truckJobAssignable(world: World, job: TransportJob): boolean {
  const truck = truckOfJob(world, job);
  const block = truckJobBlock(world, job);
  return truck !== undefined && block !== undefined && block.handlingSystem === 'straddle' && truckReadyForHandling(truck, job.id);
}

/**
 * Job, ktorý sa vozidlu nepriraďuje (zatiaľ): job zo skladu, ktorého jednotku zavaľuje kontajner s rozbehnutým jobom zo skladu (`hasLeavingJob`) alebo ktorú nemožno vybrať
 * (`unitPickable`) — vozidlo čaká, kým kontajnery nad ňou neodídu; job kamióna, ktorý nie je na TP pripravený (`truckJobAssignable`). Čakanie nevytvorí kruh: kontajner bez jobu sa preloží.
 */
function blockedJob(world: World, job: TransportJob): boolean {
  if (isTruckJob(job) && !truckJobAssignable(world, job)) return true;
  if (job.from.kind !== 'in_storage') return false;
  const unit = world.cargo.get(job.unitIds[0]);
  return unit !== undefined && (blockedByLeavingUnit(world, unit, hasLeavingJob) || !unitPickable(world, unit, world.defs.logistics.rehandleSpareCells));
}

/** Voľné vozidlá (`idle`, `to_depot`, `parked` — `VehicleStateTraits.free`) vzostupne podľa id do znovupoužiteľného poľa `into` (najprv ho vyprázdni) — raz za tick. */
function collectIdleVehicles(world: World, into: Vehicle[]): void {
  into.length = 0;
  for (const vehicle of world.vehicles.values()) {
    if (VEHICLE_STATE_TRAITS[vehicle.state].free) into.push(vehicle);
  }
}

/**
 * Prednosť vozidla pri jobe smeru `direction` (menšie = skôr): job prázdneho (`empty`) berie prednostne vozidlo, ktoré smery
 * obmedzuje na `empty` (empty handler, `cargoDirections` obsahuje `empty`), inak bežné vozidlo; joby iných smerov nerozlišujú.
 */
function vehiclePreference(vehicle: Vehicle, direction: CargoDirection): number {
  return direction === 'empty' && vehicle.def.cargoDirections?.includes('empty') === true ? 0 : 1;
}

/**
 * Najlepšie voľné vozidlo z `candidates` (vzostupne podľa id) pre job: vozí kategóriu a smer nákladu (`vehicleCarries`), cena cesty
 * k zdroju je konečná; vyhrá vyššia prednosť (`vehiclePreference`: empty handler pri jobe prázdneho), v rámci nej najmenšia cena,
 * pri zhode menšie id (berie sa len ostro menšia cena). Inak `undefined`.
 */
function pickVehicle(world: World, job: TransportJob, candidates: Iterable<Vehicle>): Vehicle | undefined {
  const source = world.modules.get(job.fromModuleId);
  const category = jobCategory(world, job);
  const direction = world.cargo.get(job.unitIds[0])?.direction;
  if (source === undefined || category === undefined || direction === undefined) return undefined;
  const gangAllows = gangFilter(world, job);
  let best: Vehicle | undefined;
  let bestPreference = Infinity;
  let bestCost = Infinity;
  for (const vehicle of candidates) {
    if (!VEHICLE_STATE_TRAITS[vehicle.state].free || !vehicleCarries(vehicle, category, direction) || !vehicleMayServe(world, vehicle, job)) continue;
    if (gangAllows !== undefined && !gangAllows(vehicle)) continue;
    const cost = distanceToModule(world, vehicle.cell, source);
    if (cost === Infinity) continue;
    const preference = vehiclePreference(vehicle, direction);
    if (preference < bestPreference || (preference === bestPreference && cost < bestCost)) {
      best = vehicle;
      bestPreference = preference;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Voľné vozidlo pre job zo všetkých vozidiel sveta: vozí kategóriu nákladu, cena cesty k zdroju je konečná a najmenšia,
 * pri zhode menšie id (vozidlá idú vzostupne podľa id, berie sa len ostro menšia cena). Inak `undefined`.
 */
export function chooseVehicle(world: World, job: TransportJob): Vehicle | undefined {
  return pickVehicle(world, job, world.vehicles.values());
}

/**
 * Kotvisko nakládky pod hákom (job `in_storage → in_crane`), ku ktorého háku nevedie cesta (jednosmerné zátky pri nábreží): nakládka ide rovno cez apron, takže job
 * potrebuje slot apronu už pri priradení (ADR-040 dodatok TR3-02b). Bez neho by vozidlo s jednotkou čakalo v `no_path` na zdrojovej bunke a zablokovalo vozidlo,
 * ktoré uvoľňuje apron. `undefined` = job sa týka bežného háku; inak kotvisko.
 */
function apronLoadBerth(world: World, job: TransportJob): BerthModule | undefined {
  if (job.from.kind !== 'in_storage' || job.to.kind !== 'in_crane') return undefined;
  const berth = world.modules.get(job.toModuleId);
  return berth instanceof BerthModule && hookUnreachable(world, job.to.craneId, berth) ? berth : undefined;
}

/** Je pre job voľné miesto na priradenie? Nakládka cez apron potrebuje slot nad rezervou pre vykládku (`apronUnloadReserveSlots`). */
function hasApronRoom(world: World, job: TransportJob): boolean {
  const berth = apronLoadBerth(world, job);
  return berth === undefined || berth.apron.freeUnreservedCount > world.defs.logistics.apronUnloadReserveSlots;
}

/** Priradí job vozidlu a pošle ho k zdroju (viď hlavička súboru). */
function assign(world: World, job: TransportJob, vehicle: Vehicle): void {
  job.assign(vehicle.id);
  const apronBerth = apronLoadBerth(world, job);
  if (apronBerth !== undefined) job.rebindTarget({ kind: 'on_apron', berthId: apronBerth.id, slot: apronBerth.apron.reserve() });
  vehicle.jobId = job.id;
  world.events.emit({ type: 'JobAssigned', jobId: job.id, vehicleId: vehicle.id });
  // Zaparkované vozidlo najprv vyjde z depa (`depot_exit`, voľný slot prístupovej bunky), ostatné idú k zdroju hneď (s preplánovaním).
  if (vehicle.state === 'parked') {
    changeVehicleState(world.events, vehicle, 'depot_exit');
    tryLeaveDepot(world, vehicle);
  } else {
    startTrip(world, vehicle, 'to_pickup');
  }
}

/**
 * Priradenie (§7.3 bod 3): joby `open` podľa priority trasy (inbound pred outbound, `JOB_ROUTES.priority`) a v rámci nej
 * v poradí vzniku dostanú najbližšie voľné kompatibilné vozidlo — jeden prechod jobmi na úroveň priority. Voľné vozidlá
 * sa zozbierajú raz za tick do `idle` (znovupoužiteľné pole `DispatcherSystem`; bez neho nové), priradené vozidlo z neho
 * vypadne a priradenie skončí, keď je prázdne — jeden job prejde len voľné vozidlá, nie celý vozový park.
 */
export function assignOpenJobs(world: World, idle: Vehicle[] = []): void {
  collectIdleVehicles(world, idle);
  for (let priority = 0; priority < JOB_PRIORITY_LEVELS; priority++) {
    for (const job of world.jobs.values()) {
      if (idle.length === 0) return;
      if (job.state !== 'open' || job.priority !== priority || blockedJob(world, job) || !hasApronRoom(world, job)) continue;
      const vehicle = pickVehicle(world, job, idle);
      if (vehicle === undefined) continue;
      assign(world, job, vehicle);
      idle.splice(idle.indexOf(vehicle), 1);
    }
  }
}
