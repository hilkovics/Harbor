/**
 * Konzervácia nákladu vo fáze 3 (T03-07, TDD; CLAUDE.md pravidlo 2, ARCHITECTURE §6 krok 12, §7.1, §16): po **každom**
 * ticku beží `assertCargoConservation(world)` (+ nezávislý `auditLedgerF3` a `auditJobs` z `recordRunF3`) a k tomu:
 *  - `createdCount === živé + exported`, žiadna jednotka nie je naraz v dvoch lokáciách, nič nevzniká ani nezaniká,
 *  - vozidlo drží najviac `capacityUnits` a jeho stav zodpovedá nákladu (`idle`/`to_pickup` prázdne, `to_dropoff` s jednou
 *    jednotkou, job ↔ stav),
 *  - reťaz pohybov každej jednotky nadväzuje a smie ísť len `on_ship → in_crane → on_apron → in_vehicle → in_storage`,
 *  - `CargoLedger.move` cez verejné API odmietne teleport (napr. `on_apron → in_storage`) bez zmeny stavu a bez udalosti,
 *  - jednotka `in_vehicle` u neexistujúceho vozidla porušuje invariant sveta aj obnovu zo save (`CARGO_HOLDER_SOURCES`).
 *
 * Testy idú len cez verejné API a JSON príkazy; časové hranice sú horné, nie presné ticky.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CargoTransitionError, type CargoLocation, type CargoLocationKind } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { World, WorldInvariantError, type WorldState } from '@sim/world';
import { FAR_YARD_ORIGIN, NEAR_YARD_ORIGIN, f3Scenario } from '../helpers/f3-layout';
import {
  boughtVehicleIds,
  defsWithYardCapacity,
  recordRunF3,
  rootBerthOf,
  runUntilF3,
  storageAt,
  storageCapacity,
  timed3,
  vehiclesById,
  vehiclesOf,
  type RunLog3,
} from '../helpers/f3';
import { must, type TimedEvent } from '../helpers/harbor';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, stateHash } from '../helpers/scenario';
import { DEFS, MAP } from '../world/world-fixtures';

const RUN_TICKS = 4000;
const UNITS = 120;

/** Všetky druhy lokácií z ARCHITECTURE §7.1 okrem konečného `exported`. */
const LIVE_KINDS: readonly CargoLocationKind[] = [
  'on_ship',
  'in_crane',
  'on_apron',
  'in_vehicle',
  'in_storage',
  'in_pipeline',
  'at_ramp',
  'in_truck',
  'in_train',
];

/** Prechody, ktoré sa vo F3 môžu reálne stať (export, potrubia a rampy prídu neskôr). */
const F3_TRANSITIONS: readonly (readonly [CargoLocationKind, CargoLocationKind])[] = [
  ['on_ship', 'in_crane'],
  ['in_crane', 'on_apron'],
  ['on_apron', 'in_vehicle'],
  ['in_vehicle', 'in_storage'],
];

type CargoMovedEvent = Extract<SimEvent, { type: 'CargoMoved' }>;

/** Záznam ledgera po jednom ticku: počty podľa lokácie a počítadlá. */
interface LedgerSample {
  readonly tick: number;
  readonly created: number;
  readonly live: number;
  readonly exported: number;
  readonly onShip: number;
  readonly onApron: number;
  readonly inVehicle: number;
  readonly inStorage: number;
}

/**
 * Vzorka ledgera + kontrola vozidiel po jednom ticku: vozidlo drží najviac `capacityUnits`, `idle`/`to_pickup` je
 * prázdne, `to_dropoff` vezie práve jednu jednotku (unese 1) a stav ↔ `jobId` (`idle` bez jobu, ostatné aktívne stavy
 * s jobom). `loading`/`unloading` sa nekontroluje (jednotka sa presúva až na konci pobytu, tick presunu môže byť
 * ešte v pôvodnom stave).
 */
