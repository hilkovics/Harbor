// Katalógové defy F2 až F4 (ADR-009): cargo_types.json, modules.json, ships.json, vehicles.json, trucks.json a konfiguračný
// logistics.json — hodnoty z kariet T02-01, T03-01 a T04-01, schémy (`additionalProperties: false`, params podľa kind),
// jedinečnosť id a väzba na assets/manifest.json + design/tokens.css.
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
  sprites: Record<
    string,
    {
      footprint: { w: number; h: number };
      connectors: unknown[];
      slots?: number;
      layers?: number;
      stalls?: unknown[] | number;
      docks?: unknown[];
    }
  >;
  entities: Record<string, { footprint: { w: number; h: number } }>;
}

const manifest = readJson(join(ROOT, 'assets', 'manifest.json')) as unknown as Manifest;

describe('skutočné katalógy F2 až F4', () => {
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
        exportPricePerUnitCents: 40000,
        repositioningPricePerUnitCents: 12000,
        transhipPricePerUnitCents: 28000,
        xpPerUnit: 1,
        colorToken: 'cargo-container',
      },
    ]);
  });

  it('modules.json: berth, žeriav, kontajnerový dvor, depo, brána, čakacia plocha, rampa (ARCHITECTURE §5.3) a depo prázdnych (ADR-034)', () => {
    const def = realDef('modules');
    expect(def['schemaVersion']).toBe(1);
    expect(items(def).map((entry) => entry['id'])).toEqual([
      'berth_standard',
      'crane_container_gantry',
      'container_yard_small',
      'vehicle_depot',
      'truck_gate',
      'truck_waiting_area',
      'loading_ramp_container',
      'empty_depot',
    ]);
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
      params: { depthClass: 1, apronSlots: 8, maxCranes: 2, frontWaterCells: 3, apronReserveSlots: 2, handoverMode: 'under_hook', craneBufferSlots: 1 },
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
      params: { cycleTicks: 12, category: 'container', wagePerDayCents: 25000, dualCycleFactor: 1.5 },
    });
    expect(item(def, 'container_yard_small')).toEqual({
      id: 'container_yard_small',
      kind: 'storage',
      displayName: 'Kontajnerový dvor S',
      footprint: { w: 4, h: 4 },
      placement: { requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true },
      connectors: [{ x: 1, y: 3, side: 's', type: 'road' }],
      costCents: 15_000_000,
      maintenancePerDayCents: 30_000,
      params: { capacityUnits: 64, category: 'container' },
    });
    expect(item(def, 'vehicle_depot')).toEqual({
      id: 'vehicle_depot',
      kind: 'depot',
      displayName: 'Depo vozidiel',
      footprint: { w: 3, h: 3 },
      placement: { requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true },
      connectors: [{ x: 1, y: 2, side: 's', type: 'road' }],
      costCents: 9_000_000,
      maintenancePerDayCents: 15_000,
      params: { capacity: 10 },
    });
    expect(item(def, 'truck_gate')).toEqual({
      id: 'truck_gate',
      kind: 'gate',
      displayName: 'Brána kamiónov',
      footprint: { w: 2, h: 2 },
      placement: { requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true },
      connectors: [
        { x: 0, y: 0, side: 'n', type: 'road' },
        { x: 0, y: 1, side: 's', type: 'road' },
      ],
      costCents: 8_000_000,
      maintenancePerDayCents: 15_000,
      params: { processTicks: 18 },
    });
    expect(item(def, 'truck_waiting_area')).toEqual({
      id: 'truck_waiting_area',
      kind: 'waiting_area',
      displayName: 'Čakacia plocha',
      footprint: { w: 4, h: 3 },
      placement: { requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true },
      connectors: [
        { x: 0, y: 2, side: 'w', type: 'road' },
        { x: 3, y: 2, side: 'e', type: 'road' },
      ],
      costCents: 6_000_000,
      maintenancePerDayCents: 10_000,
      params: { bays: 6 },
    });
    expect(item(def, 'loading_ramp_container')).toEqual({
      id: 'loading_ramp_container',
      kind: 'ramp',
      displayName: 'Rampa · kontajnery',
      footprint: { w: 4, h: 2 },
      placement: { requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true },
      connectors: [
        { x: 1, y: 1, side: 's', type: 'road' },
        { x: 2, y: 1, side: 's', type: 'road' },
      ],
      costCents: 10_000_000,
      maintenancePerDayCents: 20_000,
      params: { docks: 2, stagingPerDock: 4, loadTicksPerUnit: 6, category: 'container' },
    });
  });

  it('trucks.json: truck_container (ARCHITECTURE §4.2, §7.5)', () => {
    const def = realDef('trucks');
    expect(def['schemaVersion']).toBe(1);
    expect(items(def)).toEqual([
      {
        id: 'truck_container',
        displayName: 'Kamión kontajnerový',
        capacityUnits: 1,
        speedCellsPerTick: 0.6,
        cargoCategories: ['container'],
      },
    ]);
  });

  it('vehicles.json: straddle_carrier (ARCHITECTURE §4.4) a empty_handler (ADR-034)', () => {
    const def = realDef('vehicles');
    expect(def['schemaVersion']).toBe(1);
    expect(items(def)).toEqual([
      {
        id: 'straddle_carrier',
        displayName: 'Straddle carrier',
        capacityUnits: 1,
        speedCellsPerTick: 0.4,
        loadTicks: 3,
        unloadTicks: 3,
        cargoCategories: ['container'],
        purchaseCents: 4_800_000,
        wagePerDayCents: 18_000,
      },
      {
        id: 'empty_handler',
        displayName: 'Empty handler',
        capacityUnits: 1,
        speedCellsPerTick: 0.5,
        loadTicks: 2,
        unloadTicks: 2,
        cargoCategories: ['container'],
        cargoDirections: ['empty'],
        purchaseCents: 3_600_000,
        wagePerDayCents: 14_000,
      },
    ]);
  });

  it('logistics.json: konštanty z ARCHITECTURE §4.6 (ADR-010)', () => {
    expect(realDef('logistics')).toEqual({
      schemaVersion: 1,
      defaultInternalTicks: 6,
      repathIntervalTicks: 30,
      congestion: { trafficDecayPerHour: 0.9, slowdownPerExtraVehicle: 0.25, penaltyTrafficDivisor: 200, penaltyMax: 3 },
      shipNavigation: { approachMarginCells: 1, sweepStepCells: 0.5, turnManeuvers: 1, sidewaysManeuvers: 1 },
      exportFlow: { arrivalWindowDays: 2, vgmMissingChance: 0.05, vgmHoldHours: 6, weightClassShares: { light: 0.3, medium: 0.5, heavy: 0.2 } },
      emptyFlow: {
        hinterlandDaysRange: [1, 3],
        emptyReturnRate: 0.6,
        damageChance: 0.08,
        repairHours: 6,
        emptyPickupRate: 0.4,
        emptyPickupLeadHoursRange: [4, 12],
        emptyPickupMaxWaitHours: 6,
      },
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
        lashingTicksPerUnit: 6,
        paperworkTicks: 360,
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
        lashingTicksPerUnit: 6,
        paperworkTicks: 540,
      },
    ]);
  });
});

