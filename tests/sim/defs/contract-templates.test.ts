// F5 / T05-01: katalóg `contract_templates.json`, rozšírenie `economy.json` (kontrakty, XP, ledger) a mzda žeriava —
// getter, hodnoty, fail-fast chyby s JSON pointerom, krížové kontroly (cargo, lode, kapacita) a zhoda so schémou (Ajv).
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import contractTemplatesSchema from '@data/schemas/contract_templates.schema.json';
import economySchema from '@data/schemas/economy.schema.json';
import { DefError, DefRegistry, craneParams, loadBundledDefs } from '@sim/defs';
import { checkField } from '@sim/defs/def-spec';

type Json = Record<string, unknown>;

function rawDefs(): Record<string, Json> {
  return {
    time: structuredClone(timeJson),
    economy: structuredClone(economyJson),
    infrastructure: structuredClone(infrastructureJson),
    cargo_types: structuredClone(cargoTypesJson),
    modules: structuredClone(modulesJson),
    ships: structuredClone(shipsJson),
    vehicles: structuredClone(vehiclesJson),
    trucks: structuredClone(trucksJson),
    logistics: structuredClone(logisticsJson),
    contract_templates: structuredClone(contractTemplatesJson),
  };
}

const templatesOf = (raw: Record<string, Json>): Json[] => raw['contract_templates']!['items'] as Json[];
const shipsOf = (raw: Record<string, Json>): Json[] => raw['ships']!['items'] as Json[];

function expectDefError(fn: () => unknown, defName: string, path: string): DefError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DefError);
  const error = caught as DefError;
  expect(error.defName).toBe(defName);
  expect(error.path).toBe(path);
  return error;
}

const accepts = (raw: Record<string, Json>): boolean => {
  try {
    DefRegistry.fromRaw(raw);
    return true;
  } catch (error) {
    if (error instanceof DefError) return false;
    throw error;
  }
};

describe('contract_templates.json (bundled)', () => {
  const defs = loadBundledDefs();

  it('5 šablón kontajnerov: 3 import (express, standard, handy run tier 1) a booking roundtrip + export (feeder)', () => {
    expect(defs.contractTemplates.items.map((item) => item.id)).toEqual([
      'container_feeder_express',
      'container_feeder_standard',
      'container_handy_run',
      'container_feeder_roundtrip',
      'container_feeder_export',
    ]);
    expect(defs.contractTemplates.items).toEqual([
      {
        id: 'container_feeder_express',
        kind: 'import',
        cargoTypeId: 'container_teu',
        volumeUnitsRange: [12, 48],
        slaDaysRange: [2, 3],
        shipClassIds: ['feeder'],
        weight: 3,
        minTier: 0,
      },
      {
        id: 'container_feeder_standard',
        kind: 'import',
        cargoTypeId: 'container_teu',
        volumeUnitsRange: [24, 96],
        slaDaysRange: [3, 5],
        shipClassIds: ['feeder'],
        weight: 5,
        minTier: 0,
      },
      {
        id: 'container_handy_run',
        kind: 'import',
        cargoTypeId: 'container_teu',
        volumeUnitsRange: [60, 240],
        slaDaysRange: [5, 8],
        shipClassIds: ['handy'],
        weight: 2,
        minTier: 1,
      },
      {
        id: 'container_feeder_roundtrip',
        kind: 'roundtrip',
        destinationPorts: ['Rotterdam', 'Hamburg', 'Gdańsk'],
        cargoTypeId: 'container_teu',
        volumeUnitsRange: [24, 72],
        exportVolumeUnitsRange: [12, 36],
        slaDaysRange: [3, 5],
        shipClassIds: ['feeder'],
        weight: 4,
        minTier: 0,
      },
      {
        id: 'container_feeder_export',
        kind: 'export',
        destinationPorts: ['Rotterdam', 'Hamburg', 'Gdańsk'],
        cargoTypeId: 'container_teu',
        volumeUnitsRange: [12, 36],
        slaDaysRange: [3, 5],
        shipClassIds: ['feeder'],
        weight: 2,
        minTier: 0,
      },
    ]);
  });

  it('gettery: get / has, neznáme id → DefError, položky sú zmrazené', () => {
    expect(defs.contractTemplates.get('container_handy_run').minTier).toBe(1);
    expect(defs.contractTemplates.has('container_handy_run')).toBe(true);
    expect(defs.contractTemplates.has('nope')).toBe(false);
    expectDefError(() => defs.contractTemplates.get('nope'), 'contract_templates', '/items');
    const template = defs.contractTemplates.get('container_feeder_express');
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.volumeUnitsRange)).toBe(true);
    expect(Object.isFrozen(template.shipClassIds)).toBe(true);
  });

  it('objem každej šablóny sa zmestí do každej lode šablóny a je na začiatku dostupná aspoň jedna šablóna (tier 0)', () => {
    for (const template of defs.contractTemplates.items) {
      for (const shipId of template.shipClassIds) {
        expect(template.volumeUnitsRange[1]).toBeLessThanOrEqual(defs.ships.get(shipId).capacityUnits);
      }
    }
    expect(defs.contractTemplates.items.some((template) => template.minTier === 0)).toBe(true);
  });
});

