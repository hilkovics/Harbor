/**
 * Konzervácia nákladu vo fáze 4 (T04-05, TDD; CLAUDE.md pravidlo 2, ARCHITECTURE §6 krok 12, §7.1, §16): po **každom**
 * ticku beží `assertCargoConservation(world)` (+ nezávislý `auditLedgerF4` a `auditJobsF4` z `Recorder4`) a k tomu:
 *  - `createdCount === živé + exported`, žiadna jednotka nie je naraz v dvoch lokáciách, nič nevzniká ani nezaniká,
 *  - `exported` rastie výlučne pri `TruckExited` (počet jednotiek udalosti = prírastok počítadla) a je konečný stav,
 *  - kamión drží najviac `capacityUnits` a jeho stav zodpovedá nákladu (pred nakládkou prázdny, po nej plný),
 *  - reťaz pohybov každej jednotky nadväzuje a ide presne `on_ship → in_crane → on_apron → in_vehicle → in_storage →
 *    in_vehicle → at_ramp → in_truck → exported`,
 *  - `CargoLedger.move` cez verejné API odmietne teleport (`in_storage → at_ramp`, `at_ramp → exported`, `in_truck →
 *    at_ramp`…) bez zmeny stavu a bez udalosti,
 *  - jednotka `at_ramp` / `in_truck` u neexistujúceho držiteľa porušuje invariant sveta aj obnovu zo save.
 *
 * Testy idú len cez verejné API a JSON príkazy; časové hranice sú horné, nie presné ticky.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CargoError, CargoTransitionError, type CargoLocation, type CargoLocationKind } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { rampParams } from '@sim/defs';
import { World, WorldInvariantError, type WorldState } from '@sim/world';
import { f3Scenario } from '../helpers/f3-layout';
import { runUntilF3, storageModulesOf } from '../helpers/f3';
import { f4Scenario } from '../helpers/f4-layout';
import {
  Recorder4,
  STRADDLES,
  exportChainViolation,
  landsideEvents,
  moveChains,
  rampOf,
  timed4,
  trucksById,
} from '../helpers/f4';
import { must } from '../helpers/harbor';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, stateHash } from '../helpers/scenario';
import { DEFS, MAP } from '../world/world-fixtures';

const UNITS = 12;
const MAX_TICKS = 20_000;
const RUN_TIMEOUT_MS = 180_000;

const scenario = f4Scenario('f4_conservation', 4404, { vehicles: STRADDLES, units: UNITS });
const RAMP_PARAMS = rampParams(DEFS.modules.get('loading_ramp_container'));
const STAGING_TOTAL = RAMP_PARAMS.docks * RAMP_PARAMS.stagingPerDock;
const TRUCK_CAPACITY = DEFS.trucks.get('truck_container').capacityUnits;

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

/** Prechody, ktoré sa vo F4 môžu reálne stať (potrubia a vlaky prídu neskôr). */
const F4_TRANSITIONS: readonly (readonly [CargoLocationKind, CargoLocationKind])[] = [
  ['on_ship', 'in_crane'],
  ['in_crane', 'on_apron'],
  ['on_apron', 'in_vehicle'],
  ['in_vehicle', 'in_storage'],
  ['in_storage', 'in_vehicle'],
  ['in_vehicle', 'at_ramp'],
  ['at_ramp', 'in_truck'],
  ['in_truck', 'exported'],
];

/** Záznam ledgera po jednom ticku: počty podľa lokácie a počítadlá. */
interface LedgerSample {
  readonly tick: number;
  readonly created: number;
  readonly live: number;
  readonly exported: number;
  readonly inVehicle: number;
  readonly inStorage: number;
  readonly atRamp: number;
  readonly inTruck: number;
  readonly trucks: number;
}

