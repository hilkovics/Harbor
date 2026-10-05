/**
 * Pevné view-modely pre demo renderu karty TR1-06 (`r1-traffic.html`, R1 doprava bez prekrývania, ADR-037) — bez simu.
 * Nosiče nesú stopu (`body`, `lengthCells`, `offRoad`, `blocked`, `jammed`), ktorú zo simu dodá až TR1-08; tu je zadaná ručne.
 *
 * Scény (`?scene=<názov>`):
 *  - `queue`: brána kamiónov (44; 32) s južným vstupom a kolóna štyroch kamiónov (`lengthCells` 3) na ceste x = 44: čelo fronty v
 *    `gate_queue`, dva za ním stoja (`blocked` → brzdové svetlá), posledný práve zatáča zo zákruty (44; 44) – návesy sledujú cestu;
 *  - `crane`: kotvisko so žeriavom a dva straddle carriery (`lengthCells` 2) za sebou na nábreží pod žeriavom, druhý čaká (`blocked`);
 *  - `depot`: depo vozidiel s piatimi zaparkovanými vozidlami (`parkedVehicles`; ich VM v stave `parked` sa nekreslia), vozidlo
 *    práve vychádzajúce z depa (krátka stopa) a vozidlo na ceste;
 *  - `jam`: križovatka so zaseknutým kamiónom (`jammed`: červené bunky a odznak), čakajúcim kamiónom zo severu a kamiónom pred ním;
 *  - `hairpin`: tri slepé cesty s kamiónom pri vjazde, uprostred otočky (vlásenka) a po výjazde.
 *
 * Cesty scény sú jediné cesty gridu (štartová cesta mapy sa nepoužíva), aby zákruty boli skutočné zákruty.
 * `tests/render/r1-traffic-fixtures.test.ts` stráži konzistenciu (stopy súvislé a na cestách, moduly sa neprekrývajú, nosiče
 * sa na ceste neprekrývajú).
 */
import type { CellCoord, Grid, LoadedMap } from '@sim/grid';
import { rotateFootprint } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { EntitiesVM, ModuleVM, TruckVM, VehicleVM, ViewRotation } from '../view-models';
import { berthVM, craneVM, shipVM } from './f2-render.fixtures';
import { gateVM } from './f4-render.fixtures';

/** Dĺžky nosičov v bunkách – rovnaké ako `lengthCells` v defoch od TR1-02 (kamión 3, straddle carrier 2). */
export const TRUCK_LENGTH_CELLS = 3;
export const CARRIER_LENGTH_CELLS = 2;