function sampleLedger(world: World, problems: string[]): LedgerSample {
  const { cargo } = world;
  const live = LIVE_KINDS.reduce((sum, kind) => sum + cargo.countByKind(kind), 0);
  const tick = world.clock.tick;
  for (const vehicle of vehiclesOf(world).values()) {
    const held = cargo.countAt('in_vehicle', vehicle.id);
    const where = `tick ${String(tick)}, vozidlo ${String(vehicle.id)} (${vehicle.state})`;
    if (held > vehicle.def.capacityUnits) problems.push(`${where}: drží ${String(held)} jednotiek nad kapacitu ${String(vehicle.def.capacityUnits)}`);
    if ((vehicle.state === 'idle' || vehicle.state === 'to_pickup') && held !== 0) problems.push(`${where}: nemá vezť náklad, drží ${String(held)}`);
    if (vehicle.state === 'to_dropoff' && held !== 1) problems.push(`${where}: má vezť práve 1 jednotku, drží ${String(held)}`);
    if (vehicle.state === 'idle' && vehicle.jobId !== null) problems.push(`${where}: idle má jobId ${String(vehicle.jobId)}`);
    const busy = vehicle.state === 'to_pickup' || vehicle.state === 'loading' || vehicle.state === 'to_dropoff' || vehicle.state === 'unloading';
    if (busy && vehicle.jobId === null) problems.push(`${where}: aktívny stav bez jobu`);
  }
  return {
    tick,
    created: cargo.createdCount,
    live,
    exported: cargo.exportedCount,
    onShip: cargo.countByKind('on_ship'),
    onApron: cargo.countByKind('on_apron'),
    inVehicle: cargo.countByKind('in_vehicle'),
    inStorage: cargo.countByKind('in_storage'),
  };
}

/** `CargoMoved` udalosti zoskupené podľa jednotky v poradí vzniku. */
function moveChains(log: RunLog3): Map<number, TimedEvent<CargoMovedEvent>[]> {
  const chains = new Map<number, TimedEvent<CargoMovedEvent>[]>();
  for (const entry of timed3(log, 'CargoMoved')) chains.set(entry.event.unitId, [...(chains.get(entry.event.unitId) ?? []), entry]);
  return chains;
}

