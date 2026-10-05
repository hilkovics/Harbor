import { describe, expect, it } from 'vitest';
import { cellLaneKind, laneFor } from '@sim/traffic';
import { idx, lay, line, trafficBed } from './traffic-fixtures';

// Zem x 30…58, y ≥ 21 je voľná (cesta nábrežia je v y = 17, depo v (31, 18)).
describe('CellLanes — druh bunky, konce a úseky one_lane', () => {
  it('rovná dvojpruhová cesta: two_lane s koncami N a S; roh S + W; slepá bunka má len jeden koniec; bez cesty none', () => {
    const { world } = trafficBed();
    lay(world, line([40, 22], [40, 26]));
    lay(world, line([44, 22], [46, 22]));
    lay(world, line([46, 23], [46, 24]));
    const lanes = world.cellLanes;
    expect([lanes.kindOf(idx(world, [40, 24])), lanes.end0(idx(world, [40, 24])), lanes.end1(idx(world, [40, 24]))]).toEqual(['two_lane', 0, 2]);
    expect([lanes.end0(idx(world, [46, 22])), lanes.end1(idx(world, [46, 22]))]).toEqual([2, 3]);
    expect([lanes.kindOf(idx(world, [40, 22])), lanes.end0(idx(world, [40, 22])), lanes.end1(idx(world, [40, 22]))]).toEqual(['two_lane', 2, -1]);
    expect(cellLaneKind(world, idx(world, [50, 30]))).toBe('none');
  });

  it('bunka s ≥ 3 jazdnými susedmi je križovatka (1 slot), aj keď je cesta jednopruhová', () => {
    const { world } = trafficBed();
    lay(world, line([36, 24], [44, 24]));
    lay(world, line([40, 25], [40, 27]));
    lay(world, [[40, 23]], 'one_lane');
    expect([cellLaneKind(world, idx(world, [40, 24])), cellLaneKind(world, idx(world, [39, 24]))]).toEqual(['junction', 'two_lane']);
    // (40, 23) má jediného suseda → slepá jednopruhová bunka je single
    expect(cellLaneKind(world, idx(world, [40, 23]))).toBe('single');
  });

  it('one_lane a one_way sú single; zmena siete (roadVersion) prepočíta cache', () => {
    const { world } = trafficBed();
    lay(world, line([40, 22], [40, 24]), 'one_lane');
    lay(world, line([42, 22], [42, 24]), 'one_way', ['S', 'S', 'S']);
    expect([cellLaneKind(world, idx(world, [40, 23])), cellLaneKind(world, idx(world, [42, 23]))]).toEqual(['single', 'single']);
    lay(world, [[40, 23]], 'two_lane');
    expect(cellLaneKind(world, idx(world, [40, 23]))).toBe('two_lane');
  });

  it('úsek one_lane: súvislý reťazec jednopruhových buniek bez križovatiek, usporiadaný od konca; protismer sa líši', () => {
    const { world } = trafficBed();
    lay(world, line([34, 26], [35, 26]));
    lay(world, line([36, 26], [40, 26]), 'one_lane');
    lay(world, line([41, 26], [42, 26]));
    const lanes = world.cellLanes;
    const segment = lanes.segmentOf(idx(world, [38, 26]));
    expect(segment).toBeGreaterThan(0);
    expect(lanes.segmentOf(idx(world, [35, 26]))).toBe(0);
    const cells = Array.from(lanes.cellsOfSegment(segment));
    expect(cells).toHaveLength(5);
    expect(new Set(cells)).toEqual(new Set(line([36, 26], [40, 26]).map((xy) => idx(world, xy))));
    const [first, last] = [cells[0], cells[cells.length - 1]];
    const width = world.grid.width;
    // vstup zvonka na prvú bunku = +1, na poslednú = −1
    const outsideOfFirst = first === idx(world, [36, 26]) ? idx(world, [35, 26]) : idx(world, [41, 26]);
    const outsideOfLast = last === idx(world, [40, 26]) ? idx(world, [41, 26]) : idx(world, [35, 26]);
    expect([lanes.entryDirection(width, first, outsideOfFirst), lanes.entryDirection(width, last, outsideOfLast)]).toEqual([1, -1]);
    expect(lanes.entryDirection(width, cells[2], cells[1])).toBe(1);
    expect(lanes.entryDirection(width, cells[2], cells[3])).toBe(-1);
  });

  it('križovatka rozdelí one_lane cestu na dva úseky', () => {
    const { world } = trafficBed();
    lay(world, line([34, 26], [44, 26]), 'one_lane');
    lay(world, line([39, 27], [39, 28]));
    const lanes = world.cellLanes;
    expect(lanes.kindOf(idx(world, [39, 26]))).toBe('junction');
    expect(lanes.segmentCount).toBe(2);
    expect(lanes.segmentOf(idx(world, [39, 26]))).toBe(0);
    expect(lanes.segmentOf(idx(world, [36, 26]))).not.toBe(lanes.segmentOf(idx(world, [42, 26])));
  });
});

describe('laneFor — pruh podľa strany vjazdu a výjazdu (rozhodnutie 3)', () => {
  it('rovná cesta N–S (e0 = N, e1 = S): vjazd zo severu pruh 0, z juhu pruh 1', () => {
    const { world } = trafficBed();
    lay(world, line([40, 22], [40, 26]));
    const cell = idx(world, [40, 24]);
    expect([laneFor(world, cell, 0, 2), laneFor(world, cell, 2, 0)]).toEqual([0, 1]);
  });

  it('bez strany vjazdu rozhoduje výjazd: k e1 pruh 0, k e0 pruh 1; bez oboch pruh 0', () => {
    const { world } = trafficBed();
    lay(world, line([40, 22], [40, 26]));
    const cell = idx(world, [40, 24]);
    expect([laneFor(world, cell, null, 2), laneFor(world, cell, null, 0), laneFor(world, cell, null, null)]).toEqual([0, 1, 0]);
  });

  it('slepá bunka: vjazd z e0 pruh 0, výjazd späť cez e0 (otočka) pruh 1', () => {
    const { world } = trafficBed();
    lay(world, line([40, 22], [40, 26]));
    const deadEnd = idx(world, [40, 26]);
    expect([laneFor(world, deadEnd, 0, null), laneFor(world, deadEnd, null, 0)]).toEqual([0, 1]);
  });

  it('single, križovatka a bunka bez cesty majú vždy pruh 0', () => {
    const { world } = trafficBed();
    lay(world, line([36, 24], [44, 24]));
    lay(world, line([40, 25], [40, 27]));
    lay(world, line([36, 30], [38, 30]), 'one_lane');
    expect(laneFor(world, idx(world, [40, 24]), 1, 3)).toBe(0);
    expect(laneFor(world, idx(world, [37, 30]), 3, 1)).toBe(0);
    expect(laneFor(world, idx(world, [50, 50]), 3, 1)).toBe(0);
  });
});
