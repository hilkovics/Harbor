// Meranie výkonu `world.tick()` (Fáza 6, rozhodnutie 8): načíta scenár rovnako ako simrun (zdieľaný loader), odsimuluje
// N tickov a vypíše priemer, p50, p95, max, počet tickov nad prahom a ticks/s.
// Spustenie: `pnpm bench <scenario.json> --ticks N [--json] [--profile] [--warmup N] [--no-invariants]`.
// Exit 1 pri akejkoľvek chybe (správa na stderr). Meranie času (`performance.now`) je dovolené LEN v tools/ — src/sim je čistý.
//
// Meria sa iba `world.tick()`; príkazy scenára sa aplikujú pred tickom cez `applyPending()` mimo merania (rovnako ako
// v simrun). Predvolene beží krok 12 ticku (`checkInvariants`, rovnako ako simrun a vývojový build); produkčný build ho má
// vypnutý (`APP_WORLD_OPTIONS`) → `--no-invariants`.
//
// `--profile`: druhý beh na novom svete s časovačmi okolo krokov ticku (rozpad po systémoch) a okolo A*. Bez zmeny
// src/sim: systémy sú súkromné polia `World`, takže sa k nim pristupuje cez index a ich `tick` sa na inštancii obalí
// (krehké voči premenovaniu polí — chýbajúci krok sa vypíše v `unavailable`, nie je to chyba). Rozpad je len orientačný:
// časovače pridávajú réžiu; celkové čísla hlavičky pochádzajú z behu bez nich.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundledDefs, type DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import {
  SimrunError,
  errorMessage,
  loadScenario,
  parseCommands,
  parseTicks,
  resolveMap,
  type LoadedScenario,
} from './simrun';

// ---------------------------------------------------------------------------------------------------------
// Konštanty
// ---------------------------------------------------------------------------------------------------------

/** Tick pomalší než táto hodnota (v ms) sa počíta do `overThresholdTicks` (cieľ F6: priemer pod 2 ms). */
export const SLOW_TICK_MS = 2;

const PERCENT = 100;
const P50 = 50;
const P95 = 95;
const MS_PER_SECOND = 1000;
/** Zaokrúhlenie výstupu na desaťtisíciny ms (0,1 µs) — čitateľné JSON a stabilné pri porovnávaní reportov. */
const MS_DECIMALS = 4;
const RATE_DECIMALS = 1;
/** Koľko najpomalších tickov sa vypíše v reporte (čísla ticku → korelácia s udalosťami: hranice hodiny/dňa, spawn lode…). */
const SLOWEST_COUNT = 5;

export const USAGE = 'použitie: pnpm bench <scenario.json> --ticks N [--json] [--profile] [--warmup N] [--no-invariants]';

const TICKS_FLAG = '--ticks';
const WARMUP_FLAG = '--warmup';
const JSON_FLAG = '--json';
const PROFILE_FLAG = '--profile';
const NO_INVARIANTS_FLAG = '--no-invariants';

// ---------------------------------------------------------------------------------------------------------
// Argumenty
// ---------------------------------------------------------------------------------------------------------

export interface BenchArgs {
  readonly scenarioPath: string;
  readonly ticks: number;
  /** Prvých `warmup` tickov sa odsimuluje, ale nezapočíta do štatistík (JIT, lenivé cache). */
  readonly warmup: number;
  readonly json: boolean;
  readonly profile: boolean;
  readonly checkInvariants: boolean;
}

function parseWarmup(raw: string | undefined): number {
  if (raw === undefined || raw === '') throw new SimrunError(`${WARMUP_FLAG} vyžaduje hodnotu. ${USAGE}`);
  // Celé číslo ≥ 0 v desiatkovom zápise (0 je platné — žiadne zahriatie).
  const warmup = /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(warmup)) {
    throw new SimrunError(`${WARMUP_FLAG} musí byť celé číslo ≥ 0, dostal "${raw}"`);
  }
  return warmup;
}

