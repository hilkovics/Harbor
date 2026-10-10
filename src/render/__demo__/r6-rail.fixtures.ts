/**
 * Pevné view-modely pre demo renderu karty TR6-03 (`r6-rail.html`, R6 železnica s RMG) — bez simu a bez UI.
 *
 * Scéna `terminal`: koľaj z východu sa v zákrute (44; 22) stáča na juh a ide pozdĺž terminálu (stĺpec x = 44) ; vlak
 * (lokomotíva + 6 vagónov 60′, časť naložená) stojí hlavou na juhu, jeho chvost je ešte v zákrute (kĺbové uhly voz po voze); RMG (rám 6 × 2) nad koľajami a
 * bufferom zdvíha kontajner z vagóna. Pózy vozov vznikajú z lomenej čiary koľaje (`carPoses`), nie ručne.
 *
 * `tests/render/r6-rail.test.ts` stráži konzistenciu (vozy na koľaji, uhly po zákrute, sloty kontajnerov).
 */
import type { CellCoord } from '@sim/grid';
import type { ContainerVM, EntitiesVM, MachineVM, TrainCarVM, TrainVM } from '../view-models';
import type { R1Scene } from './r1-traffic.fixtures';

export type R6Scene = R1Scene;

/** Dĺžka vozňa a lokomotívy v bunkách (footprint 1 × 3). */
export const CAR_LENGTH_CELLS = 3;
/** Vzdialenosť „náprav“ od stredu vozňa (bunky): oblúk sa láme medzi nimi. */
const AXLE_HALF_CELLS = 1.2;

export const TRAIN_ID = 61;
export const RMG_ID = 62;
export const TRACK_X = 44;
export const CORNER_Y = 22;
export const TRACK_END_X = 54;
export const HEAD_Y = 36;

interface Pt {
  x: number;
  y: number;
}

/** Os koľaje od hlavy vlaku (juh) cez zákrutu na východ: stredy buniek. */
export const TRACK_PATH: readonly Pt[] = [
  { x: TRACK_X + 0.5, y: HEAD_Y + 0.5 },
  { x: TRACK_X + 0.5, y: CORNER_Y + 0.5 },
  { x: TRACK_END_X + 0.5, y: CORNER_Y + 0.5 },
];

/** Bod lomenej čiary vo vzdialenosti `s` od jej začiatku (za koncom pokračuje v smere posledného úseku). */
export function pointAt(path: readonly Pt[], s: number): Pt {
  let left = s;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len || i + 2 === path.length) return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    left -= len;
  }
  return path[0]!;
}

/**
 * Pózy `count` vozov za sebou od hlavy po lomenej čiare: stred voza = stred medzi prednou a zadnou „nápravou“, uhol = smer jazdy
 * (0 = hore, v smere hodinových ručičiek; smer ide od zadnej nápravy k prednej).
 */
export function carPoses(path: readonly Pt[], count: number): { x: number; y: number; angle: number }[] {
  return Array.from({ length: count }, (_, k) => {
    const mid = CAR_LENGTH_CELLS * k + CAR_LENGTH_CELLS / 2;
    const front = pointAt(path, mid - AXLE_HALF_CELLS);
    const rear = pointAt(path, mid + AXLE_HALF_CELLS);
    const dx = front.x - rear.x;
    const dy = front.y - rear.y;
    return { x: (front.x + rear.x) / 2, y: (front.y + rear.y) / 2, angle: (Math.atan2(dx, -dy) * 180) / Math.PI };
  });
}

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
  const poses = carPoses(TRACK_PATH, 1 + WAGON_CARGO.length);
  const cars: TrainCarVM[] = poses.map((pose, i) => ({ kind: i === 0 ? 'loco' : 'wagon', ...pose, cargo: i === 0 ? [] : (WAGON_CARGO[i - 1] ?? []) }));
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

/** Koľaje: hlavná (zákruta + juh) . */
export const RAILS: readonly CellCoord[] = [
  ...Array.from({ length: TRACK_END_X - TRACK_X + 1 }, (_, i) => ({ x: TRACK_X + i, y: CORNER_Y })),
  ...Array.from({ length: HEAD_Y - CORNER_Y }, (_, i) => ({ x: TRACK_X, y: CORNER_Y + 1 + i })),
];

const TERMINAL_VM: EntitiesVM = { modules: [], cranes: [], ships: [], vehicles: [], trucks: [], machines: [RMG], trains: [trainVM()] };

export const R6_SCENES = Object.freeze({
  terminal: { roads: [], vm: TERMINAL_VM, view: { centerX: 47, centerY: 28.5, zoom: 0.5 } } satisfies R6Scene,
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
