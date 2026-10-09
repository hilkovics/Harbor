import { describe, expect, it } from 'vitest';
import { Graphics, Sprite } from 'pixi.js';
import { loadBundledMap } from '@sim/grid';
import { PortalLayer, portalRotation } from '@render/portal-layer';
import { PALETTE, StubTextures } from './stub-textures';

describe('portalRotation (šípka von z mapy: sever = 0°)', () => {
  it.each([
    [{ x: 10, y: 0 }, 0],
    [{ x: 19, y: 5 }, 90],
    [{ x: 10, y: 9 }, 180],
    [{ x: 0, y: 5 }, 270],
  ] as const)('bunka %j na mape 20×10 → %i°', (cell, expected) => {
    expect(portalRotation(cell, 20, 10)).toBe(expected);
  });

  it('roh mapy: prvý zodpovedajúci okraj v poradí sever, východ, juh, západ', () => {
    expect(portalRotation({ x: 0, y: 0 }, 20, 10)).toBe(0);
    expect(portalRotation({ x: 19, y: 0 }, 20, 10)).toBe(0);
    expect(portalRotation({ x: 19, y: 9 }, 20, 10)).toBe(90);
    expect(portalRotation({ x: 0, y: 9 }, 20, 10)).toBe(180);
  });

  it('bunka mimo okraja je chyba', () => {
    expect(() => portalRotation({ x: 5, y: 5 }, 20, 10)).toThrow(RangeError);
  });
});

describe('PortalLayer (Pixi scene graph bez renderera)', () => {
  const map = loadBundledMap();
  const { width, height } = map;

  it('harbor_01: road_south_in (44,63) → juh 180°, road_west_in (0,60) → západ 270°, rail_east (95,24) → východ 90°', () => {
    const layer = new PortalLayer(map, width, height, PALETTE, new StubTextures());
    expect(layer.portalCount).toBe(5);
    expect(layer.portalOf('road_south_in')).toEqual({ kind: 'road', rotation: 180 });
    expect(layer.portalOf('road_west_in')).toEqual({ kind: 'road', rotation: 270 });
    expect(layer.portalOf('rail_east')).toEqual({ kind: 'rail', rotation: 90 });
    expect(layer.portalOf('neexistuje')).toBeUndefined();
  });

  it('sprity `portal_road` / `portal_rail` na strede bunky portálu, otočené okolo stredu', () => {
    const textures = new StubTextures();
    const layer = new PortalLayer(map, width, height, PALETTE, textures);
    expect(layer.view.isRenderGroup).toBe(true);
    const sprites = layer.view.children as Sprite[];
    expect(sprites.every((child) => child instanceof Sprite)).toBe(true);
    const cell = PALETTE.cellPx;

    const road = sprites.find((sprite) => sprite.texture === textures.textureFor('terrain/portal_road'));
    expect(road?.position.x).toBe((44 + 0.5) * cell);
    expect(road?.position.y).toBe((63 + 0.5) * cell);
    expect(road?.angle).toBe(180);
    expect(road?.anchor.x).toBe(0.5);
    expect(road?.width).toBeCloseTo(cell, 6);

    const rail = sprites.find((sprite) => sprite.texture === textures.textureFor('terrain/portal_rail'));
    expect(rail?.position.x).toBe((95 + 0.5) * cell);
    expect(rail?.position.y).toBe((24 + 0.5) * cell);
    expect(rail?.angle).toBe(90);
  });

  it('portál mimo okraja mapy je chyba konštrukcie', () => {
    const broken = { roadPortals: [{ id: 'x', cell: { x: 5, y: 5 } }], railPortals: [] };
    expect(() => new PortalLayer(broken, width, height, PALETTE, null)).toThrow(RangeError);
  });

  it('bez textúr: Graphics fallback s rovnakou polohou a rotáciou', () => {
    const layer = new PortalLayer(map, width, height, PALETTE, null);
    expect(layer.view.children).toHaveLength(5);
    expect(layer.view.children.every((child) => child instanceof Graphics)).toBe(true);
    const south = layer.view.children[0];
    expect(south.position.x).toBe((44 + 0.5) * PALETTE.cellPx);
    expect(south.angle).toBe(180);
  });
});
