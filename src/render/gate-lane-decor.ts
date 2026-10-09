/**
 * Ozdoba pruhu brány (`ModuleVM.gateLane`, R4, TR4-03): `gate_in_lane` / `gate_out_lane` 1 × 4. Ozdoba kreslí celé telo pruhu (`coversBody`): strechu podľa
 * polohy v rade susedných pruhov (`roofPart`: `single` = `sprites.<defId>.file`, `left` / `mid` / `right` = `sprites.<defId>.parts.<časť>`), zdieľanú závoru
 * (`sprites.gate_lane_barrier.parts.barrier`, otvorená, keď pruh nespracúva žiadny krok), štítok kroku (`step`) a pruh postupu (`progress`).
 * Štítok a pruh ostávajú vzpriamené pri každej rotácii modulu.
 */
import { Container, Graphics, Sprite, Text, type TextStyleFontWeight } from 'pixi.js';
import { GATE_BARRIER_ENTRY_ID, manifestScale, moduleSprite, type ModuleSpriteEntry } from './entity-assets';
import { BARRIER_MOTION_MS, BarrierMotion, createBarrier } from './gate-barrier';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { GateLaneVM, ModuleVM } from './view-models';

/** Krátke štítky krokov pruhu (id kroku zo simu → text v UI). */
export const GATE_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ocr: 'OCR',
  check: 'Kontrola',
  issue: 'Výdaj',
  weigh: 'Váženie',
  scan: 'Sken',
  seal: 'Plomba',
  express: 'Express',
  trouble: 'Problém',
  inspect: 'Inšpekcia',
});

/** Kroky, ktoré signalizujú problém (pruh postupu v `--ui-danger`; štítok ostáva čitateľný v farbe popisu). */
const TROUBLE_STEPS: ReadonlySet<string> = new Set(['trouble', 'inspect']);

/** Poloha štítka a pruhu postupu (zlomok výšky pruhu od stredu) a rozmery pruhu postupu. */
const LABEL_Y_FRACTION = -0.42;
const BAR_Y_FRACTION = -0.3;
const BAR_WIDTH_CELLS = 0.7;
const BAR_HEIGHT_PX = 5;

/** Súbor strechy pre `roofPart` (neznáma / chýbajúca časť → `single`). */
export function roofFile(entry: ModuleSpriteEntry | undefined, roofPart: GateLaneVM['roofPart']): string | undefined {
  if (roofPart !== undefined && roofPart !== 'single') {
    const part = entry?.parts?.[roofPart];
    if (part !== undefined) return part.file;
  }
  return entry?.file;
}

/** Závora je hore, kým pruh nespracúva krok. */
export function gateLaneBarrierOpen(lane: GateLaneVM): boolean {
  return lane.step === undefined || lane.step === '';
}

const defaultNow = (): number => performance.now();

