/**
 * Rozloženie prístavu pre scenáre pozemnej časti (R4, TR4-02, ADR-041): „priečna ulica“ na starter parcele mapy `harbor_01` — jednosmerný okruh
 * (verejná cesta → vstupný pruh brány → ulica na sever → berth a späť dolu východným ramenom → výstupný pruh brány) s depom a dvormi pri ulici.
 * Čistý dátový modul bez behových závislostí na sim; `data/scenarios/vertical_slice.json` je to isté rozloženie.
 *
 * ```
 *   x:    40 41 42 43 44 45 46 47 48 49 50
 *   y=18   .  N  W  W  W  .  E  S  .  .  .      berth hák (41, 18) severne, ulica (44..42, 18) na západ, (46, 18) na východ, (47, 18) juh
 *   y=19   Y  .  .  .  ^  .  .  v  Y  Y  .      západný dvor (40, 19) rot 270, východný dvor (48, 19) rot 90, ulica x = 44 na sever, x = 47 na juh
 *   y=24   .  .  .  .  ^  .  .  v  D  D  D      depo (48, 24) rot 90
 *   y=28   .  .  .  .  ^  <  <  J  .  .  .      križovatka J (47, 28) `two_lane`
 *   y=29   .  .  .  .  ^  v  <  <                odbočka (47, 29) → (45, 29) → juh
 *   y=30   .  .  .  .  I  O  .  .                vstupný pruh brány (44, 30) rot 0, výstupný pruh (45, 30) rot 180
 *   y=34   .  .  .  .  ^                         verejná cesta (44, 34) sever
 * ```
 * Poradie príkazov (id modulov): starter berth 1 + žeriav 2, depo 3, dvory 4 a 5, vstupný pruh 6, výstupný pruh 7.
 */
import type { CellCoord, Rotation } from '@sim/grid';
import type { Scenario, ScenarioEntry } from './scenario';

export { segment } from './f3-layout';

/** Road portál `road_south` mapy `harbor_01`. */
export const ROAD_PORTAL: CellCoord = { x: 44, y: 63 };
/** Posledná bunka verejnej cesty pred areálom. */
export const PUBLIC_ROAD_END: CellCoord = { x: 44, y: 34 };

export type LandsideKind = 'gate' | 'gate_out';

export interface LandsidePlacement {
  readonly defId: string;
  readonly kind: LandsideKind;
  /** Ľavý horný roh footprintu po rotácii. */
  readonly origin: CellCoord;
  readonly rotation: Rotation;
}

/** Vstupný pruh brány (R4): kamión ide na sever, vstup z verejnej cesty (44, 34). */
export const GATE: LandsidePlacement = { defId: 'gate_in_lane', kind: 'gate', origin: { x: 44, y: 30 }, rotation: 0 };
/** Výstupný pruh brány: kamión ide na juh (rot 180), výstup na verejnú cestu. */
export const GATE_OUT: LandsidePlacement = { defId: 'gate_out_lane', kind: 'gate_out', origin: { x: 45, y: 30 }, rotation: 180 };

export const LANDSIDE_PLACEMENTS: Readonly<Record<LandsideKind, LandsidePlacement>> = { gate: GATE, gate_out: GATE_OUT };
/** Predvolené poradie stavby pozemných modulov (id 6, 7). */
export const DEFAULT_LANDSIDE_ORDER: readonly LandsideKind[] = ['gate', 'gate_out'];

/** Úsek ciest rozloženia: jeden `PlaceRoad` (jednosmerné s `dirs`, križovatka `two_lane`). */
interface RoadSegment {
  readonly type: 'PlaceRoad';
  readonly cells: readonly CellCoord[];
  readonly kind: 'one_way' | 'two_lane';
  readonly dirs?: readonly ('N' | 'E' | 'S' | 'W')[];
}

