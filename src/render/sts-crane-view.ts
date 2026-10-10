/**
 * StsCraneView (R3, TR3-03; TERMINAL_2, `design/assets-t2/README.md`): nový STS žeriav z oddelených spritov `sprites.sts.parts` — **rám je statický**
 * (3 × 10 buniek, výložník nerotuje), vozík jazdí po osi Y rámu (`travel.yMin..yMax`, px rámu), pod vozíkom visí spreader 20′ / 40′ a pod ním kontajner.
 *
 * Skladanie (rot 0, počiatok = stred footprintu, potom sa celé otočí o `rotation`; poradie kreslenia z manifestu): **kontajner → spreader → rám → vozík**.
 * Rám a vozík sú v koreni `view` (nad vozidlami: vozidlá prechádzajú pod portálom, pod nosníkmi), `baseView` ostáva prázdny (rovnaké rozhranie ako `CraneView`).
 *
 * Poloha vozíka: `CraneVM.trolleyY` 0..1 (0 = nos k vode, 1 = backreach); chýba → z `state` a `progress` (`trolleyTravelFraction`: pevnina → backreach).
 * Spreader sa volí podľa `CraneVM.cargo.sizeFt` (bez nákladu 40′); kontajner (`CraneVM.cargo`) visí pod spreaderom, dlhšou stranou pozdĺž nábrežia (os x).
 * Odznak `overlay.blocked_badge` (pri `blocked`) sa neotáča so žeriavom. Chýbajúca textúra časti → obdĺžnik z tokenov (`--crane-frame` / `--crane-boom`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { CargoSprite } from './cargo-sprite';
import { containerKey } from './container-sprites';
import { craneBox, trolleyTravelFraction, type CraneViewDeps } from './crane-view';
import {
  BLOCKED_BADGE_FILE,
  BLOCKED_BADGE_SIZE,
  MANIFEST_CELL_PX,
  manifestScale,
  type ManifestPoint,
  type StsEntry,
  type StsPart,
} from './entity-assets';
import { footprintPose, rotateOffset, type FootprintPose } from './footprint-pose';
import type { ContainerVM, CraneVM } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Typ nákladu pod spreaderom (len nositeľ štítkov; kontajner sa kreslí podľa `look.container`). */
const STS_CARGO_TYPE = 'container_teu';

/** Podiel dráhy vozíka 0..1 (0 = nos k vode, 1 = backreach) pre VM: `trolleyY`, inak odvodený zo stavu cyklu. */
export function stsTrolleyFraction(vm: CraneVM): number {
  const value = vm.trolleyY ?? 1 - trolleyTravelFraction(vm.state, vm.progress, vm.cycle);
  return Math.min(1, Math.max(0, value));
}

/** Súradnica `y` stredu vozíka v súradniciach rámu (px zdroja) pre podiel dráhy `fraction`. */
export function stsTrolleyFrameY(fraction: number, travel: { readonly yMin: number; readonly yMax: number }): number {
  return travel.yMin + fraction * (travel.yMax - travel.yMin);
}

/** Veľkosť spreadera pre kontajner na ňom (bez kontajnera 40′). */
export function stsSpreaderSize(cargo: ContainerVM | null | undefined): 20 | 40 {
  return cargo?.sizeFt === 20 ? 20 : 40;
}

/**
 * Poloha rámu: pri module žeriavu s `entry.module` (napr. `crane_container_gantry` 2 × 3) je `vm.x/y` roh modulu a rám 3 × 10 sa kladie o `frameOffset`
 * (rot 0) od neho — os vozíka na bunku pod hákom, nohy mimo pruhov nábrežia; posun medzi stredmi sa otáča s modulom. Inak je `vm.x/y` roh rámu.
 */
