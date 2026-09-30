/**
 * BuildLayer (ARCHITECTURE §15.1): ghost stavby nad svetom — bunky ťahu vyfarbené podľa validácie príkazu.
 *
 * - platná bunka: `--ghost-valid` (zelená, polopriehľadná),
 * - neplatná bunka: `--ghost-invalid` (červená) + šrafa `ghost_hatch` (vzor z `assets/manifest.json`, 12×12 px)
 *   ako `TilingSprite` — stavový signál teda nie je len farba (DESIGN_BRIEF §6.4).
 *
 * Ghost modulu (`setModuleGhost`) je footprint modulu tým istým spôsobom a navyše `overlay.connector_marker`
 * na každom konektore, otočený podľa strany vjazdu (šípka smeruje do modulu).
 *
 * Vrstva iba kreslí; o tom, ktoré bunky sú platné, rozhoduje volajúci (`InputController` cez `Command.validate`).
 * Žiadny text — popisy a ceny patria do React/DOM (CLAUDE.md, ARCHITECTURE §15.1).
 * Patrí do kontajnera sveta (`WorldRenderer.world`), takže súradnice sú v px pri zoome 1 (`x × cellPx`).
 */
import { Assets, Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { CellCoord } from '@sim/grid';
import { GHOST_HATCH_PATTERN, overlayAssetUrl } from './overlay-assets';
import { documentTokenResolver, readColorToken, readLengthToken, type ColorValue, type TokenResolver } from './tokens';
import type { ModuleGhostVM, ViewRotation, ViewSide } from './view-models';

/** Bunka ghostu a jej výsledok validácie. */
export interface GhostCell extends CellCoord {
  /** `true` = príkaz by bunku prijal (zelená), `false` = odmietol by ju (červená + šrafa). */
  readonly valid: boolean;
}

/** Cieľ, do ktorého `InputController` posiela ghost; `BuildLayer` ho spĺňa. */
export interface GhostView {
  setGhost(cells: readonly GhostCell[]): void;
  clearGhost(): void;
}

/** Farby ghostu z tokenov (DESIGN_BRIEF §3 „Stavy na mape“). */
export interface GhostPalette {
  readonly valid: ColorValue;
  readonly invalid: ColorValue;
  /** Značka konektora bez sprite (`--module-connector`). */
  readonly connector: ColorValue;
}

/**
 * Rotácia `overlay.connector_marker` podľa strany vjazdu konektora: sprite má šípku na sever (rot 0), t. j. do modulu
 * cez JUŽNÚ hranu; konektor na strane `n` teda dostane 180°, `e` 270°, `w` 90°.
 */
export const CONNECTOR_MARKER_ROTATION: Readonly<Record<ViewSide, ViewRotation>> = { s: 0, w: 90, n: 180, e: 270 };

/** Bunky ghostu modulu: každá bunka footprintu `w × h` od ľavého horného rohu, všetky s platnosťou ghostu. */
export function moduleGhostCells(ghost: ModuleGhostVM): GhostCell[] {
  const cells: GhostCell[] = [];
  for (let dy = 0; dy < ghost.h; dy += 1) {
    for (let dx = 0; dx < ghost.w; dx += 1) cells.push({ x: ghost.x + dx, y: ghost.y + dy, valid: ghost.valid });
  }
  return cells;
}

/** Načíta farby ghostu z tokenov `--ghost-valid` / `--ghost-invalid`; chýbajúci token → chyba. */
export function loadGhostPalette(resolve: TokenResolver = documentTokenResolver): GhostPalette {
  return {
    valid: readColorToken('--ghost-valid', resolve),
    invalid: readColorToken('--ghost-invalid', resolve),
    connector: readColorToken('--module-connector', resolve),
  };
}

/** Hustota, v akej sa SVG šrafa rasterizuje: čitateľná aj pri zoome 2 (bunka 64 px → 128 px na obrazovke). */
const HATCH_RASTER_RESOLUTION = 4;

/** Hustota rasterizácie značky konektora (1 bunka = 64 px zdroja → ostrá aj pri zoome 2). */
const MARKER_RASTER_RESOLUTION = 2;

/** Veľkosť fallbacku značky konektora (trojuholník) ako zlomok bunky. */
const MARKER_FALLBACK_CELLS = 0.5;

export interface BuildLayerOptions {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: GhostPalette;
  /** Textúra vzoru šrafy (12×12 px); `null` = neplatné bunky bez šrafy (len testy bez assetov). */
  readonly hatch: Texture | null;
  /** Textúra `overlay.connector_marker`; `null`/vynechaná = značka konektora sa nakreslí z `Graphics`. */
  readonly connectorMarker?: Texture | null;
}

export interface BuildLayerCreateOptions {
  readonly resolveToken?: TokenResolver;
}

export class BuildLayer implements GhostView {
  /** Koreň vrstvy; pridaj ho do `WorldRenderer.world`. */
  readonly view = new Container({ label: 'build-layer' });

  private readonly cellPx: number;
  private readonly palette: GhostPalette;
  private readonly hatch: Texture | null;
  private readonly connectorMarker: Texture | null;
  private readonly fills = new Graphics({ label: 'ghost-fills' });
  private readonly hatchLayer = new Container({ label: 'ghost-hatch' });
  private readonly markerLayer = new Container({ label: 'ghost-connectors' });
  private readonly hatchPool: TilingSprite[] = [];
  private readonly markerPool: Container[] = [];
  private cellsShown = 0;
  private destroyed = false;

  constructor(options: BuildLayerOptions) {
    this.cellPx = options.cellPx;
    this.palette = options.palette;
    this.hatch = options.hatch;
    this.connectorMarker = options.connectorMarker ?? null;
    this.view.addChild(this.fills, this.hatchLayer, this.markerLayer);
    this.view.eventMode = 'none';
  }

  /**
   * Vytvorí vrstvu: farby z tokenov (`--ghost-*`, `--module-connector`, `--cell`) a overlaye `ghost_hatch`
   * a `connector_marker` podľa `assets/manifest.json`. Asynchrónne kvôli načítaniu textúr.
   */
  static async create(options: BuildLayerCreateOptions = {}): Promise<BuildLayer> {
    const resolve = options.resolveToken ?? documentTokenResolver;
    const [hatch, connectorMarker] = await Promise.all([
      Assets.load<Texture>({ src: overlayAssetUrl('ghost_hatch'), data: { resolution: HATCH_RASTER_RESOLUTION } }),
      Assets.load<Texture>({ src: overlayAssetUrl('connector_marker'), data: { resolution: MARKER_RASTER_RESOLUTION } }),
    ]);
    return new BuildLayer({
      cellPx: readLengthToken('--cell', resolve),
      palette: loadGhostPalette(resolve),
      hatch,
      connectorMarker,
    });
  }

  /** Počet buniek, ktoré ghost práve zobrazuje. */
  get shownCount(): number {
    return this.cellsShown;
  }

  /** Nahradí ghost novými bunkami (prázdne pole = skryť). Neplatné bunky dostanú aj šrafu; značky konektorov zmiznú. */
  setGhost(cells: readonly GhostCell[]): void {
    if (this.destroyed) return;
    this.paint(cells);
    this.showMarkers([]);
  }

  /**
   * Ghost modulu: footprint (zelený / červený so šrafou) a `connector_marker` na každom konektore. `null` = skryť.
   * Konektory sú vo svetových bunkách po rotácii; `side` je strana vjazdu (po rotácii).
   */
  setModuleGhost(ghost: ModuleGhostVM | null): void {
    if (this.destroyed) return;
    if (ghost === null) {
      this.clearGhost();
      return;
    }
    this.paint(moduleGhostCells(ghost));
    this.showMarkers(ghost.connectors);
  }

  /** Počet zobrazených značiek konektorov. */
  get markerCount(): number {
    let shown = 0;
    for (const marker of this.markerPool) if (marker.visible) shown += 1;
    return shown;
  }

  /** Vykreslí výplň a šrafy pre `cells`. */
  private paint(cells: readonly GhostCell[]): void {
    const { cellPx } = this;
    this.fills.clear();
    for (const [validity, color] of [
      [true, this.palette.valid],
      [false, this.palette.invalid],
    ] as const) {
      let any = false;
      for (const cell of cells) {
        if (cell.valid !== validity) continue;
        this.fills.rect(cell.x * cellPx, cell.y * cellPx, cellPx, cellPx);
        any = true;
      }
      if (any) this.fills.fill({ color: color.color, alpha: color.alpha });
    }

    let used = 0;
    const { hatch } = this;
    if (hatch !== null) {
      for (const cell of cells) {
        if (cell.valid) continue;
        const sprite = this.hatchSprite(used, hatch);
        // Vzor je ukotvený k svetu (nie k bunke), takže šrafa plynulo prechádza cez susedné neplatné bunky.
        sprite.position.set(cell.x * cellPx, cell.y * cellPx);
        sprite.tilePosition.set(-cell.x * cellPx, -cell.y * cellPx);
        sprite.visible = true;
        used += 1;
      }
    }
    for (let i = used; i < this.hatchPool.length; i++) this.hatchPool[i].visible = false;
    this.cellsShown = cells.length;
  }

  clearGhost(): void {
    this.setGhost([]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.view.destroy({ children: true });
  }

  /** Zobrazí značky na konektoroch (pool sa rozširuje podľa potreby); nadbytočné skryje. */
  private showMarkers(connectors: readonly { readonly x: number; readonly y: number; readonly side: ViewSide }[]): void {
    const { cellPx } = this;
    connectors.forEach((connector, index) => {
      const marker = this.markerAt(index);
      marker.position.set((connector.x + 0.5) * cellPx, (connector.y + 0.5) * cellPx);
      marker.angle = CONNECTOR_MARKER_ROTATION[connector.side];
      marker.visible = true;
    });
    for (let i = connectors.length; i < this.markerPool.length; i++) this.markerPool[i].visible = false;
  }

  /** Značka konektora `index`-tá z poolu: `Sprite` `connector_marker` (vycentrovaný na bunku) alebo trojuholník. */
  private markerAt(index: number): Container {
    let marker: Container | undefined = this.markerPool[index];
    if (marker === undefined) {
      marker = this.connectorMarker !== null ? this.markerSprite(this.connectorMarker) : this.markerFallback();
      this.markerPool.push(marker);
      this.markerLayer.addChild(marker);
    }
    return marker;
  }

  private markerSprite(texture: Texture): Sprite {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.setSize(this.cellPx, this.cellPx);
    return sprite;
  }

  /** Šípka nahor (do modulu pri rot 0) z `--module-connector`, vycentrovaná na počiatok. */
  private markerFallback(): Graphics {
    const half = (MARKER_FALLBACK_CELLS * this.cellPx) / 2;
    const { connector } = this.palette;
    return new Graphics().poly([0, -half, half, half, -half, half]).fill({ color: connector.color, alpha: connector.alpha });
  }

  /** Šrafa pre `index`-tú neplatnú bunku; pool sa rozširuje podľa potreby a nikdy nezmenšuje. */
  private hatchSprite(index: number, texture: Texture): TilingSprite {
    let sprite: TilingSprite | undefined = this.hatchPool[index];
    if (sprite === undefined) {
      sprite = new TilingSprite({ texture, width: this.cellPx, height: this.cellPx });
      // Vzor sa opakuje v pôvodnej veľkosti z manifestu (12×12), nezávisle od rasterizačnej hustoty textúry.
      sprite.tileScale.set(GHOST_HATCH_PATTERN.w / texture.width);
      this.hatchPool.push(sprite);
      this.hatchLayer.addChild(sprite);
    }
    return sprite;
  }
}
