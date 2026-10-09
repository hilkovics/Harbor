/**
 * Pevné view-modely pre demo renderu Fázy 6c (`f6c-render.html`, T6C-04: prázdne kontajnery, depo prázdnych, empty handler) — bez simu
 * a bez živých dát prázdnych (správanie dodajú T6C-02 / T6C-03), preto na syntetických snímkach.
 *
 * Scény (`?scene=<názov>`):
 *  - `ships`: berth s apronom, kde stoja plné aj prázdne kontajnery (prázdne sivé s pásikom farby linky), žeriav nakladá prázdny
 *    kontajner, loď pri berthe a rad lodí s importom / exportom / prázdnymi na palube (prázdne tesne pred exportom);
 *  - `depot`: depo prázdnych (sivé kontajnery na svetlej ploche) s odznakmi poškodených a opráv a dvor kontajnerov (oranžové) pre
 *    porovnanie; po ceste jazdí empty handler (s prázdnym kontajnerom aj bez), straddle carrier s prázdnym a s plným kontajnerom
 *    a kamión s prázdnym kontajnerom;
 *  - `gate`: vstupný pruh brány pri ceste a kamióny s prázdnym a s plným kontajnerom (stav nákladu na návese).
 *
 * `tests/render/f6c-render-fixtures.test.ts` stráži, že scény sú konzistentné (moduly sa neprekrývajú, cesty nevedú cez moduly,
 * lode ležia na vode, VM polia sedia na manifest).
 */
import { rotateFootprint, type CellCoord } from '@sim/grid';
import { moduleSprite } from '../entity-assets';
import type { CraneVM, EntitiesVM, ModuleVM, ShipVM, TruckVM, VehicleVM, ViewRotation } from '../view-models';
import { berthVM, craneVM, shipVM } from './f2-render.fixtures';
import { gateLaneVM, truckAt } from './f4-render.fixtures';
import type { T5b03Scene } from './t5b03-render.fixtures';

/** Scéna dema: rovnaký tvar ako scény T5B-03 (cesty, VM, kamera), takže ju zdieľa `createT5b03Grid`. */
export type F6cScene = T5b03Scene;

export const BERTH_ID = 1;
export const CRANE_ID = 2;
export const YARD_ID = 3;
export const GATE_ID = 4;
export const DEPOT_ID = 5;

/** Typ nákladu prázdneho kontajnera (prázdne sú vždy kontajnery TEU). */
const CONTAINER = 'container_teu';

function row(y: number, x1: number, x2: number): CellCoord[] {
  return Array.from({ length: x2 - x1 + 1 }, (_, i) => ({ x: x1 + i, y }));
}

function column(x: number, y1: number, y2: number): CellCoord[] {
  return Array.from({ length: y2 - y1 + 1 }, (_, i) => ({ x, y: y1 + i }));
}

/** Modul bez dynamických polí: footprint z manifestu po rotácii. */
function plainModule(id: number, defId: string, kind: string, x: number, y: number): ModuleVM {
  const base = moduleSprite(defId)?.footprint;
  if (base === undefined) throw new Error(`demo: modul "${defId}" nie je v manifeste`);
  const size = rotateFootprint(base.w, base.h, 0);
  return { id, defId, kind, x, y, rotation: 0, w: size.w, h: size.h, connected: true };
}

// ---- scéna `ships` -------------------------------------------------------------------------------------------------

/**
 * Berth (40; 14) s piatimi jednotkami na aprone: plné kontajnery (sloty 0, 2), prázdne s pásikom farby linky (sloty 1, 4 — modrá, 5 — jantárová).
 */
export const SHIPS_BERTH: ModuleVM = (() => {
  const berth = berthVM(BERTH_ID, 40, 14, 0, [0, 1, 2, 4, 5]);
  const marks: Readonly<Record<number, { empty: true; lineToken: string }>> = {
    1: { empty: true, lineToken: 'line-blue' },
    4: { empty: true, lineToken: 'line-blue' },
    5: { empty: true, lineToken: 'line-amber' },
  };
  const units = (berth.apron?.units ?? []).map((unit) => ({ ...unit, ...(marks[unit.slot] ?? {}) }));
  return { ...berth, connected: true, apron: { capacity: berth.apron?.capacity ?? 0, units } };
})();

