/**
 * Pomocníci scenárových testov fázy 4 (T04-05, TDD): pozemná časť exportu — brána, čakacia plocha, rampa a kamióny.
 * Záznam behu (udalosti s tickom, vzorky kamiónov, brán, plôch a ramp po každom ticku), audit ledgera po celej reťazi
 * `on_ship → … → in_storage → in_vehicle → at_ramp → in_truck → exported`, audit jobov (inbound aj outbound) a syntetické
 * defy (`bays`, `processTicks`).
 *
 * Píše sa proti rozhraniu z `docs/tasks/phase-04.md` „Spoločné rozhrania" ešte pred T04-02..T04-04. Kde API (kamióny,
 * triedy `TruckGate` / `WaitingArea` / `LoadingRamp`, udalosti `Truck*`) v simu ešte nie je, ide prístup cez úzke lokálne
 * rozhrania nižšie a chýbajúce API sa ohlási zrozumiteľnou chybou („chýba API: …") namiesto `TypeError` o `undefined`.
 * Keď sa API zmení, upravuje sa jediné miesto — tento súbor. Žiadne `@ts-*` komentáre ani `eslint-disable`.
 *
 * Záznam pre F4 je náprotivok `recordRunF3` z `f3.ts`: ten výslovne zakazuje `at_ramp` / `in_truck` / `exported`, takže by
 * pri prvej naloženej jednotke zlyhal. F3 helper ostáva nedotknutý.
 */
import { APRON_MODULES as modulesJson } from './apron-modules';
import type { CargoLocation } from '@sim/cargo';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry, berthParams, rampParams } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import type { Module, StorageModule } from '@sim/modules';
import { World } from '@sim/world';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';
import { EPSILON, cellOfPosition, jobsOf, sameCell, storageCapacity, storageModulesOf, vehiclesOf } from './f3';
import {
  GATE_ENTRY_OUTSIDE,
  GATE_OUT_ENTRY_OUTSIDE,
  ROAD_PORTAL,
  f4Scenario,
  placeLandsideCommand,
} from './f4-layout';
import { cranesOf, must, type TimedEvent } from './harbor';
import { assertCargoConservation } from './invariants';
import { runScenario, type Scenario } from './scenario';

export { EPSILON, SLACK_TICKS } from './f3';

// ---------------------------------------------------------------------------------------------------------
// Úzke lokálne rozhrania (Spoločné rozhrania z docs/tasks/phase-04.md)
// ---------------------------------------------------------------------------------------------------------

/** Stavy kamióna (Truck FSM, §7.5). */
export const TRUCK_STATES = [
  'to_gate',
  'gate_queue',
  'gate_pass',
  'to_bay',
  'waiting',
  'to_dock',
  'loading',
  'to_gate_out',
  'gate_queue_out',
  'gate_pass_out',
  'to_portal',
  'exited',
  'no_path',
] as const;
export type TruckState = (typeof TRUCK_STATES)[number];

/** Dôvody neprevádzkovosti rampy (`LoadingRamp.inoperativeReason`). */
export type InoperativeReason = 'no_gate' | 'no_waiting_area' | 'not_connected';

/** `Truck` z `src/sim/trucks` (T04-04) — len polia, ktoré testy čítajú. */
export interface TruckLike {
  readonly id: EntityId;
  readonly defId: string;
  readonly def: { readonly capacityUnits: number; readonly speedCellsPerTick: number };
  readonly state: TruckState;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly rampId: EntityId;
  readonly dock: number;
  readonly waitingAreaId: EntityId;
  readonly gateId: EntityId;
  readonly gateOutId?: EntityId | null;
}

interface ConnectorLike {
  readonly x: number;
  readonly y: number;
  readonly side: string;
  readonly type: string;
}

/** `TruckGate` (T04-02; od R4 pruh brány) — len polia, ktoré testy čítajú. */
export interface GateLike {
  readonly params: { readonly direction: 'in' | 'out'; readonly internalTicks?: number };
  readonly direction: 'in' | 'out';
  readonly queueLength: number;
  readonly busyTicksLeft: number;
  readonly entrySide: ConnectorLike | null;
  readonly exitSide: ConnectorLike | null;
  readonly trucksProcessed: number;
}

/** `WaitingArea` (T04-02). */
export interface WaitingAreaLike {
  readonly params: { readonly bays: number; readonly internalTicks?: number };
  readonly bays: number;
  readonly occupiedBays: number;
  readonly reservedBays: number;
}

/** `LoadingRamp` (T04-02). */
export interface RampLike {
  readonly params: { readonly docks: number; readonly stagingPerDock: number; readonly loadTicksPerUnit: number; readonly category: string };
  readonly docks: number;
  stagedAt(dock: number): number;
  reservedAt(dock: number): number;
  readonly operational: boolean;
  readonly inoperativeReason: InoperativeReason | null;
}

export type GateModule = Module & GateLike;
export type WaitingAreaModule = Module & WaitingAreaLike;
export type RampModule = Module & RampLike;

interface LandsideWorld {
  readonly trucks?: ReadonlyMap<EntityId, TruckLike>;
  isRampOperational?(ramp: Module): boolean;
}

const landsideView = (world: World): LandsideWorld => world as unknown as LandsideWorld;

/** `world.trucks` (T04-04); chýbajúce API = zrozumiteľná chyba namiesto `TypeError` o `undefined`. */
export function trucksOf(world: World): ReadonlyMap<EntityId, TruckLike> {
  const trucks = landsideView(world).trucks;
  if (trucks === undefined) throw new Error('chýba API: world.trucks (T04-04: Truck + World.trucks)');
  return trucks;
}

/** `world.isRampOperational(ramp)` (T04-02). */
export function isRampOperational(world: World, ramp: Module): boolean {
  const view = landsideView(world);
  if (typeof view.isRampOperational !== 'function') throw new Error('chýba API: World.isRampOperational(ramp) (T04-02: prevádzkovosť rampy)');
  return view.isRampOperational(ramp);
}

export function trucksById(world: World): TruckLike[] {
  return [...trucksOf(world).values()].sort((a, b) => a.id - b.id);
}

function modulesOfKind(world: World, kind: Module['kind']): Module[] {
  return [...world.modules.values()].filter((module) => module.kind === kind);
}

export function gatesOf(world: World): GateModule[] {
  return modulesOfKind(world, 'gate') as GateModule[];
}
export function waitingAreasOf(world: World): WaitingAreaModule[] {
  return modulesOfKind(world, 'waiting_area') as WaitingAreaModule[];
}
export function rampsOf(world: World): RampModule[] {
  return modulesOfKind(world, 'ramp') as RampModule[];
}

