/**
 * Dispatcher (ARCHITECTURE §6 krok 5, §7.3 body 1–3; rozhodnutie orchestrátora F3 č. 6, F4 č. 4 a F5 č. 9; ADR-018,
 * ADR-023, ADR-027) —
 * tvorba, zrušenie a priradenie jobov. `DispatcherSystem` (krok 5) volá v každom ticku `cancelUnusableOutboundJobs` →
 * `createInboundJobs` → `createOutboundJobs` → `assignOpenJobs`.
 *
 * **Inbound:** kotviská vzostupne podľa id, jednotky na aprone vo FIFO (poradie príchodu v ledgeri); jednotka bez
 * aktívneho jobu dostane sklad z `allocateStorage` (najbližší pripojený s voľnou kapacitou, pri zhode menšie id),
 * sklad jej rezervuje slot (`reserve`) a vznikne job `open` (`JobCreated`). Ak sklad pre jednotku nie je, job nevznikne
 * a jednotka čaká na aprone; kotvisko emituje `NoStorageAvailable` najviac raz za hernú hodinu
 * (`BerthModule.lastNoStorageHour`).
 *
 * **Outbound** (F4 ADR-023, F5 ADR-027 vrátane dodatku T05-11): na rampu smú uskladnené jednotky kontraktov v stave
 * `unloading` a `exporting` (`CONTRACT_STATE_TRAITS.outbound = 'sla'` — objem nad voľnú kapacitu skladov sa vyvezie už
 * počas vykládky), kontraktov v stave `failed` (`free` — náklad nesmie navždy zaberať sklad, kontraktu sa už
 * nezapočíta) a jednotky bez kontraktu (`contractId === null`, scenáre F2–F4 a `SpawnShipDebug`). Ostatné stavy
 * (`held`) uskladnené jednotky nemajú. Poradie: skupiny `sla` podľa `slaDeadlineTick` ↑, potom
 * id kontraktu ↑; potom `free` kontrakty podľa id ↑ a nakoniec jednotky bez kontraktu; v rámci skupiny FIFO (sklad ↑,
 * v sklade poradie príchodu). Jednotky číta z odvodenej cache `World.storedCargo` (`StoredCargoIndex`, udržiava ju
 * háčik ledgera, nie je v save), takže prechádza len jednotky skupín, ktoré smú na rampu — nie jednotky × kontrakty.
 * Jednotka bez aktívneho jobu dostane rampu z `allocateRamp` pre svoj sklad (prevádzková, kategórie skladu, s voľným
 * staging miestom, najbližšia zo skladu podľa `DistanceMatrix`, pri zhode menšie id), rampa jej rezervuje miesto na
 * najnižšom docku s voľným miestom (`reserve(firstFreeDock())`) a vznikne job `in_storage → at_ramp` (`JobCreated`).
 * Rampy, ktoré môžu job dostať, sa zbierajú raz za tick do znovupoužiteľného poľa; bez nich sa skupiny ani nezbierajú
 * a plná rampa z poľa vypadne — outbound jobov vznikne za tick najviac toľko, koľko je voľných staging miest, a skupinou
 * sa prechádza len cez jej jednotky s aktívnym outbound jobom (najviac toľko, koľko je staging miest), jednotky
 * skladov bez vhodnej rampy a po prvú jednotku, ktorá job dostane. Pri samých jednotkách bez kontraktu je poradie
 * jobov rovnaké ako vo F4 (sklady ↑, FIFO).
 *
 * **Zrušenie** (ADR-023): `open` outbound job, ktorého rampa už nie je prevádzková alebo k nej zo skladu nevedie cesta
 * (podmienky vzniku), sa zruší — rezervácia na docku sa uvoľní, job prejde do `cancelled`, zmizne a emituje
 * `JobCancelled`. Jednotka ostane v sklade a `createOutboundJobs` jej v tom istom kroku nájde inú rampu, ak nejaká je
 * (inak neskôr, keď rampa bude znova prevádzková). Job, ktorý už má vozidlo, sa neruší — vozidlo ho dokončí (ak k rampe
 * cesta nevedie, čaká v `no_path` a skúša znova, ADR-019); jednotka sa nestratí a sklad ani rampa sa nezablokujú.
 *
 * **Priradenie:** joby `open` podľa priority trasy (`JOB_ROUTES.priority`: inbound pred outbound — uvoľnenie apronu
 * chráni žeriav pred blokovaním) a v rámci priority v poradí vzniku (vzostupne podľa id); z voľných (`idle`) vozidiel,
 * ktoré vozia kategóriu nákladu jobu, vyhrá najmenšia cena cesty z bunky vozidla k prístupovej bunke zdroja
 * (`distanceToModule`), pri zhode menšie id. Vozidlo bez cesty k zdroju job nedostane; job bez vozidla ostáva `open`.
 * Priradenie: `job.assign`, `vehicle.jobId`, `JobAssigned` a jazda k zdroju (`startTrip`: `idle → to_pickup` +
 * `VehicleStateChanged` a trasa; pohyb v kroku 6 toho istého ticku, ADR-019).
 *
 * Hot path: žiadne `filter`/`map`/closures v cykle; aprony sa čítajú cez `CargoLedger.countAt`/`unitAtIndex` bez kópie,
 * sklady cez skupiny `StoredCargoIndex` a mapy sveta sa prechádzajú v poradí id; voľné vozidlá, rampy a outbound skupiny
 * sa zbierajú raz za tick do znovupoužiteľných polí. Alokuje sa len nový job (jeho zoznam jednotiek a lokácie).
 */
