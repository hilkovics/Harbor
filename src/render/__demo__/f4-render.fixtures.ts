/**
 * Pevné view-modely pre demo renderu Fázy 4 (`f4-render.html`, T04-06) — bez simu, aby šlo skontrolovať vzhľad brány
 * kamiónov (závora, fronta), čakacej plochy (obsadené stojiská), rampy (pripravené kontajnery, upozornenie) a kamiónov.
 *
 * Scéna `main` (screenshot `f4-render-demo.png`) na starter parcele mapy `harbor_01`:
 *  - brána (44; 32) so severným a južným konektorom; vstupný je južný (`entryConnector: 1`), kde sa napája štartová cesta
 *    x = 44 z portálu. Fronta 3, závora zatvorená, kamión na čele fronty stojí na vonkajšej bunke (44; 34),
 *  - cesta zo severného konektora brány (x = 44, y 28–31) so zákrutou (44; 28) doľava a vodorovná cesta y = 28
 *    k východnému konektoru čakacej plochy (33; 26); z jej západného konektora ide cesta x = 32 hore k rampe,
 *  - čakacia plocha so 4 z 6 obsadených stojísk (0, 1, 3, 4), na každom obsadenom stojí kamión,
 *  - rampa A (30; 23): na doku 0 dva pripravené kontajnery, na doku 1 kamión počas nakládky,
 *  - rampa B (38; 26) pripojená k ceste y = 28, ale neprevádzková (`operational: false` → odznak upozornenia),
 *  - kamióny na ceste: pred bránou (fronta), na štartovej ceste smerom k bráne (prázdny) aj od nej (naložený), v zákrute
 *    (44; 28) a po bráne smerom von (naložený).
 *
 * Geometria (vonkajšie bunky konektorov, stredy stojísk a dokov) sa počíta z manifestu a `@sim/grid` rovnako ako v sime;
 * `tests/render/f4-render-fixtures.test.ts` stráži, že scéna je konzistentná (moduly sa neprekrývajú a ležia na starter
 * parcele, príznak `connected` zodpovedá ceste pri konektore, kamióny stoja na cestách alebo na stojiskách / dokoch).
 */
import type { CellCoord, Grid, LoadedMap } from '@sim/grid';
import { rotateFootprint, type Rotation } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import { dockCenter, stallCenter } from '../module-slots';
import type { EntitiesVM, ModuleVM, TruckVM } from '../view-models';

export const DEMO_GATE_DEF = 'truck_gate';
export const DEMO_WAITING_AREA_DEF = 'truck_waiting_area';
export const DEMO_RAMP_DEF = 'loading_ramp_container';
export const DEMO_TRUCK_DEF = 'truck_container';

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

/** Brána kamiónov s ľavým horným rohom (x, y) PO rotácii. `entryConnector` chýba = 0 (renderer ho berie ako prvý konektor). */
export function gateVM(
  id: number,
  x: number,
  y: number,
  rotation: Rotation,
  state: { queueLength: number; open: boolean; entryConnector?: number },
  connected = true,
): ModuleVM {
  return { ...moduleVM(id, DEMO_GATE_DEF, 'gate', x, y, rotation), connected, gate: state };
}

/** Čakacia plocha s ľavým horným rohom (x, y) PO rotácii; `occupied[i]` patrí stojisku `stalls[i]`. */
export function waitingAreaVM(id: number, x: number, y: number, rotation: Rotation, occupied: readonly boolean[], connected = true): ModuleVM {
  return { ...moduleVM(id, DEMO_WAITING_AREA_DEF, 'waiting_area', x, y, rotation), connected, waitingArea: { bays: occupied.length, occupied } };
}

/** Nakladacia rampa s ľavým horným rohom (x, y) PO rotácii; `staged[i]` patrí doku `docks[i]`. */
export function rampVM(
  id: number,
  x: number,
  y: number,
  rotation: Rotation,
  staged: readonly number[],
  operational: boolean,
  connected = true,
): ModuleVM {
  return { ...moduleVM(id, DEMO_RAMP_DEF, 'ramp', x, y, rotation), connected, ramp: { docks: staged.length, staged, operational } };
}

/** Predchádzajúca poloha kamióna a voliteľne aj kurz (`heading` chýba = rovnaký ako aktuálny). */
export interface TruckPrev {
  readonly x: number;
  readonly y: number;
  readonly heading?: TruckVM['heading'];
}

