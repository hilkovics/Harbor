// Katalógové defy F2 (ADR-009): cargo_types.json, modules.json, ships.json — hodnoty z karty T02-01, schémy
// (`additionalProperties: false`, params podľa kind), jedinečnosť id a väzba na assets/manifest.json + design/tokens.css.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DEFS_DIR, DEFAULT_SCHEMAS_DIR, validateDefsDir } from '../../tools/validate-defs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

function realDef(name: string): Json {
  return readJson(join(DEFAULT_DEFS_DIR, `${name}.json`));
}

function items(def: Json): Json[] {
  return def['items'] as Json[];
}

function item(def: Json, id: string): Json {
  const found = items(def).find((entry) => entry['id'] === id);
  if (found === undefined) throw new Error(`def nemá položku ${id}`);
  return found;
}

interface Manifest {
  sprites: Record<string, { footprint: { w: number; h: number }; connectors: unknown[] }>;
  entities: Record<string, { footprint: { w: number; h: number } }>;
}

const manifest = readJson(join(ROOT, 'assets', 'manifest.json')) as unknown as Manifest;

describe('skutočné katalógy F2', () => {
  it('cargo_types.json: container_teu podľa T02-01', () => {
    const def = realDef('cargo_types');
    expect(def['schemaVersion']).toBe(1);
    expect(items(def)).toEqual([
      {
        id: 'container_teu',
        category: 'container',
        unitName: 'TEU',
        unitsPerBatch: 1,
        basePricePerUnitCents: 45000,
        xpPerUnit: 1,
        colorToken: 'cargo-container',
      },
    ]);
  });

  it('modules.json: berth_standard a crane_container_gantry (ARCHITECTURE §5.3)', () => {
    const def = realDef('modules');
    expect(def['schemaVersion']).toBe(1);
    expect(items(def).map((entry) => entry['id'])).toEqual(['berth_standard', 'crane_container_gantry']);
    expect(item(def, 'berth_standard')).toEqual({
      id: 'berth_standard',
      kind: 'berth',
      displayName: 'Kotvisko',
      footprint: { w: 8, h: 3 },
      placement: { requiredTerrain: ['quay'], waterSide: 'north', requiresParcelOwnership: true },
      connectors: [
        { x: 1, y: 2, side: 's', type: 'road' },
        { x: 6, y: 2, side: 's', type: 'road' },
      ],
      costCents: 40_000_000,
      maintenancePerDayCents: 120_000,
      params: { depthClass: 1, apronSlots: 4, maxCranes: 2, frontWaterCells: 3 },
    });
    expect(item(def, 'crane_container_gantry')).toEqual({
      id: 'crane_container_gantry',
      kind: 'crane',
      displayName: 'Kontajnerový žeriav',
      footprint: { w: 2, h: 3 },
      placement: { requiredTerrain: ['quay'], requiresParcelOwnership: true, mustAttachTo: ['berth'] },
      connectors: [],
      costCents: 60_000_000,
      maintenancePerDayCents: 90_000,
      params: { cycleTicks: 12, category: 'container' },
    });
  });

  it('ships.json: feeder a handy (ARCHITECTURE §4.3)', () => {
    const def = realDef('ships');
    expect(def['schemaVersion']).toBe(1);
    const categories = ['container', 'bulk', 'liquid', 'gas', 'roro'];
    expect(items(def)).toEqual([
      {
        id: 'feeder',
        displayName: 'Feeder',
        lengthCells: 6,
        widthCells: 2,
        draftClass: 1,
        capacityUnits: 120,
        speedCellsPerTick: 0.15,
        cargoCategories: categories,
        berthAllowanceTicks: 17_280,
      },
      {
        id: 'handy',
        displayName: 'Handysize',
        lengthCells: 10,
        widthCells: 2,
        draftClass: 1,
        capacityUnits: 300,
        speedCellsPerTick: 0.15,
        cargoCategories: categories,
        berthAllowanceTicks: 17_280,
      },
    ]);
  });
});

