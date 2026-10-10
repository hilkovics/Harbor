/**
 * Kontajner kreslený z tokenov (`Graphics`): výplň, tmavý obrys a priečne rebrá ako na sprite `cargo.container_teu`
 * (DESIGN_BRIEF §5.7). Spoločné pre náklad na palube lode (`ship-deck.ts`), prázdne kontajnery na aprone, doku a pod žeriavom
 * (`cargo-sprite.ts`) a kontajner na portálovom žeriave dvora — farba (import / export / prázdny) je len parameter.
 */
import type { Graphics } from 'pixi.js';
import type { ColorValue } from './tokens';

/** Počet priečnych rebier na kontajneri (ako na sprite `container_teu`: dva pruhy). */
export const RIB_COUNT = 2;

/** Farby kontajnera: výplň, obrys + rebrá a (voliteľne) svetlý odlesk pri ľavej a hornej hrane ako na sprite. */
export interface BoxColors {
  readonly base: ColorValue;
  readonly dark: ColorValue;
  readonly light?: ColorValue;
}

/** Obdĺžnik kontajnera v px sveta: ľavý horný roh a rozmer. */
export interface BoxRect {
  readonly left: number;
  readonly top: number;
  readonly w: number;
  readonly h: number;
}

/** Os, pozdĺž ktorej leží dlhšia strana kontajnera (`x` = na aprone a doku, `y` = na palube lode). */
export type BoxAxis = 'x' | 'y';

/**
 * Nakreslí kontajner do `graphics` (existujúci obsah ostáva): výplň, obrys hrúbky `outline` (vnútri obdĺžnika), `RIB_COUNT` rebier
 * kolmých na dlhšiu os `axis` a — ak je `colors.light` — odlesk pri ľavej a hornej hrane.
 */
export function drawContainerBox(graphics: Graphics, rect: BoxRect, colors: BoxColors, outline: number, axis: BoxAxis): void {
  const { left, top, w, h } = rect;
  const { base, dark, light } = colors;
  graphics
    .rect(left, top, w, h)
    .fill({ color: base.color, alpha: base.alpha })
    .stroke({ width: outline, color: dark.color, alpha: dark.alpha, alignment: 1 });
  for (let rib = 1; rib <= RIB_COUNT; rib++) {
    if (axis === 'y') {
      const y = top + (h * rib) / (RIB_COUNT + 1);
      graphics.moveTo(left + outline, y).lineTo(left + w - outline, y).stroke({ width: outline / 2, color: dark.color, alpha: dark.alpha });
    } else {
      const x = left + (w * rib) / (RIB_COUNT + 1);
      graphics.moveTo(x, top + outline).lineTo(x, top + h - outline).stroke({ width: outline / 2, color: dark.color, alpha: dark.alpha });
    }
  }
  if (light !== undefined) {
    graphics
      .moveTo(left + outline * 2, top + h - outline * 2)
      .lineTo(left + outline * 2, top + outline * 2)
      .lineTo(left + w - outline * 2, top + outline * 2)
      .stroke({ width: outline / 2, color: light.color, alpha: light.alpha });
  }
}
