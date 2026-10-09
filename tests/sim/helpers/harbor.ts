/**
 * Pomocníci scenárových testov fázy 2 (T02-06, TDD): Root modul, príkazy modulov a lodí, záznam behu
 * (udalosti s tickom, vzorky lodí po každom ticku) a nezávislý audit ledgera nákladu.
 *
 * Všetko ide len cez verejné API simu (`World.create`, `world.enqueue`, `world.tick`, `world.modules`,
 * `world.ships`, `world.cargo`, udalosti) — tieto testy sa píšu proti rozhraniu z `docs/tasks/phase-02.md`
 * „Spoločné rozhrania", ešte pred implementáciou T02-02..T02-05.
 */
import type { SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { berthParams } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import type { BerthModule, CraneModule, Module } from '@sim/modules';
import type { Ship } from '@sim/ships';
import type { World } from '@sim/world';
import { assertCargoConservation } from './invariants';
import { runScenario, type Scenario, type ScenarioEntry } from './scenario';

// ---------------------------------------------------------------------------------------------------------
// Konštanty mapy harbor_01 (Root modul, ARCHITECTURE §5.3; `data/maps/harbor_01.json`)
// ---------------------------------------------------------------------------------------------------------

/** Ľavý horný roh Root berthu (`berth_standard`, rot 0): x 40–47, y 14–16. */
export const ROOT_BERTH_CELL: CellCoord = { x: 40, y: 14 };
/** Ľavý horný roh Root žeriavu (`crane_container_gantry`, rot 0): x 43–44, y 14–16, stojí na bunkách Root berthu. */
export const ROOT_CRANE_CELL: CellCoord = { x: 43, y: 14 };
/** Berth tesne vedľa Rootu (x 48–55): s Rootom tvorí skupinu dĺžky 16. */
export const EAST_BERTH_CELL: CellCoord = { x: 48, y: 14 };
/** Berth tesne pred Rootom (x 32–39): dotýka sa Rootu zľava, spolu s `EAST_BERTH_CELL` tri berthy v rade. */
export const WEST_ADJACENT_BERTH_CELL: CellCoord = { x: 32, y: 14 };
/** Berth (x 30–37) oddelený od Rootu medzerou x 38–39 → samostatná skupina. */
export const GAP_BERTH_CELL: CellCoord = { x: 30, y: 14 };
/** Druhý žeriav na Root berthe (x 45–46), vedľa Root žeriavu (x 43–44); `maxCranes` berthu je 2. */
export const SECOND_CRANE_CELL: CellCoord = { x: 45, y: 14 };

export const CONTAINER_TYPE = 'container_teu';

/**
 * Tolerancia ±1 tick pri porovnávaní trvania fáz žeriavu s `cycleTicks`: karta T02-05 určuje ⌊c/2⌋ a c − ⌊c/2⌋
 * tickov, ale nechá otvorené, či sa tick zmeny stavu počíta do fázy. Test má chytiť „okamžitý“ žeriav, nie off-by-one.
 */
export const PHASE_SLACK_TICKS = 1;

// ---------------------------------------------------------------------------------------------------------
// Príkazy a scenáre
// ---------------------------------------------------------------------------------------------------------

export function spawnShipCommand(shipClassId: string, units: number, cargoTypeId: string = CONTAINER_TYPE): SerializedCommand {
  return { type: 'SpawnShipDebug', shipClassId, cargoTypeId, units };
}

export function placeModuleCommand(defId: string, cell: CellCoord, rotation: 0 | 90 | 180 | 270 = 0): SerializedCommand {
  return { type: 'PlaceModule', defId, x: cell.x, y: cell.y, rotation };
}

export function removeModuleCommand(moduleId: EntityId): SerializedCommand {
  return { type: 'RemoveModule', moduleId };
}

export function at(atTick: number, command: SerializedCommand): ScenarioEntry {
  return { atTick, command };
}

/** Kópia scenára s pridanými príkazmi (originál z `loadScenarioFile` sa nemení). */
export function withCommands(base: Scenario, ...extra: readonly ScenarioEntry[]): Scenario {
  return { ...base, commands: [...base.commands, ...extra] };
}

/** Prázdny scenár na mape `harbor_01` — príkazy sa dodajú cez `withCommands`. */
export function emptyScenario(id: string, seed: number): Scenario {
  return { id, seed, map: 'data/maps/harbor_01.json', commands: [] };
}

// ---------------------------------------------------------------------------------------------------------
// Prístup k modulom (typované zúženie cez `kind`, bez `instanceof` na ešte neexistujúce triedy)
// ---------------------------------------------------------------------------------------------------------

/** Modul, ktorého footprint zaberá bunku; inak chyba s vysvetlením. */
export function moduleAt(world: World, cell: CellCoord): Module {
  const id = world.grid.at(cell.x, cell.y).moduleId;
  if (id === null) {
    throw new Error(`na bunke (${String(cell.x)}, ${String(cell.y)}) nestojí žiadny modul (chýba starter modul / PlaceModule?)`);
  }
  const module = world.modules.get(id);
  if (module === undefined) throw new Error(`bunka (${String(cell.x)}, ${String(cell.y)}) odkazuje na neznámy modul ${String(id)}`);
  return module;
}

export function berthAt(world: World, cell: CellCoord): BerthModule {
  const module = moduleAt(world, cell);
  if (module.kind !== 'berth') throw new Error(`na bunke (${String(cell.x)}, ${String(cell.y)}) nie je berth, ale '${module.kind}'`);
  return module as BerthModule;
}

/** Všetky žeriavy v poradí umiestnenia. */
export function cranesOf(world: World): CraneModule[] {
  return [...world.modules.values()].filter((module): module is CraneModule => module.kind === 'crane');
}

/** Hodnota alebo chyba s popisom — náhrada `!` v testoch, aby zlyhanie hovorilo, čo chýba. */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`očakávané: ${what}`);
  return value;
}

