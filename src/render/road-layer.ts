/**
 * RoadLayer (ARCHITECTURE §15.1): cesty ako autotile podľa susedov; prekresľuje sa len pri zmene (`RoadChanged`).
 *
 * Tvar a rotáciu určuje `autotile.ts` (tabuľka T01-08); sprite je `infra.road.tiles.<tvar>` z manifestu
 * (`assets/infra/road_*.svg`, DESIGN_BRIEF §5.2), nakreslený v základnej orientácii (`end` na sever, `straight` zvislá,
 * `corner` N→E, `t` bez juhu, `cross`) a otočený okolo stredu bunky. Konzistenciu tabuľky s `connectsAtRot0` z manifestu
 * stráži `tests/tools/asset-manifest.test.ts`.
 *
 * Bez textúr (`textures === null`, napr. testy bez DOM alebo chýbajúci sprite) padá na dočasné kreslenie z tokenov
 * (`--road-base`, `--road-marking`): každý tvar má jeden zdieľaný `GraphicsContext`, dlaždica je `Graphics` nad ním
 * (pozícia + `angle`), takže tisíc ciest = tisíc ľahkých objektov nad piatimi geometriami.
 *
 * Vrstva je vlastná render group: posun kamery (transformácia rodiča) neprepočítava dlaždice a zmena ciest
 * prestavia len túto vrstvu, nie terén.
 *
 * Kreslí sa iba vrstva `road`; koľaje (`rail`) pribudnú s ich stavbou (tokeny `--rail-*`).
 */
import { Container, Graphics, GraphicsContext, Sprite } from 'pixi.js';
import { DIRECTIONS_4, type CellCoord, type Grid, type Rect, type Rotation } from '@sim/grid';
import {
  AUTOTILE_SHAPE_BASE_MASK,
  autotileAffected,
  autotileTile,
  type AutotileShape,
  type AutotileTile,
} from './autotile';
import type { Point } from './camera';
import type { SpriteTextures } from './sprite-atlas';
import type { RenderPalette } from './tokens';

/** Vrstva dopravy, ktorú tento layer kreslí. */
const LAYER = 'road' as const;

/** Šírka pásu cesty ako zlomok bunky (`--cell`); zvyšok bunky ostáva terén. */
export const ROAD_BAND_CELLS = 3 / 4;

/** Šírka stredovej čiary ako zlomok bunky (`--cell`; 2 px pri 64 px). */
export const ROAD_MARKING_CELLS = 1 / 32;

/** Stred bunky v jednotkách buniek. */
const MID = 0.5;

/**
 * Telo cesty tvaru `shape` v základnej orientácii: stred bunky + rameno k hrane bunky v každom smere masky tvaru.
 * Obdĺžniky v jednotkách buniek (0…1); ramená sa prekrývajú v strede (farba je nepriehľadná).
 */
export function roadBodyRects(shape: AutotileShape): Rect[] {
  const half = ROAD_BAND_CELLS / 2;
  const mask = AUTOTILE_SHAPE_BASE_MASK[shape];
  const rects: Rect[] = [];
  for (const { bit, dx, dy } of DIRECTIONS_4) {
    if ((mask & bit) === 0) continue;
    const reach = MID + half; // rameno od hrany bunky po vzdialenejšiu hranu stredu
    if (dx === 0) rects.push({ x: MID - half, y: dy < 0 ? 0 : MID - half, w: ROAD_BAND_CELLS, h: reach });
    else rects.push({ x: dx < 0 ? 0 : MID - half, y: MID - half, w: reach, h: ROAD_BAND_CELLS });
  }
  return rects;
}

const TOP: Point = { x: MID, y: 0 };
const BOTTOM: Point = { x: MID, y: 1 };
const LEFT: Point = { x: 0, y: MID };
const RIGHT: Point = { x: 1, y: MID };
const CENTER: Point = { x: MID, y: MID };

/** Stredová čiara každého tvaru v základnej orientácii (lomené čiary v jednotkách buniek). */
const MARKING_PATHS: Readonly<Record<AutotileShape, readonly (readonly Point[])[]>> = Object.freeze({
  end: [[TOP, CENTER]],
  straight: [[TOP, BOTTOM]],
  corner: [[TOP, CENTER, RIGHT]],
  t: [[LEFT, RIGHT], [TOP, CENTER]],
  cross: [[TOP, BOTTOM], [LEFT, RIGHT]],
});

/** Stredové čiary tvaru `shape` (základná orientácia), body v jednotkách buniek. */
export function roadMarkingPaths(shape: AutotileShape): readonly (readonly Point[])[] {
  return MARKING_PATHS[shape];
}

interface RoadTile {
  /** `Sprite` (textúra z atlasu) alebo `Graphics` (fallback). */
  readonly display: Container;
  readonly shape: AutotileShape;
  readonly rotation: Rotation;
}

