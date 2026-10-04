// F6a / T6A-02 (ADR-032): `pnpm validate:defs` pre polia exportu — schéma (rozsahy, povinné polia, druh šablóny) a krížové
// kontroly, ktoré schéma nevyjadrí (cut-off po prijatí, súčet váh tried, rezerva apronu, cena exportu, kapacita lode).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DEFS_DIR, DEFAULT_SCHEMAS_DIR, validateDefsDir } from '../../tools/validate-defs';

type Json = Record<string, unknown>;

const readDef = (name: string): Json => JSON.parse(readFileSync(join(DEFAULT_DEFS_DIR, `${name}.json`), 'utf8')) as Json;
const itemsOf = (def: Json): Json[] => def['items'] as Json[];

describe('validate:defs — F6a defy exportu', () => {
  let defsDir: string;
  let tmpRoot: string;

  const write = (name: string, value: Json): void => writeFileSync(join(defsDir, `${name}.json`), JSON.stringify(value, null, 2));
  const errorsFor = (file: string): string[] => {
    const result = validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR).find((entry) => entry.file === file);
    if (result === undefined) throw new Error(`žiadny výsledok pre ${file}`);
    return result.errors;
  };
  const writeReal = (): void => {
    for (const name of ['cargo_types', 'ships', 'contract_templates', 'economy', 'logistics', 'modules']) write(name, readDef(name));
  };
  const edit = (name: string, change: (def: Json) => void): void => {
    const def = readDef(name);
    change(def);
    write(name, def);
  };
  const template = (def: Json, id: string): Json => itemsOf(def).find((item) => item['id'] === id) as Json;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'validate-export-defs-'));
    defsDir = join(tmpRoot, 'defs');
    mkdirSync(defsDir);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skutočné defy sú platné vrátane polí exportu', () => {
    writeReal();
    for (const file of ['cargo_types.json', 'contract_templates.json', 'economy.json', 'logistics.json', 'modules.json', 'ships.json']) {
      expect(errorsFor(file), file).toEqual([]);
    }
  });

  describe('economy.json', () => {
    it('cutoffHours musí byť menší ako exportArrivalDaysRange[0] × 24 h', () => {
      writeReal();
      edit('economy', (def) => void (def['cutoffHours'] = 48));
      expect(errorsFor('economy.json')).toEqual([
        'economy.json: /exportArrivalDaysRange/0 min × 24 h (48) musí byť > cutoffHours (48) — cut-off by ležal pred prijatím bookingu, dostal 2',
      ]);
      edit('economy', (def) => void (def['cutoffHours'] = 47));
      expect(errorsFor('economy.json')).toEqual([]);
    });

    it('exportArrivalDaysRange: min ≤ max', () => {
      writeReal();
      edit('economy', (def) => void (def['exportArrivalDaysRange'] = [3, 2]));
      expect(errorsFor('economy.json')).toEqual(['economy.json: /exportArrivalDaysRange rozsah musí mať min ≤ max, dostal [3, 2]']);
    });

    it.each([
      ['bookingOffersPerDay', -1, '/bookingOffersPerDay must be >= 0'],
      ['cutoffHours', 0, '/cutoffHours must be > 0'],
      ['bookingFulfilmentShare', 1.2, '/bookingFulfilmentShare must be <= 1'],
      ['rolledExportRateOfReward', -0.1, '/rolledExportRateOfReward must be >= 0'],
    ])('%s = %j → schéma', (field, value, message) => {
      writeReal();
      edit('economy', (def) => void (def[field] = value));
      expect(errorsFor('economy.json')).toContain(`economy.json: ${message}`);
    });

    it('chýbajúce nové pole', () => {
      writeReal();
      edit('economy', (def) => void delete def['cutoffWarningHours']);
      expect(errorsFor('economy.json')).toEqual(["economy.json: / must have required property 'cutoffWarningHours'"]);
    });
  });

  describe('logistics.json', () => {
    it('súčet váh hmotnostných tried musí byť > 0', () => {
      writeReal();
      edit('logistics', (def) => void ((def['exportFlow'] as Json)['weightClassShares'] = { light: 0, medium: 0, heavy: 0 }));
      expect(errorsFor('logistics.json')).toEqual(['logistics.json: /exportFlow/weightClassShares súčet váh hmotnostných tried musí byť > 0']);
    });

    it('okno príchodov exportu (arrivalWindowDays × 24 h) musí presiahnuť economy.cutoffHours', () => {
      writeReal();
      edit('logistics', (def) => void ((def['exportFlow'] as Json)['arrivalWindowDays'] = 0.5));
      expect(errorsFor('logistics.json')).toEqual([
        'logistics.json: /exportFlow/arrivalWindowDays okno príchodov (12 h) musí byť > economy.cutoffHours (12) — okno pred cut-off by bolo prázdne, dostal 0.5',
      ]);
    });

    it('schéma: vgmMissingChance nad 1 a chýbajúca trieda', () => {
      writeReal();
      edit('logistics', (def) => void ((def['exportFlow'] as Json)['vgmMissingChance'] = 1.5));
      expect(errorsFor('logistics.json')).toEqual(['logistics.json: /exportFlow/vgmMissingChance must be <= 1']);
      writeReal();
      edit('logistics', (def) => void delete ((def['exportFlow'] as Json)['weightClassShares'] as Json)['light']);
      expect(errorsFor('logistics.json')).toEqual(["logistics.json: /exportFlow/weightClassShares must have required property 'light'"]);
    });
  });

  describe('modules.json', () => {
    it('apronReserveSlots nad ⌊apronSlots / 2⌋ → chyba vzťahu', () => {
      writeReal();
      edit('modules', (def) => void ((itemsOf(def)[0]!['params'] as Json)['apronReserveSlots'] = 5));
      expect(errorsFor('modules.json')).toEqual(['modules.json: /items/0/params/apronReserveSlots musí byť ≤ ⌊apronSlots / 2⌋ (4), dostal 5']);
    });

    it('dualCycleFactor mimo 1 … 2 → schéma', () => {
      writeReal();
      edit('modules', (def) => void ((itemsOf(def)[1]!['params'] as Json)['dualCycleFactor'] = 2.5));
      expect(errorsFor('modules.json')).toEqual(['modules.json: /items/1/params/dualCycleFactor must be <= 2']);
    });
  });

  describe('ships.json a cargo_types.json', () => {
    it('lashingTicksPerUnit a paperworkTicks: záporné → schéma, chýbajúce → povinné pole', () => {
      writeReal();
      edit('ships', (def) => void (itemsOf(def)[0]!['lashingTicksPerUnit'] = -1));
      expect(errorsFor('ships.json')).toEqual(['ships.json: /items/0/lashingTicksPerUnit must be >= 0']);
      writeReal();
      edit('ships', (def) => void delete itemsOf(def)[1]!['paperworkTicks']);
      expect(errorsFor('ships.json')).toEqual(["ships.json: /items/1 must have required property 'paperworkTicks'"]);
    });

    it('exportPricePerUnitCents: záporné → schéma; 0 pri export šablóne → krížová kontrola', () => {
      writeReal();
      edit('cargo_types', (def) => void (itemsOf(def)[0]!['exportPricePerUnitCents'] = -5));
      expect(errorsFor('cargo_types.json')).toEqual(['cargo_types.json: /items/0/exportPricePerUnitCents must be >= 0']);
      writeReal();
      edit('cargo_types', (def) => void (itemsOf(def)[0]!['exportPricePerUnitCents'] = 0));
      expect(errorsFor('contract_templates.json')).toEqual([
        "contract_templates.json: /items/3/cargoTypeId šablóna druhu 'roundtrip' vyžaduje typ nákladu s exportPricePerUnitCents > 0, 'container_teu' má 0",
        "contract_templates.json: /items/4/cargoTypeId šablóna druhu 'export' vyžaduje typ nákladu s exportPricePerUnitCents > 0, 'container_teu' má 0",
      ]);
    });
  });

  describe('contract_templates.json — druh šablóny', () => {
    it('roundtrip bez exportVolumeUnitsRange → schéma aj krížová kontrola', () => {
      writeReal();
      edit('contract_templates', (def) => void delete template(def, 'container_feeder_roundtrip')['exportVolumeUnitsRange']);
      const errors = errorsFor('contract_templates.json');
      expect(errors).toContain('contract_templates.json: /items/3/exportVolumeUnitsRange šablóna druhu \'roundtrip\' vyžaduje pole');
      expect(errors.some((line) => line.includes("must have required property 'exportVolumeUnitsRange'"))).toBe(true);
    });

    it('export bez destinationPorts', () => {
      writeReal();
      edit('contract_templates', (def) => void delete template(def, 'container_feeder_export')['destinationPorts']);
      expect(errorsFor('contract_templates.json')).toContain("contract_templates.json: /items/4/destinationPorts šablóna druhu 'export' vyžaduje pole");
    });

    it('import s destinationPorts a s exportVolumeUnitsRange', () => {
      writeReal();
      edit('contract_templates', (def) => {
        template(def, 'container_feeder_express')['destinationPorts'] = ['Hamburg'];
        template(def, 'container_feeder_express')['exportVolumeUnitsRange'] = [12, 24];
      });
      const errors = errorsFor('contract_templates.json');
      expect(errors).toContain("contract_templates.json: /items/0/destinationPorts šablóna druhu 'import' toto pole nemá");
      expect(errors).toContain("contract_templates.json: /items/0/exportVolumeUnitsRange šablóna druhu 'import' toto pole nemá");
    });

    it('chýbajúci kind = import: platná šablóna bez poľa', () => {
      writeReal();
      edit('contract_templates', (def) => void delete template(def, 'container_feeder_express')['kind']);
      expect(errorsFor('contract_templates.json')).toEqual([]);
    });

    it('neznámy kind → schéma', () => {
      writeReal();
      edit('contract_templates', (def) => void (template(def, 'container_feeder_express')['kind'] = 'tranship'));
      expect(errorsFor('contract_templates.json').some((line) => line.startsWith('contract_templates.json: /items/0/kind'))).toBe(true);
    });

    it('exportVolumeUnitsRange: min > max a max nad kapacitu najmenšej lode', () => {
      writeReal();
      edit('contract_templates', (def) => void (template(def, 'container_feeder_roundtrip')['exportVolumeUnitsRange'] = [36, 12]));
      expect(errorsFor('contract_templates.json')).toEqual(['contract_templates.json: /items/3/exportVolumeUnitsRange rozsah musí mať min ≤ max, dostal [36, 12]']);
      edit('contract_templates', (def) => void (template(def, 'container_feeder_roundtrip')['exportVolumeUnitsRange'] = [12, 121]));
      expect(errorsFor('contract_templates.json')).toEqual([
        'contract_templates.json: /items/3/exportVolumeUnitsRange/1 musí byť ≤ najmenšia kapacita lodí šablóny (120), dostal 121',
      ]);
    });

    it('destinationPorts: prázdne pole a duplicity → schéma', () => {
      writeReal();
      edit('contract_templates', (def) => void (template(def, 'container_feeder_export')['destinationPorts'] = []));
      expect(errorsFor('contract_templates.json')).toContain('contract_templates.json: /items/4/destinationPorts must NOT have fewer than 1 items');
      edit('contract_templates', (def) => void (template(def, 'container_feeder_export')['destinationPorts'] = ['Hamburg', 'Hamburg']));
      expect(errorsFor('contract_templates.json').some((line) => line.includes('/items/4/destinationPorts must NOT have duplicate items'))).toBe(true);
    });
  });
});
