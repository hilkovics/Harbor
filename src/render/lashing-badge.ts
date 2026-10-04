/**
 * Indikátor lashingu lode (F6a, ADR-032 bod 12): po nakládke a vykládke loď v stave `lashing` zaisťuje náklad a vybavuje papiere,
 * kým neodpláva. Odznak sedí v strede lode, ostáva vzpriamený (vyrovnáva rotáciu lode) a nesie prstenec postupu — oblúk
 * `1 − ticksLeft / ticksTotal` v smere hodinových ručičiek od hornej polohy.
 *
 * Kruh pod prstencom je `overlay.queue_badge` z manifestu (bez textúry kruh z `--ui-surface` s obrysom `--ui-accent`), značkou je
 * zámok (náklad sa zaisťuje) vo farbe textu `--ui-text`; farby prstenca z `EntityPalette.lashing` (`--ui-border` dráha,
 * `--ui-warning` postup). Odznak je `LASHING_BADGE_SCALE`-krát väčší než odznaky modulov — je to stav celej lode, nie detail modulu.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import type { CargoSpriteDeps } from './cargo-sprite';
import { QUEUE_BADGE_FILE, QUEUE_BADGE_SIZE, manifestScale } from './entity-assets';

/** Hrúbka obrysu ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Prstenec: hrúbka a medzera od kruhu odznaku v px zdroja (bunka 64 px). */
const RING_WIDTH_PX = 4;
const RING_GAP_PX = 1;

/** Zámok (značka lashingu) v px zdroja: telo (šírka × výška), polomer a hrúbka oblúka strmeňa. */
const LOCK_BODY_PX = { w: 9, h: 7 };
const LOCK_SHACKLE_RADIUS_PX = 3;
const LOCK_SHACKLE_WIDTH_PX = 2;

/** Násobok veľkosti odznaku voči odznakom modulov (24 px zdroja → 36 px). */
export const LASHING_BADGE_SCALE = 1.5;

/** Počet krokov, na ktoré sa postup kvantuje (prekreslenie len pri zmene kroku); 100 = po percentách. */
export const LASHING_PROGRESS_STEPS = 100;

/** Začiatok oblúka: hore (−90°) a koniec pri plnom kruhu. */
const START_ANGLE = -Math.PI / 2;

/** Postup lashingu 0…1 (`1 − ticksLeft / ticksTotal`); neznámy celkový čas (`ticksTotal ≤ 0`) alebo nečíselné `ticksLeft` = 0, hodnoty mimo rozsahu sa orežú. */
export function lashingProgress(ticksLeft: number, ticksTotal: number): number {
  if (!(ticksTotal > 0) || Number.isNaN(ticksLeft)) return 0;
  return Math.min(1, Math.max(0, 1 - ticksLeft / ticksTotal));
}

/** Postup zaokrúhlený na `LASHING_PROGRESS_STEPS` krokov (kľúč prekreslenia). */
export function lashingStep(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * LASHING_PROGRESS_STEPS);
}

export class LashingBadge extends Container {
  private readonly ring = new Graphics();
  private readonly radiusPx: number;
  private readonly ringRadiusPx: number;
  private step = -1;

  constructor(private readonly deps: CargoSpriteDeps) {
    super({ label: 'ship-lashing-badge' });
    const { textures, palette, cellPx } = deps;
    const unit = manifestScale(cellPx) * LASHING_BADGE_SCALE;
    const width = QUEUE_BADGE_SIZE.w * unit;
    const height = QUEUE_BADGE_SIZE.h * unit;
    this.radiusPx = Math.min(width, height) / 2;
    this.ringRadiusPx = this.radiusPx + (RING_GAP_PX + RING_WIDTH_PX / 2) * unit;
    const texture = textures?.file(QUEUE_BADGE_FILE);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(width, height);
      this.addChild(sprite);
    } else {
      const base = new Graphics();
      base
        .circle(0, 0, this.radiusPx - OUTLINE_CELLS * cellPx)
        .fill({ color: palette.surface.color, alpha: palette.surface.alpha })
        .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.accent.color, alpha: palette.accent.alpha });
      this.addChild(base);
    }
    const label = palette.label.color;
    const bodyW = LOCK_BODY_PX.w * unit;
    const bodyH = LOCK_BODY_PX.h * unit;
    const shackle = LOCK_SHACKLE_RADIUS_PX * unit;
    const lockTop = -(bodyH + shackle) / 2 + shackle; // zámok (strmeň + telo) vycentrovaný na kruh
    const lock = new Graphics();
    lock
      .moveTo(-shackle, lockTop)
      .arc(0, lockTop, shackle, Math.PI, 2 * Math.PI)
      .stroke({ width: LOCK_SHACKLE_WIDTH_PX * unit, color: label.color, alpha: label.alpha });
    lock.roundRect(-bodyW / 2, lockTop, bodyW, bodyH, OUTLINE_CELLS * cellPx * 2).fill({ color: label.color, alpha: label.alpha });
    this.addChild(this.ring, lock);
    this.setProgress(0);
  }

  /** Posledný nakreslený krok postupu 0…`LASHING_PROGRESS_STEPS` — pre testy. */
  get drawnStep(): number {
    return this.step;
  }

  /** Nastaví postup 0…1; prstenec sa prekreslí len pri zmene kvantovaného kroku. */
  setProgress(progress: number): void {
    const step = lashingStep(progress);
    if (step === this.step) return;
    this.step = step;
    const { palette, cellPx } = this.deps;
    const width = RING_WIDTH_PX * manifestScale(cellPx) * LASHING_BADGE_SCALE;
    const { track, progress: done } = palette.lashing;
    this.ring.clear();
    this.ring.circle(0, 0, this.ringRadiusPx).stroke({ width, color: track.color, alpha: track.alpha });
    if (step <= 0) return;
    const sweep = (step / LASHING_PROGRESS_STEPS) * Math.PI * 2;
    if (step >= LASHING_PROGRESS_STEPS) {
      this.ring.circle(0, 0, this.ringRadiusPx).stroke({ width, color: done.color, alpha: done.alpha });
      return;
    }
    this.ring
      .moveTo(0, -this.ringRadiusPx) // začiatok oblúka hore; bez čiary zo stredu
      .arc(0, 0, this.ringRadiusPx, START_ANGLE, START_ANGLE + sweep)
      .stroke({ width, color: done.color, alpha: done.alpha });
  }
}
