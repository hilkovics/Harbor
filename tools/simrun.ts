// Headless runner scenára (ARCHITECTURE §16): načíta scenár, odsimuluje N tickov a vypíše report.
// Spustenie: `pnpm simrun <scenario.json> --ticks N [--report]`. Exit 1 pri akejkoľvek chybe (správa na stderr).
// Logika je exportovaná (`parseArgs`, `loadScenario`, `runScenario`), CLI sa spustí len pri priamom behu súboru.
//
// Beh nad skutočným `World` (od fázy 1): `World.create(defs, mapa, seed)`; príkazy scenára sa vo fronte sveta
// objavia presne pred tickom `atTick` (replay, ARCHITECTURE §12.2). Odmietnutý príkaz = chyba scenára → exit 1.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, commandFromJSON, type Command, type SerializedCommand } from '@sim/commands';
import { loadBundledDefs, type DefRegistry } from '@sim/defs';
import { loadBundledMap, loadMap, parseMapDef, type LoadedMap } from '@sim/grid';
import { World } from '@sim/world';

// ---------------------------------------------------------------------------------------------------------
// Scenár
// ---------------------------------------------------------------------------------------------------------

/** Jeden riadok replaye: príkaz, ktorý sa aplikuje pred tickom `atTick` (ARCHITECTURE §12.2). */
export interface ScenarioEntry {
  /** Celé číslo ≥ 0; záznamy v scenári sú zoradené neklesajúco (rovnaký tick = poradie zo scenára). */
  readonly atTick: number;
  /** Serializovaný `Command` (`{ type, … }`); zostaví ho `commandFromJSON`. */
  readonly command: unknown;
}

/** Scenár = seed + (voliteľná) mapa + zoznam príkazov. */
export interface Scenario {
  readonly id: string;
  /** Seed jediného `Rng` (ARCHITECTURE §14); celé číslo ≥ 0. */
  readonly seed: number;
  /** Cesta k mape (relatívna k pracovnému adresáru, rovnako ako cesta k scenáru). */
  readonly map?: string;
  readonly commands: readonly ScenarioEntry[];
}

/** Scenár po načítaní; `mapData` je surový JSON súboru `map` (`runScenario` ho spracuje `parseMapDef` + `loadMap`). */
export interface LoadedScenario extends Scenario {
  readonly mapData?: unknown;
}

/** Očakávaná chyba použitia alebo vstupu (nie chyba programu) — CLI ju vypíše bez stack trace. */
export class SimrunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimrunError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------

/**
 * Report behu. Kľúče a ich poradie sú záväzné — číta ich `test-runner` a budúce golden reporty.
 * Metriky, ktoré ešte nie sú implementované, sú `null` (nie 0), aby sa nedali zameniť za nameranú nulu.
 */
export interface SimrunReport {
  readonly scenario: string;
  readonly seed: number;
  /** Vykonané ticky (= `clock.tick`). */
  readonly ticks: number;
  /** Uplynulé herné dni (= `clock.gameDay`). */
  readonly gameDays: number;
  /** Hotovosť na konci v centoch (`world.cashCents`). */
  readonly cashEnd: number;
  /** Exportované jednotky nákladu; do fázy 2 (náklad) vždy 0. */
  readonly exportedUnits: number;
  /** Stratené jednotky nákladu; musí byť 0 (CLAUDE.md, `/sim-check`). Do fázy 2 (náklad) vždy 0. */
  readonly lostUnits: number;
  readonly onTimeRate: number | null;
  readonly craneBlockedPct: number | null;
  /** Počet buniek s cestou (`road === 'road'`) na konci behu, vrátane štartovacích ciest mapy. */
  readonly roads: number;
  /** Príkazy scenára aplikované pred tickom `atTick < ticks` (každý prešiel validáciou, inak beh končí chybou). */
  readonly commandsApplied: number;
  /** Príkazy s `atTick ≥ ticks` — beh skončil skôr, než na ne prišiel rad. */
  readonly commandsSkipped: number;
}

// ---------------------------------------------------------------------------------------------------------
// Argumenty
// ---------------------------------------------------------------------------------------------------------

export interface SimrunArgs {
  readonly scenarioPath: string;
  readonly ticks: number;
  readonly report: boolean;
}

export const USAGE = 'použitie: pnpm simrun <scenario.json> --ticks N [--report]';

const TICKS_FLAG = '--ticks';
const REPORT_FLAG = '--report';