/** Žeriav nakladá prázdny kontajner na loď (cyklus `load`, fáza `placing`): kontajner pod vozíkom je sivý. */
export function craneLoadingEmpty(progress = 0.5): CraneVM {
  return craneVM(CRANE_ID, SHIPS_BERTH, { state: 'placing', progress, cycle: 'load', holding: { unitId: 9101, typeId: CONTAINER, empty: true } });
}

/** Žeriav nakladá plný kontajner (porovnanie s oranžovým). */
export function craneLoadingFull(progress = 0.5): CraneVM {
  return craneVM(CRANE_ID, SHIPS_BERTH, { state: 'placing', progress, cycle: 'load', holding: { unitId: 9102, typeId: CONTAINER } });
}

/** Loď pri berthe: import (40), export (20) aj prázdne (20) z kapacity 120 — tri bloky na palube. */
export const DOCKED_FEEDER: ShipVM = shipVM(31, 'feeder', 43, 13, 90, {
  unitsOnBoard: 80,
  capacityUnits: 120,
  cargoSplit: { import: 40, export: 20, empty: 20 },
});

/** Rad feederov: import + prázdne, export + prázdne, len prázdne a import + export + prázdne. */
export const DECK_ROW: readonly ShipVM[] = [
  shipVM(51, 'feeder', 36, 6, 90, { unitsOnBoard: 100, capacityUnits: 120, cargoSplit: { import: 60, export: 0, empty: 40 } }),
  shipVM(52, 'feeder', 44, 6, 90, { unitsOnBoard: 100, capacityUnits: 120, cargoSplit: { import: 0, export: 50, empty: 50 } }),
  shipVM(53, 'feeder', 52, 6, 90, { unitsOnBoard: 80, capacityUnits: 120, cargoSplit: { import: 0, export: 0, empty: 80 } }),
  shipVM(54, 'feeder', 60, 6, 90, { unitsOnBoard: 120, capacityUnits: 120, cargoSplit: { import: 40, export: 40, empty: 40 } }),
];

export const SHIPS_SCENE: F6cScene = {
  roads: [],
  vm: {
    modules: [SHIPS_BERTH],
    cranes: [craneLoadingEmpty()],
    ships: [DOCKED_FEEDER, ...DECK_ROW],
    vehicles: [],
    trucks: [],
  },
  view: { centerX: 48, centerY: 10, zoom: 0.62 },
};

// ---- scéna `depot` -------------------------------------------------------------------------------------------------

/** Cesty scény: rad (41…53; 23) pod dvormi — konektory dvora a depa (stred 4×4, `connectors[0]` na (1; 3) strany `s`) majú vonkajšiu bunku (x + 1; 23). */
export const DEPOT_ROADS: readonly CellCoord[] = row(23, 41, 53);

/** Depo prázdnych (44; 19): 56 z 96 miest, poškodené (3), v oprave (2 z 2 miest) a posledná operácia — uloženie prázdneho. */
export const DEPOT: ModuleVM = {
  ...plainModule(DEPOT_ID, 'empty_depot', 'storage', 44, 19),
  storage: { capacity: 96, stored: 56, reserved: 0 },
  depot: { available: 51, damaged: 3, inRepair: 2, repairBays: 2 },
  lastStorageOp: { slot: 5, tick: 100, kind: 'put' },
};

/** Depo bez problémov: 20 z 96 miest, nič poškodené ani v oprave (bez odznakov). */
export const DEPOT_CLEAN: ModuleVM = {
  ...plainModule(6, 'empty_depot', 'storage', 40, 19),
  storage: { capacity: 96, stored: 20, reserved: 0 },
  depot: { available: 20, damaged: 0, inRepair: 0, repairBays: 2 },
};

/** Kontajnerový dvor (48; 19) pre porovnanie: oranžové kontajnery na tmavšej ploche; 32 z 64 miest. */
export const COMPARE_YARD: ModuleVM = {
  ...plainModule(YARD_ID, 'container_yard_small', 'storage', 48, 19),
  storage: { capacity: 64, stored: 32, reserved: 0 },
  lastStorageOp: { slot: 3, tick: 90, kind: 'take' },
};

