// F6a (T6A-06): žeriav pri nakládke animuje opačný smer (apron → loď), dual cyklus nadväzuje bez skoku vozíka.
import { describe, expect, it } from 'vitest';
import { CRANE_CYCLES, CRANE_CYCLE_TRAITS } from '@sim/modules';
import {
  CRANE_BOOM_TILT_DEG,
  CRANE_CYCLE_STYLE,
  CraneView,
  craneBoomTilt,
  craneCycleDirection,
  trolleyBoomY,
  trolleyTravelFraction,
  type CraneState,
} from '@render/crane-view';
import { moduleSprite } from '@render/entity-assets';
import type { CraneCycleVM, CraneVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const SPRITE = moduleSprite('crane_container_gantry');
const TRAVEL = SPRITE?.parts?.['trolley']?.travel ?? { yMin: 0, yMax: 0 };
const BOOM_PIVOT = SPRITE?.parts?.['boom']?.pivot ?? { x: 0, y: 0 };

function crane(over: Partial<CraneVM> = {}): CraneVM {
  return { id: 7, defId: 'crane_container_gantry', berthId: 1, x: 43, y: 14, rotation: 0, state: 'idle', progress: 0, holding: null, ...over };
}

function view(vm: CraneVM): CraneView {
  return new CraneView(vm, { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures() });
}

describe('CRANE_CYCLE_STYLE (zrkadlo CRANE_CYCLE_TRAITS simu)', () => {
  it('pokrýva presne smery cyklu simu', () => {
    expect(Object.keys(CRANE_CYCLE_STYLE).sort()).toEqual([...CRANE_CYCLES].sort());
  });

  it.each(CRANE_CYCLES)('%s: smer animácie = smer v CRANE_CYCLE_TRAITS', (cycle) => {
    expect(CRANE_CYCLE_STYLE[cycle].direction).toBe(CRANE_CYCLE_TRAITS[cycle].direction);
    expect(craneCycleDirection(cycle)).toBe(CRANE_CYCLE_TRAITS[cycle].direction);
  });

  it('chýbajúci cycle (VM z F2–F6) = vykládka', () => {
    expect(craneCycleDirection(undefined)).toBe('unload');
  });
});

describe('trolleyTravelFraction podľa smeru cyklu (0 = pevnina / apron, 1 = more / loď)', () => {
  it('bez cycle sa správa ako vykládka (spätná kompatibilita F2)', () => {
    for (const state of ['idle', 'grabbing', 'swinging', 'placing', 'blocked'] as const) {
      for (const progress of [0, 0.3, 1]) expect(trolleyTravelFraction(state, progress)).toBe(trolleyTravelFraction(state, progress, 'unload'));
    }
  });

  it.each([
    ['grabbing', 0, 0],
    ['grabbing', 0.5, 0.5],
    ['grabbing', 1, 1],
    ['swinging', 0.5, 1],
    ['placing', 0, 1],
    ['placing', 0.5, 0.5],
    ['placing', 1, 0],
  ] as const)('unload %s pri %f → %f', (state, progress, expected) => {
    expect(trolleyTravelFraction(state, progress, 'unload')).toBeCloseTo(expected, 12);
  });

  it.each([
    ['grabbing', 0, 1],
    ['grabbing', 0.5, 0.5],
    ['grabbing', 1, 0],
    ['swinging', 0.5, 0],
    ['placing', 0, 0],
    ['placing', 0.25, 0.25],
    ['placing', 1, 1],
  ] as const)('load (opačný smer) %s pri %f → %f', (state, progress, expected) => {
    expect(trolleyTravelFraction(state, progress, 'load')).toBeCloseTo(expected, 12);
  });

  it('nakládka: vozík pri grabbing smeruje k aprone (klesá), pri placing k lodi (rastie) — opak vykládky', () => {
    const at = (state: CraneState, progress: number, cycle: CraneCycleVM): number => trolleyTravelFraction(state, progress, cycle);
    expect(at('grabbing', 0.8, 'load')).toBeLessThan(at('grabbing', 0.2, 'load'));
    expect(at('placing', 0.8, 'load')).toBeGreaterThan(at('placing', 0.2, 'load'));
    expect(at('grabbing', 0.8, 'unload')).toBeGreaterThan(at('grabbing', 0.2, 'unload'));
    expect(at('placing', 0.8, 'unload')).toBeLessThan(at('placing', 0.2, 'unload'));
  });

  it('idle a blocked stoja na pevnine pri každom smere', () => {
    for (const cycle of CRANE_CYCLES) {
      expect(trolleyTravelFraction('idle', 0.5, cycle)).toBe(0);
      expect(trolleyTravelFraction('blocked', 0.5, cycle)).toBe(0);
    }
  });

  it('opakovaná nakládka nadväzuje: koniec placing (pri lodi) = začiatok ďalšieho grabbing', () => {
    expect(trolleyTravelFraction('placing', 1, 'load')).toBe(trolleyTravelFraction('grabbing', 0, 'load'));
  });

  it('vykládka nadväzuje na seba (koniec placing = začiatok grabbing) aj na dual cyklus a naopak', () => {
    expect(trolleyTravelFraction('placing', 1, 'unload')).toBe(trolleyTravelFraction('grabbing', 0, 'unload'));
    // dual: nakládka pri aprone → položí pri lodi → vykládka od lode → položí pri aprone → ďalšia nakládka pri aprone
    expect(trolleyTravelFraction('placing', 1, 'dual_load')).toBe(trolleyTravelFraction('grabbing', 0, 'dual_unload'));
    expect(trolleyTravelFraction('placing', 1, 'dual_unload')).toBe(trolleyTravelFraction('grabbing', 0, 'dual_load'));
  });

  it('dual cyklus: nakládková polovica ide od apronu k lodi, vykládková od lode k aprone, uchopenie stojí', () => {
    expect(trolleyTravelFraction('grabbing', 0.5, 'dual_load')).toBe(0);
    expect(trolleyTravelFraction('placing', 0.5, 'dual_load')).toBeCloseTo(0.5, 12);
    expect(trolleyTravelFraction('placing', 1, 'dual_load')).toBe(1);
    expect(trolleyTravelFraction('grabbing', 0.5, 'dual_unload')).toBe(1);
    expect(trolleyTravelFraction('placing', 0.5, 'dual_unload')).toBeCloseTo(0.5, 12);
    expect(trolleyTravelFraction('placing', 1, 'dual_unload')).toBe(0);
  });

  it('progress mimo 0..1 sa orezá aj pri nakládke', () => {
    expect(trolleyTravelFraction('grabbing', -1, 'load')).toBe(1);
    expect(trolleyTravelFraction('placing', 2, 'load')).toBe(1);
  });
});

describe('craneBoomTilt (sklon výložníka podľa smeru)', () => {
  it('vykládka má sklon z tabuľky, nakládka opačný', () => {
    expect(craneBoomTilt('grabbing', undefined)).toBe(CRANE_BOOM_TILT_DEG.grabbing);
    expect(craneBoomTilt('grabbing', 'unload')).toBe(CRANE_BOOM_TILT_DEG.grabbing);
    expect(craneBoomTilt('grabbing', 'load')).toBe(-CRANE_BOOM_TILT_DEG.grabbing);
    expect(craneBoomTilt('placing', 'load')).toBe(-CRANE_BOOM_TILT_DEG.placing);
    expect(craneBoomTilt('placing', 'dual_unload')).toBe(CRANE_BOOM_TILT_DEG.placing);
    expect(craneBoomTilt('idle', 'load')).toBe(0);
  });
});

describe('CraneView: nakládka', () => {
  const offsetAt = (state: CraneState, progress: number, cycle: CraneCycleVM | undefined): number => {
    const vm = crane({ state, progress, ...(cycle === undefined ? {} : { cycle }) });
    return view(vm).trolleyOffsetY;
  };

  it('vozík pri nakládke v grabbing/0 stojí pri mori a v placing/1 tiež (vozík jazdí apron ↔ loď po výložníku)', () => {
    const sea = (trolleyBoomY(1, TRAVEL) - BOOM_PIVOT.y) * (CELL / 64);
    expect(offsetAt('grabbing', 0, 'load')).toBeCloseTo(sea, 6);
    expect(offsetAt('placing', 1, 'load')).toBeCloseTo(sea, 6);
  });

  it('v strede cyklu je vozík v rovnakej polohe pri oboch smeroch, ale smeruje opačne', () => {
    expect(offsetAt('grabbing', 0.5, 'load')).toBeCloseTo(offsetAt('grabbing', 0.5, 'unload'), 9);
    const early = offsetAt('grabbing', 0.2, 'load');
    const late = offsetAt('grabbing', 0.8, 'load');
    expect(late).toBeGreaterThan(early); // záporné = k moru: vozík sa od mora vzďaľuje
    const unloadEarly = offsetAt('grabbing', 0.2, 'unload');
    const unloadLate = offsetAt('grabbing', 0.8, 'unload');
    expect(unloadLate).toBeLessThan(unloadEarly); // vykládka: vozík ide k lodi
  });

  it('zmena cycle pri rovnakej fáze a postupe prepočíta vozík a sklon výložníka', () => {
    const unload = view(crane({ state: 'grabbing', progress: 0.2 }));
    const before = unload.trolleyOffsetY;
    const tiltBefore = unload.boomAngle;
    unload.update(crane({ state: 'grabbing', progress: 0.2, cycle: 'load' }));
    expect(unload.trolleyOffsetY).not.toBeCloseTo(before, 3);
    expect(unload.boomAngle).toBe(-tiltBefore);
    expect(unload.vm.cycle).toBe('load');
  });

  it('držaný náklad pri placing nakládky visí pod vozíkom (ako pri vykládke)', () => {
    const loading = view(crane({ state: 'placing', progress: 0.4, cycle: 'load', holding: { unitId: 5, typeId: 'container_teu' } }));
    expect(loading.heldCargo?.unitId).toBe(5);
    loading.update(crane({ state: 'idle', cycle: 'unload' }));
    expect(loading.heldCargo).toBeNull();
  });
});
