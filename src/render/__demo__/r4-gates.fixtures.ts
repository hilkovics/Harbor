/**
 * Pevné view-modely pre demo renderu karty TR4-03 (`r4-gates.html`, R4 brány, predbránová a odstavná plocha, TP) — bez simu a bez UI. Pruhy brány, plochy a TP dodá
 * zo simu až TR4-05; tu sú zadané ručne.
 *
 * Dva pohľady (`?scene=<názov>`):
 *  - `gates`: osem vstupných pruhov so strechou (`left`, 6 × `mid`, `right`; kamióny v rôznych krokoch spracovania), štyri výstupné pruhy (`left`, `mid`, `mid`,
 *    `right`), predbránová plocha 8 × 8 s kamiónmi vedľa seba a odstavná plocha s obsadenými miestami;
 *  - `rtg`: blok RTG 5 × 12 s odovzdávacími miestami v pruhu kamióna (dve obsadené kamiónom → `safe_zone`).
 *
 * `tests/render/r4-gates-fixtures.test.ts` stráži konzistenciu (moduly sa neprekrývajú, kamióny stoja na vlastných bunkách).
 */
import { rotateFootprint } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { EntitiesVM, GateLaneVM, HoldingSlotVM, ModuleVM, TpCellVM, TruckVM } from '../view-models';
import { centerOf, truckOnTrail, type R1Scene } from './r1-traffic.fixtures';

export type R4Scene = R1Scene;

export const IN_LANES_X = 44;
export const IN_LANES_Y = 26;
export const OUT_LANES_X = 54;
export const PRE_GATE_X = 44;
export const PRE_GATE_Y = 30;
export const HOLDING_X = 54;
export const HOLDING_Y = 31;
export const RTG_BLOCK_X = 48;
export const RTG_BLOCK_Y = 20;

