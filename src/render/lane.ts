/**
 * Pruhy (docs/tasks/phase-03.md, „Doplnok od používateľa“, rozhodnutie 11): sim vedie vozidlo stredom bunky, pruh je
 * čisto prezentačný — renderer posunie vozidlo kolmo na smer jazdy do pravého pruhu (premávka je pravostranná).
 *
 * Geometria sa odvodzuje zo spritov (`assets/infra/road_*.svg`, `assets/entities/straddle_carrier_*.svg`, obe 64×64 px,
 * `cellPx` manifestu), nie z odhadu; `tests/render/lane.test.ts` porovnáva konštanty priamo so SVG:
 *  - asfalt cesty má šírku 52 px (x 6–58), okraje 2 px na x 7 a 57, stredová čiara je na x 32;
 *  - jeden pruh má teda 26 px a jeho stred je ±13 px od osi (x 19 a x 45) = ±13/64 bunky;
 *  - obsah spritu vozidla je 56 px široký (kolesá x 4–60), takže sa škáluje na šírku pruhu: 26 / 56.
 *
 * Typ cesty (`RoadKind`) vo F3 sim ešte nemá (príde v T03-18); `createRoadKindAt` je jediné miesto, kde renderer typ
 * cesty číta — T03-19 ho prepne na `cell.roadKind`.
 */
import type { Cell, Grid } from '@sim/grid';
import type { Point } from './camera';
import { MANIFEST_CELL_PX } from './entity-assets';
import type { ViewRotation } from './view-models';

/** Typ cesty (ADR-020, T03-18): dvojpruhová obojsmerná, jednopruhová obojsmerná, jednosmerná jednopruhová. */
export type RoadKind = 'two_lane' | 'one_lane' | 'one_way';

/** Typ cesty, ktorý platí, kým ho sim nezapisuje (F3 pred T03-18): štartové aj hráčove cesty sú dvojpruhové. */
export const DEFAULT_ROAD_KIND: RoadKind = 'two_lane';

/** Šírka asfaltu sprite `road_*` v px zdroja (x 6–58). */
export const ROAD_ASPHALT_PX = 52;

/** Šírka jedného pruhu dvojpruhovej cesty v px zdroja (asfalt / 2 = 26; pruhy x 6–32 a x 32–58). */
export const LANE_WIDTH_PX = ROAD_ASPHALT_PX / 2;

/** Vzdialenosť stredu pruhu od osi cesty v px zdroja (13; stredy pruhov na x 19 a x 45 pri osi x 32). */
export const LANE_CENTER_PX = LANE_WIDTH_PX / 2;

/** Posun stredu pruhu od osi cesty v bunkách: 13/64. */
export const LANE_OFFSET_CELLS = LANE_CENTER_PX / MANIFEST_CELL_PX;

/** Šírka obsahu spritu vozidla v px zdroja (`straddle_carrier_*.svg`: kolesá x 4–60). */
export const VEHICLE_CONTENT_WIDTH_PX = 56;

/** Mierka spritu vozidla, aby šírka jeho obsahu zodpovedala šírke pruhu (26 / 56). */
export const VEHICLE_LANE_SCALE = LANE_WIDTH_PX / VEHICLE_CONTENT_WIDTH_PX;

/** Vektor „vpravo od smeru jazdy“ pre kurz (0 = sever, v smere hodinových ručičiek; +x doprava, +y nadol). */
const RIGHT_OF_HEADING: Readonly<Record<ViewRotation, Point>> = {
  0: { x: 1, y: 0 },
  90: { x: 0, y: 1 },
  180: { x: -1, y: 0 },
  270: { x: 0, y: -1 },
};

const CENTERED: Point = Object.freeze({ x: 0, y: 0 });

/** Posuny pre všetky štyri kurzy pri posune `distance` bunky vpravo od smeru jazdy (0 = stred bunky). */
function offsetsAt(distance: number): Readonly<Record<ViewRotation, Point>> {
  const at = (heading: ViewRotation): Point => {
    const right = RIGHT_OF_HEADING[heading];
    return distance === 0 ? CENTERED : Object.freeze({ x: right.x * distance, y: right.y * distance });
  };
  return { 0: at(0), 90: at(90), 180: at(180), 270: at(270) };
}

/**
 * Predpočítané posuny podľa typu cesty a kurzu — `laneOffset` sa volá každý frame pre každé vozidlo, preto nealokuje.
 * Dvojpruhová cesta má pruh (13/64 vpravo od osi), jednopruhové cesty jazdia v strede.
 */
const LANE_OFFSETS: Readonly<Record<RoadKind, Readonly<Record<ViewRotation, Point>>>> = {
  two_lane: offsetsAt(LANE_OFFSET_CELLS),
  one_lane: offsetsAt(0),
  one_way: offsetsAt(0),
};

/**
 * Posun stredu vozidla od stredu bunky v bunkách (`x` doprava, `y` nadol), kolmo na smer jazdy vpravo:
 * `two_lane` = 13/64 bunky (kurz 0° → +x, 90° → +y, 180° → −x, 270° → −y), `one_lane` a `one_way` = 0 (stred).
 */
export function laneOffset(kind: RoadKind, heading: ViewRotation): Point {
  return LANE_OFFSETS[kind][heading];
}

/** Typ cesty v bunke gridu (x, y). */
export type RoadKindAt = (cellX: number, cellY: number) => RoadKind;

/** `RoadKindAt` bez gridu: všade `two_lane` (predvolené pre views bez `WorldRenderer`, napr. testy). */
export const defaultRoadKindAt: RoadKindAt = () => DEFAULT_ROAD_KIND;

/**
 * Typ cesty v bunke. **Jediné miesto, kde renderer typ cesty číta**: T03-19 ho prepne na `cell.roadKind`.
 * Kým ho sim nemá (T03-18), má každá bunka s cestou `two_lane`; bunka bez cesty pruh nemá, vozidlo tam jazdí v strede
 * (`one_lane`) — nastať to nemá (vozidlo jazdí po cestách, `RemoveRoad` pod ním je `occupied`, ADR-019).
 */
export function roadKindOfCell(cell: Readonly<Pick<Cell, 'road'>>): RoadKind {
  return cell.road === 'road' ? DEFAULT_ROAD_KIND : 'one_lane';
}

/** Vytvorí `RoadKindAt` nad živou mriežkou sveta (číta sa pri každom volaní, takže zmeny ciest sa prejavia hneď). */
export function createRoadKindAt(grid: Grid): RoadKindAt {
  return (cellX, cellY) => (grid.inBounds(cellX, cellY) ? roadKindOfCell(grid.at(cellX, cellY)) : 'one_lane');
}
