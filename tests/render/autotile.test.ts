import { describe, expect, it } from 'vitest';
import { DIRECTIONS_4, Grid, type CellCoord, type RoadLayer } from '@sim/grid';
import {
  AUTOTILE_SHAPE_BASE_MASK,
  AUTOTILE_TABLE,
  autotileAffected,
  autotileMask,
  autotileShape,
  autotileTile,
  rotateMask,
  type AutotileShape,
} from '@render/autotile';

const N = 1;
const E = 2;
const S = 4;
const W = 8;

/** Tabuľka z docs/tasks/phase-01.md (T01-08): maska → tvar + rotácia (v smere hodinových ručičiek). */
const CARD_TABLE: ReadonlyArray<readonly [mask: number, shape: AutotileShape, rotation: 0 | 90 | 180 | 270]> = [
  [0, 'end', 0],
  [1, 'end', 0],
  [2, 'end', 90],
  [3, 'corner', 0],
  [4, 'end', 180],
  [5, 'straight', 0],
  [6, 'corner', 90],
  [7, 't', 90],
  [8, 'end', 270],
  [9, 'corner', 270],
  [10, 'straight', 90],
  [11, 't', 0],
  [12, 'corner', 180],
  [13, 't', 270],
  [14, 't', 180],
  [15, 'cross', 0],
];

/** Mriežka `size × size` samej pevniny; `roads` sú cesty, `rails` koľaje. */
function gridWith(size: number, roads: readonly CellCoord[], rails: readonly CellCoord[] = []): Grid {
  const grid = new Grid(size, size, () => ({ terrain: 'land' }));
  for (const { x, y } of roads) grid.at(x, y).road = 'road';
  for (const { x, y } of rails) grid.at(x, y).road = 'rail';
  return grid;
}

describe('autotileShape (tabuľka z karty)', () => {
  it('tabuľka má presne 16 masiek', () => {
    expect(CARD_TABLE).toHaveLength(16);
    expect(AUTOTILE_TABLE).toHaveLength(16);
  });

  it.each(CARD_TABLE)('maska %i → %s, rotácia %i', (mask, shape, rotation) => {
    expect(autotileShape(mask)).toEqual({ shape, rotation });
  });

  it('základné orientácie (DESIGN_BRIEF §5.2): end na sever, straight zvislá, corner N→E, t bez juhu, cross', () => {
    expect(AUTOTILE_SHAPE_BASE_MASK).toEqual({ end: N, straight: N | S, corner: N | E, t: N | E | W, cross: N | E | S | W });
  });

  it.each(CARD_TABLE.filter(([mask]) => mask !== 0))(
    'maska %i: otočenie základnej masky tvaru %s o %i° v smere hodinových ručičiek dáva späť masku',
    (mask, shape, rotation) => {
      expect(rotateMask(AUTOTILE_SHAPE_BASE_MASK[shape], rotation)).toBe(mask);
    },
  );

  it('rotateMask: 90° posunie N→E→S→W→N', () => {
    expect(rotateMask(N, 90)).toBe(E);
    expect(rotateMask(E, 90)).toBe(S);
    expect(rotateMask(S, 90)).toBe(W);
    expect(rotateMask(W, 90)).toBe(N);
    expect(rotateMask(N | E, 180)).toBe(S | W);
    expect(rotateMask(N, 270)).toBe(W);
    expect(rotateMask(N | E | S | W, 90)).toBe(N | E | S | W);
  });

  it.each([-1, 16, 1.5, Number.NaN])('neplatná maska %s → RangeError', (mask) => {
    expect(() => autotileShape(mask)).toThrow(RangeError);
  });
});