export function craneById(world: World, craneId: EntityId): CraneModule {
  const module = world.modules.get(craneId);
  if (module?.kind !== 'crane') throw new Error(`modul ${String(craneId)} nie je žeriav`);
  return module as CraneModule;
}

/** Počet slotov apronu berthu podľa defu (nie podľa implementácie `ApronBuffer`). */
export function apronCapacity(berth: BerthModule): number {
  return berthParams(berth.def).apronSlots;
}

// ---------------------------------------------------------------------------------------------------------
// Záznam behu
// ---------------------------------------------------------------------------------------------------------

/** Udalosť s tickom (`clock.tick` po `world.tick()`) a hernou hodinou, v ktorej vznikla. */
export interface TimedEvent<E extends SimEvent = SimEvent> {
  readonly tick: number;
  /** `world.clock.gameHour` v okamihu záznamu — hodina, do ktorej patrí udalosť. */
  readonly hour: number;
  readonly event: E;
}

/** Stav lode na konci jedného ticku. */
export interface ShipSample {
  readonly tick: number;
  readonly shipId: EntityId;
  readonly classId: string;
  readonly state: Ship['state'];
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly berthIds: readonly EntityId[];
  /** `dockedShipId` každého obsadeného berthu (rovnaké poradie ako `berthIds`). */
  readonly berthDockedShipIds: readonly (EntityId | null)[];
  /** Počet jednotiek `on_ship` (podľa ledgera). */
  readonly unitsOnBoard: number;
}

export interface RunLog {
  /** Všetky udalosti v poradí vzniku, s tickom a hodinou. */
  readonly events: readonly TimedEvent[];
  /** Vzorky každej lode po každom ticku, kým existovala v `world.ships`. */
  readonly ships: ReadonlyMap<EntityId, readonly ShipSample[]>;
  /** Počet tickov, po ktorých bežali invarianty (ledger audit). */
  readonly ticksChecked: number;
}

export interface RunOptions {
  /** Voliteľný hák po každom ticku (po invariantoch). */
  readonly onTick?: (world: World, events: readonly SimEvent[]) => void;
}

/**
 * Prehrá scenár po absolútny tick `untilTick` a zaznamená udalosti a vzorky lodí. Po **každom** ticku volá
 * `assertCargoConservation(world)` (CLAUDE.md, pravidlo 2) a nezávislý `auditLedger(world)`.
 */
export function recordRun(world: World, scenario: Scenario, untilTick: number, options: RunOptions = {}): RunLog {
  const events: TimedEvent[] = [];
  const ships = new Map<EntityId, ShipSample[]>();
  let ticksChecked = 0;

  runScenario(world, scenario, untilTick, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      auditLedger(w);
      ticksChecked += 1;

      for (const event of tickEvents) events.push({ tick: w.clock.tick, hour: w.clock.gameHour, event });
      for (const ship of w.ships.values()) {
        const list = ships.get(ship.id) ?? [];
        list.push(sampleShip(w, ship));
        ships.set(ship.id, list);
      }
      options.onTick?.(w, tickEvents);
    },
  });
  return { events, ships, ticksChecked };
}

