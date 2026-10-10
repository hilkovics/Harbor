/**
 * Pevné view-modely pre demo renderu karty TR6-03 (`r6-rail.html`, R6 železnica s RMG) — bez simu a bez UI.
 *
 * Scéna `terminal`: dlhá koľaj z východu s dvoma veľkými zákrutami (S, polomer `RAIL_CURVE_RADIUS_CELLS`) a tretou pri RMG (stĺpec x = 44); vlak
 * (lokomotíva + 6 vagónov 60′, časť naložená) stojí hlavou na juhu a jeho chvost je ešte v zákrutách; RMG (rám 6 × 2) nad koľajami a
 * bufferom zdvíha kontajner z vagóna. Pózy vozov vznikajú z hladkej osi koľaje (`placeCars`), nie ručne.
 *
 * `tests/render/r6-rail.test.ts` stráži konzistenciu (vozy na koľaji, uhly po zákrute, sloty kontajnerov).
 */
import type { CellCoord } from '@sim/grid';
import type { ContainerVM, EntitiesVM, MachineVM, TrainCarVM, TrainVM } from '../view-models';
import { buildRailPaths, placeCars, type RailPath } from '../rail-path';
import type { R1Scene } from './r1-traffic.fixtures';

export type R6Scene = R1Scene;

/** Dĺžka vozňa a lokomotívy v bunkách (footprint 1 × 3). */
export const CAR_LENGTH_CELLS = 3;

export const TRAIN_ID = 61;
export const RMG_ID = 62;
/** Zvislá koľaj pri RMG (stĺpec) a jej južný koniec. */
export const TRACK_X = 44;
export const HEAD_Y = 38;

/** Koľaje: východ (y = 16) → juh (x = 50) → západ (y = 24) → juh (x = 44): dve veľké zákruty S a tretia, každá s polomerom 3 bunky. */
export const RAILS: readonly CellCoord[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ x: 50 + i, y: 16 })),
  ...Array.from({ length: 8 }, (_, i) => ({ x: 50, y: 17 + i })),
  ...Array.from({ length: 5 }, (_, i) => ({ x: 45 + i, y: 24 })),
  ...Array.from({ length: HEAD_Y - 23 }, (_, i) => ({ x: TRACK_X, y: 24 + i })),
];

/** Hladká os koľaje (od východného konca po južný) — rovnaká, akú kreslí `RoadLayer`. */
export const TRACK_PATH: RailPath = buildRailPaths(RAILS)[0]!;

/** Hlava vlaku stojí 5 buniek pred južným koncom, chvost je ešte v druhej zákrute. */
export const HEAD_S = TRACK_PATH.length - 5;

const box = (sizeFt: 20 | 40, lineId: string | null, containerType = 'dry'): ContainerVM => ({
  sizeFt,
  containerType,
  lineId,
  direction: sizeFt === 40 ? 'import' : 'export',
});

/** Náklad vagónov 1–6: 40′ + 20′, 3 × 20′, 40′, prázdny, 20′, prázdny. */
export const WAGON_CARGO: readonly (readonly ContainerVM[])[] = [
  [box(40, 'blue_anchor'), box(20, 'northern_star')],
  [box(20, 'northern_star'), box(20, 'blue_anchor'), box(20, 'northern_star')],
  [box(40, 'blue_anchor')],
  [],
  [box(20, 'northern_star')],
  [],
];

function trainVM(): TrainVM {
  const poses = placeCars(TRACK_PATH, HEAD_S, 1, 1 + WAGON_CARGO.length, CAR_LENGTH_CELLS);
  const cars: TrainCarVM[] = poses.map((pose, i) => ({ kind: i === 0 ? 'loco' : 'wagon', x: pose.x, y: pose.y, angle: pose.angle, cargo: i === 0 ? [] : (WAGON_CARGO[i - 1] ?? []) }));
  return { id: TRAIN_ID, cars, state: 'at_terminal', departureTick: 4800 };
}

/** RMG: rám 6 × 2 (pivot x 160 px) nad koľajou x = 44 a bufferom (stĺpce 45–47); vozík nad hlavnou koľajou, kontajner zdvihnutý z vagóna. */
export const RMG: MachineVM = {
  id: RMG_ID,
  defId: 'rmg',
  blockId: 0,
  x: TRACK_X - 1 + 2.5,
  y: 30,
  trolley: 0.18,
  hoist: 0.8,
  state: 'lifting',
  cargo: box(40, 'blue_anchor'),
};

const TERMINAL_VM: EntitiesVM = { modules: [], cranes: [], ships: [], vehicles: [], trucks: [], machines: [RMG], trains: [trainVM()] };

export const R6_SCENES = Object.freeze({
  terminal: { roads: [], vm: TERMINAL_VM, view: { centerX: 50, centerY: 27, zoom: 0.5 } } satisfies R6Scene,
  rmg: { roads: [], vm: TERMINAL_VM, view: { centerX: 45.5, centerY: 30, zoom: 1.6 } } satisfies R6Scene,
});
export type R6SceneName = keyof typeof R6_SCENES;

/** Buffer pod RMG (R6, `rmg_rail_block`): 4 rady × 6 bays vedľa koľaje; rad = 0,5 bunky, bay = 1 bunka; `null` = prázdna pozícia. */
export const BUFFER = {
  x0: TRACK_X + 1.25,
  rowPitch: 0.5,
  y0: 27,
  rows: 4,
  bays: 6,
  stacks: [
    [box(20, 'blue_anchor'), box(20, 'northern_star'), null, box(20, 'blue_anchor'), box(20, 'blue_anchor'), null],
    [box(20, 'northern_star'), null, box(20, 'northern_star'), box(20, 'northern_star'), null, box(20, 'blue_anchor')],
    [null, box(20, 'blue_anchor'), box(20, 'blue_anchor'), null, box(20, 'northern_star'), box(20, 'northern_star')],
    [box(20, 'northern_star'), box(20, 'northern_star'), null, box(20, 'blue_anchor'), null, null],
  ] as readonly (readonly (ContainerVM | null)[])[],
} as const;