function parseTicks(raw: string | undefined): number {
  if (raw === undefined || raw === '') throw new SimrunError(`${TICKS_FLAG} vyžaduje hodnotu. ${USAGE}`);
  // Len desiatkový zápis kladného celého čísla; "1e3", "0x10", "1.5", "-5" a "0" sú chyby.
  const ticks = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(ticks)) {
    throw new SimrunError(`${TICKS_FLAG} musí byť kladné celé číslo, dostal "${raw}"`);
  }
  return ticks;
}

/** Spracuje argumenty bez `node`/skriptu. Chyba použitia → `SimrunError`. `--ticks` je povinné. */
export function parseArgs(argv: readonly string[]): SimrunArgs {
  let scenarioPath: string | undefined;
  let ticksRaw: string | undefined;
  let ticksGiven = false;
  let report = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === TICKS_FLAG) {
      ticksGiven = true;
      ticksRaw = argv[i + 1];
      i += 1;
    } else if (arg.startsWith(`${TICKS_FLAG}=`)) {
      ticksGiven = true;
      ticksRaw = arg.slice(TICKS_FLAG.length + 1);
    } else if (arg === REPORT_FLAG) {
      report = true;
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
  return { scenarioPath, ticks: parseTicks(ticksRaw), report };
}

// ---------------------------------------------------------------------------------------------------------
// Načítanie scenára
// ---------------------------------------------------------------------------------------------------------

const SCENARIO_KEYS: ReadonlySet<string> = new Set(['id', 'seed', 'map', 'commands']);

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new SimrunError(`${what} "${path}" sa nedá prečítať: ${errorMessage(cause)}`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SimrunError(`${what} "${path}" nie je platný JSON: ${errorMessage(cause)}`);
  }
}

function validateEntries(raw: unknown[], path: string): ScenarioEntry[] {
  let previousTick = 0;
  return raw.map((entry, index) => {
    const at = `${path}: /commands/${String(index)}`;
    if (!isPlainObject(entry)) throw new SimrunError(`${at} musí byť objekt { atTick, command }`);
    for (const key of Object.keys(entry)) {
      if (key !== 'atTick' && key !== 'command') throw new SimrunError(`${at}/${key} je neznámy kľúč`);
    }
    const { atTick, command } = entry;
    if (typeof atTick !== 'number' || !Number.isSafeInteger(atTick) || atTick < 0) {
      throw new SimrunError(`${at}/atTick musí byť celé číslo ≥ 0`);
    }
    if (atTick < previousTick) {
      throw new SimrunError(`${at}/atTick ${String(atTick)} je menší než predchádzajúci ${String(previousTick)} (záznamy musia byť neklesajúce)`);
    }
    previousTick = atTick;
    if (!isPlainObject(command)) throw new SimrunError(`${at}/command musí byť objekt`);
    return { atTick, command };
  });
}

/**
 * Načíta a zvaliduje scenár `{ id, seed, map?, commands }`. Ak je uvedená `map`, súbor sa načíta a parsuje ako JSON
 * (tvar mapy overí až `runScenario`). Záznamy `commands` musia mať `atTick` neklesajúci. Typy a payloady príkazov
 * sa overujú v `runScenario`. Akákoľvek chyba (súbor, JSON, tvar) → `SimrunError`.
 */
export function loadScenario(path: string): LoadedScenario {
  const raw = readJsonFile(path, 'scenár');
  if (!isPlainObject(raw)) throw new SimrunError(`${path}: scenár musí byť objekt`);

  for (const key of Object.keys(raw)) {
    if (!SCENARIO_KEYS.has(key)) throw new SimrunError(`${path}: /${key} je neznámy kľúč`);
  }
  const { id, seed, map, commands } = raw;
  if (typeof id !== 'string' || id === '') throw new SimrunError(`${path}: /id musí byť neprázdny reťazec`);
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) {
    throw new SimrunError(`${path}: /seed musí byť celé číslo ≥ 0`);
  }
  if (map !== undefined && (typeof map !== 'string' || map === '')) {
    throw new SimrunError(`${path}: /map musí byť neprázdny reťazec (cesta k mape)`);
  }
  if (!Array.isArray(commands)) throw new SimrunError(`${path}: /commands musí byť pole`);

  const scenario: Scenario = { id, seed, commands: validateEntries(commands, path), ...(map !== undefined && { map }) };

  if (scenario.map === undefined) return scenario;
  return { ...scenario, mapData: readJsonFile(scenario.map, 'mapa') };
}

// ---------------------------------------------------------------------------------------------------------
// Beh
// ---------------------------------------------------------------------------------------------------------

interface ParsedEntry {
  readonly atTick: number;
  readonly command: Command;
}