describe('väzba na assets/manifest.json a design/tokens.css', () => {
  it.each(['berth_standard', 'crane_container_gantry'])('modul %s: footprint zodpovedá spritu v manifeste', (id) => {
    expect(item(realDef('modules'), id)['footprint']).toEqual(manifest.sprites[id]?.footprint);
  });

  it('berth_standard: konektory sú presne sprites.berth_standard.connectors', () => {
    expect(item(realDef('modules'), 'berth_standard')['connectors']).toEqual(manifest.sprites['berth_standard']?.connectors);
  });

  it('crane_container_gantry: konektory sú presne sprites.crane_container_gantry.connectors (prázdne)', () => {
    expect(item(realDef('modules'), 'crane_container_gantry')['connectors']).toEqual(
      manifest.sprites['crane_container_gantry']?.connectors,
    );
  });

  it.each(['feeder', 'handy'])('loď %s: widthCells × lengthCells = entities.ship_%s.footprint (w × h)', (id) => {
    const ship = item(realDef('ships'), id);
    expect(manifest.entities[`ship_${id}`]?.footprint).toEqual({ w: ship['widthCells'], h: ship['lengthCells'] });
  });

  it('colorToken každého nákladu je definovaný v design/tokens.css', () => {
    const css = readFileSync(join(ROOT, 'design', 'tokens.css'), 'utf8');
    for (const cargo of items(realDef('cargo_types'))) {
      expect(css, String(cargo['id'])).toMatch(new RegExp(`--${String(cargo['colorToken'])}\\s*:`));
    }
  });
});

