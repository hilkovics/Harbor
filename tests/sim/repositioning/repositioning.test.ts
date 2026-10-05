/**
 * Repositioning prázdnych kontajnerov (T6C-03, ADR-034 bod 10 + dodatok T6C-03): ponuka repositioningu linky L na loď voyage — prijatie
 * (pripravenosť = depo prázdnych), pridelenie dostupných prázdnych linky z depa nakládke (`Contract.assignLoad`), nakládka na loď cez žeriav
 * (apron aj pod hákom, empty handler), `shipped` pri odchode lode, odmena za naložený kus a uzavretie bookingu (pomerne / penalizácia).
 * Prázdne nemajú `contractId` — naložené prázdne priraďuje bookingu kniha podľa lode a linky; stowage ich radí po plných jednotkách.
 */
import { describe, expect, it } from 'vitest';
import { acceptCommand, hookDefs, ofType, send, tickEvents } from '../helpers/f6a';
import { emptyWorld, eventsOf, f6cDefs, offerRepositioning, runUntil, stockDepot, lost } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { stateHash, World, type WorldState } from '@sim/world';
import { pendingExportUnits } from '@sim/logistics/voyage-cargo';
import { MAP } from '../world/world-fixtures';
import type { EntityId } from '@sim/core';
import { itR1Interim } from '../helpers/r1-interim';

const VEHICLES = ['straddle_carrier', 'straddle_carrier', 'empty_handler'];
const NO_RANDOM = { emptyReturnRate: 0, emptyPickupRate: 0, damageChance: 0 };

function repoWorld(options: { readonly hook?: boolean; readonly seed?: number } = {}): World {
  const defs = options.hook === true ? hookDefs(1, { emptyFlow: NO_RANDOM }) : f6cDefs({ emptyFlow: NO_RANDOM });
  return emptyWorld({ defs, vehicles: VEHICLES, seed: options.seed });
}

/** Tickuje, kým nie sú všetky kontrakty uzavreté a na mape nie je loď. */
function runToClose(world: World, maxTicks = 60_000) {
  const closed = (w: World): boolean => w.ships.size === 0 && w.contractBook.contracts.size > 0 && [...w.contractBook.contracts.values()].every((c) => c.state === 'completed' || c.state === 'failed');
  return runUntil(world, closed, maxTicks, 'uzavretie bookingov');
}

