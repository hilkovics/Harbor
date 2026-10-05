/**
 * Zlyhanie (SLA + `failAfterDaysLate`) export bookingu počas nakládky (T6A-09b, review src/sim, major 2; ADR-032 bod 12–14).
 *
 * Booking v `exporting` s naloženým exportom na lodi sa pri uplynutí lehoty neskončí ako `failed` s nákladom na palube (`exportAboard`
 * 0, export by sa počítal ako import a loď by navždy čakala — v režime `apron` by žeriav hodil `ModuleError`), ale sa uzavrie
 * rovnako ako pri odchode lode: výplata pomerne k naloženým, loď odíde a export na palube je `shipped`.
 *
 * `importAboard` / `exportAboard` rozlišujú náklad lode podľa smeru jednotky (`unit.direction`), nie podľa otvorených bookingov.
 */
import { describe, expect, it } from 'vitest';
import type { DefRegistry } from '@sim/defs';
import { exportAboard, importAboard } from '@sim/logistics/voyage-cargo';
import type { World } from '@sim/world';
import { TICKS_PER_DAY, apronDefs, contractOf, hookDefs, lostUnits, ofType, startLoading, tickUntil } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';

const TIMEOUT = 60_000;
const EARLY = [10, 20, 30, 40, 50, 60];

/** Tickuje po prvú naloženú jednotku (loď pri kotvisku nakladá), potom vynúti uplynutie lehoty bookingu. */
function forceOverdueDuringLoading(defs: DefRegistry): { readonly world: World; readonly contractId: number; readonly loadedBefore: number } {
  const run = startLoading({ defs, kind: 'export', booked: 6, arrivals: EARLY });
  const { world } = run;
  const contract = run.offer.exportContract;
  tickUntil(world, () => contract.booking.loadedUnits >= 2 && contract.booking.loadedUnits < contract.booking.bookedUnits, TIMEOUT);
  const loadedBefore = contract.booking.loadedUnits;
  contract.slaDeadlineTick = world.clock.tick - (world.defs.economy.failAfterDaysLate + 1) * TICKS_PER_DAY;
  return { world, contractId: contract.id, loadedBefore };
}

describe.each([
  ['apron', () => apronDefs()],
  ['under_hook', () => hookDefs()],
])('booking po lehote počas nakládky — režim %s', (_mode, makeDefs) => {
  it('booking sa uzavrie (pomerná výplata), loď odíde a naložený export je shipped; nič sa nestratí', () => {
    const { world, contractId, loadedBefore } = forceOverdueDuringLoading(makeDefs());
    const events = tickUntil(world, (w) => w.ships.size === 0, TIMEOUT);
    assertCargoConservation(world);
    world.assertInvariants();

    const contract = contractOf(world, contractId);
    const loaded = contract.booking?.loadedUnits;
    expect(contract.state).toBe('completed');
    const shipped = ofType(events, 'ExportShipped');
    expect(shipped).toHaveLength(1);
    // Na loď sa dostali aspoň jednotky naložené pred vynúteným uzavretím; všetky naložené odplávali.
    expect(shipped[0].event.units).toBeGreaterThanOrEqual(loadedBefore);
    expect(shipped[0].event.units).toBe(loaded);
    expect(world.cargo.shippedCount).toBe(loaded);
    expect(ofType(events, 'ContractCompleted')).toHaveLength(1);
    expect(lostUnits(world)).toBe(0);
  });

  it('po lehote nevznikne nový job nakládky; rozbehnutá nakládka sa dokončí a booking sa neskončí ako failed', () => {
    const { world, contractId } = forceOverdueDuringLoading(makeDefs());
    let lastJobId = 0;
    for (const job of world.jobs.values()) lastJobId = Math.max(lastJobId, job.id);
    const late: number[] = [];
    const events = tickUntil(world, (w) => {
      for (const job of w.jobs.values()) {
        if (job.id > lastJobId && (job.to.kind === 'on_apron' || job.to.kind === 'in_crane') && w.cargo.get(job.unitIds[0])?.contractId === contractId) late.push(job.id);
      }
      return w.ships.size === 0;
    }, TIMEOUT);
    expect(late).toEqual([]);
    expect(ofType(events, 'ContractFailed')).toHaveLength(0);
    expect(contractOf(world, contractId).state).toBe('completed');
  });

  it('svet beží po odchode lode ďalej: nenaložené jednotky sa vrátia odosielateľovi, invarianty držia', () => {
    const { world } = forceOverdueDuringLoading(makeDefs());
    tickUntil(world, (w) => w.ships.size === 0, TIMEOUT);
    tickUntil(world, (w) => w.cargo.liveCount === 0, TIMEOUT);
    assertCargoConservation(world);
    world.assertInvariants();
    expect(lostUnits(world)).toBe(0);
    expect(world.cargo.exportedCount + world.cargo.shippedCount).toBe(world.cargo.createdCount);
  });
});

describe('importAboard / exportAboard podľa smeru jednotky', () => {
  it('uzavretý booking s exportom na palube: export sa nepočíta ako import', () => {
    const { world, contractId } = forceOverdueDuringLoading(apronDefs());
    const contract = contractOf(world, contractId);
    // Ihneď po zlyhaní lehoty (krok 2 nasledujúceho ticku) je booking uzavretý, ale loď je ešte pri kotvisku s naloženým exportom.
    let shipId: number | undefined;
    for (let i = 0; i < TIMEOUT && contract.state !== 'completed' && contract.state !== 'failed'; i++) {
      world.tick();
      shipId = contract.shipId;
    }
    expect(shipId).toBeDefined();
    const ship = world.ships.get(shipId as never);
    expect(ship).toBeDefined();
    const aboard = world.cargo.countAt('on_ship', shipId as never);
    expect(aboard).toBeGreaterThan(0);
    expect(exportAboard(world, shipId as never)).toBe(aboard);
    expect(importAboard(world, shipId as never)).toBe(0);
  });
});
