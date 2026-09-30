/**
 * ModuleLayer (ARCHITECTURE §15.1): moduly na mape (`ModuleView` podľa `id`), nad cestami a portálmi.
 *
 * Žeriavy sa tu nekreslia: `CraneLayer` ich skladá z častí (`base`, `boom`, `trolley`) a kreslí nad loďami.
 * Ak `ModuleVM[]` obsahuje aj žeriavy (`kind === 'crane'`), vrstva ich preskočí.
 *
 * Odznaky „nepripojené“ držia čitateľnú veľkosť aj pri malom zoome (`setZoom`, rovnako ako odznaky žeriavov).
 */
import { Container } from 'pixi.js';
import type { CargoSpriteDeps } from './cargo-sprite';
import { badgeScaleForZoom } from './crane-view';
import { ModuleView, sameModuleShape } from './module-view';
import type { ModuleVM } from './view-models';
import { ViewSync } from './view-sync';

/** Druh modulu, ktorý kreslí `CraneLayer`, nie táto vrstva. */
const CRANE_KIND = 'crane';

export class ModuleLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'modules' });
  private readonly views: ViewSync<ModuleVM, ModuleView>;
  private badgeScale = 1;

  constructor(deps: CargoSpriteDeps) {
    this.views = new ViewSync<ModuleVM, ModuleView>({
      accepts: (vm) => vm.kind !== CRANE_KIND,
      create: (vm) => {
        const view = new ModuleView(vm, deps);
        view.setBadgeScale(this.badgeScale);
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: (view, vm) => sameModuleShape(view.vm, vm),
      update: (view, vm) => {
        view.update(vm);
      },
    });
  }

  /** Počet nakreslených modulov. */
  get moduleCount(): number {
    return this.views.size;
  }

  /** View modulu `id` (testy, ladenie). */
  moduleView(id: number): ModuleView | undefined {
    return this.views.get(id);
  }

  /** Zosúladí moduly s VM: vytvorí nové, zruší zmiznuté, zmenenú polohu / rotáciu / def vytvorí nanovo. */
  sync(modules: readonly ModuleVM[]): void {
    this.views.sync(modules);
  }

  /** Prispôsobí veľkosť odznakov zoomu kamery (volá `WorldRenderer.syncCamera`). */
  setZoom(zoom: number): void {
    const next = badgeScaleForZoom(zoom);
    if (next === this.badgeScale) return;
    this.badgeScale = next;
    this.views.forEach((view) => {
      view.setBadgeScale(next);
    });
  }

  destroy(): void {
    this.views.clear();
    this.view.destroy({ children: true });
  }
}
