import { Graphics, Sprite, type FillInstruction, type StrokeInstruction } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Grid, type CellCoord, type Direction4Name, type RoadKind } from '@sim/grid';
import { AUTOTILE_TABLE } from '@render/autotile';
import { RoadLayer } from '@render/road-layer';
import { PALETTE, StubTextures } from './stub-textures';

function emptyGrid(size: number): Grid {
  return new Grid(size, size, () => ({ terrain: 'land' }));
}

function setRoads(grid: Grid, cells: readonly CellCoord[], kind: RoadKind = 'two_lane', dir: Direction4Name | null = null): void {
  for (const { x, y } of cells) {
    const cell = grid.at(x, y);
    cell.road = 'road';
    cell.roadKind = kind;
    cell.roadDir = dir;
  }
}

const row = (y: number, x1: number, x2: number): CellCoord[] => Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));

const displayAt = (layer: RoadLayer, x: number, y: number) =>
  layer.view.children.find((child) => child.x === (x + 0.5) * PALETTE.cellPx && child.y === (y + 0.5) * PALETTE.cellPx);

describe('RoadLayer: typ cesty určuje štýl dlaždice (sprite × procedurálna úzka cesta)', () => {
  it('two_lane = Sprite z atlasu; one_lane a one_way = Graphics (bez spritu), s rovnakým tvarom, rotáciou a polohou', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(2, 1, 4), 'two_lane');
    setRoads(grid, row(4, 1, 4), 'one_lane');
    setRoads(grid, row(6, 1, 4), 'one_way', 'E');
    const textures = new StubTextures();
    const layer = new RoadLayer(grid, PALETTE, textures);
    expect(layer.tileCount).toBe(12);
    for (const [y, kind] of [
      [2, 'two_lane'],
      [4, 'one_lane'],
      [6, 'one_way'],
    ] as const) {
      const display = displayAt(layer, 2, y);
      expect(display, kind).toBeDefined();
      if (kind === 'two_lane') {
        expect(display).toBeInstanceOf(Sprite);
        expect(layer.tileStyleAt(2, y)).toBe('wide');
      } else {
        expect(display).toBeInstanceOf(Graphics);
        expect(layer.tileStyleAt(2, y)).toBe('narrow:0');
      }
      // rovnaký autotile: vodorovná rovná cesta = `straight` otočená o 90°
      expect(layer.tileAt(2, y)).toEqual({ shape: 'straight', rotation: 90 });
      expect(display?.angle).toBe(90);
    }
    // koncové bunky sú `end` s rotáciou podľa tabuľky, rovnako pre všetky typy
    expect(layer.tileAt(1, 4)).toEqual(AUTOTILE_TABLE[2]);
    expect(layer.tileAt(4, 6)).toEqual(AUTOTILE_TABLE[8]);
    // úzke cesty nežiadajú sprite: textúry sa pýtali len pre dvojpruhovú cestu
    expect(new Set(textures.requests)).toEqual(new Set(['infra/road/straight', 'infra/road/end']));
  });

  it('bez textúr sú všetky typy Graphics; úzka cesta je iná geometria než široká', () => {
    const grid = emptyGrid(8);
    setRoads(grid, row(2, 1, 4), 'two_lane');
    setRoads(grid, row(5, 1, 4), 'one_lane');
    const layer = new RoadLayer(grid, PALETTE);
    expect(layer.view.children.every((child) => child instanceof Graphics)).toBe(true);
    const wide = displayAt(layer, 2, 2) as Graphics;
    const narrow = displayAt(layer, 2, 5) as Graphics;
    expect(wide.context).not.toBe(narrow.context);
  });

  it('úzka dlaždica používa farby z tokenov: asfalt `--road-base`, okraj odvodený od nej, žiadna stredová čiara', () => {
    const grid = emptyGrid(8);
    setRoads(grid, row(3, 1, 5), 'one_lane');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    const tile = displayAt(layer, 3, 3) as Graphics;
    const fills = tile.context.instructions.filter((i): i is FillInstruction => i.action === 'fill');
    const strokes = tile.context.instructions.filter((i): i is StrokeInstruction => i.action === 'stroke');
    expect(fills.length).toBeGreaterThan(0);
    expect(strokes.length).toBeGreaterThan(0);
    for (const fill of fills) expect(fill.data.style.color).toBe(PALETTE.road.base.color);
    for (const stroke of strokes) {
      expect(stroke.data.style.color).toBe(PALETTE.road.edge.color);
      expect(stroke.data.style.width).toBeCloseTo((2 / 64) * PALETTE.cellPx, 9);
    }
    const usedColors = new Set([...fills, ...strokes].map((instruction) => instruction.data.style.color));
    expect(usedColors.has(PALETTE.road.marking.color)).toBe(false);
  });

  it('rovnaký tvar a lievik zdieľajú jednu geometriu (contexts sa nekopírujú pre každú dlaždicu)', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(3, 1, 8), 'one_lane');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    const a = displayAt(layer, 3, 3) as Graphics;
    const b = displayAt(layer, 5, 3) as Graphics;
    expect(a.context).toBe(b.context);
  });

  it('rotácia úzkej dlaždice: pivot v strede bunky, uhol z autotile tabuľky', () => {
    const grid = emptyGrid(8);
    setRoads(grid, [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 3, y: 4 }], 'one_way', 'S');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    const corner = displayAt(layer, 3, 3) as Graphics;
    expect(layer.tileAt(3, 3)).toEqual({ shape: 'corner', rotation: 90 });
    expect(corner.angle).toBe(90);
    expect(corner.pivot.x).toBe(PALETTE.cellPx / 2);
    expect(corner.pivot.y).toBe(PALETTE.cellPx / 2);
  });
});

