import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateFootprint, rotateLocalCell, type Rotation } from '@sim/grid';
import { moduleSprite } from '@render/entity-assets';
import { footprintPose, localCellCenter, localCellWorldCenter, rotateOffset, type FootprintBox } from '@render/footprint-pose';
import { PALETTE } from './stub-textures';

const CELL = PALETTE.cellPx;

/** Footprint berthu 8×3 (manifest) umiestnený s ľavým horným rohom (40, 14) po rotácii. */
function berthBox(rotation: Rotation): FootprintBox {
  const rotated = rotateFootprint(8, 3, rotation);
  return { x: 40, y: 14, w: rotated.w, h: rotated.h, rotation };
}

describe('footprintPose (rotácia okolo stredu footprintu)', () => {
  it('rot 0: stred = ľavý horný roh + polovica rozmerov, rozmery pred rotáciou = rozmery', () => {
    expect(footprintPose(berthBox(0), CELL)).toEqual({ cx: 44 * CELL, cy: 15.5 * CELL, angle: 0, baseW: 8, baseH: 3 });
  });

  it('rot 90: footprint po rotácii je 3×8, sprite ostáva 8×3 a kontajner sa otočí o 90°', () => {
    expect(footprintPose(berthBox(90), CELL)).toEqual({ cx: 41.5 * CELL, cy: 18 * CELL, angle: 90, baseW: 8, baseH: 3 });
  });

  it.each(ROTATIONS)('rot %i: rozmery pred rotáciou sú vždy 8×3', (rotation) => {
    const pose = footprintPose(berthBox(rotation), CELL);
    expect([pose.baseW, pose.baseH]).toEqual([8, 3]);
    expect(pose.angle).toBe(rotation);
  });
});

describe('rotateOffset', () => {
  it.each([
    [0, { x: 3, y: 5 }],
    [90, { x: -5, y: 3 }],
    [180, { x: -3, y: -5 }],
    [270, { x: 5, y: -3 }],
  ] as const)('rot %i otočí vektor (3, 5) v smere hodinových ručičiek', (rotation, expected) => {
    expect(rotateOffset(3, 5, rotation)).toEqual(expected);
  });

  it('nulová zložka nedáva zápornú nulu', () => {
    for (const rotation of ROTATIONS) {
      const rotated = rotateOffset(0, 0, rotation);
      expect(Object.is(rotated.x, 0) && Object.is(rotated.y, 0)).toBe(true);
    }
  });
});

describe('pozícia apron slotov a konektorov po rotácii', () => {
  const berth = moduleSprite('berth_standard');

  it('manifest: berth_standard má 8 apron slotov a 2 konektory', () => {
    expect(berth?.apronSlots).toHaveLength(8);
    expect(berth?.connectors).toHaveLength(2);
  });

  it.each(ROTATIONS)('rot %i: stred slotu sa zhoduje s rotateLocalCell zo simu (bunka + 0,5)', (rotation) => {
    const box = berthBox(rotation);
    for (const slot of [...(berth?.apronSlots ?? []), ...(berth?.connectors ?? [])]) {
      const cell = rotateLocalCell(slot.x, slot.y, 8, 3, rotation);
      const world = localCellWorldCenter(box, slot, CELL);
      expect(world.x).toBeCloseTo((box.x + cell.x + 0.5) * CELL, 9);
      expect(world.y).toBeCloseTo((box.y + cell.y + 0.5) * CELL, 9);
    }
  });

  it('localCellCenter: lokálna súradnica pred rotáciou je vzhľadom na stred footprintu', () => {
    // slot (1, 1) vo footprinte 8×3: stred bunky (1,5; 1,5) − stred footprintu (4; 1,5) = (−2,5; 0)
    expect(localCellCenter({ x: 1, y: 1 }, 8, 3, CELL)).toEqual({ x: -2.5 * CELL, y: 0 });
  });
});
