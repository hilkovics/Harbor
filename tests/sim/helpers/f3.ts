/**
 * Pomocníci scenárových testov fázy 3 (T03-07, TDD): záznam behu s vozidlami a jobmi, audit ledgera po celej
 * reťazi `on_ship → in_crane → on_apron → in_vehicle → in_storage`, audit jobov a syntetické defy.
 *
 * Prečo nie `recordRun` z `harbor.ts`: jeho `auditLedger` výslovne zakazuje jednotky `in_vehicle`/`in_storage`
 * (F2 nemá vozidlá), takže by pri prvej prevezenej jednotke zlyhal. Tento súbor je jeho F3 náprotivok — rovnaký
 * štýl (udalosti s tickom, vzorky po každom ticku, `assertCargoConservation` + nezávislý audit po KAŽDOM ticku),
 * F2 helper ostáva nedotknutý.
 *
 * Všetko ide len cez verejné API simu (`World`, `world.vehicles`, `world.jobs`, `world.modules`, `world.cargo`,
 * udalosti) — píše sa proti rozhraniu z `docs/tasks/phase-03.md` „Spoločné rozhrania", ešte pred T03-02..T03-06.
 */
import { APRON_MODULES as modulesJson } from './apron-modules';
import vehiclesJson from '@data/defs/vehicles.json';
import type { CargoLocation, CargoLocationKind } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { DefRegistry, berthParams, storageParams } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord, Grid } from '@sim/grid';
import type { JobState, TransportJob } from '@sim/logistics';
import { SIDE_STEPS, connectorsOf, type BerthModule, type Module, type StorageModule, type VehicleDepot } from '@sim/modules';
import type { Vehicle, VehicleState } from '@sim/vehicles';
import { World, type WorldState } from '@sim/world';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';
import { DEPOT_ENTITY_ID } from './f3-layout';
import { cranesOf, type TimedEvent } from './harbor';
import { assertCargoConservation } from './invariants';
import { runScenario, type Scenario } from './scenario';

/** Tolerancia float porovnaní polohy a rýchlosti vozidla. */
export const EPSILON = 1e-6;

/** Tolerancia ±1 tick pri trvaniach (karta nechá otvorené, či sa tick zmeny stavu počíta do fázy). */
export const SLACK_TICKS = 1;

// ---------------------------------------------------------------------------------------------------------
// Prístup k vozidlám, jobom a skladom (s jasnou hláškou, keď implementácia ešte chýba)
// ---------------------------------------------------------------------------------------------------------

/** `world.vehicles` (T03-04); chýbajúce API = zrozumiteľná chyba namiesto `TypeError` o `undefined`. */
export function vehiclesOf(world: World): ReadonlyMap<EntityId, Vehicle> {
  const vehicles: ReadonlyMap<EntityId, Vehicle> | undefined = world.vehicles;
  if (vehicles === undefined) throw new Error('chýba API: world.vehicles (T03-04: Vehicle + World.vehicles)');
  return vehicles;
}

/** `world.jobs` (T03-05); chýbajúce API = zrozumiteľná chyba namiesto `TypeError` o `undefined`. */
export function jobsOf(world: World): ReadonlyMap<EntityId, TransportJob> {
  const jobs: ReadonlyMap<EntityId, TransportJob> | undefined = world.jobs;
  if (jobs === undefined) throw new Error('chýba API: world.jobs (T03-05: TransportJob + World.jobs)');
  return jobs;
}

export function storageModulesOf(world: World): StorageModule[] {
  return [...world.modules.values()].filter((module): module is StorageModule => module.kind === 'storage');
}

/** Sklad, ktorého footprint zaberá bunku `origin`; inak chyba s vysvetlením. */
export function storageAt(world: World, origin: CellCoord): StorageModule {
  const id = world.grid.at(origin.x, origin.y).moduleId;
  const module = id === null ? undefined : world.modules.get(id);
  if (module?.kind !== 'storage') {
    throw new Error(`na bunke (${String(origin.x)}, ${String(origin.y)}) nestojí sklad (modul: ${module?.label ?? 'žiadny'})`);
  }
  return module as StorageModule;
}

/** Depo scenárov f3 (id `DEPOT_ID`, prvý `PlaceModule`); inak chyba s vysvetlením. */
export function depotOf(world: World): VehicleDepot {
  const module = world.modules.get(DEPOT_ENTITY_ID);
  if (module?.kind !== 'depot') throw new Error(`modul ${String(DEPOT_ENTITY_ID)} nie je depo (modul: ${module?.label ?? 'žiadny'})`);
  return module as VehicleDepot;
}

