/**
 * Pevné view-modely pre demo renderu Fázy 3 (`f3-render.html`, T03-08) — bez simu, aby šlo skontrolovať vzhľad:
 * fill stavy skladu, vozidlá s kurzmi a odznak „nepripojené“.
 *
 * Scéna `main` (screenshot `f3-render-demo.png`) na starter parcele mapy `harbor_01`:
 *  - vodorovná cesta (y 24, x 33–48) so zvislou odbočkou (x 44, y 25–33) na štartovú cestu (x 44, y 34–63),
 *  - dva kontajnerové dvory S (fill 0 a 75) a pripojené depo na južnej hrane s konektormi na ceste,
 *  - druhé depo východne od konca cesty, ku ktorému cesta nedosahuje (`connected: false` → odznak),
 *  - 3 straddle carriery: prázdny na východ, naložený na západ a naložený na sever.
 *
 * Scéna `lanes` (T03-17, screenshot `f3-lanes.png`, `f3-render.html?scene=lanes`): bez modulov, len cesty a vozidlá v pravom
 * pruhu — priama cesta s protismernými vozidlami (aj vedľa seba v jednej bunke), zákruty, T-križovatka a dve vozidlá
 * uprostred zákruty (`prevHeading`).
 *
 * Geometria (vonkajšie bunky konektorov, vozidlá na cestách) sa počíta z manifestu a `@sim/grid` rovnako ako v sime;
 * `tests/render/f3-render-fixtures.test.ts` stráži, že scéna je konzistentná (príznak `connected` zodpovedá ceste
 * pri konektore, vozidlá stoja na cestách a smerujú po nich).
 */
import type { CellCoord, Grid, LoadedMap } from '@sim/grid';
import { rotateFootprint, rotateLocalCell, type Rotation } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { EntitiesVM, ModuleVM, VehicleVM, ViewSide } from '../view-models';
import { rotateSide } from './f2-render.fixtures';

export const DEMO_YARD_DEF = 'container_yard_small';
export const DEMO_DEPOT_DEF = 'vehicle_depot';
export const DEMO_VEHICLE_DEF = 'straddle_carrier';

/** Kapacita dvora vo fixtúrach (`container_yard_small`: 32 slotov × 2 vrstvy) — renderer používa iba pomer. */
export const DEMO_YARD_CAPACITY = 64;

/** Krok (dx, dy) v bunkách von cez stranu. */
export const SIDE_STEP: Readonly<Record<ViewSide, { readonly dx: number; readonly dy: number }>> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};

