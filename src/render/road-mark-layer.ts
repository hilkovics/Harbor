/**
 * RoadMarkLayer (ARCHITECTURE §15.1, T03-19): cestné značky nad asfaltom — šípky smeru jednosmerky.
 *
 * Každá bunka `one_way` (`ROAD_KIND_TRAITS[kind].oneWay`) so smerom `Cell.roadDir` dostane `overlay.path_arrow`
 * (šípka na sever pri rotácii 0) otočený podľa smeru: N 0°, E 90°, S 180°, W 270°. Šípka je na KAŽDEJ bunke, sprite má
 * 20 px pri pruhu 26 px, takže pri zoome 0,5 je stále vidieť (10 px) a pri zoome 2 nezavadzia (40 px).
 *
 * V bunke so zákrutou (dvaja kolmí susedia) leží stred bunky mimo asfaltu (od vnútorného rohu je 45,25 px, asfalt siaha
 * do 45 px), preto sa šípka položí do stredu oblúka pruhu (`turnArcPose` pri `alpha` 0,5, polomer 32 px) a otočí o os
 * medzi vstupným a výstupným kurzom (45°, 135°, …) — presne ako vozidlo uprostred zákruty (`vehicle-view.ts`). Výstupný
 * kurz je `roadDir` (smer do ďalšej bunky, `dragDirections`, ADR-020). Tvar bunky závisí od susedov, preto
 * `updateCells` prekresľuje aj susedov zmenených buniek.
 *
 * Vrstva leží nad `RoadLayer` a POD `EntityLayer` (vozidlá a lode šípku nezakryjú). Šípka závisí len od vlastnej bunky,
 * takže `updateCells(RoadChanged.cells)` prekreslí iba zmenené bunky. Bez textúry (`null`) sa šípka nakreslí ako `Graphics`
 * z tokenu `--ui-accent`.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { ROAD_KIND_TRAITS, type CellCoord, type Direction4Name, type Grid } from '@sim/grid';
import { autotileAffected, autotileMask } from './autotile';
import type { Point } from './camera';
import { MANIFEST_CELL_PX } from './entity-assets';
import { PATH_ARROW_FOOTPRINT } from './overlay-assets';
import type { RenderPalette } from './tokens';
import { cornerTurn, turnArcPose } from './turn-arc';
import type { ViewRotation } from './view-models';

/** Rotácia šípky podľa smeru jednosmerky (sprite ukazuje na sever): N, E, S, W = 0°, 90°, 180°, 270° (poradie `DIRECTIONS_4`). */
export const ARROW_ROTATION: Readonly<Record<Direction4Name, ViewRotation>> = Object.freeze({
  N: 0,
  E: 90,
  S: 180,
  W: 270,
});

/** Vrchol a ramená šípky bez sprite (px zdroja vzhľadom na stred bunky; `overlay/path_arrow.svg`: `M22 38 L32 26 L42 38`). */
const FALLBACK_CHEVRON: readonly Point[] = [
  { x: -10, y: 6 },
  { x: 0, y: -6 },
  { x: 10, y: 6 },
];

/** Hrúbka čiary šípky bez sprite (px zdroja; svetlá čiara v spriteoch má 3,5 px). */
const FALLBACK_STROKE_PX = 4;

/** Poloha a uhol šípky: posun od stredu bunky v bunkách a uhol v stupňoch (0 = sever, v smere hodinových ručičiek). */
export interface ArrowPose {
  readonly dx: number;
  readonly dy: number;
  readonly angle: number;
}

/** Šípka pre bunku (x, y), alebo `null`, ak tam šípka nemá byť (nie je to jednosmerka so smerom). */
function wantedPose(grid: Grid, x: number, y: number): ArrowPose | null {
  const cell = grid.at(x, y);
  if (cell.road !== 'road' || !ROAD_KIND_TRAITS[cell.roadKind].oneWay || cell.roadDir === null) return null;
  const heading = ARROW_ROTATION[cell.roadDir];
  const turn = cornerTurn(autotileMask(grid, x, y, 'road'), heading);
  if (turn === null) return { dx: 0, dy: 0, angle: heading };
  const middle = turnArcPose(cell.roadKind, turn.from, turn.to, 0.5);
  return { dx: middle.x, dy: middle.y, angle: middle.angle };
}

