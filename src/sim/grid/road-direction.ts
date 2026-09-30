/**
 * Smery ciest a pravidlo prechodu cez jednosmerky (docs/tasks/phase-03.md „Doplnok od používateľa" rozhodnutie 12;
 * ADR-020). Smer je `Direction4Name` (`N`, `E`, `S`, `W`) — rovnaké mená ako `DIRECTIONS_4`.
 *
 * **Pravidlo prechodu** z bunky A do susednej bunky B v smere `d = dir(A → B)`:
 * - A nie je jednosmerná, alebo `d === A.roadDir` (z jednosmerky sa vychádza len v jej smere);
 * - B nie je jednosmerná, alebo `d !== opačný(B.roadDir)` (do jednosmerky sa nevchádza proti smeru; zboku áno).
 * Pravidlo používa A* (smerové hrany), krok 12 (trasa a rozbehnutý úsek vozidla) aj obrat vozidla uprostred úseku —
 * obrat z úseku A → B je povolený práve vtedy, keď je povolený krok B → A.
 */
import { DIRECTIONS_4, directionOfStep, type Cell, type CellCoord, type Direction4Name } from './grid';
import { ROAD_KIND_TRAITS } from './road-kind';

/** Smery v poradí `DIRECTIONS_4` (N, E, S, W). */
export const DIRECTION_NAMES: readonly Direction4Name[] = Object.freeze(DIRECTIONS_4.map((direction) => direction.name));

/** Opačný smer (N ↔ S, E ↔ W). */
export const OPPOSITE_DIRECTION: Readonly<Record<Direction4Name, Direction4Name>> = Object.freeze({ N: 'S', E: 'W', S: 'N', W: 'E' });

/** Je hodnota jeden zo smerov `N`, `E`, `S`, `W` (napr. `dirs` v JSON príkaze alebo smer v save)? */
export function isDirection4Name(value: unknown): value is Direction4Name {
  return (DIRECTION_NAMES as readonly unknown[]).includes(value);
}

/** Časť bunky, ktorú pravidlo prechodu číta. */
export type RoadStepCell = Pick<Readonly<Cell>, 'roadKind' | 'roadDir'>;

/**
 * Smie vozidlo prejsť z cestnej bunky `from` do susednej cestnej bunky `to` v smere `direction` (= smer kroku
 * `from → to`)? Vrstvu `road` overuje volajúci. Jednosmerka bez smeru (nekonzistentný stav, ktorý odmieta krok 12
 * aj obnova save) je neprejazdná. Bez alokácie (horúca cesta A*).
 */
export function isRoadStepAllowed(from: RoadStepCell, to: RoadStepCell, direction: Direction4Name): boolean {
  if (ROAD_KIND_TRAITS[from.roadKind].oneWay && from.roadDir !== direction) return false;
  if (!ROAD_KIND_TRAITS[to.roadKind].oneWay) return true;
  return to.roadDir !== null && OPPOSITE_DIRECTION[to.roadDir] !== direction;
}

/**
 * Smery jednosmerky pozdĺž ťahu myšou (rozhodnutie 12): bunka `i` dostane smer do bunky `i + 1` (v rohu teda platí
 * smer do ďalšej bunky), posledná bunka smer z predchádzajúcej. Ťah kratší ako 2 bunky alebo s krokom medzi
 * nesusednými bunkami → `undefined` (smer sa nedá určiť). Pomôcka pre UI (`PlaceRoad.dirs`) a testy; sim `dirs`
 * neodvodzuje — prijme ľubovoľné platné smery.
 */
export function dragDirections(cells: readonly CellCoord[]): Direction4Name[] | undefined {
  if (cells.length < 2) return undefined;
  const dirs: Direction4Name[] = [];
  for (let i = 1; i < cells.length; i++) {
    const direction = directionOfStep(cells[i].x - cells[i - 1].x, cells[i].y - cells[i - 1].y);
    if (direction === undefined) return undefined;
    dirs.push(direction);
  }
  dirs.push(dirs[dirs.length - 1]);
  return dirs;
}
