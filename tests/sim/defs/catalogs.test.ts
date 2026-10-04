// Katalógové defy (ADR-009) v DefRegistry: cargo_types, modules, ships — rozhranie Catalog, fail-fast DefError s JSON
// pointerom, typované parametre modulov podľa kind (MODULE_PARAM_SPECS) a zhoda so schémami (Ajv).
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import cargoTypesSchema from '@data/schemas/cargo_types.schema.json';
import modulesSchema from '@data/schemas/modules.schema.json';
import shipsSchema from '@data/schemas/ships.schema.json';
import trucksSchema from '@data/schemas/trucks.schema.json';
import vehiclesSchema from '@data/schemas/vehicles.schema.json';
import {
  CARGO_CATEGORIES,
  DefError,
  DefRegistry,
  MODULE_KINDS,
  MODULE_PARAM_SPECS,
  berthParams,
  craneParams,
  depotParams,
  gateParams,
  loadBundledDefs,
  rampParams,
  storageParams,
  waitingAreaParams,
  type Catalog,
  type ModuleDef,
} from '@sim/defs';
import { createCatalog } from '@sim/defs/catalog';

type Json = Record<string, unknown>;
type CatalogName = 'cargo_types' | 'modules' | 'ships' | 'vehicles' | 'trucks';

interface RawBundle {
  time: Json;
  economy: Json;
  infrastructure: Json;
  cargo_types: Json;
  modules: Json;
  ships: Json;
  vehicles: Json;
  trucks: Json;
  logistics: Json;
  contract_templates: Json;
  lines: Json;
}

/** Čerstvá hlboká kópia bundled defov; negatívne testy z nej upravia jedno pole. */
function rawDefs(): RawBundle {
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
    lines: structuredClone(linesJson),
  };
}

function itemsOf(raw: RawBundle, name: CatalogName): Json[] {
  return raw[name]['items'] as Json[];
}

/** Nastaví (alebo pri `undefined` zmaže) hodnotu na JSON pointeri v klonovanom deffe. */
function setAtPath(root: Json, path: string, value: unknown): void {
  const segments = path.slice(1).split('/');
  const last = segments.pop() as string;
  let target = root;
  for (const segment of segments) target = target[segment] as Json;
  if (value === undefined) delete target[last];
  else target[last] = value;
}

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
  expect(error.message).toBe(`${defName}${path}: ${error.problem}`);
  return error;
}

const fromRaw = (raw: RawBundle): DefRegistry => DefRegistry.fromRaw(raw);

describe('bundled katalógy (loadBundledDefs)', () => {
  const defs = loadBundledDefs();

  it('cargoTypes: container_teu podľa T02-01', () => {
    expect(defs.cargoTypes.items.map((item) => item.id)).toEqual(['container_teu']);
    expect(defs.cargoTypes.get('container_teu')).toEqual({
      id: 'container_teu',
      category: 'container',
      unitName: 'TEU',
      unitsPerBatch: 1,
      basePricePerUnitCents: 45_000,
      exportPricePerUnitCents: 40_000,
      repositioningPricePerUnitCents: 12_000,
      transhipPricePerUnitCents: 28_000,
      xpPerUnit: 1,
      colorToken: 'cargo-container',
    });
  });

  it('modules: poradie zo súboru, berth, crane, dvor a depo s konektormi a parametrami', () => {
    expect(defs.modules.items.map((item) => item.id)).toEqual([
      'berth_standard',
      'crane_container_gantry',
      'container_yard_small',
      'vehicle_depot',
      'truck_gate',
      'truck_waiting_area',
      'loading_ramp_container',
      'empty_depot',
    ]);
    const berth = defs.modules.get('berth_standard');
    expect(berth.kind).toBe('berth');
    expect(berth.footprint).toEqual({ w: 8, h: 3 });
    expect(berth.placement).toEqual({ requiredTerrain: ['quay'], waterSide: 'north', requiresParcelOwnership: true });
    expect(berth.connectors).toEqual([
      { x: 1, y: 2, side: 's', type: 'road' },
      { x: 6, y: 2, side: 's', type: 'road' },
    ]);
    expect([berth.costCents, berth.maintenancePerDayCents]).toEqual([40_000_000, 120_000]);
    const crane = defs.modules.get('crane_container_gantry');
    expect(crane.footprint).toEqual({ w: 2, h: 3 });
    expect(crane.placement.mustAttachTo).toEqual(['berth']);
    expect(crane.placement.waterSide).toBeUndefined();
    expect(crane.connectors).toEqual([]);
    expect([crane.costCents, crane.maintenancePerDayCents]).toEqual([60_000_000, 90_000]);
    const yard = defs.modules.get('container_yard_small');
    expect([yard.kind, yard.displayName, yard.footprint]).toEqual(['storage', 'Kontajnerový dvor S', { w: 4, h: 4 }]);
    expect(yard.placement).toEqual({ requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true });
    expect(yard.connectors).toEqual([{ x: 1, y: 3, side: 's', type: 'road' }]);
    expect([yard.costCents, yard.maintenancePerDayCents]).toEqual([15_000_000, 30_000]);
    const depot = defs.modules.get('vehicle_depot');
    expect([depot.kind, depot.displayName, depot.footprint]).toEqual(['depot', 'Depo vozidiel', { w: 3, h: 3 }]);
    expect(depot.placement).toEqual({ requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true });
    expect(depot.connectors).toEqual([{ x: 1, y: 2, side: 's', type: 'road' }]);
    expect([depot.costCents, depot.maintenancePerDayCents]).toEqual([9_000_000, 15_000]);
  });

  it('modules: brána, čakacia plocha a rampa podľa T04-01 (konektory z manifestu)', () => {
    const gate = defs.modules.get('truck_gate');
    expect([gate.kind, gate.displayName, gate.footprint]).toEqual(['gate', 'Brána kamiónov', { w: 2, h: 2 }]);
    expect(gate.placement).toEqual({ requiredTerrain: ['land', 'quay'], requiresParcelOwnership: true });
    expect(gate.connectors).toEqual([
      { x: 0, y: 0, side: 'n', type: 'road' },
      { x: 0, y: 1, side: 's', type: 'road' },
    ]);
    expect([gate.costCents, gate.maintenancePerDayCents]).toEqual([8_000_000, 15_000]);
    expect(gate.params).toEqual({ processTicks: 18 });
    const waiting = defs.modules.get('truck_waiting_area');
    expect([waiting.kind, waiting.displayName, waiting.footprint]).toEqual(['waiting_area', 'Čakacia plocha', { w: 4, h: 3 }]);
    expect(waiting.connectors).toEqual([
      { x: 0, y: 2, side: 'w', type: 'road' },
      { x: 3, y: 2, side: 'e', type: 'road' },
    ]);
    expect([waiting.costCents, waiting.maintenancePerDayCents]).toEqual([6_000_000, 10_000]);
    expect(waiting.params).toEqual({ bays: 6, pickupReservedBays: 2 });
    const ramp = defs.modules.get('loading_ramp_container');
    expect([ramp.kind, ramp.displayName, ramp.footprint]).toEqual(['ramp', 'Rampa · kontajnery', { w: 4, h: 2 }]);
    expect(ramp.connectors).toEqual([
      { x: 1, y: 1, side: 's', type: 'road' },
      { x: 2, y: 1, side: 's', type: 'road' },
    ]);
    expect([ramp.costCents, ramp.maintenancePerDayCents]).toEqual([10_000_000, 20_000]);
    expect(ramp.params).toEqual({ docks: 2, stagingPerDock: 4, loadTicksPerUnit: 6, category: 'container' });
  });

  it('trucks: truck_container podľa T04-01', () => {
    expect(defs.trucks.items.map((item) => item.id)).toEqual(['truck_container']);
    expect(defs.trucks.get('truck_container')).toEqual({
      id: 'truck_container',
      displayName: 'Kamión kontajnerový',
      capacityUnits: 1,
      speedCellsPerTick: 0.6,
      cargoCategories: ['container'],
    });
  });

  it('vehicles: straddle_carrier podľa T03-01', () => {
    expect(defs.vehicles.items.map((item) => item.id)).toEqual(['straddle_carrier', 'empty_handler']);
    expect(defs.vehicles.get('straddle_carrier')).toEqual({
      id: 'straddle_carrier',
      displayName: 'Straddle carrier',
      capacityUnits: 1,
      speedCellsPerTick: 0.4,
      loadTicks: 3,
      unloadTicks: 3,
      cargoCategories: ['container'],
      purchaseCents: 4_800_000,
      wagePerDayCents: 18_000,
    });
  });

  it('ships: feeder a handy', () => {
    expect(defs.ships.items.map((item) => item.id)).toEqual(['feeder', 'handy']);
    const feeder = defs.ships.get('feeder');
    expect([feeder.lengthCells, feeder.widthCells, feeder.draftClass, feeder.capacityUnits]).toEqual([6, 2, 1, 120]);
    expect(feeder.speedCellsPerTick).toBe(0.15);
    expect(feeder.cargoCategories).toEqual([...CARGO_CATEGORIES]);
    expect(feeder.berthAllowanceTicks).toBe(17_280);
    const handy = defs.ships.get('handy');
    expect([handy.displayName, handy.lengthCells, handy.widthCells, handy.capacityUnits]).toEqual(['Handysize', 10, 2, 300]);
  });

  it('typované gettery storageParams / depotParams', () => {
    expect(storageParams(defs.modules.get('container_yard_small'))).toEqual({ capacityUnits: 64, category: 'container' });
    expect(depotParams(defs.modules.get('vehicle_depot'))).toEqual({ capacity: 10 });
  });

  it('typované gettery gateParams / waitingAreaParams / rampParams', () => {
    expect(gateParams(defs.modules.get('truck_gate'))).toEqual({ processTicks: 18 });
    expect(waitingAreaParams(defs.modules.get('truck_waiting_area'))).toEqual({ bays: 6, pickupReservedBays: 2 });
    expect(rampParams(defs.modules.get('loading_ramp_container'))).toEqual({
      docks: 2,
      stagingPerDock: 4,
      loadTicksPerUnit: 6,
      category: 'container',
    });
  });

  it('typované gettery berthParams / craneParams', () => {
    expect(berthParams(defs.modules.get('berth_standard'))).toEqual({
      depthClass: 1,
      apronSlots: 8,
      maxCranes: 2,
      frontWaterCells: 3,
      apronReserveSlots: 2,
      handoverMode: 'under_hook',
      craneBufferSlots: 1,
    });
    expect(craneParams(defs.modules.get('crane_container_gantry'))).toEqual({ cycleTicks: 12, category: 'container', wagePerDayCents: 25_000, dualCycleFactor: 1.5 });
  });

  it('každé volanie loadBundledDefs vráti nezávislé katalógy', () => {
    expect(loadBundledDefs().modules).not.toBe(defs.modules);
  });
});

