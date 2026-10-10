/**
 * CraneLayer (ARCHITECTURE §15.1): žeriavy (`CraneView` podľa `id`) nad loďami — výložník sa kreslí nad palubou.
 *
 * Dva koreňové kontajnery (F6d, T6D-02): `view` (výložník, vozík, držaný náklad, odznak) nad loďami a vozidlami, `baseView` (základňa) pod
 * nimi — vozidlo stojace pri odovzdaní pod žeriavom je tak vidieť v portáli a nad ním vozík s kontajnerom. `WorldRenderer` ich vkladá
 * na rôzne miesta poradia vrstiev.
 *
 * Odznak zablokovania drží čitateľnú veľkosť aj pri malom zoome (`setZoom`, rovnako ako obrysy parciel).
 */
import { Container } from 'pixi.js';
import { badgeScaleForZoom, CraneView, type CraneViewDeps } from './crane-view';
import { stsSprite } from './entity-assets';
import { StsCraneView } from './sts-crane-view';
import type { CraneVM } from './view-models';
import { ViewSync } from './view-sync';

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo). */
function sameCraneShape(a: CraneVM, b: CraneVM): boolean {
  return a.defId === b.defId && a.x === b.x && a.y === b.y && a.rotation === b.rotation && a.hook?.x === b.hook?.x && a.hook?.y === b.hook?.y;
}

/** View žeriavu vo vrstve: starý žeriav s výložníkom (`CraneView`) alebo nový STS s pevným rámom (`StsCraneView`, R3; def s `parts.frame` v manifeste). */
type AnyCraneView = CraneView | StsCraneView;

export class CraneLayer {
  /** Kontajner vrstvy (výložníky, vozíky, náklad, odznaky); pridaj ho do sveta nad lode a vozidlá (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'cranes' });
  /** Kontajner základní žeriavov; pridaj ho do sveta pod lode a vozidlá (F6d). */
  readonly baseView = new Container({ label: 'crane-bases' });
  private readonly cranes: ViewSync<CraneVM, AnyCraneView>;
  private badgeScale: number;

  constructor(deps: CraneViewDeps) {
    this.badgeScale = deps.badgeScale ?? 1;
    this.cranes = new ViewSync<CraneVM, AnyCraneView>({
      create: (vm) => {
        const sts = stsSprite(vm.defId);
        const craneDeps = { ...deps, badgeScale: this.badgeScale };
        const view: AnyCraneView = sts === undefined ? new CraneView(vm, craneDeps) : new StsCraneView(vm, craneDeps, sts);
        this.view.addChild(view.view);
        this.baseView.addChild(view.baseView);
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
    const view = this.cranes.get(id);
    return view instanceof CraneView ? view : undefined;
  }

  /** View STS žeriavu `id` (R3; testy, ladenie). */
  stsView(id: number): StsCraneView | undefined {
    const view = this.cranes.get(id);
    return view instanceof StsCraneView ? view : undefined;
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
    this.baseView.destroy({ children: true });
  }
}
