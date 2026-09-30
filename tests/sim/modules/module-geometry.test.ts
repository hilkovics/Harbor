// Geometria modulov (T02-03): rotateSide (n → e → s → w v smere hodinových ručičiek), waterSideOf a footprintOf
// (ľavý horný roh po rotácii, bunky row-major) — zhodné s rotateLocalCell (ARCHITECTURE §8 bod 7).
import { describe, expect, it } from 'vitest';
import { SIDES, type Side } from '@sim/defs';
import { DIRECTIONS_4, ROTATIONS, rotateLocalCell, type Rotation } from '@sim/grid';
import { SIDE_STEPS, connectorOutside, connectorsOf, edgeCells, footprintOf, frontBandCells, rotateSide, waterSideOf } from '@sim/modules';
import { BERTH, CRANE, MODULE_DEFS } from './module-fixtures';

const berthDef = MODULE_DEFS.modules.get(BERTH);
const craneDef = MODULE_DEFS.modules.get(CRANE);

describe('rotateSide', () => {
  const TABLE: readonly [Side, Rotation, Side][] = [
    ['n', 0, 'n'],
    ['n', 90, 'e'],
    ['n', 180, 's'],
    ['n', 270, 'w'],
    ['e', 90, 's'],
    ['s', 90, 'w'],
    ['w', 90, 'n'],
    ['w', 270, 's'],
    ['s', 180, 'n'],
  ];
  it.each(TABLE)('%s pri %i° → %s', (side, rotation, expected) => {
    expect(rotateSide(side, rotation)).toBe(expected);
  });

  it('zodpovedá rotateLocalCell: stredná bunka hrany sa po rotácii ocitne na otočenej hrane', () => {
    // Footprint 5×3: stredy hrán n (2,0), e (4,1), s (2,2), w (0,1).
    const w = 5;
    const h = 3;
    const edgeCell: Readonly<Record<Side, { x: number; y: number }>> = { n: { x: 2, y: 0 }, e: { x: 4, y: 1 }, s: { x: 2, y: 2 }, w: { x: 0, y: 1 } };
    for (const rotation of ROTATIONS) {
      const rw = rotation % 180 === 0 ? w : h;
      const rh = rotation % 180 === 0 ? h : w;
      for (const side of SIDES) {
        const cell = rotateLocalCell(edgeCell[side].x, edgeCell[side].y, w, h, rotation);
        const onEdge: Readonly<Record<Side, boolean>> = { n: cell.y === 0, e: cell.x === rw - 1, s: cell.y === rh - 1, w: cell.x === 0 };
        expect(onEdge[rotateSide(side, rotation)], `${side} @ ${String(rotation)}`).toBe(true);
      }
    }
  });

  it('neplatná rotácia alebo strana → RangeError', () => {
    expect(() => rotateSide('n', 45 as Rotation)).toThrow(RangeError);
    expect(() => rotateSide('x' as Side, 0)).toThrow(RangeError);
  });
});

describe('waterSideOf', () => {
  it.each([
    [0, 'n'],
    [90, 'e'],
    [180, 's'],
    [270, 'w'],
  ] as const)('berth pri %i° má vodu na strane %s', (rotation, side) => {
    expect(waterSideOf(berthDef, rotation)).toBe(side);
  });

  it('modul bez placement.waterSide → undefined', () => {
    expect(waterSideOf(craneDef, 0)).toBeUndefined();
  });
});

describe('footprintOf', () => {
  it('rot 0: rozmery defu, bunky row-major od (x, y)', () => {
    const { size, cells } = footprintOf(craneDef, 43, 14, 0);
    expect(size).toEqual({ w: 2, h: 3 });
    expect(cells).toEqual([
      { x: 43, y: 14 },
      { x: 44, y: 14 },
      { x: 43, y: 15 },
      { x: 44, y: 15 },
      { x: 43, y: 16 },
      { x: 44, y: 16 },
    ]);
  });

  it.each(ROTATIONS)('rot %i: rovnaká množina buniek ako rotateLocalCell + (x, y)', (rotation) => {
    const { size, cells } = footprintOf(berthDef, 10, 20, rotation);
    const expected = new Set<string>();
    for (let ly = 0; ly < berthDef.footprint.h; ly++) {
      for (let lx = 0; lx < berthDef.footprint.w; lx++) {
        const c = rotateLocalCell(lx, ly, berthDef.footprint.w, berthDef.footprint.h, rotation);
        expected.add(`${String(10 + c.x)},${String(20 + c.y)}`);
      }
    }
    expect(new Set(cells.map((c) => `${String(c.x)},${String(c.y)}`))).toEqual(expected);
    expect(cells).toHaveLength(size.w * size.h);
    expect(size).toEqual(rotation % 180 === 0 ? { w: 8, h: 3 } : { w: 3, h: 8 });
  });
});

