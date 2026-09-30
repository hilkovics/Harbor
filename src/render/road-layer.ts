/**
 * RoadLayer (ARCHITECTURE §15.1): cesty ako autotile podľa susedov; prekresľuje sa len pri zmene (`RoadChanged`).
 *
 * Tvar a rotáciu určuje `autotile.ts` (tabuľka T01-08) — nezávisle od typu cesty; sprite je `infra.road.tiles.<tvar>`
 * z manifestu (`assets/infra/road_*.svg`, DESIGN_BRIEF §5.2), nakreslený v základnej orientácii (`end` na sever,
 * `straight` zvislá, `corner` N→E, `t` bez juhu, `cross`) a otočený okolo stredu bunky. Konzistenciu tabuľky
 * s `connectsAtRot0` z manifestu stráži `tests/tools/asset-manifest.test.ts`.
 *
 * **Typ cesty** (`Cell.roadKind`, ADR-020): `two_lane` sa kreslí spritami. Jednopruhové cesty (`one_lane`, `one_way`;
 * `ROAD_KIND_TRAITS[kind].lanes === 1`) nemajú sprity, kreslia sa procedurálne (`narrow-road.ts`): asfalt 40 px, okraje
 * 2 px, bez stredovej čiary, rovnaký tvar a rotácia. Ich ramená pri širokom susedovi dostanú lievik, aby sa úzka vetva
 * napojila do stredu širokej bez schodíka. Šípky jednosmerky kreslí `RoadMarkLayer` nad touto vrstvou a pod entitami.
 *
 * Bez textúr (`textures === null`, napr. testy bez DOM alebo chýbajúci sprite) padá na dočasné kreslenie z tokenov
 * (`--road-base`, `--road-marking`): každý tvar má jeden zdieľaný `GraphicsContext`, dlaždica je `Graphics` nad ním
 * (pozícia + `angle`), takže tisíc ciest = tisíc ľahkých objektov nad piatimi geometriami.
 *
 * **Napojenie na moduly** (F5b č. 3): bunka cesty pred konektorom modulu (brána, stojisko, rampa, dvor, kotvisko…) dostane
 * rameno k modulu (`connectorMask`, `module-connectors.ts`), takže cesta končí na okraji bunky modulu namiesto zaobleného
 * konca s medzerou. Maska sa číta pri každom prekreslení bunky; zmenu modulov oznamuje volajúci cez `updateRoads`.
 *
 * Vrstva je vlastná render group: posun kamery (transformácia rodiča) neprepočítava dlaždice a zmena ciest
 * prestavia len túto vrstvu, nie terén.
 *
 * Kreslí sa iba vrstva `road`; koľaje (`rail`) pribudnú s ich stavbou (tokeny `--rail-*`).
 */
import { Container, Graphics, GraphicsContext, Sprite } from 'pixi.js';
import { DIRECTIONS_4, ROAD_KIND_TRAITS, type CellCoord, type Grid, type Rect, type Rotation } from '@sim/grid';
import {
  AUTOTILE_SHAPE_BASE_MASK,
  autotileAffected,
  autotileTile,
  rotateMask,
  type AutotileShape,
  type AutotileTile,
} from './autotile';
import type { Point } from './camera';
import { MANIFEST_CELL_PX } from './entity-assets';
import { ROAD_ASPHALT_PX } from './lane';
import { noConnectorMask, type ConnectorMaskAt } from './module-connectors';
import { ROAD_EDGE_PX, narrowRoadPaths, type PathOp } from './narrow-road';
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

/** Štýl dlaždice: sprite / dočasné `Graphics` širokej cesty, alebo procedurálna úzka cesta s maskou lievikov. */
const WIDE_STYLE = 'wide';
const narrowStyle = (flareMask: number): string => `narrow:${String(flareMask)}`;

interface RoadTile {
  /** `Sprite` (textúra z atlasu) alebo `Graphics` (fallback, úzka cesta). */
  readonly display: Container;
  readonly shape: AutotileShape;
  readonly rotation: Rotation;
  /** `wide` alebo `narrow:<maska lievikov>`; zmena štýlu (iný typ cesty, iný sused) dlaždicu nahradí. */
  readonly style: string;
}

/** Preloží operácie cesty na kontext (`scale` = px kontextu na px zdroja). */
function applyPath(context: GraphicsContext, ops: readonly PathOp[], scale: number): void {
  for (const op of ops) {
    if (op.op === 'M') context.moveTo(op.x * scale, op.y * scale);
    else if (op.op === 'L') context.lineTo(op.x * scale, op.y * scale);
    else if (op.op === 'A') context.arc(op.cx * scale, op.cy * scale, op.r * scale, op.from, op.to, op.to < op.from);
    else context.closePath();
  }
}