import { slotOf } from '../cargo/cargo-location';
import { CONTRACT_STATE_TRAITS, type ContractOutbound } from '../contracts/contract-fsm';
import type { EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import { BerthModule } from '../modules/berth-module';
import type { LoadingRamp } from '../modules/loading-ramp';
import { StorageModule } from '../modules/storage-module';
import type { Vehicle } from '../vehicles/vehicle';
import { startTrip } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';
import { JobError } from './job-error';
import { distanceBetweenModules, distanceToModule } from './module-access';
import { allocateRamp } from './ramp-allocator';
import { allocateStorage } from './storage-allocator';
import type { StoredCargoGroup } from './stored-cargo-index';
import { JOB_PRIORITY_LEVELS, TransportJob, type JobCancelReason } from './transport-job';

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
    openJob(world, { unitIds: [unit.id], from: unit.location, to: { kind: 'in_storage', moduleId: storage.id, slot } });
  }
  if (missingTypeId !== undefined) emitNoStorage(world, berth, missingTypeId);
}

/** Inbound (§7.3 bod 1): joby pre jednotky na apronoch všetkých kotvísk (viď hlavička súboru). */
export function createInboundJobs(world: World): void {
  for (const module of world.modules.values()) {
    if (module instanceof BerthModule) inboundFromBerth(world, module);
  }
}

/** Vytvorí job `open` s už rezervovaným miestom v cieli, pridá ho do sveta a ohlási `JobCreated`. */
function openJob(world: World, init: Pick<TransportJob, 'unitIds' | 'from' | 'to'>): void {
  const job = new TransportJob({ id: world.ids.next(), unitIds: init.unitIds, from: init.from, to: init.to, createdTick: world.clock.tick });
  world.addJob(job);
  world.events.emit({ type: 'JobCreated', jobId: job.id, unitIds: job.unitIds, fromModuleId: job.fromModuleId, toModuleId: job.toModuleId });
}

/**
 * Rampy, ktoré môžu v tomto ticku dostať outbound job (prevádzkové s voľným staging miestom; kategóriu overí
 * `allocateRamp`), vzostupne podľa id do znovupoužiteľného poľa `into` (najprv ho vyprázdni) — raz za tick.
 */
function collectOutboundRamps(world: World, into: LoadingRamp[]): void {
  into.length = 0;
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.freeCount > 0 && world.isRampOperational(ramp)) into.push(ramp);
  }
}

