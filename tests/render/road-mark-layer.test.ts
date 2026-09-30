import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { DIRECTIONS_4, Grid, ROAD_KINDS, ROAD_KIND_TRAITS, type CellCoord, type Direction4Name, type RoadKind } from '@sim/grid';
import { BuildLayer, loadGhostPalette, type GhostCell } from '@render/build-layer';
import { PATH_ARROW_FOOTPRINT } from '@render/overlay-assets';
import { ARROW_ROTATION, RoadMarkLayer } from '@render/road-mark-layer';
import { PALETTE, StubTextures, TOKENS } from './stub-textures';

const CELL = PALETTE.cellPx;

function emptyGrid(size: number): Grid {
  return new Grid(size, size, () => ({ terrain: 'land' }));
}

function setRoad(grid: Grid, cell: CellCoord, kind: RoadKind, dir: Direction4Name | null = null): void {
  const at = grid.at(cell.x, cell.y);
  at.road = 'road';
  at.roadKind = kind;
  at.roadDir = dir;
}

describe('ARROW_ROTATION (sprite `path_arrow` ukazuje na sever)', () => {
  it('N 0°, E 90°, S 180°, W 270° — poradie DIRECTIONS_4 × 90°', () => {
    expect(ARROW_ROTATION).toEqual({ N: 0, E: 90, S: 180, W: 270 });
    DIRECTIONS_4.forEach((direction, index) => expect(ARROW_ROTATION[direction.name]).toBe(index * 90));
  });

  it('manifest: šípka je 1×1 bunka (rotatable)', () => {
    expect(PATH_ARROW_FOOTPRINT).toEqual({ w: 1, h: 1 });
  });
});

