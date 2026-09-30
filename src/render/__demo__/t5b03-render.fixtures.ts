/**
 * Pevné view-modely pre demo renderu karty T5B-03 (`t5b03-render.html`, spätná väzba F5b č. 3, 8, 10, 11) — bez simu.
 *
 * Scény (`?scene=<názov>`):
 *  - `scale` (audit mierky, č. 10): Root berth so žeriavom, loďami feeder a handy, kontajnermi na aprone, dvor (fill 50),
 *    rampa s pripravenými kontajnermi, cesty, straddle carriery (prázdny a naložený vedľa seba) a kamióny (prázdny, naložený).
 *    Cesty sa napájajú na konektory berthu, dvora a rampy (č. 3);
 *  - `connect` (č. 3): scéna F4 — brána, čakacia plocha a dve rampy prepojené cestami (bez medzier pri konektoroch);
 *  - `yard` (č. 8): kontajnerový dvor s cestou a straddle carrierom pri vstupe; animáciu žeriavu spúšťa test zmenou
 *    `lastStorageOp` (`yardScene`);
 *  - `dock` (č. 11): rampa A s dvoma kamiónmi, ktoré cúvajú do docku — jeden prichádza popri rampe (kurz kolmý na os docku),
 *    druhý priamo na modul; póza sa skladá funkciami `dockTruck*`.
 *
 * Geometria (vonkajšie bunky konektorov, stredy dokov) sa počíta z manifestu rovnako ako v sime;
 * `tests/render/t5b03-render-fixtures.test.ts` stráži, že scény sú konzistentné (moduly sa neprekrývajú, cesty sú pri
 * konektoroch, vozidlá stoja na cestách).
 */
import type { CellCoord, Grid, LoadedMap } from '@sim/grid';
import { rotateFootprint, type Rotation } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import { dockCenter } from '../module-slots';
import type { EntitiesVM, ModuleVM, TruckVM, VehicleVM, ViewRotation } from '../view-models';
import { berthVM, craneVM, shipVM } from './f2-render.fixtures';
import { F4_ROADS, RAMP_A, RAMP_B, F4_MAIN_SCENE, F4_MAIN_VIEW, GATE, WAITING_AREA, rampVM, truckAt } from './f4-render.fixtures';