/** Outbound skupiny uskladneného nákladu (`StoredCargoIndex`): kontrakt jednotiek, alebo bez kontraktu → `free`. */
function outboundOf(world: World, group: StoredCargoGroup): ContractOutbound {
  if (group.contractId === null) return 'free';
  const contract = world.contractBook.get(group.contractId);
  // Kontrakt mimo knihy obnova save odmietne; náklad by inak navždy zaberal sklad.
  return contract === undefined ? 'free' : CONTRACT_STATE_TRAITS[contract.state].outbound;
}

/** Termín kontraktu skupiny (`slaDeadlineTick`), bez neho `Infinity`. */
function deadlineOf(world: World, group: StoredCargoGroup): number {
  return group.contractId === null ? Infinity : (world.contractBook.get(group.contractId)?.slaDeadlineTick ?? Infinity);
}

/**
 * Má skupina `a` prednosť pred `b` (obe smú na rampu)? `sla` pred `free`; v `sla` menší `slaDeadlineTick`, potom menšie
 * id kontraktu; vo `free` menšie id kontraktu a jednotky bez kontraktu na koniec (rozhodnutie 9, ADR-027). Kľúče sú
 * rôzne pre rôzne skupiny, takže poradie nezávisí od poradia indexu (obnova save).
 */
function precedes(world: World, a: StoredCargoGroup, b: StoredCargoGroup): boolean {
  const outboundA = outboundOf(world, a);
  const outboundB = outboundOf(world, b);
  if (outboundA !== outboundB) return outboundA === 'sla';
  if (a.contractId === null) return false;
  if (b.contractId === null) return true;
  if (outboundA === 'sla') {
    const deadlineA = deadlineOf(world, a);
    const deadlineB = deadlineOf(world, b);
    if (deadlineA !== deadlineB) return deadlineA < deadlineB;
  }
  return a.contractId < b.contractId;
}

/**
 * Skupiny uskladneného nákladu, ktoré smú na rampu (`ContractOutbound` ≠ `held`), v poradí priority do
 * znovupoužiteľného poľa `into` (najprv ho vyprázdni) — raz za tick, len pri voľnom staging mieste. Skupín je toľko,
 * koľko kontraktov má niečo v sklade (+ jednotky bez kontraktu), preto stačí triedenie vkladaním bez alokácie.
 */
function collectOutboundGroups(world: World, into: StoredCargoGroup[]): void {
  into.length = 0;
  for (const group of world.storedCargo.entries) {
    if (outboundOf(world, group) === 'held') continue;
    into.push(group);
    for (let i = into.length - 1; i > 0 && precedes(world, into[i], into[i - 1]); i--) {
      const swap = into[i];
      into[i] = into[i - 1];
      into[i - 1] = swap;
    }
  }
}

/** Najbližšia vhodná rampa z `ramps` pre sklad `storageId` (`allocateRamp`), alebo `undefined`. */
function rampForStorage(world: World, storageId: EntityId, ramps: readonly LoadingRamp[]): LoadingRamp | undefined {
  const storage = world.modules.get(storageId);
  return storage instanceof StorageModule ? allocateRamp(world, storage, storage.category, ramps) : undefined;
}

/**
 * Joby pre jednotky jednej skupiny (sklad ↑, FIFO), ktoré ešte job nemajú, k najbližšej vhodnej rampe z `ramps` pre ich
 * sklad. Plná rampa z `ramps` vypadne a hľadá sa ďalšia; jednotky skladu, pre ktorý rampa nie je, sa preskočia.
 * Vráti `false`, keď `ramps` ostalo prázdne (ďalšie skupiny už job nedostanú).
 */
