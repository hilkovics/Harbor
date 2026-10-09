/**
 * Pevné view-modely pre demo renderu pozemnej časti (`f4-render.html`, pôvodne T04-06; po R4 bez rampy, čakacej plochy a
 * `truck_gate`) — bez simu, aby šlo skontrolovať vzhľad pruhov brány (strecha, závora, štítok kroku), odstavnej plochy
 * (`truck_holding`) a kamiónov na ceste, v zákrute a pred bránou.
 *
 * Scéna `main` (screenshot `f4-render-demo.png`) na starter parcele mapy `harbor_01`:
 *  - vstupný pruh brány `gate_in_lane` (44; 30) so strechou `single` a krokom `ocr` (závora dole) a výstupný pruh
 *    `gate_out_lane` (45; 30) voľný (závora hore); pred vstupným pruhom stojí na štartovej ceste x = 44 kamión (44; 34),
 *  - cesta zo severného konca pruhov (x = 44, y 28–29) so zákrutou (44; 28) doľava a vodorovná cesta y = 28 k odstavnej
 *    ploche `truck_holding` (33; 26) so 4 miestami, z ktorých 2 sú obsadené kamiónom,
 *  - kamióny: pred bránou (fronta), na štartovej ceste k bráne aj od nej, v pruhu, v zákrute a na odstavnej ploche.
 *
 * Geometria odstavných miest je zadaná v bunkách; scéna leží na starter parcele.
 */
import type { CellCoord, Grid, LoadedMap } from '@sim/grid';
import { rotateFootprint, type Rotation } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { EntitiesVM, GateLaneVM, HoldingSlotVM, ModuleVM, TruckVM } from '../view-models';

export const DEMO_IN_LANE_DEF = 'gate_in_lane';
export const DEMO_OUT_LANE_DEF = 'gate_out_lane';
export const DEMO_HOLDING_DEF = 'truck_holding';
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

/** Pruh brány (`gate_in_lane` / `gate_out_lane`) s ľavým horným rohom (x, y); `lane.step` chýba = voľný pruh so závorou hore. */
export function gateLaneVM(id: number, defId: string, x: number, y: number, lane: GateLaneVM, connected = true): ModuleVM {
  return { ...moduleVM(id, defId, 'gate', x, y, 0), connected, gateLane: lane };
}

/** Odstavná plocha `truck_holding` s ľavým horným rohom (x, y) a danými miestami. */
export function holdingVM(id: number, x: number, y: number, slots: readonly HoldingSlotVM[], connected = true): ModuleVM {
  return { ...moduleVM(id, DEMO_HOLDING_DEF, 'holding', x, y, 0), connected, holdingSlots: slots };
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
 * Cesty scény (všetky `two_lane`): zo severného konca pruhov hore (x 44, y 28–29), doľava k odstavnej ploche (y 28, x 39–43).
 * Štartová cesta mapy (x 44, y 34–63) tvorí vstup; bunky 30–33 zaberajú pruhy brány.
 */
export const F4_ROADS: readonly CellCoord[] = [...column(44, 28, 29), ...row(28, 39, 43)];

/** Mriežka pre demo: terén mapy + štartová cesta + cesty scény. */
export function createF4Grid(map: LoadedMap): Grid {
  const grid = map.createGrid();
  for (const cell of [...map.starter.roads, ...F4_ROADS]) grid.at(cell.x, cell.y).road = 'road';
  return grid;
}

/** Vstupný pruh s krokom `ocr` (závora dole), voľný výstupný pruh (závora hore) a odstavná plocha so 4 miestami. */
export const IN_LANE = gateLaneVM(1, DEMO_IN_LANE_DEF, 44, 30, { kind: 'in', mode: 'normal', roofPart: 'single', step: 'ocr', progress: 0.6 });
export const OUT_LANE = gateLaneVM(2, DEMO_OUT_LANE_DEF, 45, 30, { kind: 'out', mode: 'normal', roofPart: 'single' });
export const HOLDING_SLOTS: readonly HoldingSlotVM[] = [
  { x: 33, y: 26, occupied: true },
  { x: 34, y: 26, occupied: false },
  { x: 33, y: 29, occupied: true },
  { x: 34, y: 29, occupied: false },
];
export const HOLDING = holdingVM(3, 33, 26, HOLDING_SLOTS);

/** Kamióny scény: fronta pred bránou, cesta k bráne a od nej, pruh, zákruta a odstavná plocha. */
export const F4_TRUCKS: readonly TruckVM[] = [
  truckInCell(101, 44, 34, 0, false, 'to_gate'), //            čelo fronty: bunka pred pruhmi brány
  truckInCell(102, 44, 38, 0, false, 'to_gate', { x: 44.5, y: 38.9 }), // ide k bráne
  truckInCell(103, 44, 41, 180, true, 'to_portal'), //         naložený odchádza na portál
  truckInCell(110, 44, 31, 0, false, 'gate_lane'), //          v pruhu brány pri závore
  truckAt(104, 44.5, 28.75, 0, false, 'to_holding', { x: 44.5, y: 29.15 }), // v zákrute (44; 28): sever → západ, ľavá
  truckInCell(105, 33, 26, 0, false, 'holding'),
  truckInCell(106, 33, 29, 0, false, 'holding'),
];

/** Scéna `main`: moduly a kamióny; bez žeriavov, lodí a vozidiel. */
export const F4_MAIN_SCENE: EntitiesVM = {
  modules: [IN_LANE, OUT_LANE, HOLDING],
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
