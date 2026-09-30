/**
 * Odznaky nad modulmi (DESIGN_BRIEF §5.8): `overlay.warning_badge` („nepripojené“, „neprevádzková rampa“) a
 * `overlay.queue_badge` (počet kamiónov vo fronte pred bránou).
 *
 * Oba sú kontajnery so stredom v počiatku: sprite z manifestu (alebo kruh z tokenov, ak textúra chýba) v rozmere
 * `size × cellPx / 64`. Odznak fronty nesie číslo kreslené enginom (Pixi `Text`; písmo, farba a veľkosť z tokenov).
 */
import { Container, Graphics, Sprite, Text, type TextStyleFontWeight } from 'pixi.js';
import type { CargoSpriteDeps } from './cargo-sprite';
import {
  QUEUE_BADGE_FILE,
  QUEUE_BADGE_SIZE,
  WARNING_BADGE_FILE,
  WARNING_BADGE_SIZE,
  manifestScale,
} from './entity-assets';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Najvyššie číslo, ktoré odznak fronty ukáže presne; vyššie sa zobrazí ako „99+“. */
export const QUEUE_BADGE_MAX = 99;

/** Text odznaku fronty pre `count` čakajúcich kamiónov. */
export function queueBadgeLabel(count: number): string {
  return count > QUEUE_BADGE_MAX ? `${String(QUEUE_BADGE_MAX)}+` : String(Math.max(0, Math.floor(count)));
}

/**
 * Odznak `overlay.warning_badge` so stredom v počiatku. `angle` vyrovná rotáciu rodiča (odznak ostáva vzpriamený),
 * `scale` je násobok pre zoom kamery (`badgeScaleForZoom`).
 */
export function createWarningBadge(deps: CargoSpriteDeps, angle: number, scale: number): Container {
  const { textures, palette, cellPx } = deps;
  const unit = manifestScale(cellPx);
  const width = WARNING_BADGE_SIZE.w * unit;
  const height = WARNING_BADGE_SIZE.h * unit;
  const badge = new Container({ label: 'module-disconnected-badge' });
  badge.angle = angle;
  badge.scale.set(scale);
  const texture = textures?.file(WARNING_BADGE_FILE);
  if (texture !== undefined) {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.setSize(width, height);
    badge.addChild(sprite);
  } else {
    const { disconnected, module } = palette;
    const graphics = new Graphics();
    graphics
      .circle(0, 0, Math.min(width, height) / 2)
      .fill({ color: disconnected.color, alpha: disconnected.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: module.outline.color, alpha: module.outline.alpha });
    badge.addChild(graphics);
  }
  return badge;
}

export interface QueueBadgeDeps extends CargoSpriteDeps {
  /** Rozlíšenie rasterizácie čísla (px na px sveta); vyššie = ostrejšie pri priblížení. Predvolene 1. */
  readonly textResolution?: number;
}

/** Odznak fronty: kruh `overlay.queue_badge` s číslom uprostred. */
export class QueueBadge extends Container {
  private readonly text: Text;
  private shown = '';

  constructor(deps: QueueBadgeDeps) {
    super({ label: 'gate-queue-badge' });
    const { textures, palette, cellPx } = deps;
    const unit = manifestScale(cellPx);
    const width = QUEUE_BADGE_SIZE.w * unit;
    const height = QUEUE_BADGE_SIZE.h * unit;
    const texture = textures?.file(QUEUE_BADGE_FILE);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(width, height);
      this.addChild(sprite);
    } else {
      const graphics = new Graphics();
      graphics
        .circle(0, 0, Math.min(width, height) / 2 - OUTLINE_CELLS * cellPx)
        .fill({ color: palette.surface.color, alpha: palette.surface.alpha })
        .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.accent.color, alpha: palette.accent.alpha });
      this.addChild(graphics);
    }
    const { label } = palette;
    this.text = new Text({
      text: '',
      style: {
        fontFamily: label.fontFamily,
        fontWeight: label.fontWeight as TextStyleFontWeight,
        fontSize: label.sizePx * unit,
        fill: label.color.color,
      },
      resolution: deps.textResolution ?? 1,
      anchor: 0.5,
    });
    this.addChild(this.text);
  }

  /** Text aktuálne zobrazený v odznaku (testy). */
  get shownText(): string {
    return this.shown;
  }

  /** Nastaví počet vo fronte; text sa prekreslí len pri zmene. */
  setCount(count: number): void {
    const label = queueBadgeLabel(count);
    if (label === this.shown) return;
    this.shown = label;
    this.text.text = label;
  }
}