/** Reťaz pohybov každej jednotky nadväzuje, začína `on_ship` a používa len povolené F3 prechody. */
function expectContiguousChains(log: RunLog3): void {
  for (const [unitId, chain] of moveChains(log)) {
    let expectedFrom: CargoLocation | null = null;
    for (const { event, tick } of chain) {
      const where = `jednotka ${String(unitId)}, tick ${String(tick)}`;
      if (expectedFrom === null) expect(event.from.kind, `${where}: prvý pohyb`).toBe('on_ship');
      else expect(event.from, `${where}: nadväznosť na predošlý pohyb`).toEqual(expectedFrom);
      expect(
        F3_TRANSITIONS.some(([from, to]) => from === event.from.kind && to === event.to.kind),
        `${where}: ${event.from.kind} → ${event.to.kind}`,
      ).toBe(true);
      expectedFrom = event.to;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// apron_to_yard: prvých 4 000 tickov
// ---------------------------------------------------------------------------------------------------------

describe('konzervácia nákladu: apron_to_yard, prvých 4 000 tickov (loď, žeriav, vozidlá, dvory)', () => {
  const scenario = loadScenarioFile('apron_to_yard');
  const samples: LedgerSample[] = [];
  const problems: string[] = [];
  let world: World;
  let log: RunLog3;
  let vehicleIds: EntityId[];

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    // `recordRunF3` po každom ticku volá `assertCargoConservation(world)`, `auditLedgerF3` aj `auditJobs`.
    log = recordRunF3(world, scenario, RUN_TICKS, { onTick: (w) => samples.push(sampleLedger(w, problems)) });
    vehicleIds = boughtVehicleIds(log);
  }, 120_000);

  it('assertCargoConservation(world) prešla po každom zo 4 000 tickov (svet má ledger)', () => {
    expect(world.clock.tick).toBe(RUN_TICKS);
    expect(log.ticksChecked).toBe(RUN_TICKS);
    expect(samples).toHaveLength(RUN_TICKS);
    expect(() => assertCargoConservation(world)).not.toThrow();
    expect(() => world.cargo.assertConservation()).not.toThrow();
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('createdCount = živé + exported po každom ticku, exported ostáva 0 a súčet po lokáciách sedí', () => {
    for (const sample of samples) {
      const where = `tick ${String(sample.tick)}`;
      expect(sample.created, where).toBe(sample.live + sample.exported);
      expect(sample.exported, where).toBe(0);
      expect(sample.onShip + sample.onApron + sample.inVehicle + sample.inStorage, where).toBeLessThanOrEqual(sample.live);
    }
  });

  it('createdCount rastie iba spawnom lode: 0 → 120 (tick 0), potom je konštantne 120', () => {
    for (const sample of samples.filter((s) => s.tick >= 2)) expect(sample.created, `tick ${String(sample.tick)}`).toBe(UNITS);
    expect(world.cargo.createdCount).toBe(UNITS);
    expect(timed3(log, 'ShipSpawned').map((entry) => entry.event.units)).toEqual([UNITS]);
    expect(timed3(log, 'CommandRejected')).toEqual([]);
  });

  it('jednotiek v sklade nikdy neubudne (vo F3 sa nič nevyváža) a rastú aj počas jázd; časť nákladu je v tom istom čase vo vozidlách', () => {
    let previous = 0;
    for (const sample of samples) {
      expect(sample.inStorage, `tick ${String(sample.tick)}`).toBeGreaterThanOrEqual(previous);
      previous = sample.inStorage;
    }
    expect(previous).toBeGreaterThan(0);
    expect(Math.max(...samples.map((sample) => sample.inVehicle))).toBeGreaterThan(0);
    expect(Math.max(...samples.map((sample) => sample.inVehicle))).toBeLessThanOrEqual(vehicleIds.length * DEFS.vehicles.get('straddle_carrier').capacityUnits);
  });

  it('vozidlo drží najviac capacityUnits a jeho stav zodpovedá nákladu a jobu po každom ticku (sampleLedger)', () => {
    expect(problems).toEqual([]);
    expect(vehicleIds).toHaveLength(2);
  });

  it('pohyby: každá jednotka ide len on_ship → in_crane → on_apron → in_vehicle → in_storage, bez návratu a preskakovania', () => {
    expectContiguousChains(log);
    for (const [unitId, chain] of moveChains(log)) {
      expect(chain.length, `jednotka ${String(unitId)}`).toBeLessThanOrEqual(4);
      const kinds = chain.map((entry) => entry.event.to.kind);
      expect(new Set(kinds).size, `jednotka ${String(unitId)} sa vrátila do lokácie`).toBe(kinds.length);
    }
  });

  it('in_vehicle vždy odkazuje na kúpené vozidlo a in_storage na dvor (kind storage) s slotom v rozsahu kapacity', () => {
    const yards = new Set([storageAt(world, NEAR_YARD_ORIGIN).id, storageAt(world, FAR_YARD_ORIGIN).id]);
    let stored = 0;
    for (const { event } of timed3(log, 'CargoMoved')) {
      if (event.to.kind === 'in_vehicle') expect(vehicleIds).toContain(event.to.vehicleId);
      if (event.to.kind === 'in_storage') {
        expect(yards.has(event.to.moduleId)).toBe(true);
        expect(event.to.slot).toBeGreaterThanOrEqual(0);
        expect(event.to.slot).toBeLessThan(storageCapacity(must(world.modules.get(event.to.moduleId), 'dvor')));
        stored += 1;
      }
    }
    expect(stored).toBe(world.cargo.countByKind('in_storage'));
  });

  it('jednotka sa nikdy nevyskytne v dvoch lokáciách: ledger zoznamy vozidiel a dvorov sú disjunktné a jedinečné', () => {
    const all: EntityId[] = [];
    for (const id of vehicleIds) all.push(...world.cargo.unitsAt('in_vehicle', id));
    for (const module of world.modules.values()) if (module.kind === 'storage') all.push(...world.cargo.unitsAt('in_storage', module.id));
    all.push(...world.cargo.unitsOnApron(rootBerthOf(world).id));
    for (const ship of world.ships.values()) all.push(...world.cargo.unitsOnShip(ship.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length + world.cargo.countByKind('in_crane')).toBe(UNITS);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Bohatší tok: plné dvory, jednotka ostáva na aprone
// ---------------------------------------------------------------------------------------------------------

describe('konzervácia nákladu: dvory s kapacitou 3 a 7 jednotiek (jedna ostane na aprone)', () => {
  const RUN = 4000;
  const scenario = f3Scenario('f3_conservation_full', 3301, { vehicles: ['straddle_carrier', 'straddle_carrier'], units: 7 });
  const samples: LedgerSample[] = [];
  const problems: string[] = [];
  let world: World;
  let log: RunLog3;

  beforeAll(() => {
    world = World.create(defsWithYardCapacity(3), MAP, scenario.seed);
    log = recordRunF3(world, scenario, RUN, { onTick: (w) => samples.push(sampleLedger(w, problems)) });
  }, 120_000);

  it('konzervácia platí po každom ticku aj pri jednotke, ktorá nemá kam ísť', () => {
    expect(timed3(log, 'CommandRejected')).toEqual([]);
    expect(log.ticksChecked).toBe(RUN);
    for (const sample of samples) expect(sample.created, `tick ${String(sample.tick)}`).toBe(sample.live + sample.exported);
    expect(problems).toEqual([]);
  });

  it('konečný stav: 6 v dvoroch (po 3), 1 na aprone, nič vo vozidlách ani na lodi; súčet 7 = createdCount', () => {
    expect(world.cargo.createdCount).toBe(7);
    expect(world.cargo.countByKind('in_storage')).toBe(6);
    expect(world.cargo.countByKind('on_apron')).toBe(1);
    expect(world.cargo.countByKind('in_vehicle')).toBe(0);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(world.cargo.countByKind('in_crane')).toBe(0);
    expect(world.cargo.countAt('in_storage', storageAt(world, NEAR_YARD_ORIGIN).id)).toBe(3);
    expect(world.cargo.countAt('in_storage', storageAt(world, FAR_YARD_ORIGIN).id)).toBe(3);
  });

  it('reťaz pohybov: 6 jednotiek prešlo celou cestou do dvora, siedma skončila na on_apron; nič nepreskočilo vozidlo', () => {
    expectContiguousChains(log);
    const lengths = [...moveChains(log).values()].map((chain) => chain.length).sort((a, b) => a - b);
    expect(lengths).toEqual([2, 4, 4, 4, 4, 4, 4]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// CargoLedger.move a World.assertInvariants cez verejné API
// ---------------------------------------------------------------------------------------------------------

describe('CargoLedger.move a invarianty sveta: teleport a neexistujúci držiteľ sa odmietnu', () => {
  const scenario = loadScenarioFile('apron_to_yard');

  /** Svet uprostred prevozu: aspoň jedna jednotka na aprone a aspoň jedna vo vozidle. */
  function busyWorld(): { world: World; apronUnit: EntityId; vehicleUnit: EntityId; vehicleId: EntityId; berthId: EntityId; yardId: EntityId } {
    const world = World.create(DEFS, MAP, scenario.seed);
    runUntilF3(world, scenario, (w) => w.cargo.countByKind('in_vehicle') >= 1 && w.cargo.countByKind('on_apron') >= 1, 6000);
    const berthId = rootBerthOf(world).id;
    const vehicle = must(
      vehiclesById(world).find((candidate) => world.cargo.countAt('in_vehicle', candidate.id) > 0),
      'vozidlo s nákladom',
    );
    return {
      world,
      apronUnit: must(world.cargo.unitsOnApron(berthId)[0], 'jednotka na aprone'),
      vehicleUnit: must(world.cargo.unitsAt('in_vehicle', vehicle.id)[0], 'jednotka vo vozidle'),
      vehicleId: vehicle.id,
      berthId,
      yardId: storageAt(world, NEAR_YARD_ORIGIN).id,
    };
  }

  it('on_apron → in_storage (preskočenie vozidla) vyhodí CargoTransitionError; jednotka ostáva na aprone, stav sa nezmení a nevznikne CargoMoved', () => {
    const { world, apronUnit, berthId, yardId } = busyWorld();
    const location = must(world.cargo.get(apronUnit), 'jednotka').location;
    const before = stateHash(world);

    expect(() => world.cargo.move(apronUnit, { kind: 'in_storage', moduleId: yardId, slot: 60 })).toThrow(CargoTransitionError);

    expect(world.cargo.get(apronUnit)?.location).toEqual(location);
    expect(world.cargo.unitsOnApron(berthId)).toContain(apronUnit);
    expect(stateHash(world)).toBe(before);
    assertCargoConservation(world);
    expect(world.events.flush().filter((event) => event.type === 'CargoMoved')).toEqual([]);
  });

  it.each<{ name: string; target: (ids: { berthId: EntityId; yardId: EntityId }) => CargoLocation }>([
    // `in_vehicle → on_apron` je od F6a povolený (export na apron, ADR-032) a `in_vehicle → in_crane` od ADR-033 (nakládka
    // pod hákom); vrátenie na loď bez žeriava nie.
    { name: 'in_vehicle → on_ship (preskočenie žeriava)', target: () => ({ kind: 'on_ship', shipId: 2 as EntityId }) },
    { name: 'in_vehicle → exported (preskočenie celého reťazca)', target: () => ({ kind: 'exported' }) },
  ])('$name vyhodí CargoTransitionError a jednotka ostáva vo vozidle', ({ target }) => {
    const { world, vehicleUnit, vehicleId, berthId, yardId } = busyWorld();
    const before = stateHash(world);
    expect(() => world.cargo.move(vehicleUnit, target({ berthId, yardId }))).toThrow(CargoTransitionError);
    expect(world.cargo.get(vehicleUnit)?.location).toEqual({ kind: 'in_vehicle', vehicleId });
    expect(stateHash(world)).toBe(before);
    assertCargoConservation(world);
  });

  it('konzistentný svet uprostred prevozu spĺňa invarianty (jednotka vo vozidle má držiteľa)', () => {
    const { world } = busyWorld();
    expect(world.cargo.countByKind('in_vehicle')).toBeGreaterThanOrEqual(1);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('jednotka presunutá do neexistujúceho vozidla porušuje invariant sveta (WorldInvariantError)', () => {
    const { world, apronUnit } = busyWorld();
    const missingVehicleId = 999_999 as EntityId;
    expect(vehiclesOf(world).has(missingVehicleId)).toBe(false);
    // `on_apron → in_vehicle` je povolený prechod ledgera; existenciu držiteľa strážia invarianty sveta (krok 12).
    world.cargo.move(apronUnit, { kind: 'in_vehicle', vehicleId: missingVehicleId });
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
  });

  it('obnova zo save odmietne jednotku in_vehicle, ktorej vozidlo v stave chýba (držiteľ sa overuje voči existencii vozidla)', () => {
    const { world } = busyWorld();
    const saved = JSON.parse(JSON.stringify(world.serialize())) as Record<string, unknown>;
    // Predpoklad: WorldState v3 má na vrchu polia `vehicles` a `jobs` (pole záznamov) — karta T03-04/T03-05.
    expect(Array.isArray(saved['vehicles'])).toBe(true);
    saved['vehicles'] = [];
    saved['jobs'] = [];
    expect(() => World.deserialize(DEFS, MAP, saved as unknown as WorldState)).toThrow(/in_vehicle|vozidl/i);
  });
});
