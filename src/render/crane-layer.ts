/**
 * CraneLayer (ARCHITECTURE §15.1): žeriavy (`CraneView` podľa `id`) nad loďami — výložník sa kreslí nad palubou.
 *
 * Odznak zablokovania drží čitateľnú veľkosť aj pri malom zoome (`setZoom`, rovnako ako obrysy parciel).
 */
import { Container } from 'pixi.js';
import { badgeScaleForZoom, CraneView, type CraneViewDeps } from './crane-view';
import type { CraneVM } from './view-models';
import { ViewSync } from './view-sync';

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo). */
function sameCraneShape(a: CraneVM, b: CraneVM): boolean {
  return a.defId === b.defId && a.x === b.x && a.y === b.y && a.rotation === b.rotation;
}

export class CraneLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'cranes' });
  private readonly cranes: ViewSync<CraneVM, CraneView>;
  private badgeScale: number;

  constructor(deps: CraneViewDeps) {
    this.badgeScale = deps.badgeScale ?? 1;
    this.cranes = new ViewSync<CraneVM, CraneView>({
      create: (vm) => {
        const view = new CraneView(vm, { ...deps, badgeScale: this.badgeScale });
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: (view, vm) => sameCraneShape(view.vm, vm),
      update: (view, vm) => {
        view.update(vm);
      },
    });
  }

  /** Počet nakreslených žeriavov. */
  get craneCount(): number {
    return this.cranes.size;
  }

  /** View žeriava `id` (testy, ladenie). */
  craneView(id: number): CraneView | undefined {
    return this.cranes.get(id);
  }

  /** Zosúladí žeriavy s VM: vytvorí nové, zruší zmiznuté, zmenenú polohu / rotáciu / def vytvorí nanovo. */
  sync(cranes: readonly CraneVM[]): void {
    this.cranes.sync(cranes);
  }

  /** Prispôsobí veľkosť odznakov zoomu kamery (volá `WorldRenderer.syncCamera`). */
  setZoom(zoom: number): void {
    const next = badgeScaleForZoom(zoom);
    if (next === this.badgeScale) return;
    this.badgeScale = next;
    this.cranes.forEach((view) => {
      view.setBadgeScale(next);
    });
  }

  destroy(): void {
    this.cranes.clear();
    this.view.destroy({ children: true });
  }
}
