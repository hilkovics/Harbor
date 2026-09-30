import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Container, Graphics, NineSliceSprite, Texture, TilingSprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BuildLayer, loadGhostPalette, type GhostCell } from '@render/build-layer';
import { GHOST_HATCH_PATTERN, SELECTION_RING_SLICE, overlayAssetUrl } from '@render/overlay-assets';
import { tokenResolverFromCss } from '@render/tokens';

const TOKENS = tokenResolverFromCss(readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8'));
const CELL = 64;

function layer(hatch: Texture | null = Texture.WHITE): BuildLayer {
  return new BuildLayer({ cellPx: CELL, palette: loadGhostPalette(TOKENS), hatch });
}

/** Šrafy sú v druhom potomkovi koreňa (`ghost-hatch`). */
function hatchSprites(build: BuildLayer): TilingSprite[] {
  const container = build.view.children[1] as Container;
  return container.children as TilingSprite[];
}

const visible = (sprites: readonly TilingSprite[]): TilingSprite[] => sprites.filter((sprite) => sprite.visible);

describe('loadGhostPalette', () => {
  it('farby z tokenov --ghost-valid / --ghost-invalid (rgba s alfou)', () => {
    const palette = loadGhostPalette(TOKENS);
    expect(palette.valid).toEqual({ color: 0x35c27a, alpha: 0.55 });
    expect(palette.invalid).toEqual({ color: 0xe5484d, alpha: 0.55 });
  });

  it('chýbajúci token → chyba s jeho menom', () => {
    expect(() => loadGhostPalette(() => '')).toThrow('--ghost-valid');
  });
});

describe('overlay assety z manifestu', () => {
  it('ghost_hatch: vzor 12×12 a URL súboru overlay/ghost_hatch.svg', () => {
    expect(GHOST_HATCH_PATTERN).toEqual({ w: 12, h: 12 });
    expect(overlayAssetUrl('ghost_hatch')).toContain('ghost_hatch');
  });
});

describe('BuildLayer', () => {
  const cells: GhostCell[] = [
    { x: 3, y: 4, valid: true },
    { x: 4, y: 4, valid: true },
    { x: 5, y: 4, valid: false },
  ];

  it('bez ghostu nič nezobrazuje', () => {
    const build = layer();
    expect(build.shownCount).toBe(0);
    expect(hatchSprites(build)).toHaveLength(0);
  });

  it('setGhost: výplň pre všetky bunky, šrafa len pre neplatné, na polohe bunky (px = bunka × cellPx)', () => {
    const build = layer();
    build.setGhost(cells);
    expect(build.shownCount).toBe(3);
    const shown = visible(hatchSprites(build));
    expect(shown).toHaveLength(1);
    expect(shown[0].position.x).toBe(5 * CELL);
    expect(shown[0].position.y).toBe(4 * CELL);
    expect(shown[0].width).toBe(CELL);
    expect(shown[0].height).toBe(CELL);
  });

  it('vzor šrafy je ukotvený k svetu: susedné neplatné bunky na seba plynulo nadväzujú', () => {
    const build = layer();
    build.setGhost([
      { x: 1, y: 2, valid: false },
      { x: 2, y: 2, valid: false },
    ]);
    const [a, b] = visible(hatchSprites(build));
    expect(a.position.x + a.tilePosition.x).toBe(0);
    expect(b.position.x + b.tilePosition.x).toBe(0);
    expect(a.position.y + a.tilePosition.y).toBe(0);
  });

  it('pool šrafy sa znovupoužíva; nadbytočné sprity sa skryjú, nie zničia', () => {
    const build = layer();
    const invalid = (n: number): GhostCell[] => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, valid: false }));
    build.setGhost(invalid(5));
    const pool = [...hatchSprites(build)];
    expect(pool).toHaveLength(5);
    build.setGhost(invalid(2));
    expect(hatchSprites(build)).toHaveLength(5);
    expect(visible(hatchSprites(build))).toHaveLength(2);
    build.setGhost(invalid(4));
    expect(hatchSprites(build)).toEqual(pool); // rovnaké objekty
    expect(visible(hatchSprites(build))).toHaveLength(4);
  });

  it('clearGhost skryje všetko', () => {
    const build = layer();
    build.setGhost(cells);
    build.clearGhost();
    expect(build.shownCount).toBe(0);
    expect(visible(hatchSprites(build))).toHaveLength(0);
  });

  it('bez textúry šrafy (len testy) sa kreslí iba výplň', () => {
    const build = layer(null);
    build.setGhost(cells);
    expect(build.shownCount).toBe(3);
    expect(hatchSprites(build)).toHaveLength(0);
  });

  it('po destroy() setGhost nič nerobí a nehádže', () => {
    const build = layer();
    build.destroy();
    expect(() => {
      build.setGhost(cells);
    }).not.toThrow();
    expect(() => {
      build.destroy();
    }).not.toThrow();
  });
});

