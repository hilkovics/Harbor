/**
 * Prijatie ponúk F6c (T6C-03, ADR-034 + dodatok): pripravenosť podľa druhu (`READINESS_BY_KIND`) — repositioning vyžaduje depo prázdnych, prekládka sklad
 * kategórie nákladu (obe `no_storage_for_category`, nový dôvod sa nezavádza) — a plán lode: príchod lode s cut-off exportom z `exportArrivalDaysRange`,
 * inak z `arrivalDaysRange` (prekládka a repositioning bez exportu cut-off nemajú), príchod lode B prekládky po `transhipGapDaysRange`.
 */
import { describe, expect, it } from 'vitest';
import { ExportContract } from '@sim/contracts';
import type { SimEvent } from '@sim/events';
import { acceptCommand, exportWorld, send, TICKS_PER_DAY } from '../helpers/f6a';
import { emptyWorld, f6cDefs, offerRepositioning, offerTranship } from '../helpers/f6c';

const reasonsOf = (events: readonly SimEvent[]): readonly string[] => events.flatMap((event) => (event.type === 'CommandRejected' ? event.reasons : []));

describe('AcceptContract — pripravenosť podľa druhu', () => {
  it('repositioning: s depom prázdnych sa prijme, bez depa no_storage_for_category', () => {
    const withDepot = emptyWorld({ defs: f6cDefs() });
    const accepted = offerRepositioning(withDepot);
    expect(send(withDepot, acceptCommand(accepted.id)).map((event) => event.type)).toContain('ContractAccepted');
    expect(accepted.state).toBe('accepted');

    const without = emptyWorld({ defs: f6cDefs(), depot: false });
    const refused = offerRepositioning(without);
    const events = send(without, acceptCommand(refused.id));
    expect(reasonsOf(events)).toEqual(['no_storage_for_category']);
    expect(refused.state).toBe('offered');
  });

  it('prekládka: so skladom kategórie sa prijme (depo nie je potrebné), bez skladu no_storage_for_category', () => {
    const noDepot = emptyWorld({ defs: f6cDefs(), depot: false });
    const leg = offerTranship(noDepot);
    expect(send(noDepot, acceptCommand(leg.id)).map((event) => event.type)).toContain('ContractAccepted');

    const noStorage = emptyWorld({ defs: f6cDefs(), depot: false, farYard: false });
    const refused = offerTranship(noStorage);
    expect(reasonsOf(send(noStorage, acceptCommand(refused.id)))).toEqual(['no_storage_for_category']);
    expect(refused.state).toBe('offered');
  });

  it('skupina export + repositioning jednej voyage: export kontroluje aj pozemnú stranu (bez brány no_gate_for_category), repositioning depo', () => {
    const world = emptyWorld({ defs: f6cDefs(), landside: [] });
    const repo = offerRepositioning(world, { withExport: 6 });
    expect(reasonsOf(send(world, acceptCommand(repo.id)))).toEqual(['no_gate_for_category']);
    expect(world.contracts.get((repo.id - 1) as never)?.state).toBe('offered');
    expect(repo.state).toBe('offered');
  });
});

describe('AcceptContract — plán lode podľa druhu', () => {
  const DAYS = { exportArrivalDaysRange: [2, 2], arrivalDaysRange: [0.5, 0.5], transhipGapDaysRange: [1.5, 1.5] };

  it('prekládka a repositioning bez exportu: príchod lode A z arrivalDaysRange (0,5 dňa), príchod lode B o transhipGapDaysRange (1,5 dňa) neskôr', () => {
    const world = exportWorld({ defs: f6cDefs({ economy: DAYS }) });
    const leg = offerTranship(world);
    send(world, acceptCommand(leg.id));
    expect(leg.shipArrivalTick).toBe(Math.round(0.5 * TICKS_PER_DAY));
    expect(leg.outArrivalTick).toBe(Math.round(0.5 * TICKS_PER_DAY) + Math.round(1.5 * TICKS_PER_DAY));
    expect(leg.booking.arrivalPlan).toEqual([]);
    expect(leg.booking.cutoffTick).toBeUndefined();

    const repoWorld = emptyWorld({ defs: f6cDefs({ economy: DAYS }) });
    const repo = offerRepositioning(repoWorld);
    send(repoWorld, acceptCommand(repo.id));
    expect(repo.shipArrivalTick).toBe(Math.round(0.5 * TICKS_PER_DAY));
    expect(repo.booking.cutoffTick).toBeUndefined();
    expect(repo.booking.arrivalPlan).toEqual([]);
  });

  it('repositioning spolu s exportom: skupina s cut-off exportom berie exportArrivalDaysRange (2 dni) a export dostane cut-off a plán príchodov', () => {
    const world = emptyWorld({ defs: f6cDefs({ economy: DAYS }) });
    const repo = offerRepositioning(world, { withExport: 6 });
    const exp = world.contracts.get((repo.id - 1) as never) as ExportContract;
    send(world, acceptCommand(exp.id));
    expect(exp.shipArrivalTick).toBe(2 * TICKS_PER_DAY);
    expect(repo.shipArrivalTick).toBe(2 * TICKS_PER_DAY);
    expect(exp.booking.arrivalPlan).toHaveLength(6);
    expect(repo.booking.arrivalPlan).toEqual([]);
    expect(repo.booking.cutoffTick).toBeUndefined();
    expect([exp.state, repo.state]).toEqual(['accepted', 'accepted']);
  });
});
