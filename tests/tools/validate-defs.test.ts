import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSET_MANIFEST,
  DEFAULT_DEFS_DIR,
  DEFAULT_MAPS_DIR,
  DEFAULT_SCHEMAS_DIR,
  validateAssetManifest,
  validateDefsDir,
  validateMapsDir,
} from '../../tools/validate-defs';

const VALIDATE_SCRIPT = fileURLToPath(new URL('../../tools/validate-defs.ts', import.meta.url));

const TIME_OK = {
  schemaVersion: 1,
  tickGameSeconds: 10,
  ticksPerRealSecond: 10,
  maxTicksPerFrame: 64,
  speeds: [0, 1, 2, 4, 8],
};

const INFRASTRUCTURE_OK = {
  schemaVersion: 1,
  road: { costPerCellCents: 200000, maintenancePerDayCents: 0 },
  rail: { costPerCellCents: 600000, maintenancePerDayCents: 0 },
  roadKinds: {
    two_lane: { costPerCellCents: 200000, speedFactor: 1 },
    one_lane: { costPerCellCents: 120000, speedFactor: 0.7 },
    one_way: { costPerCellCents: 150000, speedFactor: 1 },
  },
};

function readRealDef(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DEFAULT_DEFS_DIR, `${name}.json`), 'utf8')) as Record<string, unknown>;
}