describe('autotileMask', () => {
  it('bity sú N=1, E=2, S=4, W=8 (DIRECTIONS_4)', () => {
    expect(DIRECTIONS_4.map((d) => [d.name, d.bit])).toEqual([
      ['N', N],
      ['E', E],
      ['S', S],
      ['W', W],
    ]);
  });

  it('izolovaná cesta → 0', () => {
    const grid = gridWith(5, [{ x: 2, y: 2 }]);
    expect(autotileMask(grid, 2, 2, 'road')).toBe(0);
  });

  it.each([
    ['sever', { x: 2, y: 1 }, N],
    ['východ', { x: 3, y: 2 }, E],
    ['juh', { x: 2, y: 3 }, S],
    ['západ', { x: 1, y: 2 }, W],
  ] as const)('jediný sused na %s', (_name, neighbor, expected) => {
    const grid = gridWith(5, [{ x: 2, y: 2 }, neighbor]);
    expect(autotileMask(grid, 2, 2, 'road')).toBe(expected);
  });

  it('kríž → 15, T bez juhu → 11', () => {
    const cross = gridWith(5, [
      { x: 2, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 1, y: 2 },
    ]);
    expect(autotileMask(cross, 2, 2, 'road')).toBe(N | E | S | W);
    const t = gridWith(5, [
      { x: 2, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
      { x: 1, y: 2 },
    ]);
    expect(autotileMask(t, 2, 2, 'road')).toBe(N | E | W);
  });

  it('susedia mimo mapy sa nepočítajú (roh a okraj mapy)', () => {
    const grid = gridWith(3, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    expect(autotileMask(grid, 0, 0, 'road')).toBe(E | S);
    expect(autotileMask(grid, 2, 2, 'road')).toBe(0);
  });

  it('spája len rovnakú vrstvu: koľaj nie je sused cesty a naopak', () => {
    const grid = gridWith(5, [{ x: 2, y: 2 }, { x: 2, y: 1 }], [{ x: 3, y: 2 }]);
    expect(autotileMask(grid, 2, 2, 'road')).toBe(N);
    grid.at(2, 2).road = 'rail';
    expect(autotileMask(grid, 3, 2, 'rail' satisfies RoadLayer)).toBe(W);
  });

  it('bunka mimo mapy → RangeError', () => {
    const grid = gridWith(3, []);
    expect(() => autotileMask(grid, 3, 0, 'road')).toThrow(RangeError);
  });
});

describe('autotileTile', () => {
  it('bunka bez tejto vrstvy → null; cesta → tvar + rotácia podľa masky', () => {
    const grid = gridWith(5, [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
    ]);
    expect(autotileTile(grid, 0, 0, 'road')).toBeNull();
    expect(autotileTile(grid, 2, 2, 'rail')).toBeNull();
    expect(autotileTile(grid, 2, 2, 'road')).toEqual({ shape: 'corner', rotation: 90 });
    expect(autotileTile(grid, 3, 2, 'road')).toEqual({ shape: 'end', rotation: 270 });
    expect(autotileTile(grid, 2, 3, 'road')).toEqual({ shape: 'end', rotation: 0 });
  });
});

describe('autotileAffected (dotknuté bunky + susedia)', () => {
  const key = (c: CellCoord): string => `${String(c.x)},${String(c.y)}`;

  it('vnútri mapy: bunka a jej 4 susedia', () => {
    const grid = gridWith(5, []);
    const cells = autotileAffected(grid, [{ x: 2, y: 2 }]);
    expect(cells.map(key).sort()).toEqual(['1,2', '2,1', '2,2', '2,3', '3,2']);
  });

  it('roh mapy vynechá bunky mimo mapy', () => {
    const grid = gridWith(5, []);
    const cells = autotileAffected(grid, [{ x: 0, y: 0 }]);
    expect(cells.map(key).sort()).toEqual(['0,0', '0,1', '1,0']);
  });

  it('susedné bunky sa nezdvojujú a poradie je deterministické', () => {
    const grid = gridWith(6, []);
    const input = [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 2 },
    ];
    const cells = autotileAffected(grid, input);
    expect(new Set(cells.map(key)).size).toBe(cells.length);
    expect(cells.map(key).sort()).toEqual(['1,2', '2,1', '2,2', '2,3', '3,1', '3,2', '3,3', '4,2']);
    expect(autotileAffected(grid, input)).toEqual(cells);
  });

  it('bunka mimo mapy vo vstupe sa ignoruje, prázdny vstup → prázdny výstup', () => {
    const grid = gridWith(3, []);
    expect(autotileAffected(grid, [{ x: 10, y: 10 }])).toEqual([]);
    expect(autotileAffected(grid, [])).toEqual([]);
  });
});
