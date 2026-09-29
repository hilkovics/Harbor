import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DEFS_DIR, DEFAULT_SCHEMAS_DIR, validateDefsDir } from '../../tools/validate-defs';

const VALIDATE_SCRIPT = fileURLToPath(new URL('../../tools/validate-defs.ts', import.meta.url));

const TIME_OK = { schemaVersion: 1, tickGameSeconds: 10, ticksPerRealSecond: 10, speeds: [0, 1, 2, 4, 8] };

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
      expect(results.map((r) => r.file)).toEqual(expect.arrayContaining(['economy.json', 'time.json']));
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

  describe('CLI (tools/validate-defs.ts)', () => {
    const runCli = (defs: string, schemas: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', VALIDATE_SCRIPT, defs, schemas], { encoding: 'utf8' });

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

    it('def bez schémy → exit 1', () => {
      writeDef('mystery.json', { schemaVersion: 1 });
      const run = runCli(defsDir, DEFAULT_SCHEMAS_DIR);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('mystery.json: / chýba schéma');
    }, 30_000);
  });
});