describe('Catalog', () => {
  const defs = loadBundledDefs();

  it('has / get; neznáme id → DefError s názvom defu a zoznamom známych id', () => {
    expect(defs.modules.has('berth_standard')).toBe(true);
    expect(defs.modules.has('berth_deepwater')).toBe(false);
    expect(defs.modules.get('crane_container_gantry')).toBe(defs.modules.items[1]);
    const error = expectDefError(() => defs.modules.get('berth_deepwater'), 'modules', '/items');
    expect(error.problem).toContain("'berth_deepwater'");
    expect(error.problem).toContain('berth_standard, crane_container_gantry, container_yard_small, vehicle_depot');
    expectDefError(() => defs.cargoTypes.get('grain'), 'cargo_types', '/items');
    expectDefError(() => defs.ships.get('mega'), 'ships', '/items');
    expectDefError(() => defs.vehicles.get('agv'), 'vehicles', '/items');
    expectDefError(() => defs.trucks.get('truck_tanker'), 'trucks', '/items');
  });

  it('has neznámeho id nehádže a prototypové názvy nie sú id', () => {
    expect(defs.ships.has('')).toBe(false);
    expect(defs.ships.has('constructor')).toBe(false);
    expect(defs.ships.has('__proto__')).toBe(false);
  });

  it('položky aj pole items sú zmrazené (hlboko)', () => {
    expect(Object.isFrozen(defs.modules.items)).toBe(true);
    const berth = defs.modules.get('berth_standard');
    expect(Object.isFrozen(berth)).toBe(true);
    expect(Object.isFrozen(berth.footprint)).toBe(true);
    expect(Object.isFrozen(berth.placement)).toBe(true);
    expect(Object.isFrozen(berth.placement.requiredTerrain)).toBe(true);
    expect(Object.isFrozen(berth.connectors)).toBe(true);
    expect(Object.isFrozen(berth.connectors[0])).toBe(true);
    expect(Object.isFrozen(berth.params)).toBe(true);
    expect(Object.isFrozen(defs.ships.get('feeder').cargoCategories)).toBe(true);
    expect(Object.isFrozen(defs.vehicles.items)).toBe(true);
    expect(Object.isFrozen(defs.vehicles.get('straddle_carrier'))).toBe(true);
    expect(Object.isFrozen(defs.vehicles.get('straddle_carrier').cargoCategories)).toBe(true);
    expect(Object.isFrozen(defs.trucks.items)).toBe(true);
    expect(Object.isFrozen(defs.trucks.get('truck_container'))).toBe(true);
    expect(Object.isFrozen(defs.trucks.get('truck_container').cargoCategories)).toBe(true);
    expect(() => {
      (berth.params as { apronSlots: number }).apronSlots = 99;
    }).toThrow(TypeError);
  });

  it('vstupné objekty sa nemenia ani nezmrazujú', () => {
    const raw = rawDefs();
    const before = structuredClone(raw);
    const registry = fromRaw(raw);
    expect(raw).toEqual(before);
    expect(Object.isFrozen(raw.modules)).toBe(false);
    expect(Object.isFrozen(itemsOf(raw, 'modules'))).toBe(false);
    expect(registry.modules.get('berth_standard')).not.toBe(itemsOf(raw, 'modules')[0]);
  });

  it('createCatalog: duplicitné id → DefError na indexe duplikátu', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];
    const error = expectDefError(() => createCatalog('demo', items), 'demo', '/items/2/id');
    expect(error.problem).toBe("duplicitné id 'a' (/items/0/id)");
  });

  it('createCatalog: poradie položiek sa zachová a zdrojové pole sa nezdieľa', () => {
    const items = [{ id: 'z' }, { id: 'a' }];
    const catalog: Catalog<{ id: string }> = createCatalog('demo', items);
    expect(catalog.items.map((item) => item.id)).toEqual(['z', 'a']);
    items.push({ id: 'late' });
    expect(catalog.has('late')).toBe(false);
    expect(catalog.items).toHaveLength(2);
  });
});