describe('economy.json — polia F5 (bundled)', () => {
  it('hodnoty: urgency 0.6, príchod lode 0.5–2 dňa, škála objemu 0.4–1.2, hint 24, tier po 10, XP ×1, neskoré XP ×0.5, ledger 2000', () => {
    const { economy } = loadBundledDefs();
    expect(economy.urgencyFactor).toBe(0.6);
    expect(economy.arrivalDaysRange).toEqual([0.5, 2]);
    expect(economy.volumeScaleRange).toEqual([0.4, 1.2]);
    expect(economy.minCapacityHint).toBe(24);
    expect(economy.contractsPerTier).toBe(10);
    expect(economy.xpMultiplier).toBe(1);
    expect(economy.lateXpFactor).toBe(0.5);
    expect(economy.ledgerEntriesKept).toBe(2000);
    expect(Object.isFrozen(economy.arrivalDaysRange)).toBe(true);
  });
});

describe('crane_container_gantry.params.wagePerDayCents', () => {
  it('craneParams vráti mzdu 25 000 ¢/deň', () => {
    const crane = loadBundledDefs().modules.get('crane_container_gantry');
    expect(craneParams(crane).wagePerDayCents).toBe(25_000);
  });

  it.each([
    [-1, false],
    [0, true],
    [250.5, false],
    ['25000', false],
    [null, false],
    [25_000, true],
  ])('wagePerDayCents = %j → registry akceptuje: %s', (value, ok) => {
    const raw = rawDefs();
    const crane = (raw['modules']!['items'] as Json[]).find((item) => item['id'] === 'crane_container_gantry')!;
    (crane['params'] as Json)['wagePerDayCents'] = value;
    expect(accepts(raw)).toBe(ok);
  });

  it('chýbajúca mzda → DefError na params/wagePerDayCents žeriava', () => {
    const raw = rawDefs();
    const index = (raw['modules']!['items'] as Json[]).findIndex((item) => item['id'] === 'crane_container_gantry');
    delete ((raw['modules']!['items'] as Json[])[index]!['params'] as Json)['wagePerDayCents'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'modules', `/items/${String(index)}/params/wagePerDayCents`);
  });
});

