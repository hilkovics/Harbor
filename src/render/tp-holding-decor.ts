/**
 * Ozdoby R4 (TR4-03) viazané na bunky sveta: `ModuleVM.tpCells` (odovzdávacie miesta RTG bloku: `overlay.tp_marker`, pri `busy` aj `overlay.safe_zone`)
 * a `ModuleVM.holdingSlots` (miesta odstavnej plochy: obsadené sa zvýraznia `--ui-accent`). Bunky sú vo svetových súradniciach (po rotácii modulu), ozdoba žije
 * v lokálnom rámci modulu (rot 0), takže sa poloha prepočíta späť o rotáciu modulu (rovnako ako `lanes-decor.ts`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import type { Rotation } from '@sim/grid';
import { SAFE_ZONE_FILE, TP_MARKER_FILE } from './entity-assets';
import { rotateOffset } from './footprint-pose';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';

/** Stred svetovej bunky (x; y) v lokálnom rámci modulu (px sveta). */
export function worldCellToLocal(x: number, y: number, context: ModuleDecorContext): { x: number; y: number } {
  const { cellPx } = context.deps;
  const { pose } = context;
  const inverse = ((360 - pose.angle) % 360) as Rotation;
  return rotateOffset((x + 0.5) * cellPx - pose.cx, (y + 0.5) * cellPx - pose.cy, inverse);
}

/** Značka v bunke: sprite zo súboru (1 × 1 bunka, vzpriamený voči svetu) alebo fallback `Graphics`. */
function cellMarker(file: string, context: ModuleDecorContext, at: { x: number; y: number }, fallback: (graphics: Graphics, size: number) => void): Container {
  const { cellPx, textures } = context.deps;
  const texture = textures?.file(file);
  const holder = new Container({ label: 'cell-marker' });
  holder.position.set(at.x, at.y);
  holder.angle = -context.pose.angle;
  if (texture !== undefined) {
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.setSize(cellPx, cellPx);
    holder.addChild(sprite);
  } else {
    const graphics = new Graphics();
    fallback(graphics, cellPx);
    holder.addChild(graphics);
  }
  return holder;
}

export class TpDecor implements ModuleDecor {
  readonly view = new Container({ label: 'tp-decor' });
  private key = '';
  private markers = 0;
  private zones = 0;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.update(vm);
  }

  /** Počet značiek `tp_marker` a obsadených `safe_zone` (testy). */
  get counts(): { markers: number; zones: number } {
    return { markers: this.markers, zones: this.zones };
  }

  update(vm: ModuleVM): void {
    const cells = vm.tpCells ?? [];
    const key = cells.map((cell) => `${String(cell.x)},${String(cell.y)}${cell.busy ? 'b' : ''}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.view.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    const { palette } = this.context.deps;
    this.markers = 0;
    this.zones = 0;
    for (const cell of cells) {
      const at = worldCellToLocal(cell.x, cell.y, this.context);
      if (cell.busy) {
        this.view.addChild(
          cellMarker(SAFE_ZONE_FILE, this.context, at, (g, size) => {
            g.rect(-size / 2, -size / 2, size, size).fill({ color: palette.accent.color, alpha: palette.accent.alpha * 0.25 });
          }),
        );
        this.zones += 1;
      }
      this.view.addChild(
        cellMarker(TP_MARKER_FILE, this.context, at, (g, size) => {
          g.rect(-size / 4, -size / 4, size / 2, size / 2).stroke({ width: 2, color: palette.accent.color, alpha: palette.accent.alpha });
        }),
      );
      this.markers += 1;
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

export class HoldingSlotsDecor implements ModuleDecor {
  readonly view = new Container({ label: 'holding-slots-decor' });
  private key = '';
  private occupiedCount = 0;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.update(vm);
  }

  /** Počet obsadených miest (testy). */
  get occupied(): number {
    return this.occupiedCount;
  }

  update(vm: ModuleVM): void {
    const slots = vm.holdingSlots ?? [];
    const key = slots.map((slot) => `${String(slot.x)},${String(slot.y)}${slot.occupied ? 'o' : ''}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.view.removeChildren().forEach((child) => {
      child.destroy();
    });
    const { cellPx, palette } = this.context.deps;
    this.occupiedCount = 0;
    for (const slot of slots) {
      const at = worldCellToLocal(slot.x, slot.y, this.context);
      const box = new Graphics().rect(-cellPx / 2, -cellPx / 2, cellPx, cellPx);
      if (slot.occupied) {
        box.fill({ color: palette.accent.color, alpha: palette.accent.alpha * 0.3 });
        this.occupiedCount += 1;
      }
      box.stroke({ width: 1, color: palette.accent.color, alpha: palette.accent.alpha * (slot.occupied ? 0.9 : 0.35) });
      box.position.set(at.x, at.y);
      this.view.addChild(box);
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

export const tpDecorFactory: ModuleDecorFactory = {
  id: 'tp-cells',
  applies: (vm) => vm.tpCells !== undefined && vm.tpCells.length > 0,
  create: (vm, context) => new TpDecor(vm, context),
};

export const holdingSlotsDecorFactory: ModuleDecorFactory = {
  id: 'holding-slots',
  applies: (vm) => vm.holdingSlots !== undefined && vm.holdingSlots.length > 0,
  create: (vm, context) => new HoldingSlotsDecor(vm, context),
};