describe('katalógy: chyba tvaru súboru → DefError', () => {
  const NAMES: readonly CatalogName[] = ['cargo_types', 'modules', 'ships', 'vehicles', 'trucks'];

  describe.each(NAMES)('%s', (name) => {
    it('koreň nie je objekt', () => {
      for (const value of [[], 'x', 42, true]) {
        const raw = rawDefs();
        (raw as unknown as Record<string, unknown>)[name] = value;
        expectDefError(() => fromRaw(raw), name, '');
      }
    });

    it('neznámy kľúč v koreni', () => {
      const raw = rawDefs();
      raw[name]['note'] = 'x';
      expectDefError(() => fromRaw(raw), name, '/note');
    });

    it('chýbajúca alebo zlá schemaVersion', () => {
      for (const version of [undefined, 2, '1', null]) {
        const raw = rawDefs();
        setAtPath(raw[name], '/schemaVersion', version);
        expectDefError(() => fromRaw(raw), name, '/schemaVersion');
      }
    });

    it('chýbajúci items, items nie je pole, prázdny items', () => {
      const missing = rawDefs();
      delete missing[name]['items'];
      expectDefError(() => fromRaw(missing), name, '/items');
      const notArray = rawDefs();
      notArray[name]['items'] = { first: {} };
      expectDefError(() => fromRaw(notArray), name, '/items');
      const empty = rawDefs();
      empty[name]['items'] = [];
      expectDefError(() => fromRaw(empty), name, '/items');
    });

    it('položka nie je objekt', () => {
      const raw = rawDefs();
      itemsOf(raw, name)[0] = 'berth' as unknown as Json;
      expectDefError(() => fromRaw(raw), name, '/items/0');
    });

    it('neznámy kľúč v položke (preklep)', () => {
      const raw = rawDefs();
      itemsOf(raw, name)[0]!['colour'] = 'red';
      expectDefError(() => fromRaw(raw), name, '/items/0/colour');
    });

    it('chýbajúce povinné pole (id)', () => {
      const raw = rawDefs();
      delete itemsOf(raw, name)[0]!['id'];
      expectDefError(() => fromRaw(raw), name, '/items/0/id');
    });

    it.each(['Bad-Id', '1st', '', 'with space', 42, null])('id = %j', (id) => {
      const raw = rawDefs();
      itemsOf(raw, name)[0]!['id'] = id;
      expectDefError(() => fromRaw(raw), name, '/items/0/id');
    });

    it('duplicitné id → chyba na druhej položke s odkazom na prvú', () => {
      const raw = rawDefs();
      const items = itemsOf(raw, name);
      items.push(structuredClone(items[0]!));
      const error = expectDefError(() => fromRaw(raw), name, `/items/${String(items.length - 1)}/id`);
      expect(error.problem).toBe(`duplicitné id '${String(items[0]!['id'])}' (/items/0/id)`);
    });

    it('chyba v druhej položke má index v ceste', () => {
      const raw = rawDefs();
      const items = itemsOf(raw, name);
      const second = structuredClone(items[0]!);
      second['id'] = 'second_item';
      second['nonsense'] = 1;
      items.push(second);
      expectDefError(() => fromRaw(raw), name, `/items/${String(items.length - 1)}/nonsense`);
    });
  });
});

describe('cargo_types: zlé hodnoty polí → DefError s cestou', () => {
  const cases: readonly (readonly [field: string, value: unknown])[] = [
    ['category', 'grain'],
    ['category', 1],
    ['unitName', ''],
    ['unitName', 5],
    ['unitsPerBatch', 0],
    ['unitsPerBatch', 1.5],
    ['unitsPerBatch', '1'],
    ['basePricePerUnitCents', -1],
    ['basePricePerUnitCents', 0.5],
    ['xpPerUnit', -1],
    ['xpPerUnit', Number.NaN],
    ['colorToken', '--cargo-container'],
    ['colorToken', 'Cargo_Container'],
    ['colorToken', ''],
  ];

  it.each(cases)('%s = %j', (field, value) => {
    const raw = rawDefs();
    itemsOf(raw, 'cargo_types')[0]![field] = value;
    expectDefError(() => fromRaw(raw), 'cargo_types', `/items/0/${field}`);
  });

  it('hranice: xpPerUnit 0 a basePricePerUnitCents 0 sú platné', () => {
    const raw = rawDefs();
    Object.assign(itemsOf(raw, 'cargo_types')[0]!, { xpPerUnit: 0, basePricePerUnitCents: 0 });
    const cargo = fromRaw(raw).cargoTypes.get('container_teu');
    expect([cargo.xpPerUnit, cargo.basePricePerUnitCents]).toEqual([0, 0]);
  });
});

describe('ships: zlé hodnoty polí → DefError s cestou', () => {
  const cases: readonly (readonly [path: string, value: unknown])[] = [
    ['displayName', ''],
    ['lengthCells', 0],
    ['lengthCells', 6.5],
    ['widthCells', 0],
    ['widthCells', '2'],
    ['draftClass', 0],
    ['draftClass', 4],
    ['draftClass', 1.5],
    ['capacityUnits', 0],
    ['speedCellsPerTick', 0],
    ['speedCellsPerTick', -0.15],
    ['speedCellsPerTick', '0.15'],
    ['speedCellsPerTick', Number.POSITIVE_INFINITY],
    ['berthAllowanceTicks', 0],
    ['berthAllowanceTicks', 1.5],
    ['cargoCategories', []],
    ['cargoCategories', 'container'],
    ['cargoCategories', ['container', 'container']],
    ['cargoCategories/0', 'coal'],
    ['techRequired', 'Handy'],
    ['techRequired', 3],
  ];

  it.each(cases)('%s = %j', (path, value) => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'ships')[0]!, `/${path}`, value);
    expectDefError(() => fromRaw(raw), 'ships', `/items/0/${path}`);
  });

  it('techRequired je voliteľné', () => {
    const raw = rawDefs();
    expect(fromRaw(raw).ships.get('feeder').techRequired).toBeUndefined();
    itemsOf(raw, 'ships')[1]!['techRequired'] = 'ship_handy';
    expect(fromRaw(raw).ships.get('handy').techRequired).toBe('ship_handy');
  });
});

describe('vehicles: zlé hodnoty polí → DefError s cestou', () => {
  const cases: readonly (readonly [path: string, value: unknown])[] = [
    ['displayName', ''],
    ['displayName', 7],
    ['capacityUnits', 0],
    ['capacityUnits', 1.5],
    ['capacityUnits', '1'],
    ['speedCellsPerTick', 0],
    ['speedCellsPerTick', -0.4],
    ['speedCellsPerTick', '0.4'],
    ['speedCellsPerTick', Number.POSITIVE_INFINITY],
    ['loadTicks', 0],
    ['loadTicks', 2.5],
    ['loadTicks', null],
    ['unloadTicks', 0],
    ['unloadTicks', -3],
    ['cargoCategories', []],
    ['cargoCategories', 'container'],
    ['cargoCategories', ['container', 'container']],
    ['cargoCategories/0', 'coal'],
    ['purchaseCents', -1],
    ['purchaseCents', 4_800_000.5],
    ['purchaseCents', '4800000'],
    ['wagePerDayCents', -1],
    ['wagePerDayCents', 180.5],
    ['techRequired', 'Automatizacia I'],
    ['techRequired', 3],
  ];

  it.each(cases)('%s = %j', (path, value) => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'vehicles')[0]!, `/${path}`, value);
    expectDefError(() => fromRaw(raw), 'vehicles', `/items/0/${path}`);
  });

  it('chýbajúce povinné polia', () => {
    for (const path of ['displayName', 'capacityUnits', 'speedCellsPerTick', 'loadTicks', 'unloadTicks', 'cargoCategories', 'purchaseCents', 'wagePerDayCents']) {
      const raw = rawDefs();
      setAtPath(itemsOf(raw, 'vehicles')[0]!, `/${path}`, undefined);
      expectDefError(() => fromRaw(raw), 'vehicles', `/items/0/${path}`);
    }
  });

  it('techRequired je voliteľné', () => {
    const raw = rawDefs();
    expect(fromRaw(raw).vehicles.get('straddle_carrier').techRequired).toBeUndefined();
    itemsOf(raw, 'vehicles')[0]!['techRequired'] = 'automation_1';
    expect(fromRaw(raw).vehicles.get('straddle_carrier').techRequired).toBe('automation_1');
  });

  it('hranice: purchaseCents 0, wagePerDayCents 0 a loadTicks 1 sú platné', () => {
    const raw = rawDefs();
    Object.assign(itemsOf(raw, 'vehicles')[0]!, { purchaseCents: 0, wagePerDayCents: 0, loadTicks: 1, unloadTicks: 1 });
    const vehicle = fromRaw(raw).vehicles.get('straddle_carrier');
    expect([vehicle.purchaseCents, vehicle.wagePerDayCents, vehicle.loadTicks, vehicle.unloadTicks]).toEqual([0, 0, 1, 1]);
  });

  it('viac kategórií nákladu je platných (poradie sa zachová)', () => {
    const raw = rawDefs();
    itemsOf(raw, 'vehicles')[0]!['cargoCategories'] = ['bulk', 'container'];
    expect(fromRaw(raw).vehicles.get('straddle_carrier').cargoCategories).toEqual(['bulk', 'container']);
  });
});