describe('schémy katalógov (validateDefsDir)', () => {
  let tmpRoot: string;
  let defsDir: string;

  const write = (name: string, value: unknown): void => {
    writeFileSync(join(defsDir, `${name}.json`), JSON.stringify(value, null, 2));
  };
  const errorsFor = (name: string): string[] => {
    const result = validateDefsDir(defsDir, DEFAULT_SCHEMAS_DIR).find((entry) => entry.file === `${name}.json`);
    if (result === undefined) throw new Error(`žiadny výsledok pre ${name}.json`);
    return result.errors;
  };
  /** Zapíše upravenú kópiu skutočného defu a vráti chyby. */
  const errorsAfter = (name: string, mutate: (def: Json) => void): string[] => {
    const def = structuredClone(realDef(name));
    mutate(def);
    write(name, def);
    return errorsFor(name);
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'catalog-defs-'));
    defsDir = join(tmpRoot, 'defs');
    mkdirSync(defsDir);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skutočné katalógy prejdú svojou schémou', () => {
    for (const name of ['cargo_types', 'modules', 'ships']) {
      expect(errorsAfter(name, () => undefined), name).toEqual([]);
    }
  });

  describe.each(['cargo_types', 'modules', 'ships'])('%s: spoločné pravidlá katalógu', (name) => {
    it('chýbajúci items', () => {
      expect(errorsAfter(name, (def) => void delete def['items'])).toEqual([`${name}.json: / must have required property 'items'`]);
    });

    it('prázdny items', () => {
      expect(errorsAfter(name, (def) => void (def['items'] = []))).toEqual([`${name}.json: /items must NOT have fewer than 1 items`]);
    });

    it('nesprávny schemaVersion', () => {
      expect(errorsAfter(name, (def) => void (def['schemaVersion'] = 2))).toEqual([
        `${name}.json: /schemaVersion must be equal to constant`,
      ]);
    });

    it('neznámy kľúč v koreni', () => {
      const errors = errorsAfter(name, (def) => void (def['note'] = 'x'));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(new RegExp(`^${name}\\.json: / must NOT have additional properties`));
      expect(errors[0]).toContain('note');
    });

    it('neznámy kľúč v položke', () => {
      const errors = errorsAfter(name, (def) => void (items(def)[0]!['colour'] = 'red'));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(new RegExp(`^${name}\\.json: /items/0 must NOT have additional properties`));
      expect(errors[0]).toContain('colour');
    });

    it('id nie je snake_case', () => {
      expect(errorsAfter(name, (def) => void (items(def)[0]!['id'] = 'Bad-Id'))).toEqual([
        `${name}.json: /items/0/id must match pattern "^[a-z][a-z0-9_]*$"`,
      ]);
    });

    it('duplicitné id → chyba na druhej položke s odkazom na prvú', () => {
      const errors = errorsAfter(name, (def) => void items(def).push(structuredClone(items(def)[0]!)));
      const second = items(realDef(name)).length;
      const id = String(items(realDef(name))[0]!['id']);
      expect(errors).toEqual([`${name}.json: /items/${String(second)}/id duplicitné id '${id}' (/items/0/id)`]);
    });
  });

  describe('cargo_types.json', () => {
    it.each([
      ['category', 'grain', '/items/0/category must be equal to one of the allowed values'],
      ['unitsPerBatch', 0, '/items/0/unitsPerBatch must be >= 1'],
      ['unitsPerBatch', 1.5, '/items/0/unitsPerBatch must be integer'],
      ['basePricePerUnitCents', -1, '/items/0/basePricePerUnitCents must be >= 0'],
      ['xpPerUnit', -0.5, '/items/0/xpPerUnit must be >= 0'],
      ['unitName', '', '/items/0/unitName must NOT have fewer than 1 characters'],
      ['colorToken', '--cargo-container', '/items/0/colorToken must match pattern "^[a-z][a-z0-9-]*$"'],
    ])('%s = %j', (field, value, message) => {
      expect(errorsAfter('cargo_types', (def) => void (items(def)[0]![field] = value))).toEqual([`cargo_types.json: ${message}`]);
    });

    it('chýbajúce povinné pole', () => {
      expect(errorsAfter('cargo_types', (def) => void delete items(def)[0]!['colorToken'])).toEqual([
        "cargo_types.json: /items/0 must have required property 'colorToken'",
      ]);
    });
  });

  describe('ships.json', () => {
    it.each([
      ['lengthCells', 0, '/items/0/lengthCells must be >= 1'],
      ['widthCells', 2.5, '/items/0/widthCells must be integer'],
      ['draftClass', 4, '/items/0/draftClass must be equal to one of the allowed values'],
      ['capacityUnits', 0, '/items/0/capacityUnits must be >= 1'],
      ['speedCellsPerTick', 0, '/items/0/speedCellsPerTick must be > 0'],
      ['speedCellsPerTick', '0.15', '/items/0/speedCellsPerTick must be number'],
      ['berthAllowanceTicks', 0, '/items/0/berthAllowanceTicks must be >= 1'],
      ['cargoCategories', [], '/items/0/cargoCategories must NOT have fewer than 1 items'],
      ['cargoCategories', ['container', 'container'], '/items/0/cargoCategories must NOT have duplicate items (items ## 0 and 1 are identical)'],
      ['cargoCategories', ['coal'], '/items/0/cargoCategories/0 must be equal to one of the allowed values'],
    ])('%s = %j', (field, value, message) => {
      expect(errorsAfter('ships', (def) => void (items(def)[0]![field] = value))).toEqual([`ships.json: ${message}`]);
    });

    it('techRequired je voliteľné (snake_case id)', () => {
      expect(errorsAfter('ships', (def) => void (items(def)[1]!['techRequired'] = 'ship_handy'))).toEqual([]);
      expect(errorsAfter('ships', (def) => void (items(def)[1]!['techRequired'] = 'Handy'))).toEqual([
        'ships.json: /items/1/techRequired must match pattern "^[a-z][a-z0-9_]*$"',
      ]);
    });
  });

  describe('modules.json', () => {
    const berth = (def: Json): Json => item(def, 'berth_standard');
    const crane = (def: Json): Json => item(def, 'crane_container_gantry');
    const params = (entry: Json): Json => entry['params'] as Json;
    const placement = (entry: Json): Json => entry['placement'] as Json;

    it.each([
      ['kind', 'ferry', '/items/0/kind must be equal to one of the allowed values'],
      ['footprint', { w: 0, h: 3 }, '/items/0/footprint/w must be >= 1'],
      ['costCents', -1, '/items/0/costCents must be >= 0'],
      ['maintenancePerDayCents', 1.5, '/items/0/maintenancePerDayCents must be integer'],
      ['displayName', '', '/items/0/displayName must NOT have fewer than 1 characters'],
    ])('%s = %j', (field, value, message) => {
      expect(errorsAfter('modules', (def) => void (berth(def)[field] = value))).toEqual([`modules.json: ${message}`]);
    });

    it('placement: neznámy terén, prázdny requiredTerrain, neznáme mustAttachTo, waterSide', () => {
      expect(errorsAfter('modules', (def) => void (placement(berth(def))['requiredTerrain'] = ['lava']))).toEqual([
        'modules.json: /items/0/placement/requiredTerrain/0 must be equal to one of the allowed values',
      ]);
      expect(errorsAfter('modules', (def) => void (placement(berth(def))['requiredTerrain'] = []))).toEqual([
        'modules.json: /items/0/placement/requiredTerrain must NOT have fewer than 1 items',
      ]);
      expect(errorsAfter('modules', (def) => void (placement(crane(def))['mustAttachTo'] = ['dock']))).toEqual([
        'modules.json: /items/1/placement/mustAttachTo/0 must be equal to one of the allowed values',
      ]);
      expect(errorsAfter('modules', (def) => void (placement(berth(def))['waterSide'] = 'south'))).toEqual([
        'modules.json: /items/0/placement/waterSide must be equal to one of the allowed values',
      ]);
    });

    it('berth bez waterSide', () => {
      expect(errorsAfter('modules', (def) => void delete placement(berth(def))['waterSide'])).toEqual([
        "modules.json: /items/0/placement must have required property 'waterSide'",
      ]);
    });

    it('konektor: zlá strana, zlý typ, chýbajúce pole, neznáme pole', () => {
      const connector = (def: Json): Json => (berth(def)['connectors'] as Json[])[0]!;
      expect(errorsAfter('modules', (def) => void (connector(def)['side'] = 'up'))).toEqual([
        'modules.json: /items/0/connectors/0/side must be equal to one of the allowed values',
      ]);
      expect(errorsAfter('modules', (def) => void (connector(def)['type'] = 'berth_edge'))).toEqual([
        'modules.json: /items/0/connectors/0/type must be equal to one of the allowed values',
      ]);
      expect(errorsAfter('modules', (def) => void delete connector(def)['y'])).toEqual([
        "modules.json: /items/0/connectors/0 must have required property 'y'",
      ]);
      const unknown = errorsAfter('modules', (def) => void (connector(def)['z'] = 0));
      expect(unknown).toHaveLength(1);
      expect(unknown[0]).toContain('/items/0/connectors/0 must NOT have additional properties');
    });

    describe('params podľa kind', () => {
      it.each([
        ['depthClass', 4, '/items/0/params/depthClass must be equal to one of the allowed values'],
        ['apronSlots', 0, '/items/0/params/apronSlots must be >= 1'],
        ['maxCranes', 1.5, '/items/0/params/maxCranes must be integer'],
        ['frontWaterCells', '3', '/items/0/params/frontWaterCells must be integer'],
      ])('berth %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(berth(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it.each([
        ['cycleTicks', 1, '/items/1/params/cycleTicks must be >= 2'],
        ['cycleTicks', 'fast', '/items/1/params/cycleTicks must be integer'],
        ['category', 'coal', '/items/1/params/category must be equal to one of the allowed values'],
      ])('crane %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(crane(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it('berth: chýbajúci a neznámy parameter', () => {
        expect(errorsAfter('modules', (def) => void delete params(berth(def))['maxCranes'])).toEqual([
          "modules.json: /items/0/params must have required property 'maxCranes'",
        ]);
        const unknown = errorsAfter('modules', (def) => void (params(berth(def))['cycleTicks'] = 12));
        expect(unknown).toHaveLength(1);
        expect(unknown[0]).toContain('/items/0/params must NOT have additional properties');
        expect(unknown[0]).toContain('cycleTicks');
      });

      it('crane s parametrami berthu je chyba (params sa riadia kind-om, nie tvarom)', () => {
        const errors = errorsAfter('modules', (def) => void (crane(def)['params'] = { ...params(berth(def)) }));
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every((line) => line.startsWith('modules.json: /items/1/params'))).toBe(true);
      });

      it('kind bez typovaných parametrov (storage) musí mať params {}', () => {
        const withStorage = (extra: Json) => (def: Json): void => {
          const storage = structuredClone(crane(def));
          Object.assign(storage, { id: 'yard_test', kind: 'storage', params: extra });
          delete placement(storage)['mustAttachTo'];
          items(def).push(storage);
        };
        expect(errorsAfter('modules', withStorage({}))).toEqual([]);
        const errors = errorsAfter('modules', withStorage({ capacityUnits: 64 }));
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('/items/2/params must NOT have more than 0 properties');
      });
    });
  });
});
