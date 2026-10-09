// Počítadlá vnútrozemia (T6D-01, ADR-035): počet a súčet a maximum čakania vpustených kamiónov podľa misie, vzdané kamióny a ticky nedostatku stojísk pre odvoz;
// čistý JSON stav (`getState` / `fromState`) a obrat kamiónov (TTT).
import { describe, expect, it } from 'vitest';
import { Hinterland, emptyHinterlandState } from '../../../src/sim/trucks/hinterland';

describe('Hinterland — počítadlá', () => {
  it('nová hra: samé nuly', () => {
    const hinterland = new Hinterland();
    expect(hinterland.getState()).toEqual(emptyHinterlandState());
    expect([hinterland.admitted('delivery'), hinterland.admitted('collect'), hinterland.pickupBayStarvationTicks]).toEqual([0, 0, 0]);
  });

  it('recordAdmitted: počet, súčet a maximum čakania podľa misie; recordTurnedAway nezasahuje do čakania', () => {
    const hinterland = new Hinterland();
    hinterland.recordAdmitted('delivery', 0);
    hinterland.recordAdmitted('delivery', 40);
    hinterland.recordAdmitted('delivery', 25);
    hinterland.recordAdmitted('collect', 7);
    hinterland.recordTurnedAway('collect');
    hinterland.recordTurnedAway('collect');
    expect(hinterland.getState()).toEqual({
      delivery: { admitted: 3, waitTicksTotal: 65, waitTicksMax: 40, turnedAway: 0 },
      collect: { admitted: 1, waitTicksTotal: 7, waitTicksMax: 7, turnedAway: 2 },
      pickupBayStarvationTicks: 0,
      truckTurn: { trucks: 0, ticksTotal: 0, ticksMax: 0 },
    });
    expect([hinterland.waitTicksTotal('delivery'), hinterland.waitTicksMax('delivery'), hinterland.turnedAway('collect')]).toEqual([65, 40, 2]);
  });

  it('recordPickupStarved: najviac raz za tick (viac dopytov v tom istom ticku sa počíta ako jeden)', () => {
    const hinterland = new Hinterland();
    hinterland.recordPickupStarved(10);
    hinterland.recordPickupStarved(10);
    hinterland.recordPickupStarved(10);
    hinterland.recordPickupStarved(11);
    expect(hinterland.pickupBayStarvationTicks).toBe(2);
  });

  it('getState je nová kópia a fromState obnoví rovnaké počítadlá bez zdieľania objektov so vstupom', () => {
    const hinterland = new Hinterland();
    hinterland.recordAdmitted('collect', 12);
    hinterland.recordPickupStarved(3);
    const state = hinterland.getState();
    hinterland.recordAdmitted('collect', 1);
    expect(state.collect.admitted).toBe(1);
    const restored = Hinterland.fromState(state);
    restored.recordAdmitted('collect', 5);
    expect(state.collect).toEqual({ admitted: 1, waitTicksTotal: 12, waitTicksMax: 12, turnedAway: 0 });
    expect(restored.admitted('collect')).toBe(2);
    expect(restored.pickupBayStarvationTicks).toBe(1);
  });
});

describe('Hinterland — obrat kamióna (TTT, R4 ADR-041)', () => {
  it('recordTurn: počet, súčet a maximum pobytu kamiónov od vstupného pruhu po výjazd; presiahnutie max sa prejaví v getteri aj v stave', () => {
    const hinterland = new Hinterland();
    expect([hinterland.turnTrucks, hinterland.turnTicksTotal, hinterland.turnTicksMax]).toEqual([0, 0, 0]);
    hinterland.recordTurn(300);
    hinterland.recordTurn(900);
    hinterland.recordTurn(120);
    expect([hinterland.turnTrucks, hinterland.turnTicksTotal, hinterland.turnTicksMax]).toEqual([3, 1320, 900]);
    expect(hinterland.getState().truckTurn).toEqual({ trucks: 3, ticksTotal: 1320, ticksMax: 900 });
    const restored = Hinterland.fromState(hinterland.getState());
    restored.recordTurn(10);
    expect([restored.turnTrucks, hinterland.turnTrucks]).toEqual([4, 3]);
  });
});
