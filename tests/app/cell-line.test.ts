import { describe, expect, it } from 'vitest';
import type { CellCoord } from '@sim/grid';
import { interpolateCells } from '@app/cell-line';

const c = (x: number, y: number): CellCoord => ({ x, y });

/** Každé dve po sebe idúce bunky susedia hranou (Manhattan vzdialenosť presne 1). */
function isFourConnected(cells: readonly CellCoord[]): boolean {
  return cells.every((cell, i) => i === 0 || Math.abs(cell.x - cells[i - 1].x) + Math.abs(cell.y - cells[i - 1].y) === 1);
}

describe('interpolateCells', () => {
  it('rovnaká bunka → jedna bunka', () => {
    expect(interpolateCells(c(5, 7), c(5, 7))).toEqual([c(5, 7)]);
  });

  it('susedná bunka → obe, bez medzery', () => {
    expect(interpolateCells(c(2, 2), c(3, 2))).toEqual([c(2, 2), c(3, 2)]);
    expect(interpolateCells(c(2, 2), c(2, 1))).toEqual([c(2, 2), c(2, 1)]);
  });

  it('rýchly vodorovný a zvislý ťah nepreskočí žiadnu bunku', () => {
    expect(interpolateCells(c(0, 4), c(5, 4))).toEqual([c(0, 4), c(1, 4), c(2, 4), c(3, 4), c(4, 4), c(5, 4)]);
    expect(interpolateCells(c(3, 5), c(3, 1))).toEqual([c(3, 5), c(3, 4), c(3, 3), c(3, 2), c(3, 1)]);
  });

  it('diagonála → L-krok (najprv x, potom y), nikdy diagonálny skok', () => {
    expect(interpolateCells(c(0, 0), c(1, 1))).toEqual([c(0, 0), c(1, 0), c(1, 1)]);
    expect(interpolateCells(c(4, 4), c(3, 3))).toEqual([c(4, 4), c(3, 4), c(3, 3)]);
    expect(interpolateCells(c(0, 0), c(3, 3))).toEqual([c(0, 0), c(1, 0), c(1, 1), c(2, 1), c(2, 2), c(3, 2), c(3, 3)]);
  });

  it('šikmý ťah (2 : 1) sa drží ideálnej priamky a je súvislý', () => {
    expect(interpolateCells(c(0, 0), c(2, 1))).toEqual([c(0, 0), c(1, 0), c(1, 1), c(2, 1)]);
    expect(interpolateCells(c(0, 0), c(4, 1))).toEqual([c(0, 0), c(1, 0), c(2, 0), c(2, 1), c(3, 1), c(4, 1)]);
  });

  it('začína v `from`, končí v `to` a má dĺžku |Δx| + |Δy| + 1 vo všetkých smeroch', () => {
    const origin = c(10, 10);
    for (let dx = -9; dx <= 9; dx++) {
      for (let dy = -9; dy <= 9; dy++) {
        const target = c(origin.x + dx, origin.y + dy);
        const cells = interpolateCells(origin, target);
        expect(cells[0]).toEqual(origin);
        expect(cells[cells.length - 1]).toEqual(target);
        expect(cells).toHaveLength(Math.abs(dx) + Math.abs(dy) + 1);
        expect(isFourConnected(cells)).toBe(true);
      }
    }
  });

  it('bunky ležia blízko ideálnej úsečky (odchýlka stredu bunky < 1 bunka)', () => {
    const from = c(2, 3);
    const to = c(23, 11);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    for (const cell of interpolateCells(from, to)) {
      const distance = Math.abs((to.x - from.x) * (from.y - cell.y) - (from.x - cell.x) * (to.y - from.y)) / length;
      expect(distance).toBeLessThan(1);
    }
  });

  it('nikdy neopakuje bunku a je deterministická', () => {
    const cells = interpolateCells(c(-3, 8), c(14, -2));
    expect(new Set(cells.map(({ x, y }) => `${String(x)},${String(y)}`)).size).toBe(cells.length);
    expect(interpolateCells(c(-3, 8), c(14, -2))).toEqual(cells);
  });

  it('necelé súradnice → RangeError', () => {
    expect(() => interpolateCells(c(0.5, 0), c(3, 3))).toThrow(RangeError);
    expect(() => interpolateCells(c(0, 0), c(3, Number.NaN))).toThrow(RangeError);
  });
});