describe('RoadMarkLayer: šípky smeru jednosmerky', () => {
  it('šípku dostane každá bunka `one_way` so smerom, otočenú podľa `roadDir`; ostatné typy ciest nie', () => {
    const grid = emptyGrid(12);
    (['N', 'E', 'S', 'W'] as const).forEach((dir, i) => setRoad(grid, { x: 1 + i * 2, y: 2 }, 'one_way', dir));
    setRoad(grid, { x: 1, y: 5 }, 'two_lane');
    setRoad(grid, { x: 3, y: 5 }, 'one_lane');
    const textures = new StubTextures();
    const layer = new RoadMarkLayer(grid, PALETTE, textures.overlay('path_arrow'));
    expect(layer.arrowCount).toBe(4);
    (['N', 'E', 'S', 'W'] as const).forEach((dir, i) => {
      expect(layer.arrowAt(1 + i * 2, 2)).toBe(ARROW_ROTATION[dir]);
    });
    expect(layer.arrowAt(1, 5)).toBeUndefined();
    expect(layer.arrowAt(3, 5)).toBeUndefined();
    expect(layer.arrowAt(-1, 0)).toBeUndefined();
  });

  it('šípka je Sprite s textúrou `overlay.path_arrow`, veľkosť 1 bunka, vycentrovaná na bunku, uhol z rotácie', () => {
    const grid = emptyGrid(8);
    setRoad(grid, { x: 3, y: 4 }, 'one_way', 'S');
    const textures = new StubTextures();
    const layer = new RoadMarkLayer(grid, PALETTE, textures.overlay('path_arrow'));
    const sprite = layer.view.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('overlay/path_arrow'));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(0.5);
    expect(sprite.width).toBeCloseTo(CELL, 6);
    expect(sprite.height).toBeCloseTo(CELL, 6);
    expect(sprite.x).toBe(3.5 * CELL);
    expect(sprite.y).toBe(4.5 * CELL);
    expect(sprite.angle).toBe(180);
  });

  it('bez textúry je šípka Graphics z tokenu --ui-accent', () => {
    const grid = emptyGrid(8);
    setRoad(grid, { x: 3, y: 4 }, 'one_way', 'W');
    const layer = new RoadMarkLayer(grid, PALETTE);
    const arrow = layer.view.children[0];
    expect(arrow).toBeInstanceOf(Graphics);
    expect(arrow.angle).toBe(270);
    expect(PALETTE.road.arrow.color).toBe(0x3aa0ff);
  });

  it('šípka je na každej bunke jednosmerky; v zákrute leží v strede oblúka pruhu a je otočená o os kurzov', () => {
    const grid = emptyGrid(10);
    const cells = [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 4, y: 3 },
      { x: 4, y: 4 },
    ];
    const dirs: Direction4Name[] = ['E', 'E', 'S', 'S', 'S'];
    cells.forEach((cell, i) => setRoad(grid, cell, 'one_way', dirs[i]));
    const layer = new RoadMarkLayer(grid, PALETTE, Texture.WHITE);
    expect(layer.arrowCount).toBe(5);
    // (4; 2) je zákruta W–S (z východu na juh): os medzi kurzami 90° a 180° je 135°
    expect(cells.map((cell) => layer.arrowAt(cell.x, cell.y))).toEqual([90, 90, 135, 180, 180]);
    const corner = layer.arrowPoseAt(4, 2);
    // stred oblúka (polomer 32 px) je bližšie k vnútornému rohu (SW) než stred bunky (45,25 px): posun (−9,4; +9,4) px
    expect(corner?.dx).toBeCloseTo(-(45.254834 - 32) / Math.SQRT2 / 64, 6);
    expect(corner?.dy).toBeCloseTo((45.254834 - 32) / Math.SQRT2 / 64, 6);
    const sprite = layer.view.children[2] as Sprite;
    expect(sprite.x).toBeCloseTo((4.5 + (corner?.dx ?? 0)) * CELL, 9);
    expect(sprite.y).toBeCloseTo((2.5 + (corner?.dy ?? 0)) * CELL, 9);
    expect(sprite.angle).toBe(135);
    expect(layer.arrowPoseAt(3, 2)).toEqual({ dx: 0, dy: 0, angle: 90 }); // rovná bunka: stred bunky
  });

  it('tvar bunky závisí od susedov: nový sused zmení zákrutu na T (šípka späť do stredu bunky), updateCells prekreslí aj susedov', () => {
    const grid = emptyGrid(10);
    for (const [x, y, dir] of [[2, 2, 'E'], [3, 2, 'S'], [3, 3, 'S']] as const) setRoad(grid, { x, y }, 'one_way', dir);
    const layer = new RoadMarkLayer(grid, PALETTE, Texture.WHITE);
    expect(layer.arrowAt(3, 2)).toBe(135);
    setRoad(grid, { x: 4, y: 2 }, 'one_lane'); // vznikne T: (3; 2) má troch susedov
    const changed = layer.updateCells([{ x: 4, y: 2 }]); // zmenená bola len (4; 2), (3; 2) je jej sused
    expect(changed).toBe(1);
    expect(layer.arrowPoseAt(3, 2)).toEqual({ dx: 0, dy: 0, angle: 180 });
  });

  it('updateCells: nová jednosmerka, otočenie smeru, prestavba na iný typ a odstránenie; nezmenené bunky sa nedotknú', () => {
    const grid = emptyGrid(10);
    setRoad(grid, { x: 2, y: 2 }, 'one_way', 'E');
    setRoad(grid, { x: 6, y: 6 }, 'one_way', 'N');
    const layer = new RoadMarkLayer(grid, PALETTE, Texture.WHITE);
    const far = layer.view.children[1];
    expect(layer.updateCells([{ x: 2, y: 2 }])).toBe(0); // nič sa nezmenilo
    setRoad(grid, { x: 3, y: 2 }, 'one_way', 'E');
    expect(layer.updateCells([{ x: 3, y: 2 }])).toBe(1);
    expect(layer.arrowCount).toBe(3);
    setRoad(grid, { x: 3, y: 2 }, 'one_way', 'W'); // otočený smer
    expect(layer.updateCells([{ x: 3, y: 2 }])).toBe(1);
    expect(layer.arrowAt(3, 2)).toBe(270);
    setRoad(grid, { x: 3, y: 2 }, 'two_lane'); // prestavba na dvojpruhovú → šípka zmizne
    expect(layer.updateCells([{ x: 3, y: 2 }])).toBe(1);
    expect(layer.arrowAt(3, 2)).toBeUndefined();
    grid.at(2, 2).road = 'none';
    expect(layer.updateCells([{ x: 2, y: 2 }, { x: 2, y: 2 }, { x: -5, y: 9 }])).toBe(1);
    expect(layer.arrowCount).toBe(1);
    expect(layer.view.children).toContain(far);
    expect(layer.view.children).toHaveLength(1);
  });

  it('koľaj ani cesta bez smeru šípku nemá', () => {
    const grid = emptyGrid(6);
    grid.at(2, 2).road = 'rail';
    setRoad(grid, { x: 3, y: 3 }, 'one_way', null);
    expect(new RoadMarkLayer(grid, PALETTE, Texture.WHITE).arrowCount).toBe(0);
  });

  it('rebuild a destroy; šípky sú len pre typy s `oneWay` z tabuľky simu', () => {
    const grid = emptyGrid(8);
    const layer = new RoadMarkLayer(grid, PALETTE, Texture.WHITE);
    setRoad(grid, { x: 1, y: 1 }, 'one_way', 'N');
    layer.rebuild();
    expect(layer.arrowCount).toBe(1);
    layer.destroy();
    expect(layer.view.destroyed).toBe(true);
    expect(ROAD_KINDS.filter((kind) => ROAD_KIND_TRAITS[kind].oneWay)).toEqual(['one_way']);
  });

  it('vrstva nereaguje na myš (šípky nekradnú kliky)', () => {
    expect(new RoadMarkLayer(emptyGrid(4), PALETTE).view.eventMode).toBe('none');
  });
});

