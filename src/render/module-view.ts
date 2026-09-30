/**
 * ModuleView (ARCHITECTURE §15.1, DESIGN_BRIEF §5.3, §5.4): jeden modul na mape — sprite `sprites.<defId>.file`
 * z manifestu (sklad: `states.fill00…fill100` podľa zaplnenia, viď `storage-fill.ts`), otočený o `rotation` okolo
 * stredu footprintu, (berth) náklad na obsadených apron slotoch a odznak `overlay.warning_badge`, keď modul nie je
 * pripojený k ceste (`connected === false`).
 *
 * Kontajner views má počiatok v strede footprintu a je otočený; vnútri sú súradnice rot 0 (viď `footprint-pose.ts`),
 * takže sprite aj apron sloty z manifestu (bunky pri rot 0) sa rotujú spolu s modulom bez ďalšieho počítania.
 * Odznak je v strede footprintu a je proti rotácii modulu vyrovnaný, takže ostáva vzpriamený.
 * Modul bez sprite (chýba v manifeste / textúra sa nenačítala) sa nakreslí ako obdĺžnik z tokenov
 * (`--module-base` s obrysom `--module-outline`).
 *
 * Moduly s vlastnou dynamickou grafikou (brána, čakacia plocha, rampa) kreslia `ModuleDecor`y (`module-decors.ts`): view ich
 * vytvorí lenivo podľa voliteľných polí `ModuleVM` (`gate`, `waitingArea`, `ramp`). Ozdoba, ktorá hlási problém (neprevádzková
 * rampa), zapne ten istý odznak `overlay.warning_badge` ako „nepripojené“.
 *
 * Views sa nealokujú pre nezmenený stav: `update` prekreslí náklad len pri zmene obsadenia slotov, telo skladu len pri
 * zmene fill stavu a odznak sa vytvorí lazy, prvýkrát keď je potrebný (potom sa iba skrýva / ukazuje).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { createWarningBadge } from './badges';
import { moduleSprite, type ModuleSpriteEntry } from './entity-assets';
import { footprintPose, localCellCenter, type FootprintPose } from './footprint-pose';
import { CargoSprite } from './cargo-sprite';
import type { ModuleDecor, ModuleViewDeps } from './module-decor';
import { MODULE_DECORS } from './module-decors';
import { fillState, fillStateKey, type FillState } from './storage-fill';
import type { ModuleVM } from './view-models';

export type { ModuleViewDeps } from './module-decor';

/** Hrúbka obrysu fallbacku ako zlomok bunky (2 px pri 64 px, DESIGN_BRIEF §4 „Obrys“). */
const OUTLINE_CELLS = 2 / 64;

/** Odsadenie fallbacku od okraja footprintu (zlomok bunky; „hrany min. 4 px od okraja“, DESIGN_BRIEF §4). */
const FALLBACK_INSET_CELLS = 4 / 64;

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo). */
export function sameModuleShape(a: ModuleVM, b: ModuleVM): boolean {
  return a.defId === b.defId && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation;
}

/**
 * Stav zaplnenia, podľa ktorého sa vyberá sprite: `null` pre modul bez `states` v manifeste (jediný sprite `file`);
 * sklad bez `storage` vo VM ukáže prázdny dvor.
 */
export function moduleFillState(entry: ModuleSpriteEntry | undefined, vm: ModuleVM): FillState | null {
  if (entry?.states === undefined) return null;
  return vm.storage === undefined ? 0 : fillState(vm.storage.stored, vm.storage.capacity);
}

/**
 * Súbor tela modulu (relatívne k `assets/`): sprite pre stav zaplnenia skladu (`states.fillNN`), inak jediný `file`.
 * `undefined`, ak modul nemá v manifeste ani jedno.
 */
export function moduleBodyFile(entry: ModuleSpriteEntry | undefined, fill: FillState | null): string | undefined {
  if (entry === undefined) return undefined;
  if (fill !== null && entry.states !== undefined) return entry.states[fillStateKey(fill)];
  return entry.file;
}

export class ModuleView {
  /** Koreň view: počiatok = stred footprintu vo svete (px), otočený o `rotation`. */
  readonly view: Container;
  readonly id: number;
  /** Posledný synchronizovaný VM (vrstva porovnáva jeho statickú časť s novým VM). */
  private last: ModuleVM;
  private readonly pose: FootprintPose;
  private readonly sprite: ModuleSpriteEntry | undefined;
  /** Telo modulu (sprite alebo `Graphics` fallback); je vždy prvým dieťaťom `view`. */
  private body: Sprite | Graphics;
  /** Stav zaplnenia nakresleného tela (`null` = modul bez stavov). */
  private bodyFill: FillState | null;
  /** Odznak „nepripojené“; vznikne až pri prvom `connected === false`. */
  private badge: Container | null = null;
  private badgeScale = 1;
  private readonly cargoLayer = new Container({ label: 'apron-cargo' });
  /** Ozdoby modulu (brána, čakacia plocha, rampa) podľa kľúča továrne; vznikajú lenivo. */
  private readonly decorLayer = new Container({ label: 'module-decors' });
  private readonly decors = new Map<string, ModuleDecor>();
  /** Náklad na aprone podľa indexu slotu. */
  private readonly cargo = new Map<number, CargoSprite>();
  /** Pracovná množina slotov videných v poslednom `update` (znovupoužitá, aby sa nealokovalo). */
  private readonly seenSlots = new Set<number>();

