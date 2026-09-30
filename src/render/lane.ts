/**
 * Pruhy a mierka vozidiel (docs/tasks/phase-03.md, „Doplnok od používateľa“, rozhodnutie 11; ADR-020; docs/tasks/phase-05b.md,
 * spätná väzba 10): sim vedie vozidlo stredom bunky, pruh je čisto prezentačný — renderer posunie vozidlo kolmo na smer
 * jazdy doprava (premávka je pravostranná). Počet pruhov určuje typ cesty (`ROAD_KIND_TRAITS[kind].lanes` zo simu):
 * `two_lane` = 2 (pravá strana), `one_lane` a `one_way` = 1 (stred).
 *
 * **Jediné miesto mierky vozidiel.** Všetky sprity vozidiel a kamiónov (`VehicleView`, `TruckView`, fallback `Graphics`) sa
 * škálujú jediným činiteľom `VEHICLE_SCALE`. Sprity sú nakreslené v mierke náklad : vozidlo = 1 : 1 — kontajner v návese
 * kamióna má 32 × 64 px, rovnako ako `cargo.container_teu` (64 × 32 px) na aprone či pod žeriavom, a otvor straddle carriera
 * (32 px) obkročí jeden takýto kontajner. Kým sa vozidlo zmenšovalo na šírku pruhu (26 / 56 ≈ 0,46, verzia F3), kontajner
 * sa pri naložení zmenšil na menej než polovicu a pri vyložení sa zväčšil späť (F5b č. 10). Tabuľka mierok celej hry je
 * v `docs/DESIGN_BRIEF.md` §4.1.
 *
 * Geometria sa odvodzuje zo spritov (`assets/infra/road_*.svg`, `assets/entities/{straddle_carrier,truck_container}_*.svg`,
 * 64 px bunka manifestu), nie z odhadu; `tests/render/lane.test.ts` porovnáva konštanty priamo so SVG:
 *  - asfalt cesty má šírku 52 px (x 6–58), okraje 2 px na x 7 a 57, stredová čiara je na x 32;
 *  - jeden pruh má teda 26 px a jeho stred je ±13 px od osi (x 19 a x 45) = ±13/64 bunky;
 *  - obsah spritov vozidiel je 48 px široký (kolesá straddle carriera x 8–56, kolesá kamióna x 10–54).
 *
 * Vozidlo v mierke 1 : 1 je širšie než pruh (48 > 26), a tak sa na dvojpruhovej ceste posúva od osi len o toľko, koľko
 * dovolí rezerva asfaltu (`VEHICLE_OFFSET_PX` = (52 − 48) / 2 = 2 px); protismerné vozidlá sa pri míňaní prekrývajú (sim
 * kolízie nemá, ARCHITECTURE §7.6). Zmena `VEHICLE_SCALE` na menšiu hodnotu posun automaticky zväčší až na stred pruhu (13 px).
 *
 * Typ cesty renderer číta z `Cell.roadKind` (`createRoadKindAt` → `roadKindOfCell`, jediné miesto). Tvar bunky pre oblúky
 * v zákrutách (`turn-arc.ts`) dáva `createRoadMaskAt` (maska susedov ako autotile).
 */
import { DEFAULT_ROAD_KIND, ROAD_KIND_TRAITS, type Cell, type Grid, type RoadKind } from '@sim/grid';
import { autotileMask } from './autotile';
import type { Point } from './camera';
import { MANIFEST_CELL_PX } from './entity-assets';
import { noConnectorMask, type ConnectorMaskAt } from './module-connectors';
import type { ViewRotation } from './view-models';

/** Šírka asfaltu sprite `road_*` v px zdroja (x 6–58). */
export const ROAD_ASPHALT_PX = 52;

/** Šírka jedného pruhu dvojpruhovej cesty v px zdroja (asfalt / 2 = 26; pruhy x 6–32 a x 32–58). */
export const LANE_WIDTH_PX = ROAD_ASPHALT_PX / 2;

/** Vzdialenosť stredu pruhu od osi cesty v px zdroja (13; stredy pruhov na x 19 a x 45 pri osi x 32). */
export const LANE_CENTER_PX = LANE_WIDTH_PX / 2;

/** Posun stredu pruhu od osi cesty v bunkách: 13/64. */
export const LANE_OFFSET_CELLS = LANE_CENTER_PX / MANIFEST_CELL_PX;

/** Šírka obsahu spritov vozidiel a kamiónov v px zdroja (kolesá): straddle carrier x 8–56, kamión x 10–54. */
export const VEHICLE_BODY_WIDTH_PX = 48;

/**
 * Mierka všetkých spritov vozidiel a kamiónov voči súboru (manifest `entities.<def>.footprint` × 64 px × mierka):
 * 1 = sprite v pôvodnej veľkosti, teda kontajner na vozidle je rovnako veľký ako kontajner na aprone (`cargo.container_teu`).
 */
export const VEHICLE_SCALE = 1;

/** Šírka obsahu vozidla po mierke, px zdroja. */
export const VEHICLE_WIDTH_PX = VEHICLE_BODY_WIDTH_PX * VEHICLE_SCALE;

/**
 * Posun stredu vozidla od osi dvojpruhovej cesty v px zdroja: stred pruhu (13), najviac však rezerva asfaltu po stranách
 * vozidla `(52 − šírka) / 2`, aby vozidlo nečnelo z cesty. Pri `VEHICLE_SCALE` 1 je to 2 px.
 */
export const VEHICLE_OFFSET_PX = Math.min(LANE_CENTER_PX, Math.max(0, (ROAD_ASPHALT_PX - VEHICLE_WIDTH_PX) / 2));

