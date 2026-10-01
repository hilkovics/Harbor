/**
 * Audit úplnosti `World.serialize()` (T06-01, ADR-030 bod 7; ARCHITECTURE §14, §16): save → JSON text → load uprostred
 * toku nákladu a peňazí a dobehnutie → **rovnaký prúd udalostí po tickoch aj rovnaký hash stavu** ako nepretržitý beh.
 * Ak by `WorldState` nenesol niečo, čo ovplyvní budúce ticky (Rng, pool a kontrakty, ekonomika, trasy lodí, rezervácie,
 * joby, kamióny, nároky dockov, počítadlá žeriavov a brán …), obnovený svet by sa niekde odchýlil.
 *
 * - `vertical_slice` (F5), roundtrip v tickoch 3 000 (kontrakt `accepted`, loď ešte nevznikla), 9 000 (`unloading`, loď
 *   pri kotvisku, žeriav v cykle, vozidlá vezú), 12 000 (`exporting`, kamióny na rampe a v bráne) a 15 000 (`completed`,
 *   pool a ekonomika bežia ďalej) → hash na konci (30 000) = nepretržitý beh;
 * - `full_import_chain` (F4), roundtrip v ticku 4 000 (sedem kamiónov v rôznych stavoch, joby, export) → rovnako;
 * - kontrola citlivosti: save so zmeneným stavom `Rng` dobehne inak (porovnanie by chýbajúci stav naozaj odhalilo).
 *
 * Bod roundtripu = svet po `tick()`, v ktorom `clock.tick` dosiahol T, pred príkazmi s `atTick = T` (rovnako ako
 * `simrun --roundtrip-at T`). Konzervácia nákladu sa overuje po každom ticku (pravidlo 2).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { World, fnv1a32Hex, hashWorldState, stateHash, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario, type Scenario } from '../helpers/scenario';

const DEFS = loadBundledDefs();
const MAP = loadBundledMap();
const RUN_TICKS = 30_000;
const HEAVY_TIMEOUT_MS = 180_000;

interface Baseline {
  /** Hash stavu po `RUN_TICKS`. */
  readonly finalHash: string;
  /** Odtlačok udalostí každého ticku (index = `clock.tick` po ticku). */
  readonly eventPrints: readonly string[];
  /** JSON text savu v bodoch roundtripu. */
  readonly saves: ReadonlyMap<number, string>;
  /** Stav kontraktov (okrem ponúk), lodí a kamiónov v bodoch roundtripu — čo roundtrip pokrýva. */
  readonly probes: ReadonlyMap<number, { readonly contracts: string[]; readonly ships: string[]; readonly trucks: number }>;
}

/** Nepretržitý beh s odtlačkami udalostí po tickoch a savmi v bodoch `splits`. */
function runBaseline(scenario: Scenario, splits: readonly number[]): Baseline {
  const world = World.create(DEFS, MAP, scenario.seed);
  const eventPrints: string[] = [];
  const saves = new Map<number, string>();
  const probes = new Map<number, { contracts: string[]; ships: string[]; trucks: number }>();
  runScenario(world, scenario, RUN_TICKS, {
    afterTick: (w, events) => {
      assertCargoConservation(w);
      eventPrints[w.clock.tick] = fnv1a32Hex(JSON.stringify(events));
      if (!splits.includes(w.clock.tick)) return;
      saves.set(w.clock.tick, JSON.stringify(w.serialize()));
      probes.set(w.clock.tick, {
        contracts: [...w.contracts.values()].filter((contract) => contract.state !== 'offered').map((contract) => contract.state),
        ships: [...w.ships.values()].map((ship) => ship.state),
        trucks: w.trucks.size,
      });
    },
  });
  return { finalHash: stateHash(world), eventPrints, saves, probes };
}

