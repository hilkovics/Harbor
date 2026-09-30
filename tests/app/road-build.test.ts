// T03-20: čisté funkcie stavby ciest podľa typu — smery jednosmerky pozdĺž ťahu (tabuľka), otáčanie smeru `R`,
// mapovanie položiek BuildBaru na typy ciest a tvar príkazu `PlaceRoad` (JSON) pre každý typ.
import { describe, expect, it } from 'vitest';
import { ROAD_KINDS, type CellCoord, type Direction4Name } from '@sim/grid';
import {
  DIRECTION_LABEL,
  ROAD_ITEM_PREFIX,
  ROAD_KIND_LABEL,
  isOneWayKind,
  nextDirection,
  placeRoadCommand,
  roadItemId,
  roadKindOfItem,
  strokeDirections,
} from '@app/road-build';
import { c } from './input-fixtures';

type Dir = Direction4Name;

describe('strokeDirections: smery jednosmerky pozdĺž ťahu (rozhodnutie 12)', () => {
  const TABLE: ReadonlyArray<readonly [string, readonly CellCoord[], readonly Dir[]]> = [
    ['rovno na východ', [c(0, 0), c(1, 0), c(2, 0)], ['E', 'E', 'E']],
    ['rovno na sever', [c(4, 5), c(4, 4), c(4, 3)], ['N', 'N', 'N']],
    ['rovno na juh', [c(4, 3), c(4, 4), c(4, 5)], ['S', 'S', 'S']],
    ['rovno na západ', [c(2, 0), c(1, 0), c(0, 0)], ['W', 'W', 'W']],
    ['dve bunky: obe majú smer kroku', [c(0, 0), c(1, 0)], ['E', 'E']],
    ['roh: bunka v rohu smeruje do ďalšej (E → S)', [c(0, 0), c(1, 0), c(1, 1)], ['E', 'S', 'S']],
    ['roh: bunka v rohu smeruje do ďalšej (N → W)', [c(3, 3), c(3, 2), c(2, 2)], ['N', 'W', 'W']],
    ['schody: každá bunka smeruje do ďalšej, posledná zdedí', [c(0, 0), c(1, 0), c(1, 1), c(2, 1)], ['E', 'S', 'E', 'E']],
    ['U-otočka (E, S, W)', [c(0, 0), c(1, 0), c(1, 1), c(0, 1)], ['E', 'S', 'W', 'W']],
    ['U-otočka (N, E, S)', [c(0, 2), c(0, 1), c(1, 1), c(1, 2)], ['N', 'E', 'S', 'S']],
    ['okruh 2×2 (E, S, W) pokračuje N', [c(0, 0), c(1, 0), c(1, 1), c(0, 1), c(0, 0)], ['E', 'S', 'W', 'N', 'N']],
  ];

  it.each(TABLE)('%s', (_name, cells, expected) => {
    expect(strokeDirections(cells, 'E')).toEqual(expected);
    expect(strokeDirections(cells, 'N')).toEqual(expected); // smer pre 1-bunkový ťah sa pri dlhšom ťahu ignoruje
  });

  it('1 bunka: použije sa smer pre 1-bunkový ťah (nech je akýkoľvek)', () => {
    for (const single of ['N', 'E', 'S', 'W'] as const) expect(strokeDirections([c(7, 7)], single)).toEqual([single]);
  });

  it('prázdny ťah nemá smery', () => {
    expect(strokeDirections([], 'E')).toEqual([]);
  });

  it('skok medzi nesusednými bunkami (kurzor sa vrátil cez zbrané bunky): smer sa zdedí, dĺžka sedí s bunkami', () => {
    const cells = [c(0, 0), c(1, 0), c(2, 0), c(1, 1)];
    expect(strokeDirections(cells, 'S')).toEqual(['E', 'E', 'E', 'E']);
    expect(strokeDirections([c(5, 5), c(5, 6), c(9, 9)], 'W')).toEqual(['S', 'S', 'S']);
    expect(strokeDirections([c(0, 0), c(4, 4)], 'W')).toEqual(['W', 'W']); // prvá bunka nemá predchodcu → single
  });

  it('nemení vstup', () => {
    const cells = [c(0, 0), c(1, 0)];
    strokeDirections(cells, 'E');
    expect(cells).toEqual([c(0, 0), c(1, 0)]);
  });
});

describe('nextDirection: R otáča smer v smere hodinových ručičiek', () => {
  it('N → E → S → W → N', () => {
    expect((['N', 'E', 'S', 'W'] as const).map(nextDirection)).toEqual(['E', 'S', 'W', 'N']);
  });

  it('štyri otočenia sú identita', () => {
    for (const start of ['N', 'E', 'S', 'W'] as const) {
      expect(nextDirection(nextDirection(nextDirection(nextDirection(start))))).toBe(start);
    }
  });

  it('každý smer má popis so šípkou', () => {
    expect(DIRECTION_LABEL).toEqual({ N: '↑ sever', E: '→ východ', S: '↓ juh', W: '← západ' });
  });
});

describe('položky BuildBaru pre cesty', () => {
  it('defId je road_<kind> a dá sa vrátiť na typ; cudzie id nepatrí žiadnemu typu', () => {
    expect(ROAD_KINDS.map(roadItemId)).toEqual(['road_two_lane', 'road_one_lane', 'road_one_way']);
    for (const kind of ROAD_KINDS) expect(roadKindOfItem(roadItemId(kind))).toBe(kind);
    for (const id of ['berth_standard', 'road', 'road_', 'road_three_lane', `${ROAD_ITEM_PREFIX}two_lane `, '']) expect(roadKindOfItem(id), id).toBeNull();
  });

  it('názvy typov podľa karty', () => {
    expect(ROAD_KINDS.map((kind) => ROAD_KIND_LABEL[kind])).toEqual(['Cesta dvojpruhová', 'Cesta jednopruhová', 'Jednosmerná cesta']);
  });

  it('jednosmerný je práve one_way', () => {
    expect(ROAD_KINDS.filter(isOneWayKind)).toEqual(['one_way']);
  });
});

describe('placeRoadCommand: PlaceRoad JSON podľa typu', () => {
  const cells = [c(30, 20), c(31, 20), c(31, 21)];
  const xy = cells.map(({ x, y }) => ({ x, y }));

  it('dvojpruhová: kind two_lane, bez dirs', () => {
    expect(placeRoadCommand(cells, 'two_lane', 'E').toJSON()).toEqual({ type: 'PlaceRoad', cells: xy, kind: 'two_lane' });
  });

  it('jednopruhová: kind one_lane, bez dirs', () => {
    expect(placeRoadCommand(cells, 'one_lane', 'E').toJSON()).toEqual({ type: 'PlaceRoad', cells: xy, kind: 'one_lane' });
  });

  it('jednosmerná: kind one_way a dirs z ťahu (roh smeruje do ďalšej bunky)', () => {
    expect(placeRoadCommand(cells, 'one_way', 'E').toJSON()).toEqual({ type: 'PlaceRoad', cells: xy, kind: 'one_way', dirs: ['E', 'S', 'S'] });
  });

  it('jednosmerná, 1 bunka: dirs = smer pre 1-bunkový ťah', () => {
    expect(placeRoadCommand([c(30, 20)], 'one_way', 'W').toJSON()).toEqual({ type: 'PlaceRoad', cells: [{ x: 30, y: 20 }], kind: 'one_way', dirs: ['W'] });
  });
});
