import { describe, expect, it } from 'vitest';
import { Graphics, NineSliceSprite } from 'pixi.js';
import { loadBundledMap, type Parcel } from '@sim/grid';
import { ParcelLayer, PRICE_LABEL_MIN_ZOOM, formatParcelPrice, outlineScaleForZoom, parcelOutlineId } from '@render/parcel-layer';
import type { ParcelVM } from '@render/view-models';
import { terrain as terrainManifest } from '../../assets/manifest.json';
import { PALETTE, StubTextures } from './stub-textures';

/** Živé (meniteľné) kópie parciel mapy — ako `World.parcels`. */
function liveParcels(): Parcel[] {
  return loadBundledMap().parcels.map((parcel) => ({ ...parcel }));
}

const outlineSprites = (layer: ParcelLayer): NineSliceSprite[] =>
  layer.view.children.filter((child): child is NineSliceSprite => child instanceof NineSliceSprite);

describe('parcelOutlineId', () => {
  it.each([
    ['none', 'parcel_outline_for_sale'],
    ['owned', 'parcel_outline_owned'],
    ['leased', 'parcel_outline_leased'],
  ] as const)('%s → %s', (ownership, expected) => {
    expect(parcelOutlineId(ownership)).toBe(expected);
  });

  it('všetky obrysy majú v manifeste 9-slice s okrajom 8 px', () => {
    for (const ownership of ['none', 'owned', 'leased'] as const) {
      expect(terrainManifest[parcelOutlineId(ownership)].nineSlice).toEqual({ left: 8, top: 8, right: 8, bottom: 8 });
    }
  });
});

describe('outlineScaleForZoom', () => {
  it.each([
    [2, 1],
    [1, 1],
    [0.5, 2],
    [0.25, 4],
  ] as const)('zoom %f → násobok %f', (zoom, expected) => {
    expect(outlineScaleForZoom(zoom)).toBe(expected);
  });

  it('neplatný zoom je chyba', () => {
    expect(() => outlineScaleForZoom(0)).toThrow(RangeError);
    expect(() => outlineScaleForZoom(-1)).toThrow(RangeError);
    expect(() => outlineScaleForZoom(Number.NaN)).toThrow(RangeError);
  });
});

describe('ParcelLayer so spritmi (Pixi scene graph bez renderera)', () => {
  it('jeden 9-slice obrys na parcelu: poloha a rozmer = obdĺžnik parcely × `--cell`', () => {
    const parcels = liveParcels();
    const layer = new ParcelLayer(parcels, PALETTE, new StubTextures());
    expect(layer.view.isRenderGroup).toBe(true);
    expect(layer.outlineCount).toBe(4);
    const sprites = outlineSprites(layer);
    expect(sprites).toHaveLength(4);
    parcels.forEach((parcel, i) => {
      expect(sprites[i].position.x).toBe(parcel.rect.x * PALETTE.cellPx);
      expect(sprites[i].position.y).toBe(parcel.rect.y * PALETTE.cellPx);
      expect(sprites[i].width).toBe(parcel.rect.w * PALETTE.cellPx);
      expect(sprites[i].height).toBe(parcel.rect.h * PALETTE.cellPx);
    });
  });

  it('textúra podľa `ownership`: starter vlastnená, ostatné na predaj; 9-slice z manifestu', () => {
    const textures = new StubTextures();
    const layer = new ParcelLayer(liveParcels(), PALETTE, textures);
    const [starter, westQuay, eastYard] = outlineSprites(layer);
    expect(layer.outlineOf('starter')).toBe('parcel_outline_owned');
    expect(layer.outlineOf('west_quay')).toBe('parcel_outline_for_sale');
    expect(layer.outlineOf('east_yard')).toBe('parcel_outline_for_sale');
    expect(layer.outlineOf('neznama')).toBeUndefined();
    expect(starter.texture).toBe(textures.textureFor('terrain/parcel_outline_owned'));
    expect(westQuay.texture).toBe(textures.textureFor('terrain/parcel_outline_for_sale'));
    expect(eastYard.texture).toBe(textures.textureFor('terrain/parcel_outline_for_sale'));
    for (const sprite of [starter, westQuay, eastYard]) {
      expect([sprite.leftWidth, sprite.topHeight, sprite.rightWidth, sprite.bottomHeight]).toEqual([8, 8, 8, 8]);
    }
  });

  it('refresh prekreslí len parcely so zmeneným `ownership` a vráti ich počet', () => {
    const parcels = liveParcels();
    const textures = new StubTextures();
    const layer = new ParcelLayer(parcels, PALETTE, textures);
    const sprites = outlineSprites(layer);
    expect(layer.refresh()).toBe(0);

    parcels[1].ownership = 'owned'; // west_quay: kúpa
    parcels[2].ownership = 'leased'; // east_yard: prenájom
    expect(layer.refresh()).toBe(2);
    expect(layer.outlineOf('west_quay')).toBe('parcel_outline_owned');
    expect(layer.outlineOf('east_yard')).toBe('parcel_outline_leased');
    expect(sprites[1].texture).toBe(textures.textureFor('terrain/parcel_outline_owned'));
    expect(sprites[2].texture).toBe(textures.textureFor('terrain/parcel_outline_leased'));
    expect(outlineSprites(layer)).toEqual(sprites); // tie isté objekty, len nová textúra
    expect(layer.refresh()).toBe(0);

    parcels[2].ownership = 'none'; // ukončenie prenájmu
    expect(layer.refresh()).toBe(1);
    expect(layer.outlineOf('east_yard')).toBe('parcel_outline_for_sale');
  });

  it('setZoom pod 1 zväčší rám a zmenší jeho lokálny rozmer: rozmer parcely na svete sa nemení', () => {
    const parcels = liveParcels();
    const layer = new ParcelLayer(parcels, PALETTE, new StubTextures());
    const [starter] = outlineSprites(layer);
    const worldWidth = parcels[0].rect.w * PALETTE.cellPx;
    const worldHeight = parcels[0].rect.h * PALETTE.cellPx;

    expect(layer.setZoom(0.5)).toBe(true);
    expect(layer.scale).toBe(2);
    expect(starter.scale.x).toBe(2);
    expect(starter.width * starter.scale.x).toBe(worldWidth);
    expect(starter.height * starter.scale.y).toBe(worldHeight);
    expect(starter.getLocalBounds().maxX * starter.scale.x).toBeCloseTo(worldWidth, 6);

    expect(layer.setZoom(0.5)).toBe(false);
    expect(layer.setZoom(0.25)).toBe(true);
    expect(starter.scale.x).toBe(4);

    expect(layer.setZoom(2)).toBe(true); // späť na pôvodnú hrúbku
    expect(starter.scale.x).toBe(1);
    expect(starter.width).toBe(worldWidth);
    expect(layer.setZoom(1)).toBe(false); // ≥ 1 sa nič nemení
  });

  it('bez textúr: obrys z `Graphics` v tokenoch, refresh ho prekreslí', () => {
    const parcels = liveParcels();
    const layer = new ParcelLayer(parcels, PALETTE, null);
    expect(layer.view.children).toHaveLength(8); // výplň + obrys na parcelu
    expect(layer.view.children.every((child) => child instanceof Graphics)).toBe(true);
    expect(layer.outlineOf('starter')).toBeUndefined();
    parcels[0].ownership = 'leased';
    expect(layer.refresh()).toBe(1);
  });

  it('obrysy ležia v hraniciach parciel (nič nepresahuje obdĺžnik)', () => {
    const parcels = liveParcels();
    const layer = new ParcelLayer(parcels, PALETTE, null);
    parcels.forEach((parcel, i) => {
      const bounds = layer.view.children[i * 2 + 1].getLocalBounds();
      const cell = PALETTE.cellPx;
      expect(bounds.minX).toBeGreaterThanOrEqual(parcel.rect.x * cell);
      expect(bounds.minY).toBeGreaterThanOrEqual(parcel.rect.y * cell);
      expect(bounds.maxX).toBeLessThanOrEqual((parcel.rect.x + parcel.rect.w) * cell);
      expect(bounds.maxY).toBeLessThanOrEqual((parcel.rect.y + parcel.rect.h) * cell);
    });
  });
});

