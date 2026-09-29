import { describe, it, expect } from 'vitest';
import { autotileShape } from '@render/autotile';

describe('autotile table', () => {
  it.each<[number, string, number]>([
    // [mask, expectedShape, expectedRotation]
    [0, 'end', 0],
    [1, 'end', 0],
    [2, 'end', 90],
    [3, 'corner', 0],
    [4, 'end', 180],
    [5, 'straight', 0],
    [6, 'corner', 90],
    [7, 't', 90],
    [8, 'end', 270],
    [9, 'corner', 270],
    [10, 'straight', 90],
    [11, 't', 0],
    [12, 'corner', 180],
    [13, 't', 270],
    [14, 't', 180],
    [15, 'cross', 0],
  ])(
    'autotileShape($mask) → { shape: "$expectedShape", rotation: $expectedRotation }',
    (mask, expectedShape, expectedRotation) => {
      const result = autotileShape(mask);
      expect(result.shape).toBe(expectedShape);
      expect(result.rotation).toBe(expectedRotation);
    }
  );
});
