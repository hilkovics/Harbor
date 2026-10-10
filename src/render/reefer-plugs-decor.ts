/**
 * Ozdoba reefer racku (R5, TR5-03): `ModuleVM.plugs` — ikony zásuviek `overlay.reefer_plug_<on|off|alarm>` pozdĺž radov racku (telo je sprite `reefer_rack`
 * z manifestu, 1 × 1 bunka, opakuje sa po x). `x`, `y` zásuvky sú v bunkách sveta (bod, nie ľavý horný roh: stred bunky = +0,5), ozdoba ich prepočíta do
 * lokálneho rámca modulu (rovnako ako `tp-holding-decor.ts`). Voľná zásuvka (`empty`) je len malý obrys z tokenov; bez textúry je ikona kruh z tokenov.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import type { Rotation } from '@sim/grid';
import { REEFER_PLUG_FILES, REEFER_PLUG_SIZE, manifestScale } from './entity-assets';
import { rotateOffset } from './footprint-pose';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM, ReeferPlugVM } from './view-models';

/** Polomer obrysu voľnej zásuvky ako podiel rozmeru ikony. */
const EMPTY_RING_SHARE = 0.3;

export class ReeferPlugsDecor implements ModuleDecor {
  readonly view = new Container({ label: 'reefer-plugs' });
  private key = '';
  private counts: Record<ReeferPlugVM['state'], number> = { on: 0, off: 0, alarm: 0, empty: 0 };

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.update(vm);
  }

  /** Počet nakreslených zásuviek podľa stavu (testy). */
  get plugCounts(): Readonly<Record<ReeferPlugVM['state'], number>> {
    return this.counts;
  }

  update(vm: ModuleVM): void {
    const plugs = vm.plugs ?? [];
    const key = plugs.map((plug) => `${String(plug.x)},${String(plug.y)},${plug.state}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.view.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    this.counts = { on: 0, off: 0, alarm: 0, empty: 0 };
    const { cellPx, palette, textures } = this.context.deps;
    const { pose } = this.context;
    const inverse = ((360 - pose.angle) % 360) as Rotation;
    const size = REEFER_PLUG_SIZE.w * manifestScale(cellPx);
    for (const plug of plugs) {
      const at = rotateOffset(plug.x * cellPx - pose.cx, plug.y * cellPx - pose.cy, inverse);
      const holder = new Container({ label: `plug-${plug.state}` });
      holder.position.set(at.x, at.y);
      holder.angle = -pose.angle;
      if (plug.state === 'empty') {
        const { outline } = palette.module;
        holder.addChild(new Graphics().circle(0, 0, size * EMPTY_RING_SHARE).stroke({ width: cellPx / 32, color: outline.color, alpha: outline.alpha }));
      } else {
        const texture = textures?.file(REEFER_PLUG_FILES[plug.state]);
        if (texture !== undefined) {
          const sprite = new Sprite(texture);
          sprite.anchor.set(0.5);
          sprite.setSize(size, size);
          holder.addChild(sprite);
        } else {
          const color = plug.state === 'on' ? palette.accent : plug.state === 'alarm' ? palette.emptyState.repair : palette.container.neutral;
          holder.addChild(new Graphics().circle(0, 0, size / 2).fill({ color: color.color, alpha: color.alpha }));
        }
      }
      this.counts[plug.state] += 1;
      this.view.addChild(holder);
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

export const reeferPlugsDecorFactory: ModuleDecorFactory = {
  id: 'reefer_plugs',
  applies: (vm) => vm.plugs !== undefined,
  create: (vm, context) => new ReeferPlugsDecor(vm, context),
};
