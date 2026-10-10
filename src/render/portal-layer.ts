/**
 * PortalLayer (DESIGN_BRIEF §5.1): značka portálu na okraji mapy — cestný (`portal_road`) a železničný (`portal_rail`).
 *
 * Sprite je rotovateľný (manifest: `rotatable`, „šípka von z mapy pri rot 0 = sever“), takže sa otáča podľa okraja,
 * na ktorom portál leží: sever 0°, východ 90°, juh 180°, západ 270°. Kreslí sa NAD cestami — cesta končí v bunke
 * portálu a značka ju zakrýva, aby bolo vidieť, kadiaľ kamióny/vlaky vchádzajú a odchádzajú.
 *
 * Bez textúr (`textures === null`, napr. testy bez DOM) padá na jednoduchý `Graphics` z tokenov (zaoblený štvorec
 * `--road-base` so šípkou `--road-marking`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import type { CellCoord, MapPortal, Rotation } from '@sim/grid';
import type { SpriteTextures } from './sprite-atlas';
import type { RenderPalette } from './tokens';

/** Druh portálu = sprite `portal_<druh>` v manifeste. */
export type PortalKind = 'road' | 'rail';

/** Stred bunky v jednotkách buniek. */
const MID = 0.5;

/** Odsadenie značky od okraja bunky vo fallbacku (zlomok bunky). */
const FALLBACK_INSET_CELLS = 9 / 64;

/** Polomer zaoblenia značky vo fallbacku (zlomok bunky). */
const FALLBACK_RADIUS_CELLS = 8 / 64;

/** Hrúbka šípky vo fallbacku (zlomok bunky). */
const FALLBACK_ARROW_CELLS = 3 / 64;

/**
 * Rotácia značky portálu v bunke `cell` mapy `width × height`: šípka smeruje von z mapy.
 * Okraje sa skúšajú v poradí sever, východ, juh, západ (portál v rohu dostane prvý zodpovedajúci);
 * bunka mimo okraja je `RangeError` (loader mapy portál mimo okraja odmietne).
 */
export function portalRotation(cell: CellCoord, width: number, height: number): Rotation {
  if (cell.y === 0) return 0;
  if (cell.x === width - 1) return 90;
  if (cell.y === height - 1) return 180;
  if (cell.x === 0) return 270;
  throw new RangeError(`portalRotation: bunka (${String(cell.x)}, ${String(cell.y)}) nie je na okraji mapy ${String(width)}×${String(height)}`);
}

export interface PortalSet {
  readonly roadPortals: readonly MapPortal[];
  readonly railPortals: readonly MapPortal[];
}

interface PortalView {
  readonly id: string;
  readonly kind: PortalKind;
  readonly rotation: Rotation;
  readonly display: Container;
}

export class PortalLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'portals', isRenderGroup: true });
  private readonly portals: PortalView[] = [];

  /**
   * @param portals portály mapy (`LoadedMap.roadPortals`, `railPortals`)
   * @param mapWidth šírka mapy v bunkách
   * @param mapHeight výška mapy v bunkách
   * @param textures sprity portálov z `SpriteAtlas`; `null` = `Graphics` fallback
   */
  constructor(
    portals: PortalSet,
    mapWidth: number,
    mapHeight: number,
    private readonly palette: RenderPalette,
    private readonly textures: SpriteTextures | null = null,
  ) {
    for (const [kind, list] of [
      ['road', portals.roadPortals],
      ['rail', portals.railPortals],
    ] as const) {
      for (const portal of list) this.add(kind, portal, portalRotation(portal.cell, mapWidth, mapHeight));
    }
  }

  /** Počet nakreslených portálov. */
  get portalCount(): number {
    return this.portals.length;
  }

  /** Druh a rotácia značky portálu `id`, alebo `undefined`, ak taký portál nie je. */
  portalOf(id: string): { readonly kind: PortalKind; readonly rotation: Rotation } | undefined {
    const found = this.portals.find((portal) => portal.id === id);
    return found === undefined ? undefined : { kind: found.kind, rotation: found.rotation };
  }

  destroy(): void {
    this.portals.length = 0;
    this.view.destroy({ children: true });
  }

  private add(kind: PortalKind, portal: MapPortal, rotation: Rotation): void {
    const { cellPx } = this.palette;
    const display = this.textures !== null ? this.sprite(this.textures, kind) : this.fallback();
    display.position.set((portal.cell.x + MID) * cellPx, (portal.cell.y + MID) * cellPx);
    display.angle = rotation;
    this.view.addChild(display);
    this.portals.push({ id: portal.id, kind, rotation, display });
  }

  private sprite(textures: SpriteTextures, kind: PortalKind): Sprite {
    const sprite = new Sprite(textures.terrain(kind === 'road' ? 'portal_road' : 'portal_rail'));
    sprite.anchor.set(MID);
    sprite.setSize(this.palette.cellPx, this.palette.cellPx);
    return sprite;
  }

  /** Zaoblený štvorec so šípkou na sever (pri rot 0), vycentrovaný na pivot (0, 0). */
  private fallback(): Graphics {
    const { cellPx, road } = this.palette;
    const inset = FALLBACK_INSET_CELLS * cellPx;
    const half = cellPx / 2 - inset;
    const graphics = new Graphics();
    graphics.roundRect(-half, -half, half * 2, half * 2, FALLBACK_RADIUS_CELLS * cellPx).fill(road.base);
    graphics
      .moveTo(-half / 2, -half / 4)
      .lineTo(0, -half / 2 - half / 4)
      .lineTo(half / 2, -half / 4)
      .stroke({ width: FALLBACK_ARROW_CELLS * cellPx, color: road.marking.color, alpha: road.marking.alpha, cap: 'round', join: 'round' });
    return graphics;
  }
}
