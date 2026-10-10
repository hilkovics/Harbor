// Invariant kroku 12 pre tok prázdnych (T6C-02, ADR-034 dodatok; R4 ADR-041): depo drží len prázdne, kamión misie `collect` má poverenie, kým neodíde, poverenie ukazuje na platnú
// jednotku jeho linky s jobom `receive` tohto kamióna (po naložení je jednotka v kamióne).
import { describe, expect, it } from 'vitest';
import { IMPORT_LABELS } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptedBooking } from '../helpers/f6a';
import { depotOf, emptyWorld, putEmpty, runUntil } from '../helpers/f6c';

describe('checkEmptyFlow — depo a poverenia', () => {
  it('depo prázdnych drží import jednotku → porušenie (depo prijíma len prázdne)', () => {
    const world = emptyWorld();
    expect(findWorldViolation(world)).toBeUndefined();
    const depot = depotOf(world);
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }, null, IMPORT_LABELS);
    const slot = depot.reserve();
    world.cargo.move(unit.id, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(unit.id, { kind: 'in_storage', moduleId: depot.id, slot });
    depot.commit(slot, unit.id);
    expect(findWorldViolation(world)).toMatch(/depo prijíma len prázdne/);
  });

  it('kamión collect bez poverenia → porušenie; po obnovení poverenia aj pridelenej jednotky je svet v poriadku a kamión odíde s prázdnym', () => {
    const world = emptyWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 3, 'blue_anchor', exportContract.id);
    runUntil(world, (w) => w.emptyFlow.errands.length === 1, 100, 'vznik kamióna collect');
    const [errand] = world.emptyFlow.errands;
    world.emptyFlow.removeErrand(errand.truckId);
    expect(findWorldViolation(world)).toMatch(/\(collect\) v stave '[a-z_]+' nemá poverenie/);
    world.emptyFlow.addErrand(errand.truckId, errand.lineId, errand.contractId, errand.giveUpTick);
    expect(findWorldViolation(world)).toMatch(/nemá pridelený prázdny kontajner/);
    world.emptyFlow.assignErrandUnit(errand.truckId, unitId);
    expect(findWorldViolation(world)).toBeUndefined();
    // invarianty (krok 12 každý tick) držia až po opustenie mapy kamiónom s prázdnym
    runUntil(world, (w) => w.trucks.size === 0 && w.emptyFlow.errands.length === 0, 6_000, 'odchod s prázdnym');
    expect(world.cargo.exportedCount).toBe(1);
  });

  it('poverenie s jednotkou inej linky → porušenie; po vrátení správnej jednotky je svet v poriadku', () => {
    const world = emptyWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 3, 'blue_anchor', exportContract.id);
    runUntil(world, (w) => w.emptyFlow.errands[0]?.unitId === unitId, 200, 'pridelenie');
    expect(findWorldViolation(world)).toBeUndefined();
    const [errand] = world.emptyFlow.errands;
    world.emptyFlow.assignErrandUnit(errand.truckId, putEmpty(world, depotOf(world), 'golden_wave'));
    expect(findWorldViolation(world)).toMatch(/nemá job na tento kamión|patrí inej linke/);
    world.emptyFlow.assignErrandUnit(errand.truckId, unitId);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});
