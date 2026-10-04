// F5 / T05-01: `pnpm validate:defs` pre contract_templates.json, nové polia economy.json a mzdu žeriava — schéma
// (additionalProperties: false, rozsahy) a krížové kontroly, ktoré schéma nevyjadrí (cargo, lode, kapacita, poradie rozsahov).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DEFS_DIR, DEFAULT_SCHEMAS_DIR, validateDefsDir } from '../../tools/validate-defs';

type Json = Record<string, unknown>;

const readDef = (name: string): Json => JSON.parse(readFileSync(join(DEFAULT_DEFS_DIR, `${name}.json`), 'utf8')) as Json;
const itemsOf = (def: Json): Json[] => def['items'] as Json[];

describe('validate:defs — F5 defy', () => {
  let defsDir: string;
  let tmpRoot: string;

  const write = (name: string, value: Json): void => writeFileSync(join(defsDir, `${name}.json`), JSON.stringify(value, null, 2));
  const errorsFor = (file: string): string[] => {
    const result = validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR).find((entry) => entry.file === file);
    if (result === undefined) throw new Error(`žiadny výsledok pre ${file}`);
    return result.errors;
  };
  /** Skutočné defy potrebné pre krížové kontroly šablón (cargo, lode, šablóny, economy). */
  const writeReal = (): void => {
    for (const name of ['cargo_types', 'ships', 'contract_templates', 'economy']) write(name, readDef(name));
  };
  const templateAfter = (index: number, change: (template: Json) => void): void => {
    const def = readDef('contract_templates');
    change(itemsOf(def)[index]!);
    write('contract_templates', def);
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'validate-contract-templates-'));
    defsDir = join(tmpRoot, 'defs');
    mkdirSync(defsDir);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skutočné defy: contract_templates.json, economy.json a modules.json sú platné', () => {
    const results = validateDefsDir(DEFAULT_DEFS_DIR, DEFAULT_SCHEMAS_DIR);
    for (const file of ['contract_templates.json', 'economy.json', 'modules.json']) {
      expect(results.find((entry) => entry.file === file)?.errors, file).toEqual([]);
    }
  });

  describe('contract_templates.json — schéma', () => {
    it('platný katalóg bez chýb', () => {
      writeReal();
      expect(errorsFor('contract_templates.json')).toEqual([]);
    });

    it.each([
      ['volumeUnitsRange', [12], '/items/0/volumeUnitsRange must NOT have fewer than 2 items'],
      ['volumeUnitsRange', [12, 24, 48], '/items/0/volumeUnitsRange must NOT have more than 2 items'],
      ['volumeUnitsRange', [0, 48], '/items/0/volumeUnitsRange/0 must be >= 1'],
      ['volumeUnitsRange', [12.5, 48], '/items/0/volumeUnitsRange/0 must be integer'],
      ['slaDaysRange', [0, 3], '/items/0/slaDaysRange/0 must be >= 1'],
      ['shipClassIds', [], '/items/0/shipClassIds must NOT have fewer than 1 items'],
      ['weight', 0, '/items/0/weight must be >= 1'],
      ['minTier', -1, '/items/0/minTier must be >= 0'],
    ])('%s = %j → chyba s cestou', (field, value, message) => {
      writeReal();
      templateAfter(0, (template) => void (template[field] = value));
      expect(errorsFor('contract_templates.json')).toEqual([`contract_templates.json: ${message}`]);
    });

    it('chýbajúce povinné pole a neznámy kľúč', () => {
      writeReal();
      templateAfter(0, (template) => void delete template['weight']);
      expect(errorsFor('contract_templates.json')).toEqual(["contract_templates.json: /items/0 must have required property 'weight'"]);
      templateAfter(0, (template) => void (template['extra'] = 1));
      expect(errorsFor('contract_templates.json')).toEqual(['contract_templates.json: /items/0 must NOT have additional properties (extra)']);
    });

    it('duplicitné id → chyba na /items/1/id', () => {
      writeReal();
      const def = readDef('contract_templates');
      itemsOf(def)[1]!['id'] = itemsOf(def)[0]!['id'];
      write('contract_templates', def);
      expect(errorsFor('contract_templates.json')).toEqual([
        "contract_templates.json: /items/1/id duplicitné id 'container_feeder_express' (/items/0/id)",
      ]);
    });
  });

  describe('contract_templates.json — krížové kontroly', () => {
    it('rozsah v opačnom poradí (schéma ho nevyjadrí) → chyba na rozsahu', () => {
      writeReal();
      templateAfter(0, (template) => void (template['volumeUnitsRange'] = [48, 12]));
      expect(errorsFor('contract_templates.json')).toEqual(['contract_templates.json: /items/0/volumeUnitsRange rozsah musí mať min ≤ max, dostal [48, 12]']);
      templateAfter(0, (template) => void (template['slaDaysRange'] = [3, 2]));
      expect(errorsFor('contract_templates.json')).toEqual(['contract_templates.json: /items/0/slaDaysRange rozsah musí mať min ≤ max, dostal [3, 2]']);
    });

    it('neznámy cargoTypeId', () => {
      writeReal();
      templateAfter(1, (template) => void (template['cargoTypeId'] = 'grain_25t'));
      expect(errorsFor('contract_templates.json')).toEqual([
        "contract_templates.json: /items/1/cargoTypeId neznámy typ nákladu 'grain_25t' (cargo_types.json)",
      ]);
    });

    it('neznáma loď v shipClassIds', () => {
      writeReal();
      templateAfter(2, (template) => void (template['shipClassIds'] = ['handy', 'panamax']));
      expect(errorsFor('contract_templates.json')).toEqual(["contract_templates.json: /items/2/shipClassIds/1 neznáma trieda lode 'panamax' (ships.json)"]);
    });

    it('loď, ktorá nevozí kategóriu nákladu', () => {
      writeReal();
      const ships = readDef('ships');
      for (const ship of itemsOf(ships)) ship['cargoCategories'] = ['bulk'];
      write('ships', ships);
      expect(errorsFor('contract_templates.json')).toEqual([
        "contract_templates.json: /items/0/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/1/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/2/shipClassIds/0 loď 'handy' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/3/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/4/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/5/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/6/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
        "contract_templates.json: /items/7/shipClassIds/0 loď 'feeder' nevozí kategóriu 'container' nákladu 'container_teu'",
      ]);
    });

    it('volumeUnitsRange[1] > najmenšia kapacita lodí šablóny', () => {
      writeReal();
      templateAfter(0, (template) => void (template['volumeUnitsRange'] = [12, 121]));
      expect(errorsFor('contract_templates.json')).toEqual([
        'contract_templates.json: /items/0/volumeUnitsRange/1 musí byť ≤ najmenšia kapacita lodí šablóny (120), dostal 121',
      ]);
    });

    it('viac lodí: rozhoduje najmenšia kapacita; presne kapacita lode je platná', () => {
      writeReal();
      templateAfter(2, (template) => void (template['shipClassIds'] = ['handy', 'feeder']));
      expect(errorsFor('contract_templates.json')).toEqual([
        'contract_templates.json: /items/2/volumeUnitsRange/1 musí byť ≤ najmenšia kapacita lodí šablóny (120), dostal 240',
      ]);
      templateAfter(2, (template) => void ((template['shipClassIds'] = ['handy', 'feeder']), (template['volumeUnitsRange'] = [60, 120])));
      expect(errorsFor('contract_templates.json')).toEqual([]);
    });

    it('bez cargo_types.json alebo ships.json sa krížová kontrola preskočí (chýbajúci súbor hlási iná kontrola)', () => {
      write('contract_templates', readDef('contract_templates'));
      expect(errorsFor('contract_templates.json')).toEqual([]);
    });
  });

  describe('economy.json — polia F5', () => {
    const economyAfter = (change: (economy: Json) => void): void => {
      const economy = readDef('economy');
      change(economy);
      write('economy', economy);
    };

    it('platný def bez chýb', () => {
      writeReal();
      expect(errorsFor('economy.json')).toEqual([]);
    });

    it.each([
      ['urgencyFactor', -0.1, '/urgencyFactor must be >= 0'],
      ['arrivalDaysRange', [-1, 2], '/arrivalDaysRange/0 must be >= 0'],
      ['arrivalDaysRange', [1], '/arrivalDaysRange must NOT have fewer than 2 items'],
      ['volumeScaleRange', [0, 1], '/volumeScaleRange/0 must be > 0'],
      ['minCapacityHint', 0, '/minCapacityHint must be >= 1'],
      ['contractsPerTier', 0, '/contractsPerTier must be >= 1'],
      ['xpMultiplier', -1, '/xpMultiplier must be >= 0'],
      ['lateXpFactor', 1.5, '/lateXpFactor must be <= 1'],
      ['ledgerEntriesKept', 0, '/ledgerEntriesKept must be >= 1'],
    ])('%s = %j → chyba schémy s cestou', (field, value, message) => {
      writeReal();
      economyAfter((economy) => void (economy[field] = value));
      expect(errorsFor('economy.json')).toEqual([`economy.json: ${message}`]);
    });

    it('chýbajúce nové povinné pole', () => {
      writeReal();
      economyAfter((economy) => void delete economy['ledgerEntriesKept']);
      expect(errorsFor('economy.json')).toEqual(["economy.json: / must have required property 'ledgerEntriesKept'"]);
    });

    it('rozsahy v opačnom poradí (schéma ich nevyjadrí) → chyba na rozsahu', () => {
      writeReal();
      economyAfter((economy) => void (economy['arrivalDaysRange'] = [2, 0.5]));
      expect(errorsFor('economy.json')).toEqual(['economy.json: /arrivalDaysRange rozsah musí mať min ≤ max, dostal [2, 0.5]']);
      economyAfter((economy) => void (economy['volumeScaleRange'] = [1.2, 0.4]));
      expect(errorsFor('economy.json')).toEqual(['economy.json: /volumeScaleRange rozsah musí mať min ≤ max, dostal [1.2, 0.4]']);
    });

    it('arrivalDaysRange[1] = 0 → chyba (loď by prišla v ticku prijatia)', () => {
      writeReal();
      economyAfter((economy) => void (economy['arrivalDaysRange'] = [0, 0]));
      expect(errorsFor('economy.json')).toEqual([
        'economy.json: /arrivalDaysRange/1 musí byť > 0 (loď kontraktu nesmie prísť v ticku prijatia), dostal 0',
      ]);
    });
  });

  describe('modules.json — mzda žeriava', () => {
    const craneIndex = (modules: Json): number => itemsOf(modules).findIndex((item) => item['kind'] === 'crane');

    it.each([
      [-1, 'must be >= 0'],
      [250.5, 'must be integer'],
      ['25000', 'must be integer'],
    ])('wagePerDayCents = %j → chyba schémy', (value, message) => {
      const modules = readDef('modules');
      const index = craneIndex(modules);
      (itemsOf(modules)[index]!['params'] as Json)['wagePerDayCents'] = value;
      write('modules', modules);
      expect(errorsFor('modules.json')).toEqual([`modules.json: /items/${String(index)}/params/wagePerDayCents ${message}`]);
    });

    it('chýbajúca mzda žeriava je chyba (povinný parameter)', () => {
      const modules = readDef('modules');
      const index = craneIndex(modules);
      delete (itemsOf(modules)[index]!['params'] as Json)['wagePerDayCents'];
      write('modules', modules);
      expect(errorsFor('modules.json')).toEqual([`modules.json: /items/${String(index)}/params must have required property 'wagePerDayCents'`]);
    });
  });
});
