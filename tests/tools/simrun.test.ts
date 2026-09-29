import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { SimrunError, createStubWorld, formatSummary, loadScenario, parseArgs, runScenario } from '../../tools/simrun';
import type { Scenario } from '../../tools/simrun';

const SIMRUN_SCRIPT = fileURLToPath(new URL('../../tools/simrun.ts', import.meta.url));
const SMOKE_SCENARIO = fileURLToPath(new URL('../../data/scenarios/smoke.json', import.meta.url));

const SMOKE: Scenario = { id: 'smoke', seed: 42, commands: [] };
// Hodnota z data/defs/time.json (tickGameSeconds 10) → 8 640 tickov = 1 herný deň.
const TICKS_PER_DAY = 8640;

describe('parseArgs', () => {
  it('scenár + --ticks + --report', () => {
    expect(parseArgs(['a.json', '--ticks', '1000', '--report'])).toEqual({
      scenarioPath: 'a.json',
      ticks: 1000,
      report: true,
    });
  });

  it('--report je voliteľné, poradie argumentov nie je dôležité, podporuje --ticks=N', () => {
    expect(parseArgs(['--ticks=5', 'a.json'])).toEqual({ scenarioPath: 'a.json', ticks: 5, report: false });
  });

  it('chýbajúci --ticks → chyba', () => {
    expect(() => parseArgs(['a.json'])).toThrow(/chýba povinná voľba --ticks/);
  });

  it('--ticks bez hodnoty → chyba', () => {
    expect(() => parseArgs(['a.json', '--ticks'])).toThrow(/--ticks vyžaduje hodnotu/);
    expect(() => parseArgs(['--ticks', '--report', 'a.json'])).toThrow(SimrunError);
  });

  it.each(['0', '-5', '1.5', 'abc', '1e3', '0x10', '01', ' 5', '9007199254740993'])(
    'neplatný --ticks "%s" → chyba',
    (value) => {
      expect(() => parseArgs(['a.json', '--ticks', value])).toThrow(/--ticks musí byť kladné celé číslo/);
    },
  );

  it('chýbajúci scenár, nadbytočný argument a neznáma voľba → chyba', () => {
    expect(() => parseArgs(['--ticks', '5'])).toThrow(/chýba cesta k scenáru/);
    expect(() => parseArgs(['a.json', 'b.json', '--ticks', '5'])).toThrow(/nadbytočný argument "b.json"/);
    expect(() => parseArgs(['a.json', '--ticks', '5', '--verbose'])).toThrow(/neznáma voľba --verbose/);
  });
});