describe('DefRegistry.fromRaw — contract_templates', () => {
  it('chýbajúci alebo null katalóg → DefError', () => {
    const raw: Record<string, Json | undefined> = rawDefs();
    delete raw['contract_templates'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '');
    expectDefError(() => DefRegistry.fromRaw({ ...rawDefs(), contract_templates: null }), 'contract_templates', '');
  });

  it('prázdny katalóg (items: []) → DefError na /items', () => {
    const raw = rawDefs();
    raw['contract_templates'] = { schemaVersion: 1, items: [] };
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items');
  });

  it('duplicitné id → DefError na /items/1/id', () => {
    const raw = rawDefs();
    templatesOf(raw)[1]!['id'] = templatesOf(raw)[0]!['id'];
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/1/id');
  });

  it('neznámy kľúč v položke → DefError', () => {
    const raw = rawDefs();
    templatesOf(raw)[0]!['extra'] = 1;
    expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/0/extra');
  });

  const CASES: readonly (readonly [path: string, value: unknown])[] = [
    ['/items/0/id', 'Express'],
    ['/items/0/cargoTypeId', 5],
    ['/items/0/volumeUnitsRange', 12],
    ['/items/0/volumeUnitsRange', [12]],
    ['/items/0/volumeUnitsRange', [12, 24, 48]],
    ['/items/0/volumeUnitsRange', [0, 48]],
    ['/items/0/volumeUnitsRange', [12.5, 48]],
    ['/items/0/volumeUnitsRange', ['12', 48]],
    ['/items/0/volumeUnitsRange', [48, 12]],
    ['/items/0/slaDaysRange', [0, 3]],
    ['/items/0/slaDaysRange', [3, 2]],
    ['/items/0/slaDaysRange', [2, 2.5]],
    ['/items/0/shipClassIds', []],
    ['/items/0/shipClassIds', ['feeder', 'feeder']],
    ['/items/0/shipClassIds', 'feeder'],
    ['/items/0/weight', 0],
    ['/items/0/weight', 1.5],
    ['/items/0/weight', '3'],
    ['/items/0/minTier', -1],
    ['/items/0/minTier', 0.5],
  ];

  it.each(CASES)('%s = %j → DefError s cestou poľa (alebo jeho prvku)', (path, value) => {
    const raw = rawDefs();
    const segments = path.slice(1).split('/');
    const field = segments[2]!;
    templatesOf(raw)[0]![field] = value;
    const error = (() => {
      try {
        DefRegistry.fromRaw(raw);
      } catch (caught) {
        return caught as DefError;
      }
      throw new Error(`${path} = ${JSON.stringify(value)} nemá byť platné`);
    })();
    expect(error).toBeInstanceOf(DefError);
    expect(error.defName).toBe('contract_templates');
    expect(error.path.startsWith(path)).toBe(true);
  });

  it('pre rozsah v opačnom poradí ukazuje cesta na celý rozsah a správa vysvetľuje min ≤ max', () => {
    const raw = rawDefs();
    templatesOf(raw)[0]!['volumeUnitsRange'] = [48, 12];
    const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/0/volumeUnitsRange');
    expect(error.problem).toContain('min ≤ max');
  });

  it('hranice: rozsahy [n, n] a weight 1 sú platné', () => {
    const raw = rawDefs();
    Object.assign(templatesOf(raw)[0]!, { volumeUnitsRange: [24, 24], slaDaysRange: [1, 1], weight: 1 });
    expect(accepts(raw)).toBe(true);
  });

  describe('krížové kontroly', () => {
    it('neznámy cargoTypeId → DefError na cargoTypeId', () => {
      const raw = rawDefs();
      templatesOf(raw)[1]!['cargoTypeId'] = 'grain_25t';
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/1/cargoTypeId');
      expect(error.problem).toContain('grain_25t');
      expect(error.problem).toContain('container_teu');
    });

    it('neznáma loď v shipClassIds → DefError s indexom lode', () => {
      const raw = rawDefs();
      templatesOf(raw)[2]!['shipClassIds'] = ['handy', 'panamax'];
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/2/shipClassIds/1');
      expect(error.problem).toContain('panamax');
    });

    it('loď, ktorá nevozí kategóriu nákladu → DefError', () => {
      const raw = rawDefs();
      for (const ship of shipsOf(raw)) ship['cargoCategories'] = ['bulk'];
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/0/shipClassIds/0');
      expect(error.problem).toContain("kategóriu 'container'");
    });

    it('volumeUnitsRange[1] > kapacita lode → DefError na /volumeUnitsRange/1', () => {
      const raw = rawDefs();
      templatesOf(raw)[0]!['volumeUnitsRange'] = [12, 121];
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/0/volumeUnitsRange/1');
      expect(error.problem).toContain('120');
      expect(error.problem).toContain('121');
    });

    it('volumeUnitsRange[1] = kapacita lode je platné', () => {
      const raw = rawDefs();
      templatesOf(raw)[0]!['volumeUnitsRange'] = [12, 120];
      expect(accepts(raw)).toBe(true);
    });

    it('viac lodí: rozhoduje najmenšia kapacita (feeder 120 < handy 300)', () => {
      const raw = rawDefs();
      templatesOf(raw)[2]!['shipClassIds'] = ['handy', 'feeder'];
      // [60, 240] sa zmestí do handy (300), ale nie do feeder (120).
      const error = expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/2/volumeUnitsRange/1');
      expect(error.problem).toContain('120');
      templatesOf(raw)[2]!['volumeUnitsRange'] = [60, 120];
      expect(accepts(raw)).toBe(true);
    });

    it('zmenšenie kapacity lode v ships.json spôsobí chybu šablóny (nie lode)', () => {
      const raw = rawDefs();
      shipsOf(raw).find((ship) => ship['id'] === 'handy')!['capacityUnits'] = 200;
      expectDefError(() => DefRegistry.fromRaw(raw), 'contract_templates', '/items/2/volumeUnitsRange/1');
    });
  });
});

