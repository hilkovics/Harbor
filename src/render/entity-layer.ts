/**
 * EntityLayer (ARCHITECTURE §15.1): pohyblivé entity sveta — vo F2 lode (`ShipView`); vozidlá, kamióny a vlaky
 * pribudnú s ďalšími fázami. Leží nad `ModuleLayer` a pod `CraneLayer` (výložník žeriava sa kreslí nad palubou lode).
 *
 * `sync(ships, alpha)` sa volá každý frame: views vznikajú a zanikajú podľa `id` a pre nezmenené lode sa iba
 * nastaví interpolovaná poloha (`lerp(prev, curr, alpha)`).
 */
import { Container } from 'pixi.js';
import { ShipView, sameShipShape, type ShipViewDeps } from './ship-view';
import type { ShipVM } from './view-models';
import { ViewSync } from './view-sync';

export class EntityLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'entities' });
  private readonly ships: ViewSync<ShipVM, ShipView>;
  /** Interpolačný podiel aktuálneho `sync` (hook `update` ho číta). */
  private alpha = 1;

  constructor(deps: ShipViewDeps) {
    this.ships = new ViewSync<ShipVM, ShipView>({
      create: (vm) => {
        const view = new ShipView(vm, deps, this.alpha);
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: (view, vm) => sameShipShape(view.vm, vm),
      update: (view, vm) => {
        view.update(vm, this.alpha);
      },
    });
  }

  /** Počet nakreslených lodí. */
  get shipCount(): number {
    return this.ships.size;
  }

  /** View lode `id` (testy, ladenie). */
  shipView(id: number): ShipView | undefined {
    return this.ships.get(id);
  }

  /** Zosúladí lode s VM a nastaví ich polohu pre `alpha` (0…1 medzi predchádzajúcim a aktuálnym tickom). */
  sync(ships: readonly ShipVM[], alpha: number): void {
    this.alpha = alpha;
    this.ships.sync(ships);
  }

  destroy(): void {
    this.ships.clear();
    this.view.destroy({ children: true });
  }
}
