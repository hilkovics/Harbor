/**
 * Rozloženie prístavu pre scenáre fázy 4 (T04-05, TDD): rozloženie F3 (`f3-layout.ts`: cesty, depo, dva dvory) + pozemná
 * časť exportu — brána, čakacia plocha, rampa a cesty k nim — na starter parcele mapy `harbor_01`. Čistý dátový modul
 * bez behových závislostí na sim; `data/scenarios/full_import_chain.json` je presne výstup
 * `f4Scenario('full_import_chain', 4004, …)` (test `f4-full-import-chain` to overuje).
 *
 * Mapa: starter parcela x 30–57, y 14–33; road portál `road_south` (44, 63); verejná cesta x = 44, y 34..63. Brána musí
 * ležať na parcele (moduly len na vlastnenej parcele), takže jej vstup nadväzuje na verejnú cestu v bunke (44, 33).
 *
 * ```
 *   x:    44 45 46 47 48 49 50 51 52 53 54 55 56      # cesta, o cesta = vonkajšia bunka konektora
 *   y=26   #  .  .  .  .  B  B  B  B  .  .  .  .      D depo (46, 27), B ďaleký dvor (49, 26)   (F3)
 *   y=27   #  .  D  D  D  B  B  B  B  .  .  .  .      R rampa (53, 28) rot 0
 *   y=28   #  .  D  D  D  B  B  B  B  R  R  R  R      W čakacia plocha (49, 31) rot 0
 *   y=29   #  .  D  D  D  B  B  B  B  R  R  R  R      G brána (45, 32) rot 270
 *   y=30   #  #  #  o  #  #  o  #  #  #  o  o  .      vetva y = 30: F3 po (50, 30), predĺženie po (55, 30)
 *   y=31   .  .  .  .  .  W  W  W  W  #  .  .  .
 *   y=32   .  G  G  .  .  W  W  W  W  #  .  .  .
 *   y=33   o  G  G  o  o  W  W  W  W  o  .  .  .      (44, 33) vstup brány, (47, 33) výstup brány,
 *   y=34   #  .  .  .  .  .  .  .  .  .  .  .  .      (48, 33) západ plochy, (53, 33) východ plochy
 * ```
 * Reťaz kamióna: portál (44, 63) → x = 44 na sever → (44, 33) vstup brány → telom brány (rot 270, konektor `w` na
 * bunke (45, 33), konektor `e` na (46, 33)) → (47, 33) výstup → (48, 33) → telom plochy (konektor `w` (49, 33), konektor
 * `e` (52, 33)) → (53, 33) → x = 53 na sever (53, 31..33) → (53, 30) vetva → (54, 30) dock 0 / (55, 30) dock 1 (vonkajšie
 * bunky konektorov rampy `(1, 1, s)` a `(2, 1, s)`).
 *
 * Brána je jediné spojenie verejnej cesty s areálom a plocha je jediné spojenie výstupu brány s vetvou F3: medzi
 * (44, 33) a (47, 33) ani medzi (48, 33) a (53, 33) nevedie žiadna cesta (bunky (44, 31), (47, 31), (47, 32) sú prázdne),
 * takže rampa je prevádzková len s bránou aj plochou (prvý `describe` v `f4-landside.test.ts` to overuje BFS po cestách).
 *
 * Poradie príkazov (id modulov): starter berth 1 + žeriav 2, potom depo 3, dvory 4 a 5, brána 6, plocha 7, rampa 8.
 */
import type { CellCoord, Rotation } from '@sim/grid';
import { ROAD_SEGMENTS as F3_ROAD_SEGMENTS, segment } from './f3-layout';
import type { F3Options } from './f3-layout';
import type { Scenario, ScenarioEntry } from './scenario';

export { segment } from './f3-layout';

/** Road portál `road_south` mapy `harbor_01`. */
export const ROAD_PORTAL: CellCoord = { x: 44, y: 63 };
/** Posledná bunka verejnej cesty pred areálom (štartová cesta x = 44, y 34..63). */
export const PUBLIC_ROAD_END: CellCoord = { x: 44, y: 34 };

export type LandsideKind = 'gate' | 'waiting_area' | 'ramp';

export interface LandsidePlacement {
  readonly defId: string;
  readonly kind: LandsideKind;
  /** Ľavý horný roh footprintu po rotácii. */
  readonly origin: CellCoord;
  readonly rotation: Rotation;
}

/** Brána 2×2 otočená o 270°: oba konektory sú na spodnom riadku — `w` na (45, 33), `e` na (46, 33). */
export const GATE: LandsidePlacement = { defId: 'truck_gate', kind: 'gate', origin: { x: 45, y: 32 }, rotation: 270 };
/** Čakacia plocha 4×3 (rot 0): konektory `w` (49, 33) a `e` (52, 33). */
export const WAITING_AREA: LandsidePlacement = { defId: 'truck_waiting_area', kind: 'waiting_area', origin: { x: 49, y: 31 }, rotation: 0 };
/** Rampa 4×2 (rot 0): konektory `s` na (54, 29) a (55, 29). */
export const RAMP: LandsidePlacement = { defId: 'loading_ramp_container', kind: 'ramp', origin: { x: 53, y: 28 }, rotation: 0 };

export const LANDSIDE_PLACEMENTS: Readonly<Record<LandsideKind, LandsidePlacement>> = { gate: GATE, waiting_area: WAITING_AREA, ramp: RAMP };
/** Predvolené poradie stavby pozemných modulov (id 6, 7, 8). */
export const DEFAULT_LANDSIDE_ORDER: readonly LandsideKind[] = ['gate', 'waiting_area', 'ramp'];