describe('DefRegistry.fromRaw — economy (polia F5)', () => {
  const economy = (raw: Record<string, Json>): Json => raw['economy']!;

  it.each([
    ['urgencyFactor', -0.1],
    ['urgencyFactor', '0.6'],
    ['arrivalDaysRange', 1],
    ['arrivalDaysRange', [1]],
    ['arrivalDaysRange', [-0.5, 2]],
    ['arrivalDaysRange', [2, 0.5]],
    ['arrivalDaysRange', [0, 0]],
    ['arrivalDaysRange', ['a', 2]],
    ['volumeScaleRange', [0, 1.2]],
    ['volumeScaleRange', [1.2, 0.4]],
    ['volumeScaleRange', [0.4, 1.2, 2]],
    ['minCapacityHint', 0],
    ['minCapacityHint', 24.5],
    ['contractsPerTier', 0],
    ['contractsPerTier', 2.5],
    ['xpMultiplier', -1],
    ['lateXpFactor', -0.1],
    ['lateXpFactor', 1.5],
    ['ledgerEntriesKept', 0],
    ['ledgerEntriesKept', 10.5],
  ] as const)('economy.%s = %j → DefError na poli', (field, value) => {
    const raw = rawDefs();
    economy(raw)[field] = value;
    const error = (() => {
      try {
        DefRegistry.fromRaw(raw);
      } catch (caught) {
        return caught as DefError;
      }
      throw new Error('nemá byť platné');
    })();
    expect(error.defName).toBe('economy');
    expect(error.path.startsWith(`/${field}`)).toBe(true);
  });

  it.each(['urgencyFactor', 'arrivalDaysRange', 'volumeScaleRange', 'minCapacityHint', 'contractsPerTier', 'xpMultiplier', 'lateXpFactor', 'ledgerEntriesKept'])(
    'chýbajúce povinné pole economy.%s',
    (field) => {
      const raw = rawDefs();
      delete economy(raw)[field];
      expectDefError(() => DefRegistry.fromRaw(raw), 'economy', `/${field}`);
    },
  );

  it('arrivalDaysRange s hornou hranicou 0 hlási chybu na /arrivalDaysRange/1 (loď by prišla v ticku prijatia)', () => {
    const raw = rawDefs();
    economy(raw)['arrivalDaysRange'] = [0, 0];
    const error = expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/arrivalDaysRange/1');
    expect(error.problem).toContain('> 0');
  });

  it('rozsah v opačnom poradí → cesta celého rozsahu a správa min ≤ max', () => {
    const raw = rawDefs();
    economy(raw)['volumeScaleRange'] = [1.2, 0.4];
    const error = expectDefError(() => DefRegistry.fromRaw(raw), 'economy', '/volumeScaleRange');
    expect(error.problem).toContain('min ≤ max');
  });

  it('hranice: urgencyFactor 0, lateXpFactor 0 aj 1, arrivalDaysRange [0, 0.5] a [n, n] sú platné', () => {
    const raw = rawDefs();
    Object.assign(economy(raw), { urgencyFactor: 0, lateXpFactor: 0, arrivalDaysRange: [0, 0.5], volumeScaleRange: [1, 1] });
    expect(DefRegistry.fromRaw(raw).economy.lateXpFactor).toBe(0);
    economy(raw)['lateXpFactor'] = 1;
    expect(DefRegistry.fromRaw(raw).economy.lateXpFactor).toBe(1);
  });
});

