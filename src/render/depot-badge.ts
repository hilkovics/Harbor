/**
 * Odznaky depa prázdnych kontajnerov (F6c, ADR-034 bod 7): kontrola v depe nájde poškodený prázdny kontajner a ten čaká na miesto opravy
 * (`damaged`), potom sa opravuje (`in_repair`). Odznak je kruh so symbolom a štítkom s číslom v pravom dolnom rohu — rovnaký vzor
 * ako `HoldBadge` (odznak + počet), farby z tokenov:
 *  - `damaged`: kruh `--cargo-empty-damaged` so značkou „×“, štítok = počet poškodených čakajúcich na opravu;
 *  - `repair`: kruh `--ui-warning` s kľúčom, štítok = `v oprave / miesta opráv` (napr. `1/2`).
 * Kruh má obrys `--ui-surface`, značka a text `--ui-text`. Stred odznaku je v počiatku; `angle` vyrovná rotáciu rodiča (odznak ostáva
 * vzpriamený), `scale` je násobok pre zoom kamery (`badgeScaleForZoom`).
 */
import { Container, Graphics, Text, type TextStyleFontWeight } from 'pixi.js';
import { queueBadgeLabel, type QueueBadgeDeps } from './badges';
import { WARNING_BADGE_SIZE, manifestScale } from './entity-assets';
import type { ColorValue } from './tokens';

/** Druh odznaku depa. */
export type DepotBadgeKind = 'damaged' | 'repair';

/** Hrúbka obrysu ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie čísla od okraja štítku (px zdroja, bunka 64 px). */
const LABEL_PAD_PX = 2;

/** Poloha stredu štítku: podiel polomeru odznaku od jeho stredu doprava a nadol (pravý dolný roh, štítok odznak čiastočne prekrýva). */
const LABEL_CORNER = 0.8;

/** Šírka jednej číslice ako násobok veľkosti písma (tabuľkové číslice Inter ≈ 0,62 em), takže sa text nemusí merať. */
const GLYPH_EM = 0.62;

/** Polomer značky „×“ a hrúbka čiary značky ako podiel polomeru kruhu. */
const CROSS_REACH = 0.42;
const GLYPH_STROKE = 0.16;

/** Text štítku poškodených: počet čakajúcich na opravu (`99+` zhora orezaný ako pri fronte); nula = bez odznaku (`''`). */
export function damagedBadgeLabel(damaged: number): string {
  return damaged > 0 ? queueBadgeLabel(damaged) : '';
}

/** Text štítku opráv: `v oprave / miesta opráv`; nula v oprave = bez odznaku (`''`). Počty sa orežú na celé nezáporné. */
export function repairBadgeLabel(inRepair: number, repairBays: number): string {
  const busy = Math.max(0, Math.floor(inRepair));
  return busy > 0 ? `${String(busy)}/${String(Math.max(busy, Math.floor(repairBays)))}` : '';
}

export class DepotBadge extends Container {
  private readonly text: Text;
  private readonly pill = new Graphics();
  private shown = '';

  constructor(
    private readonly deps: QueueBadgeDeps,
    readonly kind: DepotBadgeKind,
    angle: number,
    scale: number,
  ) {
    super({ label: `depot-badge-${kind}` });
    this.angle = angle;
    this.scale.set(scale);
    const { palette, cellPx } = deps;
    const unit = manifestScale(cellPx);
    const radius = (Math.min(WARNING_BADGE_SIZE.w, WARNING_BADGE_SIZE.h) / 2) * unit;
    const fill = kind === 'damaged' ? palette.emptyState.damaged : palette.emptyState.repair;
    const disc = new Graphics();
    disc
      .circle(0, 0, radius - (OUTLINE_CELLS * cellPx) / 2) // obrys je vycentrovaný na hranu: vonkajší polomer = `radius`
      .fill({ color: fill.color, alpha: fill.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.surface.color, alpha: palette.surface.alpha });
    this.addChild(disc, this.createGlyph(kind, radius, palette.emptyState.glyph));
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
    this.addChild(this.pill, this.text);
    this.pill.visible = false;
    this.text.visible = false;
  }

  /** Text štítku (`''` = bez štítku) — pre testy. */
  get shownText(): string {
    return this.shown;
  }

  /** Nastaví text štítku; prekreslí sa len pri zmene. */
  setLabel(label: string): void {
    if (label === this.shown) return;
    this.shown = label;
    this.pill.visible = label !== '';
    this.text.visible = label !== '';
    if (label === '') return;
    const { cellPx, palette } = this.deps;
    const unit = manifestScale(cellPx);
    const pad = LABEL_PAD_PX * unit;
    const fontPx = palette.label.sizePx * unit;
    const width = Math.max(fontPx, label.length * fontPx * GLYPH_EM) + pad * 2;
    const height = fontPx + pad;
    const center = { x: (WARNING_BADGE_SIZE.w / 2) * LABEL_CORNER * unit, y: (WARNING_BADGE_SIZE.h / 2) * LABEL_CORNER * unit };
    this.text.text = label;
    this.text.position.set(center.x, center.y);
    this.pill.clear();
    this.pill
      .roundRect(center.x - width / 2, center.y - height / 2, width, height, height / 2)
      .fill({ color: palette.surface.color, alpha: palette.surface.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.accent.color, alpha: palette.accent.alpha });
  }

  /** Značka v kruhu: „×“ (poškodené) alebo kľúč (oprava) vo farbe `glyph`. */
  private createGlyph(kind: DepotBadgeKind, radius: number, glyph: ColorValue): Graphics {
    const stroke = { width: radius * GLYPH_STROKE * 2, color: glyph.color, alpha: glyph.alpha, cap: 'round' as const };
    const reach = radius * CROSS_REACH;
    const graphics = new Graphics();
    if (kind === 'damaged') {
      graphics.moveTo(-reach, -reach).lineTo(reach, reach).moveTo(reach, -reach).lineTo(-reach, reach).stroke(stroke);
      return graphics;
    }
    // kľúč: šikmá rukoväť od ľavého dolného rohu a prstenec hlavy vpravo hore
    const head = { x: reach * 0.55, y: -reach * 0.55 };
    graphics.moveTo(-reach, reach).lineTo(head.x - reach * 0.3, head.y + reach * 0.3).stroke(stroke);
    graphics.circle(head.x, head.y, reach * 0.5).stroke(stroke);
    return graphics;
  }
}
