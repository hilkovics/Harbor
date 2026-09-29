/**
 * ModuleView (ARCHITECTURE §15.1, DESIGN_BRIEF §5.3): jeden modul na mape — sprite `sprites.<defId>.file` z manifestu,
 * otočený o `rotation` okolo stredu footprintu, a (berth) náklad na obsadených apron slotoch.
 *
 * Kontajner views má počiatok v strede footprintu a je otočený; vnútri sú súradnice rot 0 (viď `footprint-pose.ts`),
 * takže sprite aj apron sloty z manifestu (bunky pri rot 0) sa rotujú spolu s modulom bez ďalšieho počítania.
 * Modul bez sprite (chýba v manifeste / textúra sa nenačítala) sa nakreslí ako obdĺžnik z tokenov
 * (`--module-base` s obrysom `--module-outline`).
 *
 * Views sa nealokujú pre nezmenený stav: `update` prekreslí náklad len pri zmene obsadenia slotov.
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { moduleSprite, type ModuleSpriteEntry } from './entity-assets';
import { footprintPose, localCellCenter, type FootprintPose } from './footprint-pose';
import { CargoSprite, type CargoSpriteDeps } from './cargo-sprite';
import type { ModuleVM } from './view-models';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie fallbacku od okraja footprintu (zlomok bunky; „hrany min. 4 px od okraja“, DESIGN_BRIEF §4). */
const FALLBACK_INSET_CELLS = 4 / 64;

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo). */
export function sameModuleShape(a: ModuleVM, b: ModuleVM): boolean {
  return a.defId === b.defId && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation;
}

export class ModuleView {
  /** Koreň view: počiatok = stred footprintu vo svete (px), otočený o `rotation`. */
  readonly view: Container;
  readonly id: number;
  /** Posledný synchronizovaný VM (vrstva porovnáva jeho statickú časť s novým VM). */
  private last: ModuleVM;
  private readonly pose: FootprintPose;
  private readonly sprite: ModuleSpriteEntry | undefined;
  private readonly cargoLayer = new Container({ label: 'apron-cargo' });
  /** Náklad na aprone podľa indexu slotu. */
  private readonly cargo = new Map<number, CargoSprite>();
  /** Pracovná množina slotov videných v poslednom `update` (znovupoužitá, aby sa nealokovalo). */
  private readonly seenSlots = new Set<number>();

  constructor(
    vm: ModuleVM,
    private readonly deps: CargoSpriteDeps,
  ) {
    const { cellPx } = deps;
    this.id = vm.id;
    this.last = vm;
    this.sprite = moduleSprite(vm.defId);
    this.pose = footprintPose(vm, cellPx);
    this.view = new Container({ label: `module-${String(vm.id)}` });
    this.view.position.set(this.pose.cx, this.pose.cy);
    this.view.angle = this.pose.angle;
    this.view.addChild(this.createBody(), this.cargoLayer);
    this.update(vm);
  }

  /** Počet nákladu nakresleného na aprone. */
  get cargoCount(): number {
    return this.cargo.size;
  }

  /** Náklad na slote `slot` (`undefined`, ak je prázdny) — pre testy a ladenie. */
  cargoAt(slot: number): CargoSprite | undefined {
    return this.cargo.get(slot);
  }

  /** Posledný synchronizovaný VM. */
  get vm(): ModuleVM {
    return this.last;
  }

  /** Synchronizuje náklad na aprone s `vm.apron` (statická časť VM sa tu nemení — to rieši vrstva). */
  update(vm: ModuleVM): void {
    this.last = vm;
    const slots = this.sprite?.apronSlots ?? [];
    const seen = this.seenSlots;
    seen.clear();
    const units = vm.apron?.units;
    if (units !== undefined) {
      for (const unit of units) {
        const slotCell = slots[unit.slot];
        if (slotCell === undefined) continue; // slot mimo manifestu: nemá kam ísť
        seen.add(unit.slot);
        const current = this.cargo.get(unit.slot);
        if (current?.unitId === unit.unitId && current.typeId === unit.typeId) continue; // nezmenené
        current?.destroy();
        const sprite = new CargoSprite(unit.unitId, unit.typeId, this.deps);
        const at = localCellCenter(slotCell, this.pose.baseW, this.pose.baseH, this.deps.cellPx);
        sprite.position.set(at.x, at.y);
        this.cargo.set(unit.slot, sprite);
        this.cargoLayer.addChild(sprite);
      }
    }
    this.cargo.forEach((sprite, slot) => {
      if (seen.has(slot)) return;
      sprite.destroy();
      this.cargo.delete(slot);
    });
  }

  destroy(): void {
    this.cargo.clear();
    this.view.destroy({ children: true });
  }

  /** Sprite modulu (rot 0, ľavý horný roh v strede − polovica footprintu), alebo `Graphics` fallback. */
  private createBody(): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const width = this.pose.baseW * cellPx;
    const height = this.pose.baseH * cellPx;
    const file = this.sprite?.file;
    const texture = file !== undefined ? textures?.file(file) : undefined;
    if (texture !== undefined) {
      const sprite = new Sprite(texture);
      sprite.position.set(-width / 2, -height / 2);
      sprite.setSize(width, height);
      return sprite;
    }
    const inset = FALLBACK_INSET_CELLS * cellPx;
    const { base, outline } = palette.module;
    const graphics = new Graphics();
    graphics
      .rect(-width / 2 + inset, -height / 2 + inset, width - inset * 2, height - inset * 2)
      .fill({ color: base.color, alpha: base.alpha })
      .stroke({ width: OUTLINE_CELLS * cellPx, color: outline.color, alpha: outline.alpha, alignment: 1 });
    return graphics;
  }
}