/** Posun stredu vozidla od osi dvojpruhovej cesty v bunkách (`VEHICLE_OFFSET_PX` / 64). */
export const VEHICLE_OFFSET_CELLS = VEHICLE_OFFSET_PX / MANIFEST_CELL_PX;

/** Jednotkový vektor „dopredu“ pre kurz (0 = sever, v smere hodinových ručičiek; +x doprava, +y nadol). */
const FORWARD_OF_HEADING: Readonly<Record<ViewRotation, Point>> = Object.freeze({
  0: Object.freeze({ x: 0, y: -1 }),
  90: Object.freeze({ x: 1, y: 0 }),
  180: Object.freeze({ x: 0, y: 1 }),
  270: Object.freeze({ x: -1, y: 0 }),
});

/** Vektor „vpravo od smeru jazdy“ pre kurz. */
const RIGHT_OF_HEADING: Readonly<Record<ViewRotation, Point>> = Object.freeze({
  0: Object.freeze({ x: 1, y: 0 }),
  90: Object.freeze({ x: 0, y: 1 }),
  180: Object.freeze({ x: -1, y: 0 }),
  270: Object.freeze({ x: 0, y: -1 }),
});

/** Jednotkový vektor smeru jazdy pre kurz (bez alokácie). */
export function forwardOf(heading: ViewRotation): Point {
  return FORWARD_OF_HEADING[heading];
}

/** Jednotkový vektor kolmo vpravo od smeru jazdy pre kurz (bez alokácie). */
export function rightOf(heading: ViewRotation): Point {
  return RIGHT_OF_HEADING[heading];
}

/**
 * Posun stredu vozidla od osi cesty v bunkách kolmo vpravo od smeru jazdy podľa typu cesty: dvojpruhová cesta
 * `VEHICLE_OFFSET_CELLS` (stred pruhu, najviac rezerva asfaltu po stranách vozidla), jednopruhové cesty (`one_lane`, `one_way`)
 * 0 — vozidlo jazdí v strede. Odvodené z `ROAD_KIND_TRAITS[kind].lanes`.
 */
export function laneMagnitude(kind: RoadKind): number {
  return ROAD_KIND_TRAITS[kind].lanes === 2 ? VEHICLE_OFFSET_CELLS : 0;
}

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
  two_lane: offsetsAt(laneMagnitude('two_lane')),
  one_lane: offsetsAt(laneMagnitude('one_lane')),
  one_way: offsetsAt(laneMagnitude('one_way')),
};

/**
 * Posun stredu vozidla od stredu bunky v bunkách (`x` doprava, `y` nadol), kolmo na smer jazdy vpravo:
 * `two_lane` = `VEHICLE_OFFSET_CELLS` (kurz 0° → +x, 90° → +y, 180° → −x, 270° → −y), `one_lane` a `one_way` = 0 (stred).
 */
export function laneOffset(kind: RoadKind, heading: ViewRotation): Point {
  return LANE_OFFSETS[kind][heading];
}

/** Typ cesty v bunke gridu (x, y). */
export type RoadKindAt = (cellX: number, cellY: number) => RoadKind;

/** `RoadKindAt` bez gridu: všade `two_lane` (predvolené pre views bez `WorldRenderer`, napr. testy). */
export const defaultRoadKindAt: RoadKindAt = () => DEFAULT_ROAD_KIND;

/**
 * Typ cesty v bunke: `Cell.roadKind` (ADR-020). **Jediné miesto, kde renderer typ cesty číta.** Bunka bez cesty (alebo
 * s koľajou) pruh nemá, vozidlo tam jazdí v strede (`one_lane`) — nastať to nemá (vozidlo jazdí po cestách, `RemoveRoad`
 * pod ním je `occupied`, ADR-019).
 */
export function roadKindOfCell(cell: Readonly<Pick<Cell, 'road' | 'roadKind'>>): RoadKind {
  return cell.road === 'road' ? cell.roadKind : 'one_lane';
}

/** Vytvorí `RoadKindAt` nad živou mriežkou sveta (číta sa pri každom volaní, takže zmeny ciest sa prejavia hneď). */
export function createRoadKindAt(grid: Grid): RoadKindAt {
  return (cellX, cellY) => (grid.inBounds(cellX, cellY) ? roadKindOfCell(grid.at(cellX, cellY)) : 'one_lane');
}

/**
 * Maska pripojených susedov cestnej bunky (autotile: N = 1, E = 2, S = 4, W = 8), 0 pre bunku bez cesty alebo mimo
 * mapy. Z masky vie renderer, či je bunka zákruta (dva kolmé susedia) a kade vozidlo prejde (`turn-arc.ts`).
 */
export type RoadMaskAt = (cellX: number, cellY: number) => number;

/** `RoadMaskAt` bez gridu: žiadna bunka nemá pripojených susedov, takže sa oblúky nekreslia (vozidlo jazdí po priamkach). */
export const noRoadMaskAt: RoadMaskAt = () => 0;

/**
 * Vytvorí `RoadMaskAt` nad živou mriežkou sveta (zmeny ciest sa prejavia hneď, bez cache). `connectorMask` pridá ramená
 * k konektorom modulov (rovnaké ako pri kreslení cesty), takže vozidlo vchádzajúce do modulu zo zákruty ide po oblúku.
 */
export function createRoadMaskAt(grid: Grid, connectorMask: ConnectorMaskAt = noConnectorMask): RoadMaskAt {
  return (cellX, cellY) =>
    grid.inBounds(cellX, cellY) && grid.at(cellX, cellY).road === 'road'
      ? autotileMask(grid, cellX, cellY, 'road', connectorMask(cellX, cellY))
      : 0;
}
