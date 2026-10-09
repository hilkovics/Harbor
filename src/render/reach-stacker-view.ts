/**
 * ReachStackerView (R5, TR5-03): mobilný stroj `MachineVM` s `defId` `reach_stacker` — telo (`entities.reach_stacker.file`, 1 × 2, predkom hore), teleskopický
 * výložník (`parts.boom`) a spreader (`parts.spreader_20` / `spreader_40` podľa veľkosti kontajnera), kontajner visí na špičke výložníka.
 *
 * Geometria (px zdrojového SVG, počiatok kontajnera = stred tela): pivot výložníka sedí v `boom.mountOnBase` na tele; `boom` 0..1 posúva výložník dopredu
 * (hore) o `boom × (travel.yMax - travel.yMin)`; pivot spreadera sa kladie do hlavy výložníka (`spreader.mountOnBase` v súboroch výložníka). Kontajner je
 * na pivote spreadera, dlhšou stranou naprieč osou výložníka (os x stroja). Poradie: telo → výložník → kontajner → spreader. `angle` otáča celý stroj.
 * Chýbajúca textúra → obdĺžniky z tokenov (`--crane-frame` telo, `--crane-boom` výložník).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { CargoSprite, type CargoSpriteDeps } from './cargo-sprite';
import { containerKey } from './container-sprites';
import { MANIFEST_CELL_PX, manifestScale, reachStackerSprite, type ReachStackerEntry } from './entity-assets';
import type { ContainerVM, MachineVM } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Fallback rozmer bez záznamu v manifeste (bunky). */
const FALLBACK_FOOTPRINT = { w: 1, h: 2 };

/** Posun špičky výložníka dopredu v px zdroja pre `boom` 0..1 (orezané). */
export function reachBoomExtension(boom: number, travel: { readonly yMin: number; readonly yMax: number }): number {
  return Math.min(1, Math.max(0, boom)) * (travel.yMax - travel.yMin);
}

export class ReachStackerView {
  /** Koreň: počiatok = stred tela vo svete (px), otočený o `MachineVM.angle`. */
  readonly view: Container;
  readonly id: number;
  private last: MachineVM;
  private readonly entry: ReachStackerEntry | undefined;
  private readonly scale: number;
  private readonly boomGroup = new Container({ label: 'reach-boom' });
  private readonly cargoGroup = new Container({ label: 'reach-cargo' });
  private readonly spreaderGroup = new Container({ label: 'reach-spreader' });
  private cargo: { readonly key: string; readonly sprite: CargoSprite } | null = null;
  private spreaderSize: 20 | 40 | null = null;

  constructor(
    vm: MachineVM,
    private readonly deps: CargoSpriteDeps,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.entry = reachStackerSprite();
    this.scale = manifestScale(deps.cellPx);
    this.view = new Container({ label: `machine-${String(vm.id)}` });
    const bodyFootprint = this.entry?.footprint ?? FALLBACK_FOOTPRINT;
    this.view.addChild(this.part(this.entry?.file, bodyFootprint, { x: (bodyFootprint.w * MANIFEST_CELL_PX) / 2, y: (bodyFootprint.h * MANIFEST_CELL_PX) / 2 }, 'frame'));
    this.view.addChild(this.boomGroup, this.cargoGroup, this.spreaderGroup);
    const boom = this.entry?.boom;
    if (boom !== undefined) this.boomGroup.addChild(this.part(boom.file, boom.footprint, boom.pivot, 'boom'));
    this.update(vm);
  }

  get vm(): MachineVM {
    return this.last;
  }

  /** Kontajner na špičke výložníka (testy). */
  get heldCargo(): CargoSprite | null {
    return this.cargo?.sprite ?? null;
  }

  /** Veľkosť nakresleného spreadera (testy). */
  get spreader(): 20 | 40 | null {
    return this.spreaderSize;
  }

  /** Poloha špičky výložníka (pivot spreadera) vo svete od stredu tela, px (testy). */
  get headOffset(): { readonly x: number; readonly y: number } {
    return { x: this.spreaderGroup.x, y: this.spreaderGroup.y };
  }