describe('validateDefsDir', () => {
  let defsDir: string;
  let tmpRoot: string;

  const writeDef = (name: string, value: unknown): void => {
    writeFileSync(join(defsDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const resultFor = (file: string) => {
    const result = validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR).find((r) => r.file === file);
    if (!result) throw new Error(`žiadny výsledok pre ${file}`);
    return result;
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'validate-defs-'));
    defsDir = join(tmpRoot, 'defs');
    mkdirSync(defsDir);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('skutočné defy', () => {
    it('všetky data/defs/*.json prejdú svojou schémou', () => {
      const results = validateDefsDir(DEFAULT_DEFS_DIR, DEFAULT_SCHEMAS_DIR);
      expect(results.map((r) => r.file)).toEqual(
        expect.arrayContaining(['economy.json', 'infrastructure.json', 'logistics.json', 'time.json', 'trucks.json', 'vehicles.json']),
      );
      for (const r of results) expect(r.errors, r.file).toEqual([]);
    });

    it('time.json má hodnoty z ARCHITECTURE §3', () => {
      expect(readRealDef('time')).toEqual(TIME_OK);
    });

    it('economy.json má hodnoty z ARCHITECTURE §4.6 a §9.2', () => {
      expect(readRealDef('economy')).toEqual({
        schemaVersion: 1,
        startingCashCents: 120000000,
        demurrageRateOfRewardPerHour: 0.005,
        latePenaltyRateOfRewardPerDay: 0.05,
        failAfterDaysLate: 3,
        leaseMonthlyRateOfPrice: 0.015,
        bankruptcyDays: 30,
        offersPerDay: 6,
        offerExpiryDays: 2,
        removalRefundRate: 0.5,
        // F5: kontrakty, XP a ledger (ADR-025..027).
        urgencyFactor: 0.6,
        arrivalDaysRange: [0.5, 2],
        volumeScaleRange: [0.4, 1.2],
        minCapacityHint: 24,
        contractsPerTier: 10,
        xpMultiplier: 1,
        lateXpFactor: 0.5,
        ledgerEntriesKept: 2000,
        // F6a: export a booking (ADR-032).
        bookingOffersPerDay: 2,
        exportArrivalDaysRange: [2, 3],
        cutoffHours: 12,
        cutoffWarningHours: 6,
        bookingFulfilmentShare: 0.9,
        lastMinuteExportRateOfReward: 0.02,
        rolledExportRateOfReward: 0.05,
        unfulfilledBookingRateOfReward: 0.1,
      });
    });

    it('infrastructure.json má hodnoty z ARCHITECTURE §4.6 (ADR-010)', () => {
      expect(readRealDef('infrastructure')).toEqual(INFRASTRUCTURE_OK);
    });

    it('logistics.json má hodnoty z ARCHITECTURE §4.6 (ADR-010)', () => {
      expect(readRealDef('logistics')).toEqual({
        schemaVersion: 1,
        defaultInternalTicks: 6,
        repathIntervalTicks: 30,
        congestion: { trafficDecayPerHour: 0.9, slowdownPerExtraVehicle: 0.25, penaltyTrafficDivisor: 200, penaltyMax: 3 },
        shipNavigation: { approachMarginCells: 1, sweepStepCells: 0.5, turnManeuvers: 1, sidewaysManeuvers: 1 },
        exportFlow: { arrivalWindowDays: 2, vgmMissingChance: 0.05, vgmHoldHours: 6, weightClassShares: { light: 0.3, medium: 0.5, heavy: 0.2 } },
      });
    });
  });

  describe('platný def', () => {
    it('vráti prázdne errors', () => {
      writeDef('time.json', TIME_OK);
      expect(validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR)).toEqual([{ file: 'time.json', errors: [] }]);
    });

    it('spracuje len *.json a výsledky vráti zoradené podľa názvu', () => {
      writeDef('time.json', TIME_OK);
      writeDef('economy.json', readRealDef('economy'));
      writeDef('poznamky.txt', 'nie je def');
      expect(validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR).map((r) => r.file)).toEqual(['economy.json', 'time.json']);
    });
  });

  describe('neplatný def → chyba s cestou k poľu', () => {
    it('zlý typ poľa: cesta je JSON pointer na pole', () => {
      writeDef('time.json', { ...TIME_OK, tickGameSeconds: '10' });
      const errors = resultFor('time.json').errors;
      expect(errors).toContain('time.json: /tickGameSeconds must be integer');
      expect(errors.every((line) => line.startsWith('time.json: /tickGameSeconds '))).toBe(true);
    });

    describe('tickGameSeconds musí deliť 60 (ARCHITECTURE §3)', () => {
      const ENUM_ERROR = 'time.json: /tickGameSeconds must be equal to one of the allowed values';

      it.each([7, 120, 8, 9, 11, 45])('%i → chyba s /tickGameSeconds', (value) => {
        writeDef('time.json', { ...TIME_OK, tickGameSeconds: value });
        expect(resultFor('time.json').errors).toEqual([ENUM_ERROR]);
      });

      it.each([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60])('%i → platné', (value) => {
        writeDef('time.json', { ...TIME_OK, tickGameSeconds: value });
        expect(resultFor('time.json').errors).toEqual([]);
      });

      it('CLI: 7 → exit 1 a /tickGameSeconds v stderr', () => {
        writeDef('time.json', { ...TIME_OK, tickGameSeconds: 7 });
        const run = spawnSync(process.execPath, ['--import', 'tsx', VALIDATE_SCRIPT, defsDir, DEFAULT_SCHEMAS_DIR], {
          encoding: 'utf8',
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(ENUM_ERROR);
      }, 30_000);
    });

    it('zlý prvok poľa: cesta obsahuje index', () => {
      writeDef('time.json', { ...TIME_OK, speeds: [0, 1, 'x'] });
      const errors = resultFor('time.json').errors;
      expect(errors).toContain('time.json: /speeds/2 must be integer');
    });

    it('hodnota mimo rozsahu', () => {
      writeDef('economy.json', { ...readRealDef('economy'), demurrageRateOfRewardPerHour: 1.5 });
      expect(resultFor('economy.json').errors).toEqual([
        'economy.json: /demurrageRateOfRewardPerHour must be <= 1',
      ]);
    });

    it('chýbajúce povinné pole: koreň je "/" a správa pomenuje pole', () => {
      const { speeds: _speeds, ...withoutSpeeds } = TIME_OK;
      void _speeds;
      writeDef('time.json', withoutSpeeds);
      expect(resultFor('time.json').errors).toEqual(["time.json: / must have required property 'speeds'"]);
    });

    it('neznáme pole (additionalProperties: false) je pomenované v správe', () => {
      writeDef('time.json', { ...TIME_OK, tickGameSecs: 10 });
      const errors = resultFor('time.json').errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^time\.json: \/ must NOT have additional properties/);
      expect(errors[0]).toContain('tickGameSecs');
    });

    it('nesprávny schemaVersion', () => {
      writeDef('time.json', { ...TIME_OK, schemaVersion: 2 });
      expect(resultFor('time.json').errors).toEqual(['time.json: /schemaVersion must be equal to constant']);
    });

    it('speeds bez pauzy (0) je chyba', () => {
      writeDef('time.json', { ...TIME_OK, speeds: [1, 2, 4] });
      expect(resultFor('time.json').errors).toEqual(['time.json: /speeds must contain at least 1 valid item(s)']);
    });

    describe('time.maxTicksPerFrame (ARCHITECTURE §3)', () => {
      it.each([0, -1, 1.5, '64', null])('%j → chyba s /maxTicksPerFrame', (value) => {
        writeDef('time.json', { ...TIME_OK, maxTicksPerFrame: value });
        const errors = resultFor('time.json').errors;
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every((line) => line.startsWith('time.json: /maxTicksPerFrame '))).toBe(true);
      });

      it('chýbajúce pole je chyba', () => {
        const { maxTicksPerFrame: _max, ...without } = TIME_OK;
        void _max;
        writeDef('time.json', without);
        expect(resultFor('time.json').errors).toEqual(["time.json: / must have required property 'maxTicksPerFrame'"]);
      });

      it.each([1, 64, 1000])('%i → platné', (value) => {
        writeDef('time.json', { ...TIME_OK, maxTicksPerFrame: value });
        expect(resultFor('time.json').errors).toEqual([]);
      });
    });

    describe('economy.removalRefundRate (ARCHITECTURE §8 bod 8)', () => {
      it.each([-0.1, 1.5, '0.5', null])('%j → chyba s /removalRefundRate', (value) => {
        writeDef('economy.json', { ...readRealDef('economy'), removalRefundRate: value });
        const errors = resultFor('economy.json').errors;
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every((line) => line.startsWith('economy.json: /removalRefundRate '))).toBe(true);
      });

      it.each([0, 0.5, 1])('%d → platné', (value) => {
        writeDef('economy.json', { ...readRealDef('economy'), removalRefundRate: value });
        expect(resultFor('economy.json').errors).toEqual([]);
      });
    });

    describe('infrastructure.json (ADR-010)', () => {
      const withRoad = (road: unknown) => ({ ...INFRASTRUCTURE_OK, road });

      it('platný def', () => {
        writeDef('infrastructure.json', INFRASTRUCTURE_OK);
        expect(resultFor('infrastructure.json').errors).toEqual([]);
      });

      it('záporná cena za bunku → cesta do vnoreného poľa', () => {
        writeDef('infrastructure.json', withRoad({ costPerCellCents: -1, maintenancePerDayCents: 0 }));
        expect(resultFor('infrastructure.json').errors).toEqual([
          'infrastructure.json: /road/costPerCellCents must be >= 0',
        ]);
      });

      it('zlý typ údržby', () => {
        writeDef('infrastructure.json', withRoad({ costPerCellCents: 200000, maintenancePerDayCents: '0' }));
        expect(resultFor('infrastructure.json').errors).toEqual([
          'infrastructure.json: /road/maintenancePerDayCents must be integer',
        ]);
      });

      it('chýbajúci kľúč rail', () => {
        const { rail: _rail, ...without } = INFRASTRUCTURE_OK;
        void _rail;
        writeDef('infrastructure.json', without);
        expect(resultFor('infrastructure.json').errors).toEqual([
          "infrastructure.json: / must have required property 'rail'",
        ]);
      });

      it('neznáme vnorené pole je pomenované', () => {
        writeDef('infrastructure.json', withRoad({ costPerCellCents: 200000, maintenancePerDayCents: 0, extra: 1 }));
        const errors = resultFor('infrastructure.json').errors;
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^infrastructure\.json: \/road must NOT have additional properties/);
        expect(errors[0]).toContain('extra');
      });
    });

    it('allErrors: vráti všetky chyby naraz', () => {
      writeDef('time.json', { ...TIME_OK, tickGameSeconds: 0, ticksPerRealSecond: 'x' });
      const errors = resultFor('time.json').errors;
      expect(errors).toContain('time.json: /tickGameSeconds must be equal to one of the allowed values');
      expect(errors).toContain('time.json: /ticksPerRealSecond must be integer');
    });

    it('koreň nie je objekt', () => {
      writeDef('time.json', '[]');
      expect(resultFor('time.json').errors).toEqual(['time.json: / must be object']);
    });

    it('nevalidný JSON je chyba (nie výnimka) a neblokuje ostatné súbory', () => {
      writeDef('time.json', '{ "schemaVersion": 1, ');
      writeDef('economy.json', readRealDef('economy'));
      const results = validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR);
      const time = results.find((r) => r.file === 'time.json');
      expect(time?.errors).toHaveLength(1);
      expect(time?.errors[0]).toMatch(/^time\.json: \/ neplatný JSON/);
      expect(results.find((r) => r.file === 'economy.json')?.errors).toEqual([]);
    });
  });

  describe('def bez schémy → chyba', () => {
    it('chýbajúca schéma je chyba pomenovaná podľa súboru', () => {
      writeDef('mystery.json', { schemaVersion: 1 });
      const errors = resultFor('mystery.json').errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^mystery\.json: \/ chýba schéma/);
      expect(errors[0]).toContain('mystery.schema.json');
    });

    it('chýbajúca schéma nezhodí validáciu ostatných defov', () => {
      writeDef('mystery.json', { schemaVersion: 1 });
      writeDef('time.json', TIME_OK);
      const results = validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR);
      expect(results.find((r) => r.file === 'time.json')?.errors).toEqual([]);
      expect(results.find((r) => r.file === 'mystery.json')?.errors).not.toEqual([]);
    });

    it('používa sa iba schéma z odovzdaného schemasDir', () => {
      const emptySchemas = join(tmpRoot, 'schemas');
      mkdirSync(emptySchemas);
      writeDef('time.json', TIME_OK);
      expect(validateDefsDir(defsDir, emptySchemas)[0]?.errors[0]).toMatch(/^time\.json: \/ chýba schéma/);
      copyFileSync(join(DEFAULT_SCHEMAS_DIR, 'time.schema.json'), join(emptySchemas, 'time.schema.json'));
      expect(validateDefsDir(defsDir, emptySchemas)[0]?.errors).toEqual([]);
    });
  });

  describe('krížová kontrola rampa × kamión (review T04-11 f)', () => {
    const modules = (): Record<string, unknown> => readRealDef('modules');
    const trucks = (): { items: Record<string, unknown>[] } => readRealDef('trucks') as unknown as { items: Record<string, unknown>[] };
    const rampIndex = (): number => (modules()['items'] as { kind: string }[]).findIndex((item) => item.kind === 'ramp');

    it('skutočné modules.json a trucks.json: každá rampa má kamión svojej kategórie s capacityUnits ≤ stagingPerDock', () => {
      writeDef('modules.json', modules());
      writeDef('trucks.json', trucks());
      expect(resultFor('modules.json').errors).toEqual([]);
    });

    it('rampa bez kamióna svojej kategórie → chyba na params/category', () => {
      const bulkOnly = trucks();
      bulkOnly.items = bulkOnly.items.map((item) => ({ ...item, cargoCategories: ['bulk'] }));
      writeDef('modules.json', modules());
      writeDef('trucks.json', bulkOnly);
      expect(resultFor('modules.json').errors).toEqual([
        `modules.json: /items/${String(rampIndex())}/params/category rampa 'loading_ramp_container' nakladá kategóriu 'container', ale trucks.json nemá kamión tejto kategórie`,
      ]);
      expect(resultFor('trucks.json').errors).toEqual([]);
    });

    it('kamión s capacityUnits > stagingPerDock → chyba na params/stagingPerDock', () => {
      const big = trucks();
      big.items = big.items.map((item) => ({ ...item, capacityUnits: 5 }));
      writeDef('modules.json', modules());
      writeDef('trucks.json', big);
      expect(resultFor('modules.json').errors).toEqual([
        `modules.json: /items/${String(rampIndex())}/params/stagingPerDock kamión 'truck_container' má capacityUnits 5 > stagingPerDock 4 rampy 'loading_ramp_container' — dock by sa nikdy nenaplnil`,
      ]);
    });

    it('bez trucks.json sa krížová kontrola preskočí (chýbajúci súbor hlási iná kontrola)', () => {
      writeDef('modules.json', modules());
      expect(resultFor('modules.json').errors).toEqual([]);
    });
  });

  describe('mapy (data/maps/*.json → map.schema.json)', () => {
    let mapsDir: string;

    const realMap = (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(DEFAULT_MAPS_DIR, 'harbor_01.json'), 'utf8')) as Record<string, unknown>;
    const writeMap = (name: string, value: unknown): void => {
      writeFileSync(join(mapsDir, name), typeof value === 'string' ? value : JSON.stringify(value));
    };
    const mapResult = (file: string) => {
      const result = validateMapsDir(mapsDir, DEFAULT_SCHEMAS_DIR).find((r) => r.file === `maps/${file}`);
      if (!result) throw new Error(`žiadny výsledok pre maps/${file}`);
      return result;
    };

    beforeEach(() => {
      mapsDir = join(tmpRoot, 'maps');
      mkdirSync(mapsDir);
    });

    describe('skutočné mapy', () => {
      it('všetky data/maps/*.json prejdú map.schema.json a výsledok je pomenovaný maps/<súbor>', () => {
        const results = validateMapsDir(DEFAULT_MAPS_DIR, DEFAULT_SCHEMAS_DIR);
        expect(results.map((r) => r.file)).toContain('maps/harbor_01.json');
        for (const r of results) expect(r.errors, r.file).toEqual([]);
      });

      it('harbor_01 má rozmery 96×64 a terén presne width×height znakov (ARCHITECTURE §4.7)', () => {
        const map = realMap() as { id: string; width: number; height: number; terrain: string[] };
        expect(map.id).toBe('harbor_01');
        expect([map.width, map.height]).toEqual([96, 64]);
        expect(map.terrain).toHaveLength(64);
        for (const row of map.terrain) expect(row).toHaveLength(96);
      });

      it('harbor_01: súvislé nábrežie ≥ 24 buniek, 3 parcely (1 štartovná), 1 cestný a 1 železničný portál', () => {
        const map = realMap() as {
          terrain: string[];
          parcels: { id: string; startOwned?: boolean; leasable: boolean }[];
          roadPortals: unknown[];
          railPortals: unknown[];
        };
        const longestQuayRun = Math.max(
          ...map.terrain.map((row) => Math.max(0, ...row.split(/[^Q]+/).map((run) => run.length))),
        );
        expect(longestQuayRun).toBeGreaterThanOrEqual(24);
        expect(map.parcels).toHaveLength(3);
        expect(map.parcels.filter((p) => p.startOwned === true).map((p) => p.id)).toEqual(['starter']);
        expect(map.parcels.filter((p) => p.startOwned !== true).every((p) => p.leasable)).toBe(true);
        expect(map.roadPortals).toHaveLength(1);
        expect(map.railPortals).toHaveLength(1);
      });
    });

    describe('platná mapa', () => {
      it('vráti prázdne errors', () => {
        writeMap('harbor_01.json', realMap());
        expect(validateMapsDir(mapsDir, DEFAULT_SCHEMAS_DIR)).toEqual([{ file: 'maps/harbor_01.json', errors: [] }]);
      });

      it('spracuje len *.json a výsledky vráti zoradené podľa názvu', () => {
        writeMap('b_map.json', realMap());
        writeMap('a_map.json', realMap());
        writeMap('poznamky.txt', 'nie je mapa');
        expect(validateMapsDir(mapsDir, DEFAULT_SCHEMAS_DIR).map((r) => r.file)).toEqual([
          'maps/a_map.json',
          'maps/b_map.json',
        ]);
      });
    });

    describe('neplatná mapa → chyba s cestou k poľu', () => {
      it('chýbajúce povinné pole (seaLane)', () => {
        const { seaLane: _lane, ...without } = realMap();
        void _lane;
        writeMap('bad.json', without);
        expect(mapResult('bad.json').errors).toEqual(["maps/bad.json: / must have required property 'seaLane'"]);
      });

      it('chýbajúce vnorené pole (parcels/0/priceCents)', () => {
        const map = realMap() as { parcels: Record<string, unknown>[] };
        const { priceCents: _price, ...parcel } = map.parcels[0] ?? {};
        void _price;
        writeMap('bad.json', { ...map, parcels: [parcel, ...map.parcels.slice(1)] });
        expect(mapResult('bad.json').errors).toEqual([
          "maps/bad.json: /parcels/0 must have required property 'priceCents'",
        ]);
      });

      it('zlý typ poľa (width ako reťazec)', () => {
        writeMap('bad.json', { ...realMap(), width: '96' });
        expect(mapResult('bad.json').errors).toEqual(['maps/bad.json: /width must be integer']);
      });

      it('zlý typ riadku terénu', () => {
        const map = realMap() as { terrain: unknown[] };
        writeMap('bad.json', { ...map, terrain: [42, ...map.terrain.slice(1)] });
        expect(mapResult('bad.json').errors).toContain('maps/bad.json: /terrain/0 must be string');
      });

      it('neznámy znak terénu', () => {
        const map = realMap() as { terrain: string[] };
        writeMap('bad.json', { ...map, terrain: ['X'.repeat(96), ...map.terrain.slice(1)] });
        expect(mapResult('bad.json').errors).toEqual(['maps/bad.json: /terrain/0 must match pattern "^[~=Q.#]+$"']);
      });

      it('depth: zlý kľúč aj zlá hodnota', () => {
        writeMap('bad.json', { ...realMap(), depth: { '10,14,20': 2, '30,14,28,3': 4 } });
        const errors = mapResult('bad.json').errors;
        expect(errors.some((line) => line.startsWith('maps/bad.json: /depth '))).toBe(true);
        expect(errors).toContain('maps/bad.json: /depth/30,14,28,3 must be equal to one of the allowed values');
      });

      it('parcela: nulová šírka a zlé id', () => {
        const map = realMap() as { parcels: Record<string, unknown>[] };
        const bad = { ...map.parcels[0], id: 'Bad Id', rect: { x: 0, y: 0, w: 0, h: 5 } };
        writeMap('bad.json', { ...map, parcels: [bad, ...map.parcels.slice(1)] });
        const errors = mapResult('bad.json').errors;
        expect(errors).toContain('maps/bad.json: /parcels/0/id must match pattern "^[a-z][a-z0-9_]*$"');
        expect(errors).toContain('maps/bad.json: /parcels/0/rect/w must be >= 1');
      });

      it('bunka bez y', () => {
        writeMap('bad.json', { ...realMap(), anchorage: [{ x: 44 }] });
        expect(mapResult('bad.json').errors).toEqual(["maps/bad.json: /anchorage/0 must have required property 'y'"]);
      });

      it('neznáme pole (additionalProperties: false)', () => {
        writeMap('bad.json', { ...realMap(), widht: 96 });
        const errors = mapResult('bad.json').errors;
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^maps\/bad\.json: \/ must NOT have additional properties/);
        expect(errors[0]).toContain('widht');
      });

      it('harbor_01: schemaVersion 1 a Root modul v starter.modules (T02-01)', () => {
        const map = realMap() as { schemaVersion: number; starter: { modules: unknown[] } };
        expect(map.schemaVersion).toBe(1);
        expect(map.starter.modules).toEqual([
          { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
          { defId: 'crane_container_gantry', x: 43, y: 14, rotation: 0 },
        ]);
      });

      it('chýbajúca schemaVersion', () => {
        const { schemaVersion: _version, ...without } = realMap();
        void _version;
        writeMap('bad.json', without);
        expect(mapResult('bad.json').errors).toEqual(["maps/bad.json: / must have required property 'schemaVersion'"]);
      });

      it.each([2, 0, '1', null])('schemaVersion = %j', (value) => {
        writeMap('bad.json', { ...realMap(), schemaVersion: value });
        expect(mapResult('bad.json').errors).toEqual(['maps/bad.json: /schemaVersion must be equal to constant']);
      });

      it.each([
        ['rotácia 45', { defId: 'berth_standard', x: 1, y: 1, rotation: 45 }, '/starter/modules/0/rotation must be equal to one of the allowed values'],
        ['záporné x', { defId: 'berth_standard', x: -1, y: 1, rotation: 0 }, '/starter/modules/0/x must be >= 0'],
        ['defId nie je snake_case', { defId: 'Berth', x: 1, y: 1, rotation: 0 }, '/starter/modules/0/defId must match pattern "^[a-z][a-z0-9_]*$"'],
      ])('starter.modules: %s', (_name, module, message) => {
        writeMap('bad.json', { ...realMap(), starter: { modules: [module], roads: [] } });
        expect(mapResult('bad.json').errors).toEqual([`maps/bad.json: ${message}`]);
      });

      it('starter.modules: položka bez defId', () => {
        writeMap('bad.json', { ...realMap(), starter: { modules: [{ x: 1, y: 1, rotation: 0 }], roads: [] } });
        expect(mapResult('bad.json').errors).toEqual([
          "maps/bad.json: /starter/modules/0 must have required property 'defId'",
        ]);
      });

      it('koreň nie je objekt', () => {
        writeMap('bad.json', '[]');
        expect(mapResult('bad.json').errors).toEqual(['maps/bad.json: / must be object']);
      });

      it('nevalidný JSON je chyba (nie výnimka) a neblokuje ostatné mapy', () => {
        writeMap('bad.json', '{ "id": ');
        writeMap('good.json', realMap());
        const results = validateMapsDir(mapsDir, DEFAULT_SCHEMAS_DIR);
        expect(results.find((r) => r.file === 'maps/bad.json')?.errors[0]).toMatch(/^maps\/bad\.json: \/ neplatný JSON/);
        expect(results.find((r) => r.file === 'maps/good.json')?.errors).toEqual([]);
      });

      it('chýbajúca map.schema.json je chyba pomenovaná podľa mapy', () => {
        const emptySchemas = join(tmpRoot, 'schemas');
        mkdirSync(emptySchemas);
        writeMap('harbor_01.json', realMap());
        const errors = validateMapsDir(mapsDir, emptySchemas)[0]?.errors ?? [];
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^maps\/harbor_01\.json: \/ chýba schéma map\.schema\.json/);
      });
    });
  });

  describe('CLI (tools/validate-defs.ts)', () => {
    const runCli = (defs: string, schemas: string, maps?: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', VALIDATE_SCRIPT, defs, schemas, ...(maps ? [maps] : [])], {
        encoding: 'utf8',
      });

    it('platné defy → exit 0 a riadok "OK <súbor>"', () => {
      writeDef('time.json', TIME_OK);
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('OK time.json');
    }, 30_000);

    it('akákoľvek chyba → exit 1 a chyba s cestou v stderr', () => {
      writeDef('time.json', { ...TIME_OK, tickGameSeconds: '10' });
      writeDef('economy.json', readRealDef('economy'));
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('OK economy.json');
      expect(run.stderr).toContain('time.json: /tickGameSeconds must be integer');
    }, 30_000);

    it('katalóg s duplicitným id → exit 1 a chyba s cestou v stderr', () => {
      const ships = readRealDef('ships') as { items: unknown[] };
      writeDef('ships.json', { ...ships, items: [...ships.items, ships.items[0]] });
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("ships.json: /items/2/id duplicitné id 'feeder' (/items/0/id)");
    }, 30_000);

    it('def bez schémy → exit 1', () => {
      writeDef('mystery.json', { schemaVersion: 1 });
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('mystery.json: / chýba schéma');
    }, 30_000);

    it('bez argumentov: OK pre defy aj pre maps/harbor_01.json, exit 0', () => {
      const run = spawnSync(process.execPath, ['--import', 'tsx', VALIDATE_SCRIPT], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('OK time.json');
      expect(run.stdout).toContain('OK infrastructure.json');
      for (const file of ['cargo_types.json', 'modules.json', 'ships.json', 'vehicles.json', 'trucks.json', 'logistics.json']) {
        expect(run.stdout).toContain(`OK ${file}`);
      }
      expect(run.stdout).toContain('OK maps/harbor_01.json');
      expect(run.stdout).toContain('OK assets/manifest.json');
    }, 30_000);

    it('neplatná mapa → exit 1 a chyba s cestou v stderr; platné defy ostávajú OK', () => {
      const mapsDir = join(tmpRoot, 'maps');
      mkdirSync(mapsDir);
      writeFileSync(join(mapsDir, 'broken.json'), JSON.stringify({ id: 'broken' }));
      writeDef('time.json', TIME_OK);
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR, mapsDir);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('OK time.json');
      expect(run.stderr).toContain("maps/broken.json: / must have required property 'width'");
    }, 30_000);

    it('platná mapa v odovzdanom adresári → OK maps/<súbor>', () => {
      const mapsDir = join(tmpRoot, 'maps');
      mkdirSync(mapsDir);
      copyFileSync(join(DEFAULT_MAPS_DIR, 'harbor_01.json'), join(mapsDir, 'copy.json'));
      writeDef('time.json', TIME_OK);
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR, mapsDir);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('OK maps/copy.json');
    }, 30_000);
  });
});

