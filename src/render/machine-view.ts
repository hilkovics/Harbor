/**
 * MachineView (R3, TR3-03): RTG nad blokom skladu — sprity `entities.rtg.parts` z manifestu: rám `rtg_frame` (5 × 2 bunky, pivot = stred rámu, jazdí po osi Y)
 * a vozík `rtg_trolley` (jazdí po osi X rámu v rozsahu `travel`, stred vozíka na koľajniciach y = 64). Kontajner (`MachineVM.cargo`) visí pod vozíkom,
 * dlhšou stranou pozdĺž osi Y (smer jazdy rámu, bay). Poradie kreslenia: rám → kontajner → vozík (zdvihnutý kontajner je nad rámom, vozík nad ním).
 *
 * `x`, `y` = stred rámu v bunkách; `trolley` 0..1 = poloha vozíka naprieč rámom (0 vľavo, 1 vpravo = pruh kamióna); `hoist` 0..1 = výška zdvihu, kreslená
 * ako zväčšenie kontajnera (`MACHINE_HOIST_SCALE`: bližšie ku kamere). Chýbajúca textúra → obdĺžniky z tokenov (`--crane-frame` / `--crane-boom`).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { CargoSprite, type CargoSpriteDeps } from './cargo-sprite';
import { containerKey } from './container-sprites';
import { MANIFEST_CELL_PX, machineSprite, manifestScale, type MachineSpriteEntry, type StsPart } from './entity-assets';
import type { ContainerVM, MachineVM } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Zväčšenie kontajnera pri plnom zdvihu (`hoist` 1): naznačuje výšku nad blokom. */
export const MACHINE_HOIST_SCALE = 0.12;

/** Uhol kontajnera, aby ležal dlhšou stranou pozdĺž osi Y rámu. */
const CARGO_ALONG_Y_DEG = 90;

/** Fallback rozmer RTG bez záznamu v manifeste (bunky). */
const FALLBACK_FOOTPRINT = { w: 5, h: 2 };

/** Súradnica x stredu vozíka v súradniciach rámu (px zdroja) pre `trolley` 0..1. */
export function rtgTrolleyFrameX(trolley: number, travel: { readonly yMin: number; readonly yMax: number }): number {
  return travel.yMin + Math.min(1, Math.max(0, trolley)) * (travel.yMax - travel.yMin);
}

/** Mierka kontajnera pre `hoist` 0..1. */
export function rtgHoistScale(hoist: number): number {
  return 1 + Math.min(1, Math.max(0, hoist)) * MACHINE_HOIST_SCALE;
}

export class MachineView {
  /** Koreň: počiatok = stred rámu vo svete (px). */
  readonly view: Container;
  readonly id: number;
  private last: MachineVM;
  private readonly entry: MachineSpriteEntry | undefined;
  private readonly scale: number;
  private readonly cargoGroup = new Container({ label: 'rtg-cargo' });
  private readonly trolleyGroup = new Container({ label: 'rtg-trolley' });
  private cargo: { readonly key: string; readonly sprite: CargoSprite } | null = null;

  constructor(
    vm: MachineVM,
    private readonly deps: CargoSpriteDeps,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.entry = machineSprite(vm.defId);
    this.scale = manifestScale(deps.cellPx);
    this.view = new Container({ label: `machine-${String(vm.id)}` });
    this.build();
    this.update(vm);
  }

  get vm(): MachineVM {
    return this.last;
  }

  /** Poloha vozíka v px sveta od stredu rámu po osi X (testy). */
  get trolleyOffsetX(): number {
    return this.trolleyGroup.x;
  }

  /** Kontajner pod vozíkom (testy). */
  get heldCargo(): CargoSprite | null {
    return this.cargo?.sprite ?? null;
  }

  /** Rám je nakreslený spritom z manifestu (nie fallbackom) — testy. */
  get textured(): boolean {
    return this.entry !== undefined && this.deps.textures?.file(this.entry.frame.file) !== undefined;
  }

  update(vm: MachineVM): void {
    this.last = vm;
    const { cellPx } = this.deps;
    this.view.position.set(vm.x * cellPx, vm.y * cellPx);
    const travel = this.entry?.travelX ?? { yMin: 32, yMax: 288 };
    // x vozíka od pivotu rámu (RTG: pivot = stred rámu; RMG 6 × 2: pivot x 160, konzola vpravo)
    const pivotX = this.entry?.frame.pivot.x ?? (FALLBACK_FOOTPRINT.w * MANIFEST_CELL_PX) / 2;
    const x = (rtgTrolleyFrameX(vm.trolley, travel) - pivotX) * this.scale;
    this.trolleyGroup.x = x;
    this.cargoGroup.x = x;
    this.syncCargo(vm.cargo);
    this.cargoGroup.scale.set(rtgHoistScale(vm.hoist));
  }

  destroy(): void {
    this.cargo = null;
    this.view.destroy({ children: true });
  }

  private syncCargo(container: ContainerVM | null): void {
    const key = containerKey(container);
    if ((this.cargo?.key ?? '') === key) return;
    this.cargo?.sprite.destroy({ children: true });
    this.cargo = null;
    if (container === null) return;
    const { cellPx, palette, textures } = this.deps;
    const sprite = new CargoSprite(this.id, 'container_teu', { cellPx, palette, textures }, { container });
    sprite.angle = CARGO_ALONG_Y_DEG;
    this.cargoGroup.addChild(sprite);
    this.cargo = { key, sprite };
  }

  private build(): void {
    const { entry } = this;
    this.view.addChild(this.display(entry?.frame, FALLBACK_FOOTPRINT, 'frame'));
    this.view.addChild(this.cargoGroup);
    this.trolleyGroup.addChild(this.display(entry?.trolley, { w: 1, h: 1 }, 'boom'));
    this.view.addChild(this.trolleyGroup);
  }

  /** Sprite časti zakotvený na pivote (alebo stred pri fallbacku) alebo obdĺžnik z tokenov. */
  private display(part: StsPart | undefined, footprint: { readonly w: number; readonly h: number }, fallback: 'frame' | 'boom'): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const size = part?.footprint ?? footprint;
    const width = size.w * cellPx;
    const height = size.h * cellPx;
    const x = -(part?.pivot.x ?? (size.w * MANIFEST_CELL_PX) / 2) * this.scale;
    const y = -(part?.pivot.y ?? (size.h * MANIFEST_CELL_PX) / 2) * this.scale;
    const texture = part === undefined ? undefined : textures?.file(part.file);
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
}
