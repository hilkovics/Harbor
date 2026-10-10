import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import {
  SLOW_TICK_MS,
  StepProfiler,
  formatReport,
  parseArgs,
  percentile,
  playScenario,
  runBench,
  slowestSamples,
  summarize,
  type BenchReport,
} from '../../tools/bench';
import { SimrunError, loadScenario, runScenario } from '../../tools/simrun';
import { DEFAULT_MAPS_DIR, DEFAULT_SCHEMAS_DIR, validateMapsDir } from '../../tools/validate-defs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH_SCRIPT = fileURLToPath(new URL('../../tools/bench.ts', import.meta.url));
const SMOKE_SCENARIO = fileURLToPath(new URL('../../data/scenarios/smoke.json', import.meta.url));
const VERTICAL_SLICE_SCENARIO = fileURLToPath(new URL('../../data/scenarios/vertical_slice.json', import.meta.url));
const STRESS_SCENARIO = fileURLToPath(new URL('../../data/scenarios/stress_f6.json', import.meta.url));
const TRAFFIC_STRESS_SCENARIO = fileURLToPath(new URL('../../data/scenarios/traffic_stress.json', import.meta.url));

// Prvá loď stress_f6 sa spawne v ticku 5 795 (kontrakty sa prijímajú v ticku 1, príchod 0,5–2 dňa).
const TICKS_TO_FIRST_SHIP = 6000;
// Krátky beh pre testy tvaru výstupu.
const SHORT_TICKS = 300;
// Behy so stovkami až tisíckami tickov so zapnutými invariantmi pri paralelnom behu celej sady presiahnu predvolených 15 s.
const HEAVY_TIMEOUT_MS = 120_000;

const SECONDS_PER_DAY = 86_400;

const defs = loadBundledDefs();