describe('trucks: zlé hodnoty polí → DefError s cestou', () => {
  const cases: readonly (readonly [path: string, value: unknown])[] = [
    ['displayName', ''],
    ['displayName', 7],
    ['capacityUnits', 0],
    ['capacityUnits', 1.5],
    ['capacityUnits', '1'],
    ['speedCellsPerTick', 0],
    ['speedCellsPerTick', -0.6],
    ['speedCellsPerTick', '0.6'],
    ['speedCellsPerTick', Number.POSITIVE_INFINITY],
    ['cargoCategories', []],
    ['cargoCategories', 'container'],
    ['cargoCategories', ['container', 'container']],
    ['cargoCategories/0', 'coal'],
    // Kamión sa nekupuje, nemá mzdu ani nakládku (na rozdiel od vozidla) — tie polia sú neznáme kľúče.
    ['purchaseCents', 4_800_000],
    ['wagePerDayCents', 18_000],
    ['loadTicks', 3],
  ];

  it.each(cases)('%s = %j', (path, value) => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'trucks')[0]!, `/${path}`, value);
    expectDefError(() => fromRaw(raw), 'trucks', `/items/0/${path}`);
  });

  it('chýbajúce povinné polia', () => {
    for (const path of ['displayName', 'capacityUnits', 'speedCellsPerTick', 'cargoCategories']) {
      const raw = rawDefs();
      setAtPath(itemsOf(raw, 'trucks')[0]!, `/${path}`, undefined);
      expectDefError(() => fromRaw(raw), 'trucks', `/items/0/${path}`);
    }
  });

  it('viac kategórií nákladu je platných (poradie sa zachová)', () => {
    const raw = rawDefs();
    itemsOf(raw, 'trucks')[0]!['cargoCategories'] = ['bulk', 'container'];
    expect(fromRaw(raw).trucks.get('truck_container').cargoCategories).toEqual(['bulk', 'container']);
  });
});