function only<T>(list: readonly T[], what: string): T {
  if (list.length !== 1) throw new Error(`očakávaný práve 1 modul druhu ${what}, svet ich má ${String(list.length)}`);
  return list[0];
}
/** Vstupný pruh brány (R4: v rozložení F4 práve jeden). */
export const gateOf = (world: World): GateModule => only(gatesOf(world).filter((gate) => gate.direction === 'in'), 'gate_in_lane');
/** Výstupný pruh brány (R4: v rozložení F4 práve jeden). */
export const gateOutOf = (world: World): GateModule => only(gatesOf(world).filter((gate) => gate.direction === 'out'), 'gate_out_lane');
export const waitingAreaOf = (world: World): WaitingAreaModule => only(waitingAreasOf(world), 'waiting_area');
export const rampOf = (world: World): RampModule => only(rampsOf(world), 'ramp');

// ---------------------------------------------------------------------------------------------------------
// Udalosti kamiónov a pozemnej časti (v SimEvent pribudnú s T04-02 / T04-04)
// ---------------------------------------------------------------------------------------------------------

export interface TruckSpawnedEvent {
  readonly type: 'TruckSpawned';
  readonly truckId: EntityId;
  readonly rampId: EntityId;
  readonly dock: number;
}
export interface TruckStateChangedEvent {
  readonly type: 'TruckStateChanged';
  readonly truckId: EntityId;
  readonly from: TruckState;
  readonly to: TruckState;
}
export interface TruckExitedEvent {
  readonly type: 'TruckExited';
  readonly truckId: EntityId;
  readonly units: number;
}
export interface NoWaitingBayEvent {
  readonly type: 'NoWaitingBay';
  readonly rampId: EntityId;
}
export interface RampOperationalChangedEvent {
  readonly type: 'RampOperationalChanged';
  readonly rampId: EntityId;
  readonly operational: boolean;
  readonly reason: InoperativeReason | null;
}

export type LandsideEvent =
  | TruckSpawnedEvent
  | TruckStateChangedEvent
  | TruckExitedEvent
  | NoWaitingBayEvent
  | RampOperationalChangedEvent;
export type LandsideEventType = LandsideEvent['type'];

/** Udalosť pozemnej časti s tickom a hernou hodinou (ako `TimedEvent`, ale nad lokálnymi typmi udalostí). */
export interface TimedLandside<E extends LandsideEvent = LandsideEvent> {
  readonly tick: number;
  readonly hour: number;
  readonly event: E;
}

/** Udalosti jedného typu pozemnej časti v poradí vzniku. */
export function landsideEvents<T extends LandsideEventType>(
  events: readonly TimedEvent[],
  type: T,
): TimedLandside<Extract<LandsideEvent, { type: T }>>[] {
  const matching = events.filter((entry) => {
    const eventType: string = entry.event.type;
    return eventType === type;
  });
  return matching as unknown as TimedLandside<Extract<LandsideEvent, { type: T }>>[];
}

/** Udalosti známych typov (`SimEvent`) s tickom — pre `CargoMoved`, `JobCreated`, `ModulePlaced`… */
export function timed4<T extends SimEvent['type']>(events: readonly TimedEvent[], type: T): TimedEvent<Extract<SimEvent, { type: T }>>[] {
  return events.filter((entry): entry is TimedEvent<Extract<SimEvent, { type: T }>> => entry.event.type === type);
}

// ---------------------------------------------------------------------------------------------------------
// Tabuľka FSM kamióna (karta T04-04, rozhodnutie orchestrátora 6)
// ---------------------------------------------------------------------------------------------------------

/**
 * Povolené prechody kamióna: `to_gate → gate_queue → gate_pass → to_bay → waiting → to_dock → loading → to_gate_out →
 * gate_queue_out → gate_pass_out → to_portal → exited` (`gate_queue → to_bay` len pri preklopení strán brány); jazdné stavy môžu vypadnúť do `no_path` a vracajú sa do toho, z ktorého vypadli.
 */
export const TRUCK_TRANSITIONS: Readonly<Record<TruckState, readonly TruckState[]>> = {
  to_gate: ['gate_queue', 'no_path'],
  gate_queue: ['gate_pass', 'to_bay'],
  gate_pass: ['to_bay'],
  to_bay: ['waiting', 'no_path'],
  waiting: ['to_dock'],
  to_dock: ['loading', 'no_path'],
  loading: ['to_gate_out'],
  to_gate_out: ['gate_queue_out', 'no_path'],
  gate_queue_out: ['gate_pass_out', 'to_portal'],
  gate_pass_out: ['to_portal'],
  to_portal: ['exited', 'no_path'],
  exited: [],
  no_path: ['to_gate', 'to_bay', 'to_dock', 'to_gate_out', 'to_portal'],
};

/** Kanonický životný cyklus kamióna bez `no_path` (`exited` nemusí mať vlastnú `TruckStateChanged`). */
export const TRUCK_CYCLE: readonly TruckState[] = [
  'to_gate',
  'gate_queue',
  'gate_pass',
  'to_bay',
  'waiting',
  'to_dock',
  'loading',
  'to_gate_out',
  'gate_queue_out',
  'gate_pass_out',
  'to_portal',
];

/** Kamión drží rezerváciu stojiska od spawnu, kým neodíde k rampe. */
export const BAY_HOLDING_STATES: readonly TruckState[] = ['to_gate', 'gate_queue', 'gate_pass', 'to_bay', 'waiting'];
/** Kamión stojí vo (fyzickej) fronte brány na jej vonkajšej bunke. */
export const GATE_QUEUE_STATES: readonly TruckState[] = ['gate_queue', 'gate_queue_out'];
/** Kamión prechádza bránou (čelo fronty, mimo cesty). */
export const GATE_PASS_STATES: readonly TruckState[] = ['gate_pass', 'gate_pass_out'];
/** Kamión je v zozname fronty brány (čaká alebo prechádza). */
export const GATE_LISTED_STATES: readonly TruckState[] = [...GATE_QUEUE_STATES, ...GATE_PASS_STATES];
/** Kamión ešte nič nenaložil. */
const EMPTY_STATES: readonly TruckState[] = ['to_gate', 'gate_queue', 'gate_pass', 'to_bay', 'waiting', 'to_dock'];
/** Kamión už odchádza s nákladom. */
const LOADED_STATES: readonly TruckState[] = ['to_gate_out', 'gate_queue_out', 'gate_pass_out', 'to_portal'];
/** Stavy, v ktorých kamión určite stojí alebo ide po ceste mimo tela brány / plochy. */
const ON_ROAD_STATES: readonly TruckState[] = ['to_gate', 'gate_queue', 'gate_pass', 'gate_queue_out', 'gate_pass_out', 'to_portal'];
/** Stavy s jazdou, v ktorých sa kamión neprechádza telom brány ani plochy (krok ≤ rýchlosť). */
const STEADY_DRIVE_STATES: readonly TruckState[] = ['to_gate', 'to_portal'];

