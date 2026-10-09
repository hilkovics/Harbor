/**
 * Ozdoba predbránovej plochy (`pre_gate_buffer`, R4, TR4-03): footprint 8 × 8 nemá jeden sprite — telo skladá z pruhov `sprites.<defId>.parts.lane`
 * (`pre_gate_lane.svg`, 1 × 6, dve miesta na kamión): jeden pruh na každý stĺpec footprintu, zvislo vycentrovaný (voľné riadky hore a dole sú priestor
 * pri konektoroch). Kreslí celé telo (`coversBody`); platí pre každý modul, ktorého manifest má časť `lane` bez vlastného `file`.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { moduleSprite } from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';

export class PreGateDecor implements ModuleDecor {
  readonly view = new Container({ label: 'pre-gate-decor' });
  readonly coversBody = true;
  private lanes = 0;

  constructor(private readonly context: ModuleDecorContext) {
    this.build();
  }

  /** Počet nakreslených pruhov (testy). */
  get laneCount(): number {
    return this.lanes;
  }

  update(): void {
    // statické telo: nič sa nemení
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private build(): void {
    const { cellPx, textures, palette } = this.context.deps;
    const { pose } = this.context;
    const part = this.context.entry?.parts?.['lane'];
    if (part === undefined) return;
    const size = part.footprint ?? { w: 1, h: 1 };
    const texture = textures?.file(part.file);
    const top = (-pose.baseH / 2 + (pose.baseH - size.h) / 2) * cellPx;
    for (let column = 0; column < pose.baseW; column += size.w) {
      const x = (-pose.baseW / 2 + column) * cellPx;
      if (texture !== undefined) {
        const sprite = new Sprite(texture);
        sprite.position.set(x, top);
        sprite.setSize(size.w * cellPx, size.h * cellPx);
        this.view.addChild(sprite);
      } else {
        const { base, outline } = palette.module;
        this.view.addChild(
          new Graphics()
            .rect(x, top, size.w * cellPx, size.h * cellPx)
            .fill({ color: base.color, alpha: base.alpha })
            .stroke({ width: 2, color: outline.color, alpha: outline.alpha }),
        );
      }
      this.lanes += 1;
    }
  }
}

export const preGateDecorFactory: ModuleDecorFactory = {
  id: 'pre-gate',
  applies: (vm) => {
    const entry = moduleSprite(vm.defId);
    return entry?.file === undefined && entry?.parts?.['lane'] !== undefined;
  },
  create: (_vm, context) => new PreGateDecor(context),
};
