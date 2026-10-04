// Počítadlá vnútrozemia (T6D-01, ADR-035): počet a súčet a maximum čakania vpustených kamiónov podľa misie, vzdané kamióny a ticky nedostatku stojísk pre odvoz;
// čistý JSON stav (`getState` / `fromState`) a pravidlá `TRUCK_MISSION_USES_PICKUP_BAYS`.
import { describe, expect, it } from 'vitest';
import { Hinterland, emptyHinterlandState } from '../../../src/sim/trucks/hinterland';
import { TRUCK_MISSION_USES_PICKUP_BAYS } from '../../../src/sim/trucks/truck-fsm';

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

describe('TRUCK_MISSION_USES_PICKUP_BAYS', () => {
  it('stojiská rezervované pre odvoz smú obsadiť misie, ktoré náklad odvážajú (pickup, collect), nie dovoz (delivery)', () => {
    expect(TRUCK_MISSION_USES_PICKUP_BAYS).toEqual({ pickup: true, delivery: false, collect: true });
  });
});
