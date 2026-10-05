/**
 * Dispatcher (ARCHITECTURE §6 krok 5, §7.3 body 1–3; rozhodnutie orchestrátora F3 č. 6, F4 č. 4 a F5 č. 9; ADR-018,
 * ADR-023, ADR-027) —
 * tvorba, zrušenie a priradenie jobov. `DispatcherSystem` (krok 5) volá v každom ticku `createInboundJobs` →
 * `createOutboundJobs` → `assignOpenJobs`; pred nimi `cancelUnusableOutboundJobs`, ale len keď ho pustí
 * `OutboundCancelGate` (po zmene ciest alebo modulov, T06-07 — viď „Hot path").
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
 * sa prechádza len cez jej jednotky s aktívnym outbound jobom (najviac toľko, koľko je staging miest) po prvú
 * jednotku, ktorá job dostane; sklad bez vhodnej rampy sa preskočí binárnym skokom na hranicu ďalšieho skladu skupiny. Pri samých jednotkách bez kontraktu je poradie
 * jobov rovnaké ako vo F4 (sklady ↑, FIFO).
 *
 * **Prijatie exportu** (F6a, ADR-032 bod 8): jednotka exportu, ktorú vyložil kamión s exportom na dock rampy (booking beží),
 * dostane sklad zoskupene podľa voyage a job `at_ramp → in_storage` (`createExportJobs`), priority ako outbound.
 *
 * **Vykládka z lode a nakládka** (F6c, ADR-034 + dodatok T6C-03): jednotka na aprone dostane sklad podľa smeru (`allocateUnloadStorage` — prekládka z lode A
 * zoskupene podľa kontraktu); jednotka na nakládku dokovanej lode (export, prázdne repositioningu, prekládka čakajúca na loď B) na aprone čaká na žeriav
 * (`awaitsCrane`), kým beží jej booking; joby nakládky vytvára `logistics/export-load.ts` (prázdne po plných jednotkách).
 *
 * **Prázdne kontajnery** (F6c, ADR-034 + dodatok T6C-02): prázdny z vnútrozemia vyložený na dock dostane job `at_ramp → in_storage` do depa
 * (fallback bežný sklad), kamión misie `collect` dostane job `in_storage → at_ramp` s dostupným prázdnym jeho linky (`createEmptyJobs`,
 * `logistics/empty-jobs.ts`). Job prázdneho **prednostne** dostane vozidlo, ktoré vozí smer `empty` (`cargoDirections`, empty handler),
 * inak bežné vozidlo (`pickVehicle`); empty handler nikdy nedostane job iného smeru (`vehicleCarries`).
 *
 * **Zrušenie nakládky** (T6C-07b, M2): keď sa nakládka bookingu zastaví (`loadingStopped`), jeho `open` joby nakládky bez vozidla sa zrušia (`loading_stopped`) a
 * booking dostane pridelenie späť (`Contract.releaseLoad`) — job, ku ktorému sa vozidlo nedostane, by inak držal loď a kotvisko (`logistics/export-load.ts`).
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
 * Hot path: zrušenie sa vyhodnocuje len po zmene ciest alebo modulov (`OutboundCancelGate`, T06-07); žiadne
 * `filter`/`map`/closures v cykle; aprony sa čítajú cez `CargoLedger.countAt`/`unitAtIndex` bez kópie,
 * sklady cez skupiny `StoredCargoIndex` a mapy sveta sa prechádzajú v poradí id; voľné vozidlá, rampy a outbound skupiny
 * sa zbierajú raz za tick do znovupoužiteľných polí. Alokuje sa len nový job (jeho zoznam jednotiek a lokácie).
 */
import { slotOf, type CargoLocation } from '../cargo/cargo-location';
import type { CargoDirection, CargoUnit } from '../cargo/cargo-unit';
import type { ContractOutbound } from '../contracts/contract-fsm';
import type { EntityId } from '../core/entity-id';
import type { CargoCategory } from '../defs/types';
import type { Contract } from '../contracts/contract';
import { BerthModule } from '../modules/berth-module';
import type { LoadingRamp } from '../modules/loading-ramp';
import { StorageModule } from '../modules/storage-module';
import type { Vehicle } from '../vehicles/vehicle';
import { VEHICLE_STATE_TRAITS, changeVehicleState } from '../vehicles/vehicle-fsm';
import { startTrip, tryLeaveDepot } from '../vehicles/vehicle-trip';
import type { World } from '../world/world';
import { JobError } from './job-error';
import { createEmptyIntakeJobs, createEmptyPickupJobs } from './empty-jobs';
import { createExportIntakeJobs } from './export-intake';
import { createExportLoadJobs as createLoadJobs, createHookUnloadJobs as createHookJobs, type LoadJobSpec } from './export-load';
import { distanceBetweenModules, distanceToModule } from './module-access';
import { allocateRamp, outboundRoom } from './ramp-allocator';
import type { StoredCargoGroup } from './stored-cargo-index';
import { JOB_PRIORITY_LEVELS, TransportJob, type JobCancelReason } from './transport-job';
import { allocateUnloadStorage } from './unload-storage';
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
    const storage = allocateUnloadStorage(world, berth, unit);
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

