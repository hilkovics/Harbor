// StorageAllocator a prístup k modulom (T03-05; ARCHITECTURE §7.3 bod 1, §7.7; ADR-018): prístupová bunka = vonkajšia
// bunka cestného konektora s cestou, vzdialenosti cez DistanceMatrix, najbližší kompatibilný pripojený sklad s voľnou
// kapacitou (stored + reserved < capacity), remíza → menšie id; výber svet nemení.
import { describe, expect, it } from 'vitest';
import { NO_ACCESS, accessCellIndex, allocateStorage, distanceBetweenModules, distanceToModule, isAccessCell, nearestAccessCell } from '@sim/logistics';
import type { BerthModule } from '@sim/modules';
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

const berthOf = (world: ReturnType<typeof dispatchWorld>['world']): BerthModule => world.modules.get(ROOT_BERTH_ID) as BerthModule;

describe('prístup k modulom po ceste', () => {
  it('accessCellIndex / isAccessCell: vonkajšia bunka cestného konektora s cestou; bez cesty NO_ACCESS', () => {
    const { world, depot } = dispatchWorld();
    const berth = berthOf(world);
    expect(berth.connectors.map((connector) => accessCellIndex(world.grid, connector))).toEqual(BERTH_ACCESS.map((cell) => cellIndex(world, cell)));
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
    expect(nearestAccessCell(world, cellIndex(world, { x: 43, y: 17 }), berth)).toBe(cellIndex(world, BERTH_ACCESS[0])); // 2 < 3
    expect(nearestAccessCell(world, cellIndex(world, { x: 44, y: 17 }), berth)).toBe(cellIndex(world, BERTH_ACCESS[1])); // 3 > 2
  });
});

describe('allocateStorage', () => {
  it('najbližší sklad od berthu; pri zhode vzdialeností menšie id (W pred E)', () => {
    const { world } = dispatchWorld();
    const far = placeYard(world, YARD_F);
    const west = placeYard(world, YARD_W);
    const east = placeYard(world, YARD_E);
    expect(west.id).toBeLessThan(east.id);
    expect(allocateStorage(world, berthOf(world), 'container')).toBe(west);
    expect(far.id).toBeLessThan(west.id);
  });

  it('rešpektuje rezervácie: plne rezervovaný sklad sa preskočí (freeCount = capacity − stored − reserved)', () => {
    const { world } = dispatchWorld(dispatchDefs({ yardCapacity: 2 }));
    const west = placeYard(world, YARD_W);
    const east = placeYard(world, YARD_E);
    const far = placeYard(world, YARD_F);
    west.reserve();
    expect(allocateStorage(world, berthOf(world), 'container')).toBe(west);
    west.reserve();
    expect(west.freeCount).toBe(0);
    expect(allocateStorage(world, berthOf(world), 'container')).toBe(east);
    east.reserve();
    east.reserve();
    expect(allocateStorage(world, berthOf(world), 'container')).toBe(far);
    far.reserve();
    far.reserve();
    expect(allocateStorage(world, berthOf(world), 'container')).toBeUndefined();
  });

  it('nepripojený sklad (bez cesty pred konektorom) a sklad inej kategórie sa ignorujú; výber svet nemení', () => {
    const { world } = dispatchWorld();
    placeYard(world, { x: 42, y: 24 }, 0); // bez cesty
    expect(allocateStorage(world, berthOf(world), 'container')).toBeUndefined();
    const far = placeYard(world, YARD_F);
    expect(allocateStorage(world, berthOf(world), 'bulk')).toBeUndefined();
    const before = JSON.stringify(world.serialize());
    expect(allocateStorage(world, berthOf(world), 'container')).toBe(far);
    expect(JSON.stringify(world.serialize())).toBe(before);
    expect(far.reservedCount).toBe(0);
  });

  it('sklad, ku ktorému po ceste nevedie cesta (odrezaný úsek), sa ignoruje', () => {
    const { world } = dispatchWorld();
    const far = placeYard(world, YARD_F);
    const west = placeYard(world, YARD_W);
    execute(world, { type: 'RemoveRoad', cells: [{ x: 39, y: 17 }] }); // W je odrezaný od berthu
    expect(allocateStorage(world, berthOf(world), 'container')).toBe(far);
    expect(distanceBetweenModules(world, berthOf(world), west)).toBe(Infinity);
    expect(YARD_W_ACCESS.x).toBeLessThan(39);
    expect(YARD_F_ACCESS.x).toBeGreaterThan(39);
  });
});