function sampleShip(world: World, ship: Ship): ShipSample {
  return {
    tick: world.clock.tick,
    shipId: ship.id,
    classId: ship.classId,
    state: ship.state,
    x: ship.x,
    y: ship.y,
    heading: ship.heading,
    berthIds: [...ship.berthIds],
    berthDockedShipIds: ship.berthIds.map((berthId) => {
      const module = world.modules.get(berthId);
      return module?.kind === 'berth' ? (module as BerthModule).dockedShipId : null;
    }),
    unitsOnBoard: world.cargo.unitsOnShip(ship.id).length,
  };
}

/**
 * Behá po jednom ticku, kým `predicate(world)` nie je splnený (kontrola pred každým tickom vrátane prvého);
 * nesplnenie do `maxTicks` je chyba. Invarianty ako `recordRun`.
 */
export function runUntil(world: World, scenario: Scenario, predicate: (world: World) => boolean, maxTicks: number): void {
  const limit = world.clock.tick + maxTicks;
  while (!predicate(world)) {
    if (world.clock.tick >= limit) throw new Error(`runUntil: podmienka nenastala do ${String(maxTicks)} tickov (tick ${String(world.clock.tick)})`);
    runScenario(world, scenario, world.clock.tick + 1, {
      afterTick: (w) => {
        assertCargoConservation(w);
        auditLedger(w);
      },
    });
  }
}

export function timedOfType<T extends SimEvent['type']>(log: RunLog, type: T): TimedEvent<Extract<SimEvent, { type: T }>>[] {
  return log.events.filter((entry): entry is TimedEvent<Extract<SimEvent, { type: T }>> => entry.event.type === type);
}

/** ID prvej lode zo `ShipSpawned` (poradie spawnu = poradie ID). */
export function spawnedShipIds(log: RunLog): EntityId[] {
  return timedOfType(log, 'ShipSpawned').map((entry) => entry.event.shipId as EntityId);
}

export function samplesOf(log: RunLog, shipId: EntityId): readonly ShipSample[] {
  const samples = log.ships.get(shipId);
  if (samples === undefined) throw new Error(`loď ${String(shipId)} sa v behu nikdy neobjavila v world.ships`);
  return samples;
}

/** Prvá vzorka lode v danom stave; `undefined`, ak ho loď nikdy nemala. */
export function firstSampleInState(samples: readonly ShipSample[], state: ShipSample['state']): ShipSample | undefined {
  return samples.find((sample) => sample.state === state);
}

/** Stavy lode za sebou bez opakovaní: `inbound, inbound, docked` → `['inbound', 'docked']`. */
export function stateSequence(samples: readonly ShipSample[]): ShipSample['state'][] {
  const sequence: ShipSample['state'][] = [];
  for (const sample of samples) {
    if (sequence[sequence.length - 1] !== sample.state) sequence.push(sample.state);
  }
  return sequence;
}

/**
 * Poradie stavov FSM lode (karta T02-05, ADR-029): `arriving → inbound`, `inbound → waiting_anchorage | berthing`,
 * `waiting_anchorage → berthing`, `berthing → docked`, `docked → undocking`, `undocking → outbound`,
 * `outbound → despawned`.
 * Ostro rastúci rank = žiadny návrat a žiadne opakovanie; preskočiť stav sa smie len tak, ako to tabuľka dovoľuje
 * (vzorka po ticku nemusí zachytiť stav, ktorý trval < 1 tick), preto sa kontroluje len monotónnosť.
 */
const SHIP_STATE_RANK: Readonly<Record<string, number>> = {
  arriving: 0,
  inbound: 1,
  waiting_anchorage: 2,
  berthing: 3,
  docked: 4,
  undocking: 5,
  outbound: 6,
  despawned: 7,
};

