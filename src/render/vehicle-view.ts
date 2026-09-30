/**
 * VehicleView (DESIGN_BRIEF §5.6): vozidlo na cestách — sprite `entities.<defId>.states.{empty|loaded}` z manifestu,
 * predok hore pri `heading` 0, otočený okolo stredu bunky.
 *
 * Poloha je `lerp(prev, curr, alpha)` v bunkách × `--cell` (stred vozidla; stred bunky = `x + 0,5`). `loaded` platí,
 * kým vozidlo vezie jednotku nákladu (kontajner medzi nohami je súčasť spritu). Vozidlo bez sprite (def chýba
 * v manifeste / textúra nie je načítaná) sa nakreslí ako telo z tokenov `--vehicle-body` s obrysom `--vehicle-dark`
 * a tmavým pruhom na predku, aby bol vidieť smer jazdy.
 */
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { vehicleSprite, type CellSize } from './entity-assets';
import { lerp } from './ship-view';
import type { EntityTextures } from './sprite-atlas';
import type { EntityPalette } from './tokens';
import type { VehicleVM } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie fallbacku od okraja bunky (zlomok bunky; „hrany min. 4 px od okraja“, DESIGN_BRIEF §4). */
const FALLBACK_INSET_CELLS = 4 / 64;

/** Rozmer fallbacku vozidla bez záznamu v manifeste (bunky). */
const FALLBACK_FOOTPRINT: CellSize = { w: 1, h: 1 };

/** Výška tmavého pruhu na predku fallbacku ako podiel dĺžky vozidla. */
const FALLBACK_FRONT_STRIPE = 0.2;

export type VehicleLoad = 'empty' | 'loaded';

/** Stav sprite podľa toho, či vozidlo vezie náklad. */
export function vehicleLoad(loaded: boolean): VehicleLoad {
  return loaded ? 'loaded' : 'empty';
}

/** Súbor sprite vozidla (relatívne k `assets/`), alebo `undefined`, ak def nie je vozidlo v manifeste. */
export function vehicleSpriteFile(defId: string, loaded: boolean): string | undefined {
  return vehicleSprite(defId)?.states[vehicleLoad(loaded)];
}

export interface VehiclePose {
  /** Stred vozidla vo svete (px). */
  readonly x: number;
  readonly y: number;
  /** Uhol v stupňoch v smere hodinových ručičiek (0 = predok na sever). */
  readonly angle: number;
}

/** Poloha vozidla v čase `alpha` medzi predchádzajúcim a aktuálnym tickom, v px sveta. */
export function vehiclePose(vm: VehicleVM, alpha: number, cellPx: number): VehiclePose {
  return { x: lerp(vm.prevX, vm.x, alpha) * cellPx, y: lerp(vm.prevY, vm.y, alpha) * cellPx, angle: vm.heading };
}

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo): poloha a kurz sa menia každý tick, def nie. */
export function sameVehicleShape(a: VehicleVM, b: VehicleVM): boolean {
  return a.defId === b.defId;
}

export interface VehicleViewDeps {
  /** Veľkosť bunky v px pri zoome 1 (`--cell`). */
  readonly cellPx: number;
  readonly palette: EntityPalette;
  /** Textúry entít; `null` = vždy fallback `Graphics`. */
  readonly textures: EntityTextures | null;
}

export class VehicleView {
  /** Koreň view: počiatok = stred vozidla vo svete (px), otočený o `heading`. */
  readonly view: Container;
  readonly id: number;
  private last: VehicleVM;
  /** Sprite vozidla (`null` pri fallbacku). */
  private readonly sprite: Sprite | null;
  private readonly textures: { readonly empty: Texture; readonly loaded: Texture } | null;
  private load: VehicleLoad;

  constructor(
    vm: VehicleVM,
    private readonly deps: VehicleViewDeps,
    alpha = 1,
  ) {
    this.id = vm.id;
    this.last = vm;
    this.view = new Container({ label: `vehicle-${String(vm.id)}` });
    this.load = vehicleLoad(vm.loaded);
    this.textures = this.resolveTextures(vm.defId);
    const entry = vehicleSprite(vm.defId);
    if (this.textures !== null && entry !== undefined) {
      this.sprite = new Sprite(this.textures[this.load]);
      this.sprite.anchor.set(0.5);
      this.sprite.setSize(entry.footprint.w * deps.cellPx, entry.footprint.h * deps.cellPx);
      this.view.addChild(this.sprite);
    } else {
      this.sprite = null;
      this.view.addChild(this.createFallback());
    }
    this.update(vm, alpha);
  }

  get vm(): VehicleVM {
    return this.last;
  }

  /** Aktuálna textúra sprite (`null` pri fallbacku) — pre testy. */
  get texture(): Texture | null {
    return this.sprite?.texture ?? null;
  }

  /** Nastaví polohu (interpolovanú), kurz a stav naloženia. Pre nezmenený stav nič nealokuje. */
  update(vm: VehicleVM, alpha: number): void {
    this.last = vm;
    const pose = vehiclePose(vm, alpha, this.deps.cellPx);
    if (this.view.x !== pose.x || this.view.y !== pose.y) this.view.position.set(pose.x, pose.y);
    if (this.view.angle !== pose.angle) this.view.angle = pose.angle;
    const load = vehicleLoad(vm.loaded);
    if (load !== this.load) {
      this.load = load;
      if (this.sprite !== null && this.textures !== null) this.sprite.texture = this.textures[load];
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /** Textúry `empty` / `loaded` pre vozidlo, alebo `null` (fallback). */
  private resolveTextures(defId: string): { readonly empty: Texture; readonly loaded: Texture } | null {
    const entry = vehicleSprite(defId);
    if (entry === undefined) return null;
    const empty = this.deps.textures?.file(entry.states.empty);
    const loaded = this.deps.textures?.file(entry.states.loaded);
    if (empty === undefined || loaded === undefined) return null;
    return { empty, loaded };
  }

  /** Telo z tokenov s tmavým pruhom na predku (hore); rozmer 1 bunka bez odsadenia od okraja. */
  private createFallback(): Graphics {
    const { cellPx, palette } = this.deps;
    const width = FALLBACK_FOOTPRINT.w * cellPx;
    const height = FALLBACK_FOOTPRINT.h * cellPx;
    const inset = FALLBACK_INSET_CELLS * cellPx;
    const { body, dark } = palette.vehicle;
    const left = -width / 2 + inset;
    const top = -height / 2 + inset;
    const bodyWidth = width - inset * 2;
    const bodyHeight = height - inset * 2;
    const graphics = new Graphics();
    graphics
      .rect(left, top, bodyWidth, bodyHeight)
      .fill({ color: body.color, alpha: body.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: dark.color, alpha: dark.alpha, alignment: 1 });
    graphics.rect(left, top, bodyWidth, bodyHeight * FALLBACK_FRONT_STRIPE).fill({ color: dark.color, alpha: dark.alpha });
    return graphics;
  }
}