/** Vozidlo v strede bunky (cellX, cellY) s kurzom `heading`; `carriesEmpty` = vezie prázdny kontajner. */
export function vehicleAt(id: number, defId: string, cellX: number, cellY: number, heading: ViewRotation, loaded: boolean, carriesEmpty = false): VehicleVM {
  const x = cellX + 0.5;
  const y = cellY + 0.5;
  const vm: VehicleVM = { id, defId, x, y, prevX: x, prevY: y, heading, prevHeading: heading, loaded, state: loaded ? 'to_dropoff' : 'to_pickup' };
  return carriesEmpty ? { ...vm, carriesEmpty } : vm;
}

/** Kamión v strede bunky (cellX, cellY) s kurzom `heading`; `carriesEmpty` = vezie prázdny kontajner. */
export function truckInCell(id: number, cellX: number, cellY: number, heading: ViewRotation, loaded: boolean, state: string, carriesEmpty = false): TruckVM {
  const vm = truckAt(id, cellX + 0.5, cellY + 0.5, heading, loaded, state);
  return carriesEmpty ? { ...vm, carriesEmpty } : vm;
}

export const HANDLER_LOADED = 61;
export const HANDLER_EMPTY = 62;
export const CARRIER_EMPTY_BOX = 63;
export const CARRIER_FULL_BOX = 64;
export const TRUCK_EMPTY_BOX = 65;

/** Empty handler (s prázdnym kontajnerom aj bez), straddle carrier s prázdnym a s plným kontajnerom a kamión s prázdnym kontajnerom. */
export const DEPOT_VEHICLES: readonly VehicleVM[] = [
  vehicleAt(HANDLER_EMPTY, 'empty_handler', 42, 23, 90, false),
  vehicleAt(HANDLER_LOADED, 'empty_handler', 45, 23, 90, true, true),
  vehicleAt(CARRIER_EMPTY_BOX, 'straddle_carrier', 47, 23, 90, true, true),
  vehicleAt(CARRIER_FULL_BOX, 'straddle_carrier', 49, 23, 90, true),
];

export const DEPOT_TRUCKS: readonly TruckVM[] = [truckInCell(TRUCK_EMPTY_BOX, 52, 23, 270, true, 'to_gate_out', true)];

export const DEPOT_SCENE: F6cScene = {
  roads: DEPOT_ROADS,
  vm: { modules: [DEPOT_CLEAN, DEPOT, COMPARE_YARD], cranes: [], ships: [], vehicles: DEPOT_VEHICLES, trucks: DEPOT_TRUCKS },
  view: { centerX: 46.5, centerY: 21.4, zoom: 1.25 },
};

// ---- scéna `gate` -------------------------------------------------------------------------------------------------

/** Cesta popri pruhu brány (51; 22): stĺpec (50; 17…26) a rad (50…53; 26) ako v scéne `scale` F5b. */
export const GATE_ROADS: readonly CellCoord[] = [...column(50, 17, 26), ...row(26, 50, 53)];

/** Vstupný pruh brány so strechou, bez kroku (závora hore). */
export const GATE: ModuleVM = gateLaneVM(GATE_ID, 'gate_in_lane', 51, 22, { kind: 'in', mode: 'normal', roofPart: 'single' });

export const GATE_TRUCKS: readonly TruckVM[] = [
  truckInCell(71, 50, 19, 180, true, 'to_gate', true), // prichádza s návratom prázdneho kontajnera
  truckInCell(72, 50, 22, 0, true, 'to_gate_out'), // odchádza s plným
];

export const GATE_SCENE: F6cScene = {
  roads: GATE_ROADS,
  vm: { modules: [GATE], cranes: [], ships: [], vehicles: [], trucks: GATE_TRUCKS },
  view: { centerX: 51.5, centerY: 23, zoom: 1.6 },
};

export const F6C_SCENES = Object.freeze({ ships: SHIPS_SCENE, depot: DEPOT_SCENE, gate: GATE_SCENE });
export type F6cSceneName = keyof typeof F6C_SCENES;

/** VM scény s nahradenými kamiónmi / žeriavmi / loďami (pre test, ktorý scénu postupne mení). */
export function withEntities(vm: EntitiesVM, patch: Partial<EntitiesVM>): EntitiesVM {
  return { ...vm, ...patch };
}
