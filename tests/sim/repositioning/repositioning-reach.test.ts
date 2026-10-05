/**
 * Dosiahnuteľnosť zdrojov nakládky (T6C-07b, review src/sim, M2; ADR-034 dodatok T6C-07b): jednotku na nakládku (export, prekládka, prázdne
 * repositioningu) vyberá dispatcher len zo skladov, z ktorých vedie cesta ku kotvisku lode (`distance(sklad, kotvisko) < ∞`), a keď sa nakládka
 * bookingu zastaví (`loadingStopped`), zruší otvorené joby nakládky bez vozidla a vráti `arrivedUnits` — loď ani kotvisko tak neuviaznu
 * na jobe, ku ktorému sa vozidlo nikdy nedostane.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { findAvailableEmpty, countAvailableEmpties } from '@sim/logistics/empty-stock';
import { BerthModule, StorageModule } from '@sim/modules';
import { acceptCommand, hookDefs, send, startLoading, runUntilDeparted, exportUnitsByLocation, tickUntil } from '../helpers/f6a';
import { depotOf, emptyWorld, eventsOf, f6cDefs, lost, offerRepositioning, putEmpty, runUntil, stockDepot } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import type { World } from '@sim/world';

const VEHICLES = ['straddle_carrier', 'straddle_carrier', 'empty_handler'];
const NO_RANDOM = { emptyReturnRate: 0, emptyPickupRate: 0, damageChance: 0 };
/** Lehota zlyhania po SLA skrátená na 1 deň (SLA bookingu 1 deň): nakládka sa zastaví do ~4 dní po prijatí. */
const SHORT_FAIL = { failAfterDaysLate: 1 };
/** Dlhý limit ticku. */
const LONG = 80_000;

/** Prerušené nohy kotviska (41, 22) a (46, 22): kotvisko je odrezané od priečky, depa, dvorov aj rampy. */
const CUT_BERTH = [
  { x: 41, y: 22 },
  { x: 46, y: 22 },
];

const isTerminal = (state: string): boolean => state === 'completed' || state === 'failed';

/** Svet s repositioningom na 4 prázdne a depom so zásobou 4 prázdnych linky `blue_anchor`. */
function repoWorld(options: { readonly hook?: boolean; readonly vehicles?: readonly string[] } = {}): World {
  const defs = options.hook === true ? hookDefs(1, { emptyFlow: NO_RANDOM, economy: SHORT_FAIL }) : f6cDefs({ emptyFlow: NO_RANDOM, economy: SHORT_FAIL });
  return emptyWorld({ defs, vehicles: options.vehicles ?? VEHICLES });
}

