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

/** Vozidlo v strede bunky (cellX, cellY); `prev` je predchádzajúca poloha (predvolene tá istá). */
export function vehicleVM(
  id: number,
  cellX: number,
  cellY: number,
  heading: VehicleVM['heading'],
  loaded: boolean,
  state: string,
  prev: { readonly x: number; readonly y: number } = { x: cellX + 0.5, y: cellY + 0.5 },
): VehicleVM {
  return { id, defId: DEMO_VEHICLE_DEF, x: cellX + 0.5, y: cellY + 0.5, prevX: prev.x, prevY: prev.y, heading, loaded, state };
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
export const SCENE_VIEW = { centerX: 43, centerY: 26, zoom: 0.75 } as const;