/**
 * Overí prúd `TruckStateChanged`: každá udalosť je povolený prechod, `from` nadväzuje na `to` predošlej udalosti toho
 * istého kamióna, prvá začína v `to_gate` (stav po spawne) a z `no_path` sa kamión vráti do stavu, z ktorého vypadol.
 * Vráti dôvod porušenia alebo `null`.
 */
export function truckFsmViolation(events: readonly TimedEvent[]): string | null {
  const last = new Map<number, TruckState>();
  const beforeNoPath = new Map<number, TruckState>();
  for (const { tick, event } of landsideEvents(events, 'TruckStateChanged')) {
    const { truckId, from, to } = event;
    const where = `kamión ${String(truckId)}, tick ${String(tick)}: ${from} → ${to}`;
    if (!(TRUCK_STATES as readonly string[]).includes(from) || !(TRUCK_STATES as readonly string[]).includes(to)) return `${where}: neznámy stav`;
    if (!TRUCK_TRANSITIONS[from].includes(to)) return `${where} nie je povolený prechod`;
    const previous = last.get(truckId) ?? 'to_gate';
    if (from !== previous) return `${where}: predošlý stav kamióna bol ${previous}, nie ${from}`;
    if (to === 'no_path') beforeNoPath.set(truckId, from);
    const expectedResume = beforeNoPath.get(truckId);
    if (from === 'no_path' && expectedResume !== undefined && expectedResume !== to) {
      return `${where}: kamión vypadol z ${expectedResume} a mal sa vrátiť tam`;
    }
    last.set(truckId, to);
  }
  return null;
}

/** Stavy kamiónov za sebou bez opakovaní podľa `TruckStateChanged` (prvý je `to_gate`), po kamiónoch. */
export function truckStateChains(events: readonly TimedEvent[]): Map<EntityId, TruckState[]> {
  const chains = new Map<EntityId, TruckState[]>();
  for (const { event } of landsideEvents(events, 'TruckStateChanged')) {
    const chain = chains.get(event.truckId) ?? ['to_gate'];
    chain.push(event.to);
    chains.set(event.truckId, chain);
  }
  return chains;
}

/**
 * Ticky dokončených prechodov telom brány: každý `TruckStateChanged` z `gate_pass` alebo `gate_pass_out` (oba smery majú
 * spoločnú frontu). Medzi dvoma po sebe idúcimi musí byť ≥ `processTicks`.
 */
export function gateCrossingTicks(events: readonly TimedEvent[]): number[] {
  return landsideEvents(events, 'TruckStateChanged')
    .filter((entry) => GATE_PASS_STATES.includes(entry.event.from))
    .map((entry) => entry.tick);
}

/** Najmenší odstup po sebe idúcich hodnôt (`Infinity`, ak sú menej než dve). */
export function minGap(ticks: readonly number[]): number {
  let smallest = Infinity;
  for (let i = 1; i < ticks.length; i++) smallest = Math.min(smallest, ticks[i] - ticks[i - 1]);
  return smallest;
}

