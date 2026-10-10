// R2 (TR2-03): kontajnery podľa veľkosti, typu a linky — manifest, tokeny, výber sprite a farby linky, `CargoSprite` s `look.container`.
import { Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { CargoSprite, cargoSizePx } from '@render/cargo-sprite';
import { DRY_CONTAINER_TYPE, containerKey, containerLineColor, containerSpriteId, isEmptyContainer, lineTokenOfId } from '@render/container-sprites';
import { cargoSpriteEntry, entitySpriteFiles, vehicleSpreader, vehicleSprite } from '@render/entity-assets';
import type { ContainerVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures, TOKENS } from './stub-textures';
import { parseCssColor } from '@render/tokens';

const CELL = PALETTE.cellPx;

function box(over: Partial<ContainerVM> = {}): ContainerVM {
  return { sizeFt: 20, containerType: 'dry', lineId: 'blue_anchor', direction: 'import', ...over };
}

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

describe('manifest: kontajnery 20′ / 40′ a ECH', () => {
  it.each([
    ['container_20_dry', 64, true],
    ['container_40_dry', 128, true],
    ['container_20_empty', 64, false],
    ['container_40_empty', 128, false],
  ] as const)('%s: %i × 26 px, tónovateľný = %s', (id, width, tintable) => {
    const entry = cargoSpriteEntry(id);
    expect(entry?.size).toEqual({ w: width, h: 26 });
    expect(entry?.file).toBe(`cargo/${id}.svg`);
    expect(entry?.tintable).toBe(tintable);
  });

  it('ECH: sprite `ech` 1×2 bez kontajnera, spreader visí v bode spreaderMount (32; 6) z manifest-fragment.json', () => {
    const handler = vehicleSprite('empty_handler');
    expect(handler?.footprint).toEqual({ w: 1, h: 2 });
    const spreader = vehicleSpreader('empty_handler');
    expect(spreader?.mount).toEqual({ x: 32, y: 6 });
    expect(spreader?.spreader20).toMatchObject({ file: 'entities/ech_spreader_20.svg', footprint: { w: 1, h: 1 }, pivot: { x: 32, y: 32 } });
    expect(spreader?.spreader40).toMatchObject({ file: 'entities/ech_spreader_40.svg', footprint: { w: 2, h: 1 }, pivot: { x: 64, y: 32 } });
    expect(vehicleSpreader('straddle_carrier')).toBeUndefined();
  });

  it('atlas načíta sprity kontajnerov aj spreadery a žiadny súbor sa neopakuje', () => {
    const files = entitySpriteFiles();
    for (const file of ['cargo/container_20_dry.svg', 'cargo/container_40_dry.svg', 'cargo/container_20_empty.svg', 'cargo/container_40_empty.svg', 'entities/ech_spreader_20.svg', 'entities/ech_spreader_40.svg']) {
      expect(files, file).toContain(file);
    }
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('tokeny stohov (design/tokens.css)', () => {
  it('tieň rgba(0,0,0,.32), posun 3 px na poschodie, neutrálny kontajner #D9DDE2, plocha depa --module-roof', () => {
    expect(ENTITY_PALETTE.stack.shadow.color).toBe(0);
    expect(ENTITY_PALETTE.stack.shadow.alpha).toBeCloseTo(0.32, 6);
    expect(ENTITY_PALETTE.stack.shadowStepPx).toBe(3);
    expect(ENTITY_PALETTE.stack.grid.alpha).toBeGreaterThan(0);
    expect(ENTITY_PALETTE.container.neutral.color).toBe(0xd9dde2);
    expect(ENTITY_PALETTE.module.roof).toEqual(parseCssColor(TOKENS('--module-roof')));
  });
});

describe('containerSpriteId', () => {
  it.each([
    [box({ sizeFt: 20 }), 'container_20_dry'],
    [box({ sizeFt: 40 }), 'container_40_dry'],
    [box({ sizeFt: 20, direction: 'empty' }), 'container_20_empty'],
    [box({ sizeFt: 40, direction: 'empty' }), 'container_40_empty'],
    [box({ sizeFt: 40, direction: 'export' }), 'container_40_dry'],
    [box({ sizeFt: 20, direction: 'tranship' }), 'container_20_dry'],
    [box({ sizeFt: 20, containerType: 'reefer' }), 'container_20_reefer'], // R5: vlastný sprite
    [box({ sizeFt: 40, containerType: 'tank' }), 'container_40_dry'], // typ bez sprite → dry
  ])('%j → %s', (container, id) => {
    expect(containerSpriteId(container)).toBe(id);
    expect(cargoSpriteEntry(id)).toBeDefined();
  });

  it('DRY_CONTAINER_TYPE je `dry`, prázdny sa pozná podľa smeru', () => {
    expect(DRY_CONTAINER_TYPE).toBe('dry');
    expect(isEmptyContainer(box({ direction: 'empty' }))).toBe(true);
    expect(isEmptyContainer(box({ direction: 'export' }))).toBe(false);
  });

  it('kľúč štítkov rozlišuje veľkosť, typ, linku aj smer; null a undefined = prázdny kľúč', () => {
    const keys = new Set([box(), box({ sizeFt: 40 }), box({ containerType: 'reefer' }), box({ lineId: null }), box({ direction: 'empty' })].map(containerKey));
    expect(keys.size).toBe(5);
    expect(containerKey(box())).toBe(containerKey(box()));
    expect(containerKey(null)).toBe('');
    expect(containerKey(undefined)).toBe('');
  });
});

describe('farba linky podľa lineId', () => {
  it.each([
    ['blue_anchor', 'line-blue'],
    ['northern_star', 'line-amber'],
    ['golden_wave', 'line-teal'],
  ])('%s → token %s → farba z palety', (lineId, token) => {
    expect(lineTokenOfId(lineId)).toBe(token);
    expect(containerLineColor(ENTITY_PALETTE, lineId)).toBe(ENTITY_PALETTE.line[token]);
  });

  it('priamo zadaný token funguje tiež; null, undefined a neznáma linka = bez farby', () => {
    expect(containerLineColor(ENTITY_PALETTE, 'line-blue')).toBe(ENTITY_PALETTE.line['line-blue']);
    expect(containerLineColor(ENTITY_PALETTE, null)).toBeUndefined();
    expect(containerLineColor(ENTITY_PALETTE, undefined)).toBeUndefined();
    expect(containerLineColor(ENTITY_PALETTE, 'unknown_line')).toBeUndefined();
    expect(lineTokenOfId(null)).toBeUndefined();
  });
});

describe('CargoSprite s look.container', () => {
  it('dry 20′: sprite cargo/container_20_dry.svg 64 × 26 px, tónovaný farbou linky', () => {
    const textures = new StubTextures();
    const cargo = new CargoSprite(1, 'container_teu', deps(textures), { container: box() });
    const sprite = cargo.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(cargo.textureFile).toBe('cargo/container_20_dry.svg');
    expect(sprite.texture).toBe(textures.textureFor('file/cargo/container_20_dry.svg'));
    expect(cargo.tintColor).toBe(ENTITY_PALETTE.line['line-blue'].color);
    expect(sprite.tint).toBe(ENTITY_PALETTE.line['line-blue'].color);
    expect(sprite.width).toBeCloseTo(64, 6);
    expect(sprite.height).toBeCloseTo(26, 6);
  });

  it('dry 40′: dvojnásobná dĺžka, rovnaká šírka; každá linka má vlastnú farbu', () => {
    const textures = new StubTextures();
    const sprite = (lineId: string | null) => new CargoSprite(1, 'container_teu', deps(textures), { container: box({ sizeFt: 40, lineId }) });
    const amber = sprite('northern_star');
    expect((amber.children[0] as Sprite).width).toBeCloseTo(128, 6);
    expect((amber.children[0] as Sprite).height).toBeCloseTo(26, 6);
    expect(amber.textureFile).toBe('cargo/container_40_dry.svg');
    expect(amber.tintColor).toBe(ENTITY_PALETTE.line['line-amber'].color);
    expect(sprite('golden_wave').tintColor).toBe(ENTITY_PALETTE.line['line-teal'].color);
  });

  it('dry bez linky (alebo s neznámou) ostáva neutrálny, bez tónu', () => {
    const textures = new StubTextures();
    for (const lineId of [null, 'unknown_line']) {
      const cargo = new CargoSprite(1, 'container_teu', deps(textures), { container: box({ lineId }) });
      expect(cargo.tintColor).toBeNull();
      expect((cargo.children[0] as Sprite).tint).toBe(0xffffff);
    }
  });

  it('prázdny: sivý sprite container_<size>_empty bez tónu, s pásikom farby linky; bez linky bez pásika', () => {
    const textures = new StubTextures();
    const withLine = new CargoSprite(1, 'container_teu', deps(textures), { container: box({ sizeFt: 40, direction: 'empty' }) });
    expect(withLine.textureFile).toBe('cargo/container_40_empty.svg');
    expect(withLine.tintColor).toBeNull();
    const [sprite, band] = withLine.children[0].children;
    expect(sprite).toBeInstanceOf(Sprite);
    expect((sprite as Sprite).tint).toBe(0xffffff);
    expect(band).toBeInstanceOf(Graphics);
    const plain = new CargoSprite(2, 'container_teu', deps(textures), { container: box({ direction: 'empty', lineId: null }) });
    expect(plain.children[0]).toBeInstanceOf(Sprite);
  });

  it('bez textúr: obdĺžnik z tokenov v rovnakej veľkosti (20′ 64 × 26, 40′ 128 × 26), bez súboru', () => {
    for (const [sizeFt, width] of [[20, 64], [40, 128]] as const) {
      const cargo = new CargoSprite(1, 'container_teu', deps(null), { container: box({ sizeFt }) });
      const graphics = cargo.children[0] as Graphics;
      expect(graphics).toBeInstanceOf(Graphics);
      expect(cargo.textureFile).toBeNull();
      expect(cargo.tintColor).toBe(ENTITY_PALETTE.line['line-blue'].color);
      const bounds = graphics.getLocalBounds();
      expect(bounds.width).toBeCloseTo(width, 0);
      expect(bounds.height).toBeCloseTo(26, 0);
    }
  });

  it('bez look.container ostáva kontajner TEU (container_teu, 64 × 26) ako doteraz', () => {
    const textures = new StubTextures();
    const cargo = new CargoSprite(1, 'container_teu', deps(textures));
    expect(cargo.textureFile).toBeNull();
    expect((cargo.children[0] as Sprite).texture).toBe(textures.textureFor('file/cargo/container_teu.svg'));
    expect(cargoSizePx('container_20_dry', CELL)).toEqual({ w: 64, h: 26 });
    expect(cargoSizePx('container_40_empty', CELL)).toEqual({ w: 128, h: 26 });
  });
});
