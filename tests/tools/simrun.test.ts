import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { SimrunError, craneBlockedPercent, formatSummary, loadScenario, parseArgs, runScenario } from '../../tools/simrun';
import type { Scenario, ScenarioEntry } from '../../tools/simrun';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SIMRUN_SCRIPT = fileURLToPath(new URL('../../tools/simrun.ts', import.meta.url));
const SMOKE_SCENARIO = fileURLToPath(new URL('../../data/scenarios/smoke.json', import.meta.url));
const HARBOR_MAP = fileURLToPath(new URL('../../data/maps/harbor_01.json', import.meta.url));
const F2_UNLOAD_SCENARIO = fileURLToPath(new URL('../../data/scenarios/f2_unload.json', import.meta.url));

const SMOKE: Scenario = { id: 'smoke', seed: 42, commands: [] };
// Hodnota z data/defs/time.json (tickGameSeconds 10) → 8 640 tickov = 1 herný deň.
const TICKS_PER_DAY = 8640;
// harbor_01: 30 štartovacích ciest (x = 44, y 34…63).
const STARTER_ROADS = 30;
// harbor_01: štartovacie moduly = berth_standard + crane_container_gantry.
const STARTER_MODULES = 2;

// Príkazy nad mapou harbor_01: parcela `starter` (30,14,28×20) patrí hráčovi, `west_quay` (6,14,22×20) je na predaj.
const ROAD_CELLS = [20, 21, 22, 23, 24, 25].map((y) => ({ x: 44, y }));
const PLACE_ROAD = { type: 'PlaceRoad', cells: ROAD_CELLS };
const REMOVE_ROAD = { type: 'RemoveRoad', cells: ROAD_CELLS };
const PLACE_ROAD_UNOWNED = { type: 'PlaceRoad', cells: [{ x: 10, y: 20 }] };

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

  it('data/scenarios/smoke.json je platný scenár s mapou harbor_01', () => {
    // `map` v scenári je relatívna k cwd (koreň repozitára, odkiaľ beží `pnpm vitest` aj `pnpm simrun`).
    const scenario = loadScenario(SMOKE_SCENARIO);
    expect(scenario).toMatchObject({ id: 'smoke', seed: 42, map: 'data/maps/harbor_01.json', commands: [] });
    expect(scenario.mapData).toMatchObject({ id: 'harbor_01' });
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
    [
      'zlomkový atTick',
      { id: 'a', seed: 1, commands: [{ atTick: 1.5, command: {} }] },
      /\/commands\/0\/atTick musí byť celé číslo ≥ 0/,
    ],
    [
      'atTick ako reťazec',
      { id: 'a', seed: 1, commands: [{ atTick: '3', command: {} }] },
      /\/commands\/0\/atTick musí byť celé číslo ≥ 0/,
    ],
    [
      'neznámy kľúč záznamu',
      { id: 'a', seed: 1, commands: [{ atTick: 0, command: {}, note: 'x' }] },
      /\/commands\/0\/note je neznámy kľúč/,
    ],
    [
      'klesajúce atTick',
      {
        id: 'a',
        seed: 1,
        commands: [
          { atTick: 5, command: {} },
          { atTick: 4, command: {} },
        ],
      },
      /\/commands\/1\/atTick 4 je menší než predchádzajúci 5/,
    ],
  ])('neplatný tvar: %s → SimrunError', (_name, content, message) => {
    const path = write('s.json', content);
    expect(() => loadScenario(path)).toThrow(SimrunError);
    expect(() => loadScenario(path)).toThrow(message);
  });

  it('príkazy sa načítajú v poradí zo scenára; rovnaké atTick je platné', () => {
    const commands = [
      { atTick: 0, command: PLACE_ROAD },
      { atTick: 0, command: REMOVE_ROAD },
      { atTick: 7, command: { type: 'SetGameSpeed', speed: 2 } },
    ];
    expect(loadScenario(write('s.json', { id: 'a', seed: 1, commands })).commands).toEqual(commands);
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
  const withCommands = (...commands: ScenarioEntry[]): Scenario => ({ ...SMOKE, commands });

  it('1000 tickov → ticks 1000, lostUnits 0, roads 30, kľúče reportu presne podľa dohody', () => {
    const report = runScenario(SMOKE, 1000, defs);
    expect(report.ticks).toBe(1000);
    expect(report.lostUnits).toBe(0);
    expect(report).toEqual({
      scenario: 'smoke',
      seed: 42,
      ticks: 1000,
      gameDays: 0,
      cashEnd: defs.economy.startingCashCents,
      exportedUnits: 0,
      lostUnits: 0,
      onTimeRate: null,
      craneBlockedPct: 0,
      roads: STARTER_ROADS,
      commandsApplied: 0,
      commandsSkipped: 0,
      modules: STARTER_MODULES,
      shipsSpawned: 0,
      shipsDeparted: 0,
      unitsOnApron: 0,
      craneCycles: 0,
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
      'roads',
      'commandsApplied',
      'commandsSkipped',
      'modules',
      'shipsSpawned',
      'shipsDeparted',
      'unitsOnApron',
      'craneCycles',
    ]);
  });

  it('8640 tickov → gameDays 1 (o tick menej ešte 0)', () => {
    expect(runScenario(SMOKE, TICKS_PER_DAY, defs).gameDays).toBe(1);
    expect(runScenario(SMOKE, TICKS_PER_DAY - 1, defs).gameDays).toBe(0);
  });

  it('rovnaký seed a príkazy → identický report (aj po JSON serializácii)', () => {
    const scenario = withCommands({ atTick: 3, command: PLACE_ROAD });
    const a = runScenario(scenario, 5000, defs);
    const b = runScenario({ ...scenario }, 5000, defs);
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

  it('formatSummary je jeden riadok', () => {
    const line = formatSummary(runScenario(SMOKE, 1000, defs));
    expect(line).not.toContain('\n');
    expect(line).toContain('smoke');
    expect(line).toContain('1000 tickov');
    expect(line).toContain('cesty 30');
    expect(line).toContain('lode 0/0');
    expect(line).toContain('cykly žeriavov 0');
  });

  describe('metriky žeriavov a lodí (F2)', () => {
    const spawn = (units: number): ScenarioEntry => ({
      atTick: 0,
      command: { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units },
    });
    const f2 = (units: number): Scenario => ({ id: 'f2', seed: 2002, commands: [spawn(units)] });

    it('f2_unload (5000 tickov): loď vyložená a odplávala, 4 jednotky na aprone, nič stratené ani exportované', () => {
      const report = runScenario(loadScenario(F2_UNLOAD_SCENARIO), 5000, defs);
      expect(report).toMatchObject({
        scenario: 'f2_unload',
        lostUnits: 0,
        exportedUnits: 0,
        modules: STARTER_MODULES,
        shipsSpawned: 1,
        shipsDeparted: 1,
        unitsOnApron: 4,
        craneCycles: 4,
        craneBlockedPct: 0,
        commandsApplied: 1,
        commandsSkipped: 0,
      });
    });

    it('loď je po spawne v evidencii, ale ešte neodplávala (10 tickov)', () => {
      const report = runScenario(f2(4), 10, defs);
      expect(report).toMatchObject({ shipsSpawned: 1, shipsDeparted: 0, unitsOnApron: 0, craneCycles: 0, lostUnits: 0 });
    });

    it('plný apron zablokuje žeriav: craneBlockedPct > 0, na aprone najviac 4 jednotky, nič sa nestratí', () => {
      const report = runScenario(f2(6), 5000, defs);
      expect(report.unitsOnApron).toBe(4);
      expect(report.craneCycles).toBe(4);
      expect(report.shipsDeparted).toBe(0);
      expect(report.craneBlockedPct).toBeGreaterThan(0);
      expect(report.craneBlockedPct).toBeLessThanOrEqual(100);
      expect(report.lostUnits).toBe(0);
    });

    it('craneBlockedPct má najviac 1 desatinné miesto', () => {
      const pct = runScenario(f2(6), 5000, defs).craneBlockedPct;
      expect(Math.round(pct * 10) / 10).toBe(pct);
    });

    it('rovnaký scenár → identický report (metriky F2 sú deterministické)', () => {
      expect(runScenario(f2(6), 3000, defs)).toEqual(runScenario(f2(6), 3000, defs));
    });
  });

  describe('craneBlockedPercent', () => {
    const crane = (busyTicks: number, idleTicks: number, blockedTicks: number) => ({ busyTicks, idleTicks, blockedTicks });

    it('bez žeriavov 0', () => {
      expect(craneBlockedPercent([])).toBe(0);
    });

    it('žeriav bez jediného ticku (0/0) → 0, nie NaN', () => {
      expect(craneBlockedPercent([crane(0, 0, 0)])).toBe(0);
    });

    it.each<[string, ReturnType<typeof crane>[], number]>([
      ['nikdy blokovaný', [crane(30, 70, 0)], 0],
      ['stále blokovaný', [crane(0, 0, 50)], 100],
      ['štvrtina', [crane(25, 25, 50), crane(50, 50, 0)], 25],
      ['1/3 → 33.3', [crane(1, 1, 1)], 33.3],
      ['2/3 → 66.7', [crane(1, 0, 2)], 66.7],
      ['súčty naprieč žeriavmi, nie priemer percent', [crane(0, 0, 1), crane(0, 99, 0)], 1],
      ['zaokrúhlenie hore: 16.666… → 16.7', [crane(0, 5, 1)], 16.7],
    ])('%s', (_name, cranes, expected) => {
      expect(craneBlockedPercent(cranes)).toBe(expected);
    });
  });

  describe('replay príkazov', () => {
    it('PlaceRoad sa aplikuje a zmení cesty aj hotovosť (cena z infrastructure.json)', () => {
      const report = runScenario(withCommands({ atTick: 5, command: PLACE_ROAD }), 100, defs);
      expect(report.roads).toBe(STARTER_ROADS + ROAD_CELLS.length);
      expect(report.cashEnd).toBe(
        defs.economy.startingCashCents - ROAD_CELLS.length * defs.infrastructure.road.costPerCellCents,
      );
      expect(report.commandsApplied).toBe(1);
      expect(report.commandsSkipped).toBe(0);
      expect(report.lostUnits).toBe(0);
    });

    it('príkazy pri rovnakom atTick sa aplikujú v poradí zo scenára (PlaceRoad → RemoveRoad)', () => {
      const report = runScenario(
        withCommands({ atTick: 2, command: PLACE_ROAD }, { atTick: 2, command: REMOVE_ROAD }),
        10,
        defs,
      );
      expect(report.roads).toBe(STARTER_ROADS);
      expect(report.commandsApplied).toBe(2);
    });

    it('opačné poradie (RemoveRoad → PlaceRoad) odmietne RemoveRoad: cesta ešte neexistuje', () => {
      const scenario = withCommands({ atTick: 2, command: REMOVE_ROAD }, { atTick: 2, command: PLACE_ROAD });
      expect(() => runScenario(scenario, 10, defs)).toThrow(/RemoveRoad: no_road/);
    });

    it('príkaz sa aplikuje pred tickom atTick (posledný tick ticks−1 áno, atTick = ticks nie)', () => {
      const last = runScenario(withCommands({ atTick: 9, command: PLACE_ROAD }), 10, defs);
      expect(last.commandsApplied).toBe(1);
      expect(last.roads).toBe(STARTER_ROADS + ROAD_CELLS.length);

      const beyond = runScenario(withCommands({ atTick: 10, command: PLACE_ROAD }), 10, defs);
      expect(beyond.commandsApplied).toBe(0);
      expect(beyond.commandsSkipped).toBe(1);
      expect(beyond.roads).toBe(STARTER_ROADS);
      expect(beyond.cashEnd).toBe(defs.economy.startingCashCents);
    });

    it('príkazy s atTick ≥ ticks sa preskočia a spočítajú (nevalidujú sa), ostatné sa aplikujú', () => {
      const report = runScenario(
        withCommands(
          { atTick: 0, command: PLACE_ROAD },
          { atTick: 500, command: REMOVE_ROAD },
          { atTick: 9999, command: PLACE_ROAD_UNOWNED },
        ),
        100,
        defs,
      );
      expect(report.commandsApplied).toBe(1);
      expect(report.commandsSkipped).toBe(2);
      expect(report.roads).toBe(STARTER_ROADS + ROAD_CELLS.length);
    });

    it('odmietnutý príkaz → SimrunError s typom príkazu, atTick a dôvodmi', () => {
      const scenario = withCommands({ atTick: 3, command: PLACE_ROAD_UNOWNED });
      expect(() => runScenario(scenario, 100, defs)).toThrow(SimrunError);
      expect(() => runScenario(scenario, 100, defs)).toThrow(/atTick 3 — PlaceRoad: .*parcel_not_owned/);
    });

    it('odmietnutie neskôr v scenári nesie správny atTick (SetGameSpeed s neplatnou rýchlosťou)', () => {
      const scenario = withCommands(
        { atTick: 0, command: PLACE_ROAD },
        { atTick: 4, command: { type: 'SetGameSpeed', speed: 99 } },
      );
      expect(() => runScenario(scenario, 10, defs)).toThrow(/atTick 4 — SetGameSpeed: invalid_speed/);
    });

    it('neznámy typ príkazu → SimrunError s cestou /commands/i, ešte pred prvým tickom', () => {
      const scenario = withCommands({ atTick: 0, command: PLACE_ROAD }, { atTick: 1, command: { type: 'Teleport' } });
      expect(() => runScenario(scenario, 10, defs)).toThrow(SimrunError);
      expect(() => runScenario(scenario, 10, defs)).toThrow(/\/commands\/1\/command.*Teleport/);
    });

    it('zlý payload príkazu → SimrunError s cestou /commands/i', () => {
      const scenario = withCommands({ atTick: 0, command: { type: 'PlaceRoad', cells: [{ x: 1.5, y: 2 }] } });
      expect(() => runScenario(scenario, 10, defs)).toThrow(SimrunError);
      expect(() => runScenario(scenario, 10, defs)).toThrow(/\/commands\/0\/command/);
    });

    it('príkaz, ktorý nie je objekt → SimrunError (nie holá výnimka)', () => {
      const scenario = withCommands({ atTick: 0, command: 'PlaceRoad' });
      expect(() => runScenario(scenario, 10, defs)).toThrow(SimrunError);
    });
  });

  describe('mapa scenára', () => {
    let dir: string;

    const writeScenario = (value: unknown): string => {
      const path = join(dir, 's.json');
      writeFileSync(path, JSON.stringify(value));
      return path;
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'simrun-map-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('bez `map` sa použije vstavaná harbor_01; explicitná cesta na ňu dá rovnaký report', () => {
      const bundled = runScenario(SMOKE, 200, defs);
      const explicit = runScenario(loadScenario(SMOKE_SCENARIO), 200, defs);
      expect(explicit).toEqual(bundled);
    });

    it('scenár s `map` používa túto mapu (o jednu štartovaciu cestu menej → roads 29)', () => {
      const raw = JSON.parse(readFileSync(HARBOR_MAP, 'utf8')) as { starter: { roads: unknown[] } };
      raw.starter.roads.pop();
      const map = join(dir, 'harbor_minus_one.json');
      writeFileSync(map, JSON.stringify(raw));
      const scenario = loadScenario(writeScenario({ id: 'm', seed: 1, map, commands: [] }));
      expect(runScenario(scenario, 10, defs).roads).toBe(STARTER_ROADS - 1);
    });

    it('neplatná mapa → SimrunError s cestou k mape', () => {
      const map = join(dir, 'broken.json');
      writeFileSync(map, JSON.stringify({ id: 'x' }));
      const scenario = loadScenario(writeScenario({ id: 'm', seed: 1, map, commands: [] }));
      expect(() => runScenario(scenario, 10, defs)).toThrow(SimrunError);
      expect(() => runScenario(scenario, 10, defs)).toThrow(/neplatná/);
      expect(() => runScenario(scenario, 10, defs)).toThrow(map);
    });
  });
});

describe('CLI (tools/simrun.ts)', () => {
  let dir: string;

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', SIMRUN_SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT });

  const writeScenario = (commands: unknown[]): string => {
    const path = join(dir, 's.json');
    writeFileSync(path, JSON.stringify({ id: 'cli', seed: 5, commands }));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'simrun-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('--report → na stdout čistý JSON, exit 0', () => {
    const run = runCli(SMOKE_SCENARIO, '--ticks', '1000', '--report');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      scenario: 'smoke',
      seed: 42,
      ticks: 1000,
      lostUnits: 0,
      roads: STARTER_ROADS,
      commandsApplied: 0,
      commandsSkipped: 0,
    });
    expect(report['cashEnd']).toBe(loadBundledDefs().economy.startingCashCents);
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

  it('f2_unload --report → čistý JSON s metrikami žeriavov a lodí, exit 0', () => {
    const run = runCli(F2_UNLOAD_SCENARIO, '--ticks', '5000', '--report');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toMatchObject({
      scenario: 'f2_unload',
      lostUnits: 0,
      modules: STARTER_MODULES,
      shipsSpawned: 1,
      shipsDeparted: 1,
      unitsOnApron: 4,
      craneCycles: 4,
      craneBlockedPct: 0,
    });
  }, 30_000);

  it('replay: PlaceRoad zo scenára → viac ciest, nižšia hotovosť, commandsSkipped pre atTick ≥ ticks', () => {
    const path = writeScenario([
      { atTick: 10, command: PLACE_ROAD },
      { atTick: 5000, command: REMOVE_ROAD },
    ]);
    const run = runCli(path, '--ticks', '100', '--report');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Record<string, number>;
    expect(report['roads']).toBe(STARTER_ROADS + ROAD_CELLS.length);
    expect(report['commandsApplied']).toBe(1);
    expect(report['commandsSkipped']).toBe(1);
    expect(report['cashEnd']).toBeLessThan(loadBundledDefs().economy.startingCashCents);
  }, 30_000);

  it('odmietnutý príkaz → exit 1, na stderr typ príkazu, atTick a dôvod, stdout prázdny', () => {
    const run = runCli(writeScenario([{ atTick: 3, command: PLACE_ROAD_UNOWNED }]), '--ticks', '100', '--report');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('simrun:');
    expect(run.stderr).toContain('PlaceRoad');
    expect(run.stderr).toContain('atTick 3');
    expect(run.stderr).toContain('parcel_not_owned');
  }, 30_000);

  it('neznámy typ príkazu → exit 1 a správa s cestou', () => {
    const run = runCli(writeScenario([{ atTick: 0, command: { type: 'Teleport' } }]), '--ticks', '10');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('/commands/0/command');
    expect(run.stderr).toContain('Teleport');
  }, 30_000);

  it('klesajúce atTick → exit 1', () => {
    const run = runCli(
      writeScenario([
        { atTick: 5, command: PLACE_ROAD },
        { atTick: 1, command: REMOVE_ROAD },
      ]),
      '--ticks',
      '10',
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('/commands/1/atTick');
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
});
