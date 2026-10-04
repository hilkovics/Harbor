/**
 * Determinizmus a save/load roundtrip `World` (ARCHITECTURE §14, §16; T01-05, TDD):
 *  - dva svety s rovnakým seedom a scenárom → identický „hash" stavu (`JSON.stringify(serialize())`) po N tickoch,
 *  - `deserialize(serialize(w))` uprostred behu a dobehnutie → rovnaký hash ako nepretržitý beh.
 * Scenár `f1_roads` sa prehráva cez `runScenario` (príkaz s `atTick = T` sa aplikuje cez `applyPending()`,
 * keď `clock.tick === T`, pred ďalším `tick()`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario, stateHash } from '../helpers/scenario';

const RUN_TICKS = 20_000;

const defs = loadBundledDefs();
const map = loadBundledMap();
const scenario = loadScenarioFile('f1_roads');

type State = ReturnType<World['serialize']>;

/** Hash-e stavu v zvolených tickoch (po `tick()`, kedy `clock.tick` dosiahne hodnotu), + finálny svet. */
function runWithCheckpoints(
  seed: number,
  commands: typeof scenario.commands,
  checkpoints: ReadonlySet<number>,
): { world: World; hashes: Map<number, string> } {
  const world = World.create(defs, map, seed);
  const hashes = new Map<number, string>();
  runScenario(world, { ...scenario, seed, commands }, RUN_TICKS, {
    afterTick: (w) => {
      assertCargoConservation(w);
      if (checkpoints.has(w.clock.tick)) hashes.set(w.clock.tick, stateHash(w));
    },
  });
  return { world, hashes };
}

const CHECKPOINTS = new Set([1, 2, 100, 101, 200, 201, 1000, 6000, 6001, 12_000, 12_001, 15_001, RUN_TICKS]);