/** Kam sa má nasmerovať kamera (stred v bunkách) a zoom. */
export interface T5b03View {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

export interface T5b03Scene {
  readonly roads: readonly CellCoord[];
  readonly vm: EntitiesVM;
  readonly view: T5b03View;
}

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

function column(x: number, y1: number, y2: number): CellCoord[] {
  return Array.from({ length: y2 - y1 + 1 }, (_, i) => ({ x, y: y1 + i }));
}

/** Modul bez dynamických polí: footprint z manifestu po rotácii. */
function plainModule(id: number, defId: string, kind: string, x: number, y: number, rotation: Rotation): ModuleVM {
  const base = moduleSprite(defId)?.footprint;
  if (base === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  const size = rotateFootprint(base.w, base.h, rotation);
  return { id, defId, kind, x, y, rotation, w: size.w, h: size.h };
}

/** Kontajnerový dvor s `stored` z 64 jednotiek a voliteľnou poslednou operáciou (animácia žeriavu). */
export function yardVM(id: number, x: number, y: number, stored: number, lastStorageOp?: ModuleVM['lastStorageOp']): ModuleVM {
  const vm: ModuleVM = { ...plainModule(id, 'container_yard_small', 'storage', x, y, 0), storage: { capacity: 64, stored, reserved: 0 }, connected: true };
  return lastStorageOp === undefined ? vm : { ...vm, lastStorageOp };
}

/** Straddle carrier v strede bunky (cellX, cellY) s kurzom `heading`. */
export function carrierAt(id: number, cellX: number, cellY: number, heading: ViewRotation, loaded: boolean): VehicleVM {
  const x = cellX + 0.5;
  const y = cellY + 0.5;
  return { id, defId: 'straddle_carrier', x, y, prevX: x, prevY: y, heading, prevHeading: heading, loaded, state: loaded ? 'to_dropoff' : 'to_pickup' };
}

/** Kamión v strede bunky (cellX, cellY) s kurzom `heading`. */
export function truckInCellAt(id: number, cellX: number, cellY: number, heading: ViewRotation, loaded: boolean, state: string): TruckVM {
  return truckAt(id, cellX + 0.5, cellY + 0.5, heading, loaded, state);
}

// ---- scéna `scale` -------------------------------------------------------------------------------------------------

const SCALE_BERTH = berthVM(1, 40, 14, 0, [0, 1, 3]);
const SCALE_YARD = yardVM(3, 44, 19, 32);
const SCALE_RAMP = rampVM(4, 51, 24, 0, [2, 1], true);

/**
 * Cesty scény `scale`: od južného konektora berthu (41; 16) → vonkajšia (41; 17) dole a doprava k dvoru (45; 23) a od (50; 17)
 * dole k rampe (vonkajšie bunky (52; 26), (53; 26)).
 */
export const SCALE_ROADS: readonly CellCoord[] = [...column(41, 17, 23), ...row(23, 41, 45), ...column(50, 17, 26), ...row(26, 50, 53)];

const SCALE_VEHICLES: readonly VehicleVM[] = [
  carrierAt(11, 41, 18, 180, false), // prázdny a naložený vedľa seba pod apronom
  carrierAt(12, 41, 19, 180, true),
  carrierAt(13, 42, 23, 90, false), //  a ešte raz v inom smere pri dvore
  carrierAt(14, 43, 23, 90, true),
];

const SCALE_TRUCKS: readonly TruckVM[] = [
  truckInCellAt(21, 50, 19, 180, false, 'to_dock'),
  truckInCellAt(22, 50, 22, 180, true, 'to_gate_out'),
];

export const SCALE_SCENE: T5b03Scene = {
  roads: SCALE_ROADS,
  vm: {
    modules: [SCALE_BERTH, SCALE_YARD, SCALE_RAMP].map((module) => ({ ...module, connected: true })),
    cranes: [craneVM(2, SCALE_BERTH)],
    ships: [shipVM(31, 'feeder', 43, 13, 90), shipVM(32, 'handy', 54, 12, 90)],
    vehicles: SCALE_VEHICLES,
    trucks: SCALE_TRUCKS,
  },
  view: { centerX: 47, centerY: 20, zoom: 0.58 },
};

// ---- scéna `connect` -----------------------------------------------------------------------------------------------

export const CONNECT_SCENE: T5b03Scene = { roads: F4_ROADS, vm: { ...F4_MAIN_SCENE, trucks: [] }, view: F4_MAIN_VIEW };

// ---- scéna `yard` --------------------------------------------------------------------------------------------------

/** Cesta od konektora dvora (45; 22) → vonkajšia (45; 23) doprava. */
export const YARD_ROADS: readonly CellCoord[] = row(23, 41, 47);

/** Dvor (fill 50) s danou poslednou operáciou; straddle carrier stojí na vonkajšej bunke konektora. */
export function yardScene(op?: ModuleVM['lastStorageOp']): T5b03Scene {
  return {
    roads: YARD_ROADS,
    vm: { modules: [yardVM(3, 44, 19, 32, op)], cranes: [], ships: [], vehicles: [carrierAt(11, 45, 23, 0, op?.kind === 'put')], trucks: [] },
    view: { centerX: 46, centerY: 21.4, zoom: 1.7 },
  };
}

export const YARD_SCENE: T5b03Scene = yardScene();

// ---- scéna `dock` --------------------------------------------------------------------------------------------------

/** Dva kamióny pri rampe A: dok 0 (príjazd z východu popri rampe) a dok 1 (príjazd zo juhu priamo na rampu). */
export const DOCK_TRUCK_SIDE = 201;
export const DOCK_TRUCK_STRAIGHT = 202;

/** Cieľová póza v doku `dock` rampy A: stred docku a kabína von z rampy (proti smeru do modulu). */
function dockTarget(dock: number): { x: number; y: number; heading: ViewRotation } {
  const at = dockCenter(RAMP_A, dock);
  return { x: at.x, y: at.y, heading: 180 };
}

/** Kamión tesne pred dokom: `to_dock`, stojí na vonkajšej bunke konektora s kurzom príjazdu. */
export function dockTruckArriving(id: number, cellX: number, cellY: number, heading: ViewRotation): TruckVM {
  return truckInCellAt(id, cellX, cellY, heading, false, 'to_dock');
}

/** Kamión v `loading`: `x`, `y`, `heading` = póza v doku, `approach` = sim poloha (vonkajšia bunka) a kurz príjazdu. */
export function dockTruckLoading(id: number, cellX: number, cellY: number, arrivalHeading: ViewRotation, dock: number, loaded = false): TruckVM {
  const target = dockTarget(dock);
  return {
    ...truckAt(id, target.x, target.y, target.heading, loaded, 'loading'),
    prevState: 'to_dock',
    approach: { x: cellX + 0.5, y: cellY + 0.5, heading: arrivalHeading },
  };
}

/** Kamión po nakládke: `to_gate_out` na sim polohe (vonkajšia bunka) s kurzom prvého úseku cesty. */
export function dockTruckLeaving(id: number, x: number, y: number, heading: ViewRotation): TruckVM {
  return { ...truckAt(id, x, y, heading, true, 'to_gate_out'), prevState: 'loading' };
}

/** Scéna `dock` so zadanými kamiónmi. */
export function dockScene(trucks: readonly TruckVM[]): T5b03Scene {
  return {
    roads: F4_ROADS,
    vm: { modules: [GATE, WAITING_AREA, RAMP_A, RAMP_B], cranes: [], ships: [], vehicles: [], trucks },
    view: { centerX: 32, centerY: 25.2, zoom: 2.2 },
  };
}

export const DOCK_SCENE: T5b03Scene = dockScene([dockTruckArriving(DOCK_TRUCK_SIDE, 31, 25, 270), dockTruckArriving(DOCK_TRUCK_STRAIGHT, 32, 25, 0)]);

export const T5B03_SCENES = Object.freeze({ scale: SCALE_SCENE, connect: CONNECT_SCENE, yard: YARD_SCENE, dock: DOCK_SCENE });
export type T5b03SceneName = keyof typeof T5B03_SCENES;

/** Mriežka pre scénu: terén mapy + štartová cesta + cesty scény. */
export function createT5b03Grid(map: LoadedMap, scene: T5b03Scene): Grid {
  const grid = map.createGrid();
  for (const cell of [...map.starter.roads, ...scene.roads]) grid.at(cell.x, cell.y).road = 'road';
  return grid;
}
