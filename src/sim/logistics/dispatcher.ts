/**
 * Dispatcher (ARCHITECTURE §6 krok 5, §7.3 body 1 a 3; rozhodnutie orchestrátora F3 č. 6; ADR-018) — tvorba jobov
 * a priradenie vozidiel. `DispatcherSystem` (krok 5) volá v každom ticku najprv `createInboundJobs`, potom
 * `assignOpenJobs`. Outbound (§7.3 bod 2) príde vo F4.
 *
 * **Inbound:** kotviská vzostupne podľa id, jednotky na aprone vo FIFO (poradie príchodu v ledgeri); jednotka bez
 * aktívneho jobu dostane sklad z `allocateStorage` (najbližší pripojený s voľnou kapacitou, pri zhode menšie id),
 * sklad jej rezervuje slot (`reserve`) a vznikne job `open` (`JobCreated`). Ak sklad pre jednotku nie je, job nevznikne
 * a jednotka čaká na aprone; kotvisko emituje `NoStorageAvailable` najviac raz za hernú hodinu
 * (`BerthModule.lastNoStorageHour`).
 *
 * **Priradenie:** joby `open` v poradí vzniku (vzostupne podľa id); z voľných (`idle`) vozidiel, ktoré vozia kategóriu
 * nákladu jobu, vyhrá najmenšia cena cesty z bunky vozidla k prístupovej bunke zdroja (`distanceToModule`), pri zhode
 * menšie id. Vozidlo bez cesty k zdroju job nedostane; job bez vozidla ostáva `open`. Priradenie: `job.assign`,
 * `vehicle.jobId`, `JobAssigned` a jazda k zdroju (`startTrip`: `idle → to_pickup` + `VehicleStateChanged` a trasa;
 * pohyb v kroku 6 toho istého ticku, ADR-019).
 *
 * Hot path: žiadne `filter`/`map`/closures v cykle; aprony sa čítajú cez `CargoLedger.countAt`/`unitAtIndex` bez kópie
 * a mapy sveta sa prechádzajú v poradí id; voľné vozidlá sa zbierajú raz za tick do znovupoužiteľného poľa. Alokuje sa
 * len nový job (jeho zoznam jednotiek a lokácie).
 */
import type { CargoCategory } from '../defs/types';
import { BerthModule } from '../modules/berth-module';
import type { Vehicle } from '../vehicles/vehicle';
import { startTrip } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';
import { distanceToModule } from './module-access';
import { allocateStorage } from './storage-allocator';
import { TransportJob } from './transport-job';

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

/** Joby pre jednotky na aprone jedného kotviska (FIFO), ktoré ešte job nemajú. */
function inboundFromBerth(world: World, berth: BerthModule): void {
  const count = world.cargo.countAt('on_apron', berth.id);
  let missingTypeId: string | undefined;
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_apron', berth.id, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit === undefined || world.jobOfUnit(unit.id) !== undefined) continue;
    const storage = allocateStorage(world, berth, world.defs.cargoTypes.get(unit.typeId).category);
    if (storage === undefined) {
      missingTypeId ??= unit.typeId;
      continue;
    }
    const slot = storage.reserve();
    const job = new TransportJob({
      id: world.ids.next(),
      unitIds: [unit.id],
      from: unit.location,
      to: { kind: 'in_storage', moduleId: storage.id, slot },
      createdTick: world.clock.tick,
    });
    world.addJob(job);
    world.events.emit({ type: 'JobCreated', jobId: job.id, unitIds: job.unitIds, fromModuleId: job.fromModuleId, toModuleId: job.toModuleId });
  }
  if (missingTypeId !== undefined) emitNoStorage(world, berth, missingTypeId);
}

/** Inbound (§7.3 bod 1): joby pre jednotky na apronoch všetkých kotvísk (viď hlavička súboru). */
export function createInboundJobs(world: World): void {
  for (const module of world.modules.values()) {
    if (module instanceof BerthModule) inboundFromBerth(world, module);
  }
}

/** Voľné vozidlá (`idle`) vzostupne podľa id do znovupoužiteľného poľa `into` (najprv ho vyprázdni) — raz za tick. */
function collectIdleVehicles(world: World, into: Vehicle[]): void {
  into.length = 0;
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.state === 'idle') into.push(vehicle);
  }
}

/**
 * Najlepšie voľné vozidlo z `candidates` (vzostupne podľa id) pre job: vozí kategóriu nákladu, cena cesty k zdroju je
 * konečná a najmenšia, pri zhode menšie id (berie sa len ostro menšia cena). Inak `undefined`.
 */
function pickVehicle(world: World, job: TransportJob, candidates: Iterable<Vehicle>): Vehicle | undefined {
  const source = world.modules.get(job.fromModuleId);
  const category = jobCategory(world, job);
  if (source === undefined || category === undefined) return undefined;
  let best: Vehicle | undefined;
  let bestCost = Infinity;
  for (const vehicle of candidates) {
    if (vehicle.state !== 'idle' || !vehicle.def.cargoCategories.includes(category)) continue;
    const cost = distanceToModule(world, vehicle.cell, source);
    if (cost < bestCost) {
      best = vehicle;
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

/** Priradí job vozidlu a pošle ho k zdroju (viď hlavička súboru). */
function assign(world: World, job: TransportJob, vehicle: Vehicle): void {
  job.assign(vehicle.id);
  vehicle.jobId = job.id;
  world.events.emit({ type: 'JobAssigned', jobId: job.id, vehicleId: vehicle.id });
  startTrip(world, vehicle, 'to_pickup');
}

/**
 * Priradenie (§7.3 bod 3): joby `open` v poradí vzniku dostanú najbližšie voľné kompatibilné vozidlo. Voľné vozidlá sa
 * zozbierajú raz za tick do `idle` (znovupoužiteľné pole `DispatcherSystem`; bez neho nové), priradené vozidlo z neho
 * vypadne a priradenie skončí, keď je prázdne — jeden job prejde len voľné vozidlá, nie celý vozový park.
 */
export function assignOpenJobs(world: World, idle: Vehicle[] = []): void {
  collectIdleVehicles(world, idle);
  for (const job of world.jobs.values()) {
    if (idle.length === 0) return;
    if (job.state !== 'open') continue;
    const vehicle = pickVehicle(world, job, idle);
    if (vehicle === undefined) continue;
    assign(world, job, vehicle);
    idle.splice(idle.indexOf(vehicle), 1);
  }
}