describe('connectorsOf (§8 bod 7, T02-04)', () => {
  // berth_standard 8×3: konektory (1, 2, s) a (6, 2, s) pri rot 0 (manifest).
  it('rot 0: lokálne bunky + (x, y), strany bez zmeny, poradie z defu', () => {
    expect(connectorsOf(berthDef, 40, 14, 0)).toEqual([
      { x: 41, y: 16, side: 's', type: 'road' },
      { x: 46, y: 16, side: 's', type: 'road' },
    ]);
  });

  it.each(ROTATIONS)('rot %i: bunka = rotateLocalCell + (x, y), strana = rotateSide; leží vo footprinte', (rotation) => {
    const { w, h } = berthDef.footprint;
    const placed = connectorsOf(berthDef, 10, 20, rotation);
    const footprint = footprintOf(berthDef, 10, 20, rotation);
    expect(placed).toEqual(
      berthDef.connectors.map((connector) => {
        const cell = rotateLocalCell(connector.x, connector.y, w, h, rotation);
        return { x: 10 + cell.x, y: 20 + cell.y, side: rotateSide(connector.side, rotation), type: connector.type };
      }),
    );
    for (const { x, y } of placed) expect(footprint.cells).toContainEqual({ x, y });
  });

  it('rot 90: konektory na západnej hrane (strana w), 3×8 footprint', () => {
    expect(connectorsOf(berthDef, 0, 0, 90)).toEqual([
      { x: 0, y: 1, side: 'w', type: 'road' },
      { x: 0, y: 6, side: 'w', type: 'road' },
    ]);
  });

  it('modul bez konektorov → prázdne zmrazené pole', () => {
    const placed = connectorsOf(craneDef, 0, 0, 0);
    expect(placed).toEqual([]);
    expect(Object.isFrozen(placed)).toBe(true);
  });
});

describe('connectorOutside (vonkajšia bunka konektora, T03-02, ADR-017)', () => {
  const yardDef = MODULE_DEFS.modules.get('container_yard_small');

  it('Root berth (40, 14) rot 0: vonkajšie bunky (41, 17) a (46, 17) — pevnina pod nábrežím', () => {
    expect(connectorsOf(berthDef, 40, 14, 0).map(connectorOutside)).toEqual([
      { x: 41, y: 17 },
      { x: 46, y: 17 },
    ]);
  });

  // container_yard_small 4×4, konektor (1, 3, s): po rotácii bunka + strana, vonkajšia bunka o krok von z footprintu.
  it.each([
    [0, { x: 1, y: 3, side: 's' }, { x: 1, y: 4 }],
    [90, { x: 0, y: 1, side: 'w' }, { x: -1, y: 1 }],
    [180, { x: 2, y: 0, side: 'n' }, { x: 2, y: -1 }],
    [270, { x: 3, y: 2, side: 'e' }, { x: 4, y: 2 }],
  ] as const)('dvor rot %i: konektor %o → vonkajšia bunka %o (mimo footprintu)', (rotation, connector, outside) => {
    const [placed] = connectorsOf(yardDef, 0, 0, rotation);
    expect(placed).toMatchObject(connector);
    expect(connectorOutside(placed)).toEqual(outside);
    expect(footprintOf(yardDef, 0, 0, rotation).cells).not.toContainEqual(outside);
  });

  it.each(SIDES)('strana %s: krok podľa SIDE_STEPS, výsledok zmrazený', (side) => {
    const outside = connectorOutside({ x: 5, y: 5, side });
    expect(outside).toEqual({ x: 5 + SIDE_STEPS[side].dx, y: 5 + SIDE_STEPS[side].dy });
    expect(Object.isFrozen(outside)).toBe(true);
  });
});

describe('edgeCells / frontBandCells (pás vody pred kotviskom, T02-04)', () => {
  const origin = { x: 10, y: 20 };
  const size = { w: 3, h: 2 };

  it.each<[Side, { x: number; y: number }[]]>([
    ['n', [{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 12, y: 20 }]],
    ['s', [{ x: 10, y: 21 }, { x: 11, y: 21 }, { x: 12, y: 21 }]],
    ['e', [{ x: 12, y: 20 }, { x: 12, y: 21 }]],
    ['w', [{ x: 10, y: 20 }, { x: 10, y: 21 }]],
  ])('hrana %s', (side, cells) => {
    expect(edgeCells(origin, size, side)).toEqual(cells);
  });

  it('pás: riadky d = 1 … hĺbka od hrany, v rámci riadku poradie hrany', () => {
    expect(frontBandCells(origin, size, 'n', 2)).toEqual([
      { x: 10, y: 19 }, { x: 11, y: 19 }, { x: 12, y: 19 },
      { x: 10, y: 18 }, { x: 11, y: 18 }, { x: 12, y: 18 },
    ]);
    expect(frontBandCells(origin, size, 'e', 1)).toEqual([{ x: 13, y: 20 }, { x: 13, y: 21 }]);
    expect(frontBandCells(origin, size, 'w', 1)).toEqual([{ x: 9, y: 20 }, { x: 9, y: 21 }]);
    expect(frontBandCells(origin, size, 's', 0)).toEqual([]);
  });

  it('pás môže siahať mimo mapy (hranice overuje volajúci); záporná hĺbka → RangeError', () => {
    expect(frontBandCells({ x: 0, y: 0 }, size, 'n', 1)).toEqual([{ x: 0, y: -1 }, { x: 1, y: -1 }, { x: 2, y: -1 }]);
    expect(() => frontBandCells(origin, size, 'n', -1)).toThrow(RangeError);
    expect(() => frontBandCells(origin, size, 'n', 1.5)).toThrow(RangeError);
  });

  it('SIDE_STEPS zodpovedajú DIRECTIONS_4 (sever = menšie y)', () => {
    expect(SIDES.map((side) => SIDE_STEPS[side])).toEqual(DIRECTIONS_4.map(({ dx, dy }) => ({ dx, dy })));
  });
});