describe('RoadLayer: spoj úzkej a širokej cesty (lievik na rameni k širokému susedovi)', () => {
  it('úzka cesta vedľa širokej má lievik práve na rameni k susedovi; ostatné ramená bez lievika', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(4, 1, 3), 'two_lane');
    setRoads(grid, row(4, 4, 8), 'one_lane');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    // (4; 4) je `straight` otočená o 90° (rameno N základnej orientácie = východ vo svete); západný sused (3; 4) je široký
    // → po otočení späť do základnej orientácie je to rameno S (maska 4)
    expect(layer.tileAt(4, 4)).toEqual({ shape: 'straight', rotation: 90 });
    expect(layer.tileStyleAt(4, 4)).toBe('narrow:4');
    expect(layer.tileStyleAt(5, 4)).toBe('narrow:0'); // sused je úzky
    expect(layer.tileStyleAt(3, 4)).toBe('wide'); // široká dlaždica sa nemení
  });

  it('maska lievika sa otáča s dlaždicou: východný, južný aj severný široký sused', () => {
    const cases: readonly { neighbour: CellCoord; expected: string }[] = [
      { neighbour: { x: 5, y: 4 }, expected: 'narrow:1' }, // východ vo svete, `straight` 90° → rameno N
      { neighbour: { x: 4, y: 5 }, expected: 'narrow:1' }, // juh: `end` 180° má rameno N základnej orientácie na juh
      { neighbour: { x: 4, y: 3 }, expected: 'narrow:1' }, // sever: `end` 0°
    ];
    for (const { neighbour, expected } of cases) {
      const grid = emptyGrid(10);
      setRoads(grid, [{ x: 4, y: 4 }], 'one_lane');
      setRoads(grid, [neighbour], 'two_lane');
      // dva široké susedia nie sú: aby tvar `end` mal jediné rameno, stačí jeden sused
      const layer = new RoadLayer(grid, PALETTE, new StubTextures());
      expect(layer.tileStyleAt(4, 4), `sused ${String(neighbour.x)};${String(neighbour.y)}`).toBe(expected);
    }
  });

  it('T-križovatka širokej cesty s úzkou vetvou: lievik má len úzka vetva; kríž úzkych ciest bez lievikov', () => {
    const grid = emptyGrid(14);
    setRoads(grid, row(5, 2, 10), 'two_lane');
    setRoads(grid, [{ x: 6, y: 4 }, { x: 6, y: 3 }, { x: 6, y: 2 }], 'one_lane'); // vetva na sever
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    expect(layer.tileAt(6, 5)).toEqual({ shape: 't', rotation: 0 });
    expect(layer.tileStyleAt(6, 5)).toBe('wide');
    expect(layer.tileAt(6, 4)).toEqual({ shape: 'straight', rotation: 0 });
    expect(layer.tileStyleAt(6, 4)).toBe('narrow:4'); // južné rameno je k širokej križovatke
    expect(layer.tileStyleAt(6, 3)).toBe('narrow:0');
    const narrowCross = emptyGrid(10);
    setRoads(narrowCross, [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 3 }, { x: 4, y: 5 }], 'one_way', 'E');
    expect(new RoadLayer(narrowCross, PALETTE, new StubTextures()).tileStyleAt(4, 4)).toBe('narrow:0');
  });

  it('lievik v zákrute úzkej cesty vedľa širokej', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(4, 1, 4), 'two_lane');
    setRoads(grid, [{ x: 5, y: 4 }, { x: 5, y: 5 }, { x: 5, y: 6 }], 'one_lane'); // (5; 4) je zákruta W–S
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    expect(layer.tileAt(5, 4)).toEqual({ shape: 'corner', rotation: 180 });
    // rameno W je vo svete západ; corner 180° má základné ramená N, E → vo svete S, W → západ = základné rameno E
    expect(layer.tileStyleAt(5, 4)).toBe('narrow:2');
  });

  it('bez textúr sa lievik prispôsobí užšiemu dočasnému kresleniu široké cesty (pás 48 px)', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(4, 1, 3), 'two_lane');
    setRoads(grid, row(4, 4, 8), 'one_lane');
    const withSprites = displayAt(new RoadLayer(grid, PALETTE, new StubTextures()), 4, 4) as Graphics;
    const withoutSprites = displayAt(new RoadLayer(grid, PALETTE), 4, 4) as Graphics;
    expect(withSprites.context).not.toBe(withoutSprites.context);
  });
});