describe('repositioning — sklad bez cesty ku kotvisku', () => {
  it.each([
    ['apron', false],
    ['pod hákom', true],
  ])('%s: depo odrezané od kotviska (cesta prerušená po prijatí): žiadny job, vozidlo neuviazne v no_path, loď odíde a booking zlyhá', (_name, hook) => {
    const world = repoWorld({ hook });
    stockDepot(world, 'blue_anchor', 4);
    const contract = offerRepositioning(world, { booked: 4, slaDays: 1 });
    expect(send(world, acceptCommand(contract.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
    send(world, { type: 'RemoveRoad', cells: CUT_BERTH });
    const events = runUntil(world, (w) => w.ships.size === 0 && isTerminal(contract.state), LONG, 'odchod lode a uzavretie bookingu');
    expect(eventsOf(events, 'JobCreated')).toEqual([]);
    expect(contract.state).toBe('failed');
    expect(contract.booking.loadedUnits).toBe(0);
    expect(contract.booking.arrivedUnits).toBe(0);
    expect(world.cargo.shippedCount).toBe(0);
    expect([...world.vehicles.values()].every((vehicle) => vehicle.state === 'parked')).toBe(true);
    expect(depotOf(world).storedCount).toBe(4);
    expect(world.jobs.size).toBe(0);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
  });

  it('depo bez prístupu, prázdne aj vo dvore: nakladá sa z dvora (depo pred dvorom platí len medzi dosiahnuteľnými)', () => {
    const world = repoWorld({ hook: true });
    const depot = depotOf(world);
    const yard = [...world.modules.values()].find((module): module is StorageModule => module instanceof StorageModule && module.id !== depot.id && module.category === 'container');
    if (yard === undefined) throw new Error('svet nemá dvor');
    const depotUnits = stockDepot(world, 'blue_anchor', 4);
    const yardUnits = Array.from({ length: 4 }, () => putEmpty(world, yard, 'blue_anchor'));
    const contract = offerRepositioning(world, { booked: 4, slaDays: 1 });
    send(world, acceptCommand(contract.id));
    // vonkajšia bunka konektora depa (43, 22): bez nej depo nemá prístup — vozidlo k nemu nedôjde ani nepríde z neho
    send(world, { type: 'RemoveRoad', cells: [{ x: 43, y: 22 }] });
    runUntil(world, (w) => w.ships.size === 0 && isTerminal(contract.state), LONG, 'odchod lode a uzavretie bookingu');
    expect(contract.state).toBe('completed');
    expect(contract.booking.loadedUnits).toBe(4);
    expect(yardUnits.every((unit) => world.cargo.get(unit) === undefined)).toBe(true);
    expect(depotUnits.every((unit) => world.cargo.get(unit)?.location.kind === 'in_storage')).toBe(true);
    expect(world.cargo.shippedCount).toBe(4);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
  });
});

describe('výber prázdneho s cestou k cieľu (findAvailableEmpty / countAvailableEmpties s targets)', () => {
  it('depo bez prístupu: s cieľom kotvisko sa berie dvor, s prázdnym zoznamom cieľov nič, bez cieľov (bez obmedzenia) depo pred dvorom', () => {
    const world = repoWorld();
    const depot = depotOf(world);
    const yard = [...world.modules.values()].find((module): module is StorageModule => module instanceof StorageModule && module.id !== depot.id && module.category === 'container');
    if (yard === undefined) throw new Error('svet nemá dvor');
    const depotUnit = stockDepot(world, 'blue_anchor', 2)[1]; // navrchu stohu (v depe sa vydáva kontajner navrchu, ADR-039)
    const yardUnit = putEmpty(world, yard, 'blue_anchor');
    send(world, { type: 'RemoveRoad', cells: [{ x: 43, y: 22 }] });
    const berth = world.modules.get(1 as EntityId);
    if (berth === undefined) throw new Error('kotvisko #1 vo svete nie je');
    expect(findAvailableEmpty(world, 'blue_anchor')?.id).toBe(depotUnit);
    expect(findAvailableEmpty(world, 'blue_anchor', [berth])?.id).toBe(yardUnit);
    expect(findAvailableEmpty(world, 'blue_anchor', [])).toBeUndefined();
    expect(countAvailableEmpties(world, 'blue_anchor')).toBe(3);
    expect(countAvailableEmpties(world, 'blue_anchor', [berth])).toBe(1);
    expect(countAvailableEmpties(world, 'blue_anchor', [])).toBe(0);
  });

  it('prijatie repositioningu: depo bez prístupu ku kotvisku je no_storage_for_category (loď by na prázdne čakala zbytočne)', () => {
    const world = repoWorld();
    stockDepot(world, 'blue_anchor', 4);
    send(world, { type: 'RemoveRoad', cells: [{ x: 43, y: 22 }] });
    const contract = offerRepositioning(world, { booked: 4 });
    const events = send(world, acceptCommand(contract.id));
    expect(events).toEqual([{ type: 'CommandRejected', commandType: 'AcceptContract', reasons: ['no_storage_for_category'] }]);
    expect(contract.state).toBe('offered');
  });
});

describe('export — sklad bez cesty ku kotvisku', () => {
  it('jednotky exportu vo dvore, ktorý je po prijatí odrezaný: žiadny job nakládky, loď po lehote odíde (neuviazne), jednotky sa nestratia', () => {
    const { world, offer } = startLoading({ defs: hookDefs(1, { economy: SHORT_FAIL }), kind: 'export', booked: 4, slaDays: 1, arrivals: [10, 20, 30, 40] });
    const { exportContract } = offer;
    tickUntil(world, (w) => exportUnitsByLocation(w)['in_storage'] === 4 && w.trucks.size === 0 && [...w.vehicles.values()].every((vehicle) => vehicle.state === 'parked'), 40_000);
    // chrbtica x = 44 (44, 24): dvor, depo vozidiel a rampa sú odrezané od kotviska (cesta musí byť voľná — žiadne vozidlo ani kamión na nej nestojí)
    expect(send(world, { type: 'RemoveRoad', cells: [{ x: 44, y: 24 }] }).map((event) => event.type)).not.toContain('CommandRejected');
    const events = runUntilDeparted(world, LONG);
    expect(eventsOf(events, 'JobCreated').filter((event) => event.toModuleId === 1)).toEqual([]);
    expect(exportContract.booking.loadedUnits).toBe(0);
    expect(world.cargo.shippedCount).toBe(0);
    expect(world.ships.size).toBe(0);
    // po uzavretí bookingu smú nenaložené jednotky na rampu (vrátenie odosielateľovi) — nič sa nestratilo
    expect(world.cargo.liveCount + world.cargo.exportedCount).toBe(4);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
  }, 60_000);
});

describe('nakládka sa zastavila — otvorené joby bez vozidla sa zrušia (loadingStopped)', () => {
  it.each([
    ['apron', false],
    ['pod hákom', true],
  ])('%s: bez vozidiel ostanú joby nakládky open; po lehote zlyhania sa zrušia (JobCancelled loading_stopped), arrivedUnits sa vráti a loď odíde', (_name, hook) => {
    const world = repoWorld({ hook, vehicles: [] });
    stockDepot(world, 'blue_anchor', 4);
    const contract = offerRepositioning(world, { booked: 4, slaDays: 1 });
    send(world, acceptCommand(contract.id));
    const berth = world.modules.get(1 as EntityId);
    if (!(berth instanceof BerthModule)) throw new Error('kotvisko #1 vo svete nie je');
    // kým lehota neuplynie, joby nakládky čakajú na vozidlo (žiadne vozidlo nie je)
    runUntil(world, () => contract.booking.arrivedUnits === 4, LONG, 'pridelenie 4 prázdnych nakládke');
    expect(world.jobs.size).toBe(4);
    const events = runUntil(world, (w) => w.ships.size === 0 && isTerminal(contract.state), LONG, 'odchod lode po lehote zlyhania');
    const cancelled = eventsOf(events, 'JobCancelled');
    expect(cancelled).toHaveLength(4);
    expect(cancelled.every((event) => event.reason === 'loading_stopped')).toBe(true);
    expect(world.jobs.size).toBe(0);
    expect(contract.state).toBe('failed');
    expect(contract.booking.arrivedUnits).toBe(0);
    expect(contract.booking.loadedUnits).toBe(0);
    expect(depotOf(world).storedCount).toBe(4);
    // rezervácie slotov apronu sa uvoľnili (v režime pod hákom sa nerezervuje nič)
    expect(berth.apron.freeUnreservedCount).toBe(berth.params.apronSlots);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
  }, 60_000);
});
