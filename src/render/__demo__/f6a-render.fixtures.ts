/**
 * Pevné view-modely pre demo renderu Fázy 6a (`f6a-render.html`, T6A-06: export a booking) — bez simu a bez živých dát exportu
 * (správanie dodá T6A-04/05), preto na syntetických snímkach.
 *
 * Scény (`?scene=<názov>`):
 *  - `ships` (c, d, b): berth s apronom a jednotkou vo VGM hold na slote, žeriav pri nakládke (smer apron → loď), kontajnerová loď
 *    pri berthe s importom aj exportom na palube, handy loď v stave `lashing` s prstencom postupu a rad lodí s rôznym zaplnením
 *    palubného nákladu (prázdna, len import, len export, zmiešaná);
 *  - `hold` (e): sklad s jednotkami v hold (odznak s počtom v rohu), berth so slotom v hold.
 *
 * Geometria (vonkajšie bunky konektorov) sa počíta z manifestu rovnako ako v sime;
 * `tests/render/f6a-render-fixtures.test.ts` stráži, že scény sú konzistentné (moduly sa neprekrývajú, cesty sú pri konektoroch,
 * VM polia sedia na manifest).
 */
import { berthVM, craneVM, shipVM } from './f2-render.fixtures';
import { SCALE_ROADS, carrierAt, yardVM, type T5b03Scene } from './t5b03-render.fixtures';
import type { CraneCycleVM, CraneVM, EntitiesVM, ModuleVM, ShipVM } from '../view-models';

/** Scéna dema: rovnaký tvar ako scény T5B-03 (cesty, VM, kamera), takže ich zdieľa `createT5b03Grid`. */
export type F6aScene = T5b03Scene;

// ---- žeriav --------------------------------------------------------------------------------------------------------

export const CRANE_ID = 2;
export const BERTH_ID = 1;

/** Berth (40; 14) s tromi jednotkami na aprone; jednotka na slote 2 je vo VGM hold (odznak pri slote). */
export const SHIPS_BERTH: ModuleVM = { ...berthVM(BERTH_ID, 40, 14, 0, [0, 2, 5]), held: { count: 1, slots: [2] }, connected: true };

/** Žeriav na berthe v zadanej fáze, smere cyklu a s držanou jednotkou. */
export function craneAt(state: CraneVM['state'], progress: number, cycle: CraneCycleVM, holding = false): CraneVM {
  return craneVM(CRANE_ID, SHIPS_BERTH, {
    state,
    progress,
    cycle,
    holding: holding ? { unitId: 9001, typeId: 'container_teu' } : null,
  });
}

// ---- lode ----------------------------------------------------------------------------------------------------------

/** Loď pri berthe: feeder s importom (40) aj exportom (20) z kapacity 120 — na palube dva bloky, import od predku, export od zadku. */
export const DOCKED_FEEDER: ShipVM = shipVM(31, 'feeder', 43, 13, 90, {
  unitsOnBoard: 60,
  capacityUnits: 120,
  cargoSplit: { import: 40, export: 20 },
});

/** Handy loď v lashingu: samé exporty (200 z 300), prstenec na 62,5 % (150 z 400 tickov zostáva). */
export const LASHING_HANDY: ShipVM = shipVM(32, 'handy', 54, 12, 90, {
  state: 'lashing',
  unitsOnBoard: 200,
  capacityUnits: 300,
  cargoSplit: { import: 0, export: 200 },
  lashing: { ticksLeft: 150, ticksTotal: 400 },
});

/** Rad feederov s rôznym zaplnením palubného nákladu: prázdna, len import, len export, zmiešaná (viď `deckFill`). */
export const DECK_ROW: readonly ShipVM[] = [
  shipVM(41, 'feeder', 36, 6, 90, { unitsOnBoard: 0, capacityUnits: 120, cargoSplit: { import: 0, export: 0 } }),
  shipVM(42, 'feeder', 44, 6, 90, { unitsOnBoard: 100, capacityUnits: 120, cargoSplit: { import: 100, export: 0 } }),
  shipVM(43, 'feeder', 52, 6, 90, { unitsOnBoard: 100, capacityUnits: 120, cargoSplit: { import: 0, export: 100 } }),
  shipVM(44, 'feeder', 60, 6, 90, { unitsOnBoard: 120, capacityUnits: 120, cargoSplit: { import: 60, export: 60 } }),
];

export const SHIPS_SCENE: F6aScene = {
  roads: [],
  vm: {
    modules: [SHIPS_BERTH],
    cranes: [craneAt('placing', 0.5, 'load', true)],
    ships: [DOCKED_FEEDER, LASHING_HANDY, ...DECK_ROW],
    vehicles: [],
    trucks: [],
  },
  view: { centerX: 48, centerY: 10, zoom: 0.62 },
};

// ---- sklad a berth s jednotkami v hold ----------------------------------------------------------------------

const HOLD_YARD = { ...yardVM(3, 44, 19, 32), held: { count: 3 } };
const HOLD_BERTH: ModuleVM = { ...SHIPS_BERTH };

export const HOLD_SCENE: F6aScene = {
  roads: SCALE_ROADS,
  vm: {
    modules: [HOLD_BERTH, HOLD_YARD].map((module) => ({ ...module, connected: true })),
    cranes: [craneVM(CRANE_ID, HOLD_BERTH, { state: 'idle' })],
    ships: [],
    vehicles: [carrierAt(11, 43, 23, 90, true)],
    trucks: [],
  },
  view: { centerX: 47, centerY: 20, zoom: 0.9 },
};

export const F6A_SCENES = Object.freeze({ ships: SHIPS_SCENE, hold: HOLD_SCENE });
export type F6aSceneName = keyof typeof F6A_SCENES;

/** VM scény s nahradenými kamiónmi / žeriavmi / loďami (pre test, ktorý scénu postupne mení). */
export function withEntities(vm: EntitiesVM, patch: Partial<EntitiesVM>): EntitiesVM {
  return { ...vm, ...patch };
}
