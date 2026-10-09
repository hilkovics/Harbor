/**
 * Závora pruhu brány (`gate_lane_barrier` v manifeste, R4): `BarrierMotion` (plynulý uhol závory v čase) a `createBarrier` (sprite s pivotom alebo fallback rameno).
 * Používa ich `gate-lane-decor.ts`. Závora sa otáča okolo pivotu medzi `closedDeg` (cez pruh) a `openDeg` (hore); prechod trvá `BARRIER_MOTION_MS`
 * (kratšie ako 200 ms, DESIGN_BRIEF §6.4) a beží podľa hodín z `ModuleViewDeps.now`.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { manifestScale, type ManifestPart } from './entity-assets';
import type { ModuleDecorContext } from './module-decor';

/** Trvanie prechodu závory medzi zatvorenou a otvorenou polohou (ms); pod limitom 200 ms z DESIGN_BRIEF §6.4. */
export const BARRIER_MOTION_MS = 150;

/** Hrúbka ramena závory vo fallbacku ako zlomok bunky (6 px pri 64 px, ako v `gate_lane_barrier.svg`). */
const FALLBACK_ARM_CELLS = 6 / 64;

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/**
 * Uhol závory v čase: plynulý prechod z aktuálneho uhla do cieľa (`closedDeg` / `openDeg`) za `durationMs`. Čistá trieda
 * bez Pixi — hodiny sa podávajú zvonka, aby šla testovať bez skutočného času.
 */
export class BarrierMotion {
  private from: number;
  private to: number;
  private startedAt = 0;

  constructor(
    private readonly closedDeg: number,
    private readonly openDeg: number,
    private readonly durationMs: number,
    private readonly now: () => number,
    open: boolean,
  ) {
    this.to = open ? openDeg : closedDeg;
    this.from = this.to;
  }

  /** Cieľová poloha: závora je (alebo sa otvára) hore. */
  get open(): boolean {
    return this.to === this.openDeg;
  }

  /** Uhol v stupňoch v aktuálnom čase. */
  get angle(): number {
    if (this.from === this.to) return this.to;
    const t = this.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (this.now() - this.startedAt) / this.durationMs));
    return this.from + (this.to - this.from) * t;
  }

  /** Nastaví cieľ; pri zmene sa prechod začne z aktuálneho uhla (aj uprostred pohybu). */
  setOpen(open: boolean): void {
    const target = open ? this.openDeg : this.closedDeg;
    if (target === this.to) return;
    this.from = this.angle;
    this.to = target;
    this.startedAt = this.now();
  }
}

/**
 * Poloha odznaku fronty v lokálnom rámci modulu (px, rot 0): stred vonkajšej bunky konektora `connectorIndex` posunutý do

/** Závora: kontajner v pivote (jeho `angle` je uhol závory), v ňom sprite alebo fallback rameno. */
export function createBarrier(part: ManifestPart, context: ModuleDecorContext): Container {
  const { cellPx, textures, palette } = context.deps;
  const { pose } = context;
  const unit = manifestScale(cellPx);
  const offset = part.offset ?? { x: 0, y: 0 };
  const pivot = part.pivot ?? { x: 0, y: 0 };
  const size = part.footprint ?? { w: 1, h: 1 };
  const holder = new Container({ label: 'gate-barrier' });
  holder.position.set((-pose.baseW * cellPx) / 2 + (offset.x + pivot.x) * unit, (-pose.baseH * cellPx) / 2 + (offset.y + pivot.y) * unit);
  const texture = textures?.file(part.file);
  if (texture !== undefined) {
    const sprite = new Sprite(texture);
    sprite.position.set(-pivot.x * unit, -pivot.y * unit);
    sprite.setSize(size.w * cellPx, size.h * cellPx);
    holder.addChild(sprite);
  } else {
    const thickness = FALLBACK_ARM_CELLS * cellPx;
    const graphics = new Graphics();
    graphics
      .rect(0, -thickness / 2, size.w * cellPx - pivot.x * unit, thickness)
      .fill({ color: palette.danger.color, alpha: palette.danger.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha, alignment: 1 });
    holder.addChild(graphics);
  }
  return holder;
}