/**
 * Prijatie exportu (ADR-032 bod 8): joby `at_ramp → in_storage` pre jednotky exportu, ktoré práve vyložil kamión na dock
 * rampy, so zoskupením podľa voyage (`logistics/export-intake.ts`). Vracia počet vytvorených jobov.
 */
export function createExportJobs(world: World): number {
  return createExportIntakeJobs(world, ({ unitId, from, to }) => {
    openJob(world, { unitIds: [unitId], from, to });
  });
}

/**
 * Prázdne kontajnery (ADR-034): prijatie prázdnych z docku do depa a výdaj prázdneho kamiónu `collect` (`logistics/empty-jobs.ts`).
 * Vracia počet vytvorených jobov.
 */
export function createEmptyJobs(world: World): number {
  const open = ({ unitId, from, to }: { readonly unitId: EntityId; readonly from: CargoLocation; readonly to: CargoLocation }): void => {
    openJob(world, { unitIds: [unitId], from, to });
  };
  return createEmptyIntakeJobs(world, open) + createEmptyPickupJobs(world, open);
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
 * Rampy, ktoré môžu v tomto ticku dostať outbound job (prevádzkové s voľným staging miestom; kategóriu overí
 * `allocateRamp`), vzostupne podľa id do znovupoužiteľného poľa `into` (najprv ho vyprázdni) — raz za tick.
 */
function collectOutboundRamps(world: World, into: LoadingRamp[]): void {
  into.length = 0;
  for (const ramp of world.landsideModules.ramps) {
    if (outboundRoom(world, ramp) > 0 && world.isRampOperational(ramp)) into.push(ramp);
  }
}

/** Outbound skupiny uskladneného nákladu (`StoredCargoIndex`): kontrakt jednotiek, alebo bez kontraktu → `free`. */
function outboundOf(world: World, group: StoredCargoGroup): ContractOutbound {
  if (group.contractId === null) return 'free';
  const contract = world.contractBook.get(group.contractId);
  // Kontrakt mimo knihy obnova save odmietne; náklad by inak navždy zaberal sklad. Politiku určuje druh kontraktu
  // (`Contract.outbound`: import podľa stavu, export booking až po uzavretí — ADR-032).
  return contract === undefined ? 'free' : contract.outbound;
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
 * Prvý index `≥ from` v `storages` (neklesajúce id skladov skupiny), kde začína iný sklad ako `storageId` — binárne
 * vyhľadanie hranice skladu, bez prechodu jeho jednotiek.
 */
function nextStorageStart(storages: readonly EntityId[], from: number, storageId: EntityId): number {
  let low = from;
  let high = storages.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (storages[mid] <= storageId) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Joby pre jednotky jednej skupiny (sklad ↑, FIFO), ktoré ešte job nemajú, k najbližšej vhodnej rampe z `ramps` pre ich
 * sklad. Plná rampa z `ramps` vypadne a hľadá sa ďalšia; sklad, pre ktorý rampa nie je, sa preskočí celý (skok na
 * hranicu ďalšieho skladu v skupine, `nextStorageStart`). Vráti `false`, keď `ramps` ostalo prázdne (ďalšie skupiny už
 * job nedostanú).
 */
function outboundFromGroup(world: World, group: StoredCargoGroup, ramps: LoadingRamp[]): boolean {
  let storageId: EntityId | undefined;
  let ramp: LoadingRamp | undefined;
  let i = 0;
  while (i < group.units.length) {
    const unitStorage = group.storages[i];
    if (unitStorage !== storageId) {
      storageId = unitStorage;
      ramp = rampForStorage(world, unitStorage, ramps);
    }
    if (ramp === undefined) {
      i = nextStorageStart(group.storages, i, unitStorage);
      continue;
    }
    const index = i;
    i += 1;
    const unit = world.cargo.get(group.units[index]);
    if (unit === undefined || world.jobOfUnit(unit.id) !== undefined) continue;
    const dock = world.dockIntake.firstRoomDock(ramp);
    ramp.reserve(dock);
    openJob(world, { unitIds: [unit.id], from: unit.location, to: { kind: 'at_ramp', rampId: ramp.id, dock } });
    if (outboundRoom(world, ramp) > 0) continue;
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
 * Uvoľní rezerváciu cieľa jobu bez vozidla (jedna na jednotku jobu, `cargoDropTarget().release`). Hák žeriava (`in_crane`, nakládka pod hákom,
 * ADR-033) nič nerezervuje — nie je čo uvoľniť. Cieľ bez `cargoDropTarget` → `JobError('invalid_input')` (svet je nekonzistentný).
 */
function releaseTarget(world: World, job: TransportJob): void {
  if (job.to.kind === 'in_crane') return;
  const target = world.modules.get(job.toModuleId)?.cargoDropTarget();
  const place = slotOf(job.to);
  if (target === undefined || target.kind !== job.to.kind || place === null) {
    throw new JobError('invalid_input', `${job.label}: cieľ #${String(job.toModuleId)} nemá miesto '${job.to.kind}' na uvoľnenie`);
  }
  for (let i = 0; i < job.unitIds.length; i++) target.release(place);
}

/**
 * Zruší job bez vozidla: uvoľní rezerváciu v cieli (`releaseTarget`), `open → cancelled`, `World.removeJob` a `JobCancelled`. Cieľ bez
 * `cargoDropTarget` → `JobError('invalid_input')` (svet je nekonzistentný), job sa nezmení.
 */
function cancelJob(world: World, job: TransportJob, reason: JobCancelReason): void {
  releaseTarget(world, job);
  job.transition('cancelled');
  world.removeJob(job.id);
  world.events.emit({ type: 'JobCancelled', jobId: job.id, reason });
}

/** Verzie siete, od ktorých závisí zrušenie open outbound jobov (`World` ich spĺňa). */
export interface NetworkVersions {
  readonly roadVersion: number;
  readonly moduleVersion: number;
}

/**
 * Brána kontroly zrušenia (T06-07, BACKLOG P2 „cache prevádzkovosti rampy"): dôvody zrušenia (`ramp_inoperative`,
 * `ramp_unreachable`) závisia len od ciest a modulov — prevádzkovosť rampy aj cena cesty sú memo podľa `roadVersion`
 * a `moduleVersion` — a open outbound job vzniká len pri prevádzkovej a dosiahnuteľnej rampe. Kým sa verzie nezmenia,
 * žiadny open job zrušiť netreba a prechod jobmi sa vynechá. Nie je stav simulácie (nový aj obnovený svet začína
 * kontrolou v prvom ticku).
 */
export class OutboundCancelGate {
  private roadVersion = Number.NaN;
  private moduleVersion = Number.NaN;

  /** `true`, keď sa od poslednej kontroly zmenili cesty alebo moduly (prvé volanie vždy); aktuálne verzie si zapamätá. */
  due(world: NetworkVersions): boolean {
    const { roadVersion, moduleVersion } = world;
    if (roadVersion === this.roadVersion && moduleVersion === this.moduleVersion) return false;
    this.roadVersion = roadVersion;
    this.moduleVersion = moduleVersion;
    return true;
  }
}

/**
 * Zrušenie (ADR-023): `open` outbound joby, ktorých rampa stratila prevádzkovosť alebo k nej zo skladu nevedie cesta
 * (viď hlavička súboru), v poradí vzniku. Joby s vozidlom sa nerušia. `DispatcherSystem` ho volá len po zmene ciest
 * alebo modulov (`OutboundCancelGate`).
 */
export function cancelUnusableOutboundJobs(world: World): void {
  for (const job of world.jobs.values()) {
    if (job.state !== 'open') continue;
    const reason = outboundCancelReason(world, job);
    if (reason !== undefined) cancelJob(world, job, reason);
  }
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
  let best: Vehicle | undefined;
  let bestPreference = Infinity;
  let bestCost = Infinity;
  for (const vehicle of candidates) {
    if (!VEHICLE_STATE_TRAITS[vehicle.state].free || !vehicleCarries(vehicle, category, direction)) continue;
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

/** Priradí job vozidlu a pošle ho k zdroju (viď hlavička súboru). */
function assign(world: World, job: TransportJob, vehicle: Vehicle): void {
  job.assign(vehicle.id);
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
      if (job.state !== 'open' || job.priority !== priority) continue;
      const vehicle = pickVehicle(world, job, idle);
      if (vehicle === undefined) continue;
      assign(world, job, vehicle);
      idle.splice(idle.indexOf(vehicle), 1);
    }
  }
}