describe('väzba na assets/manifest.json a design/tokens.css', () => {
  it.each([
    'berth_standard',
    'crane_container_gantry',
    'container_yard_small',
    'vehicle_depot',
    'truck_gate',
    'truck_waiting_area',
    'loading_ramp_container',
  ])(
    'modul %s: footprint zodpovedá spritu v manifeste',
    (id) => {
      expect(item(realDef('modules'), id)['footprint']).toEqual(manifest.sprites[id]?.footprint);
    },
  );

  it.each(['container_yard_small', 'vehicle_depot', 'truck_gate', 'truck_waiting_area', 'loading_ramp_container'])('modul %s: konektory sú presne sprites.%s.connectors', (id) => {
    expect(item(realDef('modules'), id)['connectors']).toEqual(manifest.sprites[id]?.connectors);
  });

  it('container_yard_small: params.capacityUnits = sprites.container_yard_small.slots × layers (32 × 2 = 64)', () => {
    const sprite = manifest.sprites['container_yard_small'];
    expect(sprite?.slots).toBe(32);
    expect(sprite?.layers).toBe(2);
    const params = item(realDef('modules'), 'container_yard_small')['params'] as Json;
    expect(params['capacityUnits']).toBe((sprite?.slots ?? 0) * (sprite?.layers ?? 0));
  });

  it('vehicle_depot: params.capacity = sprites.vehicle_depot.stalls (10)', () => {
    const sprite = manifest.sprites['vehicle_depot'];
    expect(sprite?.stalls).toBe(10);
    const params = item(realDef('modules'), 'vehicle_depot')['params'] as Json;
    expect(params['capacity']).toBe(sprite?.stalls);
  });

  it('truck_waiting_area: params.bays = počet sprites.truck_waiting_area.stalls (6)', () => {
    const stalls = manifest.sprites['truck_waiting_area']?.stalls;
    expect(Array.isArray(stalls)).toBe(true);
    expect((stalls as unknown[]).length).toBe(6);
    const params = item(realDef('modules'), 'truck_waiting_area')['params'] as Json;
    expect(params['bays']).toBe((stalls as unknown[]).length);
  });

  it('loading_ramp_container: params.docks = počet sprites.loading_ramp_container.docks (2)', () => {
    const docks = manifest.sprites['loading_ramp_container']?.docks;
    expect(Array.isArray(docks)).toBe(true);
    expect(docks?.length).toBe(2);
    const params = item(realDef('modules'), 'loading_ramp_container')['params'] as Json;
    expect(params['docks']).toBe(docks?.length);
  });

  it('truck_gate: konektory (0,0,n) a (0,1,s) tvoria priechod (jeden stĺpec, opačné strany)', () => {
    const connectors = item(realDef('modules'), 'truck_gate')['connectors'] as { x: number; y: number; side: string }[];
    expect(connectors.map(({ x, y, side }) => [x, y, side])).toEqual([
      [0, 0, 'n'],
      [0, 1, 's'],
    ]);
  });

  it.each(['truck_container'])('kamión %s má entitu entities.%s (1×2) v manifeste', (id) => {
    expect(items(realDef('trucks')).map((entry) => entry['id'])).toContain(id);
    expect(manifest.entities[id]?.footprint).toEqual({ w: 1, h: 2 });
  });

  it.each(['straddle_carrier'])('vozidlo %s má entitu entities.%s v manifeste', (id) => {
    expect(items(realDef('vehicles')).map((entry) => entry['id'])).toContain(id);
    expect(manifest.entities[id]?.footprint).toEqual({ w: 1, h: 1 });
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
    for (const name of ['cargo_types', 'modules', 'ships', 'vehicles', 'trucks', 'logistics']) {
      expect(errorsAfter(name, () => undefined), name).toEqual([]);
    }
  });

  describe.each(['cargo_types', 'modules', 'ships', 'vehicles', 'trucks'])('%s: spoločné pravidlá katalógu', (name) => {
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

  describe('vehicles.json', () => {
    it.each([
      ['displayName', '', '/items/0/displayName must NOT have fewer than 1 characters'],
      ['capacityUnits', 0, '/items/0/capacityUnits must be >= 1'],
      ['capacityUnits', 1.5, '/items/0/capacityUnits must be integer'],
      ['speedCellsPerTick', 0, '/items/0/speedCellsPerTick must be > 0'],
      ['speedCellsPerTick', '0.4', '/items/0/speedCellsPerTick must be number'],
      ['loadTicks', 0, '/items/0/loadTicks must be >= 1'],
      ['loadTicks', 2.5, '/items/0/loadTicks must be integer'],
      ['unloadTicks', 0, '/items/0/unloadTicks must be >= 1'],
      ['cargoCategories', [], '/items/0/cargoCategories must NOT have fewer than 1 items'],
      ['cargoCategories', ['container', 'container'], '/items/0/cargoCategories must NOT have duplicate items (items ## 0 and 1 are identical)'],
      ['cargoCategories', ['coal'], '/items/0/cargoCategories/0 must be equal to one of the allowed values'],
      ['purchaseCents', -1, '/items/0/purchaseCents must be >= 0'],
      ['purchaseCents', 1.5, '/items/0/purchaseCents must be integer'],
      ['wagePerDayCents', -1, '/items/0/wagePerDayCents must be >= 0'],
      ['wagePerDayCents', '18000', '/items/0/wagePerDayCents must be integer'],
    ])('%s = %j', (field, value, message) => {
      expect(errorsAfter('vehicles', (def) => void (items(def)[0]![field] = value))).toEqual([`vehicles.json: ${message}`]);
    });

    it('chýbajúce povinné polia', () => {
      for (const field of ['displayName', 'capacityUnits', 'speedCellsPerTick', 'loadTicks', 'unloadTicks', 'cargoCategories', 'purchaseCents', 'wagePerDayCents']) {
        expect(errorsAfter('vehicles', (def) => void delete items(def)[0]![field]), field).toEqual([
          `vehicles.json: /items/0 must have required property '${field}'`,
        ]);
      }
    });

    it('techRequired je voliteľné (snake_case id)', () => {
      expect(errorsAfter('vehicles', (def) => void (items(def)[0]!['techRequired'] = 'automation_1'))).toEqual([]);
      expect(errorsAfter('vehicles', (def) => void (items(def)[0]!['techRequired'] = 'Automation 1'))).toEqual([
        'vehicles.json: /items/0/techRequired must match pattern "^[a-z][a-z0-9_]*$"',
      ]);
    });
  });

  describe('trucks.json', () => {
    it.each([
      ['displayName', '', '/items/0/displayName must NOT have fewer than 1 characters'],
      ['capacityUnits', 0, '/items/0/capacityUnits must be >= 1'],
      ['capacityUnits', 1.5, '/items/0/capacityUnits must be integer'],
      ['speedCellsPerTick', 0, '/items/0/speedCellsPerTick must be > 0'],
      ['speedCellsPerTick', '0.6', '/items/0/speedCellsPerTick must be number'],
      ['cargoCategories', [], '/items/0/cargoCategories must NOT have fewer than 1 items'],
      ['cargoCategories', ['container', 'container'], '/items/0/cargoCategories must NOT have duplicate items (items ## 0 and 1 are identical)'],
      ['cargoCategories', ['coal'], '/items/0/cargoCategories/0 must be equal to one of the allowed values'],
    ])('%s = %j', (field, value, message) => {
      expect(errorsAfter('trucks', (def) => void (items(def)[0]![field] = value))).toEqual([`trucks.json: ${message}`]);
    });

    it('chýbajúce povinné polia', () => {
      for (const field of ['displayName', 'capacityUnits', 'speedCellsPerTick', 'cargoCategories']) {
        expect(errorsAfter('trucks', (def) => void delete items(def)[0]![field]), field).toEqual([
          `trucks.json: /items/0 must have required property '${field}'`,
        ]);
      }
    });

    it('polia vozidla (nákup, mzda, load/unload, techRequired) kamión nemá — sú neznáme kľúče', () => {
      for (const field of ['purchaseCents', 'wagePerDayCents', 'loadTicks', 'unloadTicks', 'techRequired']) {
        const errors = errorsAfter('trucks', (def) => void (items(def)[0]![field] = 1));
        expect(errors, field).toHaveLength(1);
        expect(errors[0]).toMatch(/^trucks\.json: \/items\/0 must NOT have additional properties/);
        expect(errors[0]).toContain(field);
      }
    });
  });

  describe('logistics.json', () => {
    const congestion = (def: Json): Json => def['congestion'] as Json;

    it.each([
      ['defaultInternalTicks', -1, '/defaultInternalTicks must be >= 0'],
      ['defaultInternalTicks', 1.5, '/defaultInternalTicks must be integer'],
      ['repathIntervalTicks', 0, '/repathIntervalTicks must be >= 1'],
      ['repathIntervalTicks', '30', '/repathIntervalTicks must be integer'],
    ])('%s = %j', (field, value, message) => {
      expect(errorsAfter('logistics', (def) => void (def[field] = value))).toEqual([`logistics.json: ${message}`]);
    });

    it.each([
      ['trafficDecayPerHour', 1.5, '/congestion/trafficDecayPerHour must be <= 1'],
      ['trafficDecayPerHour', -0.1, '/congestion/trafficDecayPerHour must be >= 0'],
      ['slowdownPerExtraVehicle', -0.25, '/congestion/slowdownPerExtraVehicle must be >= 0'],
      ['penaltyTrafficDivisor', 0, '/congestion/penaltyTrafficDivisor must be > 0'],
      ['penaltyMax', -1, '/congestion/penaltyMax must be >= 0'],
      ['penaltyMax', '3', '/congestion/penaltyMax must be number'],
    ])('congestion.%s = %j', (field, value, message) => {
      expect(errorsAfter('logistics', (def) => void (congestion(def)[field] = value))).toEqual([`logistics.json: ${message}`]);
    });

    it.each([
      ['defaultInternalTicks'],
      ['repathIntervalTicks'],
      ['congestion'],
    ])('chýbajúce povinné pole %s', (field) => {
      expect(errorsAfter('logistics', (def) => void delete def[field])).toEqual([
        `logistics.json: / must have required property '${field}'`,
      ]);
    });

    it('chýbajúce pole v congestion', () => {
      expect(errorsAfter('logistics', (def) => void delete congestion(def)['penaltyMax'])).toEqual([
        "logistics.json: /congestion must have required property 'penaltyMax'",
      ]);
    });

    it('neznámy kľúč v koreni aj v congestion', () => {
      const root = errorsAfter('logistics', (def) => void (def['note'] = 'x'));
      expect(root).toHaveLength(1);
      expect(root[0]).toMatch(/^logistics\.json: \/ must NOT have additional properties/);
      const nested = errorsAfter('logistics', (def) => void (congestion(def)['bonus'] = 1));
      expect(nested).toHaveLength(1);
      expect(nested[0]).toContain('/congestion must NOT have additional properties');
    });

    it('nesprávny schemaVersion', () => {
      expect(errorsAfter('logistics', (def) => void (def['schemaVersion'] = 2))).toEqual([
        'logistics.json: /schemaVersion must be equal to constant',
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
        ['apronReserveSlots', -1, '/items/0/params/apronReserveSlots must be >= 0'],
        ['apronReserveSlots', 1.5, '/items/0/params/apronReserveSlots must be integer'],
        ['handoverMode', 'hook', '/items/0/params/handoverMode must be equal to one of the allowed values'],
        ['craneBufferSlots', 2, '/items/0/params/craneBufferSlots must be <= 1'],
        ['craneBufferSlots', -1, '/items/0/params/craneBufferSlots must be >= 0'],
        ['craneBufferSlots', 0.5, '/items/0/params/craneBufferSlots must be integer'],
      ])('berth %s = %j', (field, value, message) => {
        // `apronSlots = 0` dá aj vzťah rezervy (⌊0 / 2⌋ = 0) a buffera, preto sa nulujú — kontrola vzťahov má vlastný test.
        const mutate = (def: Json): void => {
          params(berth(def))[field] = value;
          if (field === 'apronSlots') {
            params(berth(def))['apronReserveSlots'] = 0;
            params(berth(def))['craneBufferSlots'] = 0;
          }
        };
        expect(errorsAfter('modules', mutate)).toEqual([`modules.json: ${message}`]);
      });

      it('berth: rezerva apronu nad ⌊apronSlots / 2⌋ → chyba vzťahu polí', () => {
        expect(errorsAfter('modules', (def) => void (params(berth(def))['apronReserveSlots'] = 5))).toEqual([
          'modules.json: /items/0/params/apronReserveSlots musí byť ≤ ⌊apronSlots / 2⌋ (4), dostal 5',
        ]);
        expect(errorsAfter('modules', (def) => void (params(berth(def))['apronReserveSlots'] = 4))).toEqual([]);
      });

      it('berth: buffer apronu na žeriav × maxCranes nad apronSlots → chyba vzťahu polí', () => {
        const tight = (def: Json): void => {
          params(berth(def))['apronSlots'] = 2;
          params(berth(def))['apronReserveSlots'] = 1;
          params(berth(def))['craneBufferSlots'] = 1;
        };
        expect(errorsAfter('modules', tight)).toEqual([]);
        expect(errorsAfter('modules', (def) => (tight(def), void (params(berth(def))['maxCranes'] = 3)))).toEqual([
          'modules.json: /items/0/params/craneBufferSlots craneBufferSlots × maxCranes (3) musí byť ≤ apronSlots (2)',
        ]);
      });

      it.each([
        ['dualCycleFactor', 0.9, '/items/1/params/dualCycleFactor must be >= 1'],
        ['dualCycleFactor', 2.5, '/items/1/params/dualCycleFactor must be <= 2'],
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

      const yard = (def: Json): Json => item(def, 'container_yard_small');
      const depot = (def: Json): Json => item(def, 'vehicle_depot');

      it.each([
        ['capacityUnits', 0, '/items/2/params/capacityUnits must be >= 1'],
        ['capacityUnits', 64.5, '/items/2/params/capacityUnits must be integer'],
        ['capacityUnits', '64', '/items/2/params/capacityUnits must be integer'],
        ['category', 'coal', '/items/2/params/category must be equal to one of the allowed values'],
        ['internalTicks', -1, '/items/2/params/internalTicks must be >= 0'],
        ['internalTicks', 2.5, '/items/2/params/internalTicks must be integer'],
      ])('storage %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(yard(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it.each([
        ['capacity', 0, '/items/3/params/capacity must be >= 1'],
        ['capacity', 6.5, '/items/3/params/capacity must be integer'],
        ['capacity', '6', '/items/3/params/capacity must be integer'],
        ['internalTicks', -1, '/items/3/params/internalTicks must be >= 0'],
        ['internalTicks', 0.5, '/items/3/params/internalTicks must be integer'],
      ])('depot %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(depot(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it('storage a depot: chýbajúci povinný parameter', () => {
        expect(errorsAfter('modules', (def) => void delete params(yard(def))['category'])).toEqual([
          "modules.json: /items/2/params must have required property 'category'",
        ]);
        expect(errorsAfter('modules', (def) => void delete params(depot(def))['capacity'])).toEqual([
          "modules.json: /items/3/params must have required property 'capacity'",
        ]);
      });

      it('storage a depot: internalTicks je voliteľné (0 je platné), cudzí parameter je chyba', () => {
        expect(errorsAfter('modules', (def) => void (params(yard(def))['internalTicks'] = 0))).toEqual([]);
        expect(errorsAfter('modules', (def) => void (params(depot(def))['internalTicks'] = 10))).toEqual([]);
        const unknownInYard = errorsAfter('modules', (def) => void (params(yard(def))['capacity'] = 6));
        expect(unknownInYard).toHaveLength(1);
        expect(unknownInYard[0]).toContain('/items/2/params must NOT have additional properties');
        const unknownInDepot = errorsAfter('modules', (def) => void (params(depot(def))['capacityUnits'] = 64));
        expect(unknownInDepot).toHaveLength(1);
        expect(unknownInDepot[0]).toContain('/items/3/params must NOT have additional properties');
      });

      it('storage a depot s params {} už schéma odmietne (povinné parametre)', () => {
        expect(errorsAfter('modules', (def) => void (yard(def)['params'] = {}))).toEqual([
          "modules.json: /items/2/params must have required property 'capacityUnits'",
          "modules.json: /items/2/params must have required property 'category'",
        ]);
        expect(errorsAfter('modules', (def) => void (depot(def)['params'] = {}))).toEqual([
          "modules.json: /items/3/params must have required property 'capacity'",
        ]);
      });

      const gate = (def: Json): Json => item(def, 'truck_gate');
      const waiting = (def: Json): Json => item(def, 'truck_waiting_area');
      const ramp = (def: Json): Json => item(def, 'loading_ramp_container');

      it.each([
        ['processTicks', 0, '/items/4/params/processTicks must be >= 1'],
        ['processTicks', 18.5, '/items/4/params/processTicks must be integer'],
        ['processTicks', '18', '/items/4/params/processTicks must be integer'],
        ['internalTicks', -1, '/items/4/params/internalTicks must be >= 0'],
        ['internalTicks', 2.5, '/items/4/params/internalTicks must be integer'],
      ])('gate %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(gate(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it.each([
        ['bays', 0, '/items/5/params/bays must be >= 1'],
        ['bays', 6.5, '/items/5/params/bays must be integer'],
        ['bays', '6', '/items/5/params/bays must be integer'],
        ['internalTicks', -1, '/items/5/params/internalTicks must be >= 0'],
        ['internalTicks', 0.5, '/items/5/params/internalTicks must be integer'],
      ])('waiting_area %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(waiting(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it.each([
        ['docks', 0, '/items/6/params/docks must be >= 1'],
        ['docks', 2.5, '/items/6/params/docks must be integer'],
        ['stagingPerDock', 0, '/items/6/params/stagingPerDock must be >= 1'],
        ['loadTicksPerUnit', 0, '/items/6/params/loadTicksPerUnit must be >= 1'],
        ['loadTicksPerUnit', '6', '/items/6/params/loadTicksPerUnit must be integer'],
        ['category', 'coal', '/items/6/params/category must be equal to one of the allowed values'],
        ['internalTicks', -1, '/items/6/params/internalTicks must be >= 0'],
      ])('ramp %s = %j', (field, value, message) => {
        expect(errorsAfter('modules', (def) => void (params(ramp(def))[field] = value))).toEqual([`modules.json: ${message}`]);
      });

      it('gate, waiting_area a ramp: chýbajúci povinný parameter', () => {
        expect(errorsAfter('modules', (def) => void delete params(gate(def))['processTicks'])).toEqual([
          "modules.json: /items/4/params must have required property 'processTicks'",
        ]);
        expect(errorsAfter('modules', (def) => void delete params(waiting(def))['bays'])).toEqual([
          "modules.json: /items/5/params must have required property 'bays'",
        ]);
        for (const field of ['docks', 'stagingPerDock', 'loadTicksPerUnit', 'category']) {
          expect(errorsAfter('modules', (def) => void delete params(ramp(def))[field]), field).toEqual([
            `modules.json: /items/6/params must have required property '${field}'`,
          ]);
        }
      });

      it('gate, waiting_area a ramp: internalTicks je voliteľné (0 je platné), cudzí parameter je chyba', () => {
        expect(errorsAfter('modules', (def) => void (params(gate(def))['internalTicks'] = 0))).toEqual([]);
        expect(errorsAfter('modules', (def) => void (params(waiting(def))['internalTicks'] = 3))).toEqual([]);
        expect(errorsAfter('modules', (def) => void (params(ramp(def))['internalTicks'] = 4))).toEqual([]);
        const unknownInGate = errorsAfter('modules', (def) => void (params(gate(def))['bays'] = 6));
        expect(unknownInGate).toHaveLength(1);
        expect(unknownInGate[0]).toContain('/items/4/params must NOT have additional properties');
        const unknownInWaiting = errorsAfter('modules', (def) => void (params(waiting(def))['docks'] = 2));
        expect(unknownInWaiting).toHaveLength(1);
        expect(unknownInWaiting[0]).toContain('/items/5/params must NOT have additional properties');
        const unknownInRamp = errorsAfter('modules', (def) => void (params(ramp(def))['processTicks'] = 18));
        expect(unknownInRamp).toHaveLength(1);
        expect(unknownInRamp[0]).toContain('/items/6/params must NOT have additional properties');
      });

      it('gate, waiting_area a ramp s params {} už schéma odmietne (povinné parametre)', () => {
        expect(errorsAfter('modules', (def) => void (gate(def)['params'] = {}))).toEqual([
          "modules.json: /items/4/params must have required property 'processTicks'",
        ]);
        expect(errorsAfter('modules', (def) => void (waiting(def)['params'] = {}))).toEqual([
          "modules.json: /items/5/params must have required property 'bays'",
        ]);
        expect(errorsAfter('modules', (def) => void (ramp(def)['params'] = {}))).toHaveLength(4);
      });

      it('kind bez typovaných parametrov (rail_station, pipeline) musí mať params {}', () => {
        const withKind = (kind: string, extra: Json) => (def: Json): void => {
          const module = structuredClone(crane(def));
          Object.assign(module, { id: `${kind}_test`, kind, params: extra });
          delete placement(module)['mustAttachTo'];
          items(def).push(module);
        };
        const testIndex = String(items(realDef('modules')).length);
        for (const kind of ['rail_station', 'pipeline']) {
          expect(errorsAfter('modules', withKind(kind, {})), kind).toEqual([]);
          const errors = errorsAfter('modules', withKind(kind, { capacityUnits: 64 }));
          expect(errors, kind).toHaveLength(1);
          expect(errors[0], kind).toContain(`/items/${testIndex}/params must NOT have more than 0 properties`);
        }
      });
    });
  });
});
