import { describe, expect, it } from 'vitest';
import { LaneSlots, keyCell, keyLane, serializeSlots, slotKey, slotKeyOf } from '@sim/traffic';

describe('LaneSlots', () => {
  it('kľúč slotu = bunka × 2 + pruh a späť', () => {
    expect([slotKey(7, 0), slotKey(7, 1)]).toEqual([14, 15]);
    expect([keyCell(15), keyLane(15), keyCell(14), keyLane(14)]).toEqual([7, 1, 7, 0]);
    expect(serializeSlots([14, 15])).toEqual([[7, 0], [7, 1]]);
    expect(slotKeyOf([7, 1])).toBe(15);
  });

  it('claim / release / holderOf: voľný slot nemá držiteľa, počet obsadených sa udržiava', () => {
    const slots = new LaneSlots(10);
    expect(slots.holderOf(3, 0)).toBeNull();
    slots.claim(slotKey(3, 0), 5);
    slots.claim(slotKey(3, 1), 6);
    expect([slots.holderOf(3, 0), slots.holderOf(3, 1), slots.holderOfKey(slotKey(3, 1))]).toEqual([5, 6, 6]);
    expect(slots.claimedCount).toBe(2);
    slots.release(slotKey(3, 0), 5);
    expect([slots.holderOf(3, 0), slots.claimedCount]).toEqual([null, 1]);
  });

  it('vlastný slot sa dá zaberať znova (idempotentne), cudzí nie; uvoľniť smie len držiteľ', () => {
    const slots = new LaneSlots(4);
    slots.claim(2, 9);
    slots.claim(2, 9);
    expect(slots.claimedCount).toBe(1);
    expect(() => slots.claim(2, 8)).toThrow(/drží #9/);
    expect(() => slots.release(2, 8)).toThrow(/drží #9/);
    expect(slots.isFreeFor(2, 9)).toBe(true);
    expect(slots.isFreeFor(2, 8)).toBe(false);
    expect(slots.isFreeFor(3, 8)).toBe(true);
  });
});