/** Kamión so stredom v (x, y) v bunkách (voľná poloha) a predchádzajúcou polohou `prev` (predvolene tá istá). */
export function truckAt(
  id: number,
  x: number,
  y: number,
  heading: TruckVM['heading'],
  loaded: boolean,
  state: string,
  prev: TruckPrev = { x, y },
): TruckVM {
  const vm: TruckVM = { id, defId: DEMO_TRUCK_DEF, x, y, prevX: prev.x, prevY: prev.y, heading, loaded, state };
  return prev.heading === undefined ? vm : { ...vm, prevHeading: prev.heading };
}

/** Kamión v strede bunky (cellX, cellY). */
export function truckInCell(
  id: number,
  cellX: number,
  cellY: number,
  heading: TruckVM['heading'],
  loaded: boolean,
  state: string,
  prev: TruckPrev = { x: cellX + 0.5, y: cellY + 0.5 },
): TruckVM {
  return truckAt(id, cellX + 0.5, cellY + 0.5, heading, loaded, state, prev);
}

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

function column(x: number, y1: number, y2: number): CellCoord[] {
  return Array.from({ length: y2 - y1 + 1 }, (_, i) => ({ x, y: y1 + i }));
}

/**
 * Cesty scény (všetky `two_lane`): z brány hore (x 44, y 28–31), doľava k čakacej ploche (y 28, x 37–43), z jej západnej
 * strany hore k rampe (x 32, y 25–28) a odbočka k druhému doku (31; 25). Štartová cesta mapy (x 44, y 34–63) tvorí vstup.
 */
export const F4_ROADS: readonly CellCoord[] = [
  ...column(44, 28, 31),
  ...row(28, 37, 43),
  ...column(32, 25, 28),
  { x: 31, y: 25 },
];

/** Mriežka pre demo: terén mapy + štartová cesta + cesty scény. */
export function createF4Grid(map: LoadedMap): Grid {
  const grid = map.createGrid();
  for (const cell of [...map.starter.roads, ...F4_ROADS]) grid.at(cell.x, cell.y).road = 'road';
  return grid;
}

/** Brána, čakacia plocha, prevádzková rampa A a neprevádzková rampa B. */
export const GATE = gateVM(1, 44, 32, 0, { queueLength: 3, open: false, entryConnector: 1 });
export const WAITING_AREA = waitingAreaVM(2, 33, 26, 0, [true, true, false, true, true, false]);
export const RAMP_A = rampVM(3, 30, 23, 0, [2, 0], true);
export const RAMP_B = rampVM(4, 38, 26, 0, [0, 0], false);

/** Stojiská plnej čakacej plochy so zaparkovaným kamiónom (indexy `occupied === true`). */
const PARKED_STALLS = [0, 1, 3, 4] as const;

/** Kamióny scény: fronta pred bránou, cesta k bráne a od nej, zákruta, po bráne von, stojiská a dok rampy A. */
export const F4_TRUCKS: readonly TruckVM[] = [
  truckInCell(101, 44, 34, 0, false, 'gate_queue'), //         čelo fronty: vonkajšia bunka vstupného (južného) konektora
  truckInCell(102, 44, 38, 0, false, 'to_gate', { x: 44.5, y: 38.9 }), // ide k bráne
  truckInCell(103, 44, 41, 180, true, 'to_portal'), //         naložený odchádza na portál
  truckInCell(110, 44, 30, 180, true, 'to_gate_out'), //       naložený ide k bráne zo severu, von
  truckAt(104, 44.5, 28.75, 0, false, 'to_bay', { x: 44.5, y: 29.15 }), // v zákrute (44; 28): sever → západ, ľavá
  ...PARKED_STALLS.map((stall, i) => {
    const at = stallCenter(WAITING_AREA, stall);
    return truckAt(105 + i, at.x, at.y, 0, false, 'waiting');
  }),
  (() => {
    const at = dockCenter(RAMP_A, 1);
    return truckAt(109, at.x, at.y, 180, false, 'loading'); //  v doku 1 rampy A: do docku kamión cúva, kabína von z rampy (juh)
  })(),
];

/** Scéna `main`: moduly a kamióny; bez žeriavov, lodí a vozidiel. */
export const F4_MAIN_SCENE: EntitiesVM = {
  modules: [GATE, WAITING_AREA, RAMP_A, RAMP_B],
  cranes: [],
  ships: [],
  vehicles: [],
  trucks: F4_TRUCKS,
};

/** Kam sa má nasmerovať kamera (stred v bunkách) a zoom. */
export interface F4SceneView {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

/** Pohľad na celú scénu (zoom 0,58: 34 × 19 buniek v okne 1280 × 720). */
export const F4_MAIN_VIEW: F4SceneView = { centerX: 38.5, centerY: 32.5, zoom: 0.58 };
