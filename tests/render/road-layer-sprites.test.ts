import { describe, expect, it } from 'vitest';
import { Graphics, Sprite } from 'pixi.js';
import { Grid, loadBundledMap, type CellCoord } from '@sim/grid';
import { AUTOTILE_TABLE } from '@render/autotile';
import { RoadLayer } from '@render/road-layer';
import { PALETTE, StubTextures } from './stub-textures';

function emptyGrid(size: number): Grid {
  return new Grid(size, size, () => ({ terrain: 'land' }));
}

function setRoad(grid: Grid, cells: readonly CellCoord[], road: 'road' | 'none' = 'road'): void {
  for (const { x, y } of cells) grid.at(x, y).road = road;
}

const spriteAt = (layer: RoadLayer, x: number, y: number): Sprite | undefined =>
  layer.view.children.find(
    (child): child is Sprite => child instanceof Sprite && child.x === (x + 0.5) * PALETTE.cellPx && child.y === (y + 0.5) * PALETTE.cellPx,
  );

describe('RoadLayer so spritmi (Pixi scene graph bez renderera)', () => {
  it('vrstva je vlastná render group; dlaždica je Sprite s textúrou `infra.road.<tvar>` a rotáciou z tabuľky', () => {
    const grid = emptyGrid(6);
    setRoad(grid, [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
    ]);
    const textures = new StubTextures();
    const layer = new RoadLayer(grid, PALETTE, textures);
    expect(layer.view.isRenderGroup).toBe(true);
    expect(layer.view.children.every((child) => child instanceof Sprite)).toBe(true);
    expect(layer.view.children.some((child) => child instanceof Graphics)).toBe(false);

    const corner = spriteAt(layer, 2, 2);
    expect(corner?.texture).toBe(textures.textureFor('infra/road/corner'));
    expect(corner?.angle).toBe(90);
    expect(corner?.anchor.x).toBe(0.5);
    expect(corner?.anchor.y).toBe(0.5);
    expect(corner?.width).toBeCloseTo(PALETTE.cellPx, 6);
    expect(corner?.height).toBeCloseTo(PALETTE.cellPx, 6);

    expect(spriteAt(layer, 3, 2)?.texture).toBe(textures.textureFor('infra/road/end'));
    expect(spriteAt(layer, 3, 2)?.angle).toBe(270);
    expect(spriteAt(layer, 2, 3)?.angle).toBe(0);
  });

  it('odbočky a rohy: sprite a rotácia stredu sedia s tabuľkou T01-08 pre všetky masky 1…15', () => {
    // Stred (5,5) s ramenami podľa masky; dlaždica stredu musí byť presne AUTOTILE_TABLE[maska].
    const arms = [
      { bit: 1, x: 5, y: 4 },
      { bit: 2, x: 6, y: 5 },
      { bit: 4, x: 5, y: 6 },
      { bit: 8, x: 4, y: 5 },
    ];
    for (let mask = 1; mask < 16; mask++) {
      const grid = emptyGrid(11);
      setRoad(grid, [{ x: 5, y: 5 }, ...arms.filter((arm) => (mask & arm.bit) !== 0)]);
      const textures = new StubTextures();
      const layer = new RoadLayer(grid, PALETTE, textures);
      const { shape, rotation } = AUTOTILE_TABLE[mask];
      const center = spriteAt(layer, 5, 5);
      expect(center?.texture, `maska ${String(mask)}`).toBe(textures.textureFor(`infra/road/${shape}`));
      expect(center?.angle, `maska ${String(mask)}`).toBe(rotation);
    }
  });

  it('starter cesty harbor_01 = jeden sprite na cestnú bunku', () => {
    const map = loadBundledMap();
    const layer = new RoadLayer(map.grid, PALETTE, new StubTextures());
    expect(layer.tileCount).toBe(map.starter.roads.length);
    expect(layer.view.children).toHaveLength(map.starter.roads.length);
  });

  it('updateRoads: pripojená cesta zmení susedov, zmizne odstránená, ostatné sprity ostanú tie isté', () => {
    const grid = emptyGrid(12);
    setRoad(grid, [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 9, y: 9 },
    ]);
    const textures = new StubTextures();
    const layer = new RoadLayer(grid, PALETTE, textures);
    const far = spriteAt(layer, 9, 9);
    const before = spriteAt(layer, 3, 1);
    expect(before?.texture).toBe(textures.textureFor('infra/road/end'));

    setRoad(grid, [{ x: 4, y: 1 }]);
    expect(layer.updateRoads([{ x: 4, y: 1 }])).toBe(2);
    expect(spriteAt(layer, 3, 1)).not.toBe(before);
    expect(spriteAt(layer, 3, 1)?.texture).toBe(textures.textureFor('infra/road/straight'));
    expect(spriteAt(layer, 3, 1)?.angle).toBe(90);
    expect(spriteAt(layer, 9, 9)).toBe(far);

    setRoad(grid, [{ x: 4, y: 1 }], 'none');
    expect(layer.updateRoads([{ x: 4, y: 1 }])).toBe(2);
    expect(spriteAt(layer, 4, 1)).toBeUndefined();
    expect(layer.view.children).toHaveLength(4);
  });

  it('zničenie dlaždice ani vrstvy neničí zdieľanú textúru z atlasu', () => {
    const grid = emptyGrid(6);
    setRoad(grid, [{ x: 2, y: 2 }]);
    const textures = new StubTextures();
    const layer = new RoadLayer(grid, PALETTE, textures);
    const texture = textures.textureFor('infra/road/end');
    setRoad(grid, [{ x: 2, y: 2 }], 'none');
    layer.updateRoads([{ x: 2, y: 2 }]);
    expect(texture.destroyed).toBe(false);
    layer.destroy();
    expect(texture.destroyed).toBe(false);
  });
});
