import { describe, expect, it } from 'vitest';
import { ROTATIONS, isRotation, rotateFootprint, rotateLocalCell, type Rotation } from '@sim/grid';

// Tabuľka z docs/tasks/phase-01.md („Spoločné rozhrania“), v smere hodinových ručičiek, y nadol.
const EXPECTED: Record<Rotation, (x: number, y: number, w: number, h: number) => { x: number; y: number }> = {
  0: (x, y) => ({ x, y }),
  90: (x, y, _w, h) => ({ x: h - 1 - y, y: x }),
  180: (x, y, w, h) => ({ x: w - 1 - x, y: h - 1 - y }),
  270: (x, y, w) => ({ x: y, y: w - 1 - x }),
};

/** Footprinty z karty: 2×3 (žeriav) a 8×3 (kotvisko), plus nesymetrické a štvorcové pre istotu. */
const FOOTPRINTS: readonly [number, number][] = [
  [2, 3],
  [8, 3],
  [1, 2],
  [4, 4],
  [1, 1],
];

function localCells(w: number, h: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x, y });
  return cells;
}

describe('ROTATIONS / isRotation', () => {
  it('štyri rotácie 0, 90, 180, 270', () => {
    expect(ROTATIONS).toEqual([0, 90, 180, 270]);
    for (const r of ROTATIONS) expect(isRotation(r)).toBe(true);
  });

  it.each([45, -90, 360, 1, '90', null, undefined, Number.NaN])('isRotation(%j) = false', (value) => {
    expect(isRotation(value)).toBe(false);
  });
});

describe('rotateFootprint', () => {
  it.each([
    [2, 3, 0, 2, 3],
    [2, 3, 90, 3, 2],
    [2, 3, 180, 2, 3],
    [2, 3, 270, 3, 2],
    [8, 3, 0, 8, 3],
    [8, 3, 90, 3, 8],
    [8, 3, 180, 8, 3],
    [8, 3, 270, 3, 8],
  ] as const)('%i×%i pri %i° → %i×%i', (w, h, r, rw, rh) => {
    expect(rotateFootprint(w, h, r)).toEqual({ w: rw, h: rh });
  });

  it('neplatné vstupy → RangeError', () => {
    expect(() => rotateFootprint(0, 3, 0)).toThrow(RangeError);
    expect(() => rotateFootprint(2, 1.5, 90)).toThrow(RangeError);
    expect(() => rotateFootprint(2, 3, 45 as Rotation)).toThrow(RangeError);
  });
});

describe('rotateLocalCell', () => {
  describe.each(FOOTPRINTS)('footprint %i×%i', (w, h) => {
    it.each(ROTATIONS)('rotácia %i° podľa tabuľky, do rozsahu rotovaného footprintu, bijekcia', (r) => {
      const size = rotateFootprint(w, h, r);
      const seen = new Set<string>();
      for (const { x, y } of localCells(w, h)) {
        const out = rotateLocalCell(x, y, w, h, r);
        expect(out).toEqual(EXPECTED[r](x, y, w, h));
        expect(Number.isInteger(out.x) && Number.isInteger(out.y)).toBe(true);
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.x).toBeLessThan(size.w);
        expect(out.y).toBeLessThan(size.h);
        seen.add(`${out.x},${out.y}`);
      }
      // Injektívne a počet buniek sa zhoduje s rotovaným footprintom → bijekcia.
      expect(seen.size).toBe(w * h);
      expect(seen.size).toBe(size.w * size.h);
    });

    it('4× rotácia o 90° = identita', () => {
      for (const start of localCells(w, h)) {
        let cell = start;
        let dims = { w, h };
        for (let step = 0; step < 4; step++) {
          cell = rotateLocalCell(cell.x, cell.y, dims.w, dims.h, 90);
          dims = rotateFootprint(dims.w, dims.h, 90);
        }
        expect(dims).toEqual({ w, h });
        expect(cell).toEqual(start);
      }
    });

    it('90° ∘ 90° = 180° a 90° ∘ 180° = 270°', () => {
      for (const { x, y } of localCells(w, h)) {
        const once = rotateLocalCell(x, y, w, h, 90);
        const d1 = rotateFootprint(w, h, 90);
        const twice = rotateLocalCell(once.x, once.y, d1.w, d1.h, 90);
        expect(twice).toEqual(rotateLocalCell(x, y, w, h, 180));
        const thrice = rotateLocalCell(once.x, once.y, d1.w, d1.h, 180);
        expect(thrice).toEqual(rotateLocalCell(x, y, w, h, 270));
      }
    });
  });

  it('v smere hodinových ručičiek: ľavý horný roh 8×3 → pravý horný (90°), pravý dolný (180°), ľavý dolný (270°)', () => {
    expect(rotateLocalCell(0, 0, 8, 3, 90)).toEqual({ x: 2, y: 0 });
    expect(rotateLocalCell(0, 0, 8, 3, 180)).toEqual({ x: 7, y: 2 });
    expect(rotateLocalCell(0, 0, 8, 3, 270)).toEqual({ x: 0, y: 7 });
    // Dlhá horná hrana 8×3 (y = 0) po 90° leží na pravej hrane (x = 2) rotovaného 3×8.
    for (let x = 0; x < 8; x++) expect(rotateLocalCell(x, 0, 8, 3, 90)).toEqual({ x: 2, y: x });
  });

  it('bunky 2×3 pri 90° (explicitne)', () => {
    const out = localCells(2, 3).map(({ x, y }) => rotateLocalCell(x, y, 2, 3, 90));
    expect(out).toEqual([
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      { x: 0, y: 1 },
    ]);
  });

  it.each([
    [-1, 0],
    [0, -1],
    [2, 0],
    [0, 3],
    [0.5, 0],
  ])('bunka (%s, %s) mimo footprintu 2×3 → RangeError', (x, y) => {
    expect(() => rotateLocalCell(x, y, 2, 3, 0)).toThrow(RangeError);
  });

  it('neplatná rotácia alebo footprint → RangeError', () => {
    expect(() => rotateLocalCell(0, 0, 2, 3, 45 as Rotation)).toThrow(RangeError);
    expect(() => rotateLocalCell(0, 0, 0, 3, 90)).toThrow(RangeError);
  });
});
