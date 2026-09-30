// CargoLedger.assertConservation (§6 krok 12): odovzdá kontrole svoje skutočné štruktúry a porušenie vyhodí ako
// CargoConservationError. Vnútro ledgera je privátne, preto tento súbor obalí findConservationViolation (vi.mock) —
// zaznamená pohľad, ktorý ledger poslal, a vie podstrčiť porušenie.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Conservation from '@sim/cargo/cargo-conservation';
import { CargoConservationError, type CargoLedgerView } from '@sim/cargo';
import { CONTAINER_CHAIN, at, createHarness, id, moveThrough } from './cargo-fixtures';

const probe = vi.hoisted(() => ({
  injected: undefined as string | undefined,
  views: [] as unknown[],
}));

vi.mock('@sim/cargo/cargo-conservation', async (importOriginal) => {
  const original = await importOriginal<typeof Conservation>();
  return {
    ...original,
    findConservationViolation: (view: CargoLedgerView): string | undefined => {
      probe.views.push(view);
      return probe.injected ?? original.findConservationViolation(view);
    },
  };
});

afterEach(() => {
  probe.injected = undefined;
  probe.views.length = 0;
});

describe('CargoLedger.assertConservation', () => {
  it('kontrola dostane živé štruktúry ledgera (jednotky, indexy, počítadlá, createdCount)', () => {
    const { ledger } = createHarness();
    const a = ledger.create('container_teu', at.ship(100)).id;
    const b = ledger.create('container_teu', at.ship(100)).id;
    moveThrough(ledger, a, CONTAINER_CHAIN);
    moveThrough(ledger, b, CONTAINER_CHAIN.slice(0, 2));
    probe.views.length = 0;

    ledger.assertConservation();
    expect(probe.views).toHaveLength(1);
    const view = probe.views[0] as CargoLedgerView;
    expect([...view.units.keys()]).toEqual([b]);
    expect(view.units.get(b)).toBe(ledger.get(b));
    expect(view.buckets.get('on_apron')?.get(id(10))?.units).toEqual([b]);
    expect(view.buckets.get('on_ship')?.size).toBe(0); // prázdny index sa odstráni
    expect(view.counts.exported).toBe(1);
    expect(view.counts.on_apron).toBe(1);
    expect(view.createdCount).toBe(2);
  });

  it('porušenie → CargoConservationError so správou kontroly; ledger sa tým nemení', () => {
    const { ledger } = createHarness();
    ledger.create('container_teu', at.ship(100));
    probe.injected = 'jednotka #1 je v dvoch indexoch: index on_ship(shipId=100) a index in_crane(craneId=20)';
    expect(() => ledger.assertConservation()).toThrow(CargoConservationError);
    expect(() => ledger.assertConservation()).toThrow(
      'CargoLedger: porušená konzervácia nákladu — jednotka #1 je v dvoch indexoch: index on_ship(shipId=100) a index in_crane(craneId=20)',
    );
    probe.injected = undefined;
    expect(() => ledger.assertConservation()).not.toThrow();
    expect(ledger.liveCount).toBe(1);
  });
});
