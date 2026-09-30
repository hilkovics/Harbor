/**
 * TruckView (DESIGN_BRIEF §5.6, F4): kamión na cestách — sprite `entities.<defId>.states.{empty|loaded}` z manifestu
 * (`truck_container`, 1×2 bunky, kabína hore pri `heading` 0).
 *
 * Pohyb a mierka sú spoločné s `VehicleView` (nie kópia): poloha je stred kamióna v bunkách, pruh a oblúky v zákrutách
 * počíta `vehiclePose` (`lane.ts`, `turn-arc.ts`) pre stred vozidla, sprite je orientovaný v smere jazdy a má mierku
 * `VEHICLE_SCALE` (rovnakú ako straddle carrier), takže kontajner v návese je rovnako veľký ako kontajner na aprone a kamión
 * je o polovicu dlhší než kontajner (100 px obsahu voči 64 px TEU). Líši sa len štýl:
 * prefix `label` a farby fallbacku bez sprite (`--truck-trailer` telo, `--truck-cab` pruh na predku).
 */
import { DockManeuver, type DockPhase, type PosePx, type SwingSide } from './dock-maneuver';
import { noRoadMaskAt, rightOf, type RoadMaskAt } from './lane';
import {
  vehicleSpriteFile,
  VehicleView,
  sameVehicleShape,
  type PoseDirector,
  type VehiclePose,
  type VehicleViewDeps,
  type VehicleViewStyle,
} from './vehicle-view';
import type { TruckVM, VehicleVM } from './view-models';

/** Štýl kamióna: náves `--truck-trailer` s kabínou `--truck-cab` na predku a tmavým obrysom. */
export const TRUCK_STYLE: VehicleViewStyle = {
  label: 'truck',
  fallback: (palette) => ({ body: palette.truck.trailer, outline: palette.vehicle.dark, front: palette.truck.cab }),
};

/** Súbor sprite kamióna (relatívne k `assets/`), alebo `undefined`, ak def nie je kamión v manifeste. */
export function truckSpriteFile(defId: string, loaded: boolean): string | undefined {
  return vehicleSpriteFile(defId, loaded);
}

/** Zhoda statickej časti VM (kým sa nezmení, view sa nevytvára nanovo): poloha a kurz sa menia každý tick, def nie. */
export function sameTruckShape(a: TruckVM, b: TruckVM): boolean {
  return sameVehicleShape(a, b);
}

const defaultNow = (): number => performance.now();

/**
 * Režisér kamióna: pri rampe nahradí pózu zo simu manévrom (`DockManeuver`). Kamión v `loading` stojí podľa simu na
 * vonkajšej bunke konektora (`vm.approach`), cieľová póza v doku je v `vm.x`, `vm.y`, `vm.heading`.
 */
class TruckDockDirector implements PoseDirector {
  private readonly maneuver: DockManeuver;
  private readonly roadMaskAt: RoadMaskAt;

  constructor(deps: VehicleViewDeps) {
    this.maneuver = new DockManeuver(deps.now ?? defaultNow, deps.cellPx);
    this.roadMaskAt = deps.roadMaskAt ?? noRoadMaskAt;
  }

  /** Strana, na ktorej pri vonkajšej bunke pokračuje cesta (vľavo / vpravo od kurzu príjazdu); bez rozdielu vpravo. */
  private swingSide(approach: NonNullable<TruckVM['approach']>): SwingSide {
    const mask = this.roadMaskAt(Math.floor(approach.x), Math.floor(approach.y));
    const right = rightOf(approach.heading);
    const bitOf = (x: number, y: number): number => (y < 0 ? 1 : x > 0 ? 2 : y > 0 ? 4 : 8); // N, E, S, W
    const hasRight = (mask & bitOf(right.x, right.y)) !== 0;
    const hasLeft = (mask & bitOf(-right.x, -right.y)) !== 0;
    return hasLeft && !hasRight ? 'left' : 'right';
  }

  get phase(): DockPhase {
    return this.maneuver.currentPhase;
  }

  pose(vm: VehicleVM, alpha: number, poseOf: (vm: VehicleVM, alpha: number) => VehiclePose): PosePx {
    const truck = vm as TruckVM;
    return this.maneuver.update(truck, {
      sim: () => poseOf(vm, alpha),
      approach: () => {
        const approach = truck.approach;
        if (approach === undefined) return null;
        // póza na vonkajšej bunke konektora ako pri jazde (pruh, oblúk zákruty k modulu), bez pohybu v ticku
        return poseOf({ ...vm, x: approach.x, y: approach.y, prevX: approach.x, prevY: approach.y, heading: approach.heading, prevHeading: approach.heading }, 1);
      },
      swing: () => (truck.approach === undefined ? 'right' : this.swingSide(truck.approach)),
    });
  }
}

export class TruckView extends VehicleView {
  /** Režisér manévru pri rampe (pre testy: fáza `DockManeuver`). */
  private readonly dock: TruckDockDirector;

  constructor(vm: TruckVM, deps: VehicleViewDeps, alpha = 1) {
    const dock = new TruckDockDirector(deps);
    super(vm, deps, alpha, TRUCK_STYLE, dock);
    this.dock = dock;
  }

  /** Fáza manévru pri rampe (`free` mimo nej) — pre testy. */
  get dockPhase(): DockPhase {
    return this.dock.phase;
  }
}
