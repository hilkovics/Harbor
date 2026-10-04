/**
 * Uloženie a načítanie uprostred príchodov exportu (F6a, T6A-04, ADR-032 bod 15): plán príchodov, kamióny v každom stave
 * (aj vykladajúce s rezerváciou docku), zadržané jednotky (VGM hold, odvodený `HoldIndex`) a jednotky `at_ramp` / `in_storage`
 * sa po roundtripe správajú bitovo rovnako ako nepretržitý beh (rovnaké udalosti a `stateHash`).
 */
import { describe, expect, it } from 'vitest';
import { World, stateHash, type AnyWorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, acceptedBooking, exportWorld, f6aDefs, lostUnits, tickEvents } from '../helpers/f6a';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Svet s bookingom 8 TEU, pevným plánom príchodov a VGM hold na každej jednotke (hold 1 hodinu). */
function busyWorld(): World {
  const defs = f6aDefs({ exportFlow: { vgmMissingChance: 1, vgmHoldHours: 1 } });
  const world = exportWorld({ defs });
  const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 8 });
  (exportContract.booking.arrivalPlan as number[]).splice(0, 8, 5, 30, 45, 120, 130, 400, 900, 2000);
  return world;
}

describe('roundtrip uprostred príchodov exportu', () => {
  const defs = f6aDefs({ exportFlow: { vgmMissingChance: 1, vgmHoldHours: 1 } });
  const AT = [1, 60, 99, 110, 125, 140, 300, 1000, 2200, 3700];
  const TOTAL = 5000;

  it.each(AT)('uloženie v ticku %i: pokračovanie dá rovnaké udalosti a stateHash ako nepretržitý beh, invarianty držia', (at) => {
    const reference = busyWorld();
    tickEvents(reference, at);
    const branch = World.deserialize(defs, MAP, clone(reference.serialize()) as unknown as AnyWorldState);
    expect(findWorldViolation(branch)).toBeUndefined();
    expect(stateHash(branch)).toBe(stateHash(reference));
    const expected = tickEvents(reference, TOTAL - at).map((entry) => JSON.stringify(entry));
    const actual = tickEvents(branch, TOTAL - at).map((entry) => JSON.stringify(entry));
    expect(actual).toEqual(expected);
    expect(stateHash(branch)).toBe(stateHash(reference));
    expect(lostUnits(branch)).toBe(0);
  });

  it('uložený stav nesie plán príchodov, počítadlá bookingu a hold jednotky; index hold je odvodený (nie v save)', () => {
    const world = busyWorld();
    tickEvents(world, 140);
    const state = world.serialize();
    const contract = state.contracts[0];
    expect(contract.kind).toBe('export');
    expect(contract.booking?.arrivalPlan.length).toBeGreaterThan(0);
    expect(contract.booking?.arrivedUnits).toBeGreaterThan(0);
    expect(contract.booking?.heldUnits).toBeGreaterThan(0);
    expect(state.cargo.units.filter((unit) => unit.hold !== null)).toHaveLength(contract.booking?.heldUnits ?? -1);
    expect('holdIndex' in state).toBe(false);
    const restored = World.deserialize(defs, MAP, clone(state) as unknown as AnyWorldState);
    expect(restored.holdIndex.all).toEqual(world.holdIndex.all);
  });

  it('vykladajúci delivery kamión sa obnoví s rezerváciou docku (staging miesto) a dokončí vykládku', () => {
    const world = busyWorld();
    let state: AnyWorldState | undefined;
    for (let i = 0; i < 400 && state === undefined; i++) {
      world.tick();
      if ([...world.trucks.values()].some((truck) => truck.state === 'unloading')) state = clone(world.serialize()) as unknown as AnyWorldState;
    }
    expect(state).toBeDefined();
    const restored = World.deserialize(defs, MAP, state as AnyWorldState);
    const truck = [...restored.trucks.values()].find((candidate) => candidate.state === 'unloading');
    expect(truck).toBeDefined();
    expect(restored.cargo.countAt('in_truck', truck!.id)).toBe(1);
    tickEvents(restored, 50);
    expect(restored.trucks.get(truck!.id)?.state).not.toBe('unloading');
    expect(findWorldViolation(restored)).toBeUndefined();
  });
});
