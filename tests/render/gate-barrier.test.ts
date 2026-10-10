import { describe, expect, it } from 'vitest';
import { BARRIER_MOTION_MS, BarrierMotion } from '@render/gate-barrier';

/** Riadené hodiny pre animáciu závory. */
function clock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('BarrierMotion (uhol závory v čase)', () => {
  it('zatvorená = closedDeg, otvorená = openDeg; bez pohybu žiadny prechod', () => {
    const time = clock();
    const closed = new BarrierMotion(0, -90, 150, time.now, false);
    expect(closed.angle).toBe(0);
    expect(closed.open).toBe(false);
    const open = new BarrierMotion(0, -90, 150, time.now, true);
    expect(open.angle).toBe(-90);
    expect(open.open).toBe(true);
  });

  it('otvorenie beží lineárne po celé trvanie a potom drží openDeg', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 150, time.now, false);
    motion.setOpen(true);
    expect(motion.angle).toBe(0);
    time.advance(75);
    expect(motion.angle).toBeCloseTo(-45, 9);
    time.advance(75);
    expect(motion.angle).toBeCloseTo(-90, 9);
    time.advance(1000);
    expect(motion.angle).toBe(-90);
  });

  it('zmena cieľa uprostred pohybu začne z aktuálneho uhla (žiadny skok)', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 150, time.now, false);
    motion.setOpen(true);
    time.advance(50);
    const halfway = motion.angle;
    expect(halfway).toBeCloseTo(-30, 9);
    motion.setOpen(false);
    expect(motion.angle).toBeCloseTo(halfway, 9);
    time.advance(75);
    expect(motion.angle).toBeCloseTo(halfway / 2, 9);
  });

  it('opakované setOpen na ten istý cieľ pohyb nerestartuje', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 150, time.now, false);
    motion.setOpen(true);
    time.advance(75);
    motion.setOpen(true);
    expect(motion.angle).toBeCloseTo(-45, 9);
  });

  it('nulové trvanie = okamžitý prechod; trvanie je pod limitom 200 ms z DESIGN_BRIEF §6.4', () => {
    const time = clock();
    const motion = new BarrierMotion(0, -90, 0, time.now, false);
    motion.setOpen(true);
    expect(motion.angle).toBe(-90);
    expect(BARRIER_MOTION_MS).toBeLessThanOrEqual(200);
  });
});
