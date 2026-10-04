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

/** Text odznaku VGM hold: počet jednotiek od dvoch vyššie (jednotka sama = bez čísla), zhora orezaný ako pri fronte (`99+`). */
export function holdBadgeLabel(count: number): string {
  const units = Math.max(0, Math.floor(count));
  return units <= 1 ? '' : queueBadgeLabel(units);
}

/** Odsadenie čísla od okraja štítku (px zdroja, bunka 64 px). */
const HOLD_LABEL_PAD_PX = 2;

/** Poloha stredu štítku s počtom: podiel polovice odznaku od jeho stredu doprava a nadol (pravý dolný roh, štítok odznak čiastočne prekrýva). */
const HOLD_LABEL_CORNER = 0.8;

/**
 * Šírka jednej číslice ako násobok veľkosti písma (tabuľkové číslice Inter ≈ 0,62 em): šírka štítku sa odhaduje z počtu znakov,
 * takže sa text nemusí merať (meranie vyžaduje canvas, v Node testoch nie je).
 */
const HOLD_GLYPH_EM = 0.62;

/**
 * Odznak VGM hold (F6a, ADR-032 bod 7): `overlay.warning_badge` (rovnaký ako „nepripojené“) a pri dvoch a viac jednotkách
 * v pravom dolnom rohu štítok s počtom (`--ui-surface` s obrysom `--ui-accent`, číslo `--ui-text`), ktorý odznak čiastočne
 * prekrýva (nezväčšuje jeho plochu, takže odznaky susedných dokov sa neprekrývajú). Stred odznaku je v počiatku; `angle`
 * vyrovná rotáciu rodiča (odznak ostáva vzpriamený), `scale` je násobok pre zoom kamery (`badgeScaleForZoom`).
 */
export class HoldBadge extends Container {
  private readonly count: Container;
  private readonly pill = new Graphics();
  private readonly text: Text;
  private shown = '';

  constructor(
    private readonly deps: QueueBadgeDeps,
    angle: number,
    scale: number,
  ) {
    super({ label: 'unit-hold-badge' });
    this.angle = angle;
    this.scale.set(scale);
    this.addChild(createWarningBadge(deps, 0, 1));
    const { label } = deps.palette;
    this.text = new Text({
      text: '',
      style: {
        fontFamily: label.fontFamily,
        fontWeight: label.fontWeight as TextStyleFontWeight,
        fontSize: label.sizePx * manifestScale(deps.cellPx),
        fill: label.color.color,
      },
      resolution: deps.textResolution ?? 1,
      anchor: 0.5,
    });
    this.count = new Container({ label: 'unit-hold-count' });
    this.count.addChild(this.pill, this.text);
    this.count.visible = false;
    this.addChild(this.count);
  }

  /** Text počtu v štítku (`''` = bez štítku) — pre testy. */
  get shownText(): string {
    return this.shown;
  }

  /** Štítok s počtom je viditeľný — pre testy. */
  get countVisible(): boolean {
    return this.count.visible;
  }

  /** Nastaví počet jednotiek v hold; štítok sa prekreslí len pri zmene textu. */
  setCount(count: number): void {
    const label = holdBadgeLabel(count);
    if (label === this.shown) return;
    this.shown = label;
    this.count.visible = label !== '';
    if (label === '') return;
    const { cellPx, palette } = this.deps;
    const unit = manifestScale(cellPx);
    const pad = HOLD_LABEL_PAD_PX * unit;
    const fontPx = palette.label.sizePx * unit;
    const width = Math.max(fontPx, label.length * fontPx * HOLD_GLYPH_EM) + pad * 2;
    const height = fontPx + pad;
    const center = { x: (WARNING_BADGE_SIZE.w / 2) * HOLD_LABEL_CORNER * unit, y: (WARNING_BADGE_SIZE.h / 2) * HOLD_LABEL_CORNER * unit };
    this.text.text = label;
    this.text.position.set(center.x, center.y);
    this.pill.clear();
    this.pill
      .roundRect(center.x - width / 2, center.y - height / 2, width, height, height / 2)
      .fill({ color: palette.surface.color, alpha: palette.surface.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.accent.color, alpha: palette.accent.alpha });
  }
}
