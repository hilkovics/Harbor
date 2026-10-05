/**
 * Scenár `landside_pressure` (F6d, T6D-01, ADR-035): tlak na pozemnú stranu prístavu F4 s depom prázdnych — import northern_star (#2, 48 TEU) beží bez tlaku,
 * potom export booking golden_wave (#11, 36 TEU, so spárovaným importom #10, 40 TEU) a návraty prázdnych z importu #2 zaplnia stojiská a staging rampy skôr,
 * než príde loď. Pred opravou (kód v8) zámka: kamióny `collect` a `delivery` čakali v stojisku (6 / 6 bays) na prázdny / na miesto na docku, staging dockov
 * zaplnili jednotky importu čakajúce na odvoz a kamióny na odvoz sa nedostali dnu, import #10 sa nikdy nedokončil (40 000 tickov: 49 exportovaných
 * jednotiek, dokončené len #2 a #11, v stojisku 6 kamiónov `delivery`, oba docky 4 + 4 jednotky importu na odvoz). Po oprave čakajú kamióny vo vnútrozemí a vojdú len s rezerváciou (kvóta stojísk pre odvoz,
 * zaručené miesto na vyloženie): import #10 aj export #11 sa dokončia, kamióny na výdaj prázdneho sa vzdajú vo vnútrozemí, `lostUnits 0`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { WaitingArea } from '@sim/modules';
import { World, hinterlandMetrics, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';
import { itR1Interim } from '../helpers/r1-interim';

const SCENARIO = loadScenarioFile('landside_pressure');
const TICKS = 40_000;
const FIRST_IMPORT_ID = 2;
const BOOKING_ID = 11;
const PAIRED_IMPORT_ID = 10;
const PAIRED_IMPORT_UNITS = 40;
const RUN_TIMEOUT_MS = 300_000;
const GOLDEN_PATH = `${REPO_ROOT}tests/sim/__golden__/landside_pressure.json`;

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

interface Observed {
  readonly world: World;
  readonly events: Entries;
  /** Najväčší počet kamiónov s dovozom (`delivery`), ktoré naraz držali stojisko. */
  readonly maxDeliveryBays: number;
  /** Prvý tick, v ktorom po ticku čaká vo vnútrozemí návrat prázdneho (splatný, nevpustený), a prvý tick čakajúceho výdaja. */
  readonly firstReturnWaiting: number | undefined;
  readonly firstPickupWaiting: number | undefined;
}

/** Celý beh scenára s kontrolami po každom ticku (konzervácia, kvóta stojísk pre odvoz). */
function run(): Observed {
  const world = World.create(BUNDLED_DEFS, MAP, SCENARIO.seed);
  const events: { tick: number; event: SimEvent }[] = [];
  let maxDeliveryBays = 0;
  let firstReturnWaiting: number | undefined;
  let firstPickupWaiting: number | undefined;
  runScenario(world, SCENARIO, TICKS, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
      let held = 0;
      for (const truck of w.trucks.values()) if (truck.bay !== null && truck.mission === 'delivery') held += 1;
      maxDeliveryBays = Math.max(maxDeliveryBays, held);
      if (firstReturnWaiting === undefined && w.emptyFlow.dueReturn(w.clock.tick) !== undefined) firstReturnWaiting = w.clock.tick;
      if (firstPickupWaiting === undefined && w.emptyFlow.duePickup(w.clock.tick) !== undefined) firstPickupWaiting = w.clock.tick;
    },
  });
  return { world, events, maxDeliveryBays, firstReturnWaiting, firstPickupWaiting };
}

const of = <T extends SimEvent['type']>(events: Entries, type: T): { tick: number; event: Extract<SimEvent, { type: T }> }[] =>
  events.filter((entry): entry is { tick: number; event: Extract<SimEvent, { type: T }> } => entry.event.type === type);