describe('modules: zlé hodnoty polí → DefError s cestou', () => {
  const cases: readonly (readonly [path: string, value: unknown])[] = [
    ['kind', 'ferry'],
    ['kind', 3],
    ['displayName', ''],
    ['footprint', 8],
    ['footprint/w', 0],
    ['footprint/h', 2.5],
    ['footprint/d', 1],
    ['placement', []],
    ['placement/requiredTerrain', []],
    ['placement/requiredTerrain', ['quay', 'quay']],
    ['placement/requiredTerrain/0', 'lava'],
    ['placement/waterSide', 'south'],
    ['placement/requiresParcelOwnership', 'yes'],
    ['placement/parcel', true],
    ['connectors', {}],
    ['connectors/0/side', 'up'],
    ['connectors/0/type', 'berth_edge'],
    ['connectors/0/x', -1],
    ['connectors/1/y', 1.5],
    ['connectors/0/z', 0],
    ['costCents', -1],
    ['costCents', 40_000.5],
    ['maintenancePerDayCents', '1'],
    ['techRequired', 'Tech Node'],
  ];

  it.each(cases)('berth_standard %s = %j', (path, value) => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'modules')[0]!, `/${path}`, value);
    expectDefError(() => fromRaw(raw), 'modules', `/items/0/${path}`);
  });

  it('chýbajúce povinné polia', () => {
    for (const path of ['kind', 'footprint', 'footprint/h', 'placement', 'placement/requiredTerrain', 'placement/requiresParcelOwnership', 'connectors', 'connectors/1/side', 'costCents', 'maintenancePerDayCents', 'params']) {
      const raw = rawDefs();
      setAtPath(itemsOf(raw, 'modules')[0]!, `/${path}`, undefined);
      expectDefError(() => fromRaw(raw), 'modules', `/items/0/${path}`);
    }
  });

  it.each([
    ['neznámy kind', ['dock'], '/items/1/placement/mustAttachTo/0'],
    ['prázdne pole', [], '/items/1/placement/mustAttachTo'],
    ['duplicita', ['berth', 'berth'], '/items/1/placement/mustAttachTo'],
  ])('mustAttachTo: %s', (_name, value, path) => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'modules')[1]!, '/placement/mustAttachTo', value);
    expectDefError(() => fromRaw(raw), 'modules', path);
  });

  it('berth bez placement.waterSide → DefError (bez neho nevie, ktorou hranou sedí na vode)', () => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'modules')[0]!, '/placement/waterSide', undefined);
    const error = expectDefError(() => fromRaw(raw), 'modules', '/items/0/placement/waterSide');
    expect(error.problem).toContain('berth vyžaduje waterSide');
  });

  it('crane (iný kind) waterSide nepotrebuje ani nezakazuje', () => {
    const raw = rawDefs();
    setAtPath(itemsOf(raw, 'modules')[1]!, '/placement/waterSide', 'north');
    expect(fromRaw(raw).modules.get('crane_container_gantry').placement.waterSide).toBe('north');
  });

  describe('konektor musí ležať vo footprinte (rotácia 0°)', () => {
    it.each([
      ['x = w', { x: 8, y: 2 }],
      ['y = h', { x: 1, y: 3 }],
      ['x ďaleko mimo', { x: 100, y: 0 }],
    ])('%s → DefError s indexom konektora', (_name, cell) => {
      const raw = rawDefs();
      Object.assign(((itemsOf(raw, 'modules')[0]!['connectors'] as Json[])[1])!, cell);
      const error = expectDefError(() => fromRaw(raw), 'modules', '/items/0/connectors/1');
      expect(error.problem).toContain('mimo footprintu 8×3');
    });

    it.each([
      ['ľavý horný roh', { x: 0, y: 0 }],
      ['pravý dolný roh', { x: 7, y: 2 }],
    ])('%s je vo footprinte', (_name, cell) => {
      const raw = rawDefs();
      Object.assign(((itemsOf(raw, 'modules')[0]!['connectors'] as Json[])[0])!, cell);
      expect(fromRaw(raw).modules.get('berth_standard').connectors[0]).toMatchObject(cell);
    });

    it('konektor žeriava (footprint 2×3) mimo → DefError', () => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[1]!['connectors'] as Json[]).push({ x: 2, y: 0, side: 'e', type: 'road' });
      expectDefError(() => fromRaw(raw), 'modules', '/items/1/connectors/0');
    });
  });

  describe('params podľa kind', () => {
    const berthCases: readonly (readonly [field: string, value: unknown])[] = [
      ['depthClass', 0],
      ['depthClass', 4],
      ['depthClass', 1.5],
      ['depthClass', '1'],
      ['apronSlots', 0],
      ['apronSlots', 2.5],
      ['maxCranes', 0],
      ['maxCranes', null],
      ['frontWaterCells', 0],
      ['frontWaterCells', '3'],
    ];
    it.each(berthCases)('berth %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[0]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/0/params/${field}`);
    });

    const craneCases: readonly (readonly [field: string, value: unknown])[] = [
      ['cycleTicks', 1],
      ['cycleTicks', 0],
      ['cycleTicks', 12.5],
      ['cycleTicks', 'fast'],
      ['category', 'coal'],
      ['category', 3],
    ];
    it.each(craneCases)('crane %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[1]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/1/params/${field}`);
    });

    it('berth: chýbajúci parameter', () => {
      const raw = rawDefs();
      delete (itemsOf(raw, 'modules')[0]!['params'] as Json)['maxCranes'];
      expectDefError(() => fromRaw(raw), 'modules', '/items/0/params/maxCranes');
    });

    it('berth: parameter cudzieho kind-u je neznámy kľúč', () => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[0]!['params'] as Json)['cycleTicks'] = 12;
      expectDefError(() => fromRaw(raw), 'modules', '/items/0/params/cycleTicks');
    });

    it('crane s parametrami berthu → prvý chýbajúci parameter žeriava', () => {
      const raw = rawDefs();
      itemsOf(raw, 'modules')[1]!['params'] = { ...(itemsOf(raw, 'modules')[0]!['params'] as Json) };
      expectDefError(() => fromRaw(raw), 'modules', '/items/1/params/depthClass');
    });

    it.each([[[]], ['x'], [null], [7]])('params nie je objekt (%j)', (value) => {
      const raw = rawDefs();
      itemsOf(raw, 'modules')[0]!['params'] = value;
      expectDefError(() => fromRaw(raw), 'modules', '/items/0/params');
    });

    const storageCases: readonly (readonly [field: string, value: unknown])[] = [
      ['capacityUnits', 0],
      ['capacityUnits', 64.5],
      ['capacityUnits', '64'],
      ['capacityUnits', null],
      ['category', 'coal'],
      ['category', 1],
      ['internalTicks', -1],
      ['internalTicks', 2.5],
      ['internalTicks', '6'],
    ];
    it.each(storageCases)('storage %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[2]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/2/params/${field}`);
    });

    const depotCases: readonly (readonly [field: string, value: unknown])[] = [
      ['capacity', 0],
      ['capacity', 6.5],
      ['capacity', '6'],
      ['capacity', null],
      ['internalTicks', -1],
      ['internalTicks', 0.5],
    ];
    it.each(depotCases)('depot %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[3]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/3/params/${field}`);
    });

    it('storage a depot: chýbajúci povinný parameter', () => {
      const yard = rawDefs();
      delete (itemsOf(yard, 'modules')[2]!['params'] as Json)['category'];
      expectDefError(() => fromRaw(yard), 'modules', '/items/2/params/category');
      const depot = rawDefs();
      delete (itemsOf(depot, 'modules')[3]!['params'] as Json)['capacity'];
      expectDefError(() => fromRaw(depot), 'modules', '/items/3/params/capacity');
    });

    it('storage a depot: cudzí parameter je neznámy kľúč', () => {
      const yard = rawDefs();
      (itemsOf(yard, 'modules')[2]!['params'] as Json)['capacity'] = 6;
      expectDefError(() => fromRaw(yard), 'modules', '/items/2/params/capacity');
      const depot = rawDefs();
      (itemsOf(depot, 'modules')[3]!['params'] as Json)['capacityUnits'] = 64;
      expectDefError(() => fromRaw(depot), 'modules', '/items/3/params/capacityUnits');
    });

    it('storage a depot: params {} už neprejdú (povinné parametre)', () => {
      const yard = rawDefs();
      itemsOf(yard, 'modules')[2]!['params'] = {};
      expectDefError(() => fromRaw(yard), 'modules', '/items/2/params/capacityUnits');
      const depot = rawDefs();
      itemsOf(depot, 'modules')[3]!['params'] = {};
      expectDefError(() => fromRaw(depot), 'modules', '/items/3/params/capacity');
    });

    it('internalTicks je voliteľné (0 je platné) a prejaví sa v getteri', () => {
      const raw = rawDefs();
      expect(storageParams(fromRaw(raw).modules.get('container_yard_small')).internalTicks).toBeUndefined();
      expect(depotParams(fromRaw(raw).modules.get('vehicle_depot')).internalTicks).toBeUndefined();
      (itemsOf(raw, 'modules')[2]!['params'] as Json)['internalTicks'] = 0;
      (itemsOf(raw, 'modules')[3]!['params'] as Json)['internalTicks'] = 10;
      const registry = fromRaw(raw);
      expect(storageParams(registry.modules.get('container_yard_small')).internalTicks).toBe(0);
      expect(depotParams(registry.modules.get('vehicle_depot')).internalTicks).toBe(10);
    });

    it('storage môže prijímať aj inú kategóriu než container', () => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[2]!['params'] as Json)['category'] = 'bulk';
      expect(storageParams(fromRaw(raw).modules.get('container_yard_small')).category).toBe('bulk');
    });

    const gateCases: readonly (readonly [field: string, value: unknown])[] = [
      ['processTicks', 0],
      ['processTicks', 18.5],
      ['processTicks', '18'],
      ['processTicks', null],
      ['internalTicks', -1],
      ['internalTicks', 2.5],
      ['internalTicks', '6'],
    ];
    it.each(gateCases)('gate %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[4]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/4/params/${field}`);
    });

    const waitingAreaCases: readonly (readonly [field: string, value: unknown])[] = [
      ['bays', 0],
      ['bays', 6.5],
      ['bays', '6'],
      ['bays', null],
      ['internalTicks', -1],
      ['internalTicks', 0.5],
    ];
    it.each(waitingAreaCases)('waiting_area %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[5]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/5/params/${field}`);
    });

    const rampCases: readonly (readonly [field: string, value: unknown])[] = [
      ['docks', 0],
      ['docks', 2.5],
      ['docks', '2'],
      ['stagingPerDock', 0],
      ['stagingPerDock', 1.5],
      ['loadTicksPerUnit', 0],
      ['loadTicksPerUnit', 6.5],
      ['loadTicksPerUnit', null],
      ['category', 'coal'],
      ['category', 1],
      ['internalTicks', -1],
      ['internalTicks', '6'],
    ];
    it.each(rampCases)('ramp %s = %j', (field, value) => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[6]!['params'] as Json)[field] = value;
      expectDefError(() => fromRaw(raw), 'modules', `/items/6/params/${field}`);
    });

    it.each([
      ['gate', 4, 'processTicks'],
      ['waiting_area', 5, 'bays'],
      ['ramp', 6, 'docks'],
    ] as const)('%s: params {} neprejdú (chýba povinný parameter), cudzí parameter je neznámy kľúč', (_kind, index, first) => {
      const empty = rawDefs();
      itemsOf(empty, 'modules')[index]!['params'] = {};
      expectDefError(() => fromRaw(empty), 'modules', `/items/${String(index)}/params/${first}`);
      const foreign = rawDefs();
      (itemsOf(foreign, 'modules')[index]!['params'] as Json)['capacityUnits'] = 64;
      expectDefError(() => fromRaw(foreign), 'modules', `/items/${String(index)}/params/capacityUnits`);
    });

    it('brána, čakacia plocha a rampa: internalTicks je voliteľné (0 je platné) a prejaví sa v getteri', () => {
      const raw = rawDefs();
      const before = fromRaw(raw);
      expect(gateParams(before.modules.get('truck_gate')).internalTicks).toBeUndefined();
      expect(waitingAreaParams(before.modules.get('truck_waiting_area')).internalTicks).toBeUndefined();
      expect(rampParams(before.modules.get('loading_ramp_container')).internalTicks).toBeUndefined();
      (itemsOf(raw, 'modules')[4]!['params'] as Json)['internalTicks'] = 0;
      (itemsOf(raw, 'modules')[5]!['params'] as Json)['internalTicks'] = 3;
      (itemsOf(raw, 'modules')[6]!['params'] as Json)['internalTicks'] = 4;
      const registry = fromRaw(raw);
      expect(gateParams(registry.modules.get('truck_gate')).internalTicks).toBe(0);
      expect(waitingAreaParams(registry.modules.get('truck_waiting_area')).internalTicks).toBe(3);
      expect(rampParams(registry.modules.get('loading_ramp_container')).internalTicks).toBe(4);
    });

    it('čakacia plocha: pickupReservedBays (kvóta stojísk pre odvoz, ADR-035) je voliteľná a celé číslo ≥ 0; účinná kvóta je najviac bays − 1', () => {
      const raw = rawDefs();
      const params = itemsOf(raw, 'modules')[5]!['params'] as Json;
      delete params['pickupReservedBays'];
      expect(waitingAreaParams(fromRaw(raw).modules.get('truck_waiting_area')).pickupReservedBays).toBeUndefined();
      params['pickupReservedBays'] = 0;
      expect(waitingAreaParams(fromRaw(raw).modules.get('truck_waiting_area')).pickupReservedBays).toBe(0);
      params['pickupReservedBays'] = 9; // nad bays: def je platný, `WaitingArea` kvótu orezáva na bays − 1 (viď waiting-area test)
      expect(waitingAreaParams(fromRaw(raw).modules.get('truck_waiting_area')).pickupReservedBays).toBe(9);
      for (const bad of [-1, 1.5, '2', null]) {
        params['pickupReservedBays'] = bad;
        expectDefError(() => fromRaw(raw), 'modules', '/items/5/params/pickupReservedBays');
      }
    });

    it('rampa môže nakladať aj inú kategóriu než container', () => {
      const raw = rawDefs();
      (itemsOf(raw, 'modules')[6]!['params'] as Json)['category'] = 'bulk';
      expect(rampParams(fromRaw(raw).modules.get('loading_ramp_container')).category).toBe('bulk');
    });

    it.each(MODULE_KINDS.filter((kind) => kind === 'rail_station' || kind === 'pipeline'))(
      'kind %s zatiaľ nemá parametre: {} je platné, akýkoľvek kľúč nie',
      (kind) => {
        const raw = rawDefs();
        const extra = structuredClone(itemsOf(raw, 'modules')[1]!);
        Object.assign(extra, { id: `${kind}_test`, kind, params: {} });
        delete (extra['placement'] as Json)['mustAttachTo'];
        itemsOf(raw, 'modules').push(extra);
        expect(fromRaw(raw).modules.get(`${kind}_test`).kind).toBe(kind);
        extra['params'] = { capacityUnits: 64 };
        expectDefError(() => fromRaw(raw), 'modules', `/items/${String(itemsOf(raw, 'modules').length - 1)}/params/capacityUnits`);
      },
    );
  });
});

