import { describe, expect, it } from 'vitest';
import { Container, Graphics, Sprite } from 'pixi.js';
import { loadBundledMap } from '@sim/grid';
import { coastTile } from '@render/coast';
import { TerrainLayer } from '@render/terrain-layer';
import { PALETTE, StubTextures } from './stub-textures';

describe('TerrainLayer so spritmi (Pixi scene graph bez renderera)', () => {
  const map = loadBundledMap();
  const textures = new StubTextures();
  const layer = new TerrainLayer(map.grid, PALETTE, textures);

  it('jeden sprite na bunku, žiadny Graphics; vrstva je statická render group', () => {
    expect(layer.spriteCount).toBe(map.grid.width * map.grid.height);
    expect(layer.view.children).toHaveLength(layer.spriteCount);
    expect(layer.view.children.every((child) => child instanceof Sprite)).toBe(true);
    expect(layer.view.children.some((child) => child instanceof Graphics)).toBe(false);
    expect(layer.view).toBeInstanceOf(Container);
    expect(layer.view.isRenderGroup).toBe(true);
  });

  it('sprite každej bunky = `coastTile` (textúra z atlasu podľa id)', () => {
    for (let y = 0; y < map.grid.height; y++) {
      for (let x = 0; x < map.grid.width; x++) {
        const id = coastTile(map.grid, x, y);
        expect(layer.tileIdAt(x, y)).toBe(id);
        const sprite = layer.view.children[map.grid.index(x, y)] as Sprite;
        expect(sprite.texture).toBe(textures.textureFor(`terrain/${id}`));
      }
    }
  });

  it('príklady harbor_01 z karty T01-16', () => {
    expect(layer.tileIdAt(0, 11)).toBe('water_edge_n');
    expect(layer.tileIdAt(5, 11)).toBe('water_inner_ne');
    expect(layer.tileIdAt(5, 12)).toBe('water_corner_ne');
    expect(layer.tileIdAt(9, 13)).toBe('water_edge_e');
    expect(layer.tileIdAt(10, 14)).toBe('quay_edge_n');
    expect(layer.tileIdAt(80, 28)).toBe('blocked');
    expect(layer.tileIdAt(-1, 0)).toBeUndefined();
    expect(layer.tileIdAt(map.grid.width, 0)).toBeUndefined();
  });

  it('sprity ležia na mriežke `--cell` a majú veľkosť bunky', () => {
    const cell = PALETTE.cellPx;
    for (const [x, y] of [
      [0, 0],
      [5, 12],
      [95, 63],
    ] as const) {
      const sprite = layer.view.children[map.grid.index(x, y)] as Sprite;
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
    expect(bounds.maxX).toBeCloseTo(map.grid.width * PALETTE.cellPx, 6);
    expect(bounds.maxY).toBeCloseTo(map.grid.height * PALETTE.cellPx, 6);
  });

  it('rebuild nahradí sprity (nie pridá) a stav ostane rovnaký', () => {
    const local = new TerrainLayer(map.grid, PALETTE, new StubTextures());
    const first = local.view.children[0];
    local.rebuild();
    expect(local.view.children).toHaveLength(map.grid.width * map.grid.height);
    expect(local.view.children[0]).not.toBe(first);
    expect(local.tileIdAt(5, 11)).toBe('water_inner_ne');
  });

  it('bez textúr ostáva `Graphics` fallback (jeden Graphics, žiadne sprity)', () => {
    const fallback = new TerrainLayer(map.grid, PALETTE, null);
    expect(fallback.spriteCount).toBe(0);
    expect(fallback.tileIdAt(5, 11)).toBeUndefined();
    expect(fallback.view.children).toHaveLength(1);
    expect(fallback.view.children[0]).toBeInstanceOf(Graphics);
  });
});