const ROAD_COMMANDS: readonly RoadSegment[] = [
  { type: 'PlaceRoad', cells: [{ x: 44, y: 34 }], kind: 'one_way', dirs: ['N'] },
  {
    type: 'PlaceRoad',
    cells: Array.from({ length: 11 }, (_, i) => ({ x: 44, y: 29 - i })),
    kind: 'one_way',
    dirs: Array.from({ length: 11 }, () => 'N' as const),
  },
  { type: 'PlaceRoad', cells: [{ x: 44, y: 18 }, { x: 43, y: 18 }, { x: 42, y: 18 }, { x: 41, y: 18 }], kind: 'one_way', dirs: ['W', 'W', 'W', 'N'] },
  { type: 'PlaceRoad', cells: [{ x: 46, y: 18 }, { x: 47, y: 18 }], kind: 'one_way', dirs: ['E', 'S'] },
  {
    type: 'PlaceRoad',
    cells: Array.from({ length: 9 }, (_, i) => ({ x: 47, y: 19 + i })),
    kind: 'one_way',
    dirs: Array.from({ length: 9 }, () => 'S' as const),
  },
  { type: 'PlaceRoad', cells: [{ x: 47, y: 28 }], kind: 'two_lane' },
  { type: 'PlaceRoad', cells: [{ x: 46, y: 28 }, { x: 45, y: 28 }], kind: 'one_way', dirs: ['W', 'W'] },
  { type: 'PlaceRoad', cells: [{ x: 47, y: 29 }, { x: 46, y: 29 }, { x: 45, y: 29 }], kind: 'one_way', dirs: ['W', 'W', 'S'] },
];

/** Všetky cesty rozloženia (33 buniek). */
export const ALL_F4_ROAD_CELLS: readonly CellCoord[] = ROAD_COMMANDS.flatMap((command) => command.cells);

export interface F4Options {
  /** Def id vozidiel na kúpu v poradí (predvolene žiadne); všetky idú do depa `F4_DEPOT_ID`. */
  readonly vehicles?: readonly string[];
  /** Počet TEU na lodi `feeder` spawnutej na ticku 0; 0 = bez lode (predvolene). */
  readonly units?: number;
  /** Cesty, ktoré sa nepostavia (každá bunka z rozloženia; úsek sa skráti). */
  readonly omitRoadCells?: readonly CellCoord[];
  /** Ďalšie príkazy; pridajú sa na koniec. */
  readonly extra?: readonly ScenarioEntry[];
  /** Ktoré pozemné moduly postaviť a v akom poradí (predvolene vstupný a výstupný pruh brány). */
  readonly landside?: readonly LandsideKind[];
  /** Ktoré dvory postaviť (predvolene oba: západný `near`, východný `far`). */
  readonly yards?: readonly ('near' | 'far')[];
}

const YARD: Readonly<Record<'near' | 'far', { readonly origin: CellCoord; readonly rotation: Rotation }>> = {
  near: { origin: { x: 40, y: 19 }, rotation: 270 },
  far: { origin: { x: 48, y: 19 }, rotation: 90 },
};
const DEPOT_ORIGIN: CellCoord = { x: 48, y: 24 };
/** ID depa: starter berth 1 + žeriav 2, depo je prvý `PlaceModule`. */
export const F4_DEPOT_ID = 3;

const sameCell = (a: CellCoord, b: CellCoord): boolean => a.x === b.x && a.y === b.y;

/**
 * Scenár na `harbor_01`: (1) cesty, (2) depo, (3) dvory, (4) brány v `landside` poradí, (5) nákupy vozidiel, (6) loď — všetko na ticku 0.
 * Cesty idú pred modulmi, takže konektory sú pripojené hneď pri stavbe.
 */
export function f4Scenario(id: string, seed: number, options: F4Options = {}): Scenario {
  const { vehicles = [], units = 0, omitRoadCells = [], extra = [], landside = DEFAULT_LANDSIDE_ORDER, yards = ['near', 'far'] } = options;
  const commands: ScenarioEntry[] = [];
  const add = (command: ScenarioEntry['command']): void => {
    commands.push({ atTick: 0, command });
  };

  for (const command of ROAD_COMMANDS) {
    const keep = command.cells.map((cell) => !omitRoadCells.some((omitted) => sameCell(omitted, cell)));
    if (!keep.some(Boolean)) continue;
    const cells = command.cells.filter((_, i) => keep[i]);
    const dirs = command.dirs?.filter((_, i) => keep[i]);
    add({ type: 'PlaceRoad', cells, kind: command.kind, ...(dirs === undefined ? {} : { dirs }) });
  }
  add({ type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_ORIGIN.x, y: DEPOT_ORIGIN.y, rotation: 90 });
  for (const spot of yards) {
    const yard = YARD[spot];
    add({ type: 'PlaceModule', defId: 'container_yard_small', x: yard.origin.x, y: yard.origin.y, rotation: yard.rotation });
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