describe('scenár landside_pressure: súbor', () => {
  it('má tvar { id, seed, map, commands }, seed 5016, mapu harbor_01', () => {
    expect(Object.keys(SCENARIO).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect([SCENARIO.id, SCENARIO.seed, SCENARIO.map]).toEqual(['landside_pressure', 5016, 'data/maps/harbor_01.json']);
  });

  it('prístav F4 s depom prázdnych a tromi vozidlami (2× straddle, empty handler) a dvoma AcceptContract (2 @2, 11 @8 641)', () => {
    const types = SCENARIO.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(10).fill('PlaceRoad'), ...Array<string>(6).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', 'BuyVehicle', 'AcceptContract', 'AcceptContract']);
    const accepts = SCENARIO.commands.filter((entry) => entry.command.type === 'AcceptContract').map((entry) => [entry.atTick, (entry.command as unknown as { contractId: number }).contractId]);
    expect(accepts).toEqual([[2, FIRST_IMPORT_ID], [8_641, BOOKING_ID]]);
  });
});

describe('scenár landside_pressure: beh', () => {
  const observed = run();
  const { world, events } = observed;

  itR1Interim('import #10 (40 TEU) sa pod tlakom dokončí; export #11 aj prvý import #2 tiež, v poradí #2, #11, #10', () => {
    expect(of(events, 'ContractCompleted').map((entry) => entry.event.contractId)).toEqual([FIRST_IMPORT_ID, BOOKING_ID, PAIRED_IMPORT_ID]);
    expect(world.contracts.get(PAIRED_IMPORT_ID as never)).toMatchObject({ kind: 'import', state: 'completed', volumeUnits: PAIRED_IMPORT_UNITS, unitsExported: PAIRED_IMPORT_UNITS });
    expect(world.contracts.get(BOOKING_ID as never)).toMatchObject({ kind: 'export', state: 'completed' });
  });

  it('kvóta stojísk pre odvoz: kamióny s dovozom (export, návrat prázdneho) naraz nikdy nedržali viac než bays − pickupReservedBays stojísk', () => {
    const area = [...world.modules.values()].find((module): module is WaitingArea => module instanceof WaitingArea);
    if (area === undefined) throw new Error('svet nemá stojisko');
    expect(area.pickupReservedBays).toBeGreaterThan(0);
    expect(observed.maxDeliveryBays).toBeGreaterThan(0);
    expect(observed.maxDeliveryBays).toBeLessThanOrEqual(area.bays - area.pickupReservedBays);
  });

  it('kamióny po prázdny kontajner (collect) sa bez dostupného prázdneho vzdali vo vnútrozemí: žiadny nečakal v stojisku nadarmo (EmptyPickupMissed vždy s truckId null)', () => {
    const missed = of(events, 'EmptyPickupMissed').map((entry) => entry.event);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((event) => event.truckId === null)).toBe(true);
    expect(hinterlandMetrics(world).collect.turnedAway).toBe(missed.length);
  });

  itR1Interim('vnútrozemie sa v behu využilo: návrat aj výdaj prázdneho čakali pred vjazdom, čakanie a nedostatok stojísk pre odvoz sú namerané, na konci nikto nečaká', () => {
    expect(observed.firstReturnWaiting).toBeDefined();
    expect(observed.firstPickupWaiting).toBeDefined();
    const metrics = hinterlandMetrics(world);
    expect(metrics.delivery.admitted).toBeGreaterThan(0);
    expect(metrics.delivery.waitTicksMax).toBeGreaterThan(0);
    expect(metrics.waitTicks.max).toBe(Math.max(metrics.delivery.waitTicksMax, metrics.collect.waitTicksMax));
    expect(metrics.pickupBayStarvationTicks).toBeGreaterThan(0);
    expect(metrics.waiting.delivery + metrics.waiting.collect).toBe(0);
  });

  it('nič sa nestratilo: konzervácia každý tick, lostUnits 0, invarianty sveta bez porušenia, žiadny kamión nezostal v stojisku', () => {
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(world.trucks.size).toBeLessThanOrEqual(6);
    for (const truck of world.trucks.values()) expect(truck.state, `kamión ${String(truck.id)}`).not.toBe('waiting');
  });

  it('golden report tests/sim/__golden__/landside_pressure.json sa zhoduje s behom', () => {
    expect(existsSync(GOLDEN_PATH), 'chýba golden: pnpm simrun data/scenarios/landside_pressure.json --ticks 40000 --report').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    const metrics = hinterlandMetrics(world);
    expect({
      cashEnd: world.cashCents,
      exportedUnits: world.cargo.exportedCount,
      shippedUnits: world.cargo.shippedCount,
      contractsCompleted: of(events, 'ContractCompleted').length,
      xp: world.xp,
      emptyReturns: of(events, 'EmptyReturned').length,
      emptyPickedUp: of(events, 'EmptyPickedUp').length,
      emptyPickupMisses: of(events, 'EmptyPickupMissed').length,
      inlandWaitTicks: world.hinterland.waitTicksTotal('delivery') + world.hinterland.waitTicksTotal('collect'),
      inlandWaitTicksMax: metrics.waitTicks.max,
      pickupBayStarvationTicks: metrics.pickupBayStarvationTicks,
    }).toEqual(golden);
  });

  it('deterministický: rovnaký beh dá rovnaký stateHash; obnova uprostred čakania návratu aj výdaja vo vnútrozemí a na konci dá zhodný stateHash', () => {
    const expected = stateHash(world);
    expect(stateHash(run().world)).toBe(expected);
    const ticks = [observed.firstReturnWaiting, observed.firstPickupWaiting, 9_000, 33_000].filter((tick): tick is number => tick !== undefined);
    for (const at of ticks) {
      const half = World.create(BUNDLED_DEFS, MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(BUNDLED_DEFS, MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});
