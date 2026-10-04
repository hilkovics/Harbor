/**
 * Rýchla cesta bez exportu (F6a, T6A-05, ADR-032, ADR-033): `ContractBook.hasOpenExports` je O(1) príznak neukončeného export
 * bookingu (aj ponuky). Bez neho žeriav, dispatcher a loď export nepočítajú, takže import-only svet ostáva bitovo aj výkonovo
 * rovnaký ako vo F5. Príznak sa drží pri vzniku ponuky, prežije obnovu zo save a zhasne pri uzavretí bookingu.
 */
import { describe, expect, it } from 'vitest';
import { World, type AnyWorldState } from '@sim/world';
import { MAP, exportWorld, f6aDefs, hookDefs, offerBooking, runUntilDeparted, startLoading } from '../helpers/f6a';

describe('ContractBook.hasOpenExports', () => {
  it('prázdna kniha: false; ponuka roundtripu (aj bez prijatia): true', () => {
    const world = exportWorld();
    expect(world.contractBook.hasOpenExports).toBe(false);
    offerBooking(world, { kind: 'roundtrip' });
    expect(world.contractBook.hasOpenExports).toBe(true);
  });

  it('rovnako pre export-only booking', () => {
    const world = exportWorld();
    offerBooking(world, { kind: 'export' });
    expect(world.contractBook.hasOpenExports).toBe(true);
  });

  it('príznak prežije obnovu zo save uprostred bookingu a po uzavretí bookingu (odchod lode) zhasne', () => {
    for (const defs of [f6aDefs(), hookDefs(1)]) {
      const run = startLoading({ defs, vehicles: ['straddle_carrier', 'straddle_carrier'], kind: 'roundtrip', booked: 6, importUnits: 6, arrivals: [10, 20, 30, 40, 50, 60] });
      expect(run.world.contractBook.hasOpenExports).toBe(true);
      for (let i = 0; i < 100; i++) run.world.tick();
      const restored = World.deserialize(defs, MAP, JSON.parse(JSON.stringify(run.world.serialize())) as AnyWorldState);
      expect(restored.contractBook.hasOpenExports).toBe(true);
      runUntilDeparted(run.world, 40_000);
      expect(run.world.contractBook.hasOpenExports).toBe(false);
      expect(run.offer.exportContract.state).toBe('completed');
    }
  });
});
