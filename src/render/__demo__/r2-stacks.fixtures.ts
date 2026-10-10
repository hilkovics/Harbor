/**
 * Pevné view-modely pre demo renderu karty TR2-03 (`r2-stacks.html`, R2 kontajnery a stohy, ADR-039) — bez simu a bez UI.
 * Stohy (`ModuleVM.stacks`) a kontajnery na nosičoch (`cargo`) zo simu dodá až TR2-05; tu sú zadané ručne.
 *
 * Jedna scéna, štyri pohľady (`?scene=<názov>`):
 *  - `terminal`: celok — straddle blok, depo prázdnych, dva rady nosičov na cestách;
 *  - `block`: straddle blok `container_yard_small` 4 × 4 bays × rows, maxTier 3: stohy výšky 1–3, 20′ aj 40′ (pár bays), tri linky, neutrálny kontajner
 *    bez linky, prázdny sivý kontajner a prázdna pozícia;
 *  - `depot`: depo prázdnych `empty_depot` 4 × 4, maxTier 8: sivé prázdne kontajnery 20′ / 40′ s pásikom linky, stohy do výšky 8 a odznaky depa;
 *  - `vehicles`: rad kamiónov (20′ modrá linka, 40′ jantárová linka, 40′ prázdny) a rad nosičov (straddle carrier so 40′ a 20′, ECH s prázdnym 20′ a 40′
 *    a ECH bez kontajnera — spreader 20′).
 *
 * `tests/render/r2-stacks-fixtures.test.ts` stráži konzistenciu (moduly sa neprekrývajú, nosiče stoja na cestách, páry 40′ sú úplné, výšky v limite).
 */
import type { CellCoord, Grid, LoadedMap } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { ContainerVM, EntitiesVM, ModuleVM, StackGeometryVM, StackVM, TruckVM, VehicleVM } from '../view-models';
import { carrierOnTrail, centerOf, createR1Grid, truckOnTrail } from './r1-traffic.fixtures';

