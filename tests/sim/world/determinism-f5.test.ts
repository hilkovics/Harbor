/**
 * Determinizmus po F5 (T06-02; ARCHITECTURE §6, §14, §16; ADR-030 bod 6): dva svety s rovnakým seedom nad
 * `vertical_slice` (kontrakty, ekonomika), `full_import_chain` (kamióny, export) a `multi_ship_queue` (päť lodí,
 * anchorage) majú v 5 kontrolných bodoch **rovnaký hash stavu** (`stateHash` = FNV-1a 32 nad `serialize()`) aj rovnaký
 * prúd udalostí po tickoch; iný seed dá iný hash aspoň v jednom bode.
 * Doplňuje `determinism.test.ts` (T01-05: len `f1_roads`, do F5 sa v sim pribudlo `Rng` v poole kontraktov, joby,
 * kamióny, trasy lodí, ekonomika).
 *
 * Svety bežia **striedavo po 100 tickoch** v jednom procese a každý má vlastné inštancie defov a mapy (svet B
 * a seed + 1 svet C dostanú čerstvé `DefRegistry.fromRaw(RAW_DEFS)` / `loadBundledMap()` — režim `apron`). Striedanie chytí stav zdieľaný medzi
 * svetmi (modulové cache, globálne počítadlá, mutácia zdieľanej mapy/defov), ktorý by pri behu svet po svete nebolo
 * vidieť. Konzervácia nákladu (`assertCargoConservation`) beží po každom ticku všetkých svetov.
 *
 * Kontrolné body ležia v rôznych fázach scenára (pozri `CHECKPOINTS`); test overí, že sa hash medzi nimi mení
 * (svet sa naozaj vyvíja, porovnanie nie je triviálne).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DefRegistry } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { World, fnv1a32Hex, hashWorldState, stateHash, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario, type Scenario } from '../helpers/scenario';
import { DEFS, MAP, RAW_DEFS } from './world-fixtures';

const HEAVY_TIMEOUT_MS = 180_000;
/** Krok striedania svetov (tickov). */
const INTERLEAVE_TICKS = 100;
/** Počet kontrolných bodov (zadanie T06-02). */
const CHECKPOINT_COUNT = 5;

/**
 * Kontrolné body (ticky) podľa scenára:
 *  - `vertical_slice`: 1 (kontrakt prijatý), 8 000 (loď pri kotvisku, vykládka), 10 700 (export, kamióny na rampe),
 *    14 800 (kontrakt `completed` krátko predtým) a 20 000 (pool a ekonomika bežia ďalej, deň po dni);
 *  - `full_import_chain`: 1, 700 (vykládka, vozidlá vezú), 3 000 (kamióny v bráne aj pri rampe), 8 000, 15 000;
 *  - `multi_ship_queue`: 1, 200 (loď pred vstupom, iná na anchorage), 3 300 (odchod a vplávanie ďalšej), 6 000, 9 000.
 */
const CHECKPOINTS: readonly (readonly [scenarioId: string, checkpoints: readonly number[]])[] = [
  ['vertical_slice', [1, 8_000, 10_700, 14_800, 20_000]],
  ['full_import_chain', [1, 700, 3_000, 8_000, 15_000]],
  ['multi_ship_queue', [1, 200, 3_300, 6_000, 9_000]],
];

/** Jeden svet bežiaci vlastnou rýchlosťou kroku s vlastnými defmi a mapou. */
interface Runner {
  readonly world: World;
  readonly scenario: Scenario;
  /** Odtlačok udalostí každého ticku (index = `clock.tick` po ticku). */
  readonly eventPrints: string[];
  readonly hashes: Map<number, string>;
}

function makeRunner(scenario: Scenario, fresh: boolean): Runner {
  const defs = fresh ? DefRegistry.fromRaw(RAW_DEFS) : DEFS;
  const map = fresh ? loadBundledMap() : MAP;
  return { world: World.create(defs, map, scenario.seed), scenario, eventPrints: [], hashes: new Map() };
}

/** Dobehne `runner` do ticku `until` (absolútny) a ak je to kontrolný bod, zapíše hash stavu. */
function advance(runner: Runner, until: number, checkpoints: readonly number[]): void {
  runScenario(runner.world, runner.scenario, until, {
    afterTick: (world, events) => {
      assertCargoConservation(world);
      runner.eventPrints[world.clock.tick] = fnv1a32Hex(JSON.stringify(events));
    },
  });
  if (checkpoints.includes(until)) runner.hashes.set(until, stateHash(runner.world));
}

