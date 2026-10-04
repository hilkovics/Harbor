/**
 * Dual transaction delivery kamiónov (F6a, T6A-05, ADR-032 bod 13): kamión po vykládke exportu zostane na docku a naloží
 * import, ak je na docku náklad na odvoz pre celú jeho kapacitu, na ktorý nemá nárok iný kamión
 * (`stagedAt − claimedAt ≥ capacityUnits`); inak uvoľní dock a odíde prázdny. Pickup kamión sa pri vzniku nároku
 * nespawnuje (spawner beží po krokoch kamiónov), preto test vloží import na dock tesne pred koncom vykládky.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { DefRegistry } from '@sim/defs';
import { LoadingRamp } from '@sim/modules';
import type { Truck } from '@sim/trucks/truck';
import type { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptedBooking, exportWorld, f6aDefs, lostUnits, ofType, tickUntil } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';

const rampOf = (world: World): LoadingRamp => [...world.modules.values()].find((module): module is LoadingRamp => module instanceof LoadingRamp) as LoadingRamp;

/** Plán príchodov nastavený testom (ticky vzostupne). */
function planArrivals(contract: { booking: { arrivalPlan: readonly number[] } }, ticks: readonly number[]): void {
  (contract.booking.arrivalPlan as number[]).splice(0, contract.booking.arrivalPlan.length, ...ticks);
}

/** Vloží `count` jednotiek importu na dock rampy (legálne prechody ledgera; staging miesto sa rezervuje a potvrdí). */
function stageImports(world: World, ramp: LoadingRamp, dock: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 950 as EntityId });
    world.cargo.move(unit.id, { kind: 'in_crane', craneId: 951 as EntityId });
    world.cargo.move(unit.id, { kind: 'in_vehicle', vehicleId: 952 as EntityId });
    ramp.reserve(dock);
    ramp.assertCommittable(dock, unit.id);
    world.cargo.move(unit.id, { kind: 'at_ramp', rampId: ramp.id, dock });
    ramp.commit(dock, unit.id);
  }
}

/** Svet bez vozidiel a booking s jedným kamiónom; tickuje do ticku tesne pred koncom vykládky jeho jednotky. */
function deliveryAboutToFinish(defs?: DefRegistry, arrivals: readonly number[] = [5]): { readonly world: World; readonly truck: Truck; readonly ramp: LoadingRamp } {
  const world = exportWorld({ defs, vehicles: [] });
  const { exportContract } = acceptedBooking(world, { kind: 'export', booked: arrivals.length });
  planArrivals(exportContract, arrivals);
  let truck: Truck | undefined;
  tickUntil(
    world,
    () => {
      truck = [...world.trucks.values()][0];
      return truck?.state === 'unloading' && truck.waitTicks === 1;
    },
    600,
  );
  return { world, truck: truck as Truck, ramp: rampOf(world) };
}

describe('dual transaction (ADR-032 bod 13)', () => {
  it('na docku je import pre celú kapacitu kamióna: kamión po vykládke zostane, stane sa pickup, naloží import a odíde plný', () => {
    const { world, truck, ramp } = deliveryAboutToFinish();
    const capacity = truck.def.capacityUnits;
    stageImports(world, ramp, truck.dock, capacity);
    expect(ramp.stagedAt(truck.dock)).toBe(capacity);
    expect(ramp.claimedAt(truck.dock)).toBe(0);
    const events = tickUntil(world, () => world.trucks.size === 0, 1500);
    const unloaded = ofType(events, 'TruckUnloaded');
    expect(unloaded).toHaveLength(1);
    expect(unloaded[0].event).toMatchObject({ truckId: truck.id, dock: truck.dock, dualTransaction: true });
    // Po vykládke kamión nepustí dock: `unloading → loading`, misia pickup, nárok na náklad docku.
    const states = ofType(events, 'TruckStateChanged')
      .filter((entry) => entry.event.truckId === truck.id)
      .map((entry) => entry.event.to);
    expect(states[0]).toBe('loading');
    expect(states).toContain('to_gate_out');
    const exited = ofType(events, 'TruckExited');
    expect(exited).toHaveLength(1);
    expect(exited[0].event.units).toBe(capacity);
    // Import odišiel po súši, exportovaná jednotka čaká v sklade na loď; nič sa nestratilo.
    expect(world.cargo.exportedCount).toBe(capacity);
    expect(ramp.claimedAt(truck.dock)).toBe(0);
    expect(lostUnits(world)).toBe(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('nárok kamióna: počas nakládky je `claimedAt` rovný kapacite a zmenšuje sa s každou naloženou jednotkou', () => {
    const { world, truck, ramp } = deliveryAboutToFinish();
    const capacity = truck.def.capacityUnits;
    stageImports(world, ramp, truck.dock, capacity);
    tickUntil(world, () => truck.state === 'loading', 50);
    expect(truck.mission).toBe('pickup');
    expect(ramp.claimedAt(truck.dock)).toBe(capacity);
    tickUntil(world, () => ramp.claimedAt(truck.dock) < capacity, 400);
    expect(ramp.claimedAt(truck.dock)).toBe(capacity - 1);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('na docku je menej importu než kapacita kamióna: bez dual transaction, kamión uvoľní dock a odíde prázdny', () => {
    const { world, truck, ramp } = deliveryAboutToFinish();
    const capacity = truck.def.capacityUnits;
    stageImports(world, ramp, truck.dock, capacity - 1);
    const events = tickUntil(world, () => world.trucks.size === 0 || [...world.trucks.values()].every((other) => other.mission === 'pickup'), 800);
    const unloaded = ofType(events, 'TruckUnloaded');
    expect(unloaded).toHaveLength(1);
    expect(unloaded[0].event.dualTransaction).toBe(false);
    expect(ofType(events, 'TruckExited')[0]?.event.units ?? 0).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('nárok sa spotrebuje: druhý delivery kamión na tom istom docku už import nenájde a odíde prázdny (dual transaction len raz)', () => {
    // Jeden dock: druhý kamión čaká v stojisku, kým prvý (pickup) nenaloží import a neuvoľní dock.
    const defs = f6aDefs({ moduleParams: { loading_ramp_container: { docks: 1, stagingPerDock: 4 } } });
    const { world, truck, ramp } = deliveryAboutToFinish(defs, [5, 6]);
    stageImports(world, ramp, truck.dock, truck.def.capacityUnits);
    const events = tickUntil(world, () => world.trucks.size === 0, 3000);
    expect(ofType(events, 'TruckUnloaded').map((entry) => entry.event.dualTransaction)).toEqual([true, false]);
    expect(ofType(events, 'TruckExited').map((entry) => entry.event.units)).toEqual([truck.def.capacityUnits, 0]);
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});
