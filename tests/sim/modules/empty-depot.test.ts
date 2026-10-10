// Depo prázdnych kontajnerov (T6C-01, ADR-034): sklad kategórie `container` s rolou `empty_depot` — registrácia podľa
// `params.role`, smery, ktoré prijíma (`acceptsDirection`), kapacita pre pool (0), `repairBays` a to, že alokátory skladu
// pre import a export depo preskočia. Kontrola, oprava a výdaj z depa dodá T6C-02.
import { describe, expect, it } from 'vitest';
import { CARGO_DIRECTIONS } from '@sim/cargo';
import { DefRegistry } from '@sim/defs';
import { EMPTY_DEPOT_CATEGORY, ContainerYard, EmptyDepot, ModuleError, STORAGE_ROLE_MODULES, StorageModule, moduleRegistry } from '@sim/modules';
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { RAW_DEFS } from '../world/world-fixtures';
import { emptyCargo, id, quayGrid } from './module-fixtures';

const DEFS = DefRegistry.fromRaw({ ...RAW_DEFS, modules: modulesJson });
const GRID = quayGrid(16, 16);

function create(defId: string): StorageModule {
  const module = moduleRegistry.create(DEFS.modules.get(defId), { defId, x: 2, y: 2, rotation: 0 }, id(10), 0, { grid: GRID, cargo: emptyCargo(DEFS) });
  if (!(module instanceof StorageModule)) throw new Error(`${defId} nie je StorageModule`);
  return module;
}

describe('EmptyDepot — registrácia a vlastnosti', () => {
  it('registry vytvorí EmptyDepot podľa params.role; sklad bez roly ostáva ContainerYard', () => {
    const depot = create('empty_depot');
    expect(depot).toBeInstanceOf(EmptyDepot);
    expect(depot).toBeInstanceOf(StorageModule);
    expect(create('container_yard_small')).toBeInstanceOf(ContainerYard);
    expect(Object.keys(STORAGE_ROLE_MODULES)).toEqual(['empty_depot', 'rtg_block', 'rail_terminal']);
  });

  it('parametre z defu: kategória container, kapacita 96 slotov, 2 opravárenské miesta; footprint 4×4', () => {
    const depot = create('empty_depot') as EmptyDepot;
    expect(EMPTY_DEPOT_CATEGORY).toBe('container');
    expect([depot.category, depot.capacity, depot.repairBays]).toEqual(['container', 96, 2]);
    expect([depot.freeCount, depot.storedCount, depot.reservedCount]).toEqual([96, 0, 0]);
    expect(depot.def.footprint).toEqual({ w: 4, h: 4 });
  });

  it('prijíma len smer empty; bežný dvor každý smer', () => {
    const depot = create('empty_depot');
    const yard = create('container_yard_small');
    for (const direction of CARGO_DIRECTIONS) {
      expect([direction, depot.acceptsDirection(direction)]).toEqual([direction, direction === 'empty']);
      expect([direction, yard.acceptsDirection(direction)]).toEqual([direction, true]);
    }
  });

  it('kapacita pre capacityHint poolu: depo 0 (neuskladňuje náklad kontraktov), dvor = capacityUnits z defu (nie fyzická kapacita bloku)', () => {
    expect(create('empty_depot').storageCapacityUnits()).toBe(0);
    const yard = create('container_yard_small');
    // Hint poolu = `capacityUnits` z defu (64), fyzická kapacita bloku so stohmi = min(capacityUnits, 4 × 4 × 3) = 48 TEU (ADR-039 dodatok TR2-02).
    expect(yard.storageCapacityUnits()).toBe(yard.params.capacityUnits);
    expect(yard.capacity).toBe(48);
  });

  it('def bez roly alebo bez repairBays nie je depo: ModuleError invalid_input', () => {
    const depotJson = modulesJson.items.find((item) => item.id === 'empty_depot');
    if (depotJson === undefined) throw new Error('empty_depot chýba v modules.json');
    const bare = { ...depotJson, params: { capacityUnits: 96, category: 'container' } };
    const raw = { ...RAW_DEFS, modules: { ...modulesJson, items: [...modulesJson.items.filter((item) => item.id !== 'empty_depot'), bare] } };
    const defs = DefRegistry.fromRaw(raw);
    const init = { x: 2, y: 2, rotation: 0 as const, defId: 'empty_depot' };
    // Bez roly ide sklad cez kategóriu → ContainerYard (platný dvor), nie depo.
    expect(moduleRegistry.create(defs.modules.get('empty_depot'), init, id(11), 0, { grid: GRID, cargo: emptyCargo(defs) })).toBeInstanceOf(ContainerYard);
    const forced = { ...defs.modules.get('empty_depot'), params: { capacityUnits: 96, category: 'container', role: 'empty_depot' } };
    expect(() => moduleRegistry.create(forced as never, init, id(12), 0, { grid: GRID, cargo: emptyCargo(defs) })).toThrow(ModuleError);
  });
});