describe('BuildLayer: šípky smeru v ghoste jednosmerky', () => {
  const build = (pathArrow: Texture | null = Texture.WHITE): BuildLayer =>
    new BuildLayer({ cellPx: CELL, palette: loadGhostPalette(TOKENS), hatch: Texture.WHITE, pathArrow });

  it('bunka s `dir` dostane šípku otočenú podľa smeru; bunky bez `dir` nie', () => {
    const layer = build();
    const cells: GhostCell[] = [
      { x: 4, y: 4, valid: true, dir: 'E' },
      { x: 5, y: 4, valid: true, dir: 'E' },
      { x: 5, y: 5, valid: false, dir: 'S' },
      { x: 9, y: 9, valid: true },
    ];
    layer.setGhost(cells);
    expect(layer.arrowCount).toBe(3);
    expect([0, 1, 2].map((i) => layer.arrowRotationAt(i))).toEqual([90, 90, 180]);
    expect(layer.arrowRotationAt(3)).toBeUndefined();
    const arrows = (layer.view.children[4] as Container).children;
    expect(arrows[0]).toBeInstanceOf(Sprite);
    expect(arrows[0].x).toBe(4.5 * CELL);
    expect(arrows[0].y).toBe(4.5 * CELL);
    expect(arrows[2].x).toBe(5.5 * CELL);
    expect(arrows[2].y).toBe(5.5 * CELL);
  });

  it('nový ghost, ghost bez smeru, ghost modulu a clear šípky skryjú; pool sa znovupoužije', () => {
    const layer = build();
    layer.setGhost([{ x: 1, y: 1, valid: true, dir: 'N' }, { x: 2, y: 1, valid: true, dir: 'N' }]);
    const pool = (layer.view.children[4] as Container).children.slice();
    expect(layer.arrowCount).toBe(2);
    layer.setGhost([{ x: 1, y: 1, valid: true, dir: 'W' }]);
    expect(layer.arrowCount).toBe(1);
    expect(layer.arrowRotationAt(0)).toBe(270);
    expect((layer.view.children[4] as Container).children).toEqual(pool); // žiadne nové objekty
    layer.setGhost([{ x: 1, y: 1, valid: true }]);
    expect(layer.arrowCount).toBe(0);
    layer.setGhost([{ x: 1, y: 1, valid: true, dir: 'S' }]);
    layer.clearGhost();
    expect(layer.arrowCount).toBe(0);
    layer.setGhost([{ x: 1, y: 1, valid: true, dir: 'S' }]);
    layer.setModuleGhost(null);
    expect(layer.arrowCount).toBe(0);
  });

  it('bez textúry šípky je fallback Graphics', () => {
    const layer = build(null);
    layer.setGhost([{ x: 1, y: 1, valid: true, dir: 'E' }]);
    expect((layer.view.children[4] as Container).children[0]).toBeInstanceOf(Graphics);
    expect(layer.arrowRotationAt(0)).toBe(90);
  });

  it('šípka je nad výplňou a šrafou ghostu (posledné dieťa koreňa), ale ghost sa kreslí ako doteraz', () => {
    const layer = build();
    layer.setGhost([{ x: 1, y: 1, valid: false, dir: 'E' }]);
    expect(layer.view.children).toHaveLength(5);
    expect(layer.shownCount).toBe(1);
    expect(layer.view.children[4].label).toBe('ghost-arrows');
  });
});