function footprintOf(defId: string): { w: number; h: number } {
  const entry = moduleSprite(defId);
  if (entry === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  return entry.footprint;
}

function moduleVM(id: number, defId: string, kind: string, x: number, y: number, rotation: Rotation): ModuleVM {
  const base = footprintOf(defId);
  const size = rotateFootprint(base.w, base.h, rotation);
  return { id, defId, kind, x, y, rotation, w: size.w, h: size.h };
}

/** Kontajnerový dvor S s ľavým horným rohom (x, y) PO rotácii a `stored` uloženými jednotkami. */
export function yardVM(id: number, x: number, y: number, rotation: Rotation, stored: number, connected: boolean): ModuleVM {
  return {
    ...moduleVM(id, DEMO_YARD_DEF, 'storage', x, y, rotation),
    storage: { capacity: DEMO_YARD_CAPACITY, stored, reserved: 0 },
    connected,
  };
}

/** Depo vozidiel s ľavým horným rohom (x, y) PO rotácii. */
export function depotVM(id: number, x: number, y: number, rotation: Rotation, connected: boolean): ModuleVM {
  return { ...moduleVM(id, DEMO_DEPOT_DEF, 'depot', x, y, rotation), connected };
}

/** Predchádzajúca poloha vozidla a voliteľne aj kurz (`heading` chýba = rovnaký ako aktuálny). */
export interface VehiclePrev {
  readonly x: number;
  readonly y: number;
  readonly heading?: VehicleVM['heading'];
}

/** Vozidlo so stredom v (x, y) v bunkách (voľná poloha, napr. v zákrute) a predchádzajúcou polohou `prev`. */
export function vehicleAt(
  id: number,
  x: number,
  y: number,
  heading: VehicleVM['heading'],
  loaded: boolean,
  state: string,
  prev: VehiclePrev = { x, y },
): VehicleVM {
  const vm: VehicleVM = { id, defId: DEMO_VEHICLE_DEF, x, y, prevX: prev.x, prevY: prev.y, heading, loaded, state };
  return prev.heading === undefined ? vm : { ...vm, prevHeading: prev.heading };
}

/** Vozidlo v strede bunky (cellX, cellY); `prev` je predchádzajúca poloha (predvolene tá istá). */
export function vehicleVM(
  id: number,
  cellX: number,
  cellY: number,
  heading: VehicleVM['heading'],
  loaded: boolean,
  state: string,
  prev: VehiclePrev = { x: cellX + 0.5, y: cellY + 0.5 },
): VehicleVM {
  return vehicleAt(id, cellX + 0.5, cellY + 0.5, heading, loaded, state, prev);
}

/** Vonkajšie bunky cestných konektorov modulu (bunka mimo footprintu, na strane `side`) — tam sa napája cesta. */
export function connectorOutsideCells(vm: ModuleVM): CellCoord[] {
  const entry = moduleSprite(vm.defId);
  if (entry === undefined) return [];
  return entry.connectors
    .filter((connector) => connector.type === 'road')
    .map((connector) => {
      const cell = rotateLocalCell(connector.x, connector.y, entry.footprint.w, entry.footprint.h, vm.rotation);
      const step = SIDE_STEP[rotateSide(connector.side, vm.rotation)];
      return { x: vm.x + cell.x + step.dx, y: vm.y + cell.y + step.dy };
    });
}

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

function column(x: number, y1: number, y2: number): CellCoord[] {
  return Array.from({ length: y2 - y1 + 1 }, (_, i) => ({ x, y: y1 + i }));
}

/** Cesty scény: hlavná vodorovná cesta pod modulmi a zvislá odbočka na štartovú cestu mapy (x 44). */
export const DEMO_ROADS: readonly CellCoord[] = [...row(24, 33, 48), ...column(44, 25, 33)];

/** Mriežka pre demo: terén mapy + štartová cesta + cesty scény. */
export function createDemoGrid(map: LoadedMap): Grid {
  const grid = map.createGrid();
  for (const cell of [...map.starter.roads, ...DEMO_ROADS]) grid.at(cell.x, cell.y).road = 'road';
  return grid;
}

/** Dvor A (prázdny), dvor B (75 %), pripojené depo a odpojené depo. */
export const YARD_EMPTY = yardVM(1, 32, 20, 0, 0, true);
export const YARD_FILLED = yardVM(2, 38, 20, 0, 48, true);
export const DEPOT_CONNECTED = depotVM(3, 46, 21, 0, true);
export const DEPOT_DISCONNECTED = depotVM(4, 51, 21, 0, false);

/** Scéna `main`: vozidlá idú po ceste a k dvorom. */
export const MAIN_SCENE: EntitiesVM = {
  modules: [YARD_EMPTY, YARD_FILLED, DEPOT_CONNECTED, DEPOT_DISCONNECTED],
  cranes: [],
  ships: [],
  vehicles: [
    vehicleVM(11, 36, 24, 90, false, 'to_pickup', { x: 36.1, y: 24.5 }),
    vehicleVM(12, 41, 24, 270, true, 'to_dropoff'),
    vehicleVM(13, 44, 29, 0, true, 'to_dropoff'),
  ],
};

/** Kam sa má nasmerovať kamera (stred v bunkách) a zoom. */
export interface SceneView {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

/** Pohľad na scénu `main`. */
export const SCENE_VIEW: SceneView = { centerX: 43, centerY: 26, zoom: 0.75 };

/**
 * Cesty scény `lanes` (všetky `two_lane`): horná priama cesta y 24 (x 37–48), zvislá odbočka x 42 (y 25–28) a spodná
 * cesta y 28 (x 42–48) a východná cesta x 48 (y 25–27) — spolu obdĺžnik s T-križovatkou (42; 24) a tromi zákrutami
 * (48; 24), (48; 28), (42; 28).
 */
export const LANES_ROADS: readonly CellCoord[] = [
  ...row(24, 37, 48),
  ...column(42, 25, 28),
  ...row(28, 43, 48),
  ...column(48, 25, 27),
];

/** Mriežka pre scénu `lanes`: terén mapy + štartová cesta + cesty scény. */
export function createLanesGrid(map: LoadedMap): Grid {
  const grid = map.createGrid();
  for (const cell of [...map.starter.roads, ...LANES_ROADS]) grid.at(cell.x, cell.y).road = 'road';
  return grid;
}

/**
 * Scéna `lanes`: protismerné vozidlá v oboch pruhoch (dvojice v jednej bunke ukazujú, že sa nekrížia), T-križovatka
 * a dve vozidlá uprostred zákruty (28: (48; 24) z východu na juh, 29: (42; 28) z juhu na východ).
 */
export const LANES_SCENE: EntitiesVM = {
  modules: [],
  cranes: [],
  ships: [],
  vehicles: [
    // horná cesta: dvojica vedľa seba v bunke (39; 24) a ďalšie dve v protismere
    vehicleVM(21, 39, 24, 90, false, 'to_pickup'),
    vehicleVM(22, 39, 24, 270, true, 'to_dropoff'),
    vehicleVM(23, 45, 24, 90, true, 'to_dropoff'),
    vehicleVM(24, 44, 24, 270, false, 'to_pickup'),
    // východná cesta: dvojica vedľa seba v bunke (48; 26)
    vehicleVM(25, 48, 26, 180, false, 'to_pickup'),
    vehicleVM(26, 48, 26, 0, true, 'to_dropoff'),
    // odbočka z T-križovatky
    vehicleVM(27, 42, 26, 180, true, 'to_dropoff'),
    vehicleVM(28, 42, 27, 0, false, 'to_pickup'),
    // spodná cesta
    vehicleVM(29, 46, 28, 270, true, 'to_dropoff'),
    vehicleVM(30, 45, 28, 90, false, 'to_pickup'),
    // zákruty: kurz sa práve zmenil, predchádzajúci úsek mal iný smer
    vehicleAt(31, 48.5, 24.62, 180, false, 'to_pickup', { x: 47.95, y: 24.5, heading: 90 }),
    vehicleAt(32, 42.62, 28.5, 90, true, 'to_dropoff', { x: 42.5, y: 27.95, heading: 180 }),
  ],
};

/** Pohľad na scénu `lanes` (zoom 1,5: pruhy sú dobre vidieť). */
export const LANES_VIEW: SceneView = { centerX: 42.5, centerY: 26.5, zoom: 1.5 };

/** Pomenované scény dema (`?scene=<názov>`). */
export interface DemoScene {
  readonly vm: EntitiesVM;
  readonly view: SceneView;
  readonly createGrid: (map: LoadedMap) => Grid;
}

export const DEMO_SCENES = {
  main: { vm: MAIN_SCENE, view: SCENE_VIEW, createGrid: createDemoGrid },
  lanes: { vm: LANES_SCENE, view: LANES_VIEW, createGrid: createLanesGrid },
} as const satisfies Readonly<Record<string, DemoScene>>;

export type DemoSceneName = keyof typeof DEMO_SCENES;
