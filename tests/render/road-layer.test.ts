import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { DIRECTIONS_4, Grid, loadBundledMap, type CellCoord, type Rect } from '@sim/grid';
import { AUTOTILE_SHAPE_BASE_MASK, type AutotileShape } from '@render/autotile';
import {
  ROAD_BAND_CELLS,
  ROAD_MARKING_CELLS,
  RoadLayer,
  roadBodyRects,
  roadMarkingPaths,
} from '@render/road-layer';
import { loadRenderPalette, tokenResolverFromCss } from '@render/tokens';

const PALETTE = loadRenderPalette(
  tokenResolverFromCss(readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8')),
);

const SHAPES = Object.keys(AUTOTILE_SHAPE_BASE_MASK) as AutotileShape[];

/** Prázdna pevnina `size × size`. */
function emptyGrid(size: number): Grid {
  return new Grid(size, size, () => ({ terrain: 'land' }));
}

function setRoad(grid: Grid, cells: readonly CellCoord[], road: 'road' | 'none' = 'road'): void {
  for (const { x, y } of cells) grid.at(x, y).road = road;
}

/** Obdĺžnik sa dotýka hrany bunky v danom smere (v jednotkách buniek). */
function touches(rect: Rect, dx: number, dy: number): boolean {
  if (dy < 0) return rect.y === 0;
  if (dy > 0) return rect.y + rect.h === 1;
  if (dx < 0) return rect.x === 0;
  return rect.x + rect.w === 1;
}

describe('roadBodyRects', () => {
  it.each(SHAPES)('%s: telo cesty siaha na hranu bunky presne v smeroch masky tvaru', (shape) => {
    const rects = roadBodyRects(shape);
    for (const { bit, dx, dy } of DIRECTIONS_4) {
      const expected = (AUTOTILE_SHAPE_BASE_MASK[shape] & bit) !== 0;
      expect(rects.some((rect) => touches(rect, dx, dy))).toBe(expected);
    }
  });

  it.each(SHAPES)('%s: obdĺžniky ležia v bunke a majú šírku pásu cesty', (shape) => {
    for (const rect of roadBodyRects(shape)) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(1);
      expect(rect.y + rect.h).toBeLessThanOrEqual(1);
      expect(Math.min(rect.w, rect.h)).toBeCloseTo(ROAD_BAND_CELLS, 9);
    }
  });
});

describe('roadMarkingPaths', () => {
  it.each(SHAPES)('%s: čiara vedie zo stredu bunky k hrane v každom smere masky tvaru', (shape) => {
    const paths = roadMarkingPaths(shape);
    expect(paths.length).toBeGreaterThan(0);
    for (const point of paths.flat()) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
    for (const { bit, dx, dy } of DIRECTIONS_4) {
      const expected = (AUTOTILE_SHAPE_BASE_MASK[shape] & bit) !== 0;
      const reachesEdge = paths.some((path) =>
        path.some((p) => (dy < 0 && p.y === 0) || (dy > 0 && p.y === 1) || (dx < 0 && p.x === 0) || (dx > 0 && p.x === 1)),
      );
      expect(reachesEdge).toBe(expected);
    }
  });
});

