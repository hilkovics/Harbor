// Invariant kroku 12 pre tok prázdnych (T6C-02, ADR-034 dodatok): depo drží len prázdne, kamión misie `collect` má poverenie (kým neodíde
// naprázdno), poverenie ukazuje na platnú jednotku; prázdny na docku nie je „náklad na odvoz“ (`isPickupCargo`, `DockSupply`).
import { describe, expect, it } from 'vitest';
import { IMPORT_LABELS } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { isPickupCargo } from '@sim/logistics/dock-cargo';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptedBooking } from '../helpers/f6a';
import { DockSupply } from '@sim/trucks';
import { depotOf, emptyLabelsOf, emptyWorld, f6cDefs, putEmpty, rampOf, runUntil } from '../helpers/f6c';

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

  it('kamión collect bez poverenia (mimo odchodu naprázdno) → porušenie; po vzdaní sa a odchode naprázdno je v poriadku', () => {
    const defs = f6cDefs({ emptyFlow: { emptyPickupMaxWaitHours: 1 } });
    const world = emptyWorld({ defs });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    world.emptyFlow.schedulePickup(world.clock.tick + 3, 'blue_anchor', exportContract.id);
    runUntil(world, (w) => w.emptyFlow.errands.length === 1, 100, 'vznik kamióna collect');
    const [errand] = world.emptyFlow.errands;
    world.emptyFlow.removeErrand(errand.truckId);
    expect(findWorldViolation(world)).toMatch(/\(collect\) v stave 'to_gate' nemá poverenie/);
    world.emptyFlow.addErrand(errand.truckId, errand.lineId, errand.contractId, errand.giveUpTick);
    expect(findWorldViolation(world)).toBeUndefined();
    // po vzdaní sa poverenie zanikne a kamión odchádza naprázdno — invarianty (krok 12 každý tick) držia až po opustenie mapy
    runUntil(world, (w) => w.trucks.size === 0 && w.emptyFlow.errands.length === 0, 6_000, 'odchod naprázdno');
  });

  it('poverenie s jednotkou inej linky alebo mimo cesty na dock kamióna → porušenie', () => {
    const world = emptyWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 3, 'blue_anchor', exportContract.id);
    runUntil(world, (w) => w.emptyFlow.errands[0]?.unitId === unitId, 200, 'pridelenie');
    expect(findWorldViolation(world)).toBeUndefined();
    const [errand] = world.emptyFlow.errands;
    world.emptyFlow.assignErrandUnit(errand.truckId, putEmpty(world, depotOf(world), 'golden_wave'));
    expect(findWorldViolation(world)).toMatch(/nemá job na jeho dock|patrí inej linke/);
    world.emptyFlow.assignErrandUnit(errand.truckId, null);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});

describe('prázdny na docku nie je náklad na odvoz', () => {
  it('isPickupCargo: prázdny (aj bez kontraktu) nikdy; import bez kontraktu áno; prázdny ráta do kapacity docku, ale nie do stagedAt', () => {
    const world = emptyWorld();
    const ramp = rampOf(world);
    const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 800 as EntityId }, null, emptyLabelsOf('blue_anchor'));
    world.cargo.move(unit.id, { kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    const staged = world.cargo.get(unit.id);
    if (staged === undefined) throw new Error('jednotka chýba');
    expect(isPickupCargo(world.contractBook, staged)).toBe(false);
    expect(world.isPickupCargo(staged)).toBe(false);
    expect([ramp.stagedAt(0), ramp.intakeAt(0), ramp.freeAt(0)]).toEqual([0, 1, ramp.stagingPerDock - 1]);
    const imported = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }, null, IMPORT_LABELS);
    world.cargo.move(imported.id, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(imported.id, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(imported.id, { kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    expect(world.isPickupCargo(world.cargo.get(imported.id) as never)).toBe(true);
    expect([ramp.stagedAt(0), ramp.intakeAt(0)]).toEqual([1, 1]);
  });
});

describe('DockSupply — prázdny z depa na ceste na dock', () => {
  it('job prázdneho s vozidlom (in_storage → at_ramp pre kamión collect) sa nepočíta ako náklad na odvoz: nevznikne kamión pickup a nárok kamióna collect nie je', () => {
    const world = emptyWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 3, 'blue_anchor', exportContract.id);
    runUntil(world, (w) => [...w.jobs.values()].some((job) => job.vehicleId !== null && job.to.kind === 'at_ramp'), 300, 'job s vozidlom');
    const supply = new DockSupply();
    supply.refresh(world);
    const ramp = rampOf(world);
    const job = [...world.jobs.values()].find((candidate) => candidate.to.kind === 'at_ramp');
    expect(job?.unitIds).toEqual([unitId]);
    expect(job?.to.kind === 'at_ramp' ? supply.dispatchedAt(ramp, job.to.dock) : -1).toBe(0);
    expect([...world.trucks.values()].every((truck) => truck.mission === 'collect')).toBe(true);
    expect(ramp.claimedUnits).toBe(0);
  });
});