function outboundFromGroup(world: World, group: StoredCargoGroup, ramps: LoadingRamp[]): boolean {
  let storageId: EntityId | undefined;
  let ramp: LoadingRamp | undefined;
  for (let i = 0; i < group.units.length; i++) {
    const unitStorage = group.storages[i];
    if (unitStorage !== storageId) {
      storageId = unitStorage;
      ramp = rampForStorage(world, unitStorage, ramps);
    }
    if (ramp === undefined) continue;
    const unit = world.cargo.get(group.units[i]);
    if (unit === undefined || world.jobOfUnit(unit.id) !== undefined) continue;
    const dock = ramp.firstFreeDock();
    ramp.reserve(dock);
    openJob(world, { unitIds: [unit.id], from: unit.location, to: { kind: 'at_ramp', rampId: ramp.id, dock } });
    if (ramp.freeCount > 0) continue;
    ramps.splice(ramps.indexOf(ramp), 1);
    if (ramps.length === 0) return false;
    ramp = rampForStorage(world, unitStorage, ramps);
  }
  return true;
}

/**
 * Outbound (§7.3 bod 2, ADR-023, ADR-027): joby pre uskladnené jednotky, ktoré smú na rampu, v poradí priority skupín
 * (viď hlavička súboru). `ramps` a `groups` sú znovupoužiteľné polia `DispatcherSystem` (bez nich nové).
 */
export function createOutboundJobs(world: World, ramps: LoadingRamp[] = [], groups: StoredCargoGroup[] = []): void {
  collectOutboundRamps(world, ramps);
  if (ramps.length === 0) return;
  collectOutboundGroups(world, groups);
  for (const group of groups) {
    if (!outboundFromGroup(world, group, ramps)) return;
  }
}

/**
 * Prečo by `open` outbound job už nevznikol (viď hlavička súboru), alebo `undefined`, ak je jeho rampa stále
 * použiteľná. Job s iným cieľom než rampa → `undefined` (inbound sa takto neruší).
 */
function outboundCancelReason(world: World, job: TransportJob): JobCancelReason | undefined {
  if (job.to.kind !== 'at_ramp') return undefined;
  const ramp = world.modules.get(job.toModuleId);
  const source = world.modules.get(job.fromModuleId);
  if (ramp === undefined || source === undefined) return undefined;
  if (!world.isRampOperational(ramp)) return 'ramp_inoperative';
  return distanceBetweenModules(world, source, ramp) === Infinity ? 'ramp_unreachable' : undefined;
}

/**
 * Zruší job bez vozidla: uvoľní rezerváciu v cieli (jedna na jednotku jobu, `cargoDropTarget().release`), `open →
 * cancelled`, `World.removeJob` a `JobCancelled`. Cieľ bez `cargoDropTarget` → `JobError('invalid_input')` (svet je
 * nekonzistentný), job sa nezmení.
 */
function cancelJob(world: World, job: TransportJob, reason: JobCancelReason): void {
  const target = world.modules.get(job.toModuleId)?.cargoDropTarget();
  const place = slotOf(job.to);
  if (target === undefined || target.kind !== job.to.kind || place === null) {
    throw new JobError('invalid_input', `${job.label}: cieľ #${String(job.toModuleId)} nemá miesto '${job.to.kind}' na uvoľnenie`);
  }
  for (let i = 0; i < job.unitIds.length; i++) target.release(place);
  job.transition('cancelled');
  world.removeJob(job.id);
  world.events.emit({ type: 'JobCancelled', jobId: job.id, reason });
}

/**
 * Zrušenie (ADR-023): `open` outbound joby, ktorých rampa stratila prevádzkovosť alebo k nej zo skladu nevedie cesta
 * (viď hlavička súboru), v poradí vzniku. Joby s vozidlom sa nerušia.
 */
export function cancelUnusableOutboundJobs(world: World): void {
  for (const job of world.jobs.values()) {
    if (job.state !== 'open') continue;
    const reason = outboundCancelReason(world, job);
    if (reason !== undefined) cancelJob(world, job, reason);
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
      if (job.state !== 'open' || job.priority !== priority) continue;
      const vehicle = pickVehicle(world, job, idle);
      if (vehicle === undefined) continue;
      assign(world, job, vehicle);
      idle.splice(idle.indexOf(vehicle), 1);
    }
  }
}
