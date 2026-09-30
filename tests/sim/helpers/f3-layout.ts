/**
 * Rozloženie prístavu pre scenáre fázy 3 (T03-07, TDD): cesty, depo a dva kontajnerové dvory na starter parcele
 * mapy `harbor_01` + skladačka scenárov nad ním. Čistý dátový modul bez behových závislostí na sim — rovnaké
 * rozloženie používa `data/scenarios/apron_to_yard.json` (test `f3-apron-to-yard` overuje, že súbor = výstup
 * `f3Scenario('apron_to_yard', 3003, …)`) aj ostatné scenáre `f3-*` s upraveným počtom jednotiek/vozidiel/dvorov.
 *
 * Mapa: Root berth x 40–47, y 14–16 (rot 0); pevnina y ≥ 17; starter parcela x 30–57, y 14–33. Konektory berthu
 * majú vonkajšie bunky (41, 17) a (46, 17). Dvor 4×4 má konektor lokálne (1, 3) `s` → vonkajšia bunka (x + 1, y + 4);
 * depo 3×3 konektor (1, 2) `s` → vonkajšia bunka (x + 1, y + 3) (data/defs/modules.json).
 *
 * ```
 *   x:    41 42 43 44 45 46 47 48 49 50 51 52      # cesta, o cesta = vonkajšia bunka konektora,
 *   y=17   o  #  #  #  #  o  .  .  .  .  .  .      A blízky dvor (42..45 × 18..21), B ďaleký dvor
 *   y=18   #  A  A  A  A  #  .  .  .  .  .  .      (49..52 × 26..29), D depo (46..48 × 27..29)
 *   y=21   #  A  A  A  A  #  .  .  .  .  .  .
 *   y=22   #  #  o  #  #  #  .  .  .  .  .  .
 *   y=23   .  .  .  #  .  .  .  .  .  .  .  .
 *   y=26   .  .  .  #  .  .  .  .  B  B  B  B
 *   y=27   .  .  .  #  .  D  D  D  B  B  B  B
 *   y=30   .  .  .  #  #  #  o  #  #  o  .  .
 * ```
 * Vonkajšie bunky (x, y): berth (41, 17) a (46, 17), dvor A (43, 22), depo (47, 30), dvor B (50, 30).
 *
 * Cesta berth → blízky dvor: 7 krokov (západná noha dole + priečka), berth → ďaleký dvor: 21 krokov. Horná spojka
 * y=17 tvorí s nohami a priečkou okruh, takže existuje aj obchádzka (testy preplánovania).
 */
import type { EntityId } from '@sim/core';
import type { CellCoord } from '@sim/grid';
import type { Scenario, ScenarioEntry } from './scenario';

/** ID depa v scenároch: starter moduly majú id 1 (berth) a 2 (žeriav), depo je prvý `PlaceModule` → 3. */
export const DEPOT_ID = 3;
/** `DEPOT_ID` ako branded `EntityId` (na `world.modules.get`). */
export const DEPOT_ENTITY_ID = DEPOT_ID as EntityId;

export const DEPOT_ORIGIN: CellCoord = { x: 46, y: 27 };
export const NEAR_YARD_ORIGIN: CellCoord = { x: 42, y: 18 };
export const FAR_YARD_ORIGIN: CellCoord = { x: 49, y: 26 };

/** Vonkajšie bunky konektorov Root berthu (lokálne (1, 2) a (6, 2), strana `s`). */
export const BERTH_OUTSIDE_CELLS: readonly CellCoord[] = [
  { x: 41, y: 17 },
  { x: 46, y: 17 },
];
export const NEAR_YARD_OUTSIDE: CellCoord = { x: 43, y: 22 };
export const FAR_YARD_OUTSIDE: CellCoord = { x: 50, y: 30 };
export const DEPOT_OUTSIDE: CellCoord = { x: 47, y: 30 };

/** Bunky obdĺžnika `x0..x1` × `y0..y1` (vrátane), row-major. */
export function segment(x0: number, y0: number, x1: number, y1: number): CellCoord[] {
  const cells: CellCoord[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.push({ x, y });
  }
  return cells;
}