function sampleLedger(world: World): LedgerSample {
  const { cargo } = world;
  return {
    tick: world.clock.tick,
    created: cargo.createdCount,
    live: LIVE_KINDS.reduce((sum, kind) => sum + cargo.countByKind(kind), 0),
    exported: cargo.exportedCount,
    inVehicle: cargo.countByKind('in_vehicle'),
    inStorage: cargo.countByKind('in_storage'),
    atRamp: cargo.countByKind('at_ramp'),
    inTruck: cargo.countByKind('in_truck'),
    trucks: trucksById(world).length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Celý reťazec: 12 TEU od lode po export
// ---------------------------------------------------------------------------------------------------------

describe('konzervácia nákladu: loď → žeriav → apron → vozidlá → dvor → rampa → kamión → export (12 TEU)', () => {
  const samples: LedgerSample[] = [];
  let world: World;
  let recorder: Recorder4;

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    // `Recorder4` po každom ticku volá `assertCargoConservation(world)`, `auditLedgerF4` aj `auditJobsF4`.
    recorder = new Recorder4(world, scenario, { onTick: (w) => samples.push(sampleLedger(w)) });
    recorder.runTo(MAX_TICKS, (w) => w.cargo.exportedCount === UNITS);
    recorder.runTo(world.clock.tick + 200);
  }, RUN_TIMEOUT_MS);

  it('assertCargoConservation(world) prešla po každom ticku behu (svet má ledger a invarianty sveta držia)', () => {
    expect(recorder.ticksChecked).toBe(world.clock.tick);
    expect(samples).toHaveLength(world.clock.tick);
    expect(() => assertCargoConservation(world)).not.toThrow();
    expect(() => world.cargo.assertConservation()).not.toThrow();
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('createdCount = živé + exported po každom ticku; súčet je konštantný 12 od ticku 2 (rastie len spawnom lode)', () => {
    for (const sample of samples) expect(sample.created, `tick ${String(sample.tick)}`).toBe(sample.live + sample.exported);
    for (const sample of samples.filter((entry) => entry.tick >= 2)) expect(sample.created, `tick ${String(sample.tick)}`).toBe(UNITS);
    expect(timed4(recorder.events, 'ShipSpawned').map((entry) => entry.event.units)).toEqual([UNITS]);
    expect(timed4(recorder.events, 'CommandRejected')).toEqual([]);
  });

  it('exported nikdy neklesá a rastie iba pri TruckExited: prírastok počítadla v ticku = súčet units udalostí TruckExited v tom ticku', () => {
    const exitedAt = new Map<number, number>();
    for (const entry of landsideEvents(recorder.events, 'TruckExited')) exitedAt.set(entry.tick, (exitedAt.get(entry.tick) ?? 0) + entry.event.units);
    let previous = 0;
    for (const sample of samples) {
      const delta = sample.exported - previous;
      expect(delta, `tick ${String(sample.tick)}`).toBe(exitedAt.get(sample.tick) ?? 0);
      previous = sample.exported;
    }
    expect(previous).toBe(UNITS);
  });

  it('každý kus nákladu prešiel novými lokáciami: na rampe aj v kamiónoch bol aspoň raz a nikdy viac než kapacity rampy a kamiónov', () => {
    expect(Math.max(...samples.map((sample) => sample.atRamp))).toBeGreaterThan(0);
    expect(Math.max(...samples.map((sample) => sample.inTruck))).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.atRamp, `tick ${String(sample.tick)}`).toBeLessThanOrEqual(STAGING_TOTAL);
      expect(sample.inTruck, `tick ${String(sample.tick)}`).toBeLessThanOrEqual(sample.trucks * TRUCK_CAPACITY);
    }
  });

  it('kamión drží najviac capacityUnits a jeho stav zodpovedá nákladu po každom ticku (pred nakládkou prázdny, po nej plný)', () => {
    expect(recorder.violationsOf('truck_cargo')).toEqual([]);
    expect(recorder.violationsOf('truck_refs')).toEqual([]);
  });

  it('pohyby: každá jednotka ide presne on_ship → in_crane → on_apron → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck → exported', () => {
    const chains = moveChains(recorder.events);
    expect(chains.size).toBe(UNITS);
    for (const [unitId, chain] of chains) {
      expect(exportChainViolation(unitId, chain)).toBeNull();
      for (const { event, tick } of chain) {
        expect(
          F4_TRANSITIONS.some(([from, to]) => from === event.from.kind && to === event.to.kind),
          `jednotka ${String(unitId)}, tick ${String(tick)}: ${event.from.kind} → ${event.to.kind}`,
        ).toBe(true);
      }
    }
  });

  it('exported je konečný stav: exportované jednotky ledger nepozná, ďalší move z exported ani do exported nejde a stav sa nezmení', () => {
    const before = stateHash(world);
    for (const unitId of moveChains(recorder.events).keys()) {
      expect(world.cargo.get(unitId as EntityId), `jednotka ${String(unitId)}`).toBeUndefined();
    }
    const unit = [...moveChains(recorder.events).keys()][0] as EntityId;
    expect(() => world.cargo.move(unit, { kind: 'exported' })).toThrow(CargoError);
    expect(() => world.cargo.move(unit, { kind: 'in_truck', truckId: 1 as EntityId })).toThrow(CargoError);
    expect(stateHash(world)).toBe(before);
    assertCargoConservation(world);
    expect(world.events.flush().filter((event) => event.type === 'CargoMoved')).toEqual([]);
  });

  it('nič sa nestratilo: po exporte je svet prázdny a každá jednotka opustila mapu cez kamión (12 TruckExited po 1 jednotke)', () => {
    expect(world.cargo.exportedCount).toBe(UNITS);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount).toBe(0);
    const exited = landsideEvents(recorder.events, 'TruckExited');
    expect(exited).toHaveLength(UNITS);
    expect(exited.reduce((sum, entry) => sum + entry.event.units, 0)).toBe(UNITS);
    expect(trucksById(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// CargoLedger.move: teleport na rampu, do kamióna a mimo mapy sa odmietne
// ---------------------------------------------------------------------------------------------------------

/** Svet uprostred reťazca: beží so záznamom a auditom, kým `predicate` nie je splnený. */
function midChainWorld(predicate: (world: World) => boolean): World {
  const world = World.create(DEFS, MAP, scenario.seed);
  new Recorder4(world, scenario).runUntil(predicate, MAX_TICKS);
  return world;
}

const anyUnitAt = (world: World, kind: 'in_storage' | 'at_ramp' | 'in_truck'): EntityId => {
  const holders = kind === 'in_storage' ? storageModulesOf(world) : kind === 'at_ramp' ? [rampOf(world)] : trucksById(world);
  for (const holder of holders) {
    const unit = world.cargo.unitsAt(kind, holder.id)[0];
    if (unit !== undefined) return unit;
  }
  throw new Error(`očakávaná jednotka v lokácii ${kind}`);
};

/** Pokus o presun musí vyhodiť `CargoTransitionError`, nič nezmeniť a nevyslať `CargoMoved`. */
function expectRejectedMove(world: World, unitId: EntityId, target: CargoLocation): void {
  const location = must(world.cargo.get(unitId), `jednotka ${String(unitId)}`).location;
  const before = stateHash(world);
  expect(() => world.cargo.move(unitId, target)).toThrow(CargoTransitionError);
  expect(world.cargo.get(unitId)?.location).toEqual(location);
  expect(stateHash(world)).toBe(before);
  assertCargoConservation(world);
  expect(world.events.flush().filter((event) => event.type === 'CargoMoved')).toEqual([]);
}

describe('CargoLedger.move: teleport v pozemnej časti reťazca sa odmietne (ARCHITECTURE §7.1)', () => {
  it('in_storage → at_ramp (preskočenie vozidla) vyhodí CargoTransitionError; jednotka ostáva v sklade', () => {
    const world = midChainWorld((w) => w.cargo.countByKind('in_storage') >= 1 && w.cargo.countByKind('at_ramp') >= 1);
    expectRejectedMove(world, anyUnitAt(world, 'in_storage'), { kind: 'at_ramp', rampId: rampOf(world).id, dock: 0 });
  }, RUN_TIMEOUT_MS);

  it.each<{ name: string; target: (rampId: EntityId) => CargoLocation }>([
    { name: 'at_ramp → exported (preskočenie kamióna)', target: () => ({ kind: 'exported' }) },
    { name: 'at_ramp → in_vehicle (späť do vozidla)', target: () => ({ kind: 'in_vehicle', vehicleId: 1 as EntityId }) },
    { name: 'at_ramp → in_storage (späť do skladu)', target: () => ({ kind: 'in_storage', moduleId: 4 as EntityId, slot: 0 }) },
  ])('$name vyhodí CargoTransitionError a jednotka ostáva na rampe', ({ target }) => {
    const world = midChainWorld((w) => w.cargo.countByKind('at_ramp') >= 1);
    expectRejectedMove(world, anyUnitAt(world, 'at_ramp'), target(rampOf(world).id));
  }, RUN_TIMEOUT_MS);

  it.each<{ name: string; target: (truckId: EntityId, rampId: EntityId) => CargoLocation }>([
    { name: 'in_truck → at_ramp (späť na rampu)', target: (_truckId, rampId) => ({ kind: 'at_ramp', rampId, dock: 0 }) },
    { name: 'in_truck → in_vehicle (späť do vozidla)', target: () => ({ kind: 'in_vehicle', vehicleId: 1 as EntityId }) },
    { name: 'in_truck → in_storage (späť do skladu)', target: () => ({ kind: 'in_storage', moduleId: 4 as EntityId, slot: 0 }) },
  ])('$name vyhodí CargoTransitionError a jednotka ostáva v kamióne', ({ target }) => {
    const world = midChainWorld((w) => w.cargo.countByKind('in_truck') >= 1);
    const unitId = anyUnitAt(world, 'in_truck');
    const location = must(world.cargo.get(unitId), 'jednotka v kamióne').location;
    expect(location.kind).toBe('in_truck');
    const truckId = location.kind === 'in_truck' ? location.truckId : (0 as EntityId);
    expectRejectedMove(world, unitId, target(truckId, rampOf(world).id));
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------
// Invarianty sveta a obnova zo save: držiteľ nákladu musí existovať
// ---------------------------------------------------------------------------------------------------------

describe('invarianty sveta: jednotka at_ramp / in_truck u neexistujúceho držiteľa', () => {
  const MISSING = 999_999 as EntityId;

  it('jednotka presunutá na neexistujúcu rampu porušuje invariant sveta (WorldInvariantError)', () => {
    // Svet F3 uprostred prevozu: `in_vehicle → at_ramp` je povolený prechod ledgera, existenciu rampy strážia invarianty (krok 12).
    const f3 = f3Scenario('f4_missing_ramp', 4405, { vehicles: ['straddle_carrier', 'straddle_carrier'], units: 8 });
    const world = World.create(DEFS, MAP, f3.seed);
    runUntilF3(world, f3, (w) => w.cargo.countByKind('in_vehicle') >= 1, 6000);
    const vehicle = must([...world.vehicles.values()].find((candidate) => world.cargo.countAt('in_vehicle', candidate.id) > 0), 'vozidlo s nákladom');
    const unit = must(world.cargo.unitsAt('in_vehicle', vehicle.id)[0], 'jednotka vo vozidle');
    expect(() => world.assertInvariants()).not.toThrow();
    world.cargo.move(unit, { kind: 'at_ramp', rampId: MISSING, dock: 0 });
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
  }, RUN_TIMEOUT_MS);

  it('jednotka presunutá do neexistujúceho kamióna porušuje invariant sveta (WorldInvariantError); so skutočným kamiónom invarianty držia', () => {
    const world = midChainWorld((w) => w.cargo.countByKind('at_ramp') >= 1 && w.cargo.countByKind('in_truck') >= 1);
    expect(() => world.assertInvariants()).not.toThrow();
    const staged = anyUnitAt(world, 'at_ramp');
    world.cargo.move(staged, { kind: 'in_truck', truckId: MISSING });
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
  }, RUN_TIMEOUT_MS);

  it('obnova zo save odmietne jednotku in_truck, ktorej kamión v stave chýba', () => {
    const world = midChainWorld((w) => w.cargo.countByKind('in_truck') >= 1);
    const saved = JSON.parse(JSON.stringify(world.serialize())) as Record<string, unknown>;
    // Predpoklad: WorldState v4 má na vrchu pole `trucks` (pole záznamov) — karta T04-04.
    expect(Array.isArray(saved['trucks'])).toBe(true);
    saved['trucks'] = [];
    expect(() => World.deserialize(DEFS, MAP, saved as unknown as WorldState)).toThrow(/in_truck|kami[oó]n|truck/i);
  }, RUN_TIMEOUT_MS);

  it('obnova zo save odmietne jednotku at_ramp, ktorej rampa v stave chýba', () => {
    const world = midChainWorld((w) => w.cargo.countByKind('at_ramp') >= 1);
    const saved = JSON.parse(JSON.stringify(world.serialize())) as { modules: { defId: string }[] } & Record<string, unknown>;
    saved.modules = saved.modules.filter((module) => module.defId !== 'loading_ramp_container');
    saved['trucks'] = [];
    saved['jobs'] = [];
    saved['vehicles'] = [];
    expect(() => World.deserialize(DEFS, MAP, saved as unknown as WorldState)).toThrow();
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------------------
// Scenár apron_to_yard ostáva bez zmeny: bez pozemnej časti sa nič nevyváža
// ---------------------------------------------------------------------------------------------------------

describe('regresia F3: apron_to_yard bez brány, plochy a rampy sa po F4 správa rovnako', () => {
  it('po 3 000 tickoch je náklad v dvoroch a vozidlách, nič na rampe, v kamióne ani exported; world.trucks je prázdne', () => {
    const f3 = loadScenarioFile('apron_to_yard');
    const world = World.create(DEFS, MAP, f3.seed);
    const recorder = new Recorder4(world, f3);
    recorder.runTo(3000);
    expect(world.cargo.countByKind('at_ramp')).toBe(0);
    expect(world.cargo.countByKind('in_truck')).toBe(0);
    expect(world.cargo.exportedCount).toBe(0);
    expect(trucksById(world)).toEqual([]);
    expect(timed4(recorder.events, 'CommandRejected')).toEqual([]);
  }, RUN_TIMEOUT_MS);
});