export function stsPose(vm: CraneVM, entry: StsEntry, cellPx: number): FootprintPose {
  const frame = footprintPose(craneBox(vm, entry.footprint), cellPx);
  const mod = entry.module;
  if (mod === undefined) return frame;
  const moduleBox = craneBox(vm, mod.footprint);
  const moduleCenter = { x: moduleBox.x + moduleBox.w / 2, y: moduleBox.y + moduleBox.h / 2 };
  const delta = rotateOffset(
    mod.frameOffset.x + entry.footprint.w / 2 - mod.footprint.w / 2,
    mod.frameOffset.y + entry.footprint.h / 2 - mod.footprint.h / 2,
    vm.rotation,
  );
  return { ...frame, cx: (moduleCenter.x + delta.x) * cellPx, cy: (moduleCenter.y + delta.y) * cellPx };
}

export class StsCraneView {
  /** Koreň: počiatok = stred footprintu (px), neotočený; telo (otočené) a odznak. */
  readonly view: Container;
  /** Prázdny koreň základne (rozhranie ako `CraneView`): STS sa kreslí celý nad vozidlami. */
  readonly baseView: Container;
  readonly id: number;
  private last: CraneVM;
  private readonly pose: FootprintPose;
  private readonly scale: number;
  private readonly body = new Container({ label: 'sts-body' });
  private readonly cargoGroup = new Container({ label: 'sts-cargo' });
  private readonly spreaderGroup = new Container({ label: 'sts-spreader' });
  private readonly trolleyGroup = new Container({ label: 'sts-trolley' });
  private spreader20: Sprite | Graphics | null = null;
  private spreader40: Sprite | Graphics | null = null;
  private readonly badge: Container;
  private cargo: { readonly key: string; readonly sprite: CargoSprite } | null = null;

  constructor(
    vm: CraneVM,
    private readonly deps: CraneViewDeps,
    private readonly entry: StsEntry,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.scale = manifestScale(deps.cellPx);
    this.pose = stsPose(vm, entry, deps.cellPx);
    this.view = new Container({ label: `sts-${String(vm.id)}` });
    this.view.position.set(this.pose.cx, this.pose.cy);
    this.baseView = new Container({ label: `sts-base-${String(vm.id)}` });
    this.baseView.position.set(this.pose.cx, this.pose.cy);
    this.body.angle = this.pose.angle;
    this.view.addChild(this.body);
    this.build();
    this.badge = this.createBadge();
    this.badge.scale.set(deps.badgeScale ?? 1);
    this.view.addChild(this.badge);
    this.apply(vm);
  }

  get vm(): CraneVM {
    return this.last;
  }

  /** Odznak zablokovania je viditeľný (testy). */
  get badgeVisible(): boolean {
    return this.badge.visible;
  }

  /** Poloha vozíka v px sveta od stredu footprintu po osi Y rámu (testy). */
  get trolleyOffsetY(): number {
    return this.trolleyGroup.y;
  }

  /** Zobrazená veľkosť spreadera 20 / 40 (testy). */
  get spreaderSizeFt(): 20 | 40 {
    return this.spreader20?.visible === true ? 20 : 40;
  }

  /** Kontajner pod spreaderom (testy). */
  get heldCargo(): CargoSprite | null {
    return this.cargo?.sprite ?? null;
  }

  /** Rám je nakreslený spritom z manifestu (nie fallbackom) — testy. */
  get textured(): boolean {
    return this.deps.textures?.file(this.entry.frame.file) !== undefined;
  }

  update(vm: CraneVM): void {
    const before = this.last;
    if (
      before.state === vm.state &&
      before.progress === vm.progress &&
      before.cycle === vm.cycle &&
      before.trolleyY === vm.trolleyY &&
      before.cargo === vm.cargo &&
      before.holding?.unitId === vm.holding?.unitId
    ) {
      this.last = vm;
      return;
    }
    this.apply(vm);
  }

  setBadgeScale(scale: number): void {
    this.badge.scale.set(scale);
  }

  destroy(): void {
    this.cargo = null;
    this.view.destroy({ children: true });
    this.baseView.destroy({ children: true });
  }

