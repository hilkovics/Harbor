/**
 * Ozdoba čakacej plochy (`ModuleVM.waitingArea`, DESIGN_BRIEF §5.5): obsadené stojiská sa zvýraznia. Stojiská sú
 * obdĺžniky `sprites.truck_waiting_area.stalls` z manifestu (px súboru pri rot 0); `occupied[i]` patrí `stalls[i]`.
 * Zvýraznenie je priesvitná výplň a obrys v `--ui-accent` pod kamiónom, ktorý na stojisku stojí (kamióny kreslí `EntityLayer`).
 */
import { Container, Graphics } from 'pixi.js';
import { manifestScale, type ManifestRect } from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';

/** Priehľadnosť výplne obsadeného stojiska (farba je `--ui-accent`). */
export const STALL_FILL_ALPHA = 0.35;

/** Hrúbka obrysu obsadeného stojiska ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Indexy obsadených stojísk (poradie ako `stalls`; index bez záznamu v manifeste sa preskočí). */
export function occupiedStalls(occupied: readonly boolean[] | undefined, stallCount: number): number[] {
  const result: number[] = [];
  if (occupied === undefined) return result;
  for (let index = 0; index < Math.min(occupied.length, stallCount); index++) {
    if (occupied[index]) result.push(index);
  }
  return result;
}

export class WaitingAreaDecor implements ModuleDecor {
  readonly view = new Container({ label: 'waiting-area-decor' });
  private readonly graphics = new Graphics();
  private readonly stalls: readonly ManifestRect[];
  /** Kľúč naposledy nakresleného stavu (zoznam obsadených indexov), aby sa neprekresľovalo zbytočne. */
  private drawn = '';
  private drawnIndexes: readonly number[] = [];

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.stalls = context.entry?.stalls ?? [];
    this.view.addChild(this.graphics);
    this.update(vm);
  }

  /** Indexy práve zvýraznených stojísk — pre testy. */
  get highlighted(): readonly number[] {
    return this.drawnIndexes;
  }

  update(vm: ModuleVM): void {
    const indexes = occupiedStalls(vm.waitingArea?.occupied, this.stalls.length);
    const key = indexes.join(',');
    if (key === this.drawn) return;
    this.drawn = key;
    this.drawnIndexes = indexes;
    this.redraw(indexes);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private redraw(indexes: readonly number[]): void {
    const { cellPx, palette } = this.context.deps;
    const { pose } = this.context;
    const unit = manifestScale(cellPx);
    const left = (-pose.baseW * cellPx) / 2;
    const top = (-pose.baseH * cellPx) / 2;
    const { accent } = palette;
    this.graphics.clear();
    for (const index of indexes) {
      const stall = this.stalls[index];
      this.graphics
        .rect(left + stall.x * unit, top + stall.y * unit, stall.w * unit, stall.h * unit)
        .fill({ color: accent.color, alpha: accent.alpha * STALL_FILL_ALPHA })
        .stroke({ width: OUTLINE_CELLS * cellPx, color: accent.color, alpha: accent.alpha, alignment: 1 });
    }
  }
}

export const waitingAreaDecorFactory: ModuleDecorFactory = {
  id: 'waiting_area',
  applies: (vm) => vm.waitingArea !== undefined,
  create: (vm, context) => new WaitingAreaDecor(vm, context),
};
