/**
 * EntityLayer (ARCHITECTURE §15.1): pohyblivé entity sveta — lode (`ShipView`, F2), vozidlá (`VehicleView`, F3) a kamióny
 * (`TruckView`, F4); vlaky pribudnú s ďalšími fázami. Leží nad `ModuleLayer` a pod `CraneLayer` (výložník žeriava sa kreslí
 * nad palubou lode).
 *
 * `sync(ships, alpha)`, `syncVehicles(vehicles, alpha)` a `syncTrucks(trucks, alpha)` sa volajú každý frame: views vznikajú
 * a zanikajú podľa `id` a pre nezmenené entity sa iba nastaví interpolovaná poloha (`lerp(prev, curr, alpha)`). Vozidlá sa
 * kreslia nad loďami a kamióny nad vozidlami (`zIndex`), nezávisle od poradia, v akom views vznikli.
 */
import { Container } from 'pixi.js';
import { ShipView, sameShipShape, type ShipViewDeps } from './ship-view';
import { TruckView, sameTruckShape } from './truck-view';
import { VehicleView, sameVehicleShape, type VehicleViewDeps } from './vehicle-view';
import type { ShipVM, TruckVM, VehicleVM } from './view-models';
import { ViewSync } from './view-sync';

/** Poradie kreslenia v rámci vrstvy: lode dole, vozidlá nad nimi, kamióny navrchu. */
const SHIP_Z_INDEX = 0;
const VEHICLE_Z_INDEX = 1;
const TRUCK_Z_INDEX = 2;

export class EntityLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). */
  readonly view = new Container({ label: 'entities' });
  private readonly ships: ViewSync<ShipVM, ShipView>;
  private readonly vehicles: ViewSync<VehicleVM, VehicleView>;
  private readonly trucks: ViewSync<TruckVM, TruckView>;
  /** Interpolačný podiel aktuálneho `sync` / `syncVehicles` / `syncTrucks` (hooky `create` a `update` ho čítajú). */
  private alpha = 1;

  constructor(deps: ShipViewDeps & VehicleViewDeps) {
    this.view.sortableChildren = true;
    this.ships = new ViewSync<ShipVM, ShipView>({
      create: (vm) => {
        const view = new ShipView(vm, deps, this.alpha);
        view.view.zIndex = SHIP_Z_INDEX;
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
    this.vehicles = new ViewSync<VehicleVM, VehicleView>({
      create: (vm) => {
        const view = new VehicleView(vm, deps, this.alpha);
        view.view.zIndex = VEHICLE_Z_INDEX;
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: (view, vm) => sameVehicleShape(view.vm, vm),
      update: (view, vm) => {
        view.update(vm, this.alpha);
      },
    });
    this.trucks = new ViewSync<TruckVM, TruckView>({
      create: (vm) => {
        const view = new TruckView(vm, deps, this.alpha);
        view.view.zIndex = TRUCK_Z_INDEX;
        this.view.addChild(view.view);
        return view;
      },
      remove: (view) => {
        view.destroy();
      },
      matches: (view, vm) => sameTruckShape(view.vm, vm),
      update: (view, vm) => {
        view.update(vm, this.alpha);
      },
    });
  }

  /** Počet nakreslených lodí. */
  get shipCount(): number {
    return this.ships.size;
  }

  /** Počet nakreslených vozidiel. */
  get vehicleCount(): number {
    return this.vehicles.size;
  }

  /** Počet nakreslených kamiónov. */
  get truckCount(): number {
    return this.trucks.size;
  }

  /** View lode `id` (testy, ladenie). */
  shipView(id: number): ShipView | undefined {
    return this.ships.get(id);
  }

  /** View vozidla `id` (testy, ladenie). */
  vehicleView(id: number): VehicleView | undefined {
    return this.vehicles.get(id);
  }

  /** View kamióna `id` (testy, ladenie). */
  truckView(id: number): TruckView | undefined {
    return this.trucks.get(id);
  }

  /** Zosúladí lode s VM a nastaví ich polohu pre `alpha` (0…1 medzi predchádzajúcim a aktuálnym tickom). */
  sync(ships: readonly ShipVM[], alpha: number): void {
    this.alpha = alpha;
    this.ships.sync(ships);
  }

  /** Zosúladí vozidlá s VM a nastaví ich polohu pre `alpha` (0…1 medzi predchádzajúcim a aktuálnym tickom). */
  syncVehicles(vehicles: readonly VehicleVM[], alpha: number): void {
    this.alpha = alpha;
    this.vehicles.sync(vehicles);
  }

  /** Zosúladí kamióny s VM a nastaví ich polohu pre `alpha` (0…1 medzi predchádzajúcim a aktuálnym tickom). */
  syncTrucks(trucks: readonly TruckVM[], alpha: number): void {
    this.alpha = alpha;
    this.trucks.sync(trucks);
  }

  destroy(): void {
    this.ships.clear();
    this.vehicles.clear();
    this.trucks.clear();
    this.view.destroy({ children: true });
  }
}
