/**
 * Ozdoba brány kamiónov (`ModuleVM.gate`, DESIGN_BRIEF §5.5): závora (`sprites.truck_gate.parts.barrier`) a odznak fronty
 * (`overlay.queue_badge`) s počtom čakajúcich kamiónov.
 *
 * **Závora** je samostatný sprite s vlastným pivotom (`pivot` v px súboru, `offset` = kam sa ľavý horný roh súboru kladie
 * na základni). Otáča sa okolo pivotu medzi `closedDeg` (zatvorená, cez cestu) a `openDeg` (otvorená) podľa `gate.open`;
 * prechod trvá `BARRIER_MOTION_MS` (kratšie ako 200 ms, DESIGN_BRIEF §6.4) a beží podľa hodín z `ModuleViewDeps.now`.
 *
 * **Odznak fronty** stojí pri vonkajšej bunke vstupného konektora (`gate.entryConnector`, predvolene 0) v ľavom pruhu
 * vzhľadom na smer vjazdu — pravý pruh patrí čakajúcemu kamiónu (`lane.ts`), takže odznak čakajúci kamión nezakrýva.
 * Číslo ostáva vzpriamené pri každej rotácii modulu a drží čitateľnú veľkosť pri zoome (`setBadgeScale`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { QueueBadge } from './badges';
import { manifestScale, type ManifestPart, type ManifestPoint, type ModuleSpriteEntry } from './entity-assets';
import { SIDE_STEP, localCellCenter, type FootprintPose } from './footprint-pose';
import { LANE_OFFSET_CELLS, rightOf } from './lane';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory, ModuleViewDeps } from './module-decor';
import type { ModuleVM, ViewRotation, ViewSide } from './view-models';

/** Trvanie prechodu závory medzi zatvorenou a otvorenou polohou (ms); pod limitom 200 ms z DESIGN_BRIEF §6.4. */
export const BARRIER_MOTION_MS = 150;

/** Hrúbka ramena závory vo fallbacku ako zlomok bunky (6 px pri 64 px, ako v `truck_gate_barrier.svg`). */
const FALLBACK_ARM_CELLS = 6 / 64;

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Kurz kamióna, ktorý vchádza do modulu cez konektor na strane `side` (opak kroku von). */
const ENTRY_HEADING: Readonly<Record<ViewSide, ViewRotation>> = { n: 180, e: 270, s: 0, w: 90 };

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
 * ľavého pruhu vzhľadom na smer vjazdu. Neplatný index → prvý konektor; modul bez konektorov → `null`.
 */
export function queueBadgePosition(
  entry: ModuleSpriteEntry | undefined,
  connectorIndex: number,
  pose: FootprintPose,
  cellPx: number,
): ManifestPoint | null {
  const connectors = entry?.connectors ?? [];
  const connector = connectors[connectorIndex] ?? connectors[0];
  if (connector === undefined) return null;
  const step = SIDE_STEP[connector.side];
  const outside = localCellCenter({ x: connector.x + step.x, y: connector.y + step.y }, pose.baseW, pose.baseH, cellPx);
  const right = rightOf(ENTRY_HEADING[connector.side]);
  const shift = LANE_OFFSET_CELLS * cellPx;
  return { x: outside.x - right.x * shift, y: outside.y - right.y * shift };
}

/** Závora: kontajner v pivote (jeho `angle` je uhol závory), v ňom sprite alebo fallback rameno. */
function createBarrier(part: ManifestPart, context: ModuleDecorContext): Container {
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

const defaultNow = (): number => performance.now();

export class GateDecor implements ModuleDecor {
  readonly view = new Container({ label: 'gate-decor' });
  private readonly deps: ModuleViewDeps;
  private readonly context: ModuleDecorContext;
  private readonly barrier: Container | null;
  private readonly motion: BarrierMotion | null;
  private badge: QueueBadge | null = null;
  private badgeScale = 1;
  private entryConnector = -1;
  /** Modul má konektor, pri ktorom odznak stojí (bez konektorov sa odznak nekreslí). */
  private hasBadgeSpot = true;

  constructor(vm: ModuleVM, context: ModuleDecorContext) {
    this.context = context;
    this.deps = context.deps;
    const part = context.entry?.parts?.['barrier'];
    if (part?.closedDeg !== undefined && part.openDeg !== undefined) {
      this.motion = new BarrierMotion(part.closedDeg, part.openDeg, BARRIER_MOTION_MS, context.deps.now ?? defaultNow, vm.gate?.open === true);
      this.barrier = createBarrier(part, context);
      this.barrier.angle = this.motion.angle;
      this.view.addChild(this.barrier);
    } else {
      this.motion = null;
      this.barrier = null;
    }
    this.update(vm);
  }

  /** Závora je (alebo sa otvára) hore — pre testy. */
  get barrierOpen(): boolean {
    return this.motion?.open === true;
  }

  /** Kontajner závory v jej pivote (`null` = modul bez závory) — pre testy. */
  get barrierView(): Container | null {
    return this.barrier;
  }

  /** Uhol závory v stupňoch práve teraz (`null` = modul bez závory) — pre testy. */
  get barrierAngle(): number | null {
    return this.barrier?.angle ?? null;
  }

  /** Odznak fronty (`null`, kým nebol potrebný) — pre testy. */
  get queueBadge(): QueueBadge | null {
    return this.badge;
  }

  /** Odznak fronty je viditeľný. */
  get queueBadgeVisible(): boolean {
    return this.badge?.visible === true;
  }

  update(vm: ModuleVM): void {
    const gate = vm.gate;
    if (this.motion !== null && this.barrier !== null) {
      this.motion.setOpen(gate?.open === true);
      const angle = this.motion.angle;
      if (this.barrier.angle !== angle) this.barrier.angle = angle;
    }
    if (gate === undefined || gate.queueLength <= 0) {
      if (this.badge !== null) this.badge.visible = false;
      return;
    }
    this.badge ??= this.createBadge();
    const entry = gate.entryConnector ?? 0;
    if (entry !== this.entryConnector) this.placeBadge(this.badge, entry);
    this.badge.setCount(gate.queueLength);
    this.badge.visible = this.hasBadgeSpot;
  }

  setBadgeScale(scale: number): void {
    this.badgeScale = scale;
    this.badge?.scale.set(scale);
  }

  destroy(): void {
    this.badge = null;
    this.view.destroy({ children: true });
  }

  private createBadge(): QueueBadge {
    const badge = new QueueBadge(this.deps);
    badge.angle = -this.context.pose.angle; // číslo ostáva vzpriamené
    badge.scale.set(this.badgeScale);
    this.view.addChild(badge);
    return badge;
  }

  private placeBadge(badge: QueueBadge, connectorIndex: number): void {
    this.entryConnector = connectorIndex;
    const at = queueBadgePosition(this.context.entry, connectorIndex, this.context.pose, this.deps.cellPx);
    this.hasBadgeSpot = at !== null;
    if (at !== null) badge.position.set(at.x, at.y);
  }
}

export const gateDecorFactory: ModuleDecorFactory = {
  id: 'gate',
  applies: (vm) => vm.gate !== undefined,
  create: (vm, context) => new GateDecor(vm, context),
};