/** Kam sa má nasmerovať kamera (stred v bunkách) a zoom. */
export interface R1View {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

export interface R1Scene {
  readonly roads: readonly CellCoord[];
  readonly vm: EntitiesVM;
  readonly view: R1View;
}

/** Bod v bunkách (stred bunky = `x + 0,5`). */
export interface CellPoint {
  x: number;
  y: number;
}

/** Stred bunky (cellX, cellY). */
export function centerOf(cellX: number, cellY: number): CellPoint {
  return { x: cellX + 0.5, y: cellY + 0.5 };
}

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

function column(x: number, y1: number, y2: number): CellCoord[] {
  return Array.from({ length: y2 - y1 + 1 }, (_, i) => ({ x, y: y1 + i }));
}

/** Kamión s hlavou v `head`, stopou `body` (od hlavy k chvostu) a kurzom `heading`; predvolene stojí na ceste (`to_gate`). */
export function truckOnTrail(id: number, head: CellPoint, heading: ViewRotation, body: readonly CellPoint[], over: Partial<TruckVM> = {}): TruckVM {
  return {
    id,
    defId: 'truck_container',
    x: head.x,
    y: head.y,
    prevX: head.x,
    prevY: head.y,
    heading,
    prevHeading: heading,
    loaded: false,
    state: 'to_gate',
    body,
    lengthCells: TRUCK_LENGTH_CELLS,
    offRoad: false,
    blocked: false,
    jammed: false,
    ...over,
  };
}

/** Straddle carrier s hlavou v `head`, stopou `body` a kurzom `heading`; predvolene jazdí na ceste (`to_pickup`). */
export function carrierOnTrail(id: number, head: CellPoint, heading: ViewRotation, body: readonly CellPoint[], over: Partial<VehicleVM> = {}): VehicleVM {
  return {
    id,
    defId: 'straddle_carrier',
    x: head.x,
    y: head.y,
    prevX: head.x,
    prevY: head.y,
    heading,
    prevHeading: heading,
    loaded: false,
    state: 'to_pickup',
    body,
    lengthCells: CARRIER_LENGTH_CELLS,
    offRoad: false,
    blocked: false,
    jammed: false,
    ...over,
  };
}

/** Modul bez dynamických polí: footprint z manifestu po rotácii. */
function plainModule(id: number, defId: string, kind: string, x: number, y: number, rotation: 0 | 90 | 180 | 270): ModuleVM {
  const base = moduleSprite(defId)?.footprint;
  if (base === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  const size = rotateFootprint(base.w, base.h, rotation);
  return { id, defId, kind, x, y, rotation, w: size.w, h: size.h };
}

/** Depo vozidiel (3 × 3) s ľavým horným rohom (x, y), rotáciou 0 a zaparkovanými vozidlami. */
export function vehicleDepotVM(id: number, x: number, y: number, parked: readonly { id: number; defId: string }[]): ModuleVM {
  return { ...plainModule(id, 'vehicle_depot', 'depot', x, y, 0), connected: true, parkedVehicles: parked };
}

// ---- scéna `queue` -------------------------------------------------------------------------------------------------

/** Brána kamiónov (44; 32): južný konektor, vonkajšia bunka (44; 34). */
const QUEUE_GATE = gateVM(1, 44, 32, 0, { queueLength: 4, open: false, entryConnector: 1 });

/** Cesty: zvislá x = 44 od brány dole (y 34–43), zákruta (44; 44) a vodorovná y = 44 na východ (x 45–52). */
export const QUEUE_ROADS: readonly CellCoord[] = [...column(44, 34, 43), ...row(44, 44, 52)];

/** Kolóna: čelo fronty v `gate_queue`, dva stojace za ním, posledný zatáča zo zákruty (hlava už na zvislom ramene). */
export const QUEUE_TRUCKS: readonly TruckVM[] = [
  truckOnTrail(101, centerOf(44, 34), 0, [centerOf(44, 35), centerOf(44, 36)], { state: 'gate_queue' }),
  truckOnTrail(102, centerOf(44, 37), 0, [centerOf(44, 38), centerOf(44, 39)], { blocked: true, loaded: true }),
  truckOnTrail(103, centerOf(44, 40), 0, [centerOf(44, 41), centerOf(44, 42)], { blocked: true }),
  truckOnTrail(104, centerOf(44, 43), 0, [centerOf(44, 44), centerOf(45, 44)], { loaded: true, prevX: 44.5, prevY: 43.5 }),
];

export const QUEUE_SCENE: R1Scene = {
  roads: QUEUE_ROADS,
  vm: { modules: [QUEUE_GATE], cranes: [], ships: [], vehicles: [], trucks: QUEUE_TRUCKS },
  view: { centerX: 47, centerY: 39, zoom: 0.8 },
};

// ---- scéna `crane` -------------------------------------------------------------------------------------------------

const CRANE_BERTH = berthVM(1, 40, 14, 0, [0, 1]);

/** Nábrežie pod žeriavom (riadok y = 16, x 41–47) a zvislá cesta k pevnine od južného konektora (41; 16). */
export const CRANE_ROADS: readonly CellCoord[] = [...row(16, 41, 47), ...column(41, 17, 21)];

export const CRANE_VEHICLES: readonly VehicleVM[] = [
  carrierOnTrail(11, centerOf(44, 16), 90, [centerOf(43, 16)], { state: 'to_dropoff', loaded: true }), //  pod žeriavom
  carrierOnTrail(12, centerOf(42, 16), 90, [centerOf(41, 16)], { blocked: true, state: 'to_pickup' }), // čaká za ním
];

export const CRANE_SCENE: R1Scene = {
  roads: CRANE_ROADS,
  vm: {
    modules: [{ ...CRANE_BERTH, connected: true }],
    cranes: [craneVM(2, CRANE_BERTH)],
    ships: [shipVM(31, 'feeder', 43, 13, 90)],
    vehicles: CRANE_VEHICLES,
    trucks: [],
  },
  view: { centerX: 44, centerY: 16.5, zoom: 1.8 },
};

// ---- scéna `depot` -------------------------------------------------------------------------------------------------

/** Zaparkované vozidlá depa (5 z 10 miest). */
export const DEPOT_PARKED: readonly { id: number; defId: string }[] = [
  { id: 21, defId: 'straddle_carrier' },
  { id: 22, defId: 'straddle_carrier' },
  { id: 23, defId: 'empty_handler' },
  { id: 24, defId: 'straddle_carrier' },
  { id: 25, defId: 'straddle_carrier' },
];

/** Cesta od výjazdu depa (33; 25) dole a doprava: zvislá x = 33 (y 25–28), zákruta (33; 28) a vodorovná y = 28 (x 34–40). */
export const DEPOT_ROADS: readonly CellCoord[] = [...column(33, 25, 27), ...row(28, 33, 40)];

/** Zaparkované vozidlá majú VM v stave `parked` v strede depa: renderer ich ako bežné vozidlá nekreslí. */
const DEPOT_PARKED_VMS: readonly VehicleVM[] = DEPOT_PARKED.map((vehicle) =>
  carrierOnTrail(vehicle.id, centerOf(33, 23), 180, [], { defId: vehicle.defId, state: 'parked', offRoad: true }),
);

export const DEPOT_VEHICLES: readonly VehicleVM[] = [
  ...DEPOT_PARKED_VMS,
  // práve vyšlo z depa: hlava za výjazdom, telo je ešte jedna bunka v depe (krátka stopa, sprite sa „rozvíja“)
  carrierOnTrail(30, { x: 33.5, y: 25.2 }, 180, [centerOf(33, 24)], { state: 'depot_exit' }),
  carrierOnTrail(31, centerOf(36, 28), 90, [centerOf(35, 28)], { loaded: true, state: 'to_dropoff' }),
  carrierOnTrail(32, centerOf(33, 28), 90, [centerOf(33, 27)], { state: 'to_pickup' }), // v zákrute: stopa v zvislom ramene
];

export const DEPOT_SCENE: R1Scene = {
  roads: DEPOT_ROADS,
  vm: { modules: [vehicleDepotVM(5, 32, 22, DEPOT_PARKED)], cranes: [], ships: [], vehicles: DEPOT_VEHICLES, trucks: [] },
  view: { centerX: 34.5, centerY: 24.6, zoom: 1.9 },
};

// ---- scéna `jam` ---------------------------------------------------------------------------------------------------

/** Križovatka (50; 24): vodorovná y = 24 (x 44–56) a zvislá x = 50 (y 18–30). */
export const JAM_ROADS: readonly CellCoord[] = [...row(24, 44, 56), ...column(50, 18, 30)];

export const JAM_TRUCKS: readonly TruckVM[] = [
  // zaseknutý uprostred križovatky: pred ním stojí kamión, ktorý ho nepustí
  truckOnTrail(201, centerOf(50, 24), 90, [centerOf(49, 24), centerOf(48, 24)], { blocked: true, jammed: true, loaded: true }),
  truckOnTrail(202, centerOf(54, 24), 90, [centerOf(53, 24), centerOf(52, 24)], { blocked: true }),
  // čaká zo severu pred križovatkou
  truckOnTrail(203, centerOf(50, 22), 180, [centerOf(50, 21), centerOf(50, 20)], { blocked: true }),
];

export const JAM_SCENE: R1Scene = {
  roads: JAM_ROADS,
  vm: { modules: [], cranes: [], ships: [], vehicles: [], trucks: JAM_TRUCKS },
  view: { centerX: 51, centerY: 24.5, zoom: 1.5 },
};

// ---- scéna `hairpin` -----------------------------------------------------------------------------------------------

/** Tri slepé cesty (y 22, 26, 30), x 40–48; slepá bunka je (48; y). */
export const HAIRPIN_ROADS: readonly CellCoord[] = [...row(22, 40, 48), ...row(26, 40, 48), ...row(30, 40, 48)];

export const HAIRPIN_TRUCKS: readonly TruckVM[] = [
  // vjazd: ide na východ k slepej bunke
  truckOnTrail(301, centerOf(46, 22), 90, [centerOf(45, 22), centerOf(44, 22)], { loaded: true }),
  // uprostred otočky: hlava je pol bunky za slepou bunkou (kurz už západ), stopa vedie cez ňu
  truckOnTrail(302, { x: 48, y: 26.5 }, 270, [centerOf(48, 26), centerOf(47, 26)], { state: 'to_portal' }),
  // po výjazde: ide na západ, chvost je ešte pri slepej bunke
  truckOnTrail(303, centerOf(46, 30), 270, [centerOf(47, 30), centerOf(48, 30)], { state: 'to_portal' }),
];

export const HAIRPIN_SCENE: R1Scene = {
  roads: HAIRPIN_ROADS,
  vm: { modules: [], cranes: [], ships: [], vehicles: [], trucks: HAIRPIN_TRUCKS },
  view: { centerX: 45, centerY: 26.5, zoom: 1.3 },
};

export const R1_SCENES = Object.freeze({ queue: QUEUE_SCENE, crane: CRANE_SCENE, depot: DEPOT_SCENE, jam: JAM_SCENE, hairpin: HAIRPIN_SCENE });
export type R1SceneName = keyof typeof R1_SCENES;

/** Mriežka pre scénu: terén mapy + cesty scény (štartová cesta mapy sa odstráni, aby zákruty scény boli skutočné zákruty). */
export function createR1Grid(map: LoadedMap, scene: R1Scene): Grid {
  const grid = map.createGrid();
  for (const cell of map.starter.roads) grid.at(cell.x, cell.y).road = 'none';
  for (const cell of scene.roads) grid.at(cell.x, cell.y).road = 'road';
  return grid;
}
