/**
 * Pevné view-modely pre demo renderu karty TR3-03 (`r3-sts-rtg.html`, R3 ťahače a RTG) — bez simu a bez UI. STS, ťahače, RTG aj pruhy kotviska dodá zo simu až
 * TR3-05; tu sú zadané ručne.
 *
 * Dva pohľady (`?scene=<názov>`):
 *  - `berth`: kotvisko 8 × 4 (`berth_standard_v2`, do TR3-05 pod id `berth_standard`) s jednosmernými pruhmi (šípky `lanes`), nový STS (rám 3 × 10 o 4 bunky nad kotviskom, vozík uprostred dráhy, spreader 40′
 *    s kontajnerom) a dva ťahače na pruhoch pod žeriavom (kontajner 40′ a 20′ na podvozku);
 *  - `rtg`: RTG nad blokom (rám 5 × 2, vozík v pruhu kamióna, kontajner zdvihnutý) a ťahač pri ňom.
 *
 * `tests/render/r3-sts-rtg-fixtures.test.ts` stráži konzistenciu (ťahače stoja na cestách, `lengthCells` 3, pruhy ležia vo footprinte kotviska).
 */
import type { CellCoord } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { ContainerVM, CraneVM, EntitiesVM, MachineVM, ModuleVM, VehicleVM } from '../view-models';
import { centerOf, carrierOnTrail, type R1Scene } from './r1-traffic.fixtures';

export type R3Scene = R1Scene;

export const BERTH_ID = 1;
export const STS_ID = 2;
export const RTG_ID = 7;
export const BERTH_X = 40;
export const BERTH_Y = 14;

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

const BOX_40: ContainerVM = { sizeFt: 40, containerType: 'dry', lineId: 'blue_anchor', direction: 'import' };
const BOX_20: ContainerVM = { sizeFt: 20, containerType: 'dry', lineId: 'northern_star', direction: 'export' };

/** Pruhy pod žeriavom (rady 1 a 2 kotviska, smer na východ) a obchádzka (rad 3, smer na západ). */
export const BERTH_LANES: readonly { x: number; y: number; dir: 'e' | 'w' }[] = [
  ...row(BERTH_Y + 1, BERTH_X, BERTH_X + 7).map((cell) => ({ ...cell, dir: 'e' as const })),
  ...row(BERTH_Y + 2, BERTH_X, BERTH_X + 7).map((cell) => ({ ...cell, dir: 'e' as const })),
  ...row(BERTH_Y + 3, BERTH_X, BERTH_X + 7).map((cell) => ({ ...cell, dir: 'w' as const })),
];

function berthModule(): ModuleVM {
  const base = moduleSprite('berth_standard_v2')?.footprint;
  if (base === undefined) throw new Error('demo: berth_standard_v2 nie je v manifeste');
  return { id: BERTH_ID, defId: 'berth_standard_v2', kind: 'berth', x: BERTH_X, y: BERTH_Y, rotation: 0, w: base.w, h: base.h, connected: true, lanes: BERTH_LANES };
}

/** STS: rám 3 × 10 sa kladie o 4 bunky (256 px) nad kotvisko; vozík uprostred dráhy. */
export const STS: CraneVM = {
  id: STS_ID,
  defId: 'sts',
  berthId: BERTH_ID,
  x: BERTH_X + 2,
  y: BERTH_Y - 4,
  rotation: 0,
  state: 'placing',
  progress: 0.5,
  holding: null,
  trolleyY: 0.5,
  cargo: BOX_40,
};

/** Ťahač smerom na východ s hlavou v bunke (headX; y) a kontajnerom `cargo`. */
function tractorEast(id: number, headX: number, y: number, cargo: ContainerVM | null): VehicleVM {
  return carrierOnTrail(id, centerOf(headX, y), 90, [centerOf(headX - 1, y), centerOf(headX - 2, y)], {
    defId: 'terminal_tractor',
    lengthCells: 3,
    state: cargo === null ? 'to_pickup' : 'to_dropoff',
    loaded: cargo !== null,
    cargo,
  });
}

export const TRACTORS: readonly VehicleVM[] = [tractorEast(21, BERTH_X + 5, BERTH_Y + 1, BOX_40), tractorEast(22, BERTH_X + 2, BERTH_Y + 2, BOX_20)];

export const BERTH_ROADS: readonly CellCoord[] = [...row(BERTH_Y + 1, BERTH_X, BERTH_X + 7), ...row(BERTH_Y + 2, BERTH_X, BERTH_X + 7)];

const BERTH_VM: EntitiesVM = { modules: [berthModule()], cranes: [STS], ships: [], vehicles: TRACTORS, trucks: [], machines: [] };

/** RTG: rám v (52,5; 24), vozík v pruhu kamióna, kontajner zdvihnutý. */
export const RTG: MachineVM = { id: RTG_ID, defId: 'rtg', blockId: 3, x: 52.5, y: 24, trolley: 0.85, hoist: 0.8, state: 'moving', cargo: BOX_40 };

export const RTG_ROADS: readonly CellCoord[] = row(26, 46, 58);

const RTG_VM: EntitiesVM = {
  modules: [],
  cranes: [],
  ships: [],
  vehicles: [tractorEast(23, 51, 26, null)],
  trucks: [],
  machines: [RTG],
};

export const R3_SCENES = Object.freeze({
  berth: { roads: BERTH_ROADS, vm: BERTH_VM, view: { centerX: 44, centerY: 15, zoom: 1.6 } } satisfies R3Scene,
  rtg: { roads: RTG_ROADS, vm: RTG_VM, view: { centerX: 52.5, centerY: 25, zoom: 2.4 } } satisfies R3Scene,
});
export type R3SceneName = keyof typeof R3_SCENES;