describe('MODULE_PARAM_SPECS', () => {
  it('má riadok pre každý druh modulu (a nič navyše)', () => {
    expect(Object.keys(MODULE_PARAM_SPECS).sort()).toEqual([...MODULE_KINDS].sort());
  });

  it('berth a crane majú presne polia BerthParams a CraneParams', () => {
    expect(Object.keys(MODULE_PARAM_SPECS.berth)).toEqual(['depthClass', 'apronSlots', 'maxCranes', 'frontWaterCells', 'apronReserveSlots', 'handoverMode', 'craneBufferSlots']);
    expect(Object.keys(MODULE_PARAM_SPECS.crane)).toEqual(['cycleTicks', 'category', 'wagePerDayCents', 'dualCycleFactor']);
  });

  it('storage a depot majú presne polia StorageParams a DepotParams (internalTicks je voliteľné)', () => {
    expect(Object.keys(MODULE_PARAM_SPECS.storage)).toEqual(['capacityUnits', 'category', 'internalTicks', 'role', 'repairBays']);
    expect(Object.keys(MODULE_PARAM_SPECS.depot)).toEqual(['capacity', 'internalTicks']);
    expect(MODULE_PARAM_SPECS.storage.internalTicks.optional).toBe(true);
    // F6c (ADR-034): rola a počet opráv sú voliteľné (bežný sklad ich nemá).
    expect(MODULE_PARAM_SPECS.storage.role.optional).toBe(true);
    expect(MODULE_PARAM_SPECS.storage.repairBays.optional).toBe(true);
    expect(MODULE_PARAM_SPECS.depot.internalTicks.optional).toBe(true);
    expect(MODULE_PARAM_SPECS.storage.capacityUnits.optional).not.toBe(true);
    expect(MODULE_PARAM_SPECS.depot.capacity.optional).not.toBe(true);
  });

  it('gate, waiting_area a ramp majú presne polia GateParams, WaitingAreaParams a RampParams (internalTicks je voliteľné)', () => {
    expect(Object.keys(MODULE_PARAM_SPECS.gate)).toEqual(['processTicks', 'internalTicks']);
    expect(Object.keys(MODULE_PARAM_SPECS.waiting_area)).toEqual(['bays', 'internalTicks', 'pickupReservedBays']);
    expect(Object.keys(MODULE_PARAM_SPECS.ramp)).toEqual(['docks', 'stagingPerDock', 'loadTicksPerUnit', 'category', 'internalTicks']);
    expect(MODULE_PARAM_SPECS.gate.internalTicks.optional).toBe(true);
    expect(MODULE_PARAM_SPECS.waiting_area.internalTicks.optional).toBe(true);
    expect(MODULE_PARAM_SPECS.ramp.internalTicks.optional).toBe(true);
    expect(MODULE_PARAM_SPECS.gate.processTicks.optional).not.toBe(true);
    expect(MODULE_PARAM_SPECS.waiting_area.bays.optional).not.toBe(true);
    expect(MODULE_PARAM_SPECS.ramp.docks.optional).not.toBe(true);
    expect(MODULE_PARAM_SPECS.ramp.stagingPerDock.optional).not.toBe(true);
    expect(MODULE_PARAM_SPECS.ramp.loadTicksPerUnit.optional).not.toBe(true);
    expect(MODULE_PARAM_SPECS.ramp.category.optional).not.toBe(true);
  });

  it('ostatné druhy (rail_station, pipeline) zatiaľ bez parametrov', () => {
    for (const kind of ['rail_station', 'pipeline'] as const) {
      expect(Object.keys(MODULE_PARAM_SPECS[kind]), kind).toEqual([]);
    }
  });
});

describe('storageParams / depotParams', () => {
  const defs = loadBundledDefs();
  const yard = defs.modules.get('container_yard_small');
  const depot = defs.modules.get('vehicle_depot');
  const berth = defs.modules.get('berth_standard');

  it('def iného kind-u → DefError (aj vzájomne storage ⇄ depot)', () => {
    expectDefError(() => storageParams(berth), 'modules', '/items');
    expectDefError(() => storageParams(depot), 'modules', '/items');
    expectDefError(() => depotParams(yard), 'modules', '/items');
    expectDefError(() => depotParams(berth), 'modules', '/items');
    expectDefError(() => berthParams(yard), 'modules', '/items');
  });

  it('opakované volanie vráti tú istú (overenú) inštanciu', () => {
    expect(storageParams(yard)).toBe(storageParams(yard));
    expect(depotParams(depot)).toBe(depotParams(depot));
  });

  it('ručne zostavený def s nesprávnymi parametrami → DefError (nie tichý as-cast)', () => {
    const broken: ModuleDef = { ...yard, params: { capacityUnits: 'many', category: 'container' } };
    const error = expectDefError(() => storageParams(broken), 'modules', '/items');
    expect(error.problem).toContain('container_yard_small');
    const hand: ModuleDef = { ...depot, params: { capacity: 6, extra: 1 } };
    expectDefError(() => depotParams(hand), 'modules', '/items');
    const missing: ModuleDef = { ...depot, params: {} };
    expectDefError(() => depotParams(missing), 'modules', '/items');
  });
});

describe('gateParams / waitingAreaParams / rampParams', () => {
  const defs = loadBundledDefs();
  const gate = defs.modules.get('truck_gate');
  const waiting = defs.modules.get('truck_waiting_area');
  const ramp = defs.modules.get('loading_ramp_container');
  const yard = defs.modules.get('container_yard_small');

  it('def iného kind-u → DefError (aj vzájomne gate, waiting_area a ramp)', () => {
    expectDefError(() => gateParams(waiting), 'modules', '/items');
    expectDefError(() => gateParams(yard), 'modules', '/items');
    expectDefError(() => waitingAreaParams(ramp), 'modules', '/items');
    expectDefError(() => waitingAreaParams(gate), 'modules', '/items');
    expectDefError(() => rampParams(gate), 'modules', '/items');
    expectDefError(() => rampParams(yard), 'modules', '/items');
    expectDefError(() => storageParams(ramp), 'modules', '/items');
  });

  it('opakované volanie vráti tú istú (overenú) inštanciu', () => {
    expect(gateParams(gate)).toBe(gateParams(gate));
    expect(waitingAreaParams(waiting)).toBe(waitingAreaParams(waiting));
    expect(rampParams(ramp)).toBe(rampParams(ramp));
  });

  it('ručne zostavený def s nesprávnymi parametrami → DefError (nie tichý as-cast)', () => {
    const brokenGate: ModuleDef = { ...gate, params: { processTicks: 'slow' } };
    const error = expectDefError(() => gateParams(brokenGate), 'modules', '/items');
    expect(error.problem).toContain('truck_gate');
    const handWaiting: ModuleDef = { ...waiting, params: { bays: 6, extra: 1 } };
    expectDefError(() => waitingAreaParams(handWaiting), 'modules', '/items');
    const missingRamp: ModuleDef = { ...ramp, params: { docks: 2 } };
    expectDefError(() => rampParams(missingRamp), 'modules', '/items');
  });
});