describe('repositioning prázdnych — nakládka z depa na loď', () => {
  itR1Interim.each([
    ['apron', false],
    ['pod hákom', true],
  ])('%s: 4 prázdne linky z depa sa naložia, odplávajú ako shipped a booking sa vyplatí v plnej výške', (_name, hook) => {
    const world = repoWorld({ hook });
    const ids = stockDepot(world, 'blue_anchor', 6);
    const contract = offerRepositioning(world, { booked: 4 });
    expect(send(world, acceptCommand(contract.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
    const cashBefore = world.cashCents;
    const events = runToClose(world);
    assertCargoConservation(world);
    expect(contract.state).toBe('completed');
    expect(contract.booking.loadedUnits).toBe(4);
    expect(contract.booking.arrivedUnits).toBe(4);
    const loaded = eventsOf(events, 'UnitLoaded');
    expect(loaded).toHaveLength(4);
    // R1 (ADR-037): vozidlá sa nepredbiehajú, takže pomalšie vozidlo pred rýchlejším `empty_handler` mení poradie príchodov k žeriavu —
    // `outOfOrder` (poradie stowage plánu) sa tu preto neoveruje, len že nakládka patrí bookingu a nie je last-minute.
    expect(loaded.every((event) => event.contractId === contract.id && !event.lastMinute)).toBe(true);
    expect(world.cargo.shippedCount).toBe(4);
    expect(world.cargo.liveCount).toBe(2);
    expect(lost(world)).toBe(0);
    // plná odmena bez penalizácie; peniaze zo scenára okrem nej tvoria len údržba a mzdy dňa
    const completed = eventsOf(events, 'ContractCompleted');
    expect(completed).toEqual([expect.objectContaining({ contractId: contract.id, rewardCents: 1_000_000, penaltiesCents: 0, onTime: true })]);
    expect(world.cashCents).toBeGreaterThan(cashBefore);
    // pridelenie berie najmenšie id; zvyšné dve ostali v sklade
    expect(ids.slice(0, 4).every((unit) => world.cargo.get(unit) === undefined)).toBe(true);
    expect(ids.slice(4).every((unit) => world.cargo.get(unit)?.location.kind === 'in_storage')).toBe(true);
    expect(eventsOf(events, 'ExportShipped')).toEqual([expect.objectContaining({ units: 4 })]);
  });

  itR1Interim('job prázdneho dostane prednostne empty handler (prvý job vždy, ďalšie keď je voľný); pod hákom ide job in_storage → in_crane', () => {
    const world = repoWorld({ hook: true });
    stockDepot(world, 'blue_anchor', 4);
    const contract = offerRepositioning(world, { booked: 4 });
    send(world, acceptCommand(contract.id));
    const events = runToClose(world);
    const handler = [...world.vehicles.values()].find((vehicle) => vehicle.def.id === 'empty_handler');
    const assigned = eventsOf(events, 'JobAssigned');
    expect(assigned.length).toBe(4);
    expect(assigned[0].vehicleId).toBe(handler?.id);
    expect(assigned.filter((event) => event.vehicleId === handler?.id).length).toBeGreaterThanOrEqual(1);
    const created = eventsOf(events, 'JobCreated');
    expect(created).toHaveLength(4);
    expect(created.every((event) => event.toModuleId === 1)).toBe(true);
    expect(contract.state).toBe('completed');
  });

  itR1Interim('menej dostupných prázdnych než bookovaných (opravovaný sa nenakladá, iná linka tiež): naloží sa len dostupné, odmena pomerne, penalizácia za nesplnený booking', () => {
    const world = repoWorld({ hook: true });
    stockDepot(world, 'blue_anchor', 2);
    const [repairing] = stockDepot(world, 'blue_anchor', 1, 'in_repair');
    world.cargo.setStatus(repairing, 'in_repair', 10 ** 9);
    stockDepot(world, 'northern_star', 5);
    const contract = offerRepositioning(world, { booked: 4 });
    send(world, acceptCommand(contract.id));
    const events = runToClose(world);
    assertCargoConservation(world);
    expect(contract.state).toBe('completed');
    expect(contract.booking.loadedUnits).toBe(2);
    expect(world.cargo.shippedCount).toBe(2);
    // pomerná výplata ⌊1 000 000 × 2 / 4⌋ = 500 000, nesplnený booking (2 < ⌈0,9 × 4⌉ = 4) ⌊1 000 000 × 0,1⌋ = 100 000
    expect(eventsOf(events, 'BookingPenaltyApplied')).toEqual([expect.objectContaining({ contractId: contract.id, kind: 'unfulfilled', units: 2, amountCents: 100_000 })]);
    expect(eventsOf(events, 'ContractCompleted')).toEqual([expect.objectContaining({ rewardCents: 500_000, penaltiesCents: 100_000 })]);
    // opravovaný a cudzia linka ostali v depe; nikdy sa nenaložili
    const left = [...world.cargo.liveUnits()].map((unit) => [unit.lineId, unit.status, unit.location.kind]);
    expect(left.filter((entry) => entry[0] === 'blue_anchor')).toEqual([['blue_anchor', 'in_repair', 'in_storage']]);
    expect(left.filter((entry) => entry[0] === 'northern_star')).toHaveLength(5);
  });

  it('linka bez dostupných prázdnych: loď odíde bez nakládky, booking zlyhá (failed) s penalizáciou, nič sa neodplávalo', () => {
    const world = repoWorld();
    stockDepot(world, 'northern_star', 3);
    const contract = offerRepositioning(world, { booked: 4 });
    send(world, acceptCommand(contract.id));
    const events = runToClose(world);
    expect(contract.state).toBe('failed');
    expect(contract.booking.loadedUnits).toBe(0);
    expect(world.cargo.shippedCount).toBe(0);
    expect(eventsOf(events, 'UnitLoaded')).toEqual([]);
    expect(eventsOf(events, 'BookingPenaltyApplied').map((event) => event.kind)).toEqual(['unfulfilled']);
    expect(eventsOf(events, 'ContractFailed')).toHaveLength(1);
    assertCargoConservation(world);
  });

  itR1Interim('loď voyage počká na pridelenie: dostupný prázdny, ktorý nie je pridelený (oprava práve skončila), sa započíta do pendingExportUnits, takže loď neodíde bez neho', () => {
    const world = repoWorld({ hook: true });
    stockDepot(world, 'blue_anchor', 3);
    const [repairing] = stockDepot(world, 'blue_anchor', 1, 'in_repair');
    world.cargo.setStatus(repairing, 'in_repair', 10 ** 9);
    const contract = offerRepositioning(world, { booked: 4 });
    send(world, acceptCommand(contract.id));
    runUntil(world, () => contract.state === 'exporting', 30_000, 'booking v exporting');
    const shipId = contract.shipId as EntityId;
    // dispatcher pridelil 3 dostupné (arrived 3, ešte nenaložené); štvrtý je v oprave → neblokuje loď
    expect(contract.booking.arrivedUnits).toBe(3);
    expect(pendingExportUnits(world, shipId)).toBe(3);
    // oprava skončí: nepridelený dostupný prázdny sa počíta (3 pridelené nenaložené + 1 nepridelený)
    world.cargo.setStatus(repairing, 'available', null);
    expect(pendingExportUnits(world, shipId)).toBe(4);
    runToClose(world);
    expect(contract.booking.loadedUnits).toBe(4);
    expect(contract.state).toBe('completed');
    assertCargoConservation(world);
  });
});

describe('repositioning spolu s exportom jednej voyage — stowage: plné pred prázdnymi', () => {
  itR1Interim.each([
    ['apron', false],
    ['pod hákom', true],
  ])('%s: všetky naložené exporty predchádzajú prázdnym', (_name, hook) => {
    const world = repoWorld({ hook });
    stockDepot(world, 'blue_anchor', 6);
    const repo = offerRepositioning(world, { booked: 4, withExport: 6 });
    send(world, acceptCommand(repo.id - 1));
    const events = runToClose(world, 80_000);
    assertCargoConservation(world);
    const exportContract = world.contracts.get((repo.id - 1) as never);
    expect(exportContract?.state).toBe('completed');
    expect(repo.state).toBe('completed');
    const loaded = eventsOf(events, 'UnitLoaded');
    const kinds = loaded.map((event) => (event.contractId === repo.id ? 'empty' : 'full'));
    expect(kinds.filter((kind) => kind === 'full').length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => kind === 'empty')).toHaveLength(4);
    expect(kinds.join(',')).toMatch(/^(full,)*(empty,?)+$/);
    // `outOfOrder` sa neoveruje: od R1 (ADR-037) sa vozidlá nepredbiehajú a poradie príchodov k žeriavu nemusí zodpovedať plánu.
    expect(world.cargo.shippedCount).toBe(loaded.length);
    expect(lost(world)).toBe(0);
  });
});

describe('repositioning — obnova uprostred nakládky', () => {
  it('uloženie a načítanie v ticku, keď sú prázdne pridelené a nakladajú sa, dá rovnaký stateHash ako nepretržitý beh', () => {
    const build = (): { world: World; contractId: number } => {
      const world = repoWorld({ hook: true, seed: 71 });
      stockDepot(world, 'blue_anchor', 5);
      const contract = offerRepositioning(world, { booked: 4 });
      send(world, acceptCommand(contract.id));
      return { world, contractId: contract.id };
    };
    const reference = build();
    const midpoint = (() => {
      const probe = build();
      const events = tickEvents(probe.world, 60_000);
      return ofType(events, 'UnitLoaded')[1].tick;
    })();
    tickEvents(reference.world, midpoint - 10);
    const restored = World.deserialize(reference.world.defs, MAP, JSON.parse(JSON.stringify(reference.world.serialize())) as WorldState);
    expect(stateHash(restored)).toBe(stateHash(reference.world));
    tickEvents(reference.world, 4_000);
    tickEvents(restored, 4_000);
    expect(stateHash(restored)).toBe(stateHash(reference.world));
    expect(restored.contracts.get(reference.contractId as never)?.state).toBe(reference.world.contracts.get(reference.contractId as never)?.state);
  });
});
