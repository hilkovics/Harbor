// Prístup k modulom a výber bloku (T03-05; ARCHITECTURE §7.3 bod 1, §7.7; ADR-018, ADR-039): prístupová bunka = vonkajšia
// bunka cestného konektora s cestou, vzdialenosti cez DistanceMatrix, najbližší kompatibilný pripojený blok s voľnou
// kapacitou (stored + reserved < capacity) vyberá `YardPlanner` (nahradil `allocateStorage`, TR2-06b), remíza → menšie id; výber svet nemení.
import { describe, expect, it } from 'vitest';
import type { CargoUnit } from '@sim/cargo';
import { NO_ACCESS, accessCellIndex, chooseYardSlot, distanceBetweenModules, distanceToModule, isAccessCell, nearestAccessCell, reserveYardSlot } from '@sim/logistics';
import type { BerthModule, YardBlock } from '@sim/modules';
import type { World } from '@sim/world';
import {
  BERTH_ACCESS,
  DEPOT_ACCESS,
  ROOT_BERTH_ID,
  YARD_E,
  YARD_E_ACCESS,
  YARD_F,
  YARD_F_ACCESS,
  YARD_W,
  YARD_W_ACCESS,
  cellIndex,
  dispatchDefs,
  dispatchWorld,
  execute,
  placeYard,
} from './dispatch-fixtures';
import { newUnit } from './yard-fixtures';

const berthOf = (world: ReturnType<typeof dispatchWorld>['world']): BerthModule => world.modules.get(ROOT_BERTH_ID) as BerthModule;

describe('prístup k modulom po ceste', () => {
  it('accessCellIndex / isAccessCell: vonkajšia bunka cestného konektora s cestou; bez cesty NO_ACCESS', () => {
    const { world, depot } = dispatchWorld();
    const berth = berthOf(world);
    // Berth 8 × 4: prvé dva sú južné konektory (s cestou), ostatné pruhové w / e bez cesty.
    expect(berth.connectors.map((connector) => accessCellIndex(world.grid, connector))).toEqual([...BERTH_ACCESS.map((cell) => cellIndex(world, cell)), ...Array<number>(6).fill(NO_ACCESS)]);
    expect(accessCellIndex(world.grid, depot.connectors[0])).toBe(cellIndex(world, DEPOT_ACCESS));
    expect(isAccessCell(world.grid, depot, cellIndex(world, DEPOT_ACCESS))).toBe(true);
    expect(isAccessCell(world.grid, depot, cellIndex(world, BERTH_ACCESS[0]))).toBe(false);
    const unconnected = placeYard(world, { x: 42, y: 24 }, 0); // konektor → (43, 28), bez cesty
    expect(accessCellIndex(world.grid, unconnected.connectors[0])).toBe(NO_ACCESS);
    expect(nearestAccessCell(world, cellIndex(world, DEPOT_ACCESS), unconnected)).toBe(NO_ACCESS);
    expect(distanceToModule(world, cellIndex(world, DEPOT_ACCESS), unconnected)).toBe(Infinity);
  });

  it('nearestAccessCell / distanceToModule: najbližší konektor berthu podľa ceny cesty; distanceBetweenModules = najlacnejšia dvojica', () => {
    const { world, depot } = dispatchWorld();
    const berth = berthOf(world);
    const west = placeYard(world, YARD_W);
    const east = placeYard(world, YARD_E);
    expect(nearestAccessCell(world, cellIndex(world, DEPOT_ACCESS), berth)).toBe(cellIndex(world, BERTH_ACCESS[0]));
    expect(nearestAccessCell(world, cellIndex(world, YARD_E_ACCESS), berth)).toBe(cellIndex(world, BERTH_ACCESS[1]));
    expect(distanceToModule(world, cellIndex(world, DEPOT_ACCESS), berth)).toBe(9);
    expect(distanceBetweenModules(world, berth, west)).toBe(4);
    expect(distanceBetweenModules(world, berth, east)).toBe(4);
    expect(distanceBetweenModules(world, depot, east)).toBe(18);
    expect(nearestAccessCell(world, cellIndex(world, { x: 43, y: 18 }), berth)).toBe(cellIndex(world, BERTH_ACCESS[0])); // 2 < 3
    expect(nearestAccessCell(world, cellIndex(world, { x: 44, y: 18 }), berth)).toBe(cellIndex(world, BERTH_ACCESS[1])); // 3 > 2
  });
});

describe('YardPlanner — výber bloku (nahradil allocateStorage, TR2-06b)', () => {
  const blockOf = (world: World, unit: CargoUnit): YardBlock => {
    const choice = reserveYardSlot(world, unit, berthOf(world));
    if (choice === null) throw new Error('plánovač nenašiel blok');
    return world.modules.get(choice.moduleId) as YardBlock;
  };

  it('najbližší blok od berthu; pri zhode vzdialeností menšie id (W pred E)', () => {
    const { world } = dispatchWorld();
    const far = placeYard(world, YARD_F);
    const west = placeYard(world, YARD_W);
    const east = placeYard(world, YARD_E);
    expect(west.id).toBeLessThan(east.id);
    expect(chooseYardSlot(world, newUnit(world), berthOf(world))?.moduleId).toBe(west.id);
    expect(far.id).toBeLessThan(west.id);
  });

  it('rešpektuje rezervácie: plne rezervovaný blok sa preskočí (freeCount = capacity − stored − reserved); import sa najprv rozloží po prázdnych stohoch blokov', () => {
    const { world } = dispatchWorld(dispatchDefs({ yardCapacity: 2 }));
    const west = placeYard(world, YARD_W);
    const east = placeYard(world, YARD_E);
    const far = placeYard(world, YARD_F);
    // Každý blok má jediný použiteľný stoh (kapacita 2): prázdny stoh (trieda 0) má prednosť pred vrstvením, medzi nimi najbližší blok; potom sa vrství.
    const picks = Array.from({ length: 6 }, () => blockOf(world, newUnit(world)));
    expect(picks).toEqual([west, east, far, west, east, far]);
    expect([west.freeCount, east.freeCount, far.freeCount]).toEqual([0, 0, 0]);
    expect(chooseYardSlot(world, newUnit(world), berthOf(world))).toBeNull();
  });

  it('nepripojený blok (bez cesty pred konektorom) sa ignoruje; výber (chooseYardSlot) svet nemení', () => {
    const { world } = dispatchWorld();
    placeYard(world, { x: 42, y: 24 }, 0); // bez cesty
    expect(chooseYardSlot(world, newUnit(world), berthOf(world))).toBeNull();
    const far = placeYard(world, YARD_F);
    const unit = newUnit(world);
    const before = JSON.stringify(world.serialize());
    expect(chooseYardSlot(world, unit, berthOf(world))?.moduleId).toBe(far.id);
    expect(JSON.stringify(world.serialize())).toBe(before);
    expect(far.reservedCount).toBe(0);
  });

  it('blok, ku ktorému po ceste nevedie cesta (odrezaný úsek), sa ignoruje', () => {
    const { world } = dispatchWorld();
    const far = placeYard(world, YARD_F);
    const west = placeYard(world, YARD_W);
    execute(world, { type: 'RemoveRoad', cells: [{ x: 39, y: 18 }] }); // W je odrezaný od berthu
    expect(chooseYardSlot(world, newUnit(world), berthOf(world))?.moduleId).toBe(far.id);
    expect(distanceBetweenModules(world, berthOf(world), west)).toBe(Infinity);
    expect(YARD_W_ACCESS.x).toBeLessThan(39);
    expect(YARD_F_ACCESS.x).toBeGreaterThan(39);
  });
});
