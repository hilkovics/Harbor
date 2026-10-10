// Typy ciest a smery (T03-18, ADR-020; docs/tasks/phase-03.md „Doplnok od používateľa" rozhodnutie 12): tabuľka
// vlastností typov, pravidlo prechodu cez jednosmerku (celá tabuľka smerov), smer kroku a smery pozdĺž ťahu.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROAD_KIND,
  DIRECTION_NAMES,
  DIRECTIONS_4,
  OPPOSITE_DIRECTION,
  ROAD_KINDS,
  ROAD_KIND_TRAITS,
  directionOfStep,
  dragDirections,
  isDirection4Name,
  isRoadKind,
  isRoadStepAllowed,
  type Direction4Name,
  type RoadKind,
  type RoadStepCell,
} from '@sim/grid';

const road = (roadKind: RoadKind, roadDir: Direction4Name | null = null): RoadStepCell => ({ roadKind, roadDir });

describe('ROAD_KINDS a ROAD_KIND_TRAITS', () => {
  it('tri typy v poradí defu; predvolený je dvojpruhová cesta', () => {
    expect([...ROAD_KINDS]).toEqual(['two_lane', 'one_lane', 'one_way']);
    expect(DEFAULT_ROAD_KIND).toBe('two_lane');
  });

  it('pruhy (prezentácia) a jednosmernosť podľa rozhodnutia 12', () => {
    expect(ROAD_KIND_TRAITS).toEqual({
      two_lane: { lanes: 2, oneWay: false },
      one_lane: { lanes: 1, oneWay: false },
      one_way: { lanes: 1, oneWay: true },
    });
    expect(Object.isFrozen(ROAD_KIND_TRAITS)).toBe(true);
    expect(Object.isFrozen(ROAD_KIND_TRAITS.one_way)).toBe(true);
  });

  it.each([
    ['two_lane', true],
    ['one_way', true],
    ['four_lane', false],
    ['', false],
    [1, false],
    [null, false],
    [undefined, false],
  ])('isRoadKind(%j) = %s', (value, expected) => {
    expect(isRoadKind(value)).toBe(expected);
  });
});

describe('smery', () => {
  it('DIRECTION_NAMES = mená DIRECTIONS_4 (N, E, S, W); opačné smery', () => {
    expect(DIRECTION_NAMES).toEqual(DIRECTIONS_4.map((d) => d.name));
    expect(OPPOSITE_DIRECTION).toEqual({ N: 'S', E: 'W', S: 'N', W: 'E' });
  });

  it.each([
    ['N', true],
    ['W', true],
    ['n', false],
    ['NE', false],
    [0, false],
    [null, false],
  ])('isDirection4Name(%j) = %s', (value, expected) => {
    expect(isDirection4Name(value)).toBe(expected);
  });

  it.each([
    [0, -1, 'N'],
    [1, 0, 'E'],
    [0, 1, 'S'],
    [-1, 0, 'W'],
    [0, 0, undefined],
    [1, 1, undefined],
    [2, 0, undefined],
  ])('directionOfStep(%i, %i) = %s', (dx, dy, expected) => {
    expect(directionOfStep(dx, dy)).toBe(expected);
  });
});

describe('isRoadStepAllowed — pravidlo prechodu (rozhodnutie 12)', () => {
  it('obojsmerné typy: každý smer v oboch smeroch', () => {
    for (const from of ['two_lane', 'one_lane'] as const) {
      for (const to of ['two_lane', 'one_lane'] as const) {
        for (const d of DIRECTION_NAMES) expect(isRoadStepAllowed(road(from), road(to), d), `${from} → ${to} ${d}`).toBe(true);
      }
    }
  });

  it('z jednosmerky len v jej smere (do obojsmernej bunky)', () => {
    for (const dir of DIRECTION_NAMES) {
      for (const d of DIRECTION_NAMES) expect(isRoadStepAllowed(road('one_way', dir), road('two_lane'), d), `${dir} krok ${d}`).toBe(d === dir);
    }
  });

  it('do jednosmerky zo všetkých strán okrem proti smeru (zboku áno)', () => {
    for (const dir of DIRECTION_NAMES) {
      for (const d of DIRECTION_NAMES) {
        expect(isRoadStepAllowed(road('two_lane'), road('one_way', dir), d), `do ${dir} krokom ${d}`).toBe(d !== OPPOSITE_DIRECTION[dir]);
      }
    }
  });

  it('jednosmerka → jednosmerka: obe podmienky naraz', () => {
    expect(isRoadStepAllowed(road('one_way', 'E'), road('one_way', 'E'), 'E')).toBe(true);
    expect(isRoadStepAllowed(road('one_way', 'E'), road('one_way', 'S'), 'E')).toBe(true); // zákruta
    expect(isRoadStepAllowed(road('one_way', 'E'), road('one_way', 'W'), 'E')).toBe(false); // čelne proti sebe
    expect(isRoadStepAllowed(road('one_way', 'W'), road('one_way', 'W'), 'E')).toBe(false); // proti smeru
  });

  it('jednosmerka bez smeru (nekonzistentná) je neprejazdná', () => {
    expect(isRoadStepAllowed(road('one_way', null), road('two_lane'), 'E')).toBe(false);
    expect(isRoadStepAllowed(road('two_lane'), road('one_way', null), 'E')).toBe(false);
  });
});

describe('dragDirections — smery jednosmerky pozdĺž ťahu', () => {
  const c = (x: number, y: number) => ({ x, y });

  it('rovný ťah: každá bunka smer ťahu, posledná smer z predchádzajúcej', () => {
    expect(dragDirections([c(1, 1), c(2, 1), c(3, 1)])).toEqual(['E', 'E', 'E']);
    expect(dragDirections([c(1, 3), c(1, 2)])).toEqual(['N', 'N']);
  });

  it('v rohu platí smer do ďalšej bunky', () => {
    expect(dragDirections([c(1, 1), c(2, 1), c(2, 2), c(2, 3), c(1, 3)])).toEqual(['E', 'S', 'S', 'W', 'W']);
  });

  it('kratší ťah alebo nesusedné bunky → undefined', () => {
    expect(dragDirections([])).toBeUndefined();
    expect(dragDirections([c(1, 1)])).toBeUndefined();
    expect(dragDirections([c(1, 1), c(3, 1)])).toBeUndefined();
    expect(dragDirections([c(1, 1), c(2, 2)])).toBeUndefined();
    expect(dragDirections([c(1, 1), c(1, 1)])).toBeUndefined();
  });
});
