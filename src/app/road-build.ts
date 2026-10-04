/**
 * Stavba ciest podľa typu (T03-20, ADR-020): čisté funkcie, ktoré z ťahu myšou, vybraného typu cesty a smeru pre
 * 1-bunkový ťah zostavia príkaz `PlaceRoad { cells, kind, dirs? }`. Bez DOM a bez stavu — `InputController` ich volá
 * pri každom pohybe myši, testujú sa v Node.
 *
 * - **Smery jednosmerky** (rozhodnutie 12): `dirs[i]` je smer do bunky `i + 1` (v rohu teda smer do ďalšej bunky),
 *   posledná bunka má smer z predchádzajúcej. Počíta ich `dragDirections` zo sim. Ťah dlhý 1 bunku nemá smer, preto sa
 *   použije `single` (posledný smer ťahu jednosmerky, predvolene `DEFAULT_ONE_WAY_DIRECTION`, otáča ho `R`).
 * - Ťah myšou zbiera bunky bez opakovania (`InputController.extendStroke`): ak hráč vrátil kurzor cez už zbrané bunky
 *   a pokračoval inde, dve po sebe idúce bunky nemusia susediť a `dragDirections` vráti `undefined`. Vtedy sa smer
 *   bunky, za ktorou nasleduje skok, zdedí od predchádzajúcej bunky (prvej bunke pripadne `single`).
 * - Položky BuildBaru pre cesty majú `defId` `road_<kind>` (`roadItemId`), aby sa nikdy nezrazili s definíciou modulu.
 */
import { PlaceRoadCommand } from '@sim/commands';
import { DIRECTION_NAMES, ROAD_KINDS, ROAD_KIND_TRAITS, dragDirections, type CellCoord, type Direction4Name, type RoadKind } from '@sim/grid';

/** Slovenské názvy typov ciest (BuildBar, štítok pri kurzore); úplná mapa: nový typ v sime = chyba kompilácie tu. */
export const ROAD_KIND_LABEL: Readonly<Record<RoadKind, string>> = {
  two_lane: 'Cesta dvojpruhová',
  one_lane: 'Cesta jednopruhová',
  one_way: 'Jednosmerná cesta',
};

/** Smery so šípkou a slovenským názvom (štítok pri kurzore: `→ východ`). */
export const DIRECTION_LABEL: Readonly<Record<Direction4Name, string>> = {
  N: '↑ sever',
  E: '→ východ',
  S: '↓ juh',
  W: '← západ',
};

/** Predpona `defId` položky BuildBaru pre typ cesty. */
export const ROAD_ITEM_PREFIX = 'road_';

/** `defId` položky BuildBaru pre typ cesty (`two_lane` → `road_two_lane`). */
export function roadItemId(kind: RoadKind): string {
  return `${ROAD_ITEM_PREFIX}${kind}`;
}

/** Typ cesty z `defId` položky BuildBaru, alebo `null`, ak `defId` nepatrí žiadnej cestnej položke. */
export function roadKindOfItem(defId: string): RoadKind | null {
  return ROAD_KINDS.find((kind) => roadItemId(kind) === defId) ?? null;
}

/** Je typ jednosmerný (potrebuje `dirs`)? */
export function isOneWayKind(kind: RoadKind): boolean {
  return ROAD_KIND_TRAITS[kind].oneWay;
}

/** Ďalší smer v smere hodinových ručičiek: N → E → S → W → N (`R` v build móde jednosmerky). */
export function nextDirection(direction: Direction4Name): Direction4Name {
  const index = DIRECTION_NAMES.indexOf(direction);
  return DIRECTION_NAMES[(index + 1) % DIRECTION_NAMES.length];
}

/** Smer kroku medzi susednými bunkami, alebo `undefined`, ak nesusedia hranou. */
function stepDirection(from: CellCoord, to: CellCoord): Direction4Name | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return undefined;
  if (dx !== 0) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}

/**
 * Smery jednosmerky pozdĺž ťahu (`cells.length` položiek): `dragDirections`; ťah kratší ako 2 bunky → `[single]`
 * (prázdny ťah → `[]`); ťah so skokom medzi nesusednými bunkami → smer bunky pred skokom sa zdedí od predchádzajúcej.
 */
export function strokeDirections(cells: readonly CellCoord[], single: Direction4Name): Direction4Name[] {
  if (cells.length === 0) return [];
  if (cells.length === 1) return [single];
  const exact = dragDirections(cells);
  if (exact !== undefined) return exact;
  const last = cells.length - 1;
  const dirs: Direction4Name[] = [];
  let previous = single;
  for (let i = 0; i <= last; i++) {
    const step = i < last ? stepDirection(cells[i], cells[i + 1]) : stepDirection(cells[i - 1], cells[i]);
    previous = step ?? previous;
    dirs.push(previous);
  }
  return dirs;
}

/**
 * Príkaz na stavbu (alebo prestavbu) cesty `kind` na `cells`. `kind` sa posiela vždy výslovne (aj `two_lane`), `dirs`
 * len pri jednosmerke. `single` = smer pre ťah dlhý 1 bunku.
 */
export function placeRoadCommand(cells: readonly CellCoord[], kind: RoadKind, single: Direction4Name): PlaceRoadCommand {
  return isOneWayKind(kind) ? new PlaceRoadCommand(cells, kind, strokeDirections(cells, single)) : new PlaceRoadCommand(cells, kind);
}
