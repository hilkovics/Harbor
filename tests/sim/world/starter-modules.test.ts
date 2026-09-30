// Starter moduly mapy (T02-04, rozhodnutie orchestrátora 1, ADR-015): World.create umiestni harbor_01.starter.modules
// (Root modul = berth_standard (40, 14) + crane_container_gantry (43, 14)) v poradí mapy s purchaseCostCents 0,
// rovnakými pravidlami ako PlaceModule okrem ceny, bez udalostí a bez zmeny hotovosti. Neplatný starter modul →
// MapError s indexom. deserialize ich neumiestňuje (sú v save).
import { describe, expect, it } from 'vitest';
import harbor01Json from '@data/maps/harbor_01.json';
import { PlaceModuleCommand, PlaceRoadCommand, RemoveModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { MapError, loadMap, parseMapDef, type LoadedMap, type PlacedModuleSpec } from '@sim/grid';
import { BerthModule, CraneModule } from '@sim/modules';
import { World } from '@sim/world';
import { DEFS, MAP, SEED, hashState } from './world-fixtures';

const id = (value: number): EntityId => value as EntityId;

/** harbor_01 s inými starter modulmi (terén, parcely a cesty bez zmeny). */
function mapWithStarters(modules: readonly PlacedModuleSpec[]): LoadedMap {
  return loadMap(parseMapDef({ ...harbor01Json, starter: { ...harbor01Json.starter, modules } }));
}

function mapErrorOf(action: () => unknown): MapError {
  try {
    action();
  } catch (error) {
    if (error instanceof MapError) return error;
    throw error;
  }
  throw new Error('očakávaný MapError');
}

describe('World.create — Root modul z harbor_01', () => {
  it('mapa predpisuje berth (40, 14) a žeriav (43, 14), rot 0 (rozhodnutie 1)', () => {
    expect(MAP.starter.modules).toEqual([
      { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
      { defId: 'crane_container_gantry', x: 43, y: 14, rotation: 0 },
    ]);
  });

  it('moduly v poradí mapy s id 1, 2, zaplatená cena 0, žeriav pripojený k berthu, skupina kotvísk', () => {
    const world = World.create(DEFS, MAP, SEED);
    const berth = world.modules.get(id(1));
    const crane = world.modules.get(id(2));
    expect(berth).toBeInstanceOf(BerthModule);
    expect(crane).toBeInstanceOf(CraneModule);
    expect([...world.modules.values()].map((m) => [m.def.id, m.origin.x, m.origin.y, m.rotation, m.purchaseCostCents])).toEqual([
      ['berth_standard', 40, 14, 0, 0],
      ['crane_container_gantry', 43, 14, 0, 0],
    ]);
    expect((berth as BerthModule).craneIds).toEqual([2]);
    expect((crane as CraneModule).berthId).toBe(1);
    expect(world.moduleAt(44, 15)).toBe(berth);
    expect(world.craneAt(44, 15)).toBe(crane);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [1], totalLength: 8, minDepth: 1 }]);
    expect(world.ids.getState()).toEqual({ nextId: 3 });
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('bez udalostí a bez zmeny hotovosti', () => {
    const world = World.create(DEFS, MAP, SEED);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(world.events.pending).toBe(0);
    expect(world.applyPending()).toEqual([]);
  });

  it('deterministické: dva svety z rovnakého seedu majú rovnaký stav', () => {
    expect(hashState(World.create(DEFS, MAP, SEED).serialize())).toBe(hashState(World.create(DEFS, MAP, SEED).serialize()));
  });

  it('bunky Root berthu sú obsadené: PlaceRoad aj PlaceModule na ne → occupied', () => {
    const world = World.create(DEFS, MAP, SEED);
    expect(new PlaceRoadCommand([{ x: 44, y: 14 }]).validate(world).reasons).toEqual(['occupied']);
    expect(new PlaceModuleCommand({ defId: 'berth_standard', x: 36, y: 14, rotation: 0 }).validate(world).reasons).toEqual(['occupied']);
  });

  it('susedné kotvisko k Root berthu vytvorí skupinu dĺžky 16 (§5.4)', () => {
    const world = World.create(DEFS, MAP, SEED);
    const command = new PlaceModuleCommand({ defId: 'berth_standard', x: 48, y: 14, rotation: 0 });
    expect(command.validate(world).ok).toBe(true);
    command.apply(world);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [1, 3], totalLength: 16, minDepth: 1 }]);
  });
});