/** Ticky, do ktorých sa svety posúvajú: všetky násobky kroku a kontrolné body, vzostupne a bez duplicít. */
function targets(checkpoints: readonly number[]): number[] {
  const last = Math.max(...checkpoints);
  const all = new Set<number>(checkpoints);
  for (let tick = INTERLEAVE_TICKS; tick <= last; tick += INTERLEAVE_TICKS) all.add(tick);
  return [...all].sort((a, b) => a - b);
}

/** Prvý index, na ktorom sa polia líšia (`-1` = rovnaké). */
function firstDifference(a: readonly (string | undefined)[], b: readonly (string | undefined)[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Názov prvého kľúča `WorldState`, v ktorom sa stavy líšia (pre zrozumiteľnú správu pri rozdielnom hashi). */
function firstDifferingKey(a: WorldState, b: WorldState): string {
  for (const key of Object.keys(a) as (keyof WorldState)[]) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return key;
  }
  return '(žiadny — líši sa len poradie kľúčov)';
}

describe.each(CHECKPOINTS)('determinizmus F5: %s', (scenarioId, checkpoints) => {
  const scenario = loadScenarioFile(scenarioId);
  const otherSeed: Scenario = { ...scenario, seed: scenario.seed + 1 };
  let startHash = '';
  let a: Runner;
  let b: Runner;
  let c: Runner;

  beforeAll(() => {
    startHash = stateHash(World.create(DEFS, MAP, scenario.seed));
    a = makeRunner(scenario, false);
    b = makeRunner(scenario, true);
    c = makeRunner(otherSeed, true);
    for (const until of targets(checkpoints)) {
      advance(a, until, checkpoints);
      advance(b, until, checkpoints);
      advance(c, until, checkpoints);
    }
  }, HEAVY_TIMEOUT_MS);

  it(`${String(CHECKPOINT_COUNT)} kontrolných bodov: dva svety s rovnakým seedom (druhý s čerstvými defmi a mapou) majú rovnaký hash v každom`, () => {
    expect(checkpoints).toHaveLength(CHECKPOINT_COUNT);
    for (const tick of checkpoints) {
      const hashA = a.hashes.get(tick);
      const hashB = b.hashes.get(tick);
      expect(hashA, `hash sveta A v ticku ${String(tick)}`).toMatch(/^[0-9a-f]{8}$/);
      expect(hashB, `tick ${String(tick)}: svety sa líšia v kľúči ${firstDifferingKey(a.world.serialize(), b.world.serialize())}`).toBe(hashA);
    }
    expect(a.world.clock.tick).toBe(Math.max(...checkpoints));
    expect(b.world.clock.tick).toBe(a.world.clock.tick);
  });

  it('koncové stavy sú rovnaké aj ako celé serializované objekty a prúd udalostí po tickoch je rovnaký', () => {
    expect(b.world.serialize()).toEqual(a.world.serialize());
    expect(firstDifference(b.eventPrints, a.eventPrints), 'prvý tick s odlišnými udalosťami').toBe(-1);
  });

  it('kontrolné body sa navzájom líšia (svet sa vyvíja, porovnanie nie je triviálne)', () => {
    const hashes = checkpoints.map((tick) => a.hashes.get(tick));
    expect(new Set(hashes).size).toBe(CHECKPOINT_COUNT);
  });

  it('iný seed → iný hash aspoň v jednom kontrolnom bode', () => {
    const differing = checkpoints.filter((tick) => c.hashes.get(tick) !== a.hashes.get(tick));
    expect(differing.length).toBeGreaterThan(0);
  });

  it('iný seed zmení aj priebeh hry, nielen polia seed a rng (inak by hash porovnával len seed)', () => {
    const last = Math.max(...checkpoints);
    const withSameSeed: WorldState = { ...c.world.serialize(), seed: a.world.serialize().seed, rng: a.world.serialize().rng };
    expect(c.hashes.get(last)).not.toBe(a.hashes.get(last));
    expect(hashWorldState(withSameSeed), `po vyrovnaní polí seed a rng sa stav v ticku ${String(last)} líši len v: ${firstDifferingKey(a.world.serialize(), withSameSeed)}`).not.toBe(a.hashes.get(last));
  });

  it('zdieľané defy a mapa ostali nedotknuté: čerstvý svet po behoch má rovnaký štartový hash', () => {
    expect(stateHash(World.create(DEFS, MAP, scenario.seed))).toBe(startHash);
  });
});
