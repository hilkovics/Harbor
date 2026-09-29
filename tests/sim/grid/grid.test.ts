import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import {
  DIRECTIONS_4,
  Grid,
  TERRAIN_TRAITS,
  TERRAIN_TYPES,
  isRoadBuildable,
  isWater,
  terrainFromChar,
  type CellInit,
  type TerrainType,
} from '@sim/grid';

const W = 5;
const H = 4;

/** Mriežka 5×4, terén podľa riadku (y 0 = hlboká voda … y 3 = pevnina), parcela 'p' na x ≥ 3. */
function sampleGrid(): Grid {
  const rows: TerrainType[] = ['deep_water', 'shallow_water', 'quay', 'land'];
  return new Grid(W, H, (x, y): CellInit => ({
    terrain: rows[y],
    depthClass: rows[y] === 'quay' ? 2 : 0,
    parcelId: x >= 3 ? 'p' : null,
  }));
}

describe('terrain', () => {
  it.each([
    ['~', 'deep_water'],
    ['=', 'shallow_water'],
    ['Q', 'quay'],
    ['.', 'land'],
    ['#', 'blocked'],
  ] as const)('znak %s → %s (§4.7)', (char, terrain) => {
    expect(terrainFromChar(char)).toBe(terrain);
    expect(TERRAIN_TRAITS[terrain].char).toBe(char);
  });

  it.each(['X', '', ' ', 'q', '~~'])('neznámy znak %j → undefined', (char) => {
    expect(terrainFromChar(char)).toBeUndefined();
  });

  it('znaky terénu sú unikátne a pokrývajú všetky typy', () => {
    const chars = TERRAIN_TYPES.map((t) => TERRAIN_TRAITS[t].char);
    expect(new Set(chars).size).toBe(TERRAIN_TYPES.length);
    expect(Object.keys(TERRAIN_TRAITS).sort()).toEqual([...TERRAIN_TYPES].sort());
  });

  it('voda = deep_water, shallow_water; cesta len na land a quay (ADR-006)', () => {
    expect(TERRAIN_TYPES.filter(isWater)).toEqual(['deep_water', 'shallow_water']);
    expect(TERRAIN_TYPES.filter(isRoadBuildable)).toEqual(['quay', 'land']);
  });
});

describe('Grid — konštrukcia', () => {
  it('rozmery a bunky podľa init; dynamické polia prázdne', () => {
    const grid = sampleGrid();
    expect(grid.width).toBe(W);
    expect(grid.height).toBe(H);
    expect(grid.cellCount).toBe(W * H);
    expect(grid.at(0, 0)).toEqual({ terrain: 'deep_water', depthClass: 0, parcelId: null, moduleId: null, road: 'none', traffic: 0 });
    expect(grid.at(4, 2)).toEqual({ terrain: 'quay', depthClass: 2, parcelId: 'p', moduleId: null, road: 'none', traffic: 0 });
  });

  it('predvolené depthClass 0 a parcelId null', () => {
    const grid = new Grid(2, 2, () => ({ terrain: 'land' }));
    expect(grid.at(1, 1).depthClass).toBe(0);
    expect(grid.at(1, 1).parcelId).toBeNull();
  });

  it('init sa volá row-major (y, potom x)', () => {
    const calls: string[] = [];
    new Grid(3, 2, (x, y) => {
      calls.push(`${x},${y}`);
      return { terrain: 'land' };
    });
    expect(calls).toEqual(['0,0', '1,0', '2,0', '0,1', '1,1', '2,1']);
  });

  it.each([
    [0, 3],
    [3, 0],
    [-1, 3],
    [2.5, 3],
    [3, Number.NaN],
    [Number.POSITIVE_INFINITY, 3],
  ])('neplatné rozmery %s×%s → RangeError', (width, height) => {
    expect(() => new Grid(width, height, () => ({ terrain: 'land' }))).toThrow(RangeError);
  });
});

