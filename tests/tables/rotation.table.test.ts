import { describe, it, expect } from 'vitest';
import { rotateLocalCell, rotateFootprint } from '@sim/grid';

describe('rotation table', () => {
  // w=2, h=3: testy rotateLocalCell pre bunky (0,0), (1,0), (0,2), (1,2) pri rotáciách 0/90/180/270
  it.each<[number, number, number, number, number, number, number]>([
    // [x, y, w, h, rotation, expectedX, expectedY]
    // r0: (x, y) → (x, y)
    [0, 0, 2, 3, 0, 0, 0],
    [1, 0, 2, 3, 0, 1, 0],
    [0, 2, 2, 3, 0, 0, 2],
    [1, 2, 2, 3, 0, 1, 2],
    // r90: (x, y) → (h-1-y, x) = (2-y, x)
    [0, 0, 2, 3, 90, 2, 0],
    [1, 0, 2, 3, 90, 2, 1],
    [0, 2, 2, 3, 90, 0, 0],
    [1, 2, 2, 3, 90, 0, 1],
    // r180: (x, y) → (w-1-x, h-1-y) = (1-x, 2-y)
    [0, 0, 2, 3, 180, 1, 2],
    [1, 0, 2, 3, 180, 0, 2],
    [0, 2, 2, 3, 180, 1, 0],
    [1, 2, 2, 3, 180, 0, 0],
    // r270: (x, y) → (y, w-1-x) = (y, 1-x)
    [0, 0, 2, 3, 270, 0, 1],
    [1, 0, 2, 3, 270, 0, 0],
    [0, 2, 2, 3, 270, 2, 1],
    [1, 2, 2, 3, 270, 2, 0],
  ])(
    'rotateLocalCell($x, $y, 2, 3, $rotation) → ($expectedX, $expectedY)',
    (x, y, w, h, rotation, expectedX, expectedY) => {
      const result = rotateLocalCell(x, y, w, h, rotation as 0 | 90 | 180 | 270);
      expect(result).toEqual({ x: expectedX, y: expectedY });
    }
  );

  // rotateFootprint testy pre w=2, h=3
  it.each<[number, number, number, number, number]>([
    // [w, h, rotation, expectedW, expectedH]
    [2, 3, 0, 2, 3],
    [2, 3, 90, 3, 2],
    [2, 3, 180, 2, 3],
    [2, 3, 270, 3, 2],
  ])(
    'rotateFootprint(2, 3, $rotation) → { w: $expectedW, h: $expectedH }',
    (w, h, rotation, expectedW, expectedH) => {
      const result = rotateFootprint(w, h, rotation as 0 | 90 | 180 | 270);
      expect(result).toEqual({ w: expectedW, h: expectedH });
    }
  );
});
