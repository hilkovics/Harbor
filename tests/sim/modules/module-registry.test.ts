// ModuleRegistry (T02-03, pravidlo 7, ARCHITECTURE §17): kind → factory, žiadny switch; neregistrovaný kind a
// dvojitá registrácia sú chyby; create overí spec.defId a konštruktor Module overí id, cenu, rotáciu a hranice.
// T03-02 (ADR-017): vstavané aj `storage` (trieda podľa kategórie, `STORAGE_MODULES`) a `depot`; env nesie ledger.
import modulesJson from '@data/defs/modules.json';
import { describe, expect, it } from 'vitest';
import { DefRegistry, type ModuleDef } from '@sim/defs';
import type { Rotation } from '@sim/grid';
import {
  BUILTIN_MODULES,
  BerthModule,
  ContainerYard,
  CraneModule,
  Module,
  ModuleError,
  ModuleRegistry,
  STORAGE_MODULES,
  StorageModule,
  VehicleDepot,
  moduleRegistry,
  registerBuiltinModules,
  type ModuleEnv,
  type ModuleErrorCode,
  type ModuleInit,
} from '@sim/modules';
import { RAW_DEFS } from '../world/world-fixtures';
import { BERTH, CRANE, MODULE_DEFS, emptyCargo, id, quayGrid } from './module-fixtures';

const GRID = quayGrid(20, 12);
const ENV: ModuleEnv = { grid: GRID, cargo: emptyCargo() };
const berthDef = MODULE_DEFS.modules.get(BERTH);
const craneDef = MODULE_DEFS.modules.get(CRANE);

function errorCode(action: () => unknown): ModuleErrorCode | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof ModuleError) return error.code;
    throw error;
  }
  return undefined;
}

/** Testovacia trieda pre druh bez vstavanej triedy (gate — brány prídu vo F5). */
class TestGate extends Module {
  constructor(init: ModuleInit) {
    super(init);
  }
}

const TEST_ITEM = {
  displayName: 'Test',
  footprint: { w: 4, h: 4 },
  placement: { requiredTerrain: ['land'], requiresParcelOwnership: true },
  connectors: [],
  costCents: 1,
  maintenancePerDayCents: 0,
};

const STORAGE_DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: [
      ...modulesJson.items,
      { ...TEST_ITEM, id: 'yard_test', kind: 'storage', params: { capacityUnits: 64, category: 'container' } },
      { ...TEST_ITEM, id: 'silo_test', kind: 'storage', params: { capacityUnits: 24, category: 'bulk' } },
      { ...TEST_ITEM, id: 'gate_test', kind: 'gate', params: {} },
    ],
  },
});
const storageDef: Readonly<ModuleDef> = STORAGE_DEFS.modules.get('yard_test');
const siloDef: Readonly<ModuleDef> = STORAGE_DEFS.modules.get('silo_test');
const gateDef: Readonly<ModuleDef> = STORAGE_DEFS.modules.get('gate_test');

describe('ModuleRegistry', () => {
  it('predvolený register má vstavané druhy berth, crane, storage a depot (BUILTIN_MODULES)', () => {
    expect(moduleRegistry.kinds).toEqual(['berth', 'crane', 'storage', 'depot']);
    expect(BUILTIN_MODULES.map(([kind]) => kind)).toEqual(['berth', 'crane', 'storage', 'depot']);
  });

  it('storage: trieda podľa kategórie (STORAGE_MODULES) — container → ContainerYard; kategória bez triedy → unknown_kind', () => {
    expect(Object.keys(STORAGE_MODULES)).toEqual(['container']);
    const yard = moduleRegistry.create(storageDef, { defId: 'yard_test', x: 0, y: 0, rotation: 0 }, id(1), 0, ENV);
    expect(yard).toBeInstanceOf(ContainerYard);
    expect(yard).toBeInstanceOf(StorageModule);
    expect(errorCode(() => moduleRegistry.create(siloDef, { defId: 'silo_test', x: 0, y: 0, rotation: 0 }, id(1), 0, ENV))).toBe('unknown_kind');
  });

  it('depot → VehicleDepot (bundled vehicle_depot)', () => {
    const depotDef = MODULE_DEFS.modules.get('vehicle_depot');
    const depot = moduleRegistry.create(depotDef, { defId: 'vehicle_depot', x: 0, y: 0, rotation: 0 }, id(1), 0, ENV);
    expect(depot).toBeInstanceOf(VehicleDepot);
  });

  it('create vyberie triedu podľa def.kind', () => {
    const berth = moduleRegistry.create(berthDef, { defId: BERTH, x: 2, y: 2, rotation: 0 }, id(1), 40, ENV);
    expect(berth).toBeInstanceOf(BerthModule);
    expect(berth.id).toBe(1);
    expect(berth.def).toBe(berthDef);
    expect(berth.kind).toBe('berth');
    expect(berth.purchaseCostCents).toBe(40);
  });

  it('nový register je prázdny: neregistrovaný kind → unknown_kind', () => {
    const registry = new ModuleRegistry();
    expect(registry.has('berth')).toBe(false);
    expect(errorCode(() => registry.create(berthDef, { defId: BERTH, x: 0, y: 0, rotation: 0 }, id(1), 0, ENV))).toBe('unknown_kind');
    expect(errorCode(() => moduleRegistry.create(gateDef, { defId: 'gate_test', x: 0, y: 0, rotation: 0 }, id(1), 0, ENV))).toBe('unknown_kind');
  });

  it('registrácia novej triedy (bez switch-u): gate → TestGate', () => {
    const registry = new ModuleRegistry();
    registerBuiltinModules(registry);
    registry.register('gate', (init) => new TestGate(init));
    const gate = registry.create(gateDef, { defId: 'gate_test', x: 1, y: 1, rotation: 90 }, id(3), 0, ENV);
    expect(gate).toBeInstanceOf(TestGate);
    expect(gate.size).toEqual({ w: 4, h: 4 });
    expect(registry.kinds).toEqual(['berth', 'crane', 'storage', 'depot', 'gate']);
    expect(errorCode(() => registry.register('storage', (init) => new TestGate(init)))).toBe('duplicate_kind');
  });

  it('dvojitá registrácia → duplicate_kind', () => {
    const registry = new ModuleRegistry();
    registerBuiltinModules(registry);
    expect(errorCode(() => registry.register('berth', (init) => new BerthModule(init)))).toBe('duplicate_kind');
  });

  it('spec.defId ≠ def.id → invalid_input', () => {
    expect(errorCode(() => moduleRegistry.create(berthDef, { defId: CRANE, x: 0, y: 0, rotation: 0 }, id(1), 0, ENV))).toBe(
      'invalid_input',
    );
  });
});

