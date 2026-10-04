// Pripojenie modulov k ceste (T03-02; rozhodnutia orchestrátora F3 č. 2, 3; ADR-017): World.connectorCells (konektory
// po rotácii, vonkajšia bunka, hasRoad) a World.isConnected (aspoň jeden `road` konektor s cestou na vonkajšej bunke),
// počítané vždy z mriežky — PlaceRoad/RemoveRoad sa prejavia hneď, bez cache.
//
// harbor_01: Root berth (40, 14) rot 0 má konektory (41, 16, s) a (46, 16, s) → vonkajšie bunky (41, 17), (46, 17);
// starter parcela x 30–57, y 14–33 (vlastnená), pevnina y ≥ 17.
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { describe, expect, it } from 'vitest';
import { PlaceRoadCommand, RemoveRoadCommand } from '@sim/commands';
import { DefRegistry } from '@sim/defs';
import type { CellCoord, Rotation } from '@sim/grid';
import { connectorOutside, type Module } from '@sim/modules';
import { World, connectorCellsOf, isModuleConnected, isOutsideUsable } from '@sim/world';
import { BARE_MAP, DEFS, MAP, RAW_DEFS, SEED } from './world-fixtures';

const YARD = 'container_yard_small';
const DEPOT = 'vehicle_depot';

function rootWorld(defs = DEFS): World {
  return World.create(defs, MAP, SEED);
}

function roads(world: World, cells: readonly CellCoord[]): void {
  world.enqueue(new PlaceRoadCommand(cells));
  world.applyPending();
}

function unroads(world: World, cells: readonly CellCoord[]): void {
  world.enqueue(new RemoveRoadCommand(cells));
  world.applyPending();
}

function place(world: World, defId: string, x: number, y: number, rotation: Rotation = 0): Module {
  return world.placeModule({ defId, x, y, rotation }, 0);
}

describe('World.connectorCells', () => {
  it('Root berth: konektory v poradí defu, vonkajšie bunky (41, 17) a (46, 17), bez cesty', () => {
    const world = rootWorld();
    const berth = world.moduleAt(40, 14);
    if (berth === undefined) throw new Error('Root berth chýba');
    expect(world.connectorCells(berth)).toEqual([
      { connector: { x: 41, y: 16, side: 's', type: 'road' }, outside: { x: 41, y: 17 }, hasRoad: false },
      { connector: { x: 46, y: 16, side: 's', type: 'road' }, outside: { x: 46, y: 17 }, hasRoad: false },
    ]);
  });

  it('hasRoad sleduje mriežku: po PlaceRoad na (46, 17) true, po RemoveRoad znova false', () => {
    const world = rootWorld();
    const berth = world.moduleAt(40, 14) as Module;
    roads(world, [{ x: 46, y: 17 }]);
    expect(world.connectorCells(berth).map((c) => c.hasRoad)).toEqual([false, true]);
    unroads(world, [{ x: 46, y: 17 }]);
    expect(world.connectorCells(berth).map((c) => c.hasRoad)).toEqual([false, false]);
  });

  it('modul bez konektorov (žeriav) → []', () => {
    const world = rootWorld();
    const crane = world.craneAt(43, 14);
    if (crane === undefined) throw new Error('Root žeriav chýba');
    expect(world.connectorCells(crane)).toEqual([]);
    expect(world.isConnected(crane)).toBe(false);
  });

  it.each([0, 90, 180, 270] as const)('dvor rot %i: outside = connectorOutside(konektor), mimo footprintu', (rotation) => {
    const world = World.create(DEFS, BARE_MAP, SEED);
    const yard = place(world, YARD, 40, 22, rotation);
    const [cell] = world.connectorCells(yard);
    expect(cell.connector).toEqual(yard.connectors[0]);
    expect(cell.outside).toEqual(connectorOutside(yard.connectors[0]));
    expect(yard.containsCell(cell.outside.x, cell.outside.y)).toBe(false);
  });

  it('vonkajšia bunka mimo mapy → hasRoad false (nie výnimka)', () => {
    const world = World.create(DEFS, BARE_MAP, SEED);
    // Dvor rot 0 pri spodnom okraji mapy (výška 64): konektor (1, 3, s) na y = 63 → outside y = 64 mimo mapy.
    const yard = place(world, YARD, 40, 60, 0);
    const [cell] = world.connectorCells(yard);
    expect(cell.outside).toEqual({ x: 41, y: 64 });
    expect(cell.hasRoad).toBe(false);
    expect(world.isConnected(yard)).toBe(false);
  });
});

