// TR4-03: manifest záznamy pruhov brány, plôch a TP overlayov + konzistencia scén demo `r4-gates.html`.
import { describe, expect, it } from 'vitest';
import { R4_SCENES, roofPartOf } from '@render/__demo__/r4-gates.fixtures';
import { entitySpriteFiles, moduleSprite } from '@render/entity-assets';
import { gateLaneBarrierOpen, roofFile } from '@render/gate-lane-decor';

describe('manifest R4', () => {
  it('pruhy brány: strecha single + left / mid / right, rozmer 1 × 4', () => {
    for (const id of ['gate_in_lane', 'gate_out_lane']) {
      const entry = moduleSprite(id);
      expect(entry?.footprint).toEqual({ w: 1, h: 4 });
      expect(roofFile(entry, 'single')).toBe(`modules/${id}_single.svg`);
      for (const part of ['left', 'mid', 'right'] as const) expect(roofFile(entry, part)).toBe(`modules/${id}_${part}.svg`);
      expect(roofFile(entry, undefined)).toBe(`modules/${id}_single.svg`);
    }
  });

  it('závora je zdieľaná (pivot 9,32; offset 0,24; −90° otvorená) a všetky súbory idú do atlasu', () => {
    const barrier = moduleSprite('gate_lane_barrier')?.parts?.['barrier'];
    expect(barrier).toMatchObject({ pivot: { x: 9, y: 32 }, offset: { x: 0, y: 24 }, closedDeg: 0, openDeg: -90 });
    const files = entitySpriteFiles();
    for (const file of ['modules/gate_lane_barrier.svg', 'modules/pre_gate_lane.svg', 'modules/truck_holding.svg', 'overlay/tp_marker.svg', 'overlay/safe_zone.svg']) {
      expect(files, file).toContain(file);
    }
  });

  it('predbránová plocha 8 × 8 sa skladá z pruhov 1 × 6', () => {
    const entry = moduleSprite('pre_gate_buffer');
    expect(entry?.footprint).toEqual({ w: 8, h: 8 });
    expect(entry?.file).toBeUndefined();
    expect(entry?.parts?.['lane']?.footprint).toEqual({ w: 1, h: 6 });
  });
});

describe('gate lane VM', () => {
  it('závora je hore, kým pruh nespracúva krok', () => {
    expect(gateLaneBarrierOpen({ kind: 'in', mode: 'normal' })).toBe(true);
    expect(gateLaneBarrierOpen({ kind: 'in', mode: 'normal', step: 'ocr', progress: 0.5 })).toBe(false);
  });

  it('strecha: left, mid…, right; samostatný pruh single', () => {
    expect([0, 1, 2, 3].map((i) => roofPartOf(i, 4))).toEqual(['left', 'mid', 'mid', 'right']);
    expect(roofPartOf(0, 1)).toBe('single');
  });
});

describe('scény demo r4-gates', () => {
  it('moduly sa neprekrývajú a kamióny stoja na vlastných bunkách', () => {
    for (const scene of Object.values(R4_SCENES)) {
      const taken = new Set<string>();
      for (const m of scene.vm.modules ?? []) {
        for (let dx = 0; dx < m.w; dx += 1) {
          for (let dy = 0; dy < m.h; dy += 1) {
            const key = `${String(m.x + dx)},${String(m.y + dy)}`;
            expect(taken.has(key), `${m.defId} ${key}`).toBe(false);
            taken.add(key);
          }
        }
      }
      const heads = new Set<string>();
      for (const truck of scene.vm.trucks ?? []) {
        const key = `${String(Math.floor(truck.x))},${String(Math.floor(truck.y))}`;
        expect(heads.has(key), `kamión ${String(truck.id)}`).toBe(false);
        heads.add(key);
      }
    }
  });

  it('scéna gates: 8 vstupných + 4 výstupné pruhy s pruhom brány a 8 pruhov predbránovej plochy', () => {
    const modules = R4_SCENES.gates.vm.modules ?? [];
    expect(modules.filter((m) => m.gateLane?.kind === 'in')).toHaveLength(8);
    expect(modules.filter((m) => m.gateLane?.kind === 'out')).toHaveLength(4);
    expect(modules.some((m) => m.defId === 'pre_gate_buffer')).toBe(true);
  });
});