/** Kapacita skladu podľa defu (nie podľa implementácie `StorageModule`). */
export function storageCapacity(module: Module): number {
  return storageParams(module.def).capacityUnits;
}

/** Bunka, na ktorej vozidlo (float poloha, stred bunky = x + 0,5) práve stojí. */
export function cellOfPosition(x: number, y: number): CellCoord {
  return { x: Math.floor(x), y: Math.floor(y) };
}

export const sameCell = (a: CellCoord, b: CellCoord): boolean => a.x === b.x && a.y === b.y;

/** Vozidlá v poradí id. */
export function vehiclesById(world: World): Vehicle[] {
  return [...vehiclesOf(world).values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------------------------------------
// Tabuľky FSM (karta T03-06, rozhodnutie orchestrátora 7)
// ---------------------------------------------------------------------------------------------------------

/**
 * Povolené prechody vozidla: `idle → to_pickup → loading → to_dropoff → unloading → idle`, `to_* ↔ no_path`.
 * Z `no_path` sa vozidlo vracia do toho `to_*`, z ktorého vypadlo (kontroluje `vehicleFsmViolation`).
 */
export const VEHICLE_TRANSITIONS: Readonly<Record<VehicleState, readonly VehicleState[]>> = {
  idle: ['to_pickup'],
  to_pickup: ['loading', 'no_path'],
  loading: ['to_dropoff'],
  to_dropoff: ['unloading', 'no_path'],
  unloading: ['idle'],
  no_path: ['to_pickup', 'to_dropoff'],
};

/** Stavy, v ktorých má vozidlo pohyb po ceste (bez cesty by nemalo byť). */
export const MOVING_STATES: readonly VehicleState[] = ['to_pickup', 'to_dropoff'];

/**
 * Poradie stavov jobu; stav smie len rásť (preskočiť možno, vzorka po ticku nemusí zachytiť krátky stav). `cancelled`
 * (T04-03, ADR-023) je konečný ako `done` a dosiahne sa len z `open`; vo F3 nenastane.
 */
export const JOB_STATE_RANK: Readonly<Record<JobState, number>> = {
  open: 0,
  assigned: 1,
  picking: 2,
  moving: 3,
  dropping: 4,
  done: 5,
  cancelled: 5,
};

/**
 * Overí prúd `VehicleStateChanged` podľa `VEHICLE_TRANSITIONS`: každá udalosť je povolený prechod, `from` nadväzuje
 * na `to` predošlej udalosti toho istého vozidla, prvá začína v `initial` stave (predvolene `idle`, teda log od začiatku
 * hry; pri logu od stredu behu sa odovzdá `vehicleStates(world)` z okamihu štartu logu) a z `no_path` sa vozidlo vráti
 * do stavu, z ktorého vypadlo. Vráti dôvod porušenia alebo `null`.
 */
export function vehicleFsmViolation(events: readonly TimedEvent[], initial: ReadonlyMap<EntityId, VehicleState> = new Map()): string | null {
  const last = new Map<number, VehicleState>(initial);
  const beforeNoPath = new Map<number, VehicleState>();
  for (const { tick, event } of events) {
    if (event.type !== 'VehicleStateChanged') continue;
    const { vehicleId, from, to } = event;
    const where = `vozidlo ${String(vehicleId)}, tick ${String(tick)}: ${from} → ${to}`;
    if (!VEHICLE_TRANSITIONS[from].includes(to)) return `${where} nie je povolený prechod`;
    const previous = last.get(vehicleId) ?? 'idle';
    if (from !== previous) return `${where}: predošlý stav vozidla bol ${previous}, nie ${from}`;
    if (to === 'no_path') beforeNoPath.set(vehicleId, from);
    const expectedResume = beforeNoPath.get(vehicleId);
    if (from === 'no_path' && expectedResume !== undefined && expectedResume !== to) {
      return `${where}: vozidlo vypadlo z ${expectedResume} a malo sa vrátiť tam`;
    }
    last.set(vehicleId, to);
  }
  return null;
}

/** Stavy všetkých vozidiel teraz (počiatok logu od stredu behu pre `vehicleFsmViolation`). */
export function vehicleStates(world: World): Map<EntityId, VehicleState> {
  return new Map([...vehiclesOf(world).values()].map((vehicle): [EntityId, VehicleState] => [vehicle.id, vehicle.state]));
}

// ---------------------------------------------------------------------------------------------------------
// Záznam behu
// ---------------------------------------------------------------------------------------------------------

/** Stav vozidla na konci jedného ticku. */
export interface VehicleSample {
  readonly tick: number;
  readonly vehicleId: EntityId;
  readonly defId: string;
  readonly state: VehicleState;
  readonly x: number;
  readonly y: number;
  readonly jobId: EntityId | null;
  /** Počet jednotiek `in_vehicle` u tohto vozidla podľa ledgera. */
  readonly unitsInside: number;
}

/** Životopis jobu: zmrazené polia z prvého ticku, v ktorom bol vo `world.jobs`, a jeho stavy za sebou. */
export interface JobTrace {
  readonly jobId: EntityId;
  readonly unitIds: readonly EntityId[];
  readonly from: CargoLocation;
  readonly to: CargoLocation;
  readonly fromModuleId: EntityId;
  readonly toModuleId: EntityId;
  readonly createdTick: number;
  readonly firstSeenTick: number;
  /** Stavy bez opakovaní (`open, assigned, …`). */
  readonly states: JobState[];
  /** Rôzne vozidlá, ktoré job malo, v poradí priradenia. */
  readonly vehicleIds: EntityId[];
}

/** Pravidlo fyziky vozidla: mimo mapy, mimo cesty, príliš veľký krok (teleport), stojí v `to_*` bez pohybu. */
export type ViolationRule = 'out_of_map' | 'off_road' | 'teleport' | 'stuck';

export interface Violation {
  readonly rule: ViolationRule;
  readonly message: string;
}

export interface RunLog3 {
  /** Všetky udalosti v poradí vzniku, s tickom a hodinou. */
  readonly events: readonly TimedEvent[];
  /** Vzorky každého vozidla po každom ticku, kým existovalo. */
  readonly vehicles: ReadonlyMap<EntityId, readonly VehicleSample[]>;
  /** Joby podľa id (zo vzoriek `world.jobs` po každom ticku). */
  readonly jobs: ReadonlyMap<EntityId, JobTrace>;
  /**
   * Porušenia fyzických pravidiel vozidiel po jednotlivých tickoch (poloha mimo cesty, príliš veľký krok, stojí
   * v `to_*` bez pohybu). Prázdne = OK; každý test si ich overí zvlášť (`violationsOf`), aby chyba pomenovala pravidlo.
   */
  readonly violations: readonly Violation[];
  /** Počet tickov, po ktorých bežali invarianty (ledger + joby). */
  readonly ticksChecked: number;
}

export interface RunOptions3 {
  /** Voliteľný hák po každom ticku (po invariantoch a vzorkách). */
  readonly onTick?: (world: World, events: readonly SimEvent[]) => void;
}

/**
 * Prehrá scenár po absolútny tick `untilTick` a zaznamená udalosti, vzorky vozidiel a životopisy jobov. Po **každom**
 * ticku volá `assertCargoConservation(world)` (CLAUDE.md, pravidlo 2), nezávislý `auditLedgerF3` a `auditJobs`.
 */
export function recordRunF3(world: World, scenario: Scenario, untilTick: number, options: RunOptions3 = {}): RunLog3 {
  const events: TimedEvent[] = [];
  const vehicles = new Map<EntityId, VehicleSample[]>();
  const jobs = new Map<EntityId, JobTrace>();
  const violations: Violation[] = [];
  let ticksChecked = 0;

  runScenario(world, scenario, untilTick, {
    afterTick: (w, tickEvents) => {
      auditWorld(w);
      ticksChecked += 1;

      for (const event of tickEvents) events.push({ tick: w.clock.tick, hour: w.clock.gameHour, event });

      for (const vehicle of vehiclesOf(w).values()) {
        const list = vehicles.get(vehicle.id) ?? [];
        const sample = sampleVehicle(w, vehicle);
        const previous = list.at(-1);
        violations.push(...vehicleViolations(w, vehicle, sample, previous));
        list.push(sample);
        vehicles.set(vehicle.id, list);
      }
      for (const job of jobsOf(w).values()) traceJob(jobs, job, w.clock.tick);

      options.onTick?.(w, tickEvents);
    },
  });
  return { events, vehicles, jobs, violations, ticksChecked };
}

/**
 * Behá po jednom ticku, kým `predicate(world)` nie je splnený (kontrola pred každým tickom vrátane prvého);
 * nesplnenie do `maxTicks` je chyba. Invarianty ako `recordRunF3`.
 */
export function runUntilF3(world: World, scenario: Scenario, predicate: (world: World) => boolean, maxTicks: number): void {
  const limit = world.clock.tick + maxTicks;
  while (!predicate(world)) {
    if (world.clock.tick >= limit) throw new Error(`runUntilF3: podmienka nenastala do ${String(maxTicks)} tickov (tick ${String(world.clock.tick)})`);
    runScenario(world, scenario, world.clock.tick + 1, { afterTick: (w) => auditWorld(w) });
  }
}

function auditWorld(world: World): void {
  assertCargoConservation(world);
  auditLedgerF3(world);
  auditJobs(world);
}

function sampleVehicle(world: World, vehicle: Vehicle): VehicleSample {
  return {
    tick: world.clock.tick,
    vehicleId: vehicle.id,
    defId: vehicle.defId,
    state: vehicle.state,
    x: vehicle.x,
    y: vehicle.y,
    jobId: vehicle.jobId,
    unitsInside: world.cargo.countAt('in_vehicle', vehicle.id),
  };
}

/**
 * Fyzické pravidlá vozidla po jednom ticku (rozhodnutie orchestrátora 1 a 7, „nič sa neteleportuje"):
 * 1. stojí na bunke s cestou (aj v `idle`/`loading`/`unloading` — vonkajšia bunka konektora),
 * 2. za tick sa posunie najviac o `speedCellsPerTick` (Manhattan; zákruta v strede bunky prenáša zvyšok kroku),
 * 3. vozidlo v `to_pickup`/`to_dropoff` sa v ďalšom ticku pohne alebo zmení stav (žiadne `to_*` bez cesty/pohybu); čaká len na voľný
 *    slot dopravy bez prekrývania (`blockedTicks > 0`, ADR-037).
 */
function vehicleViolations(world: World, vehicle: Vehicle, sample: VehicleSample, previous: VehicleSample | undefined): Violation[] {
  const found: Violation[] = [];
  const where = `vozidlo ${String(vehicle.id)}, tick ${String(sample.tick)}, stav ${sample.state}, poloha (${String(sample.x)}, ${String(sample.y)})`;
  const cell = cellOfPosition(sample.x, sample.y);
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !world.grid.inBounds(cell.x, cell.y)) {
    found.push({ rule: 'out_of_map', message: `${where}: poloha mimo mapy` });
    return found;
  }
  if (world.grid.at(cell.x, cell.y).road !== 'road') {
    found.push({ rule: 'off_road', message: `${where}: bunka (${String(cell.x)}, ${String(cell.y)}) nemá cestu` });
  }

  if (previous !== undefined && previous.tick === sample.tick - 1) {
    const step = Math.abs(sample.x - previous.x) + Math.abs(sample.y - previous.y);
    const speed = vehicle.def.speedCellsPerTick;
    if (step > speed + EPSILON) {
      found.push({ rule: 'teleport', message: `${where}: krok ${String(step)} > speedCellsPerTick ${String(speed)} (teleportácia)` });
    }
    const stuck = step <= EPSILON && sample.state === previous.state && MOVING_STATES.includes(sample.state) && vehicle.blockedTicks === 0;
    if (stuck) found.push({ rule: 'stuck', message: `${where}: stojí v stave ${sample.state} bez pohybu (to_* bez platnej cesty)` });
  }
  return found;
}

/** Správy porušení jedného pravidla (prázdne pole = pravidlo držalo po každom ticku). */
export function violationsOf(log: RunLog3, rule: ViolationRule): string[] {
  return log.violations.filter((violation) => violation.rule === rule).map((violation) => violation.message);
}

function traceJob(jobs: Map<EntityId, JobTrace>, job: TransportJob, tick: number): void {
  let trace = jobs.get(job.id);
  if (trace === undefined) {
    trace = {
      jobId: job.id,
      unitIds: [...job.unitIds],
      from: job.from,
      to: job.to,
      fromModuleId: job.fromModuleId,
      toModuleId: job.toModuleId,
      createdTick: job.createdTick,
      firstSeenTick: tick,
      states: [],
      vehicleIds: [],
    };
    jobs.set(job.id, trace);
  }
  if (trace.states.at(-1) !== job.state) trace.states.push(job.state);
  if (job.vehicleId !== null && !trace.vehicleIds.includes(job.vehicleId)) trace.vehicleIds.push(job.vehicleId);
}

/** Vráti dôvod porušenia poradia stavov jobu (stav smie len rásť), alebo `null`. */
export function jobStateViolation(states: readonly JobState[]): string | null {
  for (let i = 1; i < states.length; i++) {
    if (JOB_STATE_RANK[states[i]] <= JOB_STATE_RANK[states[i - 1]]) return `neplatný prechod ${states[i - 1]} → ${states[i]} (${states.join(' → ')})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Audit ledgera nezávislý od implementácie `assertConservation()`
// ---------------------------------------------------------------------------------------------------------

/** Lokácie, ktoré vo F3 nesmie mať žiadna jednotka (potrubia, rampy, kamióny, vlaky a export prídu neskôr). */
const LOCATION_KINDS_AFTER_STORAGE = ['in_pipeline', 'at_ramp', 'in_truck', 'in_train', 'exported'] as const;

export interface LedgerAuditF3 {
  readonly onShip: number;
  readonly inCrane: number;
  readonly onApron: number;
  readonly inVehicle: number;
  readonly inStorage: number;
}

/**
 * Prejde loď po lodi, berth po berthe, vozidlo po vozidle a sklad po sklade cez `unitsOnShip` / `unitsOnApron` /
 * `unitsAt`, porovná s `cargo.get(id).location` a s počítadlami. Overuje: žiadna jednotka nie je v dvoch zoznamoch,
 * `location` zodpovedá zoznamu, sloty apronu a skladu sú jedinečné a v rozsahu podľa **defu**, vozidlo drží najviac
 * `capacityUnits`, držiteľ `in_vehicle`/`in_storage` existuje, `storedCount` skladu = ledger, `stored + reserved ≤
 * capacity`, `createdCount` = súčet všetkých jednotiek (nič nevzniklo ani nezmizlo) a nič nejde za sklad.
 */
export function auditLedgerF3(world: World): LedgerAuditF3 {
  const { cargo } = world;
  const owner = new Map<number, string>();
  const claim = (unitId: EntityId, where: string): void => {
    const previous = owner.get(unitId);
    if (previous !== undefined) throw new Error(`audit: jednotka ${String(unitId)} je naraz v '${previous}' aj v '${where}'`);
    owner.set(unitId, where);
  };
  const locationOf = (unitId: EntityId): CargoLocation | undefined => cargo.get(unitId)?.location;

  let onShip = 0;
  for (const ship of world.ships.values()) {
    for (const unitId of cargo.unitsOnShip(ship.id)) {
      claim(unitId, `on_ship(${String(ship.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'on_ship' || location.shipId !== ship.id) {
        throw new Error(`audit: jednotka ${String(unitId)} je v zozname lode ${String(ship.id)}, ale location = ${JSON.stringify(location)}`);
      }
      onShip += 1;
    }
  }

  let onApron = 0;
  for (const module of world.modules.values()) {
    if (module.kind !== 'berth') continue;
    const capacity = berthParams(module.def).apronSlots;
    const slots = new Set<number>();
    for (const unitId of cargo.unitsOnApron(module.id)) {
      claim(unitId, `on_apron(${String(module.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'on_apron' || location.berthId !== module.id) {
        throw new Error(`audit: jednotka ${String(unitId)} je na aprone ${String(module.id)}, ale location = ${JSON.stringify(location)}`);
      }
      if (!Number.isInteger(location.slot) || location.slot < 0 || location.slot >= capacity) {
        throw new Error(`audit: jednotka ${String(unitId)} má slot apronu ${String(location.slot)} mimo 0..${String(capacity - 1)}`);
      }
      if (slots.has(location.slot)) throw new Error(`audit: slot ${String(location.slot)} apronu ${String(module.id)} je obsadený dvakrát`);
      slots.add(location.slot);
      onApron += 1;
    }
  }

  let inVehicle = 0;
  for (const vehicle of vehiclesOf(world).values()) {
    const units = cargo.unitsAt('in_vehicle', vehicle.id);
    if (units.length > vehicle.def.capacityUnits) {
      throw new Error(`audit: vozidlo ${String(vehicle.id)} drží ${String(units.length)} jednotiek nad kapacitu ${String(vehicle.def.capacityUnits)}`);
    }
    for (const unitId of units) {
      claim(unitId, `in_vehicle(${String(vehicle.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'in_vehicle' || location.vehicleId !== vehicle.id) {
        throw new Error(`audit: jednotka ${String(unitId)} je v zozname vozidla ${String(vehicle.id)}, ale location = ${JSON.stringify(location)}`);
      }
      inVehicle += 1;
    }
  }

  let inStorage = 0;
  for (const module of storageModulesOf(world)) {
    const capacity = storageCapacity(module);
    const slots = new Set<number>();
    const units = cargo.unitsAt('in_storage', module.id);
    for (const unitId of units) {
      claim(unitId, `in_storage(${String(module.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'in_storage' || location.moduleId !== module.id) {
        throw new Error(`audit: jednotka ${String(unitId)} je v sklade ${String(module.id)}, ale location = ${JSON.stringify(location)}`);
      }
      if (!Number.isInteger(location.slot) || location.slot < 0 || location.slot >= capacity) {
        throw new Error(`audit: jednotka ${String(unitId)} má slot skladu ${String(location.slot)} mimo 0..${String(capacity - 1)}`);
      }
      if (slots.has(location.slot)) throw new Error(`audit: slot ${String(location.slot)} skladu ${String(module.id)} je obsadený dvakrát`);
      slots.add(location.slot);
      inStorage += 1;
    }
    if (module.storedCount !== units.length) {
      throw new Error(`audit: sklad ${String(module.id)}: storedCount = ${String(module.storedCount)}, ledger drží ${String(units.length)} jednotiek`);
    }
    if (module.storedCount + module.reservedCount > capacity) {
      throw new Error(
        `audit: sklad ${String(module.id)} má stored ${String(module.storedCount)} + reserved ${String(module.reservedCount)} nad kapacitu ${String(capacity)}`,
      );
    }
    if (module.freeCount !== capacity - module.storedCount - module.reservedCount) {
      throw new Error(`audit: sklad ${String(module.id)}: freeCount = ${String(module.freeCount)} ≠ capacity − stored − reserved`);
    }
  }

  const inCrane = cargo.countByKind('in_crane');
  if (inCrane > cranesOf(world).length) {
    throw new Error(`audit: ${String(inCrane)} jednotiek v žeriavoch, ale žeriavov je ${String(cranesOf(world).length)}`);
  }
  const counted: readonly (readonly [CargoLocationKind, number])[] = [
    ['on_ship', onShip],
    ['on_apron', onApron],
    ['in_vehicle', inVehicle],
    ['in_storage', inStorage],
  ];
  for (const [kind, expected] of counted) {
    if (cargo.countByKind(kind) !== expected) {
      throw new Error(`audit: countByKind('${kind}') = ${String(cargo.countByKind(kind))}, zoznamy držiteľov obsahujú ${String(expected)}`);
    }
  }
  for (const kind of LOCATION_KINDS_AFTER_STORAGE) {
    if (cargo.countByKind(kind) !== 0) throw new Error(`audit: vo F3 nemá byť žiadna jednotka '${kind}', je ich ${String(cargo.countByKind(kind))}`);
  }
  if (cargo.exportedCount !== 0) throw new Error(`audit: exportedCount = ${String(cargo.exportedCount)}, vo F3 sa nič neexportuje`);
  const total = onShip + inCrane + onApron + inVehicle + inStorage;
  if (cargo.createdCount !== total) {
    throw new Error(
      `audit: createdCount = ${String(cargo.createdCount)}, ale nájdených jednotiek ${String(total)} ` +
        `(loď ${String(onShip)}, žeriav ${String(inCrane)}, apron ${String(onApron)}, vozidlo ${String(inVehicle)}, sklad ${String(inStorage)}) — náklad vznikol alebo zmizol`,
    );
  }
  return { onShip, inCrane, onApron, inVehicle, inStorage };
}

// ---------------------------------------------------------------------------------------------------------
// Audit jobov (karta T03-05, „Invarianty")
// ---------------------------------------------------------------------------------------------------------

/**
 * Invarianty dispatchera po každom ticku: žiadna jednotka nemá 2 aktívne joby, vozidlo má najviac 1 job a
 * `vehicle.jobId` ↔ `job.vehicleId` sedí, `open` job nemá vozidlo, priradený job má existujúce vozidlo, zdroj jobu je
 * apron berthu a cieľ slot existujúceho skladu, počet jednotiek jobu ≤ kapacita vozidla a každý job
 * `open`/`assigned`/`picking` má v cieli rezervovaný slot (`reservedCount` ≥ počet takých jednotiek).
 */
export function auditJobs(world: World): void {
  const activeUnits = new Map<number, EntityId>();
  const jobOfVehicle = new Map<number, EntityId>();
  const reservedNeed = new Map<EntityId, number>();

  for (const job of jobsOf(world).values()) {
    if (job.state === 'done') continue;
    const label = `job ${String(job.id)} (${job.state})`;
    if (job.unitIds.length === 0) throw new Error(`audit: ${label} nemá žiadnu jednotku`);
    for (const unitId of job.unitIds) {
      const other = activeUnits.get(unitId);
      if (other !== undefined) throw new Error(`audit: jednotka ${String(unitId)} je v dvoch aktívnych jobach (${String(other)} a ${String(job.id)})`);
      activeUnits.set(unitId, job.id);
    }

    const source = world.modules.get(job.fromModuleId);
    if (source?.kind !== 'berth' || job.from.kind !== 'on_apron' || job.from.berthId !== job.fromModuleId) {
      throw new Error(`audit: ${label}: zdroj ${JSON.stringify(job.from)} / modul ${String(job.fromModuleId)} nie je apron berthu`);
    }
    const target = world.modules.get(job.toModuleId);
    if (target?.kind !== 'storage' || job.to.kind !== 'in_storage' || job.to.moduleId !== job.toModuleId) {
      throw new Error(`audit: ${label}: cieľ ${JSON.stringify(job.to)} / modul ${String(job.toModuleId)} nie je sklad`);
    }

    if (job.state === 'open') {
      if (job.vehicleId !== null) throw new Error(`audit: ${label} má vozidlo ${String(job.vehicleId)}, hoci je open`);
    } else {
      const vehicle = job.vehicleId === null ? undefined : vehiclesOf(world).get(job.vehicleId);
      if (vehicle === undefined) throw new Error(`audit: ${label} odkazuje na neexistujúce vozidlo ${String(job.vehicleId)}`);
      if (vehicle.jobId !== job.id) throw new Error(`audit: ${label}: vozidlo ${String(vehicle.id)} má jobId ${String(vehicle.jobId)}`);
      if (jobOfVehicle.has(vehicle.id)) throw new Error(`audit: vozidlo ${String(vehicle.id)} má dva aktívne joby (${String(jobOfVehicle.get(vehicle.id))} a ${String(job.id)})`);
      jobOfVehicle.set(vehicle.id, job.id);
      if (job.unitIds.length > vehicle.def.capacityUnits) {
        throw new Error(`audit: ${label} má ${String(job.unitIds.length)} jednotiek, vozidlo ${String(vehicle.id)} unesie ${String(vehicle.def.capacityUnits)}`);
      }
    }

    if (job.state === 'open' || job.state === 'assigned' || job.state === 'picking') {
      reservedNeed.set(job.toModuleId, (reservedNeed.get(job.toModuleId) ?? 0) + job.unitIds.length);
    }
  }

  for (const vehicle of vehiclesOf(world).values()) {
    if (vehicle.jobId === null) continue;
    const job = jobsOf(world).get(vehicle.jobId);
    if (job === undefined) throw new Error(`audit: vozidlo ${String(vehicle.id)} má jobId ${String(vehicle.jobId)}, ktorý vo world.jobs nie je`);
    if (job.state !== 'done' && job.vehicleId !== vehicle.id) {
      throw new Error(`audit: vozidlo ${String(vehicle.id)} má job ${String(job.id)}, ktorý patrí vozidlu ${String(job.vehicleId)}`);
    }
  }

  for (const [moduleId, need] of reservedNeed) {
    const module = world.modules.get(moduleId) as StorageModule;
    if (module.reservedCount < need) {
      throw new Error(`audit: sklad ${String(moduleId)} má reserved ${String(module.reservedCount)}, ale open/assigned/picking joby ho potrebujú ${String(need)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Udalosti a záznam
// ---------------------------------------------------------------------------------------------------------

export function timed3<T extends SimEvent['type']>(log: RunLog3, type: T): TimedEvent<Extract<SimEvent, { type: T }>>[] {
  return log.events.filter((entry): entry is TimedEvent<Extract<SimEvent, { type: T }>> => entry.event.type === type);
}

export function vehicleSamples(log: RunLog3, vehicleId: EntityId): readonly VehicleSample[] {
  const samples = log.vehicles.get(vehicleId);
  if (samples === undefined) throw new Error(`vozidlo ${String(vehicleId)} sa v behu nikdy neobjavilo vo world.vehicles`);
  return samples;
}

/** Vzorka vozidla v presnom ticku (po ticku), inak chyba. */
export function vehicleSampleAt(log: RunLog3, vehicleId: EntityId, tick: number): VehicleSample {
  const sample = vehicleSamples(log, vehicleId).find((entry) => entry.tick === tick);
  if (sample === undefined) throw new Error(`vozidlo ${String(vehicleId)} nemá vzorku v ticku ${String(tick)}`);
  return sample;
}

/** ID vozidiel z `VehicleBought` v poradí nákupu. */
export function boughtVehicleIds(log: RunLog3): EntityId[] {
  return timed3(log, 'VehicleBought').map((entry) => entry.event.vehicleId as EntityId);
}

/** Najväčší počet `NoStorageAvailable` na jeden berth v jednej hernej hodine (throttle ≤ 1× za hodinu). */
export function maxNoStoragePerBerthHour(events: readonly TimedEvent[]): number {
  const counts = new Map<string, number>();
  for (const entry of events) {
    const event = entry.event;
    if (event.type !== 'NoStorageAvailable') continue;
    const key = `${String(event.berthId)}:${String(entry.hour)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

/** Root berth (jediný berth na štarte mapy). */
export function rootBerthOf(world: World): BerthModule {
  const berth = [...world.modules.values()].find((module): module is BerthModule => module.kind === 'berth');
  if (berth === undefined) throw new Error('svet nemá žiadny berth (chýba starter modul?)');
  return berth;
}

// ---------------------------------------------------------------------------------------------------------
// Save/load a syntetické defy
// ---------------------------------------------------------------------------------------------------------

/** `deserialize(JSON.parse(JSON.stringify(serialize())))` — stav musí byť čistý JSON (žiadne Map/Set/triedy). */
export function restoreCopy(world: World, defs: DefRegistry = DEFS): World {
  const saved = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
  return World.deserialize(defs, MAP, saved);
}

/** Defy s upravenou kapacitou `container_yard_small` (ostatné hodnoty z data/defs). */
export function defsWithYardCapacity(capacityUnits: number): DefRegistry {
  const items = modulesJson.items.map((item) =>
    item.id === 'container_yard_small' ? { ...item, params: { ...item.params, capacityUnits } } : item,
  );
  return DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...modulesJson, items } });
}

/** Syntetické vozidlo s nekompatibilnou kategóriou (sypký náklad) — inak rovnaké ako `straddle_carrier`. */
export const BULK_VEHICLE_ID = 'flatbed_bulk';

/** Defy s pridaným vozidlom `flatbed_bulk` (kategória `bulk`, kontajnery nevezme). */
export function defsWithBulkVehicle(): DefRegistry {
  const bulk = { ...vehiclesJson.items[0], id: BULK_VEHICLE_ID, displayName: 'Flatbed (bulk)', cargoCategories: ['bulk'] };
  return DefRegistry.fromRaw({ ...RAW_DEFS, vehicles: { ...vehiclesJson, items: [...vehiclesJson.items, bulk] } });
}

// ---------------------------------------------------------------------------------------------------------
// Geometria a vzorky (nezávislé od Pathfinderu a od implementácie modulov)
// ---------------------------------------------------------------------------------------------------------

/**
 * Vonkajšie bunky konektorov typu `road` modulu s ľavým horným rohom `origin` (rot 0): bunka susediaca s konektorom
 * na jeho strane, mimo footprintu (rozhodnutie orchestrátora 2). Počíta sa z defu (`connectorsOf`, `SIDE_STEPS` z F2).
 */
export function outsideCellsOf(world: World, defId: string, origin: CellCoord): CellCoord[] {
  return connectorsOf(world.defs.modules.get(defId), origin.x, origin.y, 0)
    .filter((connector) => connector.type === 'road')
    .map((connector) => ({ x: connector.x + SIDE_STEPS[connector.side].dx, y: connector.y + SIDE_STEPS[connector.side].dy }));
}

/**
 * Dĺžka najkratšej cesty (počet krokov po 4-susedných bunkách s `road === 'road'`) z `from` do `to`, `Infinity`, ak
 * neexistuje. Vlastné BFS testu — nie `Pathfinder`, aby sa testy dali overiť aj bez jeho implementácie.
 */
export function roadDistance(grid: Grid, from: CellCoord, to: CellCoord): number {
  const isRoad = (x: number, y: number): boolean => grid.inBounds(x, y) && grid.at(x, y).road === 'road';
  if (!isRoad(from.x, from.y) || !isRoad(to.x, to.y)) return Infinity;
  const seen = new Set<number>([grid.index(from.x, from.y)]);
  let frontier: CellCoord[] = [from];
  for (let steps = 0; frontier.length > 0; steps++) {
    const next: CellCoord[] = [];
    for (const cell of frontier) {
      if (sameCell(cell, to)) return steps;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (!isRoad(x, y) || seen.has(grid.index(x, y))) continue;
        seen.add(grid.index(x, y));
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  return Infinity;
}

/**
 * Prvý tick súvislého státia vozidla na mieste, kde stálo v ticku `tick` (poloha `x`, `y` sa medzi vzorkami nezmenila).
 * Nezávisí od toho, kedy implementácia prepne stav (`loading` hneď pri príchode alebo až po `internalTicks`).
 */
export function stayStartTick(samples: readonly VehicleSample[], tick: number): number {
  const index = samples.findIndex((sample) => sample.tick === tick);
  if (index < 0) throw new Error(`vozidlo nemá vzorku v ticku ${String(tick)}`);
  let start = index;
  while (start > 0 && samples[start - 1].x === samples[index].x && samples[start - 1].y === samples[index].y) start -= 1;
  return samples[start].tick;
}

/** Súčet krokov (Manhattan) vozidla za celý beh. */
export function travelledCells(samples: readonly VehicleSample[]): number {
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += Math.abs(samples[i].x - samples[i - 1].x) + Math.abs(samples[i].y - samples[i - 1].y);
  return total;
}
