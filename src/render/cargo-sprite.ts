/**
 * CargoSprite (DESIGN_BRIEF §5.7): jedna jednotka nákladu na aprone alebo v žeriave.
 *
 * Sprite je `cargo.<typeId>` z manifestu (kontajner `container_teu`, dlhšia strana pozdĺž x pri rot 0) zobrazený v jednotnej
 * veľkosti `cargoDisplaySize` (TEU 64×26 px; sprite je nakreslený 64×32 a zmenší sa na šírku 26 px), vycentrovaný na počiatok kontajnera; rodič ho kladie na stred slotu / trolley. Bez textúry (alebo bez záznamu
 * v manifeste) je to obdĺžnik z tokenov `--cargo-container` s tmavým obrysom v rovnakej veľkosti.
 *
 * **F6c (ADR-034):** prázdny kontajner (`look.empty`, `direction: 'empty'`) sa kreslí procedurálne farbou `--cargo-empty` (výplň,
 * obrys, rebrá a odlesk, `container-box.ts`) v rovnakej veľkosti ako sprite — sprite `container_teu` je oranžový a jeho pripečená
 * farba sa nedá prefarbiť. Ak má jednotka linku (`look.lineColor`), nesie pásik v jej farbe (`--line-*`) po dlhšej strane kontajnera.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { drawContainerBox } from './container-box';
import { MANIFEST_CELL_PX, cargoDisplaySize, cargoSpriteEntry, manifestScale, type CellSize } from './entity-assets';
import { TEU_PX } from './world-scale';
import type { EntityTextures } from './sprite-atlas';
import type { ColorValue, EntityPalette } from './tokens';

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

/** Vzhľad jednotky nad rámec typu nákladu (F6c): prázdny kontajner a farba jeho linky. */
export interface CargoLook {
  /** Prázdny kontajner (`direction: 'empty'`) → sivý, kreslený z tokenov. */
  readonly empty?: boolean;
  /** Farba linky (`EntityPalette.line[…]`): pásik po dlhšej strane prázdneho kontajnera; bez farby sa nekreslí. */
  readonly lineColor?: ColorValue;
}

/** Hrúbka pásika linky ako podiel kratšej strany kontajnera. */
export const LINE_BAND_SHARE = 0.28;

export class CargoSprite extends Container {
  constructor(
    readonly unitId: number,
    readonly typeId: string,
    deps: CargoSpriteDeps,
    readonly look: CargoLook = {},
  ) {
    super({ label: `cargo-${String(unitId)}` });
    const size = cargoSizePx(typeId, deps.cellPx);
    if (look.empty === true) {
      this.addChild(createEmptyBox(size, deps, look.lineColor));
      return;
    }
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

/** Prázdny kontajner z tokenov: sivá výplň s rebrami a odleskom, dlhšia strana pozdĺž x; pásik linky v strede jeho dĺžky. */
function createEmptyBox(size: CellSize, deps: CargoSpriteDeps, lineColor: ColorValue | undefined): Graphics {
  const outline = OUTLINE_CELLS * deps.cellPx;
  const graphics = new Graphics();
  drawContainerBox(graphics, { left: -size.w / 2, top: -size.h / 2, w: size.w, h: size.h }, deps.palette.direction.empty, outline, 'x');
  if (lineColor !== undefined) {
    const band = size.h * LINE_BAND_SHARE;
    graphics.rect(-size.w / 2 + outline * 2, -band / 2, size.w - outline * 4, band).fill({ color: lineColor.color, alpha: lineColor.alpha });
  }
  return graphics;
}
