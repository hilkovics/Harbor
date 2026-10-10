/**
 * TruckView (DESIGN_BRIEF §5.6, F4): kamión na cestách — sprite `entities.<defId>.states.{empty|loaded}` z manifestu
 * (`truck_container`, 1×2 bunky, kabína hore pri `heading` 0).
 *
 * Pohyb a mierka sú spoločné s `VehicleView` (nie kópia): poloha je stred kamióna v bunkách, pruh a oblúky v zákrutách
 * počíta `vehiclePose` (`lane.ts`, `turn-arc.ts`) pre stred vozidla, sprite je orientovaný v smere jazdy a má mierku
 * `VEHICLE_SCALE` (rovnakú ako straddle carrier): kamión je 28 px široký (zmestí sa do 26 px pruhu) a ~116 px dlhý (footprint
 * 1×2), kontajner v návese je 64×26 ako TEU na aprone (`world-scale.ts`). Líši sa len štýl:
 * prefix `label` a farby fallbacku bez sprite (`--truck-trailer` telo, `--truck-cab` pruh na predku).
 */
import { vehicleSpriteFile, VehicleView, sameVehicleShape, type VehicleViewDeps, type VehicleViewStyle } from './vehicle-view';
import type { TruckVM } from './view-models';
import { TRUCK_LENGTH_PX, TRUCK_WIDTH_PX } from './world-scale';

/** Štýl kamióna: náves `--truck-trailer` s kabínou `--truck-cab` na predku a tmavým obrysom. */
export const TRUCK_STYLE: VehicleViewStyle = {
  label: 'truck',
  widthPx: TRUCK_WIDTH_PX,
  lengthPx: TRUCK_LENGTH_PX,
  fallback: (palette) => ({ body: palette.truck.trailer, outline: palette.vehicle.dark, front: palette.truck.cab }),
};

/** Súbor sprite kamióna (relatívne k `assets/`), alebo `undefined`, ak def nie je kamión v manifeste. */
export function truckSpriteFile(defId: string, loaded: boolean, carriesEmpty = false): string | undefined {
  return vehicleSpriteFile(defId, loaded, carriesEmpty);
}

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo): poloha a kurz sa menia každý tick, def nie. */
export function sameTruckShape(a: TruckVM, b: TruckVM): boolean {
  return sameVehicleShape(a, b);
}

export class TruckView extends VehicleView {
  constructor(vm: TruckVM, deps: VehicleViewDeps, alpha = 1) {
    super(vm, deps, alpha, TRUCK_STYLE);
  }
}