describe('RoadLayer: zmena typu cesty a susedov prekreslí dlaždice', () => {
  it('prestavba dvojpruhovej cesty na jednopruhovú: sprite nahradí Graphics, susedia získajú lievik', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(4, 1, 7), 'two_lane');
    const textures = new StubTextures();
    const layer = new RoadLayer(grid, PALETTE, textures);
    const before = displayAt(layer, 4, 4);
    expect(before).toBeInstanceOf(Sprite);

    setRoads(grid, [{ x: 4, y: 4 }], 'one_lane');
    const changed = layer.updateRoads([{ x: 4, y: 4 }]);
    expect(changed).toBe(1); // tvar susedov sa nemení, ostáva ich sprite
    expect(displayAt(layer, 4, 4)).toBeInstanceOf(Graphics);
    expect(before?.destroyed).toBe(true);
    expect(layer.tileStyleAt(4, 4)).toBe('narrow:5'); // oba susedia (východ aj západ) sú široké: rameno N aj S
    expect(layer.tileCount).toBe(7);
    expect(layer.view.children).toHaveLength(7);
  });

  it('zmena typu suseda zmení lievik úzkej dlaždice (RoadChanged.cells + susedia)', () => {
    const grid = emptyGrid(12);
    setRoads(grid, row(4, 1, 8), 'one_lane');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    expect(layer.tileStyleAt(5, 4)).toBe('narrow:0');

    setRoads(grid, [{ x: 4, y: 4 }], 'two_lane');
    layer.updateRoads([{ x: 4, y: 4 }]);
    expect(layer.tileStyleAt(4, 4)).toBe('wide');
    expect(layer.tileStyleAt(5, 4)).toBe('narrow:4'); // (4; 4) je teraz široká vľavo od (5; 4)
    expect(layer.tileStyleAt(3, 4)).toBe('narrow:1'); // a vpravo od (3; 4)

    setRoads(grid, [{ x: 4, y: 4 }], 'one_lane');
    layer.updateRoads([{ x: 4, y: 4 }]);
    expect(layer.tileStyleAt(5, 4)).toBe('narrow:0');
    expect(layer.tileStyleAt(3, 4)).toBe('narrow:0');
  });

  it('zmena typu bez zmeny masky susedov (napr. one_lane → one_way) tiež prekreslí len tú bunku; rovnaký typ nič', () => {
    const grid = emptyGrid(10);
    setRoads(grid, row(4, 1, 6), 'one_lane');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    const same = displayAt(layer, 3, 4);
    expect(layer.updateRoads([{ x: 3, y: 4 }])).toBe(0); // nič sa nezmenilo
    expect(displayAt(layer, 3, 4)).toBe(same);
    setRoads(grid, [{ x: 3, y: 4 }], 'one_way', 'W');
    expect(layer.updateRoads([{ x: 3, y: 4 }])).toBe(0); // štýl `narrow:0` a tvar rovnaké: dlaždica sa neprekresľuje
    expect(displayAt(layer, 3, 4)).toBe(same);
  });

  it('odstránená úzka cesta zmizne; zvyšné dlaždice ostanú', () => {
    const grid = emptyGrid(10);
    setRoads(grid, row(4, 1, 5), 'one_way', 'E');
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    grid.at(5, 4).road = 'none';
    layer.updateRoads([{ x: 5, y: 4 }]);
    expect(layer.tileAt(5, 4)).toBeUndefined();
    expect(layer.tileStyleAt(5, 4)).toBeUndefined();
    expect(layer.tileCount).toBe(4);
  });

  it('rebuild() a destroy() uvoľnia aj geometrie úzkych ciest', () => {
    const grid = emptyGrid(10);
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    setRoads(grid, row(4, 1, 5), 'one_lane');
    layer.rebuild();
    const context = (displayAt(layer, 3, 4) as Graphics).context;
    layer.destroy();
    expect(layer.view.destroyed).toBe(true);
    expect(context.destroyed).toBe(true);
  });
});