describe('schéma (Ajv) ⇔ DefRegistry', () => {
  const validateTemplates = new Ajv2020({ allErrors: true }).compile(contractTemplatesSchema);
  const validateEconomy = new Ajv2020({ allErrors: true }).compile(economySchema);

  it('bundled contract_templates.json a economy.json prejdú schémou aj registry', () => {
    expect(validateTemplates(contractTemplatesJson)).toBe(true);
    expect(validateEconomy(economyJson)).toBe(true);
    expect(accepts(rawDefs())).toBe(true);
  });

  const TEMPLATE_VALUES: readonly (readonly [field: string, value: unknown])[] = [
    ['id', 'Bad Id'],
    ['cargoTypeId', ''],
    ['volumeUnitsRange', [0, 10]],
    ['volumeUnitsRange', [12.5, 48]],
    ['volumeUnitsRange', [12]],
    ['volumeUnitsRange', [12, 24, 48]],
    ['slaDaysRange', [1, 1]],
    ['slaDaysRange', [0, 3]],
    ['slaDaysRange', ['2', 3]],
    ['shipClassIds', []],
    ['shipClassIds', ['feeder', 'feeder']],
    ['shipClassIds', ['Feeder']],
    ['weight', 0],
    ['weight', 2.5],
    ['weight', 7],
    ['minTier', -1],
    ['minTier', 0.5],
    ['minTier', 3],
    ['extra', 1],
  ];

  it.each(TEMPLATE_VALUES)('šablóna %s = %j: schéma a registry sa zhodnú', (field, value) => {
    const raw = rawDefs();
    templatesOf(raw)[0]![field] = value;
    // Krížové kontroly (cargo, lode, kapacita) schéma nevyjadrí, preto sa porovnávajú len hodnoty, ktoré ich neporušujú.
    const registry = accepts(raw);
    const schema = validateTemplates(raw['contract_templates']);
    if (field === 'cargoTypeId' || field === 'shipClassIds') {
      // Neznáma vec, ktorú schéma povolí (platný snake_case), ale registry odmietne: registry nesmie byť voľnejšie.
      if (registry) expect(schema).toBe(true);
    } else {
      expect(registry).toBe(schema);
    }
  });

  const ECONOMY_VALUES: readonly (readonly [field: string, value: unknown])[] = [
    ['urgencyFactor', 0],
    ['urgencyFactor', -0.5],
    ['arrivalDaysRange', [0, 3]],
    ['arrivalDaysRange', [-1, 3]],
    ['arrivalDaysRange', [1]],
    ['arrivalDaysRange', [1, 2, 3]],
    ['volumeScaleRange', [0, 1]],
    ['volumeScaleRange', [0.01, 1]],
    ['minCapacityHint', 0],
    ['minCapacityHint', 1],
    ['contractsPerTier', 0],
    ['contractsPerTier', 1],
    ['xpMultiplier', 0],
    ['xpMultiplier', -1],
    ['lateXpFactor', 1],
    ['lateXpFactor', 1.01],
    ['ledgerEntriesKept', 0],
    ['ledgerEntriesKept', 1],
    ['ledgerEntriesKept', 1.5],
  ];

  it.each(ECONOMY_VALUES)('economy.%s = %j: schéma a registry sa zhodnú', (field, value) => {
    const raw = rawDefs();
    raw['economy']![field] = value;
    expect(accepts(raw)).toBe(validateEconomy(raw['economy']));
  });
});

describe('RangeSpec (def-spec)', () => {
  const spec = { kind: 'range', bound: { kind: 'integer', min: 1 } } as const;

  it.each([
    [[1, 1], true],
    [[1, 5], true],
    [[5, 1], false],
    [[0, 5], false],
    [[1.5, 5], false],
    [[1], false],
    [[1, 2, 3], false],
    [[], false],
    ['1,5', false],
    [null, false],
    [[1, null], false],
  ])('%j → platné: %s', (value, ok) => {
    expect(checkField(value, spec, '/r') === undefined).toBe(ok);
  });

  it('chyba prvku má cestu prvku, chyba poradia cestu rozsahu', () => {
    expect(checkField([0, 5], spec, '/r')?.path).toBe('/r/0');
    expect(checkField([1, 'x'], spec, '/r')?.path).toBe('/r/1');
    expect(checkField([5, 1], spec, '/r')?.path).toBe('/r');
  });
});