/** Zostaví príkazy zo scenára vopred (pred prvým tickom), aby neplatný typ/payload zlyhal s cestou `/commands/i`. */
function parseCommands(scenario: Scenario): ParsedEntry[] {
  return scenario.commands.map((entry, index) => {
    try {
      return { atTick: entry.atTick, command: commandFromJSON(entry.command as SerializedCommand) };
    } catch (cause) {
      if (cause instanceof CommandError) {
        throw new SimrunError(`${scenario.id}: /commands/${String(index)}/command: ${cause.message}`);
      }
      throw cause;
    }
  });
}

/** Mapa scenára (`map` = cesta k súboru, `mapData` = jeho obsah); bez `map` vstavaná `harbor_01`. */
function resolveMap(scenario: LoadedScenario): LoadedMap {
  if (scenario.map === undefined) return loadBundledMap();
  const raw = scenario.mapData ?? readJsonFile(scenario.map, 'mapa');
  try {
    return loadMap(parseMapDef(raw));
  } catch (cause) {
    throw new SimrunError(`mapa "${scenario.map}" je neplatná: ${errorMessage(cause)}`);
  }
}

function countRoads(world: World): number {
  let roads = 0;
  for (let i = 0; i < world.grid.cellCount; i++) {
    if (world.grid.atIndex(i).road === 'road') roads += 1;
  }
  return roads;
}

/**
 * Odsimuluje `ticks` tickov (kladné celé číslo) a zostaví report. Pred každým tickom sa do fronty sveta zaradia
 * všetky príkazy s `atTick === world.clock.tick` (v poradí zo scenára) a zavolá sa `applyPending()`; odmietnutý
 * príkaz (`CommandRejected`) ukončí beh chybou. Príkazy s `atTick ≥ ticks` sa nevykonajú (`commandsSkipped`).
 * Rovnaký scenár + seed + defy + mapa → identický report.
 */
export function runScenario(scenario: LoadedScenario, ticks: number, defs: DefRegistry): SimrunReport {
  if (!Number.isSafeInteger(ticks) || ticks < 1) {
    throw new SimrunError(`ticks musí byť kladné celé číslo, dostal ${String(ticks)}`);
  }
  const entries = parseCommands(scenario);
  const world = World.create(defs, resolveMap(scenario), scenario.seed);

  let next = 0;
  for (let i = 0; i < ticks; i++) {
    const tick = world.clock.tick;
    while (next < entries.length && entries[next].atTick === tick) {
      world.enqueue(entries[next].command);
      next += 1;
    }
    const rejected = world.applyPending().filter((event) => event.type === 'CommandRejected');
    if (rejected.length > 0) {
      const what = rejected.map((event) => `${event.commandType}: ${event.reasons.join(', ')}`).join('; ');
      throw new SimrunError(`${scenario.id}: príkaz odmietnutý pri atTick ${String(tick)} — ${what}`);
    }
    world.tick();
  }

  return {
    scenario: scenario.id,
    seed: scenario.seed,
    ticks: world.clock.tick,
    gameDays: world.clock.gameDay,
    cashEnd: world.cashCents,
    exportedUnits: 0, // náklad až od fázy 2
    lostUnits: 0,
    onTimeRate: null,
    craneBlockedPct: null,
    roads: countRoads(world),
    commandsApplied: next,
    commandsSkipped: entries.length - next,
  };
}

/** Jednoriadkové ľudské zhrnutie (výstup bez `--report`). */
export function formatSummary(report: SimrunReport): string {
  const metric = (value: number | null): string => (value === null ? 'n/a' : String(value));
  return (
    `simrun ${report.scenario}: seed ${String(report.seed)}, ${String(report.ticks)} tickov ` +
    `(${String(report.gameDays)} dní), cash ${String(report.cashEnd)}, exportované ${String(report.exportedUnits)}, ` +
    `stratené ${String(report.lostUnits)}, on-time ${metric(report.onTimeRate)}, žeriav blokovaný ${metric(report.craneBlockedPct)}, ` +
    `cesty ${String(report.roads)}, príkazy ${String(report.commandsApplied)} (preskočené ${String(report.commandsSkipped)})`
  );
}

function main(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv);
    const report = runScenario(loadScenario(args.scenarioPath), args.ticks, loadBundledDefs());
    // S `--report` ide na stdout IBA JSON (parsovateľný `JSON.parse`), inak jedno riadkové zhrnutie.
    console.log(args.report ? JSON.stringify(report, null, 2) : formatSummary(report));
    return 0;
  } catch (cause) {
    console.error(`simrun: ${errorMessage(cause)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode namiesto process.exit(): stdout sa pri rúre stihne vyprázdniť.
  process.exitCode = main(process.argv.slice(2));
}