/** Úseky ciest v poradí, v akom ich scenár stavia (jeden `PlaceRoad` na úsek). */
export const ROAD_SEGMENTS = {
  /** Západná noha: berth (41, 17) → priečka (41, 22). */
  westLeg: segment(41, 17, 41, 22),
  /** Východná noha: berth (46, 17) → priečka (46, 22). */
  eastLeg: segment(46, 17, 46, 22),
  /** Priečka y=22 medzi nohami; (43, 22) je vonkajšia bunka blízkeho dvora. */
  trunk: segment(42, 22, 45, 22),
  /** Horná spojka y=17 medzi vonkajšími bunkami berthu (okruh → obchádzka). */
  topLink: segment(42, 17, 45, 17),
  /** Chrbtica x=44 z priečky na juh. */
  spine: segment(44, 23, 44, 30),
  /** Vetva y=30: (47, 30) je vonkajšia bunka depa, (50, 30) ďalekého dvora. */
  branch: segment(45, 30, 50, 30),
} as const;

export type RoadSegmentName = keyof typeof ROAD_SEGMENTS;

/** Všetky cesty rozloženia (34 buniek). */
export const ALL_ROAD_CELLS: readonly CellCoord[] = Object.values(ROAD_SEGMENTS).flat();

export type YardSpot = 'near' | 'far';

const YARD_ORIGIN: Readonly<Record<YardSpot, CellCoord>> = { near: NEAR_YARD_ORIGIN, far: FAR_YARD_ORIGIN };

export interface F3Options {
  /** Ktoré dvory postaviť (predvolene oba: `near`, potom `far`). */
  readonly yards?: readonly YardSpot[];
  /** Def id vozidiel na kúpu v poradí (predvolene žiadne); všetky idú do depa `DEPOT_ID`. */
  readonly vehicles?: readonly string[];
  /** Počet TEU na lodi `feeder` spawnutej na ticku 0; 0 = bez lode (predvolene). */
  readonly units?: number;
  /** Cesty, ktoré sa nepostavia (napr. `FAR_YARD_OUTSIDE` → ďaleký dvor ostane nepripojený). */
  readonly omitRoadCells?: readonly CellCoord[];
  /** Ďalšie príkazy (napr. dodatočná cesta neskôr); pridajú sa na koniec. */
  readonly extra?: readonly ScenarioEntry[];
}

const sameCell = (a: CellCoord, b: CellCoord): boolean => a.x === b.x && a.y === b.y;

/**
 * Scenár na `harbor_01`: (1) cesty po úsekoch, (2) depo (id 3), (3) dvory, (4) nákupy vozidiel, (5) loď — všetko na
 * ticku 0 v tomto poradí (id sa prideľujú v poradí `PlaceModule`, preto depo ide prvé). Cesty idú pred modulmi, takže
 * konektory sú pripojené hneď pri stavbe (ARCHITECTURE §8 bod 5 aj `BuyVehicle`).
 */
export function f3Scenario(id: string, seed: number, options: F3Options = {}): Scenario {
  const { yards = ['near', 'far'], vehicles = [], units = 0, omitRoadCells = [], extra = [] } = options;
  const commands: ScenarioEntry[] = [];
  const add = (command: ScenarioEntry['command']): void => {
    commands.push({ atTick: 0, command });
  };

  for (const cells of Object.values(ROAD_SEGMENTS)) {
    const kept = cells.filter((cell) => !omitRoadCells.some((omitted) => sameCell(omitted, cell)));
    if (kept.length > 0) add({ type: 'PlaceRoad', cells: kept });
  }
  add({ type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_ORIGIN.x, y: DEPOT_ORIGIN.y, rotation: 0 });
  for (const spot of yards) {
    add({ type: 'PlaceModule', defId: 'container_yard_small', x: YARD_ORIGIN[spot].x, y: YARD_ORIGIN[spot].y, rotation: 0 });
  }
  for (const vehicleDefId of vehicles) add({ type: 'BuyVehicle', vehicleDefId, depotId: DEPOT_ID });
  if (units > 0) add({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units });

  return { id, seed, map: 'data/maps/harbor_01.json', commands: [...commands, ...extra] };
}
