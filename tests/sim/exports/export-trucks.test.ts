/**
 * Kamióny s exportom (F6a, T6A-04, ADR-032 bod 4, 5, 6, 7, 13): spawn naložených kamiónov podľa plánu príchodov (jednotka
 * vzniká `in_truck`), brána (kontrola, `ExportArrived`, rolled po cut-off, VGM hold), vykládka na dock rampy
 * (`in_truck → at_ramp`, `unloading`, rezervácia staging miesta) a odchod prázdneho kamióna.
 */
import { describe, expect, it } from 'vitest';
import { WEIGHT_CLASSES } from '@sim/cargo/cargo-unit';
import { Rng } from '@sim/core/rng';
import { LoadingRamp } from '@sim/modules';
import { findWorldViolation } from '@sim/world/world-invariants';
import type { Truck } from '@sim/trucks/truck';
import {
  TICKS_PER_HOUR,
  acceptedBooking,
  exportUnitIds,
  exportUnitsByLocation,
  exportWorld,
  f6aDefs,
  lostUnits,
  ofType,
  send,
  tickEvents,
  tickUntil,
} from '../helpers/f6a';
import { hinterlandQueue, type World } from '@sim/world';
import { F4_DEPOT_ID } from '../helpers/f4-layout';

const rampOf = (world: World): LoadingRamp => [...world.modules.values()].find((module): module is LoadingRamp => module instanceof LoadingRamp) as LoadingRamp;

/** Plán príchodov nastavený testom (ticky vzostupne) — bez náhodného rozloženia. */
function planArrivals(contract: { booking: { arrivalPlan: readonly number[] } }, ticks: readonly number[]): void {
  (contract.booking.arrivalPlan as number[]).splice(0, contract.booking.arrivalPlan.length, ...ticks);
}

describe('spawn kamiónov s exportom', () => {
  it('kamión vznikne v ticku plánu na road portáli, naložený jednou jednotkou `in_truck` so štítkami bookingu', () => {
    const world = exportWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 3, destinationPort: 'Gdańsk' });
    planArrivals(exportContract, [10, 40, 90]);
    const events = tickEvents(world, 100);
    const spawned = ofType(events, 'TruckSpawned');
    expect(spawned.map((entry) => entry.tick)).toEqual([10, 40, 90]);
    expect(exportContract.booking.arrivalPlan).toEqual([]);
    const ids = exportUnitIds(world, exportContract.id);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(world.cargo.get(id)).toMatchObject({
        direction: 'export',
        contractId: exportContract.id,
        voyageId: exportContract.voyageId,
        destinationPort: 'Gdańsk',
        hold: null,
        typeId: 'container_teu',
      });
      expect(WEIGHT_CLASSES).toContain(world.cargo.get(id)?.weightClass);
    }
    for (const truck of world.trucks.values()) expect(truck.mission).toBe('delivery');
    expect(lostUnits(world)).toBe(0);
  });

  it('cyklus delivery kamióna: to_gate → gate_queue → to_bay → waiting → to_dock → unloading → to_gate_out → gate_queue_out → to_portal → exited', () => {
    const world = exportWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
    planArrivals(exportContract, [5]);
    const events = tickEvents(world, 400);
    const chain = ofType(events, 'TruckStateChanged').map((entry) => entry.event.to);
    expect(chain).toEqual(['gate_queue', 'to_bay', 'waiting', 'to_dock', 'unloading', 'to_gate_out', 'gate_queue_out', 'to_portal', 'exited']);
    expect(ofType(events, 'TruckExited').map((entry) => entry.event.units)).toEqual([0]);
    expect(world.trucks.size).toBe(0);
  });

  it('položka plánu počká na voľný bay (jediný bay): kamióny vznikajú po jednom, plán sa spotrebuje až po vzniku kamióna', () => {
    const world = exportWorld({ defs: f6aDefs({ moduleParams: { truck_waiting_area: { bays: 1 } } }) });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 3 });
    planArrivals(exportContract, [10, 10, 10]);
    tickEvents(world, 10);
    expect(world.trucks.size).toBe(1);
    expect(exportContract.booking.arrivalPlan).toEqual([10, 10]);
    const events = tickEvents(world, 600);
    // Všetky tri kamióny vznikli (neskôr, než plán) a vyložili sa; plán je prázdny.
    expect(ofType(events, 'TruckSpawned').length).toBe(2);
    expect(exportContract.booking.arrivalPlan).toEqual([]);
    expect(exportContract.booking.arrivedUnits).toBe(3);
  });

  it('bez pozemnej časti žiadne kamióny a plán príchodov ostane (nič nezanikne)', () => {
    const world = exportWorld({ landside: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    planArrivals(exportContract, [3, 4]);
    tickEvents(world, 200);
    expect(world.trucks.size).toBe(0);
    expect(exportContract.booking.arrivalPlan).toEqual([3, 4]);
    expect(world.cargo.createdCount).toBe(0);
  });

  it('hmotnostná trieda z exportFlow.weightClassShares (jedna trieda s váhou 1 → všetky jednotky)', () => {
    for (const weightClass of WEIGHT_CLASSES) {
      const shares = { light: 0, medium: 0, heavy: 0, [weightClass]: 1 };
      const world = exportWorld({ defs: f6aDefs({ exportFlow: { weightClassShares: shares } }) });
      const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
      planArrivals(exportContract, [5, 6, 7, 8]);
      tickEvents(world, 60);
      for (const id of exportUnitIds(world, exportContract.id)) expect(world.cargo.get(id)?.weightClass).toBe(weightClass);
    }
  });

  it('spotreba Rng na jednotku: jeden ťah pri vzniku (hmotnostná trieda) a jeden pri bráne (VGM)', () => {
    const world = exportWorld({ defs: f6aDefs({ exportFlow: { vgmMissingChance: 0 } }) });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 3 });
    planArrivals(exportContract, [5, 20, 35]);
    const twin = Rng.fromState(world.rng.getState());
    tickUntil(world, () => exportContract.booking.arrivedUnits === 3, 400);
    for (let i = 0; i < 6; i++) twin.nextU32();
    expect(world.rng.getState()).toEqual(twin.getState());
  });
});

