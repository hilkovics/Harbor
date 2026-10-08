// Konzistencia scén demo TR3-03 (`src/render/__demo__/r3-sts-rtg.fixtures.ts`): ťahače stoja na cestách bez zdieľania buniek, pruhy ležia vo footprinte kotviska.
import { describe, expect, it } from 'vitest';
import { loadBundledMap } from '@sim/grid';
import { BERTH_LANES, BERTH_X, BERTH_Y, R3_SCENES } from '@render/__demo__/r3-sts-rtg.fixtures';
import { createR1Grid } from '@render/__demo__/r1-traffic.fixtures';

const map = loadBundledMap();
const key = (x: number, y: number): string => `${String(Math.floor(x))},${String(Math.floor(y))}`;

describe.each(Object.entries(R3_SCENES))('scéna %s', (_name, scene) => {
  const grid = createR1Grid(map, scene);
  const roads = new Set(scene.roads.map((cell) => key(cell.x, cell.y)));

  it('cesty ležia na pevnine a ťahače (hlava aj stopa) stoja na cestách bez zdieľania buniek', () => {
    for (const cell of scene.roads) expect(['land', 'quay'], `cesta (${String(cell.x)}; ${String(cell.y)})`).toContain(grid.at(cell.x, cell.y).terrain);
    const owner = new Map<string, number>();
    for (const vehicle of scene.vm.vehicles ?? []) {
      const line = [{ x: vehicle.x, y: vehicle.y }, ...(vehicle.body ?? [])];
      expect(line.length, `ťahač ${String(vehicle.id)}`).toBe(vehicle.lengthCells);
      expect(vehicle.defId).toBe('terminal_tractor');
      for (const point of line) {
        const cell = key(point.x, point.y);
        expect(roads.has(cell), `ťahač ${String(vehicle.id)}: ${cell} nie je cesta`).toBe(true);
        expect(owner.has(cell), `bunka ${cell}`).toBe(false);
        owner.set(cell, vehicle.id);
      }
    }
  });
});

describe('kotvisko 8 × 4', () => {
  it('pruhy ležia vo footprinte a nemajú duplicity', () => {
    const cells = new Set<string>();
    for (const lane of BERTH_LANES) {
      expect(lane.x).toBeGreaterThanOrEqual(BERTH_X);
      expect(lane.x).toBeLessThan(BERTH_X + 8);
      expect(lane.y).toBeGreaterThan(BERTH_Y); // rad 0 je koľajnica / hrana nábrežia
      expect(lane.y).toBeLessThan(BERTH_Y + 4);
      expect(cells.has(key(lane.x, lane.y))).toBe(false);
      cells.add(key(lane.x, lane.y));
    }
    expect(cells.size).toBe(24);
  });
});
