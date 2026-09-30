// Geometria modulov (T02-03): rotateSide (n → e → s → w v smere hodinových ručičiek), waterSideOf a footprintOf
// (ľavý horný roh po rotácii, bunky row-major) — zhodné s rotateLocalCell (ARCHITECTURE §8 bod 7).
import { describe, expect, it } from 'vitest';
import { SIDES, type Side } from '@sim/defs';
import { ROTATIONS, rotateLocalCell, type Rotation } from '@sim/grid';
import { footprintOf, rotateSide, waterSideOf } from '@sim/modules';
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