export class RoadLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'roads', isRenderGroup: true });
  /** Dlaždice podľa row-major indexu bunky. */
  private readonly tiles = new Map<number, RoadTile>();
  /** Zdieľaná geometria podľa tvaru (vytvára sa lazy). */
  private readonly contexts = new Map<AutotileShape, GraphicsContext>();

  /**
   * @param textures sprity ciest z `SpriteAtlas`; `null` = dočasné `Graphics` z tokenov
   */
  constructor(
    private readonly grid: Grid,
    private readonly palette: RenderPalette,
    private readonly textures: SpriteTextures | null = null,
  ) {
    this.rebuild();
  }

  /** Počet nakreslených dlaždíc ciest. */
  get tileCount(): number {
    return this.tiles.size;
  }

  /** Tvar a rotácia nakreslenej dlaždice na (x, y), alebo `undefined`, ak tam cesta nie je. */
  tileAt(x: number, y: number): AutotileTile | undefined {
    if (!this.grid.inBounds(x, y)) return undefined;
    const tile = this.tiles.get(this.grid.index(x, y));
    return tile ? { shape: tile.shape, rotation: tile.rotation } : undefined;
  }

  /** Znova nakreslí všetky cesty z mriežky (úvodný stav, napr. starter cesty, alebo po načítaní hry). */
  rebuild(): void {
    this.clearTiles();
    for (let y = 0; y < this.grid.height; y++) {
      for (let x = 0; x < this.grid.width; x++) this.refresh(x, y);
    }
  }

  /**
   * Prekreslí zmenené bunky (`RoadChanged.cells`) a ich 4 susedov — susedia menia masku, takže sa mení tvar.
   * @returns počet dlaždíc, ktoré sa vytvorili, nahradili alebo zmizli (bunky bez zmeny sa nedotknú)
   */
  updateRoads(cells: readonly CellCoord[]): number {
    let changed = 0;
    for (const { x, y } of autotileAffected(this.grid, cells)) {
      if (this.refresh(x, y)) changed += 1;
    }
    return changed;
  }

  destroy(): void {
    this.tiles.clear();
    this.view.destroy({ children: true }); // dlaždice najprv, potom zdieľané geometrie
    for (const context of this.contexts.values()) context.destroy();
    this.contexts.clear();
  }

  /** Zosúladí dlaždicu bunky s mriežkou; `true`, ak sa niečo zmenilo. */
  private refresh(x: number, y: number): boolean {
    const index = this.grid.index(x, y);
    const existing = this.tiles.get(index);
    const wanted = autotileTile(this.grid, x, y, LAYER);
    if (existing && wanted && existing.shape === wanted.shape && existing.rotation === wanted.rotation) return false;
    if (!existing && !wanted) return false;
    if (existing) {
      existing.display.destroy(); // textúra ani zdieľaný context sa neničia (destroy bez volieb)
      this.tiles.delete(index);
    }
    if (wanted) this.tiles.set(index, this.createTile(x, y, wanted));
    return true;
  }

  private createTile(x: number, y: number, { shape, rotation }: AutotileTile): RoadTile {
    const { cellPx } = this.palette;
    let display: Container;
    if (this.textures !== null) {
      // Sprite v základnej orientácii, otáča sa okolo stredu bunky (anchor 0,5).
      const sprite = new Sprite(this.textures.infra(LAYER, shape));
      sprite.anchor.set(MID);
      sprite.setSize(cellPx, cellPx);
      display = sprite;
    } else {
      const graphics = new Graphics(this.contextFor(shape));
      graphics.pivot.set(cellPx / 2, cellPx / 2);
      display = graphics;
    }
    display.position.set((x + MID) * cellPx, (y + MID) * cellPx);
    display.angle = rotation;
    this.view.addChild(display);
    return { display, shape, rotation };
  }

  private clearTiles(): void {
    for (const tile of this.tiles.values()) tile.display.destroy();
    this.tiles.clear();
  }

  private contextFor(shape: AutotileShape): GraphicsContext {
    const cached = this.contexts.get(shape);
    if (cached) return cached;
    const { cellPx, road } = this.palette;
    const context = new GraphicsContext();
    for (const r of roadBodyRects(shape)) context.rect(r.x * cellPx, r.y * cellPx, r.w * cellPx, r.h * cellPx);
    context.fill(road.base);
    for (const path of roadMarkingPaths(shape)) {
      path.forEach((p, i) => {
        if (i === 0) context.moveTo(p.x * cellPx, p.y * cellPx);
        else context.lineTo(p.x * cellPx, p.y * cellPx);
      });
    }
    context.stroke({ width: ROAD_MARKING_CELLS * cellPx, color: road.marking.color, alpha: road.marking.alpha, cap: 'butt', join: 'miter' });
    this.contexts.set(shape, context);
    return context;
  }
}
