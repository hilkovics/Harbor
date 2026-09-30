import { describe, expect, it } from 'vitest';
import { Grid, isWater, loadBundledMap, type Rect, type TerrainType } from '@sim/grid';
import { Container, Graphics } from 'pixi.js';
import {
  FOAM_THICKNESS_CELLS,
  QUAY_EDGE_THICKNESS_CELLS,
  TERRAIN_FILL_KEYS,
  TerrainLayer,
  planTerrain,
  terrainFillKey,
  type TerrainFillKey,
} from '@render/terrain-layer';
import { loadRenderPalette, tokenResolverFromCss } from '@render/tokens';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PALETTE = loadRenderPalette(
  tokenResolverFromCss(readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8')),
);

/** Mriežka `rows[0].length × rows.length` podľa zoznamu typov terénu po riadkoch. */
function gridOf(rows: readonly (readonly TerrainType[])[]): Grid {
  return new Grid(rows[0].length, rows.length, (x, y) => ({ terrain: rows[y][x] }));
}

const area = (rects: readonly Rect[]): number => rects.reduce((sum, r) => sum + r.w * r.h, 0);

describe('terrainFillKey', () => {
  it.each([
    ['deep_water', 0, 0, 'waterDeep'],
    ['shallow_water', 3, 1, 'waterShallow'],
    ['quay', 5, 5, 'quay'],
    ['blocked', 1, 1, 'blocked'],
  ] as const)('%s → %s', (terrain, x, y, expected) => {
    expect(terrainFillKey(terrain, x, y)).toBe(expected);
  });

  it('pevnina tvorí šachovnicu 2×2 buniek (land / land-alt)', () => {
    const at = (x: number, y: number): TerrainFillKey => terrainFillKey('land', x, y);
    expect([at(0, 0), at(1, 0), at(1, 1), at(0, 1)]).toEqual(['land', 'land', 'land', 'land']);
    expect([at(2, 0), at(3, 0), at(2, 1), at(3, 1)]).toEqual(['landAlt', 'landAlt', 'landAlt', 'landAlt']);
    expect([at(0, 2), at(1, 3)]).toEqual(['landAlt', 'landAlt']);
    expect([at(2, 2), at(3, 3)]).toEqual(['land', 'land']);
  });
});

describe('planTerrain', () => {
  // riadok 0 hlboká, 1 plytká, 2 nábrežie, 3 pevnina (šírka 4)
  const grid = gridOf([
    ['deep_water', 'deep_water', 'deep_water', 'deep_water'],
    ['shallow_water', 'shallow_water', 'shallow_water', 'shallow_water'],
    ['quay', 'quay', 'quay', 'quay'],
    ['land', 'land', 'land', 'land'],
  ]);
  const plan = planTerrain(grid);

  it('susedné bunky rovnakej výplne v riadku sa zlúčia do jedného obdĺžnika', () => {
    expect(plan.fills.waterDeep).toEqual([{ x: 0, y: 0, w: 4, h: 1 }]);
    expect(plan.fills.waterShallow).toEqual([{ x: 0, y: 1, w: 4, h: 1 }]);
    expect(plan.fills.quay).toEqual([{ x: 0, y: 2, w: 4, h: 1 }]);
    expect(plan.fills.landAlt).toEqual([{ x: 0, y: 3, w: 2, h: 1 }]);
    expect(plan.fills.land).toEqual([{ x: 2, y: 3, w: 2, h: 1 }]);
    expect(plan.fills.blocked).toEqual([]);
  });

  it('pena len na hrane vody s pevninou/nábrežím (nie medzi hlbokou a plytkou)', () => {
    const t = FOAM_THICKNESS_CELLS;
    expect(plan.foam).toHaveLength(4);
    for (let x = 0; x < 4; x++) {
      expect(plan.foam).toContainEqual({ x, y: 1 + 1 - t, w: 1, h: t });
    }
  });

  it('hrana nábrežia len k vode', () => {
    const t = QUAY_EDGE_THICKNESS_CELLS;
    expect(plan.quayEdge).toHaveLength(4);
    for (let x = 0; x < 4; x++) {
      expect(plan.quayEdge).toContainEqual({ x, y: 2, w: 1, h: t });
    }
  });

  it('okraj mapy nie je hrana (susedia mimo mapy sa ignorujú)', () => {
    const water = planTerrain(gridOf([['deep_water', 'deep_water']]));
    expect(water.foam).toEqual([]);
    expect(water.quayEdge).toEqual([]);
  });

  it('bočné a vertikálne hrany: pena vľavo/vpravo, hrana nábrežia zo všetkých strán s vodou', () => {
    const p = planTerrain(gridOf([['shallow_water', 'quay', 'shallow_water']]));
    expect(p.foam).toEqual(
      expect.arrayContaining([
        { x: 1 - FOAM_THICKNESS_CELLS, y: 0, w: FOAM_THICKNESS_CELLS, h: 1 },
        { x: 2, y: 0, w: FOAM_THICKNESS_CELLS, h: 1 },
      ]),
    );
    expect(p.quayEdge).toEqual(
      expect.arrayContaining([
        { x: 1, y: 0, w: QUAY_EDGE_THICKNESS_CELLS, h: 1 },
        { x: 2 - QUAY_EDGE_THICKNESS_CELLS, y: 0, w: QUAY_EDGE_THICKNESS_CELLS, h: 1 },
      ]),
    );
  });

  it('harbor_01: výplne pokrývajú každú bunku presne raz', () => {
    const grid = loadBundledMap().createGrid();
    const full = planTerrain(grid);
    const total = TERRAIN_FILL_KEYS.reduce((sum, key) => sum + area(full.fills[key]), 0);
    expect(total).toBe(grid.width * grid.height);
    // súčet plôch podľa typu zodpovedá počtu buniek terénu
    let water = 0;
    for (let i = 0; i < grid.cellCount; i++) if (isWater(grid.atIndex(i).terrain)) water++;
    expect(area(full.fills.waterDeep) + area(full.fills.waterShallow)).toBe(water);
    expect(full.foam.length).toBeGreaterThan(0);
    expect(full.quayEdge.length).toBeGreaterThan(0);
  });
});

describe('TerrainLayer (Pixi scene graph bez renderera)', () => {
  it('nakreslí terén do jedného Graphics; rebuild ho nahradí (nie pridá)', () => {
    const layer = new TerrainLayer(loadBundledMap().createGrid(), PALETTE);
    expect(layer.view).toBeInstanceOf(Container);
    expect(layer.view.children).toHaveLength(1);
    expect(layer.view.children[0]).toBeInstanceOf(Graphics);
    const first = layer.view.children[0];
    layer.rebuild();
    expect(layer.view.children).toHaveLength(1);
    expect(layer.view.children[0]).not.toBe(first);
  });

  it('rozmer vrstvy = mapa × `--cell`', () => {
    const grid = loadBundledMap().createGrid();
    const layer = new TerrainLayer(grid, PALETTE);
    const bounds = layer.view.getLocalBounds();
    expect(bounds.minX).toBeCloseTo(0, 6);
    expect(bounds.minY).toBeCloseTo(0, 6);
    expect(bounds.maxX).toBeCloseTo(grid.width * PALETTE.cellPx, 6);
    expect(bounds.maxY).toBeCloseTo(grid.height * PALETTE.cellPx, 6);
  });
});