describe('ParcelLayer F7: hover, hit-test, cenovky, sync', () => {
  const label = { color: { color: 0xffffff, alpha: 1 }, fontFamily: 'Inter', fontWeight: '600', sizePx: 12 };
  const make = (): ParcelLayer => new ParcelLayer(liveParcels(), PALETTE, null, label);

  it('formatParcelPrice skracuje centy na USD K/M', () => {
    expect(formatParcelPrice(32000000)).toBe('$320K');
    expect(formatParcelPrice(120000000)).toBe('$1.2M');
    expect(formatParcelPrice(50000)).toBe('$500');
  });

  it('parcelAt vráti parcelu pod bunkou, mimo parciel undefined', () => {
    const layer = make();
    expect(layer.parcelAt({ x: 10, y: 20 })).toBe('west_quay');
    expect(layer.parcelAt({ x: 30, y: 14 })).toBe('starter');
    expect(layer.parcelAt({ x: 58, y: 14 })).toBeUndefined(); // x + w je mimo
    expect(layer.parcelAt({ x: 0, y: 0 })).toBeUndefined();
  });

  it('cenovka len na parcele na predaj a len pri dostatočnom zoome', () => {
    const layer = make();
    expect(layer.priceLabelOf('west_quay')).toBe('$320K');
    expect(layer.priceLabelOf('starter')).toBeUndefined();
    layer.setZoom(PRICE_LABEL_MIN_ZOOM / 2);
    expect(layer.priceLabelOf('west_quay')).toBeUndefined();
    layer.setZoom(1);
    expect(layer.priceLabelOf('west_quay')).toBe('$320K');
  });

  it('setHover mení zvýraznenie iba pri zmene', () => {
    const layer = make();
    expect(layer.setHover('west_quay')).toBe(true);
    expect(layer.setHover('west_quay')).toBe(false);
    expect(layer.hovered).toBe('west_quay');
    expect(layer.setHover(null)).toBe(true);
  });

  it('sync prevezme stav a cenu z ParcelVM', () => {
    const layer = make();
    const vm: ParcelVM = { id: 'west_quay', rect: { x: 6, y: 12, w: 16, h: 38 }, state: 'leased', priceCents: 1, leasePerMonthCents: 5 };
    expect(layer.sync([vm])).toBe(1);
    expect(layer.priceLabelOf('west_quay')).toBeUndefined();
    expect(layer.sync([{ ...vm, state: 'for_sale', priceCents: 150000000 }])).toBe(1);
    expect(layer.priceLabelOf('west_quay')).toBe('$1.5M');
    expect(layer.sync([{ ...vm, id: 'neznama' }])).toBe(0);
  });
});
