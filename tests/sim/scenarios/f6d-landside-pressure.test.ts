/**
 * Scenár `landside_pressure` (F6d, T6D-01, ADR-035; R4 ADR-041): tlak na pozemnú stranu prístavu s dvorom, depom prázdnych a jedným TP na hrane každého skladu — import northern_star (#5, 60 TEU = 35 kontajnerov;
 * pred R2 #2) beží bez tlaku, potom export booking northern_star (#9, 36 TEU = 21 kontajnerov, so spárovaným importom #8) a návraty prázdnych z importu #5 súperia o tokeny TP / státia a prístup bez bunky nikdy
 * nestoja na ceste: kamióny čakajú vo vnútrozemí (`Hinterland`) a vojdú len s tokenom. Import #8 pristane až v ticku 33 954 — do konca behu sa odvezie len časť (pickup nemá voľný TP), čo je zámer tlaku. `lostUnits 0`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { World, hinterlandMetrics, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { REPO_ROOT, loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, PORT_MAP } from '../world/world-fixtures';

const SCENARIO = loadScenarioFile('landside_pressure');
const TICKS = 40_000;
const FIRST_IMPORT_ID = 5;
const BOOKING_ID = 9;
const PAIRED_IMPORT_ID = 8;
const PAIRED_IMPORT_UNITS = 42; // kontajnery (TEU viď golden); R4 (ADR-041): nový prúd Rng (R2: 31, pôvodne 28)
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
  const world = World.create(BUNDLED_DEFS, PORT_MAP, SCENARIO.seed);
  const events: { tick: number; event: SimEvent }[] = [];
  let maxDeliveryBays = 0;
  let firstReturnWaiting: number | undefined;
  let firstPickupWaiting: number | undefined;
  runScenario(world, SCENARIO, TICKS, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
      let held = 0;
      for (const truck of w.trucks.values()) if (truck.mission === 'delivery' && truck.tpCell !== null) held += 1;
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

  it('prístav s dvorom, depom prázdnych, bránami a tromi vozidlami (2× straddle, empty handler) a dvoma AcceptContract (5 @2, 9 @8 641)', () => {
    const types = SCENARIO.commands.map((entry) => entry.command.type);
    expect(types).toEqual([...Array<string>(8).fill('PlaceRoad'), ...Array<string>(5).fill('PlaceModule'), 'BuyVehicle', 'BuyVehicle', 'BuyVehicle', 'AcceptContract', 'AcceptContract']);
    const accepts = SCENARIO.commands.filter((entry) => entry.command.type === 'AcceptContract').map((entry) => [entry.atTick, (entry.command as unknown as { contractId: number }).contractId]);
    expect(accepts).toEqual([[2, FIRST_IMPORT_ID], [8_641, BOOKING_ID]]);
  });
});

describe('scenár landside_pressure: beh', () => {
  const observed = run();
  const { world, events } = observed;

  it('prvý import #5 a export #9 sa dokončia (v poradí #5, #9); spárovaný import #8 pristane až v ticku 33 954 a do konca behu sa odvezie len časť (pod tlakom ostáva v exporting)', () => {
    expect(of(events, 'ContractCompleted').map((entry) => entry.event.contractId)).toEqual([FIRST_IMPORT_ID, BOOKING_ID]);
    expect(world.contracts.get(PAIRED_IMPORT_ID as never)).toMatchObject({ kind: 'import', state: 'exporting', volumeUnits: PAIRED_IMPORT_UNITS, unitsUnloaded: PAIRED_IMPORT_UNITS });
    expect(world.contracts.get(BOOKING_ID as never)).toMatchObject({ kind: 'export', state: 'completed' });
  });

  it('tokeny TP a státia: kamióny s dovozom (export, návrat prázdneho) naraz nikdy nedržali viac tokenov, než je TP a stojísk — svet nikdy neporušil invarianty (krok 12 po každom ticku)', () => {
    expect(observed.maxDeliveryBays).toBeGreaterThan(0);
  });

  it('kamióny po prázdny kontajner (collect) sa bez dostupného prázdneho vzdali vo vnútrozemí: žiadny nečakal na TP nadarmo (EmptyPickupMissed vždy s truckId null)', () => {
    const missed = of(events, 'EmptyPickupMissed').map((entry) => entry.event);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.every((event) => event.truckId === null)).toBe(true);
    expect(hinterlandMetrics(world).collect.turnedAway).toBe(missed.length);
  });

  it('vnútrozemie sa v behu využilo: návrat aj výdaj prázdneho čakali pred vjazdom, čakanie a nedostatok tokenov pre odvoz sú namerané, na konci nikto nečaká', () => {
    // R4 (ADR-041): pred bránou je buffer a pruh vybavuje rýchlejšie než jedna brána F4, návrat prázdneho už pred vjazdom nečaká (firstReturnWaiting môže byť undefined); výdaj čaká stále.
    expect(observed.firstPickupWaiting).toBeDefined();
    const metrics = hinterlandMetrics(world);
    expect(metrics.delivery.admitted).toBeGreaterThan(0);
    expect(metrics.delivery.waitTicksMax).toBeGreaterThan(0);
    expect(metrics.waitTicks.max).toBe(Math.max(metrics.delivery.waitTicksMax, metrics.collect.waitTicksMax));
    expect(metrics.pickupBayStarvationTicks).toBeGreaterThan(0);
    expect(metrics.waiting.delivery + metrics.waiting.collect).toBe(0);
  });

  it('nič sa nestratilo: konzervácia každý tick, lostUnits 0, invarianty sveta bez porušenia, kamióny na konci sú len na ceste (nič nezostalo bez tokenu)', () => {
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(world.trucks.size).toBeLessThanOrEqual(6);
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
      const half = World.create(BUNDLED_DEFS, PORT_MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(BUNDLED_DEFS, PORT_MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(expected);
    }
  }, RUN_TIMEOUT_MS);
});
