import { describe, expect, it } from 'vitest';
import { locomotiveSprite, machineSprite, wagonSprite } from '../../src/render/entity-assets';
import { CAR_LENGTH_CELLS, HEAD_S, RAILS, TRACK_PATH, WAGON_CARGO } from '../../src/render/__demo__/r6-rail.fixtures';
import { buildRailPaths, nearestPath, placeCars, pointAt, projectOnPath, trainPosesOnPaths } from '../../src/render/rail-path';
import { BOGIE_HALF_CELLS, COUPLER_GAP_CELLS, RAIL_CURVE_RADIUS_CELLS } from '../../src/render/rail-config';
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

const cells = (pts: [number, number][]): { x: number; y: number }[] => pts.map(([x, y]) => ({ x, y }));
/** Úsek buniek od (x0,y0) po (x1,y1) po osi. */
const run = (x0: number, y0: number, x1: number, y1: number): [number, number][] => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return Array.from({ length: n + 1 }, (_, i) => [x0 + Math.sign(x1 - x0) * i, y0 + Math.sign(y1 - y0) * i]);
};

describe('buildRailPaths — zaoblenie rohov', () => {
  it('veľký roh dostane polomer RAIL_CURVE_RADIUS_CELLS', () => {
    const paths = buildRailPaths(cells([...run(0, 0, 10, 0), ...run(10, 1, 10, 10)]));
    expect(paths).toHaveLength(1);
    expect(paths[0]!.radii).toEqual([RAIL_CURVE_RADIUS_CELLS]);
    expect(paths[0]!.cells).toHaveLength(19); // všetky bunky okrem dvoch koncov
  });

  it('polomer sa orežie podľa voľného úseku (susedné rohy si delia úsek)', () => {
    const paths = buildRailPaths(cells([...run(0, 0, 4, 0), ...run(4, 1, 4, 3), ...run(3, 3, 0, 3)]));
    const radii = paths[0]!.radii;
    expect(radii).toHaveLength(2);
    for (const r of radii) expect(r).toBeLessThanOrEqual(1.5 + 1e-9); // úsek 3 medzi stredmi rohov → po 1,5 na roh
    expect(radii[0]).toBeGreaterThan(0.5);
  });

  it('roh pri konci bez miesta ostáva dlaždicou (cesta ním neprechádza)', () => {
    const paths = buildRailPaths(cells([...run(0, 0, 3, 0), ...run(3, 1, 3, 1)])); // roh priamo pred koncom
    expect(paths.every((p) => p.cells.length === 0 || p.radii.every((r) => r > 0.5))).toBe(true);
  });

  it('dotyčnica je spojitá: smer sa v žiadnom bode nezlomí viac ako malý krok', () => {
    const path = TRACK_PATH;
    for (let i = 1; i + 1 < path.points.length; i++) {
      const a = path.points[i - 1]!;
      const b = path.points[i]!;
      const c = path.points[i + 1]!;
      const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y));
      expect(Math.acos(Math.min(1, dot))).toBeLessThan(0.3); // < ~17° na vzorku, nie 90°
    }
    // na hranici priameho úseku a oblúka sa smer zhoduje s priamkou
    const start = pointAt(path, 0).dir;
    expect(Math.abs(start.x)).toBeCloseTo(1, 5);
  });

  it('T-križovatka ostáva uzlom (dlaždica), ramená sú samostatné cesty', () => {
    const paths = buildRailPaths(cells([...run(0, 5, 10, 5), ...run(5, 0, 5, 4)]));
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => !p.cells.includes('5,5'))).toBe(true);
  });

  it('os scény je jedna cesta s tromi zákrutami veľkého polomeru', () => {
    expect(buildRailPaths(RAILS)).toHaveLength(1);
    expect(TRACK_PATH.radii).toEqual([3, 3, 3]);
  });
});

describe('placeCars — vozy na oblúku', () => {
  const poses = placeCars(TRACK_PATH, HEAD_S, 1, 7, CAR_LENGTH_CELLS);

  it('oba podvozky každého voza ležia do 0,1 bunky od osi koľaje', () => {
    for (const pose of poses) {
      for (const bogie of [pose.front, pose.rear]) expect(projectOnPath(TRACK_PATH, bogie).dist).toBeLessThan(0.1);
    }
  });

  it('vzdialenosť podvozkov je ≈ 2 × BOGIE_HALF_CELLS a rozstup vozov dĺžka + spojka', () => {
    for (let i = 1; i < poses.length; i++) {
      const gap = projectOnPath(TRACK_PATH, poses[i - 1]!.front).s - projectOnPath(TRACK_PATH, poses[i]!.front).s;
      expect(gap).toBeCloseTo(CAR_LENGTH_CELLS + COUPLER_GAP_CELLS, 5);
    }
    for (const pose of poses) expect(Math.hypot(pose.front.x - pose.rear.x, pose.front.y - pose.rear.y)).toBeGreaterThan(BOGIE_HALF_CELLS * 1.9);
  });

  it('uhol sa v zákrute plynule mení od voza k vozu (žiadny skok > 70°)', () => {
    for (let i = 1; i < poses.length; i++) {
      const d = Math.abs((((poses[i]!.angle - poses[i - 1]!.angle) % 360) + 540) % 360 - 180);
      expect(d).toBeLessThan(70);
    }
    expect(new Set(poses.map((p) => Math.round(p.angle))).size).toBeGreaterThan(3);
  });

  it('trainPosesOnPaths: hlava zo simu sa premietne na os a smer určí jej uhol', () => {
    const head = poses[0]!;
    const same = trainPosesOnPaths([TRACK_PATH], head, 7, CAR_LENGTH_CELLS)!;
    expect(same[6]!.x).toBeCloseTo(poses[6]!.x, 5);
    const reversed = trainPosesOnPaths([TRACK_PATH], { ...head, angle: head.angle + 180 }, 3, CAR_LENGTH_CELLS)!;
    expect(reversed[1]!.y).toBeGreaterThan(head.y); // jazda na sever → ďalšie vozy sú južnejšie
    expect(trainPosesOnPaths([TRACK_PATH], { x: 0, y: 0, angle: 0 }, 3, CAR_LENGTH_CELLS)).toBeUndefined();
    expect(nearestPath([TRACK_PATH], head, 1)?.path).toBe(TRACK_PATH);
  });
});

describe('scéna R6', () => {
  it('koľaje scény sú unikátne bunky', () => {
    expect(new Set(RAILS.map((c) => `${String(c.x)},${String(c.y)}`)).size).toBe(RAILS.length);
  });
});
