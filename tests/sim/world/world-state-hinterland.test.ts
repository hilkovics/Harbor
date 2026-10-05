/**
 * WorldState: počítadlá vnútrozemia `hinterland` v save (T6D-01, ADR-035; ARCHITECTURE §14) — nenulové počítadlá sa načítajú, roundtrip dá rovnaký stav
 * a poškodené `hinterland` → `WorldStateError` s JSON pointerom. Základ je čerstvý svet (clean break savov, ADR-036: bez fixtures).
 */
import { describe, expect, it } from 'vitest';
import { World, WorldStateError, type WorldState } from '@sim/world';
import { DEFS, MAP } from './world-fixtures';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, raw as WorldState);
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

describe('WorldState: počítadlá vnútrozemia v save', () => {
  const base = (): WorldState => clone(World.create(DEFS, MAP, 4242).serialize());
  const WITH_COUNTS = {
    delivery: { admitted: 3, waitTicksTotal: 90, waitTicksMax: 50, turnedAway: 1 },
    collect: { admitted: 2, waitTicksTotal: 10, waitTicksMax: 10, turnedAway: 4 },
    pickupBayStarvationTicks: 123,
  };

  it('nenulové počítadlá sa načítajú a roundtrip dá rovnaký stav', () => {
    const state: WorldState = { ...base(), hinterland: WITH_COUNTS };
    const world = World.deserialize(DEFS, MAP, clone(state));
    expect(world.hinterland.admitted('delivery')).toBe(3);
    expect(world.hinterland.waitTicksTotal('delivery')).toBe(90);
    expect(world.hinterland.waitTicksMax('collect')).toBe(10);
    expect(world.hinterland.turnedAway('collect')).toBe(4);
    expect(world.hinterland.pickupBayStarvationTicks).toBe(123);
    expect(JSON.stringify(world.serialize())).toBe(JSON.stringify(state));
  });

  const CORRUPTIONS: readonly [string, (state: WorldState) => unknown, string][] = [
    ['chýba hinterland', (s) => ({ ...s, hinterland: undefined }), '/hinterland'],
    ['hinterland nie je objekt', (s) => ({ ...s, hinterland: 3 }), '/hinterland'],
    ['neznámy kľúč', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, extra: 1 } }), '/hinterland/extra'],
    ['chýba misia collect', (s) => ({ ...s, hinterland: { delivery: WITH_COUNTS.delivery, pickupBayStarvationTicks: 0 } }), '/hinterland/collect'],
    ['záporné vpustené', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, delivery: { ...WITH_COUNTS.delivery, admitted: -1 } } }), '/hinterland/delivery/admitted'],
    ['neceločíselné čakanie', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, collect: { ...WITH_COUNTS.collect, waitTicksTotal: 1.5 } } }), '/hinterland/collect/waitTicksTotal'],
    ['maximum nad súčtom', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, delivery: { ...WITH_COUNTS.delivery, waitTicksMax: 91 } } }), '/hinterland/delivery/waitTicksMax'],
    ['čakanie bez vpustených', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, collect: { admitted: 0, waitTicksTotal: 5, waitTicksMax: 5, turnedAway: 0 } } }), '/hinterland/collect/waitTicksTotal'],
    ['záporné ticky nedostatku', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, pickupBayStarvationTicks: -2 } }), '/hinterland/pickupBayStarvationTicks'],
  ];

  it.each(CORRUPTIONS)('%s → WorldStateError s cestou', (_name, corrupt, path) => {
    expect(loadError(clone(corrupt(base()))).path).toBe(path);
  });
});