describe('World.isConnected', () => {
  it('Root berth nie je pripojený, kým pod žiadnym konektorom nie je cesta; stačí jeden konektor', () => {
    const world = rootWorld();
    const berth = world.moduleAt(40, 14) as Module;
    expect(world.isConnected(berth)).toBe(false);
    roads(world, [{ x: 41, y: 17 }]);
    expect(world.isConnected(berth)).toBe(true);
    unroads(world, [{ x: 41, y: 17 }]);
    expect(world.isConnected(berth)).toBe(false);
  });

  it('dvor a depo s cestou pod konektorom sú pripojené; cesta vedľa (nie na vonkajšej bunke) nestačí', () => {
    const world = rootWorld();
    const yard = place(world, YARD, 50, 20); // konektor (51, 23, s) → outside (51, 24)
    const depot = place(world, DEPOT, 34, 20); // konektor (35, 22, s) → outside (35, 23)
    roads(world, [
      { x: 52, y: 24 },
      { x: 36, y: 23 },
    ]);
    expect([world.isConnected(yard), world.isConnected(depot)]).toEqual([false, false]);
    roads(world, [
      { x: 51, y: 24 },
      { x: 35, y: 23 },
    ]);
    expect([world.isConnected(yard), world.isConnected(depot)]).toEqual([true, true]);
  });

  it('len konektory typu road: koľajový konektor s cestou na vonkajšej bunke modul nepripojí', () => {
    const [, , yardJson] = modulesJson.items;
    const railDefs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      modules: {
        ...modulesJson,
        items: [...modulesJson.items, { ...yardJson, id: 'yard_rail_test', connectors: [{ x: 1, y: 3, side: 's', type: 'rail' }] }],
      },
    });
    const world = rootWorld(railDefs);
    const yard = place(world, 'yard_rail_test', 50, 20);
    roads(world, [{ x: 51, y: 24 }]);
    expect(world.connectorCells(yard)[0].hasRoad).toBe(true);
    expect(world.isConnected(yard)).toBe(false);
  });

  it('čisté funkcie: connectorCellsOf / isModuleConnected = metódy World', () => {
    const world = rootWorld();
    const berth = world.moduleAt(40, 14) as Module;
    roads(world, [{ x: 46, y: 17 }]);
    expect(connectorCellsOf(world.grid, berth)).toEqual(world.connectorCells(berth));
    expect(isModuleConnected(world.grid, berth)).toBe(world.isConnected(berth));
  });
});

describe('isOutsideUsable (§8 bod 5)', () => {
  const none = (): boolean => false;

  it('cesta → áno; voľná pevnina/nábrežie → áno; voda, mimo mapy, modul, vlastný footprint, koľaj → nie', () => {
    const world = rootWorld();
    roads(world, [{ x: 40, y: 40 }]);
    world.grid.at(41, 40).road = 'rail';
    const { grid } = world;
    expect(isOutsideUsable(grid, { x: 40, y: 40 }, none)).toBe(true); // cesta
    expect(isOutsideUsable(grid, { x: 38, y: 40 }, none)).toBe(true); // voľná verejná pevnina (krk výbežku)
    expect(isOutsideUsable(grid, { x: 20, y: 25 }, none)).toBe(true); // parcela west_quay na predaj — dá sa dokúpiť
    expect(isOutsideUsable(grid, { x: 20, y: 15 }, none)).toBe(true); // nábrežie
    expect(isOutsideUsable(grid, { x: 20, y: 5 }, none)).toBe(false); // voda
    expect(isOutsideUsable(grid, { x: -1, y: 40 }, none)).toBe(false); // mimo mapy
    expect(isOutsideUsable(grid, { x: 44, y: 15 }, none)).toBe(false); // Root berth
    expect(isOutsideUsable(grid, { x: 38, y: 40 }, (x, y) => x === 38 && y === 40)).toBe(false); // vlastný footprint
    expect(isOutsideUsable(grid, { x: 41, y: 40 }, none)).toBe(false); // koľaj
  });
});
