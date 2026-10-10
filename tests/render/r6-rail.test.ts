import { describe, expect, it } from 'vitest';
import { locomotiveSprite, machineSprite, wagonSprite } from '../../src/render/entity-assets';
import { CAR_LENGTH_CELLS, RAILS, TRACK_PATH, WAGON_CARGO, carPoses } from '../../src/render/__demo__/r6-rail.fixtures';
import { wagonSlots } from '../../src/render/train-view';
import type { ContainerVM } from '../../src/render/view-models';

const box = (sizeFt: 20 | 40): ContainerVM => ({ sizeFt, containerType: 'dry', lineId: null, direction: 'import' });

describe('R6 manifest', () => {
  it('lokomotíva, vagón 60′ a RMG sú v manifeste', () => {
    expect(locomotiveSprite()?.footprint).toEqual({ w: 1, h: 3 });
    expect(wagonSprite()?.slots20).toHaveLength(3);
    const rmg = machineSprite('rmg');
    expect(rmg?.frame.footprint).toEqual({ w: 6, h: 2 });
    expect(rmg?.trolley.pivot).toEqual({ x: 32, y: 32 });
    expect(rmg?.travelX).toEqual({ yMin: 32, yMax: 352 });
  });
});

describe('wagonSlots', () => {
  const wagon = wagonSprite()!;

  it('3 × 20′ → tri sloty po tretinách', () => {
    expect(wagonSlots([box(20), box(20), box(20)], wagon).map((s) => s.centerY)).toEqual([34, 96, 158]);
  });

  it('40′ + 20′: 40′ na slot40, 20′ na poslednej tretine', () => {
    const slots = wagonSlots([box(40), box(20)], wagon);
    expect(slots.map((s) => [s.sizeFt, s.centerY])).toEqual([
      [40, 65],
      [20, 158],
    ]);
  });

  it('viac ako 3 TEU sa nezmestí', () => {
    expect(wagonSlots([box(40), box(40)], wagon)).toHaveLength(1);
    expect(wagonSlots([box(20), box(20), box(20), box(20)], wagon)).toHaveLength(3);
  });

  it('náklad scény sa zmestí na vagóny', () => {
    for (const cargo of WAGON_CARGO) expect(wagonSlots(cargo, wagon)).toHaveLength(cargo.length);
  });
});

describe('carPoses', () => {
  const poses = carPoses(TRACK_PATH, 7);

  it('hlava ide na juh (180°), chvost po zákrute na západ (270°), medzi tým kĺb', () => {
    expect(poses[0]!.angle).toBeCloseTo(180, 5);
    expect((poses[6]!.angle + 360) % 360).toBeCloseTo(270, 5);
    expect(poses.some((p) => ((p.angle + 360) % 360 > 180) && ((p.angle + 360) % 360 < 270))).toBe(true);
  });

  it('susedné vozy sú od seba približne o dĺžku vozňa', () => {
    for (let i = 1; i < poses.length; i++) {
      const d = Math.hypot(poses[i]!.x - poses[i - 1]!.x, poses[i]!.y - poses[i - 1]!.y);
      expect(d).toBeGreaterThan(CAR_LENGTH_CELLS * 0.7);
      expect(d).toBeLessThanOrEqual(CAR_LENGTH_CELLS + 1e-9);
    }
  });

  it('koľaje scény sú unikátne bunky', () => {
    expect(new Set(RAILS.map((c) => `${String(c.x)},${String(c.y)}`)).size).toBe(RAILS.length);
  });
});