  constructor(
    vm: ModuleVM,
    private readonly deps: ModuleViewDeps,
  ) {
    const { cellPx } = deps;
    this.id = vm.id;
    this.last = vm;
    this.sprite = moduleSprite(vm.defId);
    this.pose = footprintPose(vm, cellPx);
    this.view = new Container({ label: `module-${String(vm.id)}` });
    this.view.position.set(this.pose.cx, this.pose.cy);
    this.view.angle = this.pose.angle;
    this.bodyFill = moduleFillState(this.sprite, vm);
    this.body = this.createBody(moduleBodyFile(this.sprite, this.bodyFill));
    this.view.addChild(this.body, this.cargoLayer, this.decorLayer);
    this.update(vm);
  }

  /** Stav zaplnenia nakresleného tela (`null` = modul bez stavov) — pre testy. */
  get fill(): FillState | null {
    return this.bodyFill;
  }

  /** Odznak „nepripojené“ (`null`, kým nebol potrebný) — pre testy. */
  get badgeView(): Container | null {
    return this.badge;
  }

  /** Odznak „nepripojené“ / „neprevádzkové“ je viditeľný. */
  get badgeVisible(): boolean {
    return this.badge?.visible === true;
  }

  /** Ozdoba modulu s kľúčom `id` (`gate`, `waiting_area`, `ramp`), alebo `undefined` — pre testy. */
  decor<T extends ModuleDecor>(id: string): T | undefined {
    return this.decors.get(id) as T | undefined;
  }

  /** Nastaví veľkosť odznakov podľa zoomu kamery (`badgeScaleForZoom`); platí aj pre odznaky, ktoré ešte nevznikli. */
  setBadgeScale(scale: number): void {
    this.badgeScale = scale;
    this.badge?.scale.set(scale);
    this.decors.forEach((decor) => {
      decor.setBadgeScale?.(scale);
    });
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

  /**
   * Synchronizuje telo (fill stav), ozdoby, odznak a náklad na aprone s VM (statická časť VM sa tu nemení — to rieši vrstva).
   * Pre nezmenený stav nič nealokuje.
   */
  update(vm: ModuleVM): void {
    this.last = vm;
    this.syncBody(vm);
    this.syncDecors(vm);
    this.syncBadge(vm);
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
    this.decors.clear();
    this.badge = null;
    this.view.destroy({ children: true });
  }

  /** Prepne telo skladu na sprite zodpovedajúci aktuálnemu zaplneniu (iba pri zmene fill stavu). */
  private syncBody(vm: ModuleVM): void {
    const fill = moduleFillState(this.sprite, vm);
    if (fill === this.bodyFill) return;
    this.bodyFill = fill;
    const file = moduleBodyFile(this.sprite, fill);
    const texture = file !== undefined ? this.deps.textures?.file(file) : undefined;
    if (texture !== undefined && this.body instanceof Sprite) {
      this.body.texture = texture; // rovnaká veľkosť a poloha, mení sa len obsah
      return;
    }
    this.body.destroy();
    this.body = this.createBody(file);
    this.view.addChildAt(this.body, 0); // pod náklad na aprone
  }

  /** Vytvorí ozdoby, ktorých dáta VM nesie (lenivo), a všetkým podá VM. */
  private syncDecors(vm: ModuleVM): void {
    for (const factory of MODULE_DECORS) {
      let decor = this.decors.get(factory.id);
      if (decor === undefined) {
        if (!factory.applies(vm)) continue;
        decor = factory.create(vm, { deps: this.deps, pose: this.pose, entry: this.sprite });
        decor.setBadgeScale?.(this.badgeScale);
        this.decors.set(factory.id, decor);
        this.decorLayer.addChild(decor.view);
      }
      decor.update(vm);
    }
  }

  /** Ukáže / skryje odznak „nepripojené“ (`vm.connected === false`) alebo problém ozdoby (vytvorí ho lazy). */
  private syncBadge(vm: ModuleVM): void {
    let flagged = vm.connected === false;
    this.decors.forEach((decor) => {
      flagged ||= decor.warning === true;
    });
    if (flagged) {
      this.badge ??= this.createBadge();
      this.badge.visible = true;
    } else if (this.badge !== null) {
      this.badge.visible = false;
    }
  }

  /**
   * Odznak v strede footprintu: kontajner (jeho `scale` nesie zoom, `angle` vyrovnáva rotáciu modulu) so spritom
   * `overlay.warning_badge` alebo kruhom z `--module-disconnected`.
   */
  private createBadge(): Container {
    const badge = createWarningBadge(this.deps, -this.pose.angle, this.badgeScale);
    this.view.addChild(badge); // navrchu: nad telom, nákladom aj ozdobami
    return badge;
  }

  /** Sprite modulu (rot 0, ľavý horný roh v strede − polovica footprintu), alebo `Graphics` fallback. */
  private createBody(file: string | undefined): Sprite | Graphics {
    const { cellPx, textures, palette } = this.deps;
    const width = this.pose.baseW * cellPx;
    const height = this.pose.baseH * cellPx;
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