describe('parseArgs', () => {
  it('scenár + --ticks → predvolené: bez zahriatia, ľudský výstup, bez profilu, invarianty zapnuté', () => {
    expect(parseArgs(['s.json', '--ticks', '100'])).toEqual({
      scenarioPath: 's.json',
      ticks: 100,
      warmup: 0,
      json: false,
      profile: false,
      checkInvariants: true,
    });
  });

  it('všetky voľby vrátane tvaru --ticks=N a --warmup=N, poradie je ľubovoľné', () => {
    expect(parseArgs(['--json', '--profile', '--no-invariants', '--warmup=10', '--ticks=100', 's.json'])).toEqual({
      scenarioPath: 's.json',
      ticks: 100,
      warmup: 10,
      json: true,
      profile: true,
      checkInvariants: false,
    });
    expect(parseArgs(['s.json', '--warmup', '0', '--ticks', '5']).warmup).toBe(0);
  });

  it.each<[string, string[], RegExp]>([
    ['chýba scenár', ['--ticks', '5'], /chýba cesta k scenáru/],
    ['chýba --ticks', ['s.json'], /chýba povinná voľba --ticks/],
    ['--ticks bez hodnoty', ['s.json', '--ticks'], /--ticks vyžaduje hodnotu/],
    ['--ticks nula', ['s.json', '--ticks', '0'], /kladné celé číslo/],
    ['--ticks nie je celé číslo', ['s.json', '--ticks', '1.5'], /kladné celé číslo/],
    ['--warmup bez hodnoty', ['s.json', '--ticks', '5', '--warmup'], /--warmup vyžaduje hodnotu/],
    ['--warmup záporné', ['s.json', '--ticks', '5', '--warmup', '-1'], /--warmup musí byť celé číslo ≥ 0/],
    ['--warmup rovné --ticks', ['s.json', '--ticks', '5', '--warmup', '5'], /musí byť menšie než --ticks/],
    ['neznáma voľba', ['s.json', '--ticks', '5', '--fast'], /neznáma voľba --fast/],
    ['druhý scenár', ['a.json', 'b.json', '--ticks', '5'], /nadbytočný argument "b.json"/],
  ])('chyba použitia: %s', (_name, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(SimrunError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('percentile a summarize', () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('nearest-rank: p50 z 1…100 = 50, p95 = 95, p100 = 100', () => {
    const sorted = Float64Array.from(oneToHundred);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it('percentil malej množiny: 5 prvkov → p50 = 3. prvok, p95 = posledný', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(percentile([7], 50)).toBe(7);
  });

  it('neplatný vstup → RangeError', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => summarize([])).toThrow(RangeError);
  });

  it('summarize: priemer, p50, p95, max a počet tickov striktne nad prahom (zoradenie vstupu nezáleží)', () => {
    const shuffled = [...oneToHundred].reverse();
    expect(summarize(shuffled, 98)).toEqual({
      count: 100,
      totalMs: 5050,
      meanMs: 50.5,
      p50Ms: 50,
      p95Ms: 95,
      maxMs: 100,
      overThresholdTicks: 2,
    });
    // Rovné prahu sa nepočíta ako „nad".
    expect(summarize([1, 2, 2, 3], 2).overThresholdTicks).toBe(1);
    expect(SLOW_TICK_MS).toBe(2);
  });

  it('summarize nemení vstup', () => {
    const input = [3, 1, 2];
    summarize(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it('slowestSamples: zostupne podľa času, remíza → skorší tick, tick = firstTick + index + 1', () => {
    expect(slowestSamples([1, 9, 3, 9, 2], 0, 3)).toEqual([
      { tick: 2, ms: 9 },
      { tick: 4, ms: 9 },
      { tick: 3, ms: 3 },
    ]);
    expect(slowestSamples([5, 1], 100, 5)).toEqual([
      { tick: 101, ms: 5 },
      { tick: 102, ms: 1 },
    ]);
  });
});

describe('runBench: tvar výstupu', () => {
  const BASE_KEYS = [
    'scenario',
    'seed',
    'ticks',
    'warmupTicks',
    'measuredTicks',
    'checkInvariants',
    'thresholdMs',
    'meanMs',
    'p50Ms',
    'p95Ms',
    'maxMs',
    'totalMs',
    'overThresholdTicks',
    'ticksPerSecond',
    'slowestTicks',
  ];

  function expectSaneStats(report: BenchReport): void {
    expect(report.meanMs).toBeGreaterThan(0);
    expect(report.p50Ms).toBeLessThanOrEqual(report.p95Ms);
    expect(report.p95Ms).toBeLessThanOrEqual(report.maxMs);
    expect(report.meanMs).toBeLessThanOrEqual(report.maxMs);
    expect(report.overThresholdTicks).toBeGreaterThanOrEqual(0);
    expect(report.overThresholdTicks).toBeLessThanOrEqual(report.measuredTicks);
    expect(report.ticksPerSecond).toBeGreaterThan(0);
    expect(report.slowestTicks.length).toBeGreaterThan(0);
    expect(report.slowestTicks[0].ms).toBe(report.maxMs);
  }

  it('smoke bez príkazov: kľúče, počty a poradie štatistík; bez --profile nie je kľúč profile', () => {
    const report = runBench(loadScenario(SMOKE_SCENARIO), defs, { ticks: SHORT_TICKS });
    expect(Object.keys(report)).toEqual(BASE_KEYS);
    expect(report).toMatchObject({
      scenario: 'smoke',
      seed: 42,
      ticks: SHORT_TICKS,
      warmupTicks: 0,
      measuredTicks: SHORT_TICKS,
      checkInvariants: true,
      thresholdMs: SLOW_TICK_MS,
    });
    expectSaneStats(report);
    expect(report.slowestTicks.length).toBeLessThanOrEqual(5);
  });

  it('zahriatie sa nezapočíta do meraných tickov; --no-invariants sa premietne do reportu', () => {
    const report = runBench(loadScenario(SMOKE_SCENARIO), defs, { ticks: SHORT_TICKS, warmup: 100, checkInvariants: false });
    expect(report).toMatchObject({ ticks: SHORT_TICKS, warmupTicks: 100, measuredTicks: 200, checkInvariants: false });
    expectSaneStats(report);
    // Najpomalšie ticky patria do meranej časti (clock.tick > zahriatie).
    for (const slow of report.slowestTicks) expect(slow.tick).toBeGreaterThan(100);
  });

  it('report je čistý JSON (round-trip bez straty)', () => {
    const report = runBench(loadScenario(SMOKE_SCENARIO), defs, { ticks: 50, profile: true });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it(
    'vertical_slice s profilom: všetky kroky ticku, nezáporné čísla, A* a cache v diagnostike',
    () => {
      const report = runBench(loadScenario(VERTICAL_SLICE_SCENARIO), defs, { ticks: SHORT_TICKS, profile: true });
      expect(Object.keys(report)).toEqual([...BASE_KEYS, 'profile']);
      const profile = report.profile;
      expect(profile).toBeDefined();
      if (profile === undefined) return;
      expect(profile.unavailable).toEqual([]);
      expect(profile.steps.map((line) => line.name).sort()).toEqual(
        ['clock', 'commands', 'contracts', 'cranes', 'dispatcher', 'economy', 'invariants', 'landside', 'metrics', 'ships', 'vehicles'].sort(),
      );
      // Zoradené zostupne podľa času a každý krok sa zavolal raz za meraný tick.
      const totals = profile.steps.map((line) => line.totalMs);
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
      for (const line of profile.steps) {
        expect(line.calls).toBe(SHORT_TICKS);
        expect(line.totalMs).toBeGreaterThanOrEqual(0);
        expect(line.sharePct).toBeGreaterThanOrEqual(0);
      }
      expect(profile.nested.map((line) => line.name).sort()).toEqual(['cargo.assertConservation', 'pathfinder.findCost', 'pathfinder.findPath']);
      expect(profile.nested.find((line) => line.name === 'cargo.assertConservation')?.calls).toBe(SHORT_TICKS);
      expect(profile.otherMs).toBeGreaterThanOrEqual(0);
      expect(profile.pathfinder.searches).toBeGreaterThanOrEqual(0);
      expect(profile.pathCache.hits).toBeGreaterThanOrEqual(0);
      // formatReport vypíše hlavičku, štatistiky aj rozpad.
      const text = formatReport(report);
      expect(text).toContain('bench vertical_slice: seed 5005');
      expect(text).toMatch(/priemer .* ms · p50 .* ms · p95 .* ms · max .* ms/);
      expect(text).toMatch(/ticky nad 2 ms: \d+ · [\d.]+ ticks\/s/);
      expect(text).toContain('najpomalšie ticky: #');
      expect(text).toContain('landside');
    },
    HEAVY_TIMEOUT_MS,
  );

  it('neplatné nastavenie → SimrunError', () => {
    const scenario = loadScenario(SMOKE_SCENARIO);
    expect(() => runBench(scenario, defs, { ticks: 0 })).toThrow(SimrunError);
    expect(() => runBench(scenario, defs, { ticks: 10, warmup: 10 })).toThrow(/warmup musí byť/);
  });

  it('odmietnutý príkaz scenára je chyba (rovnako ako v simrun)', () => {
    const scenario = {
      ...loadScenario(SMOKE_SCENARIO),
      commands: [{ atTick: 0, command: { type: 'AcceptContract', contractId: 999 } }],
    };
    expect(() => runBench(scenario, defs, { ticks: 5 })).toThrow(/príkaz odmietnutý pri atTick 0/);
  });
});

describe('profil nemení simuláciu', () => {
  it(
    'stav sveta po behu s profilerom je zhodný s behom bez neho (stress_f6, vrátane spawnu prvej lode)',
    () => {
      const scenario = loadScenario(STRESS_SCENARIO);
      const options = { ticks: TICKS_TO_FIRST_SHIP, warmup: 0, checkInvariants: true };
      const plain = playScenario(scenario, defs, options).world;
      const profiler = new StepProfiler();
      const profiled = playScenario(scenario, defs, options, {
        instrument: (world) => {
          profiler.instrument(world);
        },
        setActive: (active) => {
          profiler.active = active;
        },
        onMeasuredTick: (elapsedMs) => {
          profiler.endTick(elapsedMs);
        },
      }).world;
      expect(profiler.unavailable).toEqual([]);
      expect(JSON.stringify(profiled.serialize())).toBe(JSON.stringify(plain.serialize()));
      expect(profiled.clock.tick).toBe(plain.clock.tick);
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe('stress_f6', () => {
  it('scenár je platný a mapa stress_f6 prejde map.schema.json', () => {
    const scenario = loadScenario(STRESS_SCENARIO);
    expect(scenario).toMatchObject({ id: 'stress_f6', map: 'data/maps/stress_f6.json' });
    expect(scenario.mapData).toMatchObject({ id: 'stress_f6' });
    const result = validateMapsDir(DEFAULT_MAPS_DIR, DEFAULT_SCHEMAS_DIR).find((r) => r.file === 'maps/stress_f6.json');
    expect(result).toEqual({ file: 'maps/stress_f6.json', errors: [] });
  });

  it('nepretržitý prísun kontraktov: prijatia v ticku 1 a potom v prvom ticku každého ďalšieho dňa', () => {
    const scenario = loadScenario(STRESS_SCENARIO);
    const accepts = scenario.commands.filter((entry) => (entry.command as { type: string }).type === 'AcceptContract');
    const ticksPerDay = SECONDS_PER_DAY / defs.time.tickGameSeconds;
    const ticks = [...new Set(accepts.map((entry) => entry.atTick))];
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    ticks.forEach((tick, day) => {
      expect(tick).toBe(day * ticksPerDay + 1);
    });
    // Import ponuky vznikajú v poradí id, 6 za deň (offersPerDay); booking ponuky (F6a, bookingOffersPerDay) zaberajú
    // medzi nimi ďalšie id (od druhej polnoci), preto id po dňoch nie sú súvislé, len vzostupné a po 6 za deň.
    const ids = accepts.map((entry) => (entry.command as { contractId: number }).contractId);
    expect(ids.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    // Prvé tri dni prijmú všetkých 6 ponúk; v neskorších dňoch sa neprijímajú ponuky, ktorým chýba kotvisko triedy lode (`no_berth_for_ship_class`, trieda handy) —
    // po R2 (ADR-039: plánovač mení prúd `Rng`) ich je v poole viac, preto aspoň 4 za deň.
    for (const tick of ticks) {
      const perDay = accepts.filter((entry) => entry.atTick === tick).length;
      expect(perDay).toBeLessThanOrEqual(defs.economy.offersPerDay);
      expect(perDay).toBeGreaterThanOrEqual(tick <= 2 * ticksPerDay ? defs.economy.offersPerDay : 4);
    }
  });

  it('každé AcceptContract scenára je platné: uvedené id je v ten tick import ponuka poolu (booking ponuky sa neprijímajú)', () => {
    const scenario = loadScenario(STRESS_SCENARIO);
    const accepts = scenario.commands.filter((entry) => (entry.command as { type: string }).type === 'AcceptContract');
    const lastTick = Math.max(...accepts.map((entry) => entry.atTick));
    // Beh bez invariantov (len prijatia): odmietnutý príkaz by bol chyba scenára — `playScenario` ju vyhodí.
    const { world } = playScenario(scenario, defs, { ticks: lastTick + 2, warmup: 0, checkInvariants: false });
    for (const entry of accepts) {
      const contract = world.contracts.get((entry.command as { contractId: number }).contractId as never);
      expect(contract?.kind).toBe('import');
      expect(contract?.acceptedTick).toBe(entry.atTick);
    }
  }, 120_000);

  it('rozšírený prístav: 2 kotviská, 4 žeriavy, 3 dvory, vstupný a výstupný pruh brány, 16 vozidiel (bez rampy a čakacej plochy, R4)', () => {
    const { world } = playScenario(loadScenario(STRESS_SCENARIO), defs, { ticks: 5, warmup: 0, checkInvariants: true });
    const counts = new Map<string, number>();
    for (const module of world.modules.values()) counts.set(module.def.id, (counts.get(module.def.id) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      berth_standard: 2,
      crane_container_gantry: 4,
      vehicle_depot: 2,
      container_yard_small: 3,
      gate_in_lane: 1,
      gate_out_lane: 1,
    });
    expect(world.vehicles.size).toBe(16);
  });

  it(
    'po spawne prvej lode: 6 prijatých kontraktov, žeriavy pracujú a stratené jednotky = 0',
    () => {
      const report = runScenario(loadScenario(STRESS_SCENARIO), TICKS_TO_FIRST_SHIP, defs);
      expect(report).toMatchObject({
        scenario: 'stress_f6',
        modules: 13,
        vehicles: 16,
        // R2 (ADR-039): menej kontajnerov na kontrakt a iný prúd `Rng` — do 6 000 tickov pricestuje druhá loď
        shipsSpawned: 2,
        lostUnits: 0,
        contractsAccepted: 6,
      });
      expect(report.craneCycles).toBeGreaterThan(0);
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe('traffic_stress (R1 bench)', () => {
  it('scenár je platný a mapa stress_f6 prejde validáciou', () => {
    const scenario = loadScenario(TRAFFIC_STRESS_SCENARIO);
    expect(scenario).toMatchObject({ id: 'traffic_stress', map: 'data/maps/stress_f6.json' });
    expect(scenario.mapData).toMatchObject({ id: 'stress_f6' });
  });

  it('po 30000 tickoch: stuckAtEnd = 0 (žiadna trvalá zápcha)', () => {
    const report = runScenario(loadScenario(TRAFFIC_STRESS_SCENARIO), 30000, defs);
    expect(report).toMatchObject({
      scenario: 'traffic_stress',
      lostUnits: 0,
    });
    expect(report.stuckAtEnd).toBe(0);
    expect(report.maxBlockedTicks).toBeGreaterThanOrEqual(0);
  }, HEAVY_TIMEOUT_MS);
});

describe('CLI', () => {
  function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', BENCH_SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it(
    '--json vypíše na stdout iba parsovateľný JSON',
    () => {
      const { status, stdout } = run([SMOKE_SCENARIO, '--ticks', '100', '--json']);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as BenchReport;
      expect(report).toMatchObject({ scenario: 'smoke', ticks: 100, measuredTicks: 100 });
      expect(report.meanMs).toBeGreaterThan(0);
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    'bez --json vypíše ľudské zhrnutie',
    () => {
      const { status, stdout } = run([SMOKE_SCENARIO, '--ticks', '100']);
      expect(status).toBe(0);
      expect(stdout).toContain('bench smoke: seed 42, 100 tickov');
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    'chyba použitia → exit 1, správa na stderr, stdout prázdny',
    () => {
      const { status, stdout, stderr } = run([SMOKE_SCENARIO]);
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/^bench: chýba povinná voľba --ticks/);
    },
    HEAVY_TIMEOUT_MS,
  );
});