/** Obnoví svet zo savu v ticku `split`, dobehne do `RUN_TICKS` a vráti prvý tick s inými udalosťami a koncový hash. */
function resume(scenario: Scenario, baseline: Baseline, split: number): { firstEventMismatch: number | null; finalHash: string; loadedHash: string; savedHash: string } {
  const text = baseline.saves.get(split);
  if (text === undefined) throw new Error(`save v ticku ${String(split)} chýba`);
  const saved = JSON.parse(text) as WorldState;
  const world = World.deserialize(DEFS, MAP, saved);
  const loadedHash = stateHash(world);
  let firstEventMismatch: number | null = null;
  runScenario(world, scenario, RUN_TICKS, {
    afterTick: (w, events) => {
      assertCargoConservation(w);
      if (firstEventMismatch === null && fnv1a32Hex(JSON.stringify(events)) !== baseline.eventPrints[w.clock.tick]) {
        firstEventMismatch = w.clock.tick;
      }
    },
  });
  return { firstEventMismatch, finalHash: stateHash(world), loadedHash, savedHash: hashWorldState(saved) };
}

describe('roundtrip uprostred vertical_slice (F5) → rovnaký ďalší priebeh a hash na konci', () => {
  const scenario = loadScenarioFile('vertical_slice');
  const SPLITS = [3_000, 9_000, 12_000, 15_000];
  let baseline: Baseline;

  beforeAll(() => {
    baseline = runBaseline(scenario, SPLITS);
  }, HEAVY_TIMEOUT_MS);

  it('stráž pokrytia: body roundtripu ležia v rôznych fázach kontraktu (accepted, unloading, exporting s kamiónmi, completed)', () => {
    expect(baseline.probes.get(3_000)).toEqual({ contracts: ['accepted'], ships: [], trucks: 0 });
    expect(baseline.probes.get(9_000)).toMatchObject({ contracts: ['unloading'], ships: ['docked'] });
    expect(baseline.probes.get(12_000)?.contracts).toEqual(['exporting']);
    expect(baseline.probes.get(12_000)?.trucks).toBeGreaterThan(0);
    expect(baseline.probes.get(15_000)).toEqual({ contracts: ['completed'], ships: [], trucks: 0 });
  });

  it.each(SPLITS)(
    'roundtrip v ticku %i: obnovený svet má hash savu, udalosti po tickoch aj hash v ticku 30 000 = nepretržitý beh',
    (split) => {
      const run = resume(scenario, baseline, split);
      expect(run.loadedHash).toBe(run.savedHash);
      expect(run.firstEventMismatch).toBeNull();
      expect(run.finalHash).toBe(baseline.finalHash);
    },
    HEAVY_TIMEOUT_MS,
  );

  it('kontrola citlivosti: save v ticku 9 000 so zmeneným stavom Rng dobehne do iného stavu', () => {
    const text = baseline.saves.get(9_000);
    if (text === undefined) throw new Error('save v ticku 9 000 chýba');
    const saved = JSON.parse(text) as WorldState;
    const [s0, s1, s2, s3] = saved.rng;
    const tampered: WorldState = { ...saved, rng: [(s0 + 1) >>> 0, s1, s2, s3] };
    const world = World.deserialize(DEFS, MAP, tampered);
    runScenario(world, scenario, RUN_TICKS, { afterTick: assertCargoConservation });
    expect(stateHash(world)).not.toBe(baseline.finalHash);
  }, HEAVY_TIMEOUT_MS);
});

describe('roundtrip uprostred full_import_chain (F4) → rovnaký ďalší priebeh a hash na konci', () => {
  const scenario = loadScenarioFile('full_import_chain');
  const SPLIT = 4_000;
  let baseline: Baseline;

  beforeAll(() => {
    baseline = runBaseline(scenario, [SPLIT]);
  }, HEAVY_TIMEOUT_MS);

  it('roundtrip v ticku 4 000 (kamióny v bráne, pri docku aj na ceste von): udalosti aj hash v ticku 30 000 = nepretržitý beh', () => {
    expect(baseline.probes.get(SPLIT)?.trucks).toBeGreaterThanOrEqual(3);
    const run = resume(scenario, baseline, SPLIT);
    expect(run.loadedHash).toBe(run.savedHash);
    expect(run.firstEventMismatch).toBeNull();
    expect(run.finalHash).toBe(baseline.finalHash);
  }, HEAVY_TIMEOUT_MS);
});
