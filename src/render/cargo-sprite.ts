/**
 * CargoSprite (DESIGN_BRIEF §5.7): jedna jednotka nákladu na aprone alebo v žeriave.
 *
 * Sprite je `cargo.<typeId>` z manifestu (kontajner `container_teu`, dlhšia strana pozdĺž x pri rot 0) zobrazený v jednotnej
 * veľkosti `cargoDisplaySize` (TEU 64×26 px; sprite je nakreslený 64×32 a zmenší sa na šírku 26 px), vycentrovaný na počiatok kontajnera; rodič ho kladie na stred slotu / trolley. Bez textúry (alebo bez záznamu
 * v manifeste) je to obdĺžnik z tokenov `--cargo-container` s tmavým obrysom v rovnakej veľkosti.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { MANIFEST_CELL_PX, cargoDisplaySize, cargoSpriteEntry, manifestScale, type CellSize } from './entity-assets';
import { TEU_PX } from './world-scale';
import type { EntityTextures } from './sprite-atlas';
import type { EntityPalette } from './tokens';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Rozmer fallbacku pri neznámom type nákladu: kontajner TEU 64 × 26 px (`world-scale.ts`), v bunkách. */
const FALLBACK_SIZE: CellSize = { w: TEU_PX.w / MANIFEST_CELL_PX, h: TEU_PX.h / MANIFEST_CELL_PX };

/** Čo `CargoSprite` potrebuje od rendereru. */
export interface CargoSpriteDeps {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: EntityPalette;
  /** Textúry entít; `null` = vždy fallback `Graphics`. */
  readonly textures: EntityTextures | null;
}

/** Rozmer sprite nákladu `typeId` v px sveta (`cargoDisplaySize`: kontajner TEU 64 × 26; neznámy typ → kontajner TEU). */
export function cargoSizePx(typeId: string, cellPx: number): CellSize {
  const size = cargoDisplaySize(typeId);
  if (size === undefined) return { w: FALLBACK_SIZE.w * cellPx, h: FALLBACK_SIZE.h * cellPx };
  const scale = manifestScale(cellPx);
  return { w: size.w * scale, h: size.h * scale };
}

export class CargoSprite extends Container {
  constructor(
    readonly unitId: number,
    readonly typeId: string,
    deps: CargoSpriteDeps,
  ) {
    super({ label: `cargo-${String(unitId)}` });
    const size = cargoSizePx(typeId, deps.cellPx);
    const entry = cargoSpriteEntry(typeId);
    const texture = entry !== undefined ? deps.textures?.file(entry.file) : undefined;
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(size.w, size.h);
      this.addChild(sprite);
    } else {
      const { cargo } = deps.palette;
      const graphics = new Graphics();
      graphics
        .rect(-size.w / 2, -size.h / 2, size.w, size.h)
        .fill({ color: cargo.base.color, alpha: cargo.base.alpha })
        .stroke({ width: OUTLINE_CELLS * deps.cellPx, color: cargo.dark.color, alpha: cargo.dark.alpha, alignment: 1 });
      this.addChild(graphics);
    }
  }
}