/** Vráti dôvod porušenia, alebo `null`, ak sekvencia stavov zodpovedá FSM lode. */
export function shipStateSequenceViolation(sequence: readonly string[]): string | null {
  for (let i = 0; i < sequence.length; i++) {
    if (SHIP_STATE_RANK[sequence[i]] === undefined) return `neznámy stav '${sequence[i]}'`;
    if (i > 0 && SHIP_STATE_RANK[sequence[i]] <= SHIP_STATE_RANK[sequence[i - 1]]) {
      return `neplatný prechod ${sequence[i - 1]} → ${sequence[i]} (sekvencia: ${sequence.join(' → ')})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Audit ledgera nezávislý od implementácie `assertConservation()`
// ---------------------------------------------------------------------------------------------------------

/** Lokácie, ktoré vo fáze 2 nesmú mať žiadnu jednotku (vozidlá, sklady, rampy a export prídu v ďalších fázach). */
const LOCATION_KINDS_AFTER_APRON = ['in_vehicle', 'in_storage', 'in_pipeline', 'in_truck', 'in_train', 'exported'] as const;

export interface LedgerAudit {
  readonly onShip: number;
  readonly inCrane: number;
  readonly onApron: number;
}

/**
 * Prejde loď po lodi a berth po berthe cez `unitsOnShip` / `unitsOnApron`, porovná s `cargo.get(id).location`
 * a s počítadlami. Overuje, že: žiadna jednotka nie je v dvoch zoznamoch, `location` zodpovedá zoznamu,
 * sloty apronu sú jedinečné a v rozsahu, `createdCount` = súčet jednotiek na lodiach + v žeriavoch + na aprone
 * (nič nevzniklo ani nezmizlo) a vo F2 nič nepokračuje za apron.
 */
export function auditLedger(world: World): LedgerAudit {
  const { cargo } = world;
  const owner = new Map<number, string>();
  const claim = (unitId: EntityId, where: string): void => {
    const previous = owner.get(unitId);
    if (previous !== undefined) throw new Error(`audit: jednotka ${String(unitId)} je naraz v '${previous}' aj v '${where}'`);
    owner.set(unitId, where);
  };

  let onShip = 0;
  for (const ship of world.ships.values()) {
    for (const unitId of cargo.unitsOnShip(ship.id)) {
      claim(unitId, `on_ship(${String(ship.id)})`);
      const location = cargo.get(unitId)?.location;
      if (location?.kind !== 'on_ship' || location.shipId !== ship.id) {
        throw new Error(`audit: jednotka ${String(unitId)} je v zozname lode ${String(ship.id)}, ale location = ${JSON.stringify(location)}`);
      }
      onShip += 1;
    }
  }

  let onApron = 0;
  for (const module of world.modules.values()) {
    if (module.kind !== 'berth') continue;
    const capacity = apronCapacity(module as BerthModule);
    const slots = new Set<number>();
    let onThisApron = 0;
    for (const unitId of cargo.unitsOnApron(module.id)) {
      claim(unitId, `on_apron(${String(module.id)})`);
      const location = cargo.get(unitId)?.location;
      if (location?.kind !== 'on_apron' || location.berthId !== module.id) {
        throw new Error(`audit: jednotka ${String(unitId)} je na aprone ${String(module.id)}, ale location = ${JSON.stringify(location)}`);
      }
      if (!Number.isInteger(location.slot) || location.slot < 0 || location.slot >= capacity) {
        throw new Error(`audit: jednotka ${String(unitId)} má slot ${String(location.slot)} mimo 0..${String(capacity - 1)}`);
      }
      if (slots.has(location.slot)) throw new Error(`audit: slot ${String(location.slot)} apronu ${String(module.id)} je obsadený dvakrát`);
      slots.add(location.slot);
      onThisApron += 1;
    }
    if (onThisApron > capacity) throw new Error(`audit: apron ${String(module.id)} má ${String(onThisApron)} jednotiek nad kapacitu ${String(capacity)}`);
    onApron += onThisApron;
  }

  const inCrane = cargo.countByKind('in_crane');
  if (inCrane > cranesOf(world).length) {
    throw new Error(`audit: ${String(inCrane)} jednotiek v žeriavoch, ale žeriavov je ${String(cranesOf(world).length)}`);
  }
  if (cargo.countByKind('on_ship') !== onShip) {
    throw new Error(`audit: countByKind('on_ship') = ${String(cargo.countByKind('on_ship'))}, zoznamy lodí obsahujú ${String(onShip)}`);
  }
  if (cargo.countByKind('on_apron') !== onApron) {
    throw new Error(`audit: countByKind('on_apron') = ${String(cargo.countByKind('on_apron'))}, zoznamy aprónov obsahujú ${String(onApron)}`);
  }
  for (const kind of LOCATION_KINDS_AFTER_APRON) {
    if (cargo.countByKind(kind) !== 0) throw new Error(`audit: vo F2 nemá byť žiadna jednotka '${kind}', je ich ${String(cargo.countByKind(kind))}`);
  }
  if (cargo.exportedCount !== 0) throw new Error(`audit: exportedCount = ${String(cargo.exportedCount)}, vo F2 sa nič neexportuje`);
  if (cargo.createdCount !== onShip + inCrane + onApron) {
    throw new Error(
      `audit: createdCount = ${String(cargo.createdCount)}, ale nájdených jednotiek ${String(onShip + inCrane + onApron)} ` +
        `(loď ${String(onShip)}, žeriav ${String(inCrane)}, apron ${String(onApron)}) — náklad vznikol alebo zmizol`,
    );
  }
  return { onShip, inCrane, onApron };
}