describe('RoadLayer (Pixi scene graph bez renderera)', () => {
  it('konštanty sú zlomky bunky', () => {
    expect(ROAD_BAND_CELLS).toBeGreaterThan(0);
    expect(ROAD_BAND_CELLS).toBeLessThan(1);
    expect(ROAD_MARKING_CELLS).toBeLessThan(ROAD_BAND_CELLS);
  });

  it('prázdna mriežka → žiadne dlaždice', () => {
    const layer = new RoadLayer(emptyGrid(6), PALETTE);
    expect(layer.view).toBeInstanceOf(Container);
    expect(layer.tileCount).toBe(0);
    expect(layer.view.children).toHaveLength(0);
  });

  it('konštruktor nakreslí cesty, ktoré už sú v mriežke (starter cesty)', () => {
    const map = loadBundledMap();
    const layer = new RoadLayer(map.createGrid(), PALETTE);
    expect(layer.tileCount).toBe(map.starter.roads.length);
    expect(layer.view.children).toHaveLength(map.starter.roads.length);
  });

  it('dlaždica má tvar + rotáciu podľa autotile a je umiestnená na stred bunky', () => {
    const grid = emptyGrid(6);
    setRoad(grid, [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
    ]);
    const layer = new RoadLayer(grid, PALETTE);
    expect(layer.tileAt(2, 2)).toEqual({ shape: 'corner', rotation: 90 });
    expect(layer.tileAt(3, 2)).toEqual({ shape: 'end', rotation: 270 });
    expect(layer.tileAt(2, 3)).toEqual({ shape: 'end', rotation: 0 });
    expect(layer.tileAt(0, 0)).toBeUndefined();

    const cell = PALETTE.cellPx;
    const graphics = layer.view.children.filter((child): child is Graphics => child instanceof Graphics);
    expect(graphics).toHaveLength(3);
    const corner = graphics.find((g) => g.position.x === 2.5 * cell && g.position.y === 2.5 * cell);
    expect(corner).toBeDefined();
    expect(corner?.angle).toBe(90);
    expect(corner?.pivot.x).toBe(cell / 2);
    expect(corner?.pivot.y).toBe(cell / 2);
  });

  it('updateRoads: nová cesta pripojená k existujúcej zmení aj susedovu dlaždicu', () => {
    const grid = emptyGrid(8);
    setRoad(grid, [{ x: 3, y: 3 }]);
    const layer = new RoadLayer(grid, PALETTE);
    expect(layer.tileAt(3, 3)).toEqual({ shape: 'end', rotation: 0 });

    setRoad(grid, [{ x: 4, y: 3 }]);
    layer.updateRoads([{ x: 4, y: 3 }]);
    expect(layer.tileCount).toBe(2);
    expect(layer.tileAt(3, 3)).toEqual({ shape: 'end', rotation: 90 });
    expect(layer.tileAt(4, 3)).toEqual({ shape: 'end', rotation: 270 });

    setRoad(grid, [{ x: 5, y: 3 }]);
    layer.updateRoads([{ x: 5, y: 3 }]);
    expect(layer.tileAt(4, 3)).toEqual({ shape: 'straight', rotation: 90 });
  });

  it('updateRoads prekreslí len dotknuté bunky a susedov: vzdialené dlaždice ostanú tie isté objekty', () => {
    const grid = emptyGrid(12);
    setRoad(grid, [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 9, y: 9 },
    ]);
    const layer = new RoadLayer(grid, PALETTE);
    const before = new Map(layer.view.children.map((child) => [`${String(child.x)},${String(child.y)}`, child]));

    setRoad(grid, [{ x: 4, y: 1 }]);
    const changed = layer.updateRoads([{ x: 4, y: 1 }]);
    // nová dlaždica (4,1) + zmenená (3,1): end → straight; ostatné nedotknuté
    expect(changed).toBe(2);

    const cell = PALETTE.cellPx;
    const same = (x: number, y: number): boolean =>
      layer.view.children.includes(before.get(`${String((x + 0.5) * cell)},${String((y + 0.5) * cell)}`) as Container);
    expect(same(1, 1)).toBe(true);
    expect(same(2, 1)).toBe(true);
    expect(same(9, 9)).toBe(true);
    expect(same(3, 1)).toBe(false); // (3,1) bola end → teraz straight
    expect(layer.tileCount).toBe(5);
  });

  it('updateRoads bez zmeny tvaru nerobí nič (idempotentné)', () => {
    const grid = emptyGrid(6);
    setRoad(grid, [{ x: 2, y: 2 }]);
    const layer = new RoadLayer(grid, PALETTE);
    expect(layer.updateRoads([{ x: 2, y: 2 }])).toBe(0);
    expect(layer.updateRoads([])).toBe(0);
  });

  it('odstránená cesta zmizne a susedia sa prekreslia', () => {
    const grid = emptyGrid(6);
    const cells = [
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ];
    setRoad(grid, cells);
    const layer = new RoadLayer(grid, PALETTE);
    expect(layer.tileAt(2, 2)).toEqual({ shape: 'straight', rotation: 90 });

    setRoad(grid, [{ x: 3, y: 2 }], 'none');
    const changed = layer.updateRoads([{ x: 3, y: 2 }]);
    expect(changed).toBe(2); // zmizne (3,2), (2,2) sa zmení na end
    expect(layer.tileAt(3, 2)).toBeUndefined();
    expect(layer.tileAt(2, 2)).toEqual({ shape: 'end', rotation: 270 });
    expect(layer.tileCount).toBe(2);
    expect(layer.view.children).toHaveLength(2);
  });

  it('koľaj sa v RoadLayer nekreslí a nespája sa s cestou', () => {
    const grid = emptyGrid(6);
    setRoad(grid, [{ x: 2, y: 2 }]);
    grid.at(3, 2).road = 'rail';
    const layer = new RoadLayer(grid, PALETTE);
    expect(layer.tileCount).toBe(1);
    expect(layer.tileAt(2, 2)).toEqual({ shape: 'end', rotation: 0 });
  });

  it('rebuild znova nakreslí všetko podľa mriežky a destroy uvoľní dlaždice', () => {
    const grid = emptyGrid(6);
    const layer = new RoadLayer(grid, PALETTE);
    setRoad(grid, [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ]);
    layer.rebuild();
    expect(layer.tileCount).toBe(2);
    layer.destroy();
    expect(layer.view.destroyed).toBe(true);
  });
});
