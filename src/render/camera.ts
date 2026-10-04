/**
 * Kamera sveta (ARCHITECTURE §15.1): pan, zoom s pivotom pod kurzorom, clamp na mapu, prevody obrazovka ↔ bunka.
 *
 * Čistá matematika bez Pixi/DOM — testovateľná v Node. `WorldRenderer` z nej iba prenáša `transform()` na kontajner
 * sveta; `InputController` (T01-11) volá `pan`, `zoomAt`, `screenToCell`, `cellToScreen`.
 *
 * Súradnicové sústavy:
 * - obrazovka: CSS px v canvase, (0, 0) = ľavý horný roh, rozmery `viewportWidth × viewportHeight`;
 * - svet: px pri zoome 1, `1 bunka = cellPx` (token `--cell`), (0, 0) = ľavý horný roh bunky (0, 0);
 * - bunka: súradnice gridu; celé čísla = ľavý horný roh bunky, zlomky = poloha vnútri bunky.
 * Prevod: `obrazovka = (svet − (left, top)) × zoom`.
 */
import type { CellCoord, Rect } from '@sim/grid';

/** Rozsah zoomu (ARCHITECTURE §15.1): 0,25–2,0 násobok veľkosti bunky. */
export const CAMERA_MIN_ZOOM = 0.25;
export const CAMERA_MAX_ZOOM = 2;
/** Úvodný zoom pri štarte hry (docs/tasks/phase-01.md, T01-08). */
export const CAMERA_START_ZOOM = 0.5;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CameraOptions {
  /** Veľkosť bunky v px pri zoome 1 (token `--cell`). */
  readonly cellPx: number;
  /** Rozmery mapy v bunkách (`Grid.width/height`). */
  readonly mapWidth: number;
  readonly mapHeight: number;
  /** Rozmery zobrazovacej plochy v CSS px. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Úvodný zoom; predvolene `CAMERA_START_ZOOM`. */
  readonly zoom?: number;
  /** Obdĺžnik buniek (napr. starter parcela), ktorého stred je na začiatku v strede obrazovky; predvolene stred mapy. */
  readonly focus?: Rect;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

/** Transformácia kontajnera sveta: `position = (x, y)`, `scale = scale`. */
export interface CameraTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Camera: ${name} musí byť kladné číslo, dostal ${String(value)}`);
  }
}

export class Camera {
  private readonly cellPx: number;
  private readonly mapPxWidth: number;
  private readonly mapPxHeight: number;
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private viewportW: number;
  private viewportH: number;
  private zoomValue: number;
  private leftValue = 0;
  private topValue = 0;
  private versionValue = 0;

  constructor(options: CameraOptions) {
    assertPositive('cellPx', options.cellPx);
    assertPositive('mapWidth', options.mapWidth);
    assertPositive('mapHeight', options.mapHeight);
    assertPositive('viewportWidth', options.viewportWidth);
    assertPositive('viewportHeight', options.viewportHeight);
    this.minZoom = options.minZoom ?? CAMERA_MIN_ZOOM;
    this.maxZoom = options.maxZoom ?? CAMERA_MAX_ZOOM;
    assertPositive('minZoom', this.minZoom);
    assertPositive('maxZoom', this.maxZoom);
    if (this.minZoom > this.maxZoom) {
      throw new RangeError(`Camera: minZoom (${String(this.minZoom)}) je väčší než maxZoom (${String(this.maxZoom)})`);
    }
    this.cellPx = options.cellPx;
    this.mapPxWidth = options.mapWidth * options.cellPx;
    this.mapPxHeight = options.mapHeight * options.cellPx;
    this.viewportW = options.viewportWidth;
    this.viewportH = options.viewportHeight;
    this.zoomValue = this.clampZoom(options.zoom ?? CAMERA_START_ZOOM);
    const focus = options.focus ?? { x: 0, y: 0, w: options.mapWidth, h: options.mapHeight };
    this.centerOn(focus.x + focus.w / 2, focus.y + focus.h / 2);
  }

  /** Aktuálny zoom (1 = `cellPx` px na bunku). */
  get zoom(): number {
    return this.zoomValue;
  }

  /** Poloha ľavého horného rohu obrazovky vo svete (px pri zoome 1). */
  get left(): number {
    return this.leftValue;
  }

  get top(): number {
    return this.topValue;
  }

  get viewportWidth(): number {
    return this.viewportW;
  }

  get viewportHeight(): number {
    return this.viewportH;
  }

  /** Počítadlo zmien pohľadu — renderer prenáša transformáciu, len keď sa zmenilo. */
  get version(): number {
    return this.versionValue;
  }

  /** Transformácia kontajnera sveta v Pixi: `container.position.set(x, y); container.scale.set(scale)`. */
  transform(): CameraTransform {
    return { x: -this.leftValue * this.zoomValue, y: -this.topValue * this.zoomValue, scale: this.zoomValue };
  }

  // ---- ovládanie ----

  /** Posunie obsah o `dx`, `dy` obrazovkových px (ťah myšou: obsah ide s kurzorom). Pri WASD pošli opačné znamienko. */
  pan(dx: number, dy: number): void {
    this.apply(this.zoomValue, this.leftValue - dx / this.zoomValue, this.topValue - dy / this.zoomValue);
  }

  /**
   * Vynásobí zoom `factor` (výsledok sa orezá na rozsah) a drží bod pod obrazovkovými súradnicami (sx, sy) na mieste.
   * Clamp na mapu môže pivot posunúť, ak by pohľad inak vyšiel za okraj mapy.
   */
  zoomAt(factor: number, sx: number, sy: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new RangeError(`Camera.zoomAt: faktor musí byť kladné číslo, dostal ${String(factor)}`);
    }
    const zoom = this.clampZoom(this.zoomValue * factor);
    if (zoom === this.zoomValue) return;
    const worldX = this.leftValue + sx / this.zoomValue;
    const worldY = this.topValue + sy / this.zoomValue;
    this.apply(zoom, worldX - sx / zoom, worldY - sy / zoom);
  }

  /** Dá bod (x, y) v súradniciach buniek (zlomky povolené) do stredu obrazovky; zoom ostáva. */
  centerOn(cellX: number, cellY: number): void {
    const worldX = cellX * this.cellPx;
    const worldY = cellY * this.cellPx;
    this.apply(this.zoomValue, worldX - this.viewportW / this.zoomValue / 2, worldY - this.viewportH / this.zoomValue / 2);
  }

  /** Zmena veľkosti obrazovky; stred pohľadu ostáva na tom istom mieste sveta. */
  resize(viewportWidth: number, viewportHeight: number): void {
    assertPositive('viewportWidth', viewportWidth);
    assertPositive('viewportHeight', viewportHeight);
    if (viewportWidth === this.viewportW && viewportHeight === this.viewportH) return;
    const centerX = this.leftValue + this.viewportW / this.zoomValue / 2;
    const centerY = this.topValue + this.viewportH / this.zoomValue / 2;
    this.viewportW = viewportWidth;
    this.viewportH = viewportHeight;
    this.apply(this.zoomValue, centerX - viewportWidth / this.zoomValue / 2, centerY - viewportHeight / this.zoomValue / 2, true);
  }

  // ---- prevody súradníc ----

  /** Obrazovka → svet (px pri zoome 1). */
  screenToWorld(sx: number, sy: number): Point {
    return { x: this.leftValue + sx / this.zoomValue, y: this.topValue + sy / this.zoomValue };
  }

  /** Svet (px pri zoome 1) → obrazovka. */
  worldToScreen(wx: number, wy: number): Point {
    return { x: (wx - this.leftValue) * this.zoomValue, y: (wy - this.topValue) * this.zoomValue };
  }

  /** Obrazovka → bunka gridu so zlomkovou časťou (poloha vnútri bunky). */
  screenToCellFloat(sx: number, sy: number): Point {
    const world = this.screenToWorld(sx, sy);
    return { x: world.x / this.cellPx, y: world.y / this.cellPx };
  }

  /** Obrazovka → celočíselná bunka pod kurzorom (floor); môže ležať mimo mapy — volajúci pýta `Grid.inBounds`. */
  screenToCell(sx: number, sy: number): CellCoord {
    const cell = this.screenToCellFloat(sx, sy);
    return { x: Math.floor(cell.x) + 0, y: Math.floor(cell.y) + 0 };
  }

  /** Bunka (zlomky povolené) → obrazovka; pre celé čísla ľavý horný roh bunky. */
  cellToScreen(cellX: number, cellY: number): Point {
    return this.worldToScreen(cellX * this.cellPx, cellY * this.cellPx);
  }

  /** Stred bunky (x, y) na obrazovke — kam klikať v e2e testoch. */
  cellCenterToScreen(cellX: number, cellY: number): Point {
    return this.cellToScreen(cellX + 0.5, cellY + 0.5);
  }

  // ---- interné ----

  private clampZoom(zoom: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }

  /**
   * Os sa zmestí do mapy → mapa je na osi vycentrovaná; inak sa ľavý/horný okraj obmedzí tak, aby pohľad
   * nevyšiel za okraj mapy.
   */
  private clampAxis(position: number, visiblePx: number, mapPx: number): number {
    if (visiblePx >= mapPx) return (mapPx - visiblePx) / 2;
    return Math.min(Math.max(position, 0), mapPx - visiblePx);
  }

  private apply(zoom: number, left: number, top: number, force = false): void {
    const clampedLeft = this.clampAxis(left, this.viewportW / zoom, this.mapPxWidth);
    const clampedTop = this.clampAxis(top, this.viewportH / zoom, this.mapPxHeight);
    if (!force && zoom === this.zoomValue && clampedLeft === this.leftValue && clampedTop === this.topValue) return;
    this.zoomValue = zoom;
    this.leftValue = clampedLeft;
    this.topValue = clampedTop;
    this.versionValue += 1;
  }
}