  private apply(vm: CraneVM): void {
    this.last = vm;
    const y = (stsTrolleyFrameY(stsTrolleyFraction(vm), this.entry.travelY) - this.frameOriginY()) * this.scale;
    for (const group of [this.cargoGroup, this.spreaderGroup, this.trolleyGroup]) group.y = y;
    const size = stsSpreaderSize(vm.cargo);
    if (this.spreader20 !== null) this.spreader20.visible = size === 20;
    if (this.spreader40 !== null) this.spreader40.visible = size === 40;
    this.syncCargo(vm.cargo ?? null);
    this.badge.visible = vm.state === 'blocked';
  }

  /** Súradnica y stredu footprintu v súradniciach rámu (px zdroja). */
  private frameOriginY(): number {
    return (this.entry.frame.footprint.h * MANIFEST_CELL_PX) / 2;
  }

  private syncCargo(container: ContainerVM | null): void {
    const key = containerKey(container);
    if ((this.cargo?.key ?? '') === key) return;
    this.cargo?.sprite.destroy({ children: true });
    this.cargo = null;
    if (container === null) return;
    const { cellPx, palette, textures } = this.deps;
    const sprite = new CargoSprite(this.id, STS_CARGO_TYPE, { cellPx, palette, textures }, { container });
    this.cargoGroup.addChild(sprite);
    this.cargo = { key, sprite };
  }

  /** Poskladá časti v poradí kontajner → spreader → rám → vozík; vodorovná poloha vozíka a spreadera je os rámu (`pivot.x` vozíka). */
  private build(): void {
    const { entry } = this;
    const { cellPx } = this.deps;
    const topLeft: ManifestPoint = { x: (-this.pose.baseW * cellPx) / 2, y: (-this.pose.baseH * cellPx) / 2 };
    const axisX = topLeft.x + entry.trolley.pivot.x * this.scale;
    for (const group of [this.cargoGroup, this.spreaderGroup, this.trolleyGroup]) group.x = axisX;
    this.body.addChild(this.cargoGroup, this.spreaderGroup);
    this.body.addChild(this.partDisplay(entry.frame, 'frame', topLeft));
    this.body.addChild(this.trolleyGroup);
    this.spreader20 = this.partDisplay(entry.spreader20, 'boom', { x: 0, y: 0 });
    this.spreader40 = this.partDisplay(entry.spreader40, 'boom', { x: 0, y: 0 });
    this.spreader20.visible = false;
    this.spreaderGroup.addChild(this.spreader20, this.spreader40);
    this.trolleyGroup.addChild(this.partDisplay(entry.trolley, 'frame', { x: 0, y: 0 }));
  }

  /** Sprite alebo fallback časti: ľavý horný roh je `origin − pivot × scale`, veľkosť `footprint × cellPx`. */
  private partDisplay(part: StsPart, fallback: 'frame' | 'boom', origin: ManifestPoint): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const width = part.footprint.w * cellPx;
    const height = part.footprint.h * cellPx;
    // rám sa kladie ľavým horným rohom (`origin` = roh footprintu), ostatné časti pivotom
    const isFrame = part === this.entry.frame;
    const x = origin.x - (isFrame ? 0 : part.pivot.x * this.scale);
    const y = origin.y - (isFrame ? 0 : part.pivot.y * this.scale);
    const texture = textures?.file(part.file);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.position.set(x, y);
      sprite.setSize(width, height);
      return sprite;
    }
    const color = fallback === 'boom' ? palette.crane.boom : palette.crane.frame;
    const graphics = new Graphics();
    graphics
      .rect(x, y, width, height)
      .fill({ color: color.color, alpha: color.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha, alignment: 1 });
    return graphics;
  }

  private createBadge(): Container {
    const { textures, palette, cellPx } = this.deps;
    const width = BLOCKED_BADGE_SIZE.w * this.scale;
    const height = BLOCKED_BADGE_SIZE.h * this.scale;
    const badge = new Container({ label: 'sts-blocked-badge' });
    const texture = textures?.file(BLOCKED_BADGE_FILE);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.setSize(width, height);
      badge.addChild(sprite);
    } else {
      const graphics = new Graphics();
      graphics
        .circle(0, 0, Math.min(width, height) / 2)
        .fill({ color: palette.danger.color, alpha: palette.danger.alpha })
        .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha });
      badge.addChild(graphics);
    }
    return badge;
  }
}