describe('brána: ExportArrived, rolled a VGM', () => {
  it('ExportArrived po prechode bránou (jednotka, kamión, brána) zvýši arrivedUnits; kamión ide potom do stojiska', () => {
    const world = exportWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
    planArrivals(exportContract, [5]);
    const events = tickUntil(world, () => exportContract.booking.arrivedUnits === 1, 300);
    const arrived = ofType(events, 'ExportArrived');
    expect(arrived).toHaveLength(1);
    const [unitId] = exportUnitIds(world, exportContract.id);
    expect(arrived[0].event).toMatchObject({ contractId: exportContract.id, unitId, truckId: [...world.trucks.keys()][0] });
    const gate = [...world.modules.values()].find((module) => module.kind === 'gate');
    expect(arrived[0].event.gateId).toBe(gate?.id);
    // Brána trvá aspoň processTicks (18): príchod po `TruckSpawned` + jazda + prechod.
    expect(arrived[0].tick).toBeGreaterThan(5 + 18);
    expect(exportContract.booking.rolledUnitIds).toEqual([]);
  });

  it('kamión, ktorý prejde bránou po cut-off, je rolled: ExportArrived a hneď UnitRolled, jednotka v rolledUnitIds', () => {
    const world = exportWorld();
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const cutoff = exportContract.booking.cutoffTick as number;
    planArrivals(exportContract, [5, cutoff - 3]);
    const events = tickUntil(world, () => exportContract.booking.arrivedUnits === 2, cutoff + 300);
    const arrived = ofType(events, 'ExportArrived');
    const rolled = ofType(events, 'UnitRolled');
    expect(arrived).toHaveLength(2);
    expect(rolled).toHaveLength(1);
    expect(arrived[0].tick).toBeLessThan(cutoff);
    expect(arrived[1].tick).toBeGreaterThan(cutoff);
    expect(rolled[0].tick).toBe(arrived[1].tick);
    expect(rolled[0].event).toMatchObject({ contractId: exportContract.id, unitId: arrived[1].event.unitId });
    expect(exportContract.booking.rolledUnitIds).toEqual([arrived[1].event.unitId]);
    // Poradie v ticku: ExportArrived pred UnitRolled.
    const sameTick = events.filter((entry) => entry.tick === arrived[1].tick).map((entry) => entry.event.type);
    expect(sameTick.indexOf('ExportArrived')).toBeLessThan(sameTick.indexOf('UnitRolled'));
  });

  it('hranica cut-off: prechod v ticku cutoffTick ešte nie je rolled, o tick neskôr áno', () => {
    const probe = exportWorld();
    const first = acceptedBooking(probe, { kind: 'export', booked: 1 });
    planArrivals(first.exportContract, [200]);
    const gateTick = ofType(tickUntil(probe, () => first.exportContract.booking.arrivedUnits === 1, 600), 'ExportArrived')[0].tick;
    for (const [cutoff, rolledExpected] of [[gateTick, false], [gateTick - 1, true]] as const) {
      const world = exportWorld();
      const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
      planArrivals(exportContract, [200]);
      exportContract.cutoffTick = cutoff;
      tickUntil(world, () => exportContract.booking.arrivedUnits === 1, 600);
      expect(exportContract.booking.rolledUnits, `cut-off ${String(cutoff)}`).toBe(rolledExpected ? 1 : 0);
    }
  });

  it('VGM chýba (šanca 1): hold do tick + round(vgmHoldHours × ticksPerHour), VgmHoldStarted, index a počítadlo; uvoľnenie v untilTick', () => {
    const world = exportWorld({ defs: f6aDefs({ exportFlow: { vgmMissingChance: 1, vgmHoldHours: 2 } }) });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
    planArrivals(exportContract, [5]);
    const events = tickUntil(world, () => exportContract.booking.heldUnits === 1, 300);
    const started = ofType(events, 'VgmHoldStarted');
    expect(started).toHaveLength(1);
    const untilTick = started[0].tick + 2 * TICKS_PER_HOUR;
    expect(started[0].event).toMatchObject({ contractId: exportContract.id, untilTick });
    const [unitId] = exportUnitIds(world, exportContract.id);
    expect(world.cargo.get(unitId)?.hold).toEqual({ reason: 'vgm', untilTick });
    expect(world.holdIndex.all).toEqual([{ untilTick, unitId }]);
    // Hold nebráni uskladneniu: jednotka ide do skladu aj so zadržaním.
    tickUntil(world, () => exportUnitsByLocation(world)['in_storage'] === 1, 400);
    expect(world.cargo.get(unitId)?.hold).not.toBeNull();
    const rest = tickUntil(world, () => exportContract.booking.heldUnits === 0, 3 * TICKS_PER_HOUR);
    const released = ofType(rest, 'VgmHoldReleased');
    expect(released).toEqual([{ tick: untilTick, event: { type: 'VgmHoldReleased', contractId: exportContract.id, unitId } }]);
    expect(world.cargo.get(unitId)?.hold).toBeNull();
    expect(world.holdIndex.size).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('šanca 0: nikdy hold; šanca z defu s fixným prúdom je deterministická', () => {
    const world = exportWorld({ defs: f6aDefs({ exportFlow: { vgmMissingChance: 0 } }) });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 6 });
    planArrivals(exportContract, [5, 25, 45, 65, 85, 105]);
    const events = tickUntil(world, () => exportContract.booking.arrivedUnits === 6, 600);
    expect(ofType(events, 'VgmHoldStarted')).toHaveLength(0);
    expect(world.holdIndex.size).toBe(0);
  });

  it('viac zadržaných jednotiek sa uvoľní vzostupne podľa (untilTick, id)', () => {
    const world = exportWorld({ defs: f6aDefs({ exportFlow: { vgmMissingChance: 1, vgmHoldHours: 1 } }) });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 3 });
    planArrivals(exportContract, [5, 30, 60]);
    const events = tickUntil(world, () => exportContract.booking.heldUnits === 3, 500);
    const started = ofType(events, 'VgmHoldStarted').map((entry) => entry.event.unitId);
    const released = ofType(tickUntil(world, () => exportContract.booking.heldUnits === 0, 2 * TICKS_PER_HOUR), 'VgmHoldReleased').map((entry) => entry.event.unitId);
    expect(released).toEqual(started);
  });
});