describe('loadScenario', () => {
  let dir: string;

  const write = (name: string, value: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simrun-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('data/scenarios/smoke.json je platný scenár', () => {
    expect(loadScenario(SMOKE_SCENARIO)).toEqual({ id: 'smoke', seed: 42, commands: [] });
  });

  it('seed 0 je platný', () => {
    expect(loadScenario(write('s.json', { id: 'z', seed: 0, commands: [] })).seed).toBe(0);
  });

  it('chýbajúci súbor → SimrunError s cestou', () => {
    const missing = join(dir, 'nope.json');
    expect(() => loadScenario(missing)).toThrow(SimrunError);
    expect(() => loadScenario(missing)).toThrow(/sa nedá prečítať/);
    expect(() => loadScenario(missing)).toThrow(missing);
  });

  it('neplatný JSON → chyba', () => {
    expect(() => loadScenario(write('bad.json', '{ nie json'))).toThrow(/nie je platný JSON/);
  });

  it.each<[string, unknown, RegExp]>([
    ['koreň nie je objekt', [], /scenár musí byť objekt/],
    ['chýba id', { seed: 1, commands: [] }, /\/id musí byť neprázdny reťazec/],
    ['id nie je reťazec', { id: 7, seed: 1, commands: [] }, /\/id musí byť neprázdny reťazec/],
    ['prázdne id', { id: '', seed: 1, commands: [] }, /\/id musí byť neprázdny reťazec/],
    ['chýba seed', { id: 'a', commands: [] }, /\/seed musí byť celé číslo ≥ 0/],
    ['zlomkový seed', { id: 'a', seed: 1.5, commands: [] }, /\/seed musí byť celé číslo ≥ 0/],
    ['záporný seed', { id: 'a', seed: -1, commands: [] }, /\/seed musí byť celé číslo ≥ 0/],
    ['seed ako reťazec', { id: 'a', seed: '1', commands: [] }, /\/seed musí byť celé číslo ≥ 0/],
    ['chýba commands', { id: 'a', seed: 1 }, /\/commands musí byť pole/],
    ['commands nie je pole', { id: 'a', seed: 1, commands: {} }, /\/commands musí byť pole/],
    ['map nie je reťazec', { id: 'a', seed: 1, map: 5, commands: [] }, /\/map musí byť neprázdny reťazec/],
    ['neznámy kľúč', { id: 'a', seed: 1, commands: [], comands: [] }, /\/comands je neznámy kľúč/],
    ['prvok commands nie je objekt', { id: 'a', seed: 1, commands: [1] }, /\/commands\/0 musí byť objekt/],
    [
      'záporný atTick',
      { id: 'a', seed: 1, commands: [{ atTick: -1, command: {} }] },
      /\/commands\/0\/atTick musí byť celé číslo ≥ 0/,
    ],
    ['chýba command', { id: 'a', seed: 1, commands: [{ atTick: 0 }] }, /\/commands\/0\/command musí byť objekt/],
  ])('neplatný tvar: %s → SimrunError', (_name, content, message) => {
    const path = write('s.json', content);
    expect(() => loadScenario(path)).toThrow(SimrunError);
    expect(() => loadScenario(path)).toThrow(message);
  });

  it('neprázdne commands → chyba "príkazy zatiaľ nie sú podporované (F1)"', () => {
    const path = write('s.json', { id: 'a', seed: 1, commands: [{ atTick: 10, command: { type: 'SetGameSpeed' } }] });
    expect(() => loadScenario(path)).toThrow(SimrunError);
    expect(() => loadScenario(path)).toThrow(/príkazy zatiaľ nie sú podporované \(F1\)/);
  });

  it('uvedená mapa sa načíta a parsuje ako JSON', () => {
    const map = write('map.json', { width: 4, height: 4 });
    const scenario = loadScenario(write('s.json', { id: 'a', seed: 1, map, commands: [] }));
    expect(scenario.map).toBe(map);
    expect(scenario.mapData).toEqual({ width: 4, height: 4 });
  });

  it('chýbajúca mapa → chyba', () => {
    const map = join(dir, 'missing-map.json');
    const path = write('s.json', { id: 'a', seed: 1, map, commands: [] });
    expect(() => loadScenario(path)).toThrow(/mapa .* sa nedá prečítať/);
  });

  it('mapa s neplatným JSON → chyba', () => {
    const map = write('map.json', 'nie json');
    const path = write('s.json', { id: 'a', seed: 1, map, commands: [] });
    expect(() => loadScenario(path)).toThrow(/mapa .* nie je platný JSON/);
  });
});

describe('runScenario', () => {
  const defs = loadBundledDefs();

  it('1000 tickov → ticks 1000, lostUnits 0, kľúče reportu presne podľa dohody', () => {
    const report = runScenario(SMOKE, 1000, defs);
    expect(report.ticks).toBe(1000);
    expect(report.lostUnits).toBe(0);
    expect(report).toEqual({
      scenario: 'smoke',
      seed: 42,
      ticks: 1000,
      gameDays: 0,
      cashEnd: null,
      exportedUnits: 0,
      lostUnits: 0,
      onTimeRate: null,
      craneBlockedPct: null,
    });
    expect(Object.keys(report)).toEqual([
      'scenario',
      'seed',
      'ticks',
      'gameDays',
      'cashEnd',
      'exportedUnits',
      'lostUnits',
      'onTimeRate',
      'craneBlockedPct',
    ]);
  });

  it('8640 tickov → gameDays 1 (o tick menej ešte 0)', () => {
    expect(runScenario(SMOKE, TICKS_PER_DAY, defs).gameDays).toBe(1);
    expect(runScenario(SMOKE, TICKS_PER_DAY - 1, defs).gameDays).toBe(0);
  });

  it('rovnaký seed → identický report (aj po JSON serializácii)', () => {
    const a = runScenario(SMOKE, 5000, defs);
    const b = runScenario({ ...SMOKE }, 5000, defs);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('seed a id sa premietnu do reportu', () => {
    const report = runScenario({ id: 'iny', seed: 7, commands: [] }, 10, defs);
    expect(report.scenario).toBe('iny');
    expect(report.seed).toBe(7);
  });

  it('neplatný počet tickov → chyba', () => {
    expect(() => runScenario(SMOKE, 0, defs)).toThrow(SimrunError);
    expect(() => runScenario(SMOKE, 1.5, defs)).toThrow(SimrunError);
  });

  it('neprázdne commands sa neignorujú ani v runScenario', () => {
    const scenario: Scenario = { id: 'a', seed: 1, commands: [{ atTick: 0, command: { type: 'SetGameSpeed' } }] };
    expect(() => runScenario(scenario, 10, defs)).toThrow(/príkazy zatiaľ nie sú podporované \(F1\)/);
  });

  it('stub sveta: tick() posúva hodiny, Rng je zo seedu', () => {
    const a = createStubWorld(defs, 42);
    const b = createStubWorld(defs, 42);
    a.tick();
    a.tick();
    expect(a.clock.tick).toBe(2);
    expect(b.clock.tick).toBe(0);
    expect(a.rng.nextU32()).toBe(b.rng.nextU32());
  });

  it('formatSummary je jeden riadok', () => {
    const line = formatSummary(runScenario(SMOKE, 1000, defs));
    expect(line).not.toContain('\n');
    expect(line).toContain('smoke');
    expect(line).toContain('1000 tickov');
  });
});

describe('CLI (tools/simrun.ts)', () => {
  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', SIMRUN_SCRIPT, ...args], { encoding: 'utf8' });

  it('--report → na stdout čistý JSON, exit 0', () => {
    const run = runCli(SMOKE_SCENARIO, '--ticks', '1000', '--report');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ scenario: 'smoke', seed: 42, ticks: 1000, lostUnits: 0, cashEnd: null });
  }, 30_000);

  it('bez --report → jeden riadok ľudského zhrnutia, exit 0', () => {
    const run = runCli(SMOKE_SCENARIO, '--ticks', '8640');
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('smoke');
    expect(lines[0]).toContain('8640 tickov');
    expect(() => JSON.parse(run.stdout)).toThrow();
  }, 30_000);

  it('chýbajúci scenár → exit 1 a správa na stderr', () => {
    const run = runCli(join(tmpdir(), 'simrun-neexistuje', 'nope.json'), '--ticks', '1');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('simrun:');
    expect(run.stderr).toContain('sa nedá prečítať');
  }, 30_000);

  it('chýbajúci --ticks → exit 1 a použitie na stderr', () => {
    const run = runCli(SMOKE_SCENARIO);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--ticks');
    expect(run.stdout).toBe('');
  }, 30_000);

  it('neprázdne commands → exit 1 (nie tiché ignorovanie)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'simrun-cli-'));
    try {
      const path = join(dir, 's.json');
      writeFileSync(path, JSON.stringify({ id: 'a', seed: 1, commands: [{ atTick: 0, command: { type: 'X' } }] }));
      const run = runCli(path, '--ticks', '10');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('príkazy zatiaľ nie sú podporované (F1)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
