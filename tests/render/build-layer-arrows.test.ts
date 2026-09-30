// T03-20: šípky smeru jednosmernej cesty na ghoste (`BuildLayer.setGhostArrows`). Pool, rotácia podľa smeru, väzba
// na ghost (setGhost/setModuleGhost/clearGhost ich skryjú) a fallback bez textúry.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BuildLayer, PATH_ARROW_ANGLE, loadGhostPalette, type GhostArrow } from '@render/build-layer';
import { overlayAssetUrl } from '@render/overlay-assets';
import { tokenResolverFromCss } from '@render/tokens';

const TOKENS = tokenResolverFromCss(readFileSync(fileURLToPath(new URL('../../design/tokens.css', import.meta.url)), 'utf8'));
const CELL = 64;

function layer(pathArrow: Texture | null = Texture.WHITE): BuildLayer {
  return new BuildLayer({ cellPx: CELL, palette: loadGhostPalette(TOKENS), hatch: null, pathArrow });
}

/** Šípky sú v poslednom potomkovi koreňa (`ghost-arrows`, za výberom). */
const arrowsOf = (build: BuildLayer): Container[] => (build.view.children[4] as Container).children as Container[];

const ARROWS: readonly GhostArrow[] = [
  { x: 3, y: 4, dir: 'E' },
  { x: 4, y: 4, dir: 'S' },
  { x: 4, y: 5, dir: 'W' },
  { x: 3, y: 5, dir: 'N' },
];

describe('BuildLayer.setGhostArrows', () => {
  it('overlay path_arrow je v manifeste a otáča sa v smere hodinových ručičiek: N 0°, E 90°, S 180°, W 270°', () => {
    expect(overlayAssetUrl('path_arrow')).toContain('path_arrow');
    expect(PATH_ARROW_ANGLE).toEqual({ N: 0, E: 90, S: 180, W: 270 });
  });

  it('bez šípok nič nezobrazuje', () => {
    const build = layer();
    expect(build.arrowCount).toBe(0);
    expect(arrowsOf(build)).toHaveLength(0);
  });

  it('šípka je Sprite vycentrovaný na bunku (px = (bunka + ½) × cellPx), natiahnutý na bunku a otočený podľa smeru', () => {
    const build = layer();
    build.setGhost(ARROWS.map((arrow) => ({ x: arrow.x, y: arrow.y, valid: true })));
    build.setGhostArrows(ARROWS);
    expect(build.arrowCount).toBe(4);
    arrowsOf(build).forEach((view, index) => {
      const arrow = ARROWS[index];
      expect(view).toBeInstanceOf(Sprite);
      expect([view.position.x, view.position.y]).toEqual([(arrow.x + 0.5) * CELL, (arrow.y + 0.5) * CELL]);
      expect(view.angle).toBe(PATH_ARROW_ANGLE[arrow.dir]);
      expect([view.width, view.height]).toEqual([CELL, CELL]);
      expect(view.visible).toBe(true);
    });
  });

  it('pool sa znovupoužije: menej šípok len skryje prebytočné, null skryje všetky', () => {
    const build = layer();
    build.setGhostArrows(ARROWS);
    const first = arrowsOf(build)[0];
    build.setGhostArrows(ARROWS.slice(0, 1));
    expect(build.arrowCount).toBe(1);
    expect(arrowsOf(build)).toHaveLength(4);
    expect(arrowsOf(build)[0]).toBe(first);
    build.setGhostArrows(null);
    expect(build.arrowCount).toBe(0);
    build.setGhostArrows(ARROWS);
    expect(build.arrowCount).toBe(4);
  });

  it('setGhost, clearGhost aj setModuleGhost šípky skryjú (šípky patria k ghostu, ktorý ich nastavil)', () => {
    const build = layer();
    build.setGhostArrows(ARROWS);
    build.setGhost([{ x: 1, y: 1, valid: true }]);
    expect(build.arrowCount).toBe(0);
    build.setGhostArrows(ARROWS);
    build.clearGhost();
    expect(build.arrowCount).toBe(0);
    build.setGhostArrows(ARROWS);
    build.setModuleGhost({ defId: 'x', x: 1, y: 1, rotation: 0, w: 1, h: 1, valid: true, connectors: [] });
    expect(build.arrowCount).toBe(0);
  });

  it('bez textúry sa šípka kreslí z Graphics (chevron z tokenu --module-connector)', () => {
    const build = layer(null);
    build.setGhostArrows(ARROWS.slice(0, 2));
    expect(arrowsOf(build)[0]).toBeInstanceOf(Graphics);
    expect(build.arrowCount).toBe(2);
  });

  it('po destroy() setGhostArrows nič nerobí a nehádže', () => {
    const build = layer();
    build.destroy();
    expect(() => {
      build.setGhostArrows(ARROWS);
    }).not.toThrow();
  });
});