/** Vonkajšia bunka konektora brány, ktorý nadväzuje na verejnú cestu (vstup). */
export const GATE_ENTRY_OUTSIDE: CellCoord = { x: 44, y: 33 };
/** Vonkajšia bunka druhého konektora brány (výstup do areálu). */
export const GATE_EXIT_OUTSIDE: CellCoord = { x: 47, y: 33 };
export const WAITING_WEST_OUTSIDE: CellCoord = { x: 48, y: 33 };
export const WAITING_EAST_OUTSIDE: CellCoord = { x: 53, y: 33 };
/** Vonkajšie bunky konektorov rampy v poradí defu (dock 0, dock 1). */
export const RAMP_OUTSIDE_CELLS: readonly CellCoord[] = [
  { x: 54, y: 30 },
  { x: 55, y: 30 },
];

/** Cesty pozemnej časti; PlaceRoad po úsekoch, rovnako ako `ROAD_SEGMENTS` z F3. */
export const F4_ROAD_SEGMENTS = {
  /** Vstup brány: (44, 33) nadväzuje na verejnú cestu (44, 34). */
  gateApproach: segment(44, 33, 44, 33),
  /** Výstup brány (47, 33) a západná vonkajšia bunka plochy (48, 33). */
  gateExit: segment(47, 33, 48, 33),
  /** Východná vonkajšia bunka plochy (53, 33) a cesta na sever k vetve. */
  truckLink: segment(53, 31, 53, 33),
  /** Predĺženie vetvy y = 30 z (51, 30) po (55, 30): vonkajšie bunky rampy (54, 30) a (55, 30). */
  branchExtension: segment(51, 30, 55, 30),
} as const;

export type F4RoadSegmentName = keyof typeof F4_ROAD_SEGMENTS;

/** Cesty pozemnej časti (11 buniek). */
export const F4_ROAD_CELLS: readonly CellCoord[] = Object.values(F4_ROAD_SEGMENTS).flat();
/** Všetky cesty scenára F4: 34 buniek F3 + 11 buniek pozemnej časti. */
export const ALL_F4_ROAD_CELLS: readonly CellCoord[] = [...Object.values(F3_ROAD_SEGMENTS).flat(), ...F4_ROAD_CELLS];

export interface F4Options extends Pick<F3Options, 'vehicles' | 'units' | 'omitRoadCells' | 'extra'> {
  /** Ktoré pozemné moduly postaviť a v akom poradí (predvolene brána, plocha, rampa); chýbajúci sa nepostaví. */
  readonly landside?: readonly LandsideKind[];
  /** Ktoré dvory postaviť (predvolene oba: blízky, potom ďaleký). */
  readonly yards?: readonly ('near' | 'far')[];
}

const sameCell = (a: CellCoord, b: CellCoord): boolean => a.x === b.x && a.y === b.y;

const YARD_ORIGIN: Readonly<Record<'near' | 'far', CellCoord>> = { near: { x: 42, y: 18 }, far: { x: 49, y: 26 } };
const DEPOT_ORIGIN: CellCoord = { x: 46, y: 27 };
/** ID depa: starter berth 1 + žeriav 2, depo je prvý `PlaceModule`. */
export const F4_DEPOT_ID = 3;

/**
 * Scenár na `harbor_01`: (1) cesty F3, potom cesty pozemnej časti (jeden `PlaceRoad` na úsek), (2) depo, (3) dvory,
 * (4) pozemné moduly v `landside` poradí, (5) nákupy vozidiel, (6) loď — všetko na ticku 0. Cesty idú pred modulmi, takže
 * konektory sú pripojené hneď pri stavbe. `omitRoadCells` vynechá jednotlivé bunky (napr. vstup brány).
 */
export function f4Scenario(id: string, seed: number, options: F4Options = {}): Scenario {
  const { vehicles = [], units = 0, omitRoadCells = [], extra = [], landside = DEFAULT_LANDSIDE_ORDER, yards = ['near', 'far'] } = options;
  const commands: ScenarioEntry[] = [];
  const add = (command: ScenarioEntry['command']): void => {
    commands.push({ atTick: 0, command });
  };

  for (const cells of [...Object.values(F3_ROAD_SEGMENTS), ...Object.values(F4_ROAD_SEGMENTS)]) {
    const kept = cells.filter((cell) => !omitRoadCells.some((omitted) => sameCell(omitted, cell)));
    if (kept.length > 0) add({ type: 'PlaceRoad', cells: kept });
  }
  add({ type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_ORIGIN.x, y: DEPOT_ORIGIN.y, rotation: 0 });
  for (const spot of yards) {
    add({ type: 'PlaceModule', defId: 'container_yard_small', x: YARD_ORIGIN[spot].x, y: YARD_ORIGIN[spot].y, rotation: 0 });
  }
  for (const kind of landside) add(placeLandsideCommand(kind));
  for (const vehicleDefId of vehicles) add({ type: 'BuyVehicle', vehicleDefId, depotId: F4_DEPOT_ID });
  if (units > 0) add({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units });

  return { id, seed, map: 'data/maps/harbor_01.json', commands: [...commands, ...extra] };
}

/** Príkaz `PlaceModule` pre pozemný modul na jeho mieste v rozložení. */
export function placeLandsideCommand(kind: LandsideKind): ScenarioEntry['command'] {
  const { defId, origin, rotation } = LANDSIDE_PLACEMENTS[kind];
  return { type: 'PlaceModule', defId, x: origin.x, y: origin.y, rotation };
}