describe('determinizmus: rovnaký seed + scenár → rovnaký stav', () => {
  it('dva svety majú identický hash vo všetkých kontrolných bodoch aj na konci', () => {
    const a = runWithCheckpoints(scenario.seed, scenario.commands, CHECKPOINTS);
    const b = runWithCheckpoints(scenario.seed, scenario.commands, CHECKPOINTS);

    expect(a.hashes.size).toBe(CHECKPOINTS.size);
    expect(b.hashes).toEqual(a.hashes);
    expect(stateHash(b.world)).toBe(stateHash(a.world));
    expect(a.world.clock.tick).toBe(RUN_TICKS);
  });

  it('prúd udalostí je pri rovnakom seede a scenári identický', () => {
    const run = () => runScenario(World.create(defs, map, scenario.seed), scenario, RUN_TICKS);
    expect(run()).toEqual(run());
  });

  it('výsledok nezávisí od inštancie LoadedMap (mapa sa načíta znova)', () => {
    const a = World.create(defs, map, scenario.seed);
    runScenario(a, scenario, RUN_TICKS);
    const b = World.create(defs, loadBundledMap(), scenario.seed);
    runScenario(b, scenario, RUN_TICKS);
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it('svety z jednej LoadedMap sa navzájom neovplyvňujú (druhý svet začína od štartového stavu)', () => {
    const fresh = stateHash(World.create(defs, map, scenario.seed));
    const used = World.create(defs, map, scenario.seed);
    runScenario(used, scenario, RUN_TICKS);
    expect(stateHash(World.create(defs, map, scenario.seed))).toBe(fresh);
    expect(stateHash(used)).not.toBe(fresh);
  });
});

describe('determinizmus: hash je citlivý (kontrolné testy, že porovnanie niečo hovorí)', () => {
  const reference = () => runWithCheckpoints(scenario.seed, scenario.commands, new Set()).world;

  it('iný seed → iný hash', () => {
    const other = runWithCheckpoints(scenario.seed + 1, scenario.commands, new Set()).world;
    expect(stateHash(other)).not.toBe(stateHash(reference()));
  });

  it('beh bez príkazov → iný hash než beh so scenárom', () => {
    const idle = runWithCheckpoints(scenario.seed, [], new Set()).world;
    expect(stateHash(idle)).not.toBe(stateHash(reference()));
    expect(idle.clock.tick).toBe(RUN_TICKS);
  });

  it('príkaz aplikovaný o tick neskôr → iný stav v tom ticku', () => {
    const early = World.create(defs, map, scenario.seed);
    const late = World.create(defs, map, scenario.seed);
    const shifted = { ...scenario, commands: scenario.commands.map((e) => ({ ...e, atTick: e.atTick + 1 })) };
    runScenario(early, scenario, 101);
    runScenario(late, shifted, 101);
    expect(stateHash(late)).not.toBe(stateHash(early));
  });

  it('hash sa mení s každým tickom', () => {
    const world = World.create(defs, map, scenario.seed);
    const seen = new Set<string>([stateHash(world)]);
    for (let i = 0; i < 5; i++) {
      world.tick();
      seen.add(stateHash(world));
    }
    expect(seen.size).toBe(6);
  });
});

describe('serialize / deserialize', () => {
  it('WorldState je čistý JSON (bez tried, undefined, NaN) vo verzii 8', () => {
    const world = World.create(defs, map, scenario.seed);
    runScenario(world, scenario, 300);
    const state = world.serialize();

    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    expect(state).toMatchObject({ version: 9, mapId: map.id, seed: scenario.seed, cashCents: world.cashCents });
  });

  it('serialize() nemení svet (dvojité volanie dá rovnaký výsledok a beh pokračuje ako bez neho)', () => {
    const observed = World.create(defs, map, scenario.seed);
    const control = World.create(defs, map, scenario.seed);
    runScenario(observed, scenario, 150, { afterTick: (w) => void w.serialize() });
    runScenario(control, scenario, 150);
    expect(stateHash(observed)).toBe(stateHash(control));
    expect(stateHash(observed)).toBe(stateHash(observed));
  });

  it('deserialize hneď po načítaní znovu serializuje na rovnaký reťazec (idempotencia)', () => {
    const world = World.create(defs, map, scenario.seed);
    runScenario(world, scenario, 6500);
    const json = stateHash(world);
    const loaded = World.deserialize(defs, map, JSON.parse(json) as State);

    expect(stateHash(loaded)).toBe(json);
    expect(loaded.clock.tick).toBe(world.clock.tick);
    expect(loaded.clock.speed).toBe(world.clock.speed);
    expect(loaded.cashCents).toBe(world.cashCents);
  });

  it('deserialize zdedí cesty zo save-u, nie zo štartového stavu mapy', () => {
    const world = World.create(defs, map, scenario.seed);
    runScenario(world, scenario, 300);
    const loaded = World.deserialize(defs, map, JSON.parse(stateHash(world)) as State);

    for (let y = 0; y < world.grid.height; y++) {
      for (let x = 0; x < world.grid.width; x++) {
        expect(loaded.grid.at(x, y).road).toBe(world.grid.at(x, y).road);
      }
    }
  });
});

describe('roundtrip: serialize v polovici behu → deserialize → dobehnúť', () => {
  let finalHash = '';

  beforeAll(() => {
    finalHash = stateHash(runWithCheckpoints(scenario.seed, scenario.commands, new Set()).world);
  });

  // Rozdelenie vrátane hraníc príkazov (tick 0, 100, 200, 12000: príkaz čaká na aplikovanie hneď po načítaní).
  const SPLITS = [0, 1, 99, 100, 101, 200, 5000, 11_999, 12_000, 12_001, 19_999];

  it.each(SPLITS)('rozdelenie v ticku %i dá rovnaký hash ako nepretržitý beh', (split) => {
    const original = World.create(defs, map, scenario.seed);
    runScenario(original, scenario, split, { afterTick: assertCargoConservation });
    const saved = stateHash(original);

    // Načítanie z čistého JSON reťazca — ako po uložení do súboru / localStorage.
    const resumed = World.deserialize(defs, map, JSON.parse(saved) as State);
    expect(stateHash(resumed)).toBe(saved);

    const resumedEvents = runScenario(resumed, scenario, RUN_TICKS, { afterTick: assertCargoConservation });
    const originalEvents = runScenario(original, scenario, RUN_TICKS);

    expect(stateHash(resumed)).toBe(finalHash);
    expect(stateHash(original)).toBe(finalHash);
    expect(resumedEvents).toEqual(originalEvents); // aj udalosti po načítaní sú rovnaké
  });

  it('reťazený roundtrip: save → load každých 2 500 tickov dá rovnaký výsledok', () => {
    let world = World.create(defs, map, scenario.seed);
    for (let until = 2500; until <= RUN_TICKS; until += 2500) {
      runScenario(world, scenario, until, { afterTick: assertCargoConservation });
      world = World.deserialize(defs, map, JSON.parse(stateHash(world)) as State);
    }
    expect(world.clock.tick).toBe(RUN_TICKS);
    expect(stateHash(world)).toBe(finalHash);
  });

  it('načítaný svet je nezávislý od pôvodného (beh jedného neovplyvní druhý)', () => {
    const original = World.create(defs, map, scenario.seed);
    runScenario(original, scenario, 6500);
    const before = stateHash(original);

    const copy = World.deserialize(defs, map, JSON.parse(before) as State);
    runScenario(copy, scenario, RUN_TICKS);

    expect(stateHash(original)).toBe(before);
    expect(stateHash(copy)).toBe(finalHash);
  });
});