/** Spracuje argumenty bez `node`/skriptu. Chyba použitia → `SimrunError`. `--ticks` je povinné. */
export function parseArgs(argv: readonly string[]): BenchArgs {
  let scenarioPath: string | undefined;
  let ticksRaw: string | undefined;
  let ticksGiven = false;
  let warmupRaw: string | undefined;
  let warmupGiven = false;
  let json = false;
  let profile = false;
  let checkInvariants = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === TICKS_FLAG) {
      ticksGiven = true;
      ticksRaw = argv[i + 1];
      i += 1;
    } else if (arg.startsWith(`${TICKS_FLAG}=`)) {
      ticksGiven = true;
      ticksRaw = arg.slice(TICKS_FLAG.length + 1);
    } else if (arg === WARMUP_FLAG) {
      warmupGiven = true;
      warmupRaw = argv[i + 1];
      i += 1;
    } else if (arg.startsWith(`${WARMUP_FLAG}=`)) {
      warmupGiven = true;
      warmupRaw = arg.slice(WARMUP_FLAG.length + 1);
    } else if (arg === JSON_FLAG) {
      json = true;
    } else if (arg === PROFILE_FLAG) {
      profile = true;
    } else if (arg === NO_INVARIANTS_FLAG) {
      checkInvariants = false;
    } else if (arg.startsWith('--')) {
      throw new SimrunError(`neznáma voľba ${arg}. ${USAGE}`);
    } else if (scenarioPath === undefined) {
      scenarioPath = arg;
    } else {
      throw new SimrunError(`nadbytočný argument "${arg}". ${USAGE}`);
    }
  }
  if (scenarioPath === undefined) throw new SimrunError(`chýba cesta k scenáru. ${USAGE}`);
  if (!ticksGiven) throw new SimrunError(`chýba povinná voľba ${TICKS_FLAG}. ${USAGE}`);
  const ticks = parseTicks(ticksRaw);
  const warmup = warmupGiven ? parseWarmup(warmupRaw) : 0;
  if (warmup >= ticks) {
    throw new SimrunError(`${WARMUP_FLAG} (${String(warmup)}) musí byť menšie než ${TICKS_FLAG} (${String(ticks)})`);
  }
  return { scenarioPath, ticks, warmup, json, profile, checkInvariants };
}

// ---------------------------------------------------------------------------------------------------------
// Štatistika
// ---------------------------------------------------------------------------------------------------------

/** Štatistiky času ticku v ms. Percentily metódou najbližšieho poradia (nearest-rank): prvok na indexe ⌈p/100·n⌉−1. */
export interface TickStats {
  readonly count: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Počet tickov so striktne vyšším časom než `thresholdMs`. */
  readonly overThresholdTicks: number;
}