  update(vm: MachineVM): void {
    this.last = vm;
    const { cellPx } = this.deps;
    const { entry, scale } = this;
    this.view.position.set(vm.x * cellPx, vm.y * cellPx);
    this.view.angle = vm.angle ?? 0;
    const body = entry?.footprint ?? FALLBACK_FOOTPRINT;
    const centre = { x: (body.w * MANIFEST_CELL_PX) / 2, y: (body.h * MANIFEST_CELL_PX) / 2 };
    const mount = entry?.boom.mount ?? { x: centre.x, y: centre.y };
    const extension = entry === undefined ? 0 : reachBoomExtension(vm.boom ?? 0, entry.boom.travel);
    // pivot výložníka sedí v mount; výložník sa posúva dopredu (hore, −y) o extension
    this.boomGroup.position.set((mount.x - centre.x) * scale, (mount.y - centre.y - extension) * scale);
    const boom = entry?.boom;
    const head = boom === undefined ? { x: 0, y: 0 } : { x: boom.pivot.x, y: boom.pivot.y };
    const headLocal = { x: this.boomGroup.x, y: this.boomGroup.y };
    // špička výložníka: hlava (`spreader.mountOnBase`, v súboroch výložníka) relatívne k pivotu výložníka
    const size: 20 | 40 = vm.cargo?.sizeFt === 40 ? 40 : 20;
    const spreader = size === 40 ? entry?.spreader40 : entry?.spreader20;
    const tip = spreader === undefined ? head : spreader.head;
    const tipX = headLocal.x + (tip.x - head.x) * scale;
    const tipY = headLocal.y + (tip.y - head.y) * scale;
    this.spreaderGroup.position.set(tipX, tipY);
    this.cargoGroup.position.set(tipX, tipY);
    this.syncSpreader(size, spreader);
    this.syncCargo(vm.cargo);
  }

  destroy(): void {
    this.cargo = null;
    this.view.destroy({ children: true });
  }

  private syncSpreader(size: 20 | 40, spreader: ReachStackerEntry['spreader20'] | undefined): void {
    if (this.spreaderSize === size) return;
    this.spreaderSize = size;
    this.spreaderGroup.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    const footprint = spreader?.footprint ?? { w: size / 20, h: 1 };
    const pivot = spreader?.pivot ?? { x: (footprint.w * MANIFEST_CELL_PX) / 2, y: (footprint.h * MANIFEST_CELL_PX) / 2 };
    this.spreaderGroup.addChild(this.part(spreader?.file, footprint, pivot, 'boom'));
  }

  private syncCargo(container: ContainerVM | null): void {
    const key = containerKey(container);
    if ((this.cargo?.key ?? '') === key) return;
    this.cargo?.sprite.destroy({ children: true });
    this.cargo = null;
    if (container === null) return;
    const { cellPx, palette, textures } = this.deps;
    const sprite = new CargoSprite(this.id, 'container_teu', { cellPx, palette, textures }, { container });
    this.cargoGroup.addChild(sprite);
    this.cargo = { key, sprite };
  }

  /** Sprite časti zakotvený na pivote (počiatok skupiny = pivot) alebo obdĺžnik z tokenov. */
  private part(file: string | undefined, footprint: { readonly w: number; readonly h: number }, pivot: { readonly x: number; readonly y: number }, fallback: 'frame' | 'boom'): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const width = footprint.w * cellPx;
    const height = footprint.h * cellPx;
    const x = -pivot.x * this.scale;
    const y = -pivot.y * this.scale;
    const texture = file === undefined ? undefined : textures?.file(file);
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.position.set(x, y);
      sprite.setSize(width, height);
      return sprite;
    }
    const color = fallback === 'boom' ? palette.crane.boom : palette.crane.frame;
    return new Graphics()
      .rect(x, y, width, height)
      .fill({ color: color.color, alpha: color.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: palette.module.outline.color, alpha: palette.module.outline.alpha, alignment: 1 });
  }
}
