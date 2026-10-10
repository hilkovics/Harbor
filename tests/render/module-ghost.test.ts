import { Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BuildLayer, CONNECTOR_MARKER_ROTATION, loadGhostPalette, moduleGhostCells } from '@render/build-layer';
import { moduleSprite } from '@render/entity-assets';
import { rotateLocalCell, type Rotation } from '@sim/grid';
import type { ModuleGhostVM } from '@render/view-models';
import { PALETTE, TOKENS } from './stub-textures';

const CELL = PALETTE.cellPx;

function layer(connectorMarker: Texture | null = Texture.WHITE): BuildLayer {
  return new BuildLayer({ cellPx: CELL, palette: loadGhostPalette(TOKENS), hatch: Texture.WHITE, connectorMarker });
}

/** Ghost berthu 8×3 na (48, 14) rot 0 s konektormi z manifestu (svetové bunky = (48 + x, 14 + y)). */
function berthGhost(valid = true): ModuleGhostVM {
  const connectors = (moduleSprite('berth_standard')?.connectors ?? []).map((c) => ({ x: 48 + c.x, y: 14 + c.y, side: c.side }));
  return { defId: 'berth_standard', x: 48, y: 14, rotation: 0, w: 8, h: 4, valid, connectors };
}

const hatch = (build: BuildLayer): TilingSprite[] => (build.view.children[1] as Container).children as TilingSprite[];
const markers = (build: BuildLayer): Container[] => (build.view.children[2] as Container).children as Container[];
const visible = <T extends Container>(items: readonly T[]): T[] => items.filter((item) => item.visible);

describe('moduleGhostCells', () => {
  it('všetky bunky footprintu od ľavého horného rohu, riadok po riadku, s platnosťou ghostu', () => {
    const cells = moduleGhostCells({ ...berthGhost(false), w: 3, h: 2, x: 5, y: 7 });
    expect(cells).toEqual([
      { x: 5, y: 7, valid: false },
      { x: 6, y: 7, valid: false },
      { x: 7, y: 7, valid: false },
      { x: 5, y: 8, valid: false },
      { x: 6, y: 8, valid: false },
      { x: 7, y: 8, valid: false },
    ]);
  });
});

describe('CONNECTOR_MARKER_ROTATION (šípka sprite smeruje na sever = do modulu cez južnú hranu)', () => {
  it('s → 0°, w → 90°, n → 180°, e → 270°', () => {
    expect(CONNECTOR_MARKER_ROTATION).toEqual({ s: 0, w: 90, n: 180, e: 270 });
  });

  it.each(['n', 'e', 's', 'w'] as const)('strana %s: šípka po rotácii smeruje do modulu', (side) => {
    // smer šípky pri rot 0 je „hore“ (0, −1); po otočení o uhol musí ísť OPAČNE než vonkajšia normála strany
    const outward = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } }[side];
    const marker = new Container();
    marker.angle = CONNECTOR_MARKER_ROTATION[side];
    const arrow = marker.toGlobal({ x: 0, y: -1 });
    expect(arrow.x).toBeCloseTo(-outward.x, 9);
    expect(arrow.y).toBeCloseTo(-outward.y, 9);
  });
});

describe('BuildLayer.setModuleGhost', () => {
  it('platný ghost: footprint 8×4 = 32 buniek, bez šrafy, 8 značiek konektorov na bunkách konektorov', () => {
    const build = layer();
    build.setModuleGhost(berthGhost(true));
    expect(build.shownCount).toBe(32);
    expect(visible(hatch(build))).toHaveLength(0);
    expect(build.markerCount).toBe(8);
    const shown = visible(markers(build));
    expect(shown[0].position.x).toBe((48 + 1 + 0.5) * CELL);
    expect(shown[0].position.y).toBe((14 + 3 + 0.5) * CELL);
    expect(shown[1].position.x).toBe((48 + 6 + 0.5) * CELL);
    expect(shown[0].angle).toBeCloseTo(0, 9); // konektory berthu majú side "s"
  });

  it('neplatný ghost: šrafa na každej z 32 buniek, značky konektorov ostávajú', () => {
    const build = layer();
    build.setModuleGhost(berthGhost(false));
    expect(visible(hatch(build))).toHaveLength(32);
    expect(build.markerCount).toBe(8);
  });

  it('značka je sprite `connector_marker` veľkosti 1 bunka, vycentrovaný', () => {
    const build = layer();
    build.setModuleGhost(berthGhost());
    const marker = markers(build)[0] as Sprite;
    expect(marker).toBeInstanceOf(Sprite);
    expect(marker.anchor.x).toBe(0.5);
    expect(marker.width).toBeCloseTo(CELL, 6);
    expect(marker.height).toBeCloseTo(CELL, 6);
  });

  it('bez textúry značky → fallback `Graphics` v rovnakej polohe a rotácii', () => {
    const build = layer(null);
    build.setModuleGhost({ ...berthGhost(), connectors: [{ x: 60, y: 20, side: 'w' }] });
    const marker = markers(build)[0];
    expect(marker).toBeInstanceOf(Graphics);
    expect(marker.position.x).toBe(60.5 * CELL);
    expect(marker.angle).toBeCloseTo(90, 9);
  });

  it('rotovaný modul: konektory vo svetových bunkách po rotácii, uhol značky podľa strany', () => {
    // berth rot 90 na (10, 10): footprint 4×8; konektory z manifestu otočené rovnako ako v sime
    const rotation: Rotation = 90;
    const spec = moduleSprite('berth_standard')?.connectors ?? [];
    const sideAfterRotation = { s: 'w', w: 'n', n: 'e', e: 's' } as const; // otočenie strany o 90° v smere hodinových ručičiek
    const connectors = spec.map((c) => {
      const cell = rotateLocalCell(c.x, c.y, 8, 4, rotation);
      return { x: 10 + cell.x, y: 10 + cell.y, side: sideAfterRotation[c.side] };
    });
    const build = layer();
    build.setModuleGhost({ defId: 'berth_standard', x: 10, y: 10, rotation, w: 4, h: 8, valid: true, connectors });
    expect(build.shownCount).toBe(32);
    const shown = visible(markers(build));
    expect(shown).toHaveLength(8);
    // všetky konektory berthu majú stranu s → po rotácii o 90° strana w → šípka 90°
    for (const marker of shown.slice(0, 2)) expect(marker.angle).toBeCloseTo(90, 9);
    expect(shown[0].position.x).toBe((connectors[0].x + 0.5) * CELL);
    expect(shown[0].position.y).toBe((connectors[0].y + 0.5) * CELL);
  });

  it('null skryje ghost aj značky; značky sa znovupoužijú (pool)', () => {
    const build = layer();
    build.setModuleGhost(berthGhost());
    const pool = markers(build).slice();
    build.setModuleGhost(null);
    expect(build.shownCount).toBe(0);
    expect(build.markerCount).toBe(0);
    build.setModuleGhost(berthGhost());
    expect(markers(build)).toHaveLength(8);
    expect(markers(build)[0]).toBe(pool[0]);
  });

  it('cestný `setGhost` po ghoste modulu skryje značky konektorov', () => {
    const build = layer();
    build.setModuleGhost(berthGhost());
    build.setGhost([{ x: 1, y: 1, valid: true }]);
    expect(build.markerCount).toBe(0);
    expect(build.shownCount).toBe(1);
  });

  it('po destroy je setModuleGhost bez účinku', () => {
    const build = layer();
    build.destroy();
    expect(() => {
      build.setModuleGhost(berthGhost());
    }).not.toThrow();
  });
});