/** Pohľad kamery (stred v bunkách a zoom) — rovnaký tvar ako `R1View`, aby ho zdieľal `createR1Grid`. */
export interface R2View {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

export interface R2Scene {
  readonly roads: readonly CellCoord[];
  readonly vm: EntitiesVM;
  readonly view: R2View;
}

export const YARD_ID = 3;
export const DEPOT_ID = 5;

/** Linky z `data/defs/lines.json`: modrá, jantárová, tyrkysová. */
export const BLUE = 'blue_anchor';
export const AMBER = 'northern_star';
export const TEAL = 'golden_wave';

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

/** Kontajner dry (plný, import) danej veľkosti a linky; `lineId` `null` = bez linky (neutrálny). */
export function dry(sizeFt: 20 | 40, lineId: string | null, direction: ContainerVM['direction'] = 'import'): ContainerVM {
  return { sizeFt, containerType: 'dry', lineId, direction };
}

/** Prázdny (sivý) kontajner danej veľkosti a linky. */
export function emptyBox(sizeFt: 20 | 40, lineId: string | null): ContainerVM {
  return { sizeFt, containerType: 'dry', lineId, direction: 'empty' };
}

/** Stoh 20′ kontajnerov na pozícii (bay; row). */
export function stack20(bay: number, row: number, height: number, top: ContainerVM): StackVM {
  return { bay, row, height, top };
}

/** 40′ stoh: obe pozície páru bays `(2k, 2k + 1)` nesú rovnaký vrchný kontajner (ako `YardBlock.topUnit`). */
export function stack40(pair: number, row: number, height: number, top: ContainerVM): StackVM[] {
  return [
    { bay: pair * 2, row, height, top },
    { bay: pair * 2 + 1, row, height, top },
  ];
}

/** Prázdna pozícia (výška 0, bez kontajnera). */
export function emptyPosition(bay: number, row: number): StackVM {
  return { bay, row, height: 0, top: null };
}

/** Modul so stohmi: footprint z manifestu po rotácii 0, `connected` a geometria bloku. */
function blockModule(id: number, defId: string, x: number, y: number, geometry: StackGeometryVM, stacks: readonly StackVM[]): ModuleVM {
  const base = moduleSprite(defId)?.footprint;
  if (base === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  const stored = stacks.reduce((sum, stack) => sum + stack.height, 0); // v TEU: 40′ pár = 2 stohy × výška
  return {
    id,
    defId,
    kind: 'storage',
    x,
    y,
    rotation: 0,
    w: base.w,
    h: base.h,
    connected: true,
    storage: { capacity: geometry.bays * geometry.rows * geometry.maxTier, stored, reserved: 0 },
    stackGeometry: geometry,
    stacks,
  };
}

/** Straddle blok (36; 19): 4 bays × 4 rows, maxTier 3. Výšky 1–3, 20′ aj 40′, tri linky, jeden neutrálny kontajner a jeden sivý prázdny. */
export const BLOCK_GEOMETRY: StackGeometryVM = { bays: 4, rows: 4, maxTier: 3 };

export const BLOCK_STACKS: readonly StackVM[] = [
  // rad 0: 20′ ×3 modrá, 20′ ×2 jantárová, 40′ ×1 tyrkysová (pár 1)
  stack20(0, 0, 3, dry(20, BLUE)),
  stack20(1, 0, 2, dry(20, AMBER)),
  ...stack40(1, 0, 1, dry(40, TEAL)),
  // rad 1: 40′ ×2 modrá (pár 0), 20′ ×3 jantárová, 20′ ×1 bez linky
  ...stack40(0, 1, 2, dry(40, BLUE)),
  stack20(2, 1, 3, dry(20, AMBER)),
  stack20(3, 1, 1, dry(20, null)),
  // rad 2: sivý prázdny 20′ ×1 (modrá linka), 20′ ×2 tyrkysová, 40′ ×3 jantárová (pár 1)
  stack20(0, 2, 1, emptyBox(20, BLUE)),
  stack20(1, 2, 2, dry(20, TEAL)),
  ...stack40(1, 2, 3, dry(40, AMBER)),
  // rad 3: prázdna pozícia, 20′ ×1 modrá, 20′ ×2 modrá, 20′ ×2 tyrkysová export
  emptyPosition(0, 3),
  stack20(1, 3, 1, dry(20, BLUE, 'export')),
  stack20(2, 3, 2, dry(20, BLUE, 'export')),
  stack20(3, 3, 2, dry(20, TEAL, 'export')),
];

export const BLOCK: ModuleVM = blockModule(YARD_ID, 'container_yard_small', 36, 19, BLOCK_GEOMETRY, BLOCK_STACKS);

/** Depo prázdnych (42; 19): 4 bays × 4 rows, maxTier 8; všetky kontajnery sivé (prázdne), pásik farby linky, 20′ aj 40′. */
export const DEPOT_GEOMETRY: StackGeometryVM = { bays: 4, rows: 4, maxTier: 8 };

export const DEPOT_STACKS: readonly StackVM[] = [
  stack20(0, 0, 8, emptyBox(20, BLUE)),
  stack20(1, 0, 5, emptyBox(20, AMBER)),
  ...stack40(1, 0, 4, emptyBox(40, TEAL)),
  ...stack40(0, 1, 6, emptyBox(40, BLUE)),
  stack20(2, 1, 3, emptyBox(20, AMBER)),
  stack20(3, 1, 1, emptyBox(20, TEAL)),
  stack20(0, 2, 2, emptyBox(20, TEAL)),
  stack20(1, 2, 7, emptyBox(20, BLUE)),
  ...stack40(1, 2, 2, emptyBox(40, AMBER)),
  stack20(0, 3, 1, emptyBox(20, AMBER)),
  emptyPosition(1, 3),
  stack20(2, 3, 4, emptyBox(20, BLUE)),
  stack20(3, 3, 8, emptyBox(20, TEAL)),
];

export const DEPOT: ModuleVM = {
  ...blockModule(DEPOT_ID, 'empty_depot', 42, 19, DEPOT_GEOMETRY, DEPOT_STACKS),
  depot: { available: 52, damaged: 2, inRepair: 1, repairBays: 2 },
};

/** Cesty: rad y = 23 pod blokmi (konektory blokov majú vonkajšiu bunku (x + 1; 23)) a rad y = 26 pre nosiče. */
export const ROADS: readonly CellCoord[] = [...row(23, 34, 56), ...row(26, 34, 56)];

/** Kamión smerom na východ s hlavou v bunke (headX; 23), stopou o 1 a 2 bunky späť a kontajnerom `cargo` (`null` = prázdny náves). */
function truckEast(id: number, headX: number, cargo: ContainerVM | null): TruckVM {
  return truckOnTrail(id, centerOf(headX, 23), 90, [centerOf(headX - 1, 23), centerOf(headX - 2, 23)], {
    state: 'to_gate_out',
    loaded: cargo !== null,
    cargo,
  });
}

/** Nosič (straddle carrier, ECH) smerom na východ s hlavou v bunke (headX; 26) a kontajnerom `cargo`. */
function carrierEast(id: number, defId: string, headX: number, cargo: ContainerVM | null): VehicleVM {
  return carrierOnTrail(id, centerOf(headX, 26), 90, [centerOf(headX - 1, 26)], { defId, state: cargo === null ? 'to_pickup' : 'to_dropoff', loaded: cargo !== null, cargo });
}

export const TRUCK_20 = 101;
export const TRUCK_40 = 102;
export const TRUCK_EMPTY_40 = 103;
export const STRADDLE_40 = 111;
export const STRADDLE_20 = 112;
export const ECH_EMPTY_20 = 113;
export const ECH_EMPTY_40 = 114;
export const ECH_FREE = 115;

export const TRUCKS: readonly TruckVM[] = [
  truckEast(TRUCK_20, 40, dry(20, BLUE)), //  20′ vpredu na návese
  truckEast(TRUCK_40, 44, dry(40, AMBER)), //  40′ na celej dĺžke
  truckEast(TRUCK_EMPTY_40, 48, emptyBox(40, TEAL)),
];

export const CARRIERS: readonly VehicleVM[] = [
  carrierEast(STRADDLE_40, 'straddle_carrier', 39, dry(40, TEAL)),
  carrierEast(STRADDLE_20, 'straddle_carrier', 42, dry(20, AMBER, 'export')),
  carrierEast(ECH_EMPTY_20, 'empty_handler', 45, emptyBox(20, BLUE)),
  carrierEast(ECH_EMPTY_40, 'empty_handler', 49, emptyBox(40, AMBER)),
  carrierEast(ECH_FREE, 'empty_handler', 53, null),
];

const VM: EntitiesVM = { modules: [BLOCK, DEPOT], cranes: [], ships: [], vehicles: CARRIERS, trucks: TRUCKS };

export const R2_SCENES = Object.freeze({
  terminal: { roads: ROADS, vm: VM, view: { centerX: 46, centerY: 23.5, zoom: 0.95 } } satisfies R2Scene,
  block: { roads: ROADS, vm: VM, view: { centerX: 38, centerY: 21, zoom: 2.4 } } satisfies R2Scene,
  depot: { roads: ROADS, vm: VM, view: { centerX: 44, centerY: 21, zoom: 2.4 } } satisfies R2Scene,
  vehicles: { roads: ROADS, vm: VM, view: { centerX: 45, centerY: 24.5, zoom: 1.4 } } satisfies R2Scene,
});
export type R2SceneName = keyof typeof R2_SCENES;

/** Mriežka pre scénu: terén mapy + cesty scény (rovnako ako R1, štartová cesta mapy sa odstráni). */
export function createR2Grid(map: LoadedMap, scene: R2Scene): Grid {
  return createR1Grid(map, scene);
}
