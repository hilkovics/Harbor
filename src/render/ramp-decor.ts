/**
 * Ozdoba nakladacej rampy (`ModuleVM.ramp`, DESIGN_BRIEF §5.5): kontajnery pripravené na doku (staging) a hlásenie
 * neprevádzkovej rampy. Doky sú obdĺžniky `sprites.<defId>.docks` z manifestu (px súboru pri rot 0); `staged[i]` patrí
 * doku `docks[i]`. Kontajner (`cargo.<typ kategórie>`) sa zmenší na šírku doku a skladá sa od vzdialeného konca doku
 * (od kamiónu, ktorý sa pristavuje z konektora) — pri viac kusoch, než sa zmestí, sa prekrývajú.
 *
 * Neprevádzková rampa (`operational === false`) nekreslí vlastný odznak: `warning` vyžiada spoločný odznak
 * `overlay.warning_badge` v `ModuleView`.
 */
import { Container } from 'pixi.js';
import { CargoSprite } from './cargo-sprite';
import {
  MANIFEST_CELL_PX,
  cargoSpriteEntry,
  cargoTypeOfCategory,
  manifestScale,
  type ManifestPoint,
  type ManifestRect,
} from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';

/** Odsadenie kontajnera od okraja doku v px súboru (obrys 2 px, DESIGN_BRIEF §4). */
export const STAGED_INSET_PX = 2;

/** Poloha a mierka jedného pripraveného kontajnera. */
export interface StagedPlacement {
  /** Stred kontajnera v px súboru (relatívne k ľavému hornému rohu footprintu modulu). */
  readonly x: number;
  readonly y: number;
  /** Mierka sprite oproti rozmeru v manifeste (`cargo.<typ>.size`). */
  readonly scale: number;
}

/**
 * Rozloženie `count` kontajnerov (rozmer `cargo` v px súboru) na doku `dock`: na šírku doku bez okrajov, jeden pod druhým
 * od horného (vzdialeného) okraja. Ak sa nezmestia, krok sa zmenší (kontajnery sa prekrývajú), ale posledný ostane v doku.
 */
export function stagedPlacements(dock: ManifestRect, count: number, cargo: { readonly w: number; readonly h: number }): StagedPlacement[] {
  if (count <= 0) return [];
  const scale = (dock.w - 2 * STAGED_INSET_PX) / cargo.w;
  const height = cargo.h * scale;
  const room = dock.h - 2 * STAGED_INSET_PX;
  const step = count > 1 ? Math.min(height, (room - height) / (count - 1)) : height;
  const x = dock.x + dock.w / 2;
  const top = dock.y + STAGED_INSET_PX;
  return Array.from({ length: count }, (_, index) => ({ x, y: top + height / 2 + index * step, scale }));
}

export class RampDecor implements ModuleDecor {
  readonly view = new Container({ label: 'ramp-decor' });
  private readonly docks: readonly ManifestRect[];
  private readonly cargoType: string;
  /** Kontajnery na každom doku (index doku). */
  private readonly sprites: CargoSprite[][];
  private isWarning = false;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.docks = context.entry?.docks ?? [];
    this.cargoType = cargoTypeOfCategory(context.entry?.category);
    this.sprites = this.docks.map(() => []);
    this.update(vm);
  }

  /** Neprevádzková rampa žiada odznak upozornenia. */
  get warning(): boolean {
    return this.isWarning;
  }

  /** Počet nakreslených kontajnerov na doku `dock` — pre testy. */
  stagedDrawn(dock: number): number {
    return this.sprites[dock]?.length ?? 0;
  }

  /** Nakreslený kontajner `slot` na doku `dock` — pre testy. */
  stagedSprite(dock: number, slot: number): CargoSprite | undefined {
    return this.sprites[dock]?.[slot];
  }

  update(vm: ModuleVM): void {
    const ramp = vm.ramp;
    this.isWarning = ramp !== undefined && !ramp.operational;
    this.docks.forEach((dock, index) => {
      this.syncDock(dock, index, ramp?.staged[index] ?? 0);
    });
  }

  destroy(): void {
    this.sprites.length = 0;
    this.view.destroy({ children: true });
  }

  /** Prekreslí kontajnery doku len pri zmene počtu. */
  private syncDock(dock: ManifestRect, index: number, staged: number): void {
    const drawn = this.sprites[index];
    const count = Math.max(0, Math.floor(staged));
    if (drawn.length === count) return;
    for (const sprite of drawn) sprite.destroy();
    drawn.length = 0;
    const { deps, pose } = this.context;
    const entry = cargoSpriteEntry(this.cargoType);
    const size = entry?.size ?? { w: MANIFEST_CELL_PX, h: MANIFEST_CELL_PX / 2 };
    const unit = manifestScale(deps.cellPx);
    const origin: ManifestPoint = { x: (-pose.baseW * deps.cellPx) / 2, y: (-pose.baseH * deps.cellPx) / 2 };
    stagedPlacements(dock, count, size).forEach((placement, slot) => {
      const sprite = new CargoSprite(slot, this.cargoType, deps);
      sprite.position.set(origin.x + placement.x * unit, origin.y + placement.y * unit);
      sprite.scale.set(placement.scale);
      this.view.addChild(sprite);
      drawn.push(sprite);
    });
  }
}

export const rampDecorFactory: ModuleDecorFactory = {
  id: 'ramp',
  applies: (vm) => vm.ramp !== undefined,
  create: (vm, context) => new RampDecor(vm, context),
};