/** Percentil `p` (0 < p ≤ 100) z **vzostupne zoradeného** poľa nenulovej dĺžky (nearest-rank). */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile: prázdna množina vzoriek');
  if (!(p > 0 && p <= PERCENT)) throw new RangeError(`percentile: p musí byť v (0, 100], dostal ${String(p)}`);
  const rank = Math.ceil((p / PERCENT) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Zhrnie vzorky (ms na tick) bez zmeny vstupu. Prázdna množina → `RangeError`. */
export function summarize(samplesMs: ArrayLike<number>, thresholdMs: number = SLOW_TICK_MS): TickStats {
  const count = samplesMs.length;
  if (count === 0) throw new RangeError('summarize: prázdna množina vzoriek');
  const sorted = Float64Array.from(samplesMs).sort();
  let total = 0;
  let over = 0;
  for (let i = 0; i < count; i++) {
    total += samplesMs[i];
    if (samplesMs[i] > thresholdMs) over += 1;
  }
  return {
    count,
    totalMs: total,
    meanMs: total / count,
    p50Ms: percentile(sorted, P50),
    p95Ms: percentile(sorted, P95),
    maxMs: sorted[count - 1],
    overThresholdTicks: over,
  };
}

/** `count` najpomalších vzoriek zostupne; `tick` = `firstTick` + index (tick, ktorý vzorka zmerala, má `clock.tick` = index + 1). */
export function slowestSamples(samplesMs: ArrayLike<number>, firstTick: number, count: number = SLOWEST_COUNT): SlowTick[] {
  const indices = Array.from({ length: samplesMs.length }, (_, index) => index);
  // Zhodný čas → skorší tick (stabilné poradie).
  indices.sort((a, b) => samplesMs[b] - samplesMs[a] || a - b);
  return indices.slice(0, count).map((index) => ({ tick: firstTick + index + 1, ms: round(samplesMs[index], MS_DECIMALS) }));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------------------------------------
// Profiler krokov (bez zmeny src/sim)
// ---------------------------------------------------------------------------------------------------------

/** Krok `World.tick()` a jeho umiestnenie: pole systému (`<pole>.tick`) alebo metóda sveta. */
interface StepSpec {
  readonly name: string;
  readonly owner: 'world' | 'field';
  /** `owner: 'world'` → názov metódy sveta; `owner: 'field'` → názov súkromného poľa s metódou `tick`. */
  readonly key: string;
}

/** Disjunktné kroky ticku v poradí ARCHITECTURE §6 (príkazy, hodiny, systémy 2–6, 8, 9, 11, invarianty). */
const STEPS: readonly StepSpec[] = [
  { name: 'commands', owner: 'world', key: 'applyQueuedCommands' },
  { name: 'clock', owner: 'world', key: 'advanceClock' },
  { name: 'contracts', owner: 'field', key: 'contractSystem' },
  { name: 'ships', owner: 'field', key: 'shipSystem' },
  { name: 'cranes', owner: 'field', key: 'craneSystem' },
  { name: 'dispatcher', owner: 'field', key: 'dispatcherSystem' },
  { name: 'vehicles', owner: 'field', key: 'vehicleSystem' },
  { name: 'landside', owner: 'field', key: 'landsideSystem' },
  { name: 'economy', owner: 'field', key: 'economySystem' },
  { name: 'metrics', owner: 'field', key: 'metricsSystem' },
  { name: 'invariants', owner: 'world', key: 'assertInvariants' },
];

/** Vnorené merania (sú súčasťou niektorého kroku, do súčtu krokov sa nepočítajú): A* a kontrola zachovania nákladu. */
const NESTED: readonly { readonly name: string; readonly target: (world: World) => unknown; readonly key: string }[] = [
  { name: 'pathfinder.findPath', target: (world) => world.pathfinder, key: 'findPath' },
  { name: 'pathfinder.findCost', target: (world) => world.pathfinder, key: 'findCost' },
  { name: 'cargo.assertConservation', target: (world) => world.cargo, key: 'assertConservation' },
];

interface Accumulator {
  totalMs: number;
  calls: number;
  /** Čas v aktuálnom ticku (nuluje `endTick`). */
  tickMs: number;
  /** Čas len v pomalých tickoch (nad prahom). */
  slowMs: number;
}

type LooseRecord = Record<string, unknown>;
type LooseFn = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null;
}

/** Zbiera časy krokov; zapisuje len počas `world.tick()` (`active`), aby sa nezapočítal `applyPending()`. */
export class StepProfiler {
  active = false;
  readonly steps = new Map<string, Accumulator>();
  readonly nested = new Map<string, Accumulator>();
  readonly unavailable: string[] = [];

  /** Obalí `owner[key]` časovačom. Vráti `false`, ak tam funkcia nie je. */
  wrap(into: Map<string, Accumulator>, name: string, owner: LooseRecord, key: string): boolean {
    const original = owner[key];
    if (typeof original !== 'function') {
      this.unavailable.push(name);
      return false;
    }
    const acc: Accumulator = { totalMs: 0, calls: 0, tickMs: 0, slowMs: 0 };
    into.set(name, acc);
    owner[key] = (...args: unknown[]): unknown => {
      if (!this.active) return (original as LooseFn).apply(owner, args);
      const start = performance.now();
      try {
        return (original as LooseFn).apply(owner, args);
      } finally {
        const elapsed = performance.now() - start;
        acc.totalMs += elapsed;
        acc.tickMs += elapsed;
        acc.calls += 1;
      }
    };
    return true;
  }

  /** Počet tickov nad prahom a ich súčet — základ pre rozpad pomalých tickov. */
  slowTicks = 0;
  slowTotalMs = 0;

  /** Uzavrie meraný tick: ak bol pomalý, jeho časy krokov sa pripočítajú k pomalým; potom vynuluje časy ticku. */
  endTick(elapsedMs: number): void {
    const slow = elapsedMs > SLOW_TICK_MS;
    if (slow) {
      this.slowTicks += 1;
      this.slowTotalMs += elapsedMs;
    }
    for (const group of [this.steps, this.nested]) {
      for (const acc of group.values()) {
        if (slow) acc.slowMs += acc.tickMs;
        acc.tickMs = 0;
      }
    }
  }

  instrument(world: World): void {
    const root = world as unknown as LooseRecord;
    for (const step of STEPS) {
      if (step.owner === 'world') {
        this.wrap(this.steps, step.name, root, step.key);
        continue;
      }
      const system = root[step.key];
      if (isRecord(system)) this.wrap(this.steps, step.name, system, 'tick');
      else this.unavailable.push(step.name);
    }
    for (const spec of NESTED) {
      const target = spec.target(world);
      if (isRecord(target)) this.wrap(this.nested, spec.name, target, spec.key);
      else this.unavailable.push(spec.name);
    }
  }
}

export interface ProfileLine {
  readonly name: string;
  readonly totalMs: number;
  /** Priemer na tick (celkový čas kroku / počet zmeraných tickov). */
  readonly meanMs: number;
  /** Podiel na celkovom čase ticku v profilovanom behu, v %. */
  readonly sharePct: number;
  readonly calls: number;
}

export interface ProfileReport {
  /** Celkový čas ticku v profilovanom behu (s réžiou časovačov — vyšší než v hlavičke reportu). */
  readonly profiledTotalMs: number;
  /** Kroky ticku zoradené zostupne podľa času; prvých 5 = „top 5 systémov". */
  readonly steps: readonly ProfileLine[];
  /** Zvyšok ticku mimo meraných krokov (flush udalostí, réžia). */
  readonly otherMs: number;
  /** Vnorené merania (A*), súčasť krokov vyššie. */
  readonly nested: readonly ProfileLine[];
  /** Rozpad len pomalých tickov (nad prahom): kde sa v nich stráca čas. `totalMs` = čas kroku v pomalých tickoch. */
  readonly slowTicks: { readonly count: number; readonly totalMs: number; readonly steps: readonly ProfileLine[]; readonly nested: readonly ProfileLine[] };
  /** Kroky, ktoré sa nepodarilo obaliť (premenovanie polí v `World`). */
  readonly unavailable: readonly string[];
  /** Počítadlá A* a cache ciest na konci profilovaného behu (verejné `diagnostics()`). */
  readonly pathfinder: { readonly searches: number };
  readonly pathCache: { readonly size: number; readonly hits: number; readonly misses: number; readonly invalidations: number };
  readonly distances: { readonly size: number; readonly hits: number; readonly misses: number; readonly invalidations: number };
}

function toLines(
  map: ReadonlyMap<string, Accumulator>,
  ticks: number,
  totalMs: number,
  pick: (acc: Accumulator) => number = (acc) => acc.totalMs,
): ProfileLine[] {
  return [...map.entries()]
    .map(([name, acc]) => ({
      name,
      totalMs: round(pick(acc), MS_DECIMALS),
      meanMs: ticks === 0 ? 0 : round(pick(acc) / ticks, MS_DECIMALS),
      sharePct: totalMs === 0 ? 0 : round((pick(acc) / totalMs) * PERCENT, RATE_DECIMALS),
      calls: acc.calls,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

// ---------------------------------------------------------------------------------------------------------
// Beh
// ---------------------------------------------------------------------------------------------------------

export interface BenchOptions {
  readonly ticks: number;
  readonly warmup?: number;
  readonly checkInvariants?: boolean;
  readonly profile?: boolean;
}

export interface BenchReport {
  readonly scenario: string;
  readonly seed: number;
  /** Všetky odsimulované ticky (vrátane zahriatia). */
  readonly ticks: number;
  readonly warmupTicks: number;
  readonly measuredTicks: number;
  readonly checkInvariants: boolean;
  readonly thresholdMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Súčet časov zmeraných tickov (čistý čas `world.tick()`, bez príkazov a bez réžie cyklu). */
  readonly totalMs: number;
  /** Ticky so striktne vyšším časom než `thresholdMs`. */
  readonly overThresholdTicks: number;
  /** Zmerané ticky / súčet ich časov (sim-ticks za sekundu čistého času `tick()`). */
  readonly ticksPerSecond: number;
  /** Najpomalšie ticky zostupne podľa času (`tick` = `clock.tick` po tomto ticku). */
  readonly slowestTicks: readonly SlowTick[];
  /** Prítomné len s `profile: true`. */
  readonly profile?: ProfileReport;
}

export interface SlowTick {
  readonly tick: number;
  readonly ms: number;
}

/** Úplné nastavenie behu (po doplnení predvolených hodnôt). */
export interface PlayOptions {
  readonly ticks: number;
  readonly warmup: number;
  readonly checkInvariants: boolean;
}

export interface PlayResult {
  readonly world: World;
  /** Čas `world.tick()` v ms pre každý tick po zahriatí. */
  readonly samplesMs: Float64Array;
}

/**
 * Prehrá scenár `ticks` tickov na novom svete (`World.create` s `checkInvariants`) a zmeria každý `world.tick()`.
 * Príkazy scenára sa aplikujú pred tickom `atTick` cez `applyPending()` mimo merania; odmietnutý príkaz = chyba scenára.
 * `instrument` sa zavolá po vytvorení sveta (profiler); `setActive(true)` hlási meraný `tick()` (po zahriatí), `false` po ňom.
 */
export function playScenario(
  scenario: LoadedScenario,
  defs: DefRegistry,
  options: PlayOptions,
  hooks: {
    readonly instrument?: (world: World) => void;
    readonly setActive?: (active: boolean) => void;
    /** Po meranom ticku: jeho čas v ms. */
    readonly onMeasuredTick?: (elapsedMs: number) => void;
  } = {},
): PlayResult {
  const { ticks, warmup, checkInvariants } = options;
  if (!Number.isSafeInteger(ticks) || ticks < 1) {
    throw new SimrunError(`ticks musí byť kladné celé číslo, dostal ${String(ticks)}`);
  }
  if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup >= ticks) {
    throw new SimrunError(`warmup musí byť celé číslo v rozsahu 0…${String(ticks - 1)}, dostal ${String(warmup)}`);
  }
  const entries = parseCommands(scenario);
  const world = World.create(defs, resolveMap(scenario), scenario.seed, { checkInvariants });
  hooks.instrument?.(world);
  const samplesMs = new Float64Array(ticks - warmup);
  let next = 0;
  for (let i = 0; i < ticks; i++) {
    const tick = world.clock.tick;
    while (next < entries.length && entries[next].atTick === tick) {
      world.enqueue(entries[next].command);
      next += 1;
    }
    const applied = world.applyPending();
    const rejected = applied.filter((event) => event.type === 'CommandRejected');
    if (rejected.length > 0) {
      const what = rejected.map((event) => `${event.commandType}: ${event.reasons.join(', ')}`).join('; ');
      throw new SimrunError(`${scenario.id}: príkaz odmietnutý pri atTick ${String(tick)} — ${what}`);
    }
    hooks.setActive?.(i >= warmup);
    const start = performance.now();
    world.tick();
    const elapsed = performance.now() - start;
    hooks.setActive?.(false);
    if (i >= warmup) {
      samplesMs[i - warmup] = elapsed;
      hooks.onMeasuredTick?.(elapsed);
    }
  }
  return { world, samplesMs };
}

function profileRun(scenario: LoadedScenario, defs: DefRegistry, options: PlayOptions): ProfileReport {
  const profiler = new StepProfiler();
  const { world, samplesMs } = playScenario(scenario, defs, options, {
    instrument: (w) => {
      profiler.instrument(w);
    },
    setActive: (active) => {
      profiler.active = active;
    },
    onMeasuredTick: (elapsedMs) => {
      profiler.endTick(elapsedMs);
    },
  });
  // Profiler zapisuje len počas meraných ticku (po zahriatí), takže sa zhoduje so `samplesMs`.
  const measured = samplesMs.length;
  let totalMs = 0;
  for (const sample of samplesMs) totalMs += sample;
  let stepsMs = 0;
  for (const acc of profiler.steps.values()) stepsMs += acc.totalMs;
  return {
    profiledTotalMs: round(totalMs, MS_DECIMALS),
    steps: toLines(profiler.steps, measured, totalMs),
    otherMs: round(Math.max(0, totalMs - stepsMs), MS_DECIMALS),
    nested: toLines(profiler.nested, measured, totalMs),
    slowTicks: {
      count: profiler.slowTicks,
      totalMs: round(profiler.slowTotalMs, MS_DECIMALS),
      steps: toLines(profiler.steps, profiler.slowTicks, profiler.slowTotalMs, (acc) => acc.slowMs),
      nested: toLines(profiler.nested, profiler.slowTicks, profiler.slowTotalMs, (acc) => acc.slowMs),
    },
    unavailable: profiler.unavailable,
    pathfinder: { searches: world.pathfinder.diagnostics().searches },
    pathCache: world.paths.diagnostics(),
    distances: world.distances.diagnostics(),
  };
}

/** Zmeria scenár a vráti report. S `profile: true` pridá druhý beh s rozpadom po krokoch ticku. */
export function runBench(scenario: LoadedScenario, defs: DefRegistry, options: BenchOptions): BenchReport {
  const resolved: PlayOptions = { ticks: options.ticks, warmup: options.warmup ?? 0, checkInvariants: options.checkInvariants ?? true };
  const { samplesMs } = playScenario(scenario, defs, resolved);
  const slowestTicks = slowestSamples(samplesMs, resolved.warmup);
  const stats = summarize(samplesMs, SLOW_TICK_MS);
  const base: BenchReport = {
    scenario: scenario.id,
    seed: scenario.seed,
    ticks: resolved.ticks,
    warmupTicks: resolved.warmup,
    measuredTicks: stats.count,
    checkInvariants: resolved.checkInvariants,
    thresholdMs: SLOW_TICK_MS,
    meanMs: round(stats.meanMs, MS_DECIMALS),
    p50Ms: round(stats.p50Ms, MS_DECIMALS),
    p95Ms: round(stats.p95Ms, MS_DECIMALS),
    maxMs: round(stats.maxMs, MS_DECIMALS),
    totalMs: round(stats.totalMs, MS_DECIMALS),
    overThresholdTicks: stats.overThresholdTicks,
    ticksPerSecond: stats.totalMs === 0 ? 0 : round((stats.count * MS_PER_SECOND) / stats.totalMs, RATE_DECIMALS),
    slowestTicks,
  };
  return options.profile === true ? { ...base, profile: profileRun(scenario, defs, resolved) } : base;
}

// ---------------------------------------------------------------------------------------------------------
// Výstup
// ---------------------------------------------------------------------------------------------------------

const TOP_STEPS = 5;

function formatLine(line: ProfileLine): string {
  return `  ${line.name.padEnd(20)} ${line.meanMs.toFixed(4)} ms/tick  ${line.sharePct.toFixed(1).padStart(5)} %  ${String(line.calls)} volaní`;
}

/** Ľudsky čitateľné zhrnutie (výstup bez `--json`). */
export function formatReport(report: BenchReport): string {
  const ms = (value: number): string => value.toFixed(4);
  const lines = [
    `bench ${report.scenario}: seed ${String(report.seed)}, ${String(report.ticks)} tickov` +
      ` (zmeraných ${String(report.measuredTicks)}, zahriatie ${String(report.warmupTicks)}), ` +
      `invarianty ${report.checkInvariants ? 'zapnuté' : 'vypnuté'}`,
    `  priemer ${ms(report.meanMs)} ms · p50 ${ms(report.p50Ms)} ms · p95 ${ms(report.p95Ms)} ms · max ${ms(report.maxMs)} ms`,
    `  ticky nad ${String(report.thresholdMs)} ms: ${String(report.overThresholdTicks)} · ${report.ticksPerSecond.toFixed(1)} ticks/s` +
      ` · čistý čas tick() ${(report.totalMs / MS_PER_SECOND).toFixed(2)} s`,
  ];
  lines.push(`  najpomalšie ticky: ${report.slowestTicks.map((slow) => `#${String(slow.tick)} ${slow.ms.toFixed(2)} ms`).join(' · ')}`);
  const profile = report.profile;
  if (profile !== undefined) {
    lines.push(`  rozpad po krokoch (profilovaný beh, ${(profile.profiledTotalMs / MS_PER_SECOND).toFixed(2)} s s réžiou časovačov; top ${String(TOP_STEPS)} označené *):`);
    profile.steps.forEach((line, index) => {
      lines.push(`${index < TOP_STEPS ? '*' : ' '}${formatLine(line)}`);
    });
    lines.push(`   ${'(mimo krokov)'.padEnd(20)} ${profile.otherMs.toFixed(4)} ms celkovo`);
    if (profile.slowTicks.count > 0) {
      lines.push(`  pomalé ticky (nad ${String(report.thresholdMs)} ms): ${String(profile.slowTicks.count)} tickov, spolu ${profile.slowTicks.totalMs.toFixed(1)} ms; kde sa strácal čas:`);
      for (const line of [...profile.slowTicks.steps, ...profile.slowTicks.nested].filter((l) => l.totalMs > 0).slice(0, TOP_STEPS)) {
        lines.push(`    ${line.name.padEnd(20)} ${line.totalMs.toFixed(1).padStart(9)} ms  ${line.sharePct.toFixed(1).padStart(5)} %`);
      }
    }
    for (const line of profile.nested) lines.push(`   vnorené:${formatLine(line)}`);
    lines.push(
      `  A*: ${String(profile.pathfinder.searches)} hľadaní · cache ciest: ${String(profile.pathCache.hits)} zásahov / ${String(profile.pathCache.misses)} miss` +
        ` / ${String(profile.pathCache.invalidations)} zneplatnení · matica vzdialeností: ${String(profile.distances.hits)} / ${String(profile.distances.misses)} / ${String(profile.distances.invalidations)}`,
    );
    if (profile.unavailable.length > 0) lines.push(`  nedostupné kroky profilu: ${profile.unavailable.join(', ')}`);
  }
  return lines.join('\n');
}

function main(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv);
    const report = runBench(loadScenario(args.scenarioPath), loadBundledDefs(), args);
    // S `--json` ide na stdout IBA JSON (parsovateľný `JSON.parse`), inak ľudské zhrnutie.
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (cause) {
    console.error(`bench: ${errorMessage(cause)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode namiesto process.exit(): stdout sa pri rúre stihne vyprázdniť.
  process.exitCode = main(process.argv.slice(2));
}
