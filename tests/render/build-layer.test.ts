import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Container, Texture, TilingSprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BuildLayer, loadGhostPalette, type GhostCell } from '@render/build-layer';
import { GHOST_HATCH_PATTERN, overlayAssetUrl } from '@render/overlay-assets';
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