describe('vykládka na dock rampy', () => {
  it('po príchode k docku `unloading`: dock drží kamión a rezervuje staging miesto; po vykládke je jednotka at_ramp ako export na prijatie', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
    planArrivals(exportContract, [5]);
    const ramp = rampOf(world);
    let truck: Truck | undefined;
    tickUntil(world, () => {
      truck = [...world.trucks.values()][0];
      return truck?.state === 'unloading';
    }, 400);
    const unloading = truck as Truck;
    expect(ramp.dockTruck(unloading.dock)).toBe(unloading.id);
    expect(ramp.reservedAt(unloading.dock)).toBe(1);
    expect(world.cargo.countAt('in_truck', unloading.id)).toBe(1);
    expect(findWorldViolation(world)).toBeUndefined();
    const events = tickUntil(world, () => world.trucks.size === 0, 400);
    const [unitId] = exportUnitIds(world, exportContract.id);
    expect(ofType(events, 'TruckUnloaded')).toHaveLength(1);
    expect(ofType(events, 'TruckUnloaded')[0].event).toMatchObject({ truckId: unloading.id, rampId: ramp.id, dock: unloading.dock, unitId, dualTransaction: false });
    expect(world.cargo.get(unitId)?.location).toEqual({ kind: 'at_ramp', rampId: ramp.id, dock: unloading.dock });
    // Bez vozidiel jednotka čaká na docku: rezervácia je premenená na obsadenie, dock je voľný; export sa nepočíta ako náklad na odvoz.
    expect(ramp.reservedAt(unloading.dock)).toBe(0);
    expect(ramp.dockTruck(unloading.dock)).toBeNull();
    expect(ramp.intakeAt(unloading.dock)).toBe(1);
    expect(ramp.stagedAt(unloading.dock)).toBe(0);
    expect(ramp.firstUnitAt(unloading.dock)).toBeUndefined();
    expect(ramp.freeAt(unloading.dock)).toBe(ramp.stagingPerDock - 1);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('vykládka trvá loadTicksPerUnit rampy (stav unloading) a každý prechod `in_truck → at_ramp` emituje CargoMoved', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 1 });
    planArrivals(exportContract, [5]);
    const events = tickEvents(world, 500);
    const changes = ofType(events, 'TruckStateChanged').filter((entry) => entry.event.to === 'unloading' || entry.event.to === 'to_gate_out');
    expect(changes[1].tick - changes[0].tick).toBe(rampOf(world).params.loadTicksPerUnit);
    const [unitId] = exportUnitIds(world, exportContract.id);
    const moves = ofType(events, 'CargoMoved').filter((entry) => entry.event.unitId === unitId).map((entry) => `${entry.event.from.kind}→${entry.event.to.kind}`);
    expect(moves).toEqual(['in_truck→at_ramp']);
  });

  it('plný dock: druhý kamión čaká vo vnútrozemí (bez zaručeného miesta na docku nevojde, nič nepreteká) a vojde, až keď sa miesto uvoľní (ADR-035)', () => {
    const defs = f6aDefs({ moduleParams: { loading_ramp_container: { docks: 1, stagingPerDock: 1 } } });
    const world = exportWorld({ defs, vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    planArrivals(exportContract, [5, 6]);
    tickEvents(world, 700);
    const ramp = rampOf(world);
    // Prvá jednotka obsadila jediné staging miesto (bez vozidiel neodíde), druhý kamión nevošiel: čaká vo vnútrozemí, položka plánu sa nespotrebovala.
    expect(ramp.intakeAt(0)).toBe(1);
    expect(world.trucks.size).toBe(0);
    expect(exportContract.nextArrivalTick).toBe(6);
    expect(hinterlandQueue(world)).toMatchObject({ delivery: 1, collect: 0 });
    expect(ramp.reservedAt(0)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    // Vozidlo odvezie prvú jednotku do skladu (dispatcher: job at_ramp → in_storage): miesto na docku sa uvoľní, druhý kamión vojde a vyloží.
    send(world, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: F4_DEPOT_ID });
    tickUntil(world, () => exportContract.booking.arrivedUnits === 2 && world.trucks.size === 0, 2500);
    expect(world.hinterland.admitted('delivery')).toBe(2);
    expect(world.hinterland.waitTicksMax('delivery')).toBeGreaterThan(0);
    tickEvents(world, 300);
    expect(exportUnitsByLocation(world)).toEqual({ in_storage: 2 });
    expect(lostUnits(world)).toBe(0);
  });

  it('kamión s exportom neblokuje nakládku importu: pripravené jednotky docku počítajú len náklad na odvoz', () => {
    const world = exportWorld({ vehicles: [] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    planArrivals(exportContract, [5, 6]);
    tickEvents(world, 500);
    const ramp = rampOf(world);
    let staged = 0;
    for (let dock = 0; dock < ramp.docks; dock++) staged += ramp.stagedAt(dock);
    expect(staged).toBe(0);
    expect(ramp.stagedCount).toBe(2);
    // Pickup kamión sa kvôli exportu na docku nespawnuje (nič na odvoz).
    expect([...world.trucks.values()].filter((truck) => truck.mission === 'pickup')).toEqual([]);
  });
});