describe('berthParams / craneParams', () => {
  const defs = loadBundledDefs();
  const berth = defs.modules.get('berth_standard');
  const crane = defs.modules.get('crane_container_gantry');

  it('def iného kind-u → DefError', () => {
    expectDefError(() => berthParams(crane), 'modules', '/items');
    expectDefError(() => craneParams(berth), 'modules', '/items');
  });

  it('opakované volanie vráti tú istú (overenú) inštanciu', () => {
    expect(berthParams(berth)).toBe(berthParams(berth));
    expect(craneParams(crane)).toBe(craneParams(crane));
  });

  it('ručne zostavený def s nesprávnymi parametrami → DefError (nie tichý as-cast)', () => {
    const broken: ModuleDef = { ...berth, params: { depthClass: 1, apronSlots: 'four' } };
    const error = expectDefError(() => berthParams(broken), 'modules', '/items');
    expect(error.problem).toContain('berth_standard');
    const hand: ModuleDef = { ...crane, params: { cycleTicks: 12, category: 'container', extra: 1 } };
    expectDefError(() => craneParams(hand), 'modules', '/items');
  });

  it('hodnoty z upraveného defu sa prejavia v getteri', () => {
    const raw = rawDefs();
    Object.assign(itemsOf(raw, 'modules')[0]!['params'] as Json, { depthClass: 3, apronSlots: 6 });
    const edited = fromRaw(raw).modules.get('berth_standard');
    expect(berthParams(edited)).toMatchObject({ depthClass: 3, apronSlots: 6, maxCranes: 2 });
  });
});

