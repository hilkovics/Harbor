import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import { DefRegistry, loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { World, stateHash } from '@sim/world';
import { DEFS as APRON_DEFS, LEGACY_CAPACITY_DEFS, RAW_DEFS } from '../sim/world/world-fixtures';
import {
  SimrunError,
  craneBlockedPercent,
  formatSummary,
  loadScenario,
  parseArgs,
  roundtripWorld,
  runScenario,
  vehicleUtilPercent,
} from '../../tools/simrun';
import type { Scenario, ScenarioEntry, SimrunReport } from '../../tools/simrun';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SIMRUN_SCRIPT = fileURLToPath(new URL('../../tools/simrun.ts', import.meta.url));
const SMOKE_SCENARIO = fileURLToPath(new URL('../../data/scenarios/smoke.json', import.meta.url));
const HARBOR_MAP = fileURLToPath(new URL('../../data/maps/harbor_01.json', import.meta.url));
const F2_UNLOAD_SCENARIO = fileURLToPath(new URL('../../data/scenarios/f2_unload.json', import.meta.url));
const APRON_TO_YARD_SCENARIO = fileURLToPath(new URL('../../data/scenarios/apron_to_yard.json', import.meta.url));
const FULL_IMPORT_CHAIN_SCENARIO = fileURLToPath(new URL('../../data/scenarios/full_import_chain.json', import.meta.url));
const VERTICAL_SLICE_SCENARIO = fileURLToPath(new URL('../../data/scenarios/vertical_slice.json', import.meta.url));
const VERTICAL_SLICE_GOLDEN = fileURLToPath(new URL('../sim/__golden__/vertical_slice.json', import.meta.url));

const SMOKE: Scenario = { id: 'smoke', seed: 42, commands: [] };
// Hodnota z data/defs/time.json (tickGameSeconds 10) → 8 640 tickov = 1 herný deň.
const TICKS_PER_DAY = 8640;
// Dlhé behy (desaťtisíce tickov) pri paralelnom behu celej sady presiahnu predvolených 10 s pre hooky.
const HEAVY_TIMEOUT_MS = 120_000;
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
      hash: false,
      roundtripAt: null,
    });
  });

  it('--report je voliteľné, poradie argumentov nie je dôležité, podporuje --ticks=N', () => {
    expect(parseArgs(['--ticks=5', 'a.json'])).toEqual({ scenarioPath: 'a.json', ticks: 5, report: false, hash: false, roundtripAt: null });
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

  it('--hash a --roundtrip-at T / --roundtrip-at=T (T06-01); 0 je platný tick roundtripu', () => {
    expect(parseArgs(['a.json', '--ticks', '100', '--hash', '--roundtrip-at', '40'])).toEqual({
      scenarioPath: 'a.json',
      ticks: 100,
      report: false,
      hash: true,
      roundtripAt: 40,
    });
    expect(parseArgs(['--roundtrip-at=0', 'a.json', '--ticks=1', '--report'])).toMatchObject({ ticks: 1, report: true, hash: false, roundtripAt: 0 });
    expect(parseArgs(['a.json', '--ticks', '100', '--roundtrip-at', '99']).roundtripAt).toBe(99);
  });

  it.each(['-1', '1.5', 'abc', '1e3', '0x10', '01', ' 5', '9007199254740993'])('neplatný --roundtrip-at "%s" → chyba', (value) => {
    expect(() => parseArgs(['a.json', '--ticks', '100', '--roundtrip-at', value])).toThrow(/--roundtrip-at musí byť celé číslo ≥ 0/);
  });

  it('--roundtrip-at bez hodnoty, zadané dvakrát alebo ≥ --ticks → chyba', () => {
    expect(() => parseArgs(['a.json', '--ticks', '100', '--roundtrip-at'])).toThrow(/--roundtrip-at vyžaduje hodnotu/);
    expect(() => parseArgs(['a.json', '--ticks', '100', '--roundtrip-at='])).toThrow(/--roundtrip-at vyžaduje hodnotu/);
    expect(() => parseArgs(['a.json', '--ticks', '100', '--roundtrip-at', '5', '--roundtrip-at=6'])).toThrow(/zadaná viackrát/);
    expect(() => parseArgs(['a.json', '--ticks', '100', '--roundtrip-at', '100'])).toThrow(/--roundtrip-at 100 musí byť menší než --ticks 100/);
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
      vehicles: 0,
      unitsInStorage: 0,
      jobsDone: 0,
      vehicleUtilPct: 0,
      noStorageEvents: 0,
      ticksToAllStored: null,
      trucksSpawned: 0,
      trucksExited: 0,
      unitsExportedByTrucks: 0,
      noWaitingBayEvents: 0,
      gateQueueMax: 0,
      ticksToAllExported: null,
      contractsCompleted: 0,
      xp: 0,
      contractsOffered: 6,
      contractsAccepted: 0,
      contractsFailed: 0,
      contractsExpired: 0,
      penaltiesCents: 0,
      revenueCents: 0,
      maintenanceCents: 0,
      wagesCents: 0,
      tier: 0,
      gameOver: false,
      stateHash: null,
      shippedUnits: 0,
      rolledUnits: 0,
      returnedUnits: 0,
      vgmHolds: 0,
      dualCycleRate: null,
      dualTransactionRate: null,
      stowageOrderViolations: 0,
      exportGroupingPct: null,
      craneWaitForVehicleTicks: 0,
      vehicleWaitUnderCraneTicks: 0,
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
      'vehicles',
      'unitsInStorage',
      'jobsDone',
      'vehicleUtilPct',
      'noStorageEvents',
      'ticksToAllStored',
      'trucksSpawned',
      'trucksExited',
      'unitsExportedByTrucks',
      'noWaitingBayEvents',
      'gateQueueMax',
      'ticksToAllExported',
      'contractsCompleted',
      'xp',
      'contractsOffered',
      'contractsAccepted',
      'contractsFailed',
      'contractsExpired',
      'penaltiesCents',
      'revenueCents',
      'maintenanceCents',
      'wagesCents',
      'tier',
      'gameOver',
      'stateHash',
      'shippedUnits',
      'rolledUnits',
      'returnedUnits',
      'vgmHolds',
      'dualCycleRate',
      'dualTransactionRate',
      'stowageOrderViolations',
      'exportGroupingPct',
      'craneWaitForVehicleTicks',
      'vehicleWaitUnderCraneTicks',
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
    expect(line).toContain('vozidlá 0');
    expect(line).toContain('v sklade 0');
    expect(line).toContain('joby hotové 0');
    expect(line).toContain('využitie vozidiel 0');
    expect(line).toContain('bez skladu 0');
    expect(line).toContain('všetko uložené n/a');
    expect(line).toContain('kamióny 0/0');
    expect(line).toContain('odvezené kamiónmi 0');
    expect(line).toContain('bez stojiska 0');
    expect(line).toContain('fronta brány max 0');
    expect(line).toContain('všetko exportované n/a');
  });

  describe('metriky žeriavov a lodí (F2)', () => {
    const spawn = (units: number): ScenarioEntry => ({
      atTick: 0,
      command: { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units },
    });
    const f2 = (units: number): Scenario => ({ id: 'f2', seed: 2002, commands: [spawn(units)] });

    it('f2_unload (5000 tickov, režim apron): loď vyložená a odplávala, 4 jednotky na aprone, nič stratené ani exportované', () => {
      const report = runScenario(loadScenario(F2_UNLOAD_SCENARIO), 5000, APRON_DEFS);
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
      // Zablokovanie potrebuje apron 4/4 pri 6 TEU na lodi → pripnutý pôvodný balans (Fáza 5b: bundled apron 8).
      const report = runScenario(f2(6), 5000, LEGACY_CAPACITY_DEFS);
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

  describe('metriky vozidiel a skladov (F3)', () => {
    // apron_to_yard: 2 × straddle_carrier (BuyVehicle), 1 loď so 120 TEU, dvor s kapacitou ≥ 120 (viď scenár).
    const apronToYard = loadScenario(APRON_TO_YARD_SCENARIO);
    const RUN_TICKS = 15_000;
    let full: SimrunReport;

    beforeAll(() => {
      full = runScenario(apronToYard, RUN_TICKS, defs);
    }, HEAVY_TIMEOUT_MS);

    it('apron_to_yard (15 000 tickov): 120 jednotiek v sklade, 120 hotových jobov, bez chýbajúceho skladu, nič stratené', () => {
      expect(full).toMatchObject({
        scenario: 'apron_to_yard',
        lostUnits: 0,
        exportedUnits: 0,
        shipsSpawned: 1,
        unitsOnApron: 0,
        vehicles: 2,
        unitsInStorage: 120,
        jobsDone: 120,
        noStorageEvents: 0,
      });
      expect(full.ticksToAllStored).not.toBeNull();
    });

    it('cashEnd (ADR-025): 64 600 000 po stavbe − 1 deň × (údržba 285 000 + mzdy 61 000) = 64 254 000', () => {
      expect(full.gameDays).toBe(1);
      expect(full.cashEnd).toBe(64_254_000);
    });

    it('ticksToAllStored je hranica: o tick skôr ešte nie je všetko uložené, presne v ňom už áno', () => {
      const stored = full.ticksToAllStored;
      if (stored === null) throw new Error('ticksToAllStored má byť číslo');
      expect(stored).toBeGreaterThan(0);
      expect(stored).toBeLessThan(RUN_TICKS);

      const before = runScenario(apronToYard, stored - 1, defs);
      expect(before.ticksToAllStored).toBeNull();
      expect(before.unitsInStorage).toBeLessThan(120);

      const at = runScenario(apronToYard, stored, defs);
      expect(at.ticksToAllStored).toBe(stored);
      expect(at.unitsInStorage).toBe(120);
    });

    it('vehicleUtilPct je podiel vozidlo-tickov mimo idle: v (0, 100), najviac 1 desatinné miesto', () => {
      expect(full.vehicleUtilPct).toBeGreaterThan(0);
      expect(full.vehicleUtilPct).toBeLessThan(100);
      expect(Math.round(full.vehicleUtilPct * 10) / 10).toBe(full.vehicleUtilPct);
    });

    it('vehicleUtilPct sa po uložení všetkého už len riedi (dlhší beh = nižšie využitie, rovnaké joby)', () => {
      const longer = runScenario(apronToYard, RUN_TICKS * 2, defs);
      expect(longer.jobsDone).toBe(full.jobsDone);
      expect(longer.unitsInStorage).toBe(full.unitsInStorage);
      expect(longer.ticksToAllStored).toBe(full.ticksToAllStored);
      expect(longer.vehicleUtilPct).toBeLessThan(full.vehicleUtilPct);
    });

    it('rovnaký scenár → identický report (metriky F3 sú deterministické)', () => {
      expect(runScenario(apronToYard, RUN_TICKS, defs)).toEqual(full);
    });

    it('bez vozidiel a skladu (f2_unload, režim apron): vehicles 0, util 0, ticksToAllStored null napriek spawnu lode', () => {
      const report = runScenario(loadScenario(F2_UNLOAD_SCENARIO), 5000, APRON_DEFS);
      expect(report).toMatchObject({
        shipsSpawned: 1,
        unitsOnApron: 4,
        vehicles: 0,
        unitsInStorage: 0,
        jobsDone: 0,
        vehicleUtilPct: 0,
      });
      expect(report.ticksToAllStored).toBeNull();
    });

    it('jednotky na aprone bez skladu → noStorageEvents > 0 (dispatcher hlási nedostatok skladu)', () => {
      const report = runScenario(loadScenario(F2_UNLOAD_SCENARIO), 5000, defs);
      expect(report.noStorageEvents).toBeGreaterThan(0);
    });

    it('bez spawnu lode je ticksToAllStored null (prázdny svet nie je „všetko uložené")', () => {
      expect(runScenario(SMOKE, 1000, defs).ticksToAllStored).toBeNull();
    });
  });

  describe('metriky kamiónov a exportu (F4)', () => {
    // full_import_chain: loď so 120 TEU → žeriav → apron → 3 vozidlá → dvor → rampa → kamióny (kapacita 1) → brána → portál.
    const fullChain = loadScenario(FULL_IMPORT_CHAIN_SCENARIO);
    const EXPORT_TICKS = 40_000;
    const UNITS = 120;
    let full: SimrunReport;

    beforeAll(() => {
      full = runScenario(fullChain, EXPORT_TICKS, defs);
    }, HEAVY_TIMEOUT_MS);

    it('full_import_chain (40 000 tickov): 120 jednotiek exportovaných 120 kamiónmi (kapacita 1), nič stratené', () => {
      expect(defs.trucks.get('truck_container').capacityUnits).toBe(1);
      expect(full).toMatchObject({
        scenario: 'full_import_chain',
        lostUnits: 0,
        exportedUnits: UNITS,
        unitsInStorage: 0,
        unitsOnApron: 0,
        shipsSpawned: 1,
        shipsDeparted: 1,
        trucksSpawned: UNITS,
        trucksExited: UNITS,
        unitsExportedByTrucks: UNITS,
      });
    });

    it('cashEnd (ADR-025): 33 600 000 po stavbe − 4 dni × (údržba 330 000 + mzdy 79 000) = 31 964 000', () => {
      expect(full.gameDays).toBe(4);
      expect(full.cashEnd).toBe(31_964_000);
    });

    it('krížová kontrola: Σ TruckExited.units === exportedUnits (kamióny sú jediná cesta exportu)', () => {
      expect(full.unitsExportedByTrucks).toBe(full.exportedUnits);
      expect(full.trucksExited).toBe(full.trucksSpawned);
    });

    it('ticksToAllExported je číslo v (0, 40 000], neskôr než ticksToAllStored', () => {
      const exported = full.ticksToAllExported;
      if (exported === null) throw new Error('ticksToAllExported má byť číslo');
      expect(exported).toBeGreaterThan(0);
      expect(exported).toBeLessThanOrEqual(EXPORT_TICKS);
      expect(full.ticksToAllStored).not.toBeNull();
      expect(exported).toBeGreaterThan(full.ticksToAllStored ?? Number.POSITIVE_INFINITY);
    });

    it('ticksToAllExported je hranica: o tick skôr ešte nie je všetko exportované, presne v ňom už áno', () => {
      const exported = full.ticksToAllExported;
      if (exported === null) throw new Error('ticksToAllExported má byť číslo');

      const before = runScenario(fullChain, exported - 1, defs);
      expect(before.ticksToAllExported).toBeNull();
      expect(before.exportedUnits).toBeLessThan(UNITS);
      expect(before.lostUnits).toBe(0);

      const at = runScenario(fullChain, exported, defs);
      expect(at.ticksToAllExported).toBe(exported);
      expect(at.exportedUnits).toBe(UNITS);
      expect(at.trucksExited).toBe(UNITS);
    });

    it('gateQueueMax ≥ 1: aspoň jeden kamión bol vo fronte (alebo v prechode) brány', () => {
      expect(full.gateQueueMax).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(full.gateQueueMax)).toBe(true);
    });

    it('noWaitingBayEvents je nezáporné celé číslo', () => {
      expect(Number.isInteger(full.noWaitingBayEvents)).toBe(true);
      expect(full.noWaitingBayEvents).toBeGreaterThanOrEqual(0);
    });

    // Fáza 5b: staging 2 × 4 = 8 kamiónov na 6 bayov stojiska → bundled balans hlási NoWaitingBay (balansová otázka, nie chyba simu);
    // „stojisko stačí → 0" sa preto overuje na pôvodnom stagingu 2 × 2 (`LEGACY_CAPACITY_DEFS`).
    it('noWaitingBayEvents je 0, keď stojisko stačí (pôvodný staging 2 × 2, 4 kamióny na 6 bayov)', () => {
      expect(runScenario(fullChain, EXPORT_TICKS, LEGACY_CAPACITY_DEFS).noWaitingBayEvents).toBe(0);
    }, HEAVY_TIMEOUT_MS);

    it('beh skrátený pred koncom exportu: trucksSpawned ≥ trucksExited, ticksToAllExported null, nič stratené', () => {
      const partial = runScenario(fullChain, 6000, defs);
      expect(partial.ticksToAllExported).toBeNull();
      expect(partial.trucksSpawned).toBeGreaterThan(0);
      expect(partial.trucksSpawned).toBeGreaterThanOrEqual(partial.trucksExited);
      expect(partial.unitsExportedByTrucks).toBe(partial.exportedUnits);
      expect(partial.exportedUnits).toBe(partial.trucksExited);
      expect(partial.lostUnits).toBe(0);
    });

    it('bez čakacej plochy je rampa neprevádzková: žiadne kamióny, ticksToAllExported null, náklad zostane v sklade', () => {
      const commands = fullChain.commands.filter(
        (entry) => (entry.command as { defId?: unknown }).defId !== 'truck_waiting_area',
      );
      expect(commands).toHaveLength(fullChain.commands.length - 1);
      const report = runScenario({ ...fullChain, commands }, EXPORT_TICKS, defs);
      expect(report).toMatchObject({
        lostUnits: 0,
        exportedUnits: 0,
        unitsInStorage: UNITS,
        trucksSpawned: 0,
        trucksExited: 0,
        unitsExportedByTrucks: 0,
        gateQueueMax: 0,
      });
      expect(report.ticksToAllExported).toBeNull();
    });

    it('rovnaký scenár → identický report (metriky F4 sú deterministické)', () => {
      expect(runScenario(fullChain, EXPORT_TICKS, defs)).toEqual(full);
    });

    it.each<[string, string, number]>([
      ['smoke (bez lode a kamiónov)', SMOKE_SCENARIO, 1000],
      ['f2_unload (loď bez skladu a kamiónov)', F2_UNLOAD_SCENARIO, 5000],
      ['apron_to_yard (sklad bez kamiónov)', APRON_TO_YARD_SCENARIO, 15_000],
    ])('bez kamiónov: %s → nuly a ticksToAllExported null', (_name, path, ticks) => {
      const report = runScenario(loadScenario(path), ticks, defs);
      expect(report).toMatchObject({
        trucksSpawned: 0,
        trucksExited: 0,
        unitsExportedByTrucks: 0,
        noWaitingBayEvents: 0,
        gateQueueMax: 0,
        exportedUnits: 0,
      });
      expect(report.ticksToAllExported).toBeNull();
    });
  });

  describe('metriky kontraktov (F5, T05-04: onTimeRate, contractsCompleted, xp; plné metriky T05-08)', () => {
    // vertical_slice: rozloženie F4, AcceptContract prvej ponuky (id 1), bez SpawnShipDebug; golden report
    // tests/sim/__golden__/vertical_slice.json vygeneroval T05-04 z `pnpm simrun … --ticks 60000 --report`.
    const SLICE_TICKS = 60_000;
    let slice: SimrunReport;

    beforeAll(() => {
      slice = runScenario(loadScenario(VERTICAL_SLICE_SCENARIO), SLICE_TICKS, defs);
    }, HEAVY_TIMEOUT_MS);

    it('vertical_slice (60 000 tickov) sa zhoduje s golden reportom (cashEnd, exportedUnits, onTimeRate, contractsCompleted, xp)', () => {
      const golden = JSON.parse(readFileSync(VERTICAL_SLICE_GOLDEN, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(golden)).toEqual(['cashEnd', 'exportedUnits', 'onTimeRate', 'contractsCompleted', 'xp']);
      const { cashEnd, exportedUnits, onTimeRate, contractsCompleted, xp } = slice;
      expect({ cashEnd, exportedUnits, onTimeRate, contractsCompleted, xp }).toEqual(golden);
    });

    it('vertical_slice: kontrakt dokončený včas, nič stratené, všetok náklad kontraktu exportovaný', () => {
      expect(slice).toMatchObject({ lostUnits: 0, contractsCompleted: 1, onTimeRate: 1, shipsSpawned: 1, unitsInStorage: 0 });
      expect(slice.xp).toBeGreaterThan(0);
      expect(slice.commandsSkipped).toBe(0);
    });

    it('vertical_slice: ekonomika kontraktu (prijatý 1, dokončený 1, tržba = odmena, bez penalizácií, údržba > 0)', () => {
      // Odmena z nezávislého behu: rovnaký scenár nad skutočným Worldom, `rewardCents` z `ContractCompleted`.
      const scenario = loadScenario(VERTICAL_SLICE_SCENARIO);
      const world = World.create(defs, loadBundledMap(), scenario.seed);
      const rewards: number[] = [];
      let next = 0;
      for (let i = 0; i < SLICE_TICKS; i++) {
        while (next < scenario.commands.length && scenario.commands[next].atTick === world.clock.tick) {
          world.enqueue(commandFromJSON(scenario.commands[next].command as SerializedCommand));
          next += 1;
        }
        for (const event of [...world.applyPending(), ...world.tick()]) {
          if (event.type === 'ContractCompleted') rewards.push(event.rewardCents);
        }
      }
      expect(rewards).toHaveLength(1);
      expect(slice).toMatchObject({
        contractsAccepted: 1,
        contractsCompleted: 1,
        contractsFailed: 0,
        penaltiesCents: 0,
        tier: 0,
        gameOver: false,
        revenueCents: rewards[0],
      });
      expect(slice.contractsOffered).toBeGreaterThanOrEqual(slice.contractsAccepted + slice.contractsExpired);
      expect(slice.maintenanceCents).toBeGreaterThan(0);
      expect(slice.wagesCents).toBeGreaterThanOrEqual(0);
    }, HEAVY_TIMEOUT_MS);

    it('scenáre bez kontraktov (full_import_chain): kontrakty 0, tržby 0, údržba > 0', () => {
      const report = runScenario(loadScenario(FULL_IMPORT_CHAIN_SCENARIO), TICKS_PER_DAY * 2, defs);
      expect(report).toMatchObject({
        contractsAccepted: 0,
        contractsCompleted: 0,
        contractsFailed: 0,
        penaltiesCents: 0,
        revenueCents: 0,
        tier: 0,
        gameOver: false,
      });
      expect(report.maintenanceCents).toBeGreaterThan(0);
    }, HEAVY_TIMEOUT_MS);

    it('formatSummary obsahuje riadok kontraktov a ekonomiky', () => {
      const text = formatSummary(slice);
      expect(text).toContain(`kontrakty ponúknuté/prijaté/zlyhané/zaniknuté ${String(slice.contractsOffered)}/1/0/${String(slice.contractsExpired)}`);
      expect(text).toContain(`tržby ${String(slice.revenueCents)}`);
      expect(text).toContain(`údržba ${String(slice.maintenanceCents)}`);
      expect(text).toContain('koniec hry nie');
    });

    it('scenáre bez kontraktov: onTimeRate null, contractsCompleted 0, xp 0', () => {
      const report = runScenario(loadScenario(FULL_IMPORT_CHAIN_SCENARIO), 1000, defs);
      expect([report.onTimeRate, report.contractsCompleted, report.xp]).toEqual([null, 0, 0]);
    });
  });

  describe('vehicleUtilPercent', () => {
    it('bez vozidlo-tickov (žiadne vozidlá alebo ešte žiadny tick) → 0, nie NaN', () => {
      expect(vehicleUtilPercent({ activeTicks: 0, totalTicks: 0 })).toBe(0);
    });

    it.each<[string, number, number, number]>([
      ['vozidlá stále idle', 0, 500, 0],
      ['vozidlá stále v práci', 500, 500, 100],
      ['polovica', 50, 100, 50],
      ['1/3 → 33.3', 1, 3, 33.3],
      ['2/3 → 66.7', 2, 3, 66.7],
      ['zaokrúhlenie hore: 16.666… → 16.7', 1, 6, 16.7],
      ['zaokrúhlenie dole: 34.24 → 34.2', 3424, 10_000, 34.2],
    ])('%s', (_name, activeTicks, totalTicks, expected) => {
      expect(vehicleUtilPercent({ activeTicks, totalTicks })).toBe(expected);
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

  describe('--hash a --roundtrip-at (T06-01, ADR-030)', () => {
    const HEX8 = /^[0-9a-f]{8}$/;
    const roadsScenario = (): Scenario => withCommands({ atTick: 10, command: PLACE_ROAD }, { atTick: 200, command: REMOVE_ROAD });

    it('hash: stateHash = stateHash sveta po rovnakom replayi (8 hex znakov); bez voľby null a ostatné metriky rovnaké', () => {
      const scenario = roadsScenario();
      const report = runScenario(scenario, 300, defs, { hash: true });
      const world = World.create(defs, loadBundledMap(), scenario.seed);
      for (let i = 0; i < 300; i++) {
        for (const entry of scenario.commands) {
          if (entry.atTick === world.clock.tick) world.enqueue(commandFromJSON(entry.command as SerializedCommand));
        }
        world.applyPending();
        world.tick();
      }
      expect(report.stateHash).toMatch(HEX8);
      expect(report.stateHash).toBe(stateHash(world));
      const plain = runScenario(scenario, 300, defs);
      expect(plain.stateHash).toBeNull();
      expect({ ...report, stateHash: null }).toEqual(plain);
    });

    it.each([0, 1, 10, 11, 200, 299])('roundtrip v ticku %i (aj pred príkazom toho ticku) → report aj stateHash zhodné s behom bez roundtripu', (at) => {
      const scenario = roadsScenario();
      const plain = runScenario(scenario, 300, defs, { hash: true });
      expect(runScenario(scenario, 300, defs, { hash: true, roundtripAt: at })).toEqual(plain);
    });

    it('roundtrip uprostred full_import_chain (tick 4 000: kamióny, joby, export) → celý report zhodný s behom bez roundtripu', () => {
      const scenario = loadScenario(FULL_IMPORT_CHAIN_SCENARIO);
      const plain = runScenario(scenario, 12_000, defs, { hash: true });
      expect(plain.trucksSpawned).toBeGreaterThan(0);
      expect(plain.exportedUnits).toBeGreaterThan(0);
      expect(runScenario(scenario, 12_000, defs, { hash: true, roundtripAt: 4_000 })).toEqual(plain);
    }, HEAVY_TIMEOUT_MS);

    it('roundtripWorld: nový svet (nie ten istý objekt) s rovnakým hashom a nezávislým stavom', () => {
      const world = World.create(defs, loadBundledMap(), SMOKE.seed);
      for (let i = 0; i < 50; i++) world.tick();
      const copy = roundtripWorld(world, defs);
      expect(copy).not.toBe(world);
      expect(stateHash(copy)).toBe(stateHash(world));
      copy.tick();
      expect(world.clock.tick).toBe(50);
      expect(copy.clock.tick).toBe(51);
    });

    it.each([-1, 1.5, 10, 11])('roundtripAt %s mimo 0…ticks − 1 → SimrunError', (at) => {
      expect(() => runScenario(SMOKE, 10, defs, { roundtripAt: at })).toThrow(SimrunError);
      expect(() => runScenario(SMOKE, 10, defs, { roundtripAt: at })).toThrow(/roundtripAt musí byť celé číslo 0…9/);
    });

    it('bankrot zastaví hodiny pred tickom roundtripu → SimrunError; roundtrip v ticku bankrotu zachová koniec hry', () => {
      // startingCashCents 0 a bankruptcyDays 1 → GameOver pri prvej uzávierke dňa (tick 8 640), potom hodiny stoja.
      const broke = DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, startingCashCents: 0, bankruptcyDays: 1 } });
      const ticks = TICKS_PER_DAY + 50;
      expect(() => runScenario(SMOKE, ticks, broke, { roundtripAt: TICKS_PER_DAY + 10 })).toThrow(
        new RegExp(`roundtrip v ticku ${String(TICKS_PER_DAY + 10)} nenastal — hodiny sa zastavili v ticku ${String(TICKS_PER_DAY)}`),
      );
      const plain = runScenario(SMOKE, ticks, broke, { hash: true });
      expect(plain).toMatchObject({ gameOver: true, ticks: TICKS_PER_DAY });
      expect(runScenario(SMOKE, ticks, broke, { hash: true, roundtripAt: TICKS_PER_DAY })).toEqual(plain);
    }, HEAVY_TIMEOUT_MS);

    it('formatSummary: so stateHash končí „hash stavu <hex>", bez neho hash nespomína', () => {
      const report = runScenario(SMOKE, 10, defs, { hash: true });
      expect(formatSummary(report).endsWith(`, hash stavu ${String(report.stateHash)}`)).toBe(true);
      expect(formatSummary({ ...report, stateHash: null })).not.toContain('hash stavu');
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

  it('apron_to_yard --report → čistý JSON s metrikami vozidiel a skladov, exit 0', () => {
    const run = runCli(APRON_TO_YARD_SCENARIO, '--ticks', '15000', '--report');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      scenario: 'apron_to_yard',
      lostUnits: 0,
      vehicles: 2,
      unitsInStorage: 120,
      jobsDone: 120,
      noStorageEvents: 0,
    });
    expect(typeof report['ticksToAllStored']).toBe('number');
    expect(typeof report['vehicleUtilPct']).toBe('number');
  }, 60_000);

  it('full_import_chain --report → čistý JSON s metrikami kamiónov a exportu, exit 0', () => {
    const run = runCli(FULL_IMPORT_CHAIN_SCENARIO, '--ticks', '40000', '--report');
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      scenario: 'full_import_chain',
      lostUnits: 0,
      exportedUnits: 120,
      trucksSpawned: 120,
      trucksExited: 120,
      unitsExportedByTrucks: 120,
    });
    expect(Number.isInteger(report['noWaitingBayEvents'])).toBe(true); // hodnota závisí od balansu stojiska/stagingu
    expect(typeof report['ticksToAllExported']).toBe('number');
    expect(report['gateQueueMax']).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('smoke --report → nové kľúče F4 sú 0 a null (nie vynechané)', () => {
    const run = runCli(SMOKE_SCENARIO, '--ticks', '100', '--report');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      trucksSpawned: 0,
      trucksExited: 0,
      unitsExportedByTrucks: 0,
      noWaitingBayEvents: 0,
      gateQueueMax: 0,
      ticksToAllExported: null,
      contractsCompleted: 0,
      xp: 0,
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

  it('--hash → zhrnutie končí hashom stavu; --report --hash → stateHash v JSON; --roundtrip-at dá bajtovo rovnaký výstup', () => {
    const summary = runCli(SMOKE_SCENARIO, '--ticks', '1000', '--hash');
    expect(summary.status).toBe(0);
    const match = /, hash stavu ([0-9a-f]{8})\n$/.exec(summary.stdout);
    expect(match).not.toBeNull();
    const roundtrip = runCli(SMOKE_SCENARIO, '--ticks', '1000', '--hash', '--roundtrip-at', '500');
    expect(roundtrip.status).toBe(0);
    expect(roundtrip.stdout).toBe(summary.stdout);
    const report = runCli(SMOKE_SCENARIO, '--ticks', '1000', '--report', '--hash', '--roundtrip-at=999');
    expect(report.status).toBe(0);
    expect(report.stderr).toBe('');
    expect((JSON.parse(report.stdout) as Record<string, unknown>)['stateHash']).toBe(match?.[1]);
  }, 60_000);

  it('--roundtrip-at ≥ --ticks → exit 1 a správa na stderr', () => {
    const run = runCli(SMOKE_SCENARIO, '--ticks', '10', '--roundtrip-at', '10');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('--roundtrip-at 10 musí byť menší než --ticks 10');
  }, 30_000);

  it('chýbajúci --ticks → exit 1 a použitie na stderr', () => {
    const run = runCli(SMOKE_SCENARIO);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--ticks');
    expect(run.stdout).toBe('');
  }, 30_000);
});
