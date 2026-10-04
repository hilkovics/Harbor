/**
 * Ozdoba nakladacej rampy (`ModuleVM.ramp`, DESIGN_BRIEF §5.5): kontajnery pripravené na doku (staging) a hlásenie
 * neprevádzkovej rampy. Doky sú obdĺžniky `sprites.<defId>.docks` z manifestu (px súboru pri rot 0); `staged[i]` patrí
 * doku `docks[i]`. Kontajner (`cargo.<typ kategórie>`) má v doku **rovnakú veľkosť ako všade inde** (TEU 64 × 26 px,
 * `world-scale.ts`) a leží dlhšou stranou pozdĺž doku, teda pozdĺž kamióna, ktorý doň cúva (dok 56 × 62 px: dĺžka
 * kontajnera zaberie dok, dva kusy sa zmestia vedľa seba) — pri viac kusoch, než sa zmestí, sa prekrývajú.
 *
 * F6c: `ramp.stagedEmpty[i]` jednotiek doku `i` sú prázdne kontajnery (`direction: 'empty'`) — kreslia sa sivé (`--cargo-empty`) a zaraďujú sa
 * za plné (výdaj prázdneho exportérovi, nakládka prázdnych po plných).
 *
 * Neprevádzková rampa (`operational === false`) nekreslí vlastný odznak: `warning` vyžiada spoločný odznak
 * `overlay.warning_badge` v `ModuleView`.
 */
import { Container } from 'pixi.js';
import { CargoSprite } from './cargo-sprite';
import {
  cargoDisplaySize,
  cargoTypeOfCategory,
  manifestScale,
  type ManifestPoint,
  type ManifestRect,
} from './entity-assets';
import type { ModuleDecor, ModuleDecorContext, ModuleDecorFactory } from './module-decor';
import type { ModuleVM } from './view-models';
import { TEU_PX } from './world-scale';

/** Typ nákladu, ktorý môže byť prázdny kontajner (prázdne sú vždy kontajnery TEU). */
const EMPTY_CARGO_TYPE = 'container_teu';

/** Odsadenie kontajnera od okraja doku v px súboru (obrys 2 px, DESIGN_BRIEF §4). */
export const STAGED_INSET_PX = 2;

/** Natočenie kontajnera v doku (°): dlhšia strana (x v súbore sprite) leží pozdĺž osi doku a kamióna (y modulu). */
export const STAGED_ANGLE = 90;

/** Poloha a natočenie jedného pripraveného kontajnera (v pôvodnej veľkosti, bez škálovania). */
export interface StagedPlacement {
  /** Stred kontajnera v px súboru (relatívne k ľavému hornému rohu footprintu modulu). */
  readonly x: number;
  readonly y: number;
  /** Natočenie sprite v stupňoch (`STAGED_ANGLE`). */
  readonly angle: number;
}

/**
 * Rozloženie `count` kontajnerov (rozmer `cargo` v px súboru, dlhšia strana `w`) na doku `dock`: dlhšou stranou pozdĺž doku,
 * vycentrované na jeho dĺžku, vedľa seba naprieč dokom symetricky okolo jeho stredu. Ak sa nezmestia (viac než
 * `(šírka doku − 2 × okraj) / cargo.h`), krok sa zmenší (kontajnery sa prekrývajú), ale krajné ostanú v doku.
 */
export function stagedPlacements(dock: ManifestRect, count: number, cargo: { readonly w: number; readonly h: number }): StagedPlacement[] {
  if (count <= 0) return [];
  const room = dock.w - 2 * STAGED_INSET_PX;
  const step = count > 1 ? Math.max(0, Math.min(cargo.h, (room - cargo.h) / (count - 1))) : 0;
  const centerX = dock.x + dock.w / 2;
  const centerY = dock.y + dock.h / 2;
  return Array.from({ length: count }, (_, index) => ({ x: centerX + (index - (count - 1) / 2) * step, y: centerY, angle: STAGED_ANGLE }));
}

export class RampDecor implements ModuleDecor {
  readonly view = new Container({ label: 'ramp-decor' });
  private readonly docks: readonly ManifestRect[];
  private readonly cargoType: string;
  /** Kontajnery na každom doku (index doku). */
  private readonly sprites: CargoSprite[][];
  /** Počet prázdnych kontajnerov nakreslených na doku (index doku); zmena prekreslí dok aj pri nezmenenom počte. */
  private readonly drawnEmpty: number[];
  private isWarning = false;

  constructor(
    vm: ModuleVM,
    private readonly context: ModuleDecorContext,
  ) {
    this.docks = context.entry?.docks ?? [];
    this.cargoType = cargoTypeOfCategory(context.entry?.category);
    this.sprites = this.docks.map(() => []);
    this.drawnEmpty = this.docks.map(() => 0);
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

  /** Počet prázdnych (sivých) kontajnerov nakreslených na doku `dock` — pre testy. */
  emptyDrawn(dock: number): number {
    return this.drawnEmpty[dock] ?? 0;
  }

  /** Nakreslený kontajner `slot` na doku `dock` — pre testy. */
  stagedSprite(dock: number, slot: number): CargoSprite | undefined {
    return this.sprites[dock]?.[slot];
  }

  update(vm: ModuleVM): void {
    const ramp = vm.ramp;
    this.isWarning = ramp !== undefined && !ramp.operational;
    this.docks.forEach((dock, index) => {
      this.syncDock(dock, index, ramp?.staged[index] ?? 0, ramp?.stagedEmpty?.[index] ?? 0);
    });
  }

  destroy(): void {
    this.sprites.length = 0;
    this.view.destroy({ children: true });
  }

  /** Prekreslí kontajnery doku len pri zmene počtu (celkového alebo prázdnych). Prázdne len pri kontajnerovej rampe. */
  private syncDock(dock: ManifestRect, index: number, staged: number, stagedEmpty: number): void {
    const drawn = this.sprites[index];
    const count = Math.max(0, Math.floor(staged));
    const empties = this.cargoType === EMPTY_CARGO_TYPE ? Math.min(count, Math.max(0, Math.floor(stagedEmpty))) : 0;
    if (drawn.length === count && this.drawnEmpty[index] === empties) return;
    this.drawnEmpty[index] = empties;
    for (const sprite of drawn) sprite.destroy();
    drawn.length = 0;
    const { deps, pose } = this.context;
    const size = cargoDisplaySize(this.cargoType) ?? TEU_PX;
    const unit = manifestScale(deps.cellPx);
    const origin: ManifestPoint = { x: (-pose.baseW * deps.cellPx) / 2, y: (-pose.baseH * deps.cellPx) / 2 };
    stagedPlacements(dock, count, size).forEach((placement, slot) => {
      const sprite = new CargoSprite(slot, this.cargoType, deps, slot >= count - empties ? { empty: true } : {});
      sprite.position.set(origin.x + placement.x * unit, origin.y + placement.y * unit);
      sprite.angle = placement.angle;
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