function module(id: number, defId: string, kind: string, x: number, y: number, extra: Partial<ModuleVM> = {}): ModuleVM {
  const base = moduleSprite(defId)?.footprint;
  if (base === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  const size = rotateFootprint(base.w, base.h, 0);
  return { id, defId, kind, x, y, rotation: 0, w: size.w, h: size.h, ...extra };
}

/** Strecha pruhu `index` z `count` susedných pruhov. */
export function roofPartOf(index: number, count: number): NonNullable<GateLaneVM['roofPart']> {
  if (count === 1) return 'single';
  if (index === 0) return 'left';
  return index === count - 1 ? 'right' : 'mid';
}

/** Krok spracovania pruhu (`undefined` = voľný pruh so závorou hore). */
interface LaneStep {
  step?: string;
  progress?: number;
}

const IN_STEPS: readonly LaneStep[] = [
  { step: 'ocr', progress: 0.6 },
  { step: 'check', progress: 0.3 },
  {},
  { step: 'issue', progress: 0.8 },
  { step: 'trouble', progress: 0.5 },
  {},
  { step: 'express', progress: 0.2 },
  { step: 'check', progress: 0.9 },
];

const OUT_STEPS: readonly LaneStep[] = [{ step: 'weigh', progress: 0.5 }, { step: 'scan', progress: 0.7 }, {}, { step: 'inspect', progress: 0.4 }];

function lanes(defId: 'gate_in_lane' | 'gate_out_lane', firstId: number, x: number, steps: readonly LaneStep[]): ModuleVM[] {
  const kind = defId === 'gate_in_lane' ? 'in' : 'out';
  return steps.map((step, index) =>
    module(firstId + index, defId, 'gate', x + index, IN_LANES_Y, {
      gateLane: { kind, mode: 'normal', roofPart: roofPartOf(index, steps.length), ...step },
    }),
  );
}

/** Kamión smerom na sever s hlavou v bunke (x; y) a telom o dve bunky nižšie. */
function truckNorth(id: number, cellX: number, headY: number, over: Partial<TruckVM> = {}): TruckVM {
  return truckOnTrail(id, centerOf(cellX, headY), 0, [centerOf(cellX, headY + 1), centerOf(cellX, headY + 2)], over);
}

/** Predbránová plocha: dva kamióny za sebou na pruhu, pruhy vedľa seba. */
const PRE_GATE_OCCUPIED: readonly { lane: number; slots: 1 | 2 }[] = [
  { lane: 0, slots: 2 },
  { lane: 1, slots: 2 },
  { lane: 2, slots: 1 },
  { lane: 3, slots: 2 },
  { lane: 5, slots: 1 },
  { lane: 6, slots: 2 },
  { lane: 7, slots: 1 },
];

function preGateTrucks(): TruckVM[] {
  const trucks: TruckVM[] = [];
  let id = 100;
  for (const { lane, slots } of PRE_GATE_OCCUPIED) {
    for (let slot = 0; slot < slots; slot += 1) {
      trucks.push(truckNorth(id, PRE_GATE_X + lane, PRE_GATE_Y + 1 + slot * 3, { state: 'pre_gate', blocked: slot === 1 }));
      id += 1;
    }
  }
  return trucks;
}

/** Kamióny, ktoré práve stoja v pruhoch (hlava pri závore, telo za ňou). */
function laneTrucks(): TruckVM[] {
  const inside = [0, 1, 3, 4, 6, 7];
  return inside.map((lane, index) => truckNorth(200 + index, IN_LANES_X + lane, IN_LANES_Y, { state: 'gate_lane' }));
}

const HOLDING_SLOTS: readonly HoldingSlotVM[] = [
  { x: HOLDING_X, y: HOLDING_Y, occupied: true },
  { x: HOLDING_X + 1, y: HOLDING_Y, occupied: false },
  { x: HOLDING_X, y: HOLDING_Y + 3, occupied: true },
  { x: HOLDING_X + 1, y: HOLDING_Y + 3, occupied: true },
];

function gatesVm(): EntitiesVM {
  const modules: ModuleVM[] = [
    ...lanes('gate_in_lane', 10, IN_LANES_X, IN_STEPS),
    ...lanes('gate_out_lane', 30, OUT_LANES_X, OUT_STEPS),
    module(50, 'pre_gate_buffer', 'pre_gate', PRE_GATE_X, PRE_GATE_Y),
    module(51, 'truck_holding', 'holding', HOLDING_X, HOLDING_Y, { holdingSlots: HOLDING_SLOTS }),
  ];
  const holdingTrucks = [
    truckNorth(300, HOLDING_X, HOLDING_Y, { state: 'holding' }),
    truckNorth(301, HOLDING_X, HOLDING_Y + 3, { state: 'holding' }),
  ];
  return { modules, cranes: [], ships: [], vehicles: [], trucks: [...laneTrucks(), ...preGateTrucks(), ...holdingTrucks], machines: [] };
}

/** TP v pruhu kamióna bloku RTG (`laneCol` 4): každá druhá bunka; dve sú obsadené. */
export const RTG_TP_CELLS: readonly TpCellVM[] = [1, 3, 5, 7, 9].map((row) => ({ x: RTG_BLOCK_X + 4, y: RTG_BLOCK_Y + row, busy: row === 3 || row === 7 }));

function rtgVm(): EntitiesVM {
  const block = module(60, 'rtg_block', 'storage', RTG_BLOCK_X, RTG_BLOCK_Y, { tpCells: RTG_TP_CELLS });
  const trucks = [truckNorth(400, RTG_BLOCK_X + 4, RTG_BLOCK_Y + 3, { state: 'at_tp' }), truckNorth(401, RTG_BLOCK_X + 4, RTG_BLOCK_Y + 7, { state: 'at_tp' })];
  return { modules: [block], cranes: [], ships: [], vehicles: [], trucks, machines: [] };
}

export const R4_SCENES = Object.freeze({
  gates: { roads: [], vm: gatesVm(), view: { centerX: 51, centerY: 31, zoom: 0.8 } } satisfies R4Scene,
  rtg: { roads: [], vm: rtgVm(), view: { centerX: 50.5, centerY: 26, zoom: 0.8 } } satisfies R4Scene,
});
export type R4SceneName = keyof typeof R4_SCENES;