export class RoadLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'roads', isRenderGroup: true });
  /** Dlaždice podľa row-major indexu bunky. */
  private readonly tiles = new Map<number, RoadTile>();
  /** Zdieľaná geometria podľa tvaru (vytvára sa lazy), širokej cesty bez spritov. */
  private readonly contexts = new Map<AutotileShape, GraphicsContext>();
  /** Zdieľaná geometria úzkych ciest podľa tvaru a masky lievikov (vytvára sa lazy). */
  private readonly narrowContexts = new Map<string, GraphicsContext>();

  /**
   * @param textures sprity ciest z `SpriteAtlas`; `null` = dočasné `Graphics` z tokenov
   * @param connectorMask ramená k konektorom modulov podľa bunky (`ConnectorArmIndex.maskAt`); predvolene žiadne
   */
  constructor(
    private readonly grid: Grid,
    private readonly palette: RenderPalette,
    private readonly textures: SpriteTextures | null = null,
    private readonly connectorMask: ConnectorMaskAt = noConnectorMask,
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

  /**
   * Štýl nakreslenej dlaždice na (x, y): `wide` (sprite / dočasné kreslenie širokej cesty) alebo `narrow:<maska>`
   * (procedurálna úzka cesta; maska = ramená s lievikom v základnej orientácii, N = 1, E = 2, S = 4, W = 8);
   * `undefined`, ak tam cesta nie je.
   */
  tileStyleAt(x: number, y: number): string | undefined {
    if (!this.grid.inBounds(x, y)) return undefined;
    return this.tiles.get(this.grid.index(x, y))?.style;
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
    for (const context of this.narrowContexts.values()) context.destroy();
    this.contexts.clear();
    this.narrowContexts.clear();
  }

  /** Zosúladí dlaždicu bunky s mriežkou; `true`, ak sa niečo zmenilo. */
  private refresh(x: number, y: number): boolean {
    const index = this.grid.index(x, y);
    const existing = this.tiles.get(index);
    const wanted = autotileTile(this.grid, x, y, LAYER, this.connectorMask(x, y));
    const style = wanted ? this.styleOf(x, y, wanted) : WIDE_STYLE;
    if (existing && wanted && existing.shape === wanted.shape && existing.rotation === wanted.rotation && existing.style === style) {
      return false;
    }
    if (!existing && !wanted) return false;
    if (existing) {
      existing.display.destroy(); // textúra ani zdieľaný context sa neničia (destroy bez volieb)
      this.tiles.delete(index);
    }
    if (wanted) this.tiles.set(index, this.createTile(x, y, wanted, style));
    return true;
  }

  /** Je cesta v bunke jednopruhová (procedurálna, bez spritu)? */
  private isNarrow(x: number, y: number): boolean {
    return ROAD_KIND_TRAITS[this.grid.at(x, y).roadKind].lanes === 1;
  }

  /**
   * Štýl dlaždice bunky (x, y): široká cesta `wide`; úzka `narrow:<maska>`, kde maska = ramená (základná orientácia),
   * ktorých sused je široká cesta — tam sa kreslí lievik.
   */
  private styleOf(x: number, y: number, { shape, rotation }: AutotileTile): string {
    if (!this.isNarrow(x, y)) return WIDE_STYLE;
    let wideNeighbours = 0; // maska vo svete
    for (const { dx, dy, bit } of DIRECTIONS_4) {
      const nx = x + dx;
      const ny = y + dy;
      if (this.grid.inBounds(nx, ny) && this.grid.at(nx, ny).road === LAYER && !this.isNarrow(nx, ny)) wideNeighbours |= bit;
    }
    // dlaždica je otočená o `rotation`; ramená základnej orientácie dostaneme otočením masky späť
    const base = rotateMask(wideNeighbours, ((360 - rotation) % 360) as Rotation) & AUTOTILE_SHAPE_BASE_MASK[shape];
    return narrowStyle(base);
  }

  private createTile(x: number, y: number, { shape, rotation }: AutotileTile, style: string): RoadTile {
    const { cellPx } = this.palette;
    let display: Container;
    if (style !== WIDE_STYLE) {
      const graphics = new Graphics(this.narrowContextFor(shape, Number(style.slice(style.indexOf(':') + 1))));
      graphics.pivot.set(cellPx / 2, cellPx / 2);
      display = graphics;
    } else if (this.textures !== null) {
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
    return { display, shape, rotation, style };
  }

  private clearTiles(): void {
    for (const tile of this.tiles.values()) tile.display.destroy();
    this.tiles.clear();
  }

  /**
   * Šírka širokého asfaltu na hrane bunky (polovica, px zdroja): sprite 52 px (x 6–58), dočasné kreslenie pás
   * `ROAD_BAND_CELLS` bunky — od nej závisí šírka lievika úzkej cesty.
   */
  private wideHalfPx(): number {
    return this.textures !== null ? ROAD_ASPHALT_PX / 2 : (ROAD_BAND_CELLS * MANIFEST_CELL_PX) / 2;
  }

  /** Úzka cesta: asfalt z `--road-base`, okraj odvodený z neho (`road.edge`), bez stredovej čiary; lievik podľa masky. */
  private narrowContextFor(shape: AutotileShape, flareMask: number): GraphicsContext {
    const key = `${shape}:${String(flareMask)}`;
    const cached = this.narrowContexts.get(key);
    if (cached) return cached;
    const { cellPx, road } = this.palette;
    const scale = cellPx / MANIFEST_CELL_PX;
    const { fills, strokes } = narrowRoadPaths(shape, flareMask, this.wideHalfPx());
    const context = new GraphicsContext();
    for (const ops of fills) {
      applyPath(context, ops, scale);
      context.fill({ color: road.base.color, alpha: road.base.alpha });
    }
    for (const ops of strokes) {
      applyPath(context, ops, scale);
      context.stroke({ width: ROAD_EDGE_PX * scale, color: road.edge.color, alpha: road.edge.alpha, cap: 'butt', join: 'miter' });
    }
    this.narrowContexts.set(key, context);
    return context;
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