describe('Grid — indexy a prístup', () => {
  it('index je row-major y * width + x', () => {
    const grid = sampleGrid();
    expect(grid.index(0, 0)).toBe(0);
    expect(grid.index(W - 1, 0)).toBe(W - 1);
    expect(grid.index(0, 1)).toBe(W);
    expect(grid.index(W - 1, H - 1)).toBe(W * H - 1);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = grid.index(x, y);
        expect(i).toBe(y * W + x);
        expect(grid.atIndex(i)).toBe(grid.at(x, y));
        expect(grid.coordOf(i)).toEqual({ x, y });
      }
    }
  });

  it('at vracia živú bunku — zápis dynamických polí sa prejaví', () => {
    const grid = sampleGrid();
    const cell = grid.at(2, 3);
    cell.road = 'road';
    cell.moduleId = 7 as EntityId;
    cell.traffic = 3;
    expect(grid.at(2, 3)).toBe(cell);
    expect(grid.at(2, 3).road).toBe('road');
    expect(grid.atIndex(grid.index(2, 3)).moduleId).toBe(7);
  });

  it('inBounds: rohy áno, okolie a necelé súradnice nie', () => {
    const grid = sampleGrid();
    for (const [x, y] of [
      [0, 0],
      [W - 1, 0],
      [0, H - 1],
      [W - 1, H - 1],
    ]) {
      expect(grid.inBounds(x, y)).toBe(true);
    }
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [W, 0],
      [0, H],
      [1.5, 1],
      [1, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
    ]) {
      expect(grid.inBounds(x, y)).toBe(false);
    }
  });

  it.each([
    [-1, 0],
    [0, -1],
    [W, 0],
    [0, H],
    [1.5, 1],
    [-1, 1], // row-major by bez kontroly trafil (W−1, 0)
  ])('at/index/neighbors4 mimo mapy (%s, %s) → RangeError', (x, y) => {
    const grid = sampleGrid();
    expect(() => grid.at(x, y)).toThrow(RangeError);
    expect(() => grid.index(x, y)).toThrow(RangeError);
    expect(() => grid.neighbors4(x, y)).toThrow(RangeError);
  });

  it.each([-1, W * H, 1.5, Number.NaN])('atIndex/coordOf mimo rozsahu (%s) → RangeError', (index) => {
    const grid = sampleGrid();
    expect(() => grid.atIndex(index)).toThrow(RangeError);
    expect(() => grid.coordOf(index)).toThrow(RangeError);
  });

  it('isEdge: bunky na okraji mapy', () => {
    const grid = sampleGrid();
    expect(grid.isEdge(0, 2)).toBe(true);
    expect(grid.isEdge(2, 0)).toBe(true);
    expect(grid.isEdge(W - 1, 1)).toBe(true);
    expect(grid.isEdge(1, H - 1)).toBe(true);
    expect(grid.isEdge(1, 1)).toBe(false);
    expect(grid.isEdge(-1, 0)).toBe(false);
  });
});

describe('Grid — neighbors4 a DIRECTIONS_4', () => {
  it('DIRECTIONS_4: poradie N, E, S, W, bity 1, 2, 4, 8 (y nadol)', () => {
    expect(DIRECTIONS_4).toEqual([
      { name: 'N', dx: 0, dy: -1, bit: 1 },
      { name: 'E', dx: 1, dy: 0, bit: 2 },
      { name: 'S', dx: 0, dy: 1, bit: 4 },
      { name: 'W', dx: -1, dy: 0, bit: 8 },
    ]);
    expect(Object.isFrozen(DIRECTIONS_4)).toBe(true);
  });

  it('vnútorná bunka: N, E, S, W', () => {
    expect(sampleGrid().neighbors4(2, 1)).toEqual([
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 1 },
    ]);
  });

  it('okraj a rohy: susedia mimo mapy sa vynechajú, poradie ostáva', () => {
    const grid = sampleGrid();
    expect(grid.neighbors4(0, 0)).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    expect(grid.neighbors4(W - 1, H - 1)).toEqual([
      { x: W - 1, y: H - 2 },
      { x: W - 2, y: H - 1 },
    ]);
    expect(grid.neighbors4(2, 0)).toEqual([
      { x: 3, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 0 },
    ]);
    expect(grid.neighbors4(0, 2)).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 3 },
    ]);
  });

  it('mriežka 1×1 nemá susedov', () => {
    expect(new Grid(1, 1, () => ({ terrain: 'land' })).neighbors4(0, 0)).toEqual([]);
  });
});

describe('Grid — obdĺžniky', () => {
  it('rectInBounds', () => {
    const grid = sampleGrid();
    expect(grid.rectInBounds({ x: 0, y: 0, w: W, h: H })).toBe(true);
    expect(grid.rectInBounds({ x: 3, y: 2, w: 2, h: 2 })).toBe(true);
    expect(grid.rectInBounds({ x: 4, y: 0, w: 2, h: 1 })).toBe(false);
    expect(grid.rectInBounds({ x: 0, y: 3, w: 1, h: 2 })).toBe(false);
    expect(grid.rectInBounds({ x: -1, y: 0, w: 1, h: 1 })).toBe(false);
    expect(grid.rectInBounds({ x: 0, y: 0, w: 0, h: 1 })).toBe(false);
    expect(grid.rectInBounds({ x: 0, y: 0, w: 1.5, h: 1 })).toBe(false);
  });

  it('rect vracia bunky row-major; mimo mapy RangeError', () => {
    const grid = sampleGrid();
    expect(grid.rect({ x: 1, y: 2, w: 3, h: 2 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ]);
    expect(() => grid.rect({ x: 4, y: 3, w: 2, h: 1 })).toThrow(RangeError);
  });
});

describe('Grid.clone', () => {
  it('hlboká kópia vrátane dynamických polí, nezávislá od originálu', () => {
    const grid = sampleGrid();
    grid.at(1, 3).road = 'road';
    grid.at(2, 3).moduleId = 5 as EntityId;
    grid.at(3, 3).traffic = 1.5;

    const copy = grid.clone();
    expect(copy).not.toBe(grid);
    expect(copy.width).toBe(W);
    expect(copy.height).toBe(H);
    for (let i = 0; i < grid.cellCount; i++) {
      expect(copy.atIndex(i)).toEqual(grid.atIndex(i));
      expect(copy.atIndex(i)).not.toBe(grid.atIndex(i));
    }

    copy.at(1, 3).road = 'rail';
    copy.at(0, 3).road = 'road';
    expect(grid.at(1, 3).road).toBe('road');
    expect(grid.at(0, 3).road).toBe('none');
  });
});