describe('BuildLayer — obrys výberu modulu (selection_ring)', () => {
  const RECT = { x: 40, y: 14, w: 8, h: 3 };
  const ringOf = (build: BuildLayer): NineSliceSprite | Graphics => {
    const container = build.view.children[3] as Container; // fills, hatch, markery, výber
    return container.children[0] as NineSliceSprite | Graphics;
  };

  it('okraje 9-slice a asset sú z manifestu (8 px, overlay/selection_ring.svg)', () => {
    expect(SELECTION_RING_SLICE).toEqual({ left: 8, top: 8, right: 8, bottom: 8 });
    expect(overlayAssetUrl('selection_ring')).toContain('selection_ring');
  });

  it('bez výberu sa nič nekreslí', () => {
    const build = layer();
    expect(build.selectionShown).toBe(false);
    expect((build.view.children[3] as Container).children).toHaveLength(0);
  });

  it('s textúrou: NineSliceSprite natiahnutý na footprint modulu (px = bunka × cellPx), rohy z manifestu', () => {
    const build = new BuildLayer({ cellPx: CELL, palette: loadGhostPalette(TOKENS), hatch: null, selectionRing: Texture.WHITE });
    build.setSelectionRing(RECT);
    const ring = ringOf(build);
    expect(ring).toBeInstanceOf(NineSliceSprite);
    const sprite = ring as NineSliceSprite;
    expect([sprite.position.x, sprite.position.y]).toEqual([RECT.x * CELL, RECT.y * CELL]);
    expect([sprite.width, sprite.height]).toEqual([RECT.w * CELL, RECT.h * CELL]);
    expect([sprite.leftWidth, sprite.topHeight, sprite.rightWidth, sprite.bottomHeight]).toEqual([8, 8, 8, 8]);
    expect(build.selectionShown).toBe(true);
  });

  it('bez textúry: Graphics obrys z tokenu --ui-accent', () => {
    const build = layer();
    expect(loadGhostPalette(TOKENS).selection).toEqual({ color: 0x3aa0ff, alpha: 1 });
    build.setSelectionRing(RECT);
    expect(ringOf(build)).toBeInstanceOf(Graphics);
    expect(build.selectionShown).toBe(true);
  });

  it('presun výberu znovupoužije ten istý sprite; null ho skryje, nezničí', () => {
    const build = new BuildLayer({ cellPx: CELL, palette: loadGhostPalette(TOKENS), hatch: null, selectionRing: Texture.WHITE });
    build.setSelectionRing(RECT);
    const first = ringOf(build);
    build.setSelectionRing({ x: 43, y: 14, w: 2, h: 3 });
    expect(ringOf(build)).toBe(first);
    expect([first.width, first.height]).toEqual([2 * CELL, 3 * CELL]);
    build.setSelectionRing(null);
    expect(build.selectionShown).toBe(false);
    expect(ringOf(build)).toBe(first);
    build.setSelectionRing(RECT);
    expect(build.selectionShown).toBe(true);
  });

  it('obrys je nezávislý od ghostu (setGhost / clearGhost ho nemenia)', () => {
    const build = layer();
    build.setSelectionRing(RECT);
    build.setGhost([{ x: 1, y: 1, valid: true }]);
    expect(build.selectionShown).toBe(true);
    build.clearGhost();
    expect(build.selectionShown).toBe(true);
  });

  it('po destroy() setSelectionRing nič nerobí a nehádže', () => {
    const build = layer();
    build.destroy();
    expect(() => {
      build.setSelectionRing(RECT);
    }).not.toThrow();
  });
});