const samePose = (a: ArrowPose, b: ArrowPose): boolean => a.dx === b.dx && a.dy === b.dy && a.angle === b.angle;

interface Arrow {
  readonly display: Container;
  readonly pose: ArrowPose;
}

export class RoadMarkLayer {
  /** Kontajner vrstvy; pridaj ho do sveta hneď nad `RoadLayer` (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'road-marks' });
  private readonly arrows = new Map<number, Arrow>();

  /**
   * @param texture `overlay.path_arrow` z atlasu; `null` = šípka z `Graphics`
   */
  constructor(
    private readonly grid: Grid,
    private readonly palette: RenderPalette,
    private readonly texture: Texture | null = null,
  ) {
    this.view.eventMode = 'none';
    this.rebuild();
  }

  /** Počet nakreslených šípok. */
  get arrowCount(): number {
    return this.arrows.size;
  }

  /** Uhol šípky na (x, y) v stupňoch, alebo `undefined`, ak tam šípka nie je. */
  arrowAt(x: number, y: number): number | undefined {
    return this.arrowPoseAt(x, y)?.angle;
  }

  /** Poloha (posun od stredu bunky v bunkách) a uhol šípky na (x, y), alebo `undefined`, ak tam šípka nie je. */
  arrowPoseAt(x: number, y: number): ArrowPose | undefined {
    if (!this.grid.inBounds(x, y)) return undefined;
    return this.arrows.get(this.grid.index(x, y))?.pose;
  }

  /** Znova nakreslí šípky všetkých jednosmeriek (úvodný stav alebo po načítaní hry). */
  rebuild(): void {
    for (const arrow of this.arrows.values()) arrow.display.destroy();
    this.arrows.clear();
    for (let y = 0; y < this.grid.height; y++) {
      for (let x = 0; x < this.grid.width; x++) this.refresh(x, y);
    }
  }

  /**
   * Prekreslí šípky zmenených buniek (`RoadChanged.cells`) a ich susedov — zákruta sa pozná podľa susedov.
   * @returns počet šípok, ktoré vznikli, zmizli, sa otočili alebo posunuli
   */
  updateCells(cells: readonly CellCoord[]): number {
    let changed = 0;
    for (const { x, y } of autotileAffected(this.grid, cells)) {
      if (this.refresh(x, y)) changed += 1;
    }
    return changed;
  }

  destroy(): void {
    this.arrows.clear();
    this.view.destroy({ children: true });
  }

  /** Zosúladí šípku bunky s mriežkou; `true`, ak sa niečo zmenilo. */
  private refresh(x: number, y: number): boolean {
    const index = this.grid.index(x, y);
    const existing = this.arrows.get(index);
    const wanted = wantedPose(this.grid, x, y);
    if (existing && wanted && samePose(existing.pose, wanted)) return false;
    if (existing) {
      existing.display.destroy(); // zdieľaná textúra sa neničí (destroy bez volieb)
      this.arrows.delete(index);
    }
    if (wanted === null) return existing !== undefined;
    const { cellPx } = this.palette;
    const display = this.texture !== null ? this.sprite(this.texture) : this.fallback();
    display.position.set((x + 0.5 + wanted.dx) * cellPx, (y + 0.5 + wanted.dy) * cellPx);
    display.angle = wanted.angle;
    this.view.addChild(display);
    this.arrows.set(index, { display, pose: wanted });
    return true;
  }

  private sprite(texture: Texture): Sprite {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.setSize(PATH_ARROW_FOOTPRINT.w * this.palette.cellPx, PATH_ARROW_FOOTPRINT.h * this.palette.cellPx);
    return sprite;
  }

  /** Šípka nahor vycentrovaná na počiatok (`Graphics`), farba z tokenu. */
  private fallback(): Graphics {
    const { cellPx, road } = this.palette;
    const scale = cellPx / MANIFEST_CELL_PX;
    const graphics = new Graphics();
    FALLBACK_CHEVRON.forEach((point, i) => {
      if (i === 0) graphics.moveTo(point.x * scale, point.y * scale);
      else graphics.lineTo(point.x * scale, point.y * scale);
    });
    graphics.stroke({ width: FALLBACK_STROKE_PX * scale, color: road.arrow.color, alpha: road.arrow.alpha, cap: 'round', join: 'round' });
    return graphics;
  }
}
