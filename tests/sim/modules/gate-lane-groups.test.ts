// Zoskupenie susedných pruhov brány pre strechu (R4, ADR-041 bod 9): adjacentLaneGroups — single / left / mid / right podľa susedstva kolmo na jazdu.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { adjacentLaneGroups, moduleRegistry, TruckGate, type LaneRoofPlacement, type Module } from '@sim/modules';
import { RAW_DEFS } from '../world/world-fixtures';
import { emptyCargo, quayGrid } from './module-fixtures';

const DEFS = DefRegistry.fromRaw(RAW_DEFS);
const GRID = quayGrid(40, 30);

let nextId = 1;
function lane(defId: 'gate_in_lane' | 'gate_out_lane', x: number, y: number, rotation: 0 | 90 | 180 | 270): TruckGate {
  const module = moduleRegistry.create(DEFS.modules.get(defId), { defId, x, y, rotation }, nextId as EntityId, 0, { grid: GRID, cargo: emptyCargo(DEFS) });
  nextId += 1;
  if (!(module instanceof TruckGate)) throw new Error('nie je pruh brány');
  return module;
}

const placements = (modules: readonly Module[]): LaneRoofPlacement['position'][] => {
  const map = adjacentLaneGroups(modules);
  return modules.map((module) => map.get(module.id)?.position ?? ('single' as const));
};

describe('adjacentLaneGroups', () => {
  it('samostatný pruh je single; bez pruhov je výsledok prázdny', () => {
    const only = lane('gate_in_lane', 10, 10, 0);
    expect(adjacentLaneGroups([only]).get(only.id)).toEqual({ position: 'single', group: 0, groupSize: 1 });
    expect(adjacentLaneGroups([]).size).toBe(0);
  });

  it('dva susedné pruhy (rot 0, 1×4) = left + right; tri = left, mid, right; osem = left, 6× mid, right', () => {
    const two = [lane('gate_in_lane', 10, 5, 0), lane('gate_in_lane', 11, 5, 0)];
    expect(placements(two)).toEqual(['left', 'right']);
    const three = [lane('gate_in_lane', 10, 5, 0), lane('gate_in_lane', 11, 5, 0), lane('gate_in_lane', 12, 5, 0)];
    expect(placements(three)).toEqual(['left', 'mid', 'right']);
    const eight = Array.from({ length: 8 }, (_unused, i) => lane('gate_in_lane', 20 + i, 5, 0));
    expect(placements(eight)).toEqual(['left', 'mid', 'mid', 'mid', 'mid', 'mid', 'mid', 'right']);
    expect(new Set([...adjacentLaneGroups(eight).values()].map((entry) => entry.group)).size).toBe(1);
    expect(adjacentLaneGroups(eight).get(eight[3].id)?.groupSize).toBe(8);
  });

  it('poradie je podľa kolmej súradnice, nie podľa id (stavba sprava doľava)', () => {
    const right = lane('gate_in_lane', 12, 5, 0);
    const left = lane('gate_in_lane', 11, 5, 0);
    const map = adjacentLaneGroups([right, left]);
    expect(map.get(left.id)?.position).toBe('left');
    expect(map.get(right.id)?.position).toBe('right');
  });

  it('medzera, iný smer, iná rotácia alebo posun pozdĺž jazdy skupinu rozdelia; skupiny sú číslované podľa polohy', () => {
    const a = lane('gate_in_lane', 10, 5, 0);
    const gap = lane('gate_in_lane', 12, 5, 0); // medzera jedného stĺpca
    const out = lane('gate_out_lane', 11, 5, 0); // iný smer, hoci susedí
    const shifted = lane('gate_in_lane', 13, 6, 0); // posun pozdĺž jazdy
    const rotated = lane('gate_in_lane', 20, 5, 90); // vodorovný pruh 4×1
    const map = adjacentLaneGroups([a, gap, out, shifted, rotated]);
    for (const module of [a, gap, out, shifted, rotated]) expect(map.get(module.id)?.position, module.label).toBe('single');
    expect(new Set([...map.values()].map((entry) => entry.group)).size).toBe(5);
  });

  it('vodorovné pruhy (rot 90 / 270, 4×1) sa zoskupia nad sebou; rot 90 a 270 sú rôzne skupiny', () => {
    const top = lane('gate_in_lane', 10, 10, 90);
    const bottom = lane('gate_in_lane', 10, 11, 90);
    const opposite = lane('gate_in_lane', 10, 12, 270);
    const map = adjacentLaneGroups([top, bottom, opposite]);
    expect([map.get(top.id)?.position, map.get(bottom.id)?.position, map.get(opposite.id)?.position]).toEqual(['left', 'right', 'single']);
  });

  it('moduly iných druhov sa ignorujú', () => {
    const berthLike = lane('gate_in_lane', 3, 3, 0);
    const map = adjacentLaneGroups([berthLike, { id: 999 as EntityId } as unknown as Module]);
    expect(map.size).toBe(1);
  });
});