describe('Root modul — refundácia 0 (rozhodnutie 2)', () => {
  it('starter žeriav aj berth sa dajú predať, ale nevrátia nič a MoneyChanged sa neemituje', () => {
    const world = World.create(DEFS, MAP, SEED);
    const removeCrane = new RemoveModuleCommand(2);
    expect(removeCrane.validate(world)).toMatchObject({ ok: true, reasons: [], costCents: 0 });
    removeCrane.apply(world);

    const removeBerth = new RemoveModuleCommand(1);
    expect(removeBerth.validate(world)).toEqual({ ok: true, reasons: [], cells: world.modules.get(id(1))?.cells, costCents: 0 });
    removeBerth.apply(world);

    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(world.events.flush().map((e) => e.type)).toEqual(['ModuleRemoved', 'ModuleRemoved']);
    expect(world.modules.size).toBe(0);
    expect(world.berthGroups).toEqual([]);
  });

  it('Root berth so žeriavom → has_cranes', () => {
    expect(new RemoveModuleCommand(1).validate(World.create(DEFS, MAP, SEED)).reasons).toEqual(['has_cranes']);
  });
});

describe('World.create — neplatný starter modul → MapError s indexom', () => {
  it.each<[string, PlacedModuleSpec[], string, RegExp]>([
    ['neznámy def', [{ defId: 'no_such_module', x: 40, y: 14, rotation: 0 }], '/starter/modules/0/defId', /nie je v modules\.json/],
    ['berth mimo pobrežia', [{ defId: 'berth_standard', x: 40, y: 20, rotation: 0 }], '/starter/modules/0', /terrain: .*; no_water_side: /],
    ['berth na cudzej parcele', [{ defId: 'berth_standard', x: 12, y: 14, rotation: 0 }], '/starter/modules/0', /parcel_not_owned/],
    [
      'žeriav mimo berthu (druhý modul)',
      [
        { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
        { defId: 'crane_container_gantry', x: 50, y: 14, rotation: 0 },
      ],
      '/starter/modules/1',
      /no_berth/,
    ],
    [
      'žeriav pred berthom (poradie mapy sa dodrží)',
      [
        { defId: 'crane_container_gantry', x: 43, y: 14, rotation: 0 },
        { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
      ],
      '/starter/modules/0',
      /no_berth/,
    ],
    [
      'dva prekrývajúce sa berthy',
      [
        { defId: 'berth_standard', x: 40, y: 14, rotation: 0 },
        { defId: 'berth_standard', x: 44, y: 14, rotation: 0 },
      ],
      '/starter/modules/1',
      /occupied/,
    ],
  ])('%s → %s', (_name, modules, path, message) => {
    const error = mapErrorOf(() => World.create(DEFS, mapWithStarters(modules), SEED));
    expect(error.mapId).toBe('harbor_01');
    expect(error.path).toBe(path);
    expect(error.problem).toMatch(message);
  });

  it('berth cez starter cestu mapy → road', () => {
    const roads = [...harbor01Json.starter.roads, { x: 42, y: 16 }];
    const map = loadMap(parseMapDef({ ...harbor01Json, starter: { modules: [MAP.starter.modules[0]], roads } }));
    const error = mapErrorOf(() => World.create(DEFS, map, SEED));
    expect(error.path).toBe('/starter/modules/0');
    expect(error.problem).toMatch(/road: na bunke \(42, 16\) je 'road'/);
  });

  it('mapa bez starter modulov → prázdne moduly, id od 1', () => {
    const world = World.create(DEFS, mapWithStarters([]), SEED);
    expect(world.modules.size).toBe(0);
    expect(world.ids.getState()).toEqual({ nextId: 1 });
  });
});

describe('World.deserialize — starter moduly sú v save, neumiestňujú sa znova', () => {
  it('roundtrip zachová Root modul (bez duplicít a so zaplatenou cenou 0)', () => {
    const world = World.create(DEFS, MAP, SEED);
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())));
    expect([...restored.modules.keys()]).toEqual([1, 2]);
    expect(restored.modules.get(id(1))?.purchaseCostCents).toBe(0);
    expect(hashState(restored.serialize())).toBe(hashState(world.serialize()));
  });

  it('hráč predal starter žeriav → po načítaní ostane len berth', () => {
    const world = World.create(DEFS, MAP, SEED);
    world.enqueue(new RemoveModuleCommand(2));
    world.applyPending();
    const restored = World.deserialize(DEFS, MAP, world.serialize());
    expect([...restored.modules.keys()]).toEqual([1]);
    expect((restored.modules.get(id(1)) as BerthModule).craneIds).toEqual([]);
  });
});