describe('Module — geometria a vstup', () => {
  it('origin, rotation, size a cells po rotácii; containsCell', () => {
    const berth = moduleRegistry.create(berthDef, { defId: BERTH, x: 5, y: 1, rotation: 90 }, id(2), 0, ENV);
    expect(berth.origin).toEqual({ x: 5, y: 1 });
    expect(berth.rotation).toBe(90);
    expect(berth.size).toEqual({ w: 3, h: 8 });
    expect(berth.cells).toHaveLength(24);
    expect(berth.cells[0]).toEqual({ x: 5, y: 1 });
    expect(berth.cells[23]).toEqual({ x: 7, y: 8 });
    expect(berth.containsCell(7, 8)).toBe(true);
    expect(berth.containsCell(8, 8)).toBe(false);
    expect(berth.containsCell(5, 0)).toBe(false);
    expect(berth.label).toBe('berth_standard #2');
  });

  const INVALID: readonly [string, () => unknown, ModuleErrorCode][] = [
    ['id 0', () => moduleRegistry.create(berthDef, { defId: BERTH, x: 0, y: 0, rotation: 0 }, id(0), 0, ENV), 'invalid_input'],
    ['id 1.5', () => moduleRegistry.create(berthDef, { defId: BERTH, x: 0, y: 0, rotation: 0 }, id(1.5), 0, ENV), 'invalid_input'],
    ['záporná cena', () => moduleRegistry.create(berthDef, { defId: BERTH, x: 0, y: 0, rotation: 0 }, id(1), -1, ENV), 'invalid_input'],
    [
      'rotácia 45',
      () => moduleRegistry.create(berthDef, { defId: BERTH, x: 0, y: 0, rotation: 45 as Rotation }, id(1), 0, ENV),
      'invalid_input',
    ],
    ['presah vpravo', () => moduleRegistry.create(berthDef, { defId: BERTH, x: 13, y: 0, rotation: 0 }, id(1), 0, ENV), 'out_of_bounds'],
    ['presah dole (rot 90)', () => moduleRegistry.create(berthDef, { defId: BERTH, x: 0, y: 5, rotation: 90 }, id(1), 0, ENV), 'out_of_bounds'],
    ['záporné x', () => moduleRegistry.create(berthDef, { defId: BERTH, x: -1, y: 0, rotation: 0 }, id(1), 0, ENV), 'out_of_bounds'],
    ['žeriav mimo modulu', () => moduleRegistry.create(craneDef, { defId: CRANE, x: 0, y: 0, rotation: 0 }, id(1), 0, ENV), 'no_berth'],
  ];
  it.each(INVALID)('%s → ModuleError %s', (_name, action, code) => {
    expect(errorCode(action)).toBe(code);
  });

  it('modul bez runtime stavu: getRuntimeState() = {} a restore prijme len {}', () => {
    const yardRegistry = new ModuleRegistry();
    yardRegistry.register('storage', (init) => new TestGate(init));
    const yard = yardRegistry.create(storageDef, { defId: 'yard_test', x: 0, y: 0, rotation: 0 }, id(1), 0, ENV);
    expect(yard.getRuntimeState()).toEqual({});
    expect(() => yard.restoreRuntimeState({})).not.toThrow();
    expect(errorCode(() => yard.restoreRuntimeState({ x: 1 }))).toBe('state');
    expect(errorCode(() => yard.restoreRuntimeState(null))).toBe('state');
  });

  it('CraneModule berie berthId z modulu pod ľavým horným rohom (mriežka sveta)', () => {
    const grid = quayGrid(20, 12);
    for (let x = 2; x < 10; x++) for (let y = 2; y < 5; y++) grid.at(x, y).moduleId = id(7);
    const crane = moduleRegistry.create(craneDef, { defId: CRANE, x: 4, y: 2, rotation: 0 }, id(8), 0, { grid, cargo: emptyCargo() });
    expect(crane).toBeInstanceOf(CraneModule);
    expect((crane as CraneModule).berthId).toBe(7);
  });
});
