/**
 * BuildLayer (ARCHITECTURE §15.1): ghost stavby nad svetom — bunky ťahu vyfarbené podľa validácie príkazu.
 *
 * - platná bunka: `--ghost-valid` (zelená, polopriehľadná),
 * - neplatná bunka: `--ghost-invalid` (červená) + šrafa `ghost_hatch` (vzor z `assets/manifest.json`, 12×12 px)
 *   ako `TilingSprite` — stavový signál teda nie je len farba (DESIGN_BRIEF §6.4).
 *
 * Vrstva iba kreslí; o tom, ktoré bunky sú platné, rozhoduje volajúci (`InputController` cez `Command.validate`).
 * Žiadny text — popisy a ceny patria do React/DOM (CLAUDE.md, ARCHITECTURE §15.1).
 * Patrí do kontajnera sveta (`WorldRenderer.world`), takže súradnice sú v px pri zoome 1 (`x × cellPx`).
 */
import { Assets, Container, Graphics, Texture, TilingSprite } from 'pixi.js';
import type { CellCoord } from '@sim/grid';
import { GHOST_HATCH_PATTERN, overlayAssetUrl } from './overlay-assets';
import { documentTokenResolver, readColorToken, readLengthToken, type ColorValue, type TokenResolver } from './tokens';

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
}

/** Načíta farby ghostu z tokenov `--ghost-valid` / `--ghost-invalid`; chýbajúci token → chyba. */
export function loadGhostPalette(resolve: TokenResolver = documentTokenResolver): GhostPalette {
  return {
    valid: readColorToken('--ghost-valid', resolve),
    invalid: readColorToken('--ghost-invalid', resolve),
  };
}

/** Hustota, v akej sa SVG šrafa rasterizuje: čitateľná aj pri zoome 2 (bunka 64 px → 128 px na obrazovke). */
const HATCH_RASTER_RESOLUTION = 4;

export interface BuildLayerOptions {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: GhostPalette;
  /** Textúra vzoru šrafy (12×12 px); `null` = neplatné bunky bez šrafy (len testy bez assetov). */
  readonly hatch: Texture | null;
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
  private readonly fills = new Graphics({ label: 'ghost-fills' });
  private readonly hatchLayer = new Container({ label: 'ghost-hatch' });
  private readonly hatchPool: TilingSprite[] = [];
  private cellsShown = 0;
  private destroyed = false;

  constructor(options: BuildLayerOptions) {
    this.cellPx = options.cellPx;
    this.palette = options.palette;
    this.hatch = options.hatch;
    this.view.addChild(this.fills, this.hatchLayer);
    this.view.eventMode = 'none';
  }

  /**
   * Vytvorí vrstvu: farby z tokenov (`--ghost-*`, `--cell`) a šrafu `ghost_hatch` podľa `assets/manifest.json`.
   * Asynchrónne kvôli načítaniu textúry.
   */
  static async create(options: BuildLayerCreateOptions = {}): Promise<BuildLayer> {
    const resolve = options.resolveToken ?? documentTokenResolver;
    const hatch = await Assets.load<Texture>({
      src: overlayAssetUrl('ghost_hatch'),
      data: { resolution: HATCH_RASTER_RESOLUTION },
    });
    return new BuildLayer({ cellPx: readLengthToken('--cell', resolve), palette: loadGhostPalette(resolve), hatch });
  }

  /** Počet buniek, ktoré ghost práve zobrazuje. */
  get shownCount(): number {
    return this.cellsShown;
  }

  /** Nahradí ghost novými bunkami (prázdne pole = skryť). Neplatné bunky dostanú aj šrafu. */
  setGhost(cells: readonly GhostCell[]): void {
    if (this.destroyed) return;
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
