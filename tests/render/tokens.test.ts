import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ROAD_EDGE_SHADE,
  loadEntityPalette,
  loadRenderPalette,
  parseCssColor,
  parseCssPx,
  readColorToken,
  readLengthToken,
  shadeColor,
  tokenResolverFromCss,
} from '@render/tokens';

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8');

describe('parseCssColor', () => {
  it.each([
    ['#0E3A5B', 0x0e3a5b, 1],
    ['#0e3a5b', 0x0e3a5b, 1],
    ['  #FFF ', 0xffffff, 1],
    ['#f80', 0xff8800, 1],
    ['#11223380', 0x112233, 128 / 255],
    ['#1238', 0x112233, 0x88 / 255],
    ['rgb(1, 2, 3)', 0x010203, 1],
    ['rgba(53,194,122,.55)', 0x35c27a, 0.55],
    ['rgba(229, 72, 77, 0.55)', 0xe5484d, 0.55],
    ['rgba(58,160,255,0)', 0x3aa0ff, 0],
  ] as const)('%s → 0x%s, alfa %f', (input, color, alpha) => {
    const parsed = parseCssColor(input);
    expect(parsed.color).toBe(color);
    expect(parsed.alpha).toBeCloseTo(alpha, 6);
  });

  it.each(['', 'red', '#12', '#12345', 'rgb(1,2)', 'rgba(300,0,0,1)', 'rgba(0,0,0,2)', '64px'])('%j → chyba', (input) => {
    expect(() => parseCssColor(input)).toThrow(Error);
  });
});

describe('parseCssPx', () => {
  it.each([
    ['64px', 64],
    [' 12.5px ', 12.5],
  ])('%j → %f', (input, expected) => {
    expect(parseCssPx(input)).toBe(expected);
  });

  it.each(['', 'px', '64', '1rem', 'abc', '-4px', '0px'])('%j → chyba', (input) => {
    expect(() => parseCssPx(input)).toThrow(Error);
  });
});

describe('tokenResolverFromCss', () => {
  it('prečíta deklarácie custom properties a ignoruje komentáre', () => {
    const resolve = tokenResolverFromCss(':root { --a: #123456; /* --b: #000; */ --c:  rgba(1,2,3,.5) ;\n --cell: 64px; }');
    expect(resolve('--a')).toBe('#123456');
    expect(resolve('--c')).toBe('rgba(1,2,3,.5)');
    expect(resolve('--cell')).toBe('64px');
    expect(resolve('--b')).toBe('');
  });
});

describe('readColorToken / readLengthToken', () => {
  const resolve = tokenResolverFromCss(TOKENS_CSS);

  it('načíta farbu a dĺžku z design/tokens.css', () => {
    expect(readColorToken('--terrain-water-deep', resolve)).toEqual({ color: 0x0e3a5b, alpha: 1 });
    expect(readColorToken('--ghost-valid', resolve).alpha).toBeCloseTo(0.55, 6);
    expect(readLengthToken('--cell', resolve)).toBe(64);
  });

  it('chýbajúci token → chyba s menom tokenu (žiadny tichý fallback)', () => {
    expect(() => readColorToken('--nie-je', resolve)).toThrow(/--nie-je/);
    expect(() => readLengthToken('--nie-je', resolve)).toThrow(/--nie-je/);
  });

  it('bez DOM a bez resolvera je chyba zrozumiteľná', () => {
    expect(() => readColorToken('--terrain-land')).toThrow(/resolver/i);
  });
});

describe('loadRenderPalette', () => {
  it('všetky tokeny terénu a ciest existujú v design/tokens.css', () => {
    const palette = loadRenderPalette(tokenResolverFromCss(TOKENS_CSS));
    expect(palette.cellPx).toBe(64);
    expect(palette.terrain.waterDeep.color).toBe(0x0e3a5b);
    expect(palette.terrain.waterShallow.color).toBe(0x1f6f8b);
    expect(palette.terrain.waterFoam.color).toBe(0x7fc2d6);
    expect(palette.terrain.quay.color).toBe(0xb7b2a6);
    expect(palette.terrain.quayEdge.color).toBe(0x7d786e);
    expect(palette.terrain.land.color).toBe(0xd8d2c4);
    expect(palette.terrain.landAlt.color).toBe(0xcfc8b8);
    expect(palette.terrain.blocked.color).toBe(0x6e6a66);
    expect(palette.road.base.color).toBe(0x4b5058);
    expect(palette.road.marking.color).toBe(0xe9e4d6);
    expect(palette.road.arrow.color).toBe(0x3aa0ff); // `--ui-accent`: šípka smeru jednosmerky bez sprite
    expect(palette.parcel.forSale.color).toBe(0xf2b233);
    expect(palette.parcel.owned.color).toBe(0x35c27a);
    expect(palette.parcel.leased.color).toBe(0x3aa0ff);
  });
});

describe('okraj cesty (obrubník procedurálnych úzkych ciest)', () => {
  const palette = loadRenderPalette(tokenResolverFromCss(TOKENS_CSS));

  it('odvodený z `--road-base` (token pre okraj v design/tokens.css nie je): #4B5058 × 0,215 = #101113 ako v spritoch', () => {
    expect(palette.road.edge).toEqual({ color: 0x101113, alpha: 1 });
    expect(ROAD_EDGE_SHADE).toBe(0.215);
  });

  it('shadeColor: kanály sa násobia a zaokrúhľujú, priehľadnosť ostáva', () => {
    expect(shadeColor({ color: 0xff8040, alpha: 0.5 }, 0.5)).toEqual({ color: 0x804020, alpha: 0.5 });
    expect(shadeColor({ color: 0x123456, alpha: 1 }, 1)).toEqual({ color: 0x123456, alpha: 1 });
    expect(shadeColor({ color: 0xffffff, alpha: 1 }, 0)).toEqual({ color: 0, alpha: 1 });
  });
});

describe('loadEntityPalette', () => {
  it('tokeny fallbacku modulov, žeriavov, lodí, vozidiel a nákladu existujú v design/tokens.css', () => {
    const palette = loadEntityPalette(tokenResolverFromCss(TOKENS_CSS));
    expect(palette.module.base.color).toBe(0x9da3ac);
    expect(palette.module.outline.color).toBe(0x5c626b);
    expect(palette.crane.frame.color).toBe(0xe3b23c);
    expect(palette.crane.boom.color).toBe(0xc88b1f);
    expect(palette.ship.hull.color).toBe(0x2c3e50);
    expect(palette.ship.deck.color).toBe(0x8e9aa7);
    expect(palette.cargo.base.color).toBe(0xf28c28);
    expect(palette.cargo.dark.color).toBe(0xc7680c);
    expect(palette.vehicle.body.color).toBe(0xf4d03f);
    expect(palette.vehicle.dark.color).toBe(0x2b2b2b);
    expect(palette.danger.color).toBe(0xe5484d);
    expect(palette.connector.color).toBe(0x3aa0ff);
    expect(palette.disconnected.color).toBe(0xf2b233);
  });

  it('chýbajúci token → chyba s jeho menom', () => {
    expect(() => loadEntityPalette(() => '')).toThrow('--module-base');
  });
});
