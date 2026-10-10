/**
 * Ozdoba jednosmerných pruhov (`ModuleVM.lanes`, R3, TR3-03): kotvisko 8 × 4 a blok RTG majú pruhy so smerom jazdy; ozdoba nad telom modulu kreslí v každej
 * bunke pruhu šípku (chevron v tvare `overlay/path_arrow.svg`, farba `--ui-accent`, polopriehľadná). Bunky sú vo svetových súradniciach (po rotácii modulu),
 * ozdoba žije v lokálnom rámci modulu (rot 0), preto sa poloha aj uhol prepočítajú späť o rotáciu modulu. Bez poľa `lanes` (alebo prázdne) sa ozdoba nevytvára.
 */
import { Container, Graphics } from 'pixi.js';
import type { Rotation } from '@sim/grid';
import { rotateOffset } from './footprint-pose';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { LaneCellVM, ModuleVM, ViewSide } from './view-models';

/** Uhol šípky podľa smeru jazdy (šípka ukazuje na sever pri 0°). */
export const LANE_DIR_ANGLE: Readonly<Record<ViewSide, number>> = Object.freeze({ n: 0, e: 90, s: 180, w: 270 });

/** Chevron šípky v px zdroja vzhľadom na stred bunky (rovnaký tvar ako `road-mark-layer.ts`, `overlay/path_arrow.svg`). */
const CHEVRON: readonly { readonly x: number; readonly y: number }[] = [
  { x: -10, y: 6 },
  { x: 0, y: -6 },
  { x: 10, y: 6 },
];

/** Hrúbka čiary šípky v px zdroja a priehľadnosť overlaya (šípky nesmú prekryť cargo ani vozidlá). */
const STROKE_PX = 4;
const LANE_ARROW_ALPHA = 0.6;

/** Jedna šípka v lokálnom rámci modulu: stred (px sveta) a uhol (stupne, 0 = sever) po odčítaní rotácie modulu. */
export interface LaneArrow {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** Šípky pre bunky `lanes` modulu s pózou `context.pose` (čistá funkcia — `LanesDecor` ich len kreslí). */
export function laneArrows(lanes: readonly LaneCellVM[], context: ModuleDecorContext): LaneArrow[] {
  const { cellPx } = context.deps;
  const { pose } = context;
  const inverse = ((360 - pose.angle) % 360) as Rotation;
  return lanes.map((lane) => {
    const local = rotateOffset((lane.x + 0.5) * cellPx - pose.cx, (lane.y + 0.5) * cellPx - pose.cy, inverse);
    return { x: local.x, y: local.y, angle: LANE_DIR_ANGLE[lane.dir] - pose.angle };
  });
}

export class LanesDecor implements ModuleDecor {
  readonly view = new Container({ label: 'lanes-decor' });
  private key = '';
  private count = 0;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.update(vm);
  }

  /** Počet nakreslených šípok — pre testy. */
  get arrowCount(): number {
    return this.count;
  }

  update(vm: ModuleVM): void {
    const lanes = vm.lanes ?? [];
    const key = lanes.map((lane) => `${String(lane.x)},${String(lane.y)}${lane.dir}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.view.removeChildren().forEach((child) => {
      child.destroy();
    });
    const { cellPx, palette } = this.context.deps;
    const unit = cellPx / 64;
    const color = palette.accent;
    for (const arrow of laneArrows(lanes, this.context)) {
      const chevron = new Graphics();
      chevron.moveTo(CHEVRON[0].x * unit, CHEVRON[0].y * unit);
      chevron.lineTo(CHEVRON[1].x * unit, CHEVRON[1].y * unit);
      chevron.lineTo(CHEVRON[2].x * unit, CHEVRON[2].y * unit);
      chevron.stroke({ width: STROKE_PX * unit, color: color.color, alpha: color.alpha * LANE_ARROW_ALPHA, cap: 'round', join: 'round' });
      chevron.position.set(arrow.x, arrow.y);
      chevron.angle = arrow.angle;
      this.view.addChild(chevron);
    }
    this.count = lanes.length;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

export const lanesDecorFactory: ModuleDecorFactory = {
  id: 'lanes',
  applies: (vm) => vm.lanes !== undefined && vm.lanes.length > 0,
  create: (vm, context) => new LanesDecor(vm, context),
};
