import { describe, expect, it } from 'vitest';
import { Container, Graphics, Sprite } from 'pixi.js';
import { loadBundledMap } from '@sim/grid';
import { coastTile } from '@render/coast';
import { TerrainLayer } from '@render/terrain-layer';
import { PALETTE, StubTextures } from './stub-textures';

describe('TerrainLayer so spritmi (Pixi scene graph bez renderera)', () => {
  const grid = loadBundledMap().createGrid();
  const textures = new StubTextures();
  const layer = new TerrainLayer(grid, PALETTE, textures);

  it('jeden sprite na bunku, žiadny Graphics; vrstva je statická render group', () => {
    expect(layer.spriteCount).toBe(grid.width * grid.height);
    expect(layer.view.children).toHaveLength(layer.spriteCount);
    expect(layer.view.children.every((child) => child instanceof Sprite)).toBe(true);
    expect(layer.view.children.some((child) => child instanceof Graphics)).toBe(false);
    expect(layer.view).toBeInstanceOf(Container);
    expect(layer.view.isRenderGroup).toBe(true);
  });

  it('sprite každej bunky = `coastTile` (textúra z atlasu podľa id)', () => {
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const id = coastTile(grid, x, y);
        expect(layer.tileIdAt(x, y)).toBe(id);
        const sprite = layer.view.children[grid.index(x, y)] as Sprite;
        expect(sprite.texture).toBe(textures.textureFor(`terrain/${id}`));
      }
    }
  });

  it('príklady harbor_01 z karty T01-16', () => {
    expect(layer.tileIdAt(0, 0)).toBe('water_deep');
    expect(layer.tileIdAt(28, 17)).toBe('water_edge_w');
    expect(layer.tileIdAt(59, 17)).toBe('water_edge_e');
    expect(layer.tileIdAt(92, 18)).toBe('water_inner_nw');
    expect(layer.tileIdAt(34, 33)).toBe('water_corner_sw');
    expect(layer.tileIdAt(6, 12)).toBe('quay_edge_n');
    expect(layer.tileIdAt(12, 47)).toBe('blocked');
    expect(layer.tileIdAt(-1, 0)).toBeUndefined();
    expect(layer.tileIdAt(grid.width, 0)).toBeUndefined();
  });

  it('sprity ležia na mriežke `--cell` a majú veľkosť bunky', () => {
    const cell = PALETTE.cellPx;
    for (const [x, y] of [
      [0, 0],
      [5, 12],
      [95, 63],
    ] as const) {
      const sprite = layer.view.children[grid.index(x, y)] as Sprite;
      expect(sprite.position.x).toBe(x * cell);
      expect(sprite.position.y).toBe(y * cell);
      expect(sprite.width).toBeCloseTo(cell, 6);
      expect(sprite.height).toBeCloseTo(cell, 6);
    }
  });

  it('rozmer vrstvy = mapa × `--cell`', () => {
    const bounds = layer.view.getLocalBounds();
    expect(bounds.minX).toBeCloseTo(0, 6);
    expect(bounds.minY).toBeCloseTo(0, 6);
    expect(bounds.maxX).toBeCloseTo(grid.width * PALETTE.cellPx, 6);
    expect(bounds.maxY).toBeCloseTo(grid.height * PALETTE.cellPx, 6);
  });

  it('rebuild nahradí sprity (nie pridá) a stav ostane rovnaký', () => {
    const local = new TerrainLayer(grid, PALETTE, new StubTextures());
    const first = local.view.children[0];
    local.rebuild();
    expect(local.view.children).toHaveLength(grid.width * grid.height);
    expect(local.view.children[0]).not.toBe(first);
    expect(local.tileIdAt(92, 18)).toBe('water_inner_nw');
  });

  it('bez textúr ostáva `Graphics` fallback (jeden Graphics, žiadne sprity)', () => {
    const fallback = new TerrainLayer(grid, PALETTE, null);
    expect(fallback.spriteCount).toBe(0);
    expect(fallback.tileIdAt(5, 11)).toBeUndefined();
    expect(fallback.view.children).toHaveLength(1);
    expect(fallback.view.children[0]).toBeInstanceOf(Graphics);
  });
});