/** Najväčší počet `NoWaitingBay` na jednu rampu v jednej hernej hodine (throttle ≤ 1× za hodinu). */
export function maxNoWaitingBayPerRampHour(events: readonly TimedEvent[]): number {
  const counts = new Map<string, number>();
  for (const entry of landsideEvents(events, 'NoWaitingBay')) {
    const key = `${String(entry.event.rampId)}:${String(entry.hour)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

// ---------------------------------------------------------------------------------------------------------
// Audit ledgera po celej reťazi (nezávislý od implementácie `assertConservation()`)
// ---------------------------------------------------------------------------------------------------------

export interface LedgerAuditF4 {
  readonly onShip: number;
  readonly inCrane: number;
  readonly onApron: number;
  readonly inVehicle: number;
  readonly inStorage: number;
  readonly atRamp: number;
  readonly inTruck: number;
  readonly exported: number;
}

/**
 * Prejde loď po lodi, berth po berthe, vozidlo po vozidle, sklad po sklade, rampu po rampe a kamión po kamióne cez
 * `unitsOnShip` / `unitsOnApron` / `unitsAt` a porovná s `cargo.get(id).location` a počítadlami. Overuje: žiadna jednotka
 * nie je v dvoch zoznamoch, `location` zodpovedá zoznamu, sloty apronu a skladu sú jedinečné a v rozsahu, dock rampy je
 * v rozsahu a počet jednotiek na docku ≤ `stagingPerDock` (`stagedAt` = ledger, `staged + reserved` ≤ `stagingPerDock`),
 * vozidlo aj kamión držia najviac `capacityUnits`, `storedCount` skladu = ledger, `createdCount` = súčet všetkých jednotiek
 * + `exportedCount` (nič nevzniklo ani nezmizlo) a nič nejde do potrubí ani vlakov.
 */
export function auditLedgerF4(world: World): LedgerAuditF4 {
  const { cargo } = world;
  const owner = new Map<number, string>();
  const claim = (unitId: EntityId, where: string): void => {
    const previous = owner.get(unitId);
    if (previous !== undefined) throw new Error(`audit: jednotka ${String(unitId)} je naraz v '${previous}' aj v '${where}'`);
    owner.set(unitId, where);
  };
  const locationOf = (unitId: EntityId): CargoLocation | undefined => cargo.get(unitId)?.location;
  const mismatch = (unitId: EntityId, holder: string): Error =>
    new Error(`audit: jednotka ${String(unitId)} je v zozname držiteľa ${holder}, ale location = ${JSON.stringify(locationOf(unitId))}`);

  let onShip = 0;
  for (const ship of world.ships.values()) {
    for (const unitId of cargo.unitsOnShip(ship.id)) {
      claim(unitId, `on_ship(${String(ship.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'on_ship' || location.shipId !== ship.id) throw mismatch(unitId, `lode ${String(ship.id)}`);
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
      if (location?.kind !== 'on_apron' || location.berthId !== module.id) throw mismatch(unitId, `apronu ${String(module.id)}`);
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
      if (location?.kind !== 'in_vehicle' || location.vehicleId !== vehicle.id) throw mismatch(unitId, `vozidla ${String(vehicle.id)}`);
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
      if (location?.kind !== 'in_storage' || location.moduleId !== module.id) throw mismatch(unitId, `skladu ${String(module.id)}`);
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
      throw new Error(`audit: sklad ${String(module.id)} má stored ${String(module.storedCount)} + reserved ${String(module.reservedCount)} nad kapacitu ${String(capacity)}`);
    }
  }

  let atRamp = 0;
  for (const ramp of rampsOf(world)) {
    const { docks, stagingPerDock } = rampParams(ramp.def);
    const perDock = Array.from({ length: docks }, () => 0);
    for (const unitId of cargo.unitsAt('at_ramp', ramp.id)) {
      claim(unitId, `at_ramp(${String(ramp.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'at_ramp' || location.rampId !== ramp.id) throw mismatch(unitId, `rampy ${String(ramp.id)}`);
      if (!Number.isInteger(location.dock) || location.dock < 0 || location.dock >= docks) {
        throw new Error(`audit: jednotka ${String(unitId)} je na docku ${String(location.dock)} mimo 0..${String(docks - 1)} rampy ${String(ramp.id)}`);
      }
      perDock[location.dock] += 1;
      atRamp += 1;
    }
    perDock.forEach((count, dock) => {
      const where = `rampa ${String(ramp.id)}, dock ${String(dock)}`;
      if (count > stagingPerDock) throw new Error(`audit: ${where} drží ${String(count)} jednotiek nad stagingPerDock ${String(stagingPerDock)}`);
      if (ramp.stagedAt(dock) !== count) throw new Error(`audit: ${where}: stagedAt = ${String(ramp.stagedAt(dock))}, ledger drží ${String(count)}`);
      if (ramp.stagedAt(dock) + ramp.reservedAt(dock) > stagingPerDock) {
        throw new Error(`audit: ${where}: staged ${String(ramp.stagedAt(dock))} + reserved ${String(ramp.reservedAt(dock))} nad stagingPerDock ${String(stagingPerDock)}`);
      }
    });
  }

  let inTruck = 0;
  for (const truck of trucksOf(world).values()) {
    const units = cargo.unitsAt('in_truck', truck.id);
    if (units.length > truck.def.capacityUnits) {
      throw new Error(`audit: kamión ${String(truck.id)} drží ${String(units.length)} jednotiek nad kapacitu ${String(truck.def.capacityUnits)}`);
    }
    for (const unitId of units) {
      claim(unitId, `in_truck(${String(truck.id)})`);
      const location = locationOf(unitId);
      if (location?.kind !== 'in_truck' || location.truckId !== truck.id) throw mismatch(unitId, `kamióna ${String(truck.id)}`);
      inTruck += 1;
    }
  }

  const inCrane = cargo.countByKind('in_crane');
  if (inCrane > cranesOf(world).length) {
    throw new Error(`audit: ${String(inCrane)} jednotiek v žeriavoch, ale žeriavov je ${String(cranesOf(world).length)}`);
  }
  const counted = [
    ['on_ship', onShip],
    ['on_apron', onApron],
    ['in_vehicle', inVehicle],
    ['in_storage', inStorage],
    ['at_ramp', atRamp],
    ['in_truck', inTruck],
  ] as const;
  for (const [kind, expected] of counted) {
    if (cargo.countByKind(kind) !== expected) {
      throw new Error(`audit: countByKind('${kind}') = ${String(cargo.countByKind(kind))}, zoznamy držiteľov obsahujú ${String(expected)}`);
    }
  }
  for (const kind of ['in_pipeline', 'in_train'] as const) {
    if (cargo.countByKind(kind) !== 0) throw new Error(`audit: vo F4 nemá byť žiadna jednotka '${kind}', je ich ${String(cargo.countByKind(kind))}`);
  }
  const exported = cargo.exportedCount;
  const live = onShip + inCrane + onApron + inVehicle + inStorage + atRamp + inTruck;
  if (cargo.createdCount !== live + exported) {
    throw new Error(
      `audit: createdCount = ${String(cargo.createdCount)}, ale nájdených jednotiek ${String(live)} + exported ${String(exported)} ` +
        `(loď ${String(onShip)}, žeriav ${String(inCrane)}, apron ${String(onApron)}, vozidlo ${String(inVehicle)}, sklad ${String(inStorage)}, ` +
        `rampa ${String(atRamp)}, kamión ${String(inTruck)}) — náklad vznikol alebo zmizol`,
    );
  }
  return { onShip, inCrane, onApron, inVehicle, inStorage, atRamp, inTruck, exported };
}

// ---------------------------------------------------------------------------------------------------------
// Audit jobov (inbound apron → sklad aj outbound sklad → rampa)
// ---------------------------------------------------------------------------------------------------------

/**
 * Invarianty dispatchera po každom ticku: žiadna jednotka nemá 2 aktívne joby, vozidlo má najviac 1 job a `vehicle.jobId`
 * ↔ `job.vehicleId` sedí, `open` job nemá vozidlo, priradený job má existujúce vozidlo, počet jednotiek ≤ kapacita vozidla.
 * Inbound job (`on_apron → in_storage`) má zdroj berth a cieľ sklad a v stavoch `open`/`assigned`/`picking` rezervovaný
 * slot skladu. Outbound job (`in_storage → at_ramp`) má zdroj sklad a cieľ rampu s docku v rozsahu a rezerváciu staging
 * slotu (`reservedAt(dock)`) drží po celý život jobu (ADR-018: aktívny job drží rezerváciu cieľa).
 */
export function auditJobsF4(world: World): void {
  const activeUnits = new Map<number, EntityId>();
  const jobOfVehicle = new Map<number, EntityId>();
  const storageNeed = new Map<EntityId, number>();
  const stagingNeed = new Map<string, { rampId: EntityId; dock: number; need: number }>();

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
    const target = world.modules.get(job.toModuleId);
    const inbound = job.from.kind === 'on_apron' && job.to.kind === 'in_storage';
    const outbound = job.from.kind === 'in_storage' && job.to.kind === 'at_ramp';
    if (inbound) {
      if (source?.kind !== 'berth' || job.from.kind !== 'on_apron' || job.from.berthId !== job.fromModuleId) {
        throw new Error(`audit: ${label}: zdroj ${JSON.stringify(job.from)} / modul ${String(job.fromModuleId)} nie je apron berthu`);
      }
      if (target?.kind !== 'storage' || job.to.kind !== 'in_storage' || job.to.moduleId !== job.toModuleId) {
        throw new Error(`audit: ${label}: cieľ ${JSON.stringify(job.to)} / modul ${String(job.toModuleId)} nie je sklad`);
      }
      if (job.state === 'open' || job.state === 'assigned' || job.state === 'picking') {
        storageNeed.set(job.toModuleId, (storageNeed.get(job.toModuleId) ?? 0) + job.unitIds.length);
      }
    } else if (outbound) {
      if (source?.kind !== 'storage' || job.from.kind !== 'in_storage' || job.from.moduleId !== job.fromModuleId) {
        throw new Error(`audit: ${label}: zdroj ${JSON.stringify(job.from)} / modul ${String(job.fromModuleId)} nie je sklad`);
      }
      if (target?.kind !== 'ramp' || job.to.kind !== 'at_ramp' || job.to.rampId !== job.toModuleId) {
        throw new Error(`audit: ${label}: cieľ ${JSON.stringify(job.to)} / modul ${String(job.toModuleId)} nie je rampa`);
      }
      const { docks } = rampParams(target.def);
      if (job.to.dock < 0 || job.to.dock >= docks) throw new Error(`audit: ${label}: dock ${String(job.to.dock)} mimo 0..${String(docks - 1)}`);
      const key = `${String(job.to.rampId)}:${String(job.to.dock)}`;
      const entry = stagingNeed.get(key) ?? { rampId: job.to.rampId, dock: job.to.dock, need: 0 };
      entry.need += job.unitIds.length;
      stagingNeed.set(key, entry);
    } else {
      throw new Error(`audit: ${label}: neznáma trasa ${job.from.kind} → ${job.to.kind}`);
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
  }

  for (const vehicle of vehiclesOf(world).values()) {
    if (vehicle.jobId === null) continue;
    const job = jobsOf(world).get(vehicle.jobId);
    if (job === undefined) throw new Error(`audit: vozidlo ${String(vehicle.id)} má jobId ${String(vehicle.jobId)}, ktorý vo world.jobs nie je`);
    if (job.state !== 'done' && job.vehicleId !== vehicle.id) {
      throw new Error(`audit: vozidlo ${String(vehicle.id)} má job ${String(job.id)}, ktorý patrí vozidlu ${String(job.vehicleId)}`);
    }
  }

  for (const [moduleId, need] of storageNeed) {
    const module = world.modules.get(moduleId);
    const reserved = module?.kind === 'storage' ? (module as StorageModule).reservedCount : 0;
    if (reserved < need) throw new Error(`audit: sklad ${String(moduleId)} má reserved ${String(reserved)}, ale inbound joby ho potrebujú ${String(need)}`);
  }
  for (const { rampId, dock, need } of stagingNeed.values()) {
    const ramp = must(world.modules.get(rampId), `rampa ${String(rampId)}`) as RampModule;
    if (ramp.reservedAt(dock) < need) {
      throw new Error(`audit: rampa ${String(rampId)}, dock ${String(dock)} má reserved ${String(ramp.reservedAt(dock))}, ale outbound joby ho potrebujú ${String(need)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Záznam behu
// ---------------------------------------------------------------------------------------------------------

/** Stav kamióna na konci jedného ticku. */
export interface TruckSample {
  readonly tick: number;
  readonly truckId: EntityId;
  readonly state: TruckState;
  readonly x: number;
  readonly y: number;
  readonly rampId: EntityId;
  readonly dock: number;
  /** Počet jednotiek `in_truck` u tohto kamióna podľa ledgera. */
  readonly unitsInside: number;
}

/** Stav brány na konci jedného ticku. */
export interface GateSample {
  readonly tick: number;
  readonly gateId: EntityId;
  readonly queueLength: number;
  readonly busyTicksLeft: number;
  readonly trucksProcessed: number;
  /** Počet kamiónov v `gate_queue` / `gate_queue_out` tejto brány podľa stavov kamiónov. */
  readonly trucksQueued: number;
}

/** Stav stojiska na konci jedného ticku. */
export interface WaitingSample {
  readonly tick: number;
  readonly areaId: EntityId;
  readonly bays: number;
  readonly occupiedBays: number;
  readonly reservedBays: number;
  /** Počet kamiónov v `BAY_HOLDING_STATES` s týmto stojiskom. */
  readonly holding: number;
}

/** Staging jednej rampy na konci jedného ticku (index = dock). */
export interface RampSample {
  readonly tick: number;
  readonly rampId: EntityId;
  readonly staged: readonly number[];
  readonly reserved: readonly number[];
  readonly operational: boolean;
}

/** Pravidlo fyziky a stavov kamióna a brány kontrolované po každom ticku. */
export type Rule4 =
  | 'truck_position'
  | 'truck_queue_position'
  | 'truck_cargo'
  | 'truck_refs'
  | 'bay_accounting'
  | 'dock_conflict'
  | 'gate_queue';

export interface Violation4 {
  readonly rule: Rule4;
  readonly message: string;
}

export interface RunOptions4 {
  /** Voliteľný hák po každom ticku (po invariantoch a vzorkách). */
  readonly onTick?: (world: World, events: readonly SimEvent[]) => void;
}

/**
 * Záznam behu nad jedným `World`: po **každom** ticku `assertCargoConservation(world)` (CLAUDE.md, pravidlo 2), nezávislý
 * `auditLedgerF4` aj `auditJobsF4`, vzorky kamiónov, brán, plôch a ramp a kontrola pravidiel kamiónov (`Rule4`). Beh sa dá
 * viackrát predĺžiť (`runTo`, `runUntil`) a medzi tým poslať príkaz (`send`), takže jeden záznam pokryje aj scenáre typu
 * „brána sa postaví neskôr".
 */
export class Recorder4 {
  readonly events: TimedEvent[] = [];
  readonly trucks = new Map<EntityId, TruckSample[]>();
  readonly gates: GateSample[] = [];
  readonly areas: WaitingSample[] = [];
  readonly ramps: RampSample[] = [];
  readonly violations: Violation4[] = [];
  ticksChecked = 0;

  constructor(
    readonly world: World,
    readonly scenario: Scenario,
    private readonly options: RunOptions4 = {},
  ) {}

  /** Pošle serializovaný príkaz; aplikuje sa na začiatku ďalšieho ticku. */
  send(command: SerializedCommand): void {
    this.world.enqueue(commandFromJSON(command));
  }

  /** Jeden tick s celým záznamom a invariantmi. */
  step(): void {
    runScenario(this.world, this.scenario, this.world.clock.tick + 1, {
      afterTick: (world, tickEvents) => this.observe(world, tickEvents),
    });
  }

  /** Behá po absolútny tick `untilTick`, prípadne skončí skôr, keď `stopWhen(world)` platí (kontrola po každom ticku). */
  runTo(untilTick: number, stopWhen?: (world: World) => boolean): void {
    while (this.world.clock.tick < untilTick) {
      this.step();
      if (stopWhen?.(this.world) === true) return;
    }
  }

  /** Behá po jednom ticku, kým `predicate(world)` nie je splnený (kontrola pred každým tickom vrátane prvého); inak chyba. */
  runUntil(predicate: (world: World) => boolean, maxTicks: number): void {
    const limit = this.world.clock.tick + maxTicks;
    while (!predicate(this.world)) {
      if (this.world.clock.tick >= limit) {
        throw new Error(`runUntil: podmienka nenastala do ${String(maxTicks)} tickov (tick ${String(this.world.clock.tick)})`);
      }
      this.step();
    }
  }

  /** Vzorky kamióna; chyba, ak sa vo svete nikdy neobjavil. */
  samplesOf(truckId: EntityId): readonly TruckSample[] {
    const samples = this.trucks.get(truckId);
    if (samples === undefined) throw new Error(`kamión ${String(truckId)} sa v behu nikdy neobjavil vo world.trucks`);
    return samples;
  }

  /** Správy porušení jedného pravidla (prázdne pole = pravidlo držalo po každom ticku). */
  violationsOf(rule: Rule4): string[] {
    return this.violations.filter((violation) => violation.rule === rule).map((violation) => violation.message);
  }

  /** Najväčší počet kamiónov naraz v `gate_queue` / `gate_queue_out` (podľa vzoriek brán). */
  get maxTrucksQueued(): number {
    return Math.max(0, ...this.gates.map((sample) => sample.trucksQueued));
  }

  private observe(world: World, tickEvents: readonly SimEvent[]): void {
    assertCargoConservation(world);
    auditLedgerF4(world);
    auditJobsF4(world);
    this.ticksChecked += 1;
    const tick = world.clock.tick;
    for (const event of tickEvents) this.events.push({ tick, hour: world.clock.gameHour, event });

    const trucks = trucksById(world);
    for (const truck of trucks) {
      const sample: TruckSample = {
        tick,
        truckId: truck.id,
        state: truck.state,
        x: truck.x,
        y: truck.y,
        rampId: truck.rampId,
        dock: truck.dock,
        unitsInside: world.cargo.countAt('in_truck', truck.id),
      };
      const list = this.trucks.get(truck.id) ?? [];
      this.violations.push(...truckViolations(world, truck, sample, list.at(-1)));
      list.push(sample);
      this.trucks.set(truck.id, list);
    }
    this.violations.push(...dockViolations(tick, trucks));

    for (const gate of gatesOf(world)) {
      const listed = gate.direction === 'in' ? ['gate_queue', 'gate_pass'] : ['gate_queue_out', 'gate_pass_out'];
      const trucksQueued = trucks.filter((truck) => (gate.direction === 'in' ? truck.gateId : truck.gateOutId) === gate.id && listed.includes(truck.state)).length;
      this.gates.push({ tick, gateId: gate.id, queueLength: gate.queueLength, busyTicksLeft: gate.busyTicksLeft, trucksProcessed: gate.trucksProcessed, trucksQueued });
      if (!Number.isInteger(gate.queueLength) || gate.queueLength < 0 || gate.queueLength > trucksQueued) {
        this.violations.push({
          rule: 'gate_queue',
          message: `tick ${String(tick)}, brána ${String(gate.id)}: queueLength ${String(gate.queueLength)}, ale v gate_queue* a gate_pass* je ${String(trucksQueued)} kamiónov (fronta smie obsahovať len ich)`,
        });
      }
      if (!Number.isInteger(gate.busyTicksLeft) || gate.busyTicksLeft < 0) {
        this.violations.push({ rule: 'gate_queue', message: `tick ${String(tick)}, brána ${String(gate.id)}: busyTicksLeft = ${String(gate.busyTicksLeft)}` });
      }
    }

    for (const area of waitingAreasOf(world)) {
      const holding = trucks.filter((truck) => truck.waitingAreaId === area.id && BAY_HOLDING_STATES.includes(truck.state)).length;
      this.areas.push({ tick, areaId: area.id, bays: area.bays, occupiedBays: area.occupiedBays, reservedBays: area.reservedBays, holding });
      const where = `tick ${String(tick)}, stojisko ${String(area.id)}`;
      if (holding > area.bays) {
        this.violations.push({ rule: 'bay_accounting', message: `${where}: ${String(holding)} kamiónov drží stojisko, ale bays = ${String(area.bays)} (spawn bez voľného bay)` });
      }
      if (area.occupiedBays + area.reservedBays > area.bays) {
        this.violations.push({
          rule: 'bay_accounting',
          message: `${where}: occupied ${String(area.occupiedBays)} + reserved ${String(area.reservedBays)} nad bays ${String(area.bays)}`,
        });
      }
      if (area.occupiedBays + area.reservedBays < holding) {
        this.violations.push({
          rule: 'bay_accounting',
          message: `${where}: occupied ${String(area.occupiedBays)} + reserved ${String(area.reservedBays)} < ${String(holding)} kamiónov, ktoré stojisko držia`,
        });
      }
    }

    for (const ramp of rampsOf(world)) {
      const docks = Array.from({ length: ramp.docks }, (_, dock) => dock);
      this.ramps.push({
        tick,
        rampId: ramp.id,
        staged: docks.map((dock) => ramp.stagedAt(dock)),
        reserved: docks.map((dock) => ramp.reservedAt(dock)),
        operational: isRampOperational(world, ramp),
      });
    }

    this.options.onTick?.(world, tickEvents);
  }
}

/** Prehrá scenár po absolútny tick `untilTick` (alebo do `stopWhen`) a vráti záznam. */
export function recordRunF4(
  world: World,
  scenario: Scenario,
  untilTick: number,
  options: RunOptions4 & { readonly stopWhen?: (world: World) => boolean } = {},
): Recorder4 {
  const recorder = new Recorder4(world, scenario, options);
  recorder.runTo(untilTick, options.stopWhen);
  return recorder;
}

/**
 * Fyzické pravidlá a stavy kamióna po jednom ticku (rozhodnutia orchestrátora 2, 3, 6; „nič sa neteleportuje"):
 * 1. poloha je konečná a v mape; v `to_gate`, `gate_queue`, `gate_queue_out`, `to_portal` stojí na bunke s cestou;
 * 2. v `to_gate` a `to_portal` (bez prechodu telom brány) je krok medzi vzorkami ≤ `speedCellsPerTick`;
 * 3. čakajúci kamión (virtuálna fronta) stojí na vonkajšej bunke konektora brány: `gate_queue` na vstupe, `gate_queue_out`
 *    na výstupe, a v ďalšom ticku toho istého stavu sa nepohne;
 * 4. náklad: `to_gate` … `to_dock` prázdny, `loading` najviac `capacityUnits`, `to_gate_out` … `to_portal` plný (§7.5 invariant);
 * 5. odkazy `rampId` / `dock` / `waitingAreaId` / `gateId` ukazujú na existujúce moduly správneho druhu.
 */
function truckViolations(world: World, truck: TruckLike, sample: TruckSample, previous: TruckSample | undefined): Violation4[] {
  const found: Violation4[] = [];
  const where = `kamión ${String(truck.id)}, tick ${String(sample.tick)}, stav ${sample.state}, poloha (${String(sample.x)}, ${String(sample.y)})`;
  const cell = cellOfPosition(sample.x, sample.y);
  if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y) || !world.grid.inBounds(cell.x, cell.y)) {
    found.push({ rule: 'truck_position', message: `${where}: poloha mimo mapy` });
    return found;
  }
  if (ON_ROAD_STATES.includes(sample.state) && world.grid.at(cell.x, cell.y).road !== 'road') {
    found.push({ rule: 'truck_position', message: `${where}: bunka (${String(cell.x)}, ${String(cell.y)}) nemá cestu` });
  }
  if (previous !== undefined && previous.tick === sample.tick - 1 && previous.state === sample.state) {
    const step = Math.abs(sample.x - previous.x) + Math.abs(sample.y - previous.y);
    if (STEADY_DRIVE_STATES.includes(sample.state) && step > truck.def.speedCellsPerTick + EPSILON) {
      found.push({ rule: 'truck_position', message: `${where}: krok ${String(step)} > speedCellsPerTick ${String(truck.def.speedCellsPerTick)} (teleportácia)` });
    }
    if (GATE_QUEUE_STATES.includes(sample.state) && step > EPSILON) {
      found.push({ rule: 'truck_queue_position', message: `${where}: čakajúci kamión sa pohol o ${String(step)}` });
    }
  }
  if (sample.state === 'gate_queue' && !sameCell(cell, GATE_ENTRY_OUTSIDE)) {
    found.push({ rule: 'truck_queue_position', message: `${where}: gate_queue má stáť na vstupnej vonkajšej bunke brány (${String(GATE_ENTRY_OUTSIDE.x)}, ${String(GATE_ENTRY_OUTSIDE.y)})` });
  }
  if (sample.state === 'gate_queue_out' && !sameCell(cell, GATE_OUT_ENTRY_OUTSIDE)) {
    found.push({ rule: 'truck_queue_position', message: `${where}: gate_queue_out má stáť na vonkajšej bunke vstupu výstupného pruhu (${String(GATE_OUT_ENTRY_OUTSIDE.x)}, ${String(GATE_OUT_ENTRY_OUTSIDE.y)})` });
  }

  const capacity = truck.def.capacityUnits;
  if (EMPTY_STATES.includes(sample.state) && sample.unitsInside !== 0) {
    found.push({ rule: 'truck_cargo', message: `${where}: pred nakládkou nemá vezť náklad, drží ${String(sample.unitsInside)}` });
  }
  if (sample.state === 'loading' && sample.unitsInside > capacity) {
    found.push({ rule: 'truck_cargo', message: `${where}: drží ${String(sample.unitsInside)} jednotiek nad kapacitu ${String(capacity)}` });
  }
  if (LOADED_STATES.includes(sample.state) && sample.unitsInside !== capacity) {
    found.push({ rule: 'truck_cargo', message: `${where}: odchádza s ${String(sample.unitsInside)} jednotkami, očakáva sa plný kamión (${String(capacity)})` });
  }

  const ramp = world.modules.get(truck.rampId);
  if (ramp?.kind !== 'ramp') found.push({ rule: 'truck_refs', message: `${where}: rampId ${String(truck.rampId)} nie je rampa` });
  else if (!Number.isInteger(truck.dock) || truck.dock < 0 || truck.dock >= rampParams(ramp.def).docks) {
    found.push({ rule: 'truck_refs', message: `${where}: dock ${String(truck.dock)} mimo rozsahu rampy ${String(truck.rampId)}` });
  }
  if (world.modules.get(truck.waitingAreaId)?.kind !== 'waiting_area') {
    found.push({ rule: 'truck_refs', message: `${where}: waitingAreaId ${String(truck.waitingAreaId)} nie je čakacia plocha` });
  }
  if (world.modules.get(truck.gateId)?.kind !== 'gate') {
    found.push({ rule: 'truck_refs', message: `${where}: gateId ${String(truck.gateId)} nie je brána` });
  }
  return found;
}

/** Na jednom docku nakladajú v jednom ticku najviac jeden kamión (fyzicky sa dva nevedia nakladať naraz). */
function dockViolations(tick: number, trucks: readonly TruckLike[]): Violation4[] {
  const loadingAt = new Map<string, EntityId>();
  const found: Violation4[] = [];
  for (const truck of trucks) {
    if (truck.state !== 'loading') continue;
    const key = `${String(truck.rampId)}:${String(truck.dock)}`;
    const other = loadingAt.get(key);
    if (other !== undefined) {
      found.push({ rule: 'dock_conflict', message: `tick ${String(tick)}: kamióny ${String(other)} a ${String(truck.id)} nakladajú naraz na rampe ${String(truck.rampId)}, dock ${String(truck.dock)}` });
    }
    loadingAt.set(key, truck.id);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------
// Reťaz pohybov jednotky
// ---------------------------------------------------------------------------------------------------------

/** Celá cesta importovanej jednotky po odchod z mapy (ARCHITECTURE §7.1, kontajnery): 8 pohybov. */
export const EXPORT_CHAIN_KINDS = [
  'on_ship',
  'in_crane',
  'on_apron',
  'in_vehicle',
  'in_storage',
  'in_vehicle',
  'at_ramp',
  'in_truck',
  'exported',
] as const;

export type CargoMovedEvent = Extract<SimEvent, { type: 'CargoMoved' }>;

/** `CargoMoved` udalosti zoskupené podľa jednotky v poradí vzniku. */
export function moveChains(events: readonly TimedEvent[]): Map<number, TimedEvent<CargoMovedEvent>[]> {
  const chains = new Map<number, TimedEvent<CargoMovedEvent>[]>();
  for (const entry of timed4(events, 'CargoMoved')) {
    chains.set(entry.event.unitId, [...(chains.get(entry.event.unitId) ?? []), entry]);
  }
  return chains;
}

/**
 * Overí, že reťaz pohybov jednotky nadväzuje (`from` = predošlé `to`), ticky neklesajú a druhy lokácií sú presne
 * `EXPORT_CHAIN_KINDS` (bez preskočenia, návratu a bez pohybu po `exported`). Vráti dôvod porušenia alebo `null`.
 */
export function exportChainViolation(unitId: number, chain: readonly TimedEvent<CargoMovedEvent>[]): string | null {
  const kinds = chain.length === 0 ? [] : [chain[0].event.from.kind, ...chain.map((entry) => entry.event.to.kind)];
  if (kinds.join(' → ') !== EXPORT_CHAIN_KINDS.join(' → ')) {
    return `jednotka ${String(unitId)}: reťaz ${kinds.join(' → ')} ≠ ${EXPORT_CHAIN_KINDS.join(' → ')}`;
  }
  for (let i = 1; i < chain.length; i++) {
    if (JSON.stringify(chain[i].event.from) !== JSON.stringify(chain[i - 1].event.to)) {
      return `jednotka ${String(unitId)}, tick ${String(chain[i].tick)}: pohyb nenadväzuje na predošlý (${JSON.stringify(chain[i - 1].event.to)} → ${JSON.stringify(chain[i].event.from)})`;
    }
    if (chain[i].tick < chain[i - 1].tick) return `jednotka ${String(unitId)}: ticky pohybov klesajú (${String(chain[i - 1].tick)} → ${String(chain[i].tick)})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Stavba sveta zo scenára
// ---------------------------------------------------------------------------------------------------------

/**
 * Svet s aplikovanými príkazmi `PlaceRoad` zo scenára (moduly sa nestavajú — ich `validate` sa overuje samostatne).
 * Odmietnutý príkaz = chyba testu.
 */
export function worldWithRoads(scenario: Scenario, defs: DefRegistry = DEFS): World {
  const world = World.create(defs, MAP, scenario.seed);
  for (const { command } of scenario.commands) {
    if (command.type === 'PlaceRoad') world.enqueue(commandFromJSON(command));
  }
  const rejected = world.applyPending().filter((event) => event.type === 'CommandRejected');
  if (rejected.length > 0) throw new Error(`worldWithRoads: PlaceRoad odmietnutý: ${JSON.stringify(rejected)}`);
  return world;
}

/** Svet po ticku 1 so všetkými príkazmi ticku 0 zo scenára (cesty, moduly, nákupy, loď); odmietnutý príkaz = chyba testu. */
export function builtWorld(scenario: Scenario, defs: DefRegistry = DEFS): World {
  const world = World.create(defs, MAP, scenario.seed);
  const rejected = runScenario(world, scenario, 1).filter((event) => event.type === 'CommandRejected');
  if (rejected.length > 0) throw new Error(`builtWorld: príkaz odmietnutý: ${JSON.stringify(rejected)}`);
  return world;
}

// ---------------------------------------------------------------------------------------------------------
// Syntetické defy
// ---------------------------------------------------------------------------------------------------------

function defsWithModuleParams(defId: string, params: Readonly<Record<string, number>>): DefRegistry {
  const items = modulesJson.items.map((item) => (item.id === defId ? { ...item, params: { ...item.params, ...params } } : item));
  return DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...modulesJson, items } });
}

/** Defy s upraveným počtom stojísk čakacej plochy (napr. `bays 1` → druhý kamión sa nespawne, kým prvý neodíde k rampe). */
export const defsWithBays = (bays: number): DefRegistry => defsWithModuleParams('truck_waiting_area', { bays });

/**
 * Defy s pomalými pruhmi brány: prechod vstupným aj výstupným pruhom trvá `passTicks` tickov (OCR 40 % + kontrola 40 % + lístok 20 %, váha 40 % + sken 40 % + plomba 20 %),
 * bez náhodných problémov — veľká hodnota vynúti frontu pred pruhom.
 */
export function defsWithSlowLanes(passTicks: number): DefRegistry {
  const first = Math.round(passTicks * 0.4);
  const last = passTicks - 2 * first;
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    modules: {
      ...RAW_DEFS.modules,
      items: RAW_DEFS.modules.items.map((item) => {
        if (item.id === 'gate_in_lane') return { ...item, params: { ...item.params, ocrTicks: first, checkTicks: first, issueTicks: last, gateIssueChance: 0 } };
        if (item.id === 'gate_out_lane') return { ...item, params: { ...item.params, weighTicks: first, scanTicks: first, sealTicks: last, sealIssueChance: 0 } };
        return item;
      }),
    },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Scenár „brána sa postaví neskôr": jednotky sú už v sklade, kým rampa nie je prevádzková
// ---------------------------------------------------------------------------------------------------------

export const STRADDLES: readonly string[] = ['straddle_carrier', 'straddle_carrier', 'straddle_carrier'];

export interface LateGateOptions {
  /** Defy sveta (predvolene bundled). */
  readonly defs?: DefRegistry;
  /** Počet TEU na feederi (predvolene 12). */
  readonly units?: number;
  readonly seed?: number;
  /** Koľko tickov po naplnení skladov čakať bez brány (predvolene 300). */
  readonly holdTicks?: number;
  /** Strop tickov od postavenia brány po export všetkých jednotiek. */
  readonly maxExportTicks?: number;
}

export interface LateGateRun {
  readonly world: World;
  readonly recorder: Recorder4;
  readonly units: number;
  /** ID rampy (postavená v scenári). */
  readonly rampId: EntityId;
  /** Tick, v ktorom sa všetky jednotky ocitli v sklade. */
  readonly storedAtTick: number;
  /** `clock.tick` v okamihu, keď sa príkaz na bránu zaradil do fronty (aplikuje sa v ďalšom ticku). */
  readonly gateSentAtTick: number;
  /** Tick, v ktorom je všetkých `units` exported. */
  readonly exportedAtTick: number;
}

/**
 * Scenár `f4_late_gate`: rozloženie F4 bez brány (plocha aj rampa stoja), loď s `units` TEU. Beh: (1) kým nie sú všetky
 * jednotky v sklade, (2) `holdTicks` tickov bez brány — rampa je neprevádzková, nič neodchádza, (3) príkaz `PlaceModule`
 * brány, (4) kým nie je všetko exported. Všetko so záznamom a invariantmi po každom ticku.
 */
export function runLateGate(options: LateGateOptions = {}): LateGateRun {
  const { defs = DEFS, units = 12, seed = 4104, holdTicks = 300, maxExportTicks = 30000 } = options;
  const scenario = f4Scenario('f4_late_gate', seed, { vehicles: STRADDLES, units, landside: ['waiting_area', 'ramp', 'gate_out'] });
  const world = World.create(defs, MAP, seed);
  const recorder = new Recorder4(world, scenario);
  recorder.runUntil((w) => w.cargo.countByKind('in_storage') === units, 20000);
  const storedAtTick = world.clock.tick;
  recorder.runTo(storedAtTick + holdTicks);
  const gateSentAtTick = world.clock.tick;
  recorder.send(placeLandsideCommand('gate'));
  recorder.runUntil((w) => w.cargo.exportedCount === units, maxExportTicks);
  return { world, recorder, units, rampId: rampOf(world).id, storedAtTick, gateSentAtTick, exportedAtTick: world.clock.tick };
}

/** Vzdialenosť bunky od stredu road portálu (Manhattan, v bunkách) — poloha kamióna je stred bunky (x + 0,5). */
export function distanceToPortal(x: number, y: number): number {
  return Math.abs(x - (ROAD_PORTAL.x + 0.5)) + Math.abs(y - (ROAD_PORTAL.y + 0.5));
}

/** Výjazdový portál jednosmerného `harbor_01` (R1): bunka vedľa vjazdu, na ktorej kamióny opúšťajú mapu. */
export const ROAD_PORTAL_OUT: CellCoord = { x: 45, y: 63 };

/** Vzdialenosť bunky od stredu výjazdového portálu `ROAD_PORTAL_OUT` (Manhattan, v bunkách). */
export function distanceToExitPortal(x: number, y: number): number {
  return Math.abs(x - (ROAD_PORTAL_OUT.x + 0.5)) + Math.abs(y - (ROAD_PORTAL_OUT.y + 0.5));
}

/** Bunky `CellCoord[]` ako `x,y` — pre porovnania množín v hláškach. */
export const cellKey = (cell: CellCoord): string => `${String(cell.x)},${String(cell.y)}`;