export class GateLaneDecor implements ModuleDecor {
  readonly view = new Container({ label: 'gate-lane-decor' });
  readonly coversBody = true;
  private roof: Sprite | Graphics;
  private roofKey: string | undefined;
  private readonly barrier: Container | null;
  private readonly motion: BarrierMotion | null;
  private readonly label: Text;
  private readonly bar = new Graphics();
  private readonly labelHolder = new Container({ label: 'gate-lane-label' });
  private shownStep = '';
  private shownProgress = -2;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    const { cellPx, palette } = context.deps;
    this.roof = new Graphics();
    this.view.addChild(this.roof);
    const barrierPart = moduleSprite(GATE_BARRIER_ENTRY_ID)?.parts?.['barrier'];
    if (barrierPart?.closedDeg !== undefined && barrierPart.openDeg !== undefined) {
      this.motion = new BarrierMotion(barrierPart.closedDeg, barrierPart.openDeg, BARRIER_MOTION_MS, context.deps.now ?? defaultNow, true);
      this.barrier = createBarrier(barrierPart, context);
      this.barrier.angle = this.motion.angle;
      this.view.addChild(this.barrier);
    } else {
      this.motion = null;
      this.barrier = null;
    }
    const unit = manifestScale(cellPx);
    const { label: style } = palette;
    this.label = new Text({
      text: '',
      style: { fontFamily: style.fontFamily, fontWeight: style.fontWeight as TextStyleFontWeight, fontSize: style.sizePx * unit, fill: style.color.color },
      resolution: context.deps.textResolution ?? 1,
      anchor: 0.5,
    });
    this.labelHolder.addChild(this.bar, this.label);
    this.labelHolder.angle = -context.pose.angle; // text ostáva vzpriamený
    this.view.addChild(this.labelHolder);
    this.update(vm);
  }

  /** Súbor aktuálnej strechy (testy). */
  get roofSource(): string | undefined {
    return this.roofKey;
  }

  /** Závora je (alebo sa otvára) hore (testy). */
  get barrierOpen(): boolean {
    return this.motion?.open === true;
  }

  /** Text štítka kroku (prázdny = bez štítka; testy). */
  get labelText(): string {
    return this.label.text;
  }

  update(vm: ModuleVM): void {
    const lane = vm.gateLane;
    this.view.visible = lane !== undefined;
    if (lane === undefined) return;
    this.syncRoof(lane);
    if (this.motion !== null && this.barrier !== null) {
      this.motion.setOpen(gateLaneBarrierOpen(lane));
      const angle = this.motion.angle;
      if (this.barrier.angle !== angle) this.barrier.angle = angle;
    }
    this.syncStep(lane);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private syncRoof(lane: GateLaneVM): void {
    const file = roofFile(this.context.entry, lane.roofPart);
    if (file === this.roofKey && this.roof instanceof Sprite) return;
    this.roofKey = file;
    const { cellPx, textures, palette } = this.context.deps;
    const width = this.context.pose.baseW * cellPx;
    const height = this.context.pose.baseH * cellPx;
    const texture = file !== undefined ? textures?.file(file) : undefined;
    const index = this.view.getChildIndex(this.roof);
    this.roof.destroy();
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.position.set(-width / 2, -height / 2);
      sprite.setSize(width, height);
      this.roof = sprite;
    } else {
      const { base, outline } = palette.module;
      this.roof = new Graphics()
        .rect(-width / 2, -height / 2, width, height)
        .fill({ color: base.color, alpha: base.alpha })
        .stroke({ width: 2, color: outline.color, alpha: outline.alpha });
    }
    this.view.addChildAt(this.roof, index);
  }

  private syncStep(lane: GateLaneVM): void {
    const step = lane.step ?? '';
    const progress = step === '' ? -1 : Math.min(1, Math.max(0, lane.progress ?? 0));
    if (step === this.shownStep && progress === this.shownProgress) return;
    this.shownStep = step;
    this.shownProgress = progress;
    const { cellPx, palette } = this.context.deps;
    const { pose } = this.context;
    const trouble = TROUBLE_STEPS.has(step);
    const color = trouble ? palette.danger : palette.accent;
    this.label.text = step === '' ? '' : (GATE_STEP_LABELS[step] ?? step);
    this.label.position.set(0, LABEL_Y_FRACTION * pose.baseH * cellPx);
    this.bar.clear();
    if (step === '') return;
    const width = BAR_WIDTH_CELLS * cellPx;
    const height = BAR_HEIGHT_PX * manifestScale(cellPx);
    const y = BAR_Y_FRACTION * pose.baseH * cellPx;
    this.bar.rect(-width / 2, y, width, height).fill({ color: palette.surface.color, alpha: palette.surface.alpha });
    this.bar.rect(-width / 2, y, width * progress, height).fill({ color: color.color, alpha: color.alpha });
  }
}

export const gateLaneDecorFactory: ModuleDecorFactory = {
  id: 'gate-lane',
  applies: (vm) => vm.gateLane !== undefined,
  create: (vm, context) => new GateLaneDecor(vm, context),
};