/** Konzistencia schéma (Ajv) ⇔ DefRegistry pre pravidlá, ktoré vyjadrujú obe (T02-01). Duplicity a konektory schéma nevie. */
describe('katalógy: schéma ⇔ DefRegistry', () => {
  const validators: Record<CatalogName, ReturnType<Ajv2020['compile']>> = {
    cargo_types: new Ajv2020({ allErrors: true }).compile(cargoTypesSchema),
    modules: new Ajv2020({ allErrors: true }).compile(modulesSchema),
    ships: new Ajv2020({ allErrors: true }).compile(shipsSchema),
    vehicles: new Ajv2020({ allErrors: true }).compile(vehiclesSchema),
    trucks: new Ajv2020({ allErrors: true }).compile(trucksSchema),
  };

  /**
   * Porovnanie so schémou patrí pravidlám jednej položky katalógu, nie krížovým kontrolám šablón kontraktov (F5;
   * tie majú vlastné testy v `contract-templates.test.ts`): šablóny sa preto nahradia neutrálnou, ktorá vždy sedí na
   * prvý typ nákladu a prvú loď upraveného katalógu.
   */
  const neutralTemplates = (raw: RawBundle): Json => ({
    schemaVersion: 1,
    items: [
      {
        id: 'neutral_template',
        cargoTypeId: itemsOf(raw, 'cargo_types')[0]!['id'],
        volumeUnitsRange: [1, 1],
        slaDaysRange: [1, 1],
        shipClassIds: [itemsOf(raw, 'ships')[0]!['id']],
        weight: 1,
        minTier: 0,
      },
    ],
  });

  const registryAccepts = (raw: RawBundle): boolean => {
    try {
      fromRaw({ ...raw, contract_templates: neutralTemplates(raw) });
      return true;
    } catch (error) {
      if (error instanceof DefError) return false;
      throw error;
    }
  };

  const CASES: readonly (readonly [name: CatalogName, path: string, value: unknown])[] = [
    ['cargo_types', '/items/0/category', 'bulk'],
    ['cargo_types', '/items/0/category', 'coal'],
    ['cargo_types', '/items/0/unitsPerBatch', 25],
    ['cargo_types', '/items/0/unitsPerBatch', 0],
    ['cargo_types', '/items/0/unitsPerBatch', 2.5],
    ['cargo_types', '/items/0/basePricePerUnitCents', 0],
    ['cargo_types', '/items/0/basePricePerUnitCents', -1],
    ['cargo_types', '/items/0/xpPerUnit', 0.5],
    ['cargo_types', '/items/0/xpPerUnit', -0.5],
    ['cargo_types', '/items/0/xpPerUnit', '1'],
    ['cargo_types', '/items/0/unitName', ''],
    ['cargo_types', '/items/0/colorToken', 'cargo-bulk'],
    ['cargo_types', '/items/0/colorToken', 'Cargo Bulk'],
    ['cargo_types', '/items/0/id', 'grain_25t'],
    ['cargo_types', '/items/0/id', '25t'],
    ['cargo_types', '/items/0/extra', 1],
    ['cargo_types', '/items/0/colorToken', undefined],
    ['ships', '/items/0/lengthCells', 14],
    ['ships', '/items/0/lengthCells', 0],
    ['ships', '/items/0/widthCells', 1.5],
    ['ships', '/items/0/draftClass', 3],
    ['ships', '/items/0/draftClass', 0],
    ['ships', '/items/0/draftClass', 4],
    ['ships', '/items/0/capacityUnits', 1],
    ['ships', '/items/0/capacityUnits', 0],
    ['ships', '/items/0/speedCellsPerTick', 0.3],
    ['ships', '/items/0/speedCellsPerTick', 0],
    ['ships', '/items/0/speedCellsPerTick', -1],
    ['ships', '/items/0/berthAllowanceTicks', 1],
    ['ships', '/items/0/berthAllowanceTicks', 0],
    ['ships', '/items/0/cargoCategories', ['container']],
    ['ships', '/items/0/cargoCategories', []],
    ['ships', '/items/0/cargoCategories', ['gas', 'gas']],
    ['ships', '/items/0/cargoCategories', ['coal']],
    ['ships', '/items/0/techRequired', 'ship_handy'],
    ['ships', '/items/0/techRequired', 'Handy'],
    ['ships', '/items/0/displayName', undefined],
    ['modules', '/items/0/kind', 'storage'],
    ['modules', '/items/0/kind', 'ferry'],
    ['modules', '/items/0/footprint/w', 9],
    ['modules', '/items/0/footprint/w', 0],
    ['modules', '/items/0/costCents', 0],
    ['modules', '/items/0/costCents', -5],
    ['modules', '/items/0/placement/requiredTerrain', ['quay', 'land']],
    ['modules', '/items/0/placement/requiredTerrain', ['quay', 'quay']],
    ['modules', '/items/0/placement/requiredTerrain', ['lava']],
    ['modules', '/items/0/placement/waterSide', 'north'],
    ['modules', '/items/0/placement/waterSide', 'east'],
    ['modules', '/items/0/placement/waterSide', undefined],
    ['modules', '/items/1/placement/waterSide', 'north'],
    ['modules', '/items/1/placement/mustAttachTo', undefined],
    ['modules', '/items/1/placement/mustAttachTo', ['berth', 'crane']],
    ['modules', '/items/1/placement/mustAttachTo', ['dock']],
    ['modules', '/items/1/placement/mustAttachTo', []],
    ['modules', '/items/0/connectors', []],
    ['modules', '/items/0/connectors/0/type', 'pipe'],
    ['modules', '/items/0/connectors/0/type', 'berth_edge'],
    ['modules', '/items/0/connectors/0/side', 'w'],
    ['modules', '/items/0/connectors/0/side', 'up'],
    ['modules', '/items/0/params/depthClass', 3],
    ['modules', '/items/0/params/depthClass', 4],
    ['modules', '/items/0/params/apronSlots', 0],
    ['modules', '/items/0/params/maxCranes', 1],
    ['modules', '/items/0/params/maxCranes', undefined],
    ['modules', '/items/0/params/cycleTicks', 12],
    ['modules', '/items/1/params/cycleTicks', 1],
    ['modules', '/items/1/params/cycleTicks', 2],
    ['modules', '/items/1/params/category', 'bulk'],
    ['modules', '/items/1/params/category', 'coal'],
    ['modules', '/items/1/params/depthClass', 1],
    ['modules', '/items/1/params', {}],
    ['modules', '/items/0/params', {}],
    ['modules', '/items/2/kind', 'depot'],
    ['modules', '/items/2/kind', 'gate'],
    ['modules', '/items/3/kind', 'storage'],
    ['modules', '/items/2/params', {}],
    ['modules', '/items/3/params', {}],
    ['modules', '/items/2/params/capacityUnits', 1],
    ['modules', '/items/2/params/capacityUnits', 0],
    ['modules', '/items/2/params/capacityUnits', -64],
    ['modules', '/items/2/params/capacityUnits', 64.5],
    ['modules', '/items/2/params/capacityUnits', '64'],
    ['modules', '/items/2/params/capacityUnits', undefined],
    ['modules', '/items/2/params/category', 'bulk'],
    ['modules', '/items/2/params/category', 'coal'],
    ['modules', '/items/2/params/category', undefined],
    ['modules', '/items/2/params/internalTicks', 0],
    ['modules', '/items/2/params/internalTicks', 6],
    ['modules', '/items/2/params/internalTicks', -1],
    ['modules', '/items/2/params/internalTicks', 2.5],
    ['modules', '/items/2/params/internalTicks', '6'],
    ['modules', '/items/2/params/capacity', 6],
    ['modules', '/items/2/params/extra', 1],
    ['modules', '/items/3/params/capacity', 1],
    ['modules', '/items/3/params/capacity', 0],
    ['modules', '/items/3/params/capacity', -6],
    ['modules', '/items/3/params/capacity', 6.5],
    ['modules', '/items/3/params/capacity', '6'],
    ['modules', '/items/3/params/capacity', undefined],
    ['modules', '/items/3/params/internalTicks', 0],
    ['modules', '/items/3/params/internalTicks', 10],
    ['modules', '/items/3/params/internalTicks', -1],
    ['modules', '/items/3/params/internalTicks', 0.5],
    ['modules', '/items/3/params/capacityUnits', 64],
    ['vehicles', '/items/0/displayName', ''],
    ['vehicles', '/items/0/displayName', undefined],
    ['vehicles', '/items/0/capacityUnits', 2],
    ['vehicles', '/items/0/capacityUnits', 0],
    ['vehicles', '/items/0/capacityUnits', 1.5],
    ['vehicles', '/items/0/speedCellsPerTick', 0.5],
    ['vehicles', '/items/0/speedCellsPerTick', 0],
    ['vehicles', '/items/0/speedCellsPerTick', -0.4],
    ['vehicles', '/items/0/speedCellsPerTick', '0.4'],
    ['vehicles', '/items/0/loadTicks', 1],
    ['vehicles', '/items/0/loadTicks', 0],
    ['vehicles', '/items/0/loadTicks', 2.5],
    ['vehicles', '/items/0/unloadTicks', 1],
    ['vehicles', '/items/0/unloadTicks', 0],
    ['vehicles', '/items/0/unloadTicks', -3],
    ['vehicles', '/items/0/cargoCategories', ['container', 'bulk']],
    ['vehicles', '/items/0/cargoCategories', []],
    ['vehicles', '/items/0/cargoCategories', ['container', 'container']],
    ['vehicles', '/items/0/cargoCategories', ['coal']],
    ['vehicles', '/items/0/purchaseCents', 0],
    ['vehicles', '/items/0/purchaseCents', -1],
    ['vehicles', '/items/0/purchaseCents', 4_800_000.5],
    ['vehicles', '/items/0/wagePerDayCents', 0],
    ['vehicles', '/items/0/wagePerDayCents', -18_000],
    ['vehicles', '/items/0/techRequired', 'automation_1'],
    ['vehicles', '/items/0/techRequired', 'Automation 1'],
    ['vehicles', '/items/0/id', 'Straddle'],
    ['vehicles', '/items/0/extra', 1],
    ['modules', '/items/4/params/processTicks', 1],
    ['modules', '/items/4/params/processTicks', 0],
    ['modules', '/items/4/params/processTicks', 18.5],
    ['modules', '/items/4/params/processTicks', undefined],
    ['modules', '/items/4/params/internalTicks', 0],
    ['modules', '/items/4/params/internalTicks', -1],
    ['modules', '/items/4/params/extra', 1],
    ['modules', '/items/4/params', {}],
    ['modules', '/items/5/params/bays', 1],
    ['modules', '/items/5/params/bays', 0],
    ['modules', '/items/5/params/bays', '6'],
    ['modules', '/items/5/params/bays', undefined],
    ['modules', '/items/5/params/internalTicks', 3],
    ['modules', '/items/5/params/internalTicks', 0.5],
    ['modules', '/items/5/params/pickupReservedBays', 0],
    ['modules', '/items/5/params/pickupReservedBays', 5],
    ['modules', '/items/5/params/pickupReservedBays', 9],
    ['modules', '/items/5/params/pickupReservedBays', -1],
    ['modules', '/items/5/params/pickupReservedBays', 1.5],
    ['modules', '/items/5/params/pickupReservedBays', '2'],
    ['modules', '/items/5/params/pickupReservedBays', undefined],
    ['modules', '/items/5/params/docks', 2],
    ['modules', '/items/6/params/docks', 1],
    ['modules', '/items/6/params/docks', 0],
    ['modules', '/items/6/params/stagingPerDock', 1],
    ['modules', '/items/6/params/stagingPerDock', 0],
    ['modules', '/items/6/params/loadTicksPerUnit', 1],
    ['modules', '/items/6/params/loadTicksPerUnit', 0],
    ['modules', '/items/6/params/loadTicksPerUnit', 2.5],
    ['modules', '/items/6/params/category', 'bulk'],
    ['modules', '/items/6/params/category', 'coal'],
    ['modules', '/items/6/params/category', undefined],
    ['modules', '/items/6/params/internalTicks', 4],
    ['modules', '/items/6/params/internalTicks', '4'],
    ['modules', '/items/6/params/bays', 6],
    ['modules', '/items/4/kind', 'ramp'],
    ['modules', '/items/5/kind', 'gate'],
    ['modules', '/items/6/kind', 'waiting_area'],
    ['modules', '/items/6/kind', 'pipeline'],
    ['trucks', '/items/0/displayName', ''],
    ['trucks', '/items/0/displayName', undefined],
    ['trucks', '/items/0/capacityUnits', 2],
    ['trucks', '/items/0/capacityUnits', 0],
    ['trucks', '/items/0/capacityUnits', 1.5],
    ['trucks', '/items/0/speedCellsPerTick', 0.8],
    ['trucks', '/items/0/speedCellsPerTick', 0],
    ['trucks', '/items/0/speedCellsPerTick', -0.6],
    ['trucks', '/items/0/speedCellsPerTick', '0.6'],
    ['trucks', '/items/0/cargoCategories', ['container', 'bulk']],
    ['trucks', '/items/0/cargoCategories', []],
    ['trucks', '/items/0/cargoCategories', ['container', 'container']],
    ['trucks', '/items/0/cargoCategories', ['coal']],
    ['trucks', '/items/0/cargoCategories', undefined],
    ['trucks', '/items/0/id', 'Truck'],
    ['trucks', '/items/0/purchaseCents', 1],
    ['trucks', '/items/0/extra', 1],
  ];

  it.each(CASES)('%s %s = %j', (name, path, value) => {
    const raw = rawDefs();
    setAtPath(raw[name], path, value);
    expect(registryAccepts(raw), `${name}${path}`).toBe(validators[name](raw[name]));
  });

  it('bundled katalógy prejdú schémou aj registry', () => {
    const raw = rawDefs();
    for (const name of ['cargo_types', 'modules', 'ships', 'vehicles', 'trucks'] as const) expect(validators[name](raw[name])).toBe(true);
    expect(registryAccepts(raw)).toBe(true);
  });
});
