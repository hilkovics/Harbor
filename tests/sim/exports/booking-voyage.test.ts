/**
 * Booking v ContractSystem (F6a, T6A-04, ADR-032 bod 1, 7): loď voyage (export-only s 0 jednotkami, roundtrip jedna loď
 * pre import aj export), prechody `accepted → ship_en_route → exporting`, upozornenie a nastanie cut-off bezstavovo podľa
 * ticku a demurrage exportu pri kotvisku. Uzavretie bookingu pri odchode lode dodá T6A-05.
 */
import { describe, expect, it } from 'vitest';
import {
  F6A_CUTOFF_HOURS,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  acceptedBooking,
  contractOf,
  exportWorld,
  f6aDefs,
  lostUnits,
  ofType,
  tickEvents,
  tickUntil,
} from '../helpers/f6a';

/** Svet bez pozemnej časti (žiadne kamióny): kontrakt sa správa len podľa lode a hodín. */
const noLandside = { landside: [] as never[] };

describe('loď voyage s exportom', () => {
  it('export-only: v ticku príchodu spawne loď s 0 jednotkami, kontrakt prejde na ship_en_route a drží shipId', () => {
    const world = exportWorld({ ...noLandside });
    const { exportContract } = acceptedBooking(world, { kind: 'export' });
    const arrival = exportContract.shipArrivalTick as number;
    tickUntil(world, (w) => w.clock.tick === arrival - 1, arrival);
    expect(exportContract.state).toBe('accepted');
    const events = tickEvents(world, 1);
    const spawned = ofType(events, 'ShipSpawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].tick).toBe(arrival);
    expect(spawned[0].event).toMatchObject({ units: 0, cargoTypeId: 'container_teu', classId: 'feeder' });
    expect(exportContract.state).toBe('ship_en_route');
    expect(exportContract.shipId).toBe(spawned[0].event.shipId);
    expect(world.cargo.countAt('on_ship', exportContract.shipId!)).toBe(0);
    expect(world.contractBook.voyageIdOfShip(exportContract.shipId!)).toBe(exportContract.voyageId);
  });

  it('roundtrip: jedna loď s importom; oba kontrakty ju prevezmú v tom istom ticku (import unloading po zakotvení)', () => {
    const world = exportWorld({ ...noLandside });
    const { importContract, exportContract } = acceptedBooking(world, { kind: 'roundtrip', importUnits: 6 });
    const imp = importContract!;
    const arrival = exportContract.shipArrivalTick as number;
    const events = tickUntil(world, (w) => w.clock.tick === arrival, arrival + 5);
    expect(ofType(events, 'ShipSpawned')).toHaveLength(1);
    expect(ofType(events, 'ShipSpawned')[0].event.units).toBe(6);
    expect(imp.shipId).toBe(exportContract.shipId);
    expect(imp.shipId).toBeDefined();
    expect(imp.state).toBe('ship_en_route');
    expect(exportContract.state).toBe('ship_en_route');
    // Naložená je len importná časť; jednotky majú voyage kontraktu.
    const units = world.cargo.unitsOnShip(imp.shipId!);
    expect(units).toHaveLength(6);
    for (const unitId of units) expect(world.cargo.get(unitId)).toMatchObject({ direction: 'import', voyageId: imp.voyageId, contractId: imp.id });
  });

  it('po zakotvení lode export `ship_en_route → exporting` (dockedTick) a import `→ unloading`', () => {
    const world = exportWorld({ ...noLandside });
    const { importContract, exportContract } = acceptedBooking(world, { kind: 'roundtrip', importUnits: 4 });
    tickUntil(world, () => exportContract.state === 'exporting', 3 * TICKS_PER_DAY);
    const ship = world.ships.get(exportContract.shipId!)!;
    expect(['docked', 'lashing', 'undocking', 'outbound']).toContain(ship.state);
    expect(exportContract.dockedTick).toBe(world.clock.tick);
    expect(importContract!.state === 'unloading' || importContract!.state === 'exporting').toBe(true);
    expect(lostUnits(world)).toBe(0);
  });

  it('export-only loď bez nákladu zakotví a odpláva; booking ostane v exporting (uzavretie je T6A-05), nič sa nestratí', () => {
    const world = exportWorld({ ...noLandside });
    const { exportContract } = acceptedBooking(world, { kind: 'export' });
    const events = tickUntil(world, (w) => w.ships.size === 0 && w.clock.tick > (exportContract.shipArrivalTick as number) + 10, 3 * TICKS_PER_DAY);
    expect(ofType(events, 'ShipDeparted')).toHaveLength(1);
    expect(exportContract.state).toBe('exporting');
    expect(lostUnits(world)).toBe(0);
  });
});

describe('cut-off (bezstavovo podľa ticku)', () => {
  it('CutoffWarning v ticku cutoff − round(cutoffWarningHours × ticksPerHour) a CutoffPassed v ticku cutoffTick, každý raz', () => {
    const world = exportWorld({ ...noLandside });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 3 });
    const cutoff = exportContract.booking.cutoffTick as number;
    expect(cutoff).toBe((exportContract.shipArrivalTick as number) - F6A_CUTOFF_HOURS * TICKS_PER_HOUR);
    const events = tickEvents(world, TICKS_PER_DAY);
    const warning = Math.round(world.defs.economy.cutoffWarningHours * TICKS_PER_HOUR);
    expect(ofType(events, 'CutoffWarning')).toEqual([{ tick: cutoff - warning, event: { type: 'CutoffWarning', contractId: exportContract.id, cutoffTick: cutoff } }]);
    expect(ofType(events, 'CutoffPassed')).toEqual([
      { tick: cutoff, event: { type: 'CutoffPassed', contractId: exportContract.id, arrivedUnits: 0, bookedUnits: 3 } },
    ]);
  });

  it('cutoffWarningHours = 0: varovanie aj cut-off v tom istom ticku', () => {
    const world = exportWorld({ ...noLandside, defs: f6aDefs({ economy: { cutoffWarningHours: 0 } }) });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    const cutoff = exportContract.booking.cutoffTick as number;
    const events = tickEvents(world, TICKS_PER_DAY);
    expect(ofType(events, 'CutoffWarning').map((entry) => entry.tick)).toEqual([cutoff]);
    expect(ofType(events, 'CutoffPassed').map((entry) => entry.tick)).toEqual([cutoff]);
  });

  it('import ani ponuka cut-off nemajú; roundtrip hlási cut-off len za export kontrakt', () => {
    const world = exportWorld({ ...noLandside });
    const { importContract, exportContract } = acceptedBooking(world, { kind: 'roundtrip', booked: 2, importUnits: 2 });
    const events = tickEvents(world, TICKS_PER_DAY);
    expect(ofType(events, 'CutoffPassed').map((entry) => entry.event.contractId)).toEqual([exportContract.id]);
    expect(ofType(events, 'CutoffWarning').map((entry) => entry.event.contractId)).toEqual([exportContract.id]);
    expect(importContract!.booking).toBeNull();
  });
});

describe('demurrage a SLA exportu', () => {
  it('export v exporting pripisuje demurrage, kým loď stojí pri kotvisku nad berthAllowanceTicks', () => {
    // Loď nemá čo vykladať ani nakladať (T6A-04), odpláva hneď — demurrage nevznikne; so zadržanou loďou (krátky limit) áno.
    const world = exportWorld({ ...noLandside, defs: f6aDefs({ ship: { id: 'feeder', fields: { berthAllowanceTicks: 1 } } }) });
    const { importContract, exportContract } = acceptedBooking(world, { kind: 'roundtrip', importUnits: 60 });
    tickUntil(world, () => exportContract.state === 'exporting' && importContract!.demurrageHours > 0, 4 * TICKS_PER_DAY);
    expect(exportContract.demurrageHours).toBeGreaterThan(0);
    expect(exportContract.penaltiesCents).toBeGreaterThan(0);
    expect(contractOf(world, exportContract.id).penaltiesCents).toBe(exportContract.penaltiesCents);
  });
});
