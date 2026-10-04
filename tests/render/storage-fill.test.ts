import { describe, expect, it } from 'vitest';
import { FILL_STATES, fillState, fillStateKey, type FillState } from '@render/storage-fill';

describe('fillState (zaplnenosť skladu → stav spritu)', () => {
  // Hranice podľa karty T03-08: stored === 0 → 0; stored >= capacity → 100; inak pomer < 0,375 → 25,
  // < 0,625 → 50, inak 75. Kapacita 64 (container_yard_small): 24/64 = 0,375 a 40/64 = 0,625 sú presné v double.
  it.each<[number, number, FillState]>([
    [0, 64, 0],
    [1, 64, 25],
    [23, 64, 25],
    [24, 64, 50], // presne 0,375 už nie je < 0,375
    [25, 64, 50],
    [39, 64, 50],
    [40, 64, 75], // presne 0,625 už nie je < 0,625
    [48, 64, 75],
    [63, 64, 75],
    [64, 64, 100],
    [65, 64, 100], // nad kapacitou (nemá nastať, ale sprite ostáva `fill100`)
  ])('stored %i / capacity %i → fill%i', (stored, capacity, expected) => {
    expect(fillState(stored, capacity)).toBe(expected);
  });

  it('malá kapacita: 1 z 8 = 12,5 % → 25; 3 z 8 = 37,5 % → 50; 5 z 8 = 62,5 % → 75; 8 z 8 → 100', () => {
    expect(fillState(1, 8)).toBe(25);
    expect(fillState(3, 8)).toBe(50);
    expect(fillState(5, 8)).toBe(75);
    expect(fillState(8, 8)).toBe(100);
  });

  it('okrajové vstupy: prázdny sklad je vždy 0, nulová kapacita s nákladom je plná, záporné / NaN nie je náklad', () => {
    expect(fillState(0, 0)).toBe(0);
    expect(fillState(1, 0)).toBe(100);
    expect(fillState(-3, 64)).toBe(0);
    expect(fillState(Number.NaN, 64)).toBe(0);
    expect(fillState(0, Number.NaN)).toBe(0);
  });

  it('stav je nemenný v čase: rovnaký vstup dáva rovnaký výstup a pomer sa monotónne nezmenšuje', () => {
    let previous: FillState = 0;
    for (let stored = 0; stored <= 64; stored += 1) {
      const state = fillState(stored, 64);
      expect(FILL_STATES).toContain(state);
      expect(state).toBeGreaterThanOrEqual(previous);
      previous = state;
    }
    expect(previous).toBe(100);
  });
});

describe('fillStateKey (kľúč v manifeste `sprites.<defId>.states`)', () => {
  it.each<[FillState, string]>([
    [0, 'fill00'],
    [25, 'fill25'],
    [50, 'fill50'],
    [75, 'fill75'],
    [100, 'fill100'],
  ])('%i → %s', (state, key) => {
    expect(fillStateKey(state)).toBe(key);
  });

  it('FILL_STATES sú práve päť stavov z DESIGN_BRIEF §4', () => {
    expect([...FILL_STATES]).toEqual([0, 25, 50, 75, 100]);
  });
});