describe('validateAssetManifest (assets/manifest.json → asset-manifest.schema.json + krížová kontrola defov)', () => {
  type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
  type JsonObject = { [key: string]: Json };
  interface Catalog {
    schemaVersion: number;
    items: { id: string }[];
  }

  let tmpRoot: string;
  let defsDir: string;
  let manifestPath: string;

  const realManifest = (): JsonObject => JSON.parse(readFileSync(DEFAULT_ASSET_MANIFEST, 'utf8')) as JsonObject;
  const realCatalog = (name: string): Catalog =>
    JSON.parse(readFileSync(join(DEFAULT_DEFS_DIR, `${name}.json`), 'utf8')) as Catalog;
  const writeManifest = (value: unknown): void => {
    writeFileSync(manifestPath, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const writeDef = (name: string, value: unknown): void => {
    writeFileSync(join(defsDir, name), JSON.stringify(value));
  };
  const errorsOf = (): string[] => validateAssetManifest(manifestPath, DEFAULT_SCHEMAS_DIR, defsDir).errors;
  /** Zapíše skutočný manifest po úprave `change` (hlboká kópia, originál ostáva nedotknutý). */
  const writeMutated = (change: (manifest: JsonObject) => void): void => {
    const manifest = realManifest();
    change(manifest);
    writeManifest(manifest);
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'validate-manifest-'));
    defsDir = join(tmpRoot, 'defs');
    mkdirSync(defsDir);
    manifestPath = join(tmpRoot, 'manifest.json');
    writeDef('modules.json', realCatalog('modules'));
    writeDef('ships.json', realCatalog('ships'));
    writeDef('vehicles.json', realCatalog('vehicles'));
    writeDef('trucks.json', realCatalog('trucks'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skutočný manifest proti skutočným defom: bez chýb, výsledok pomenovaný assets/manifest.json', () => {
    expect(validateAssetManifest(DEFAULT_ASSET_MANIFEST, DEFAULT_SCHEMAS_DIR, DEFAULT_DEFS_DIR)).toEqual({
      file: 'assets/manifest.json',
      errors: [],
    });
  });

  it('každý modul, loď, vozidlo aj kamión zo skutočných defov má sprite (nie je to prázdna kontrola)', () => {
    const manifest = realManifest();
    const modules = realCatalog('modules').items.map((item) => item.id);
    const ships = realCatalog('ships').items.map((item) => item.id);
    const vehicles = realCatalog('vehicles').items.map((item) => item.id);
    const trucks = realCatalog('trucks').items.map((item) => item.id);
    expect(modules.length).toBeGreaterThan(0);
    expect(ships.length).toBeGreaterThan(0);
    expect(vehicles.length).toBeGreaterThan(0);
    expect(trucks.length).toBeGreaterThan(0);
    for (const id of modules) expect(Object.keys(manifest.sprites as JsonObject), id).toContain(id);
    for (const id of ships) expect(Object.keys(manifest.entities as JsonObject), id).toContain(`ship_${id}`);
    for (const id of vehicles) expect(Object.keys(manifest.entities as JsonObject), id).toContain(id);
    for (const id of trucks) expect(Object.keys(manifest.entities as JsonObject), id).toContain(id);
  });

  it('názov výsledku sa odvodí od súboru: assets/<basename>', () => {
    writeManifest(realManifest());
    expect(validateAssetManifest(manifestPath, DEFAULT_SCHEMAS_DIR, defsDir).file).toBe('assets/manifest.json');
  });

  describe('schéma', () => {
    it('platná kópia manifestu → bez chýb', () => {
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([]);
    });

    it('chýbajúca sekcia → cesta "/" a názov poľa', () => {
      writeMutated((m) => delete m.overlay);
      expect(errorsOf()).toEqual(["assets/manifest.json: / must have required property 'overlay'"]);
    });

    it('iná verzia schémy', () => {
      writeMutated((m) => (m.schemaVersion = 2));
      expect(errorsOf()).toEqual(['assets/manifest.json: /schemaVersion must be equal to constant']);
    });

    it('neznáma sekcia je pomenovaná v správe', () => {
      writeMutated((m) => (m.audio = {}));
      const errors = errorsOf();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^assets\/manifest\.json: \/ must NOT have additional properties/);
      expect(errors[0]).toContain('audio');
    });

    it('cesta súboru mimo vzoru {adresár}/{id}.svg → cesta do vnoreného poľa', () => {
      writeMutated((m) => ((m.terrain as { quay: JsonObject }).quay.file = 'Terrain/Quay.svg'));
      expect(errorsOf().some((line) => line.startsWith('assets/manifest.json: /terrain/quay/file '))).toBe(true);
    });

    it('nevalidný JSON je chyba (nie výnimka)', () => {
      writeManifest('{ "schemaVersion": ');
      const errors = errorsOf();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^assets\/manifest\.json: \/ neplatný JSON/);
    });

    it('chýbajúci súbor manifestu je chyba s cestou', () => {
      const errors = errorsOf();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^assets\/manifest\.json: \/ chýba súbor/);
      expect(errors[0]).toContain(manifestPath);
    });

    it('chýbajúca asset-manifest.schema.json je chyba pomenovaná podľa súboru', () => {
      const emptySchemas = join(tmpRoot, 'schemas');
      mkdirSync(emptySchemas);
      writeManifest(realManifest());
      const errors = validateAssetManifest(manifestPath, emptySchemas, defsDir).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^assets\/manifest\.json: \/ chýba schéma asset-manifest\.schema\.json/);
    });
  });

  describe('krížová kontrola: každý modul má sprites[id], každá loď entities.ship_{id}, každé vozidlo a kamión entities[id]', () => {
    it('chýbajúci sprite modulu → chyba s cestou v manifeste a odkazom na def', () => {
      writeMutated((m) => delete (m.sprites as JsonObject).berth_standard);
      expect(errorsOf()).toEqual([
        "assets/manifest.json: /sprites/berth_standard chýba sprite pre modul 'berth_standard' (modules.json: /items/0/id)",
      ]);
    });

    it('chýbajúci sprite lode → chyba s cestou /entities/ship_{id}', () => {
      writeMutated((m) => delete (m.entities as JsonObject).ship_feeder);
      expect(errorsOf()).toEqual([
        "assets/manifest.json: /entities/ship_feeder chýba sprite pre loď 'feeder' (ships.json: /items/0/id)",
      ]);
    });

    it('chýbajúci sprite vozidla → chyba s cestou /entities/{id}', () => {
      writeMutated((m) => delete (m.entities as JsonObject).straddle_carrier);
      expect(errorsOf()).toEqual([
        "assets/manifest.json: /entities/straddle_carrier chýba sprite pre vozidlo 'straddle_carrier' (vehicles.json: /items/0/id)",
      ]);
    });

    it('chýbajúci sprite kamióna → chyba s cestou /entities/{id}', () => {
      writeMutated((m) => delete (m.entities as JsonObject).truck_container);
      expect(errorsOf()).toEqual([
        "assets/manifest.json: /entities/truck_container chýba sprite pre kamión 'truck_container' (trucks.json: /items/0/id)",
      ]);
    });

    it('nový kamión v trucks.json bez entity → chyba (index položky v ceste)', () => {
      const trucks = realCatalog('trucks');
      writeDef('trucks.json', { ...trucks, items: [...trucks.items, { ...trucks.items[0], id: 'truck_hover' }] });
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /entities/truck_hover chýba sprite pre kamión 'truck_hover' (trucks.json: /items/${String(trucks.items.length)}/id)`,
      ]);
    });

    it('kamión s entitou v manifeste (truck_bulk) je platný', () => {
      const trucks = realCatalog('trucks');
      writeDef('trucks.json', { ...trucks, items: [...trucks.items, { ...trucks.items[0], id: 'truck_bulk' }] });
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([]);
    });

    it('sprite vozidla sa hľadá pod id bez predpony ship_ (ship_straddle_carrier nestačí)', () => {
      writeMutated((m) => {
        const entities = m.entities as JsonObject;
        entities.ship_straddle_carrier = entities.straddle_carrier!;
        delete entities.straddle_carrier;
      });
      expect(errorsOf()).toEqual([
        "assets/manifest.json: /entities/straddle_carrier chýba sprite pre vozidlo 'straddle_carrier' (vehicles.json: /items/0/id)",
      ]);
    });

    it('nové vozidlo vo vehicles.json bez entity → chyba (index položky v ceste)', () => {
      const vehicles = realCatalog('vehicles');
      writeDef('vehicles.json', { ...vehicles, items: [...vehicles.items, { ...vehicles.items[0], id: 'hover_truck' }] });
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /entities/hover_truck chýba sprite pre vozidlo 'hover_truck' (vehicles.json: /items/${String(vehicles.items.length)}/id)`,
      ]);
    });

    it('vozidlo s entitou v manifeste (agv) je platné', () => {
      const vehicles = realCatalog('vehicles');
      writeDef('vehicles.json', { ...vehicles, items: [...vehicles.items, { ...vehicles.items[0], id: 'agv' }] });
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([]);
    });

    it('viac chýb naraz sa vypíše všetko (allErrors)', () => {
      writeMutated((m) => {
        delete (m.sprites as JsonObject).crane_container_gantry;
        delete (m.entities as JsonObject).ship_handy;
        delete (m.entities as JsonObject).straddle_carrier;
        delete (m.entities as JsonObject).truck_container;
      });
      const errors = errorsOf();
      expect(errors).toHaveLength(4);
      expect(errors.some((line) => line.includes('/sprites/crane_container_gantry'))).toBe(true);
      expect(errors.some((line) => line.includes('/entities/ship_handy'))).toBe(true);
      expect(errors.some((line) => line.includes('/entities/straddle_carrier'))).toBe(true);
      expect(errors.some((line) => line.includes('/entities/truck_container'))).toBe(true);
    });

    it('nový modul v modules.json bez sprite → chyba (index položky v ceste)', () => {
      const modules = realCatalog('modules');
      writeDef('modules.json', { ...modules, items: [...modules.items, { ...modules.items[0], id: 'container_yard_small_x' }] });
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/container_yard_small_x chýba sprite pre modul 'container_yard_small_x' (modules.json: /items/${String(modules.items.length)}/id)`,
      ]);
    });

    it('nová trieda lode v ships.json bez entity ship_{id} → chyba', () => {
      const ships = realCatalog('ships');
      writeDef('ships.json', { ...ships, items: [...ships.items, { ...ships.items[0], id: 'barge' }] });
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /entities/ship_barge chýba sprite pre loď 'barge' (ships.json: /items/${String(ships.items.length)}/id)`,
      ]);
    });

    it('sprite bez defu (budúce moduly) nie je chyba', () => {
      writeManifest(realManifest());
      writeDef('modules.json', { schemaVersion: 1, items: [] });
      writeDef('ships.json', { schemaVersion: 1, items: [] });
      writeDef('vehicles.json', { schemaVersion: 1, items: [] });
      writeDef('trucks.json', { schemaVersion: 1, items: [] });
      expect(errorsOf()).toEqual([]);
    });

    it('chýbajúci modules.json / ships.json / vehicles.json / trucks.json v defsDir → kontrola sa preskočí (hlási ju validateDefsDir)', () => {
      rmSync(join(defsDir, 'modules.json'));
      rmSync(join(defsDir, 'ships.json'));
      rmSync(join(defsDir, 'vehicles.json'));
      rmSync(join(defsDir, 'trucks.json'));
      writeMutated((m) => {
        delete (m.sprites as JsonObject).berth_standard;
        delete (m.entities as JsonObject).straddle_carrier;
        delete (m.entities as JsonObject).truck_container;
      });
      expect(errorsOf()).toEqual([]);
    });

    it('nečitateľný trucks.json sa preskočí bez výnimky', () => {
      writeFileSync(join(defsDir, 'trucks.json'), '{ nie json');
      writeMutated((m) => delete (m.entities as JsonObject).truck_container);
      expect(errorsOf()).toEqual([]);
    });

    it('nečitateľný vehicles.json sa preskočí bez výnimky', () => {
      writeFileSync(join(defsDir, 'vehicles.json'), '{ nie json');
      writeMutated((m) => delete (m.entities as JsonObject).straddle_carrier);
      expect(errorsOf()).toEqual([]);
    });

    it('nečitateľný modules.json sa preskočí bez výnimky', () => {
      writeFileSync(join(defsDir, 'modules.json'), '{ nie json');
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([]);
    });

    it('pri chýbajúcej sekcii sprites hlási len schéma (krížová kontrola nespamuje)', () => {
      writeMutated((m) => delete m.sprites);
      expect(errorsOf()).toEqual(["assets/manifest.json: / must have required property 'sprites'"]);
    });
  });

  describe('krížová kontrola počtov: params → počty v manifeste', () => {
    type Sprite = { stalls?: Json[] | number; docks?: Json[]; apronSlots?: Json[] };
    type SpriteArrayField = { stalls?: Json[]; docks?: Json[]; apronSlots?: Json[] };
    const sprite = (m: JsonObject, id: string): Sprite => (m.sprites as { [key: string]: Sprite })[id]!;
    const spriteArray = (m: JsonObject, id: string): SpriteArrayField => (m.sprites as { [key: string]: SpriteArrayField })[id]!;
    /** Zapíše modules.json, v ktorom položka `id` dostane `params[param] = value`. */
    const writeModuleParam = (id: string, param: string, value: number): number => {
      const modules = realCatalog('modules') as unknown as { schemaVersion: number; items: { id: string; params: JsonObject }[] };
      const index = modules.items.findIndex((item) => item.id === id);
      modules.items[index]!.params[param] = value;
      writeDef('modules.json', modules);
      return index;
    };

    it('skutočné defy a manifest: počty sedia (8 apronSlotov, 6 stojísk, 2 docky, 10 stajní)', () => {
      const manifest = realManifest();
      expect(sprite(manifest, 'berth_standard').apronSlots).toHaveLength(8);
      expect(sprite(manifest, 'truck_waiting_area').stalls).toHaveLength(6);
      expect(sprite(manifest, 'loading_ramp_container').docks).toHaveLength(2);
      expect(sprite(manifest, 'vehicle_depot').stalls).toBe(10);
      writeManifest(manifest);
      expect(errorsOf()).toEqual([]);
    });

    it('stojisko: menej stalls v manifeste než params.bays → chyba s cestou v manifeste a odkazom na def', () => {
      writeMutated((m) => (spriteArray(m, 'truck_waiting_area').stalls as Json[])?.pop());
      const index = String(realCatalog('modules').items.findIndex((item) => item.id === 'truck_waiting_area'));
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/truck_waiting_area/stalls počet stojísk (5) sa nezhoduje s params.bays (6) (modules.json: /items/${index}/params/bays)`,
      ]);
    });

    it('stojisko: params.bays iné než počet stalls → chyba', () => {
      const index = writeModuleParam('truck_waiting_area', 'bays', 8);
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/truck_waiting_area/stalls počet stojísk (6) sa nezhoduje s params.bays (8) (modules.json: /items/${String(index)}/params/bays)`,
      ]);
    });

    it('rampa: viac docks v manifeste než params.docks → chyba', () => {
      writeMutated((m) => (spriteArray(m, 'loading_ramp_container').docks as Json[])?.push({ x: 196, y: 60, w: 56, h: 62 }));
      const index = String(realCatalog('modules').items.findIndex((item) => item.id === 'loading_ramp_container'));
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/loading_ramp_container/docks počet dockov (3) sa nezhoduje s params.docks (2) (modules.json: /items/${index}/params/docks)`,
      ]);
    });

    it('rampa: params.docks iné než počet docks → chyba', () => {
      const index = writeModuleParam('loading_ramp_container', 'docks', 1);
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/loading_ramp_container/docks počet dockov (2) sa nezhoduje s params.docks (1) (modules.json: /items/${String(index)}/params/docks)`,
      ]);
    });

    it('chýbajúci sprite hlási len chýbajúci sprite (počty sa preskočia)', () => {
      writeMutated((m) => delete (m.sprites as JsonObject).truck_waiting_area);
      const errors = errorsOf();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("chýba sprite pre modul 'truck_waiting_area'");
    });

    it('sprite bez poľa stalls/docks sa preskočí (tvar hlási schéma manifestu)', () => {
      writeMutated((m) => delete spriteArray(m, 'loading_ramp_container').docks);
      expect(errorsOf().every((line) => !line.includes('počet dockov'))).toBe(true);
    });

    it('berth: menej apronSlots v manifeste než params.apronSlots → chyba', () => {
      writeMutated((m) => (spriteArray(m, 'berth_standard').apronSlots as Json[])?.pop());
      const index = String(realCatalog('modules').items.findIndex((item) => item.id === 'berth_standard'));
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/berth_standard/apronSlots počet apronSlotov (7) sa nezhoduje s params.apronSlots (8) (modules.json: /items/${index}/params/apronSlots)`,
      ]);
    });

    it('berth: params.apronSlots iné než počet apronSlots → chyba', () => {
      const index = writeModuleParam('berth_standard', 'apronSlots', 5);
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/berth_standard/apronSlots počet apronSlotov (8) sa nezhoduje s params.apronSlots (5) (modules.json: /items/${String(index)}/params/apronSlots)`,
      ]);
    });

    it('vehicle_depot: iné číslo stalls v manifeste než params.capacity → chyba', () => {
      writeMutated((m) => ((m.sprites as JsonObject).vehicle_depot as JsonObject).stalls = 15);
      const index = String(realCatalog('modules').items.findIndex((item) => item.id === 'vehicle_depot'));
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/vehicle_depot/stalls počet stajní (15) sa nezhoduje s params.capacity (10) (modules.json: /items/${index}/params/capacity)`,
      ]);
    });

    it('vehicle_depot: params.capacity iné než stalls → chyba', () => {
      const index = writeModuleParam('vehicle_depot', 'capacity', 12);
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([
        `assets/manifest.json: /sprites/vehicle_depot/stalls počet stajní (10) sa nezhoduje s params.capacity (12) (modules.json: /items/${String(index)}/params/capacity)`,
      ]);
    });

    it('iné druhy modulov sa na počty nekontrolujú', () => {
      writeModuleParam('container_yard_small', 'storageSlots', 999);
      writeManifest(realManifest());
      expect(errorsOf()).toEqual([]);
    });
  });

  describe('CLI (tools/validate-defs.ts)', () => {
    const runCli = (manifest: string, defs: string = DEFAULT_DEFS_DIR) =>
      spawnSync(process.execPath, ['--import', 'tsx', VALIDATE_SCRIPT, defs, DEFAULT_SCHEMAS_DIR, DEFAULT_MAPS_DIR, manifest], {
        encoding: 'utf8',
      });

    it('bez argumentov: exit 0 a "OK assets/manifest.json"', () => {
      const run = spawnSync(process.execPath, ['--import', 'tsx', VALIDATE_SCRIPT], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('OK assets/manifest.json');
    }, 30_000);

    it('chýbajúci sprite v odovzdanom manifeste → exit 1 a chyba s cestou v stderr; defy ostávajú OK', () => {
      writeMutated((m) => delete (m.sprites as JsonObject).berth_standard);
      const run = runCli(manifestPath);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('OK modules.json');
      expect(run.stderr).toContain("assets/manifest.json: /sprites/berth_standard chýba sprite pre modul 'berth_standard'");
    }, 30_000);

    it('chýbajúci sprite vozidla v odovzdanom manifeste → exit 1 a chyba s cestou v stderr', () => {
      writeMutated((m) => delete (m.entities as JsonObject).straddle_carrier);
      const run = runCli(manifestPath);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('OK vehicles.json');
      expect(run.stderr).toContain("assets/manifest.json: /entities/straddle_carrier chýba sprite pre vozidlo 'straddle_carrier'");
    }, 30_000);

    it('chýbajúci sprite kamióna v odovzdanom manifeste → exit 1 a chyba s cestou v stderr', () => {
      writeMutated((m) => delete (m.entities as JsonObject).truck_container);
      const run = runCli(manifestPath);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('OK trucks.json');
      expect(run.stderr).toContain("assets/manifest.json: /entities/truck_container chýba sprite pre kamión 'truck_container'");
    }, 30_000);

    it('chýbajúci súbor manifestu → exit 1', () => {
      const run = runCli(join(tmpRoot, 'nope', 'manifest.json'));
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('assets/manifest.json: / chýba súbor');
    }, 30_000);

    it('platná kópia manifestu → exit 0 a "OK assets/manifest.json"', () => {
      writeManifest(realManifest());
      const run = runCli(manifestPath);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('OK assets/manifest.json');
    }, 30_000);
  });
});
