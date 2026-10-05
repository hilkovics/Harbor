// Výdaj prázdneho kontajnera exportérovi (T6C-02, ADR-034 bod 8 + dodatok): plán po prijatí export bookingu (`emptyPickupRate`,
// `emptyPickupLeadHoursRange`, len v prístave s depom), kamión misie `collect` (poverenie v `emptyFlow.errands`), pridelenie dostupného
// prázdneho jeho linky (depo pred dvorom, len `available`), nakládka z docku, odchod (`EmptyPickedUp`, `exported`), vzdanie sa po
// `emptyPickupMaxWaitHours` (`EmptyPickupMissed`), zrušený job, obnova uprostred výdaja a invarianty poverení.
import { describe, expect, it } from 'vitest';
import { WorldStateError } from '@sim/world';
import { World, stateHash } from '@sim/world';
import { MAP } from '../world/world-fixtures';
import { acceptedBooking, send } from '../helpers/f6a';
import { TICKS_PER_HOUR, acceptedImport, depotOf, emptiesByLocation, emptyWorld, eventsOf, f6cDefs, putEmpty, rampOf, run, runUntil } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { StorageModule } from '@sim/modules';
import { itR1Interim } from '../helpers/r1-interim';

const TWO_STRADDLES = ['straddle_carrier', 'straddle_carrier'];
const WAIT_HOURS = 6;

/** Svet s depom a prijatým export bookingom linky `blue_anchor`; výdaje sa plánujú ručne (`emptyPickupRate` 0). */
function pickupWorld(options: { readonly vehicles?: readonly string[]; readonly maxWaitHours?: number; readonly pickupRate?: number } = {}): { world: World; contractId: number } {
  const defs = f6cDefs({ emptyFlow: { emptyPickupRate: options.pickupRate ?? 0, emptyPickupMaxWaitHours: options.maxWaitHours ?? WAIT_HOURS } });
  const world = emptyWorld({ defs, vehicles: options.vehicles ?? TWO_STRADDLES });
  const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
  return { world, contractId: exportContract.id };
}

const yardOf = (world: World): StorageModule => {
  const depot = depotOf(world);
  const yard = [...world.modules.values()].find((module): module is StorageModule => module instanceof StorageModule && module.id !== depot.id && module.category === 'container');
  if (yard === undefined) throw new Error('svet nemá dvor');
  return yard;
};

describe('plán výdaja po prijatí export bookingu', () => {
  it('rate 1: pre každú jednotku plánu príchodov jedna položka linky bookingu, dueTick = max(prijatie + 1, príchod − lead)', () => {
    const defs = f6cDefs({ emptyFlow: { emptyPickupRate: 1, emptyPickupLeadHoursRange: [4, 4] } });
    const world = emptyWorld({ defs });
    const tick = world.clock.tick;
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 6 });
    const arrivals = [...exportContract.booking.arrivalPlan];
    const lead = 4 * TICKS_PER_HOUR;
    expect(world.emptyFlow.pickupPlan).toHaveLength(6);
    expect(world.emptyFlow.pickupPlan.map((entry) => entry.dueTick)).toEqual(arrivals.map((arrival) => Math.max(tick + 1, arrival - lead)).sort((a, b) => a - b));
    expect(world.emptyFlow.pickupPlan.every((entry) => entry.lineId === 'blue_anchor' && entry.contractId === exportContract.id)).toBe(true);
  });

  it('rate 0, prístav bez depa a kontrakt iného druhu než export nič neplánujú; bez depa sa Rng nespotrebuje navyše', () => {
    const none = emptyWorld({ defs: f6cDefs({ emptyFlow: { emptyPickupRate: 0 } }) });
    acceptedBooking(none, { kind: 'export', booked: 6 });
    expect(none.emptyFlow.pickupPlan).toEqual([]);
    const noDepotA = emptyWorld({ depot: false, defs: f6cDefs({ emptyFlow: { emptyPickupRate: 1 } }) });
    const noDepotB = emptyWorld({ depot: false, defs: f6cDefs({ emptyFlow: { emptyPickupRate: 0 } }) });
    acceptedBooking(noDepotA, { kind: 'export', booked: 6 });
    acceptedBooking(noDepotB, { kind: 'export', booked: 6 });
    expect(noDepotA.emptyFlow.pickupPlan).toEqual([]);
    expect(noDepotA.rng.getState()).toEqual(noDepotB.rng.getState());
    // roundtrip: výdaj sa plánuje len pre export časť; import kontrakt výdaj nezaloží
    const roundtrip = emptyWorld({ defs: f6cDefs({ emptyFlow: { emptyPickupRate: 1 } }) });
    const { exportContract } = acceptedBooking(roundtrip, { kind: 'roundtrip', booked: 3, importUnits: 2 });
    expect(roundtrip.emptyFlow.pickupPlan.map((entry) => entry.contractId)).toEqual(Array(3).fill(exportContract.id));
  });
});

describe('kamión collect — výdaj z depa', () => {
  itR1Interim('dostupný prázdny linky: kamión vznikne, dostane pridelený prázdny, naloží ho z docku a odíde (EmptyPickedUp, in_truck → exported)', () => {
    const { world, contractId } = pickupWorld();
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    const events = runUntil(world, (w) => w.emptyFlow.errands.length === 0 && w.emptyFlow.pickupPlan.length === 0 && w.trucks.size === 0, 6_000, 'výdaj prázdneho');
    const [spawned] = eventsOf(events, 'TruckSpawned');
    const [picked] = eventsOf(events, 'EmptyPickedUp');
    expect(picked).toMatchObject({ unitId, lineId: 'blue_anchor', contractId });
    expect(picked.truckId).toBe(spawned.truckId);
    expect(eventsOf(events, 'EmptyPickupMissed')).toEqual([]);
    const moved = eventsOf(events, 'CargoMoved').filter((event) => event.unitId === unitId).map((event) => `${event.from.kind}>${event.to.kind}`);
    // prvé tri presuny zapísal pomocník `putEmpty` (uloženie do depa); výdaj je reťaz sklad → vozidlo → rampa → kamión → mimo mapy
    expect(moved.slice(-4)).toEqual(['in_storage>in_vehicle', 'in_vehicle>at_ramp', 'at_ramp>in_truck', 'in_truck>exported']);
    expect(world.cargo.get(unitId)).toBeUndefined();
    expect(world.cargo.exportedCount).toBe(1);
    expect(eventsOf(events, 'TruckExited')).toEqual([{ type: 'TruckExited', truckId: spawned.truckId, units: 1 }]);
    expect(emptiesByLocation(world)).toEqual({});
    assertCargoConservation(world);
    expect(world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount - world.cargo.shippedCount).toBe(0);
  });

  it('prázdny po vjazde zmizol: kamión čaká emptyPickupMaxWaitHours od príchodu do stojiska (nie od vzniku), potom odíde prázdny (EmptyPickupMissed s truckId, TruckExited bez jednotky); bez prázdneho vo vnútrozemí kamión nevošiel (hinterland-admit.test.ts)', () => {
    const { world, contractId } = pickupWorld({ maxWaitHours: 1 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    const first = runUntil(world, (w) => w.emptyFlow.errands.length === 1, 100, 'vznik kamióna collect');
    world.cargo.setStatus(unitId, 'damaged', null); // prázdny po vjazde zmizol (nie je dostupný) — dispatcher ho kamiónu nepridelí
    const events = [...first, ...runUntil(world, (w) => w.emptyFlow.pickupPlan.length === 0 && w.emptyFlow.errands.length === 0 && w.trucks.size === 0, 6_000, 'odchod kamióna naprázdno')];
    const spawnTick = events.find((entry) => entry.event.type === 'TruckSpawned')?.tick ?? -1;
    const waitingTick = events.find((entry) => entry.event.type === 'TruckStateChanged' && entry.event.to === 'waiting')?.tick ?? -1;
    const missed = events.find((entry) => entry.event.type === 'EmptyPickupMissed');
    expect(missed?.event).toMatchObject({ lineId: 'blue_anchor', contractId });
    expect(eventsOf(events, 'EmptyPickupMissed').map((entry) => entry.truckId)).toEqual([eventsOf(events, 'TruckSpawned')[0].truckId]); // vzdanie sa v stojisku: kamión odišiel prázdny (truckId), nie vo vnútrozemí (null)
    // cesta od portálu cez bránu do stojiska trvá desiatky tickov — lehota sa počíta až od príchodu do stojiska (T6C-07b, m4)
    expect(waitingTick - spawnTick).toBeGreaterThan(50);
    expect((missed?.tick ?? 0) - waitingTick).toBeGreaterThanOrEqual(TICKS_PER_HOUR);
    expect((missed?.tick ?? 0) - waitingTick).toBeLessThan(TICKS_PER_HOUR + 20);
    expect(eventsOf(events, 'EmptyPickedUp')).toEqual([]);
    expect(eventsOf(events, 'TruckExited').map((event) => event.units)).toEqual([0]);
    expect(world.cargo.exportedCount).toBe(0);
    expect(world.cargo.createdCount).toBe(1); // jediný prázdny, ktorý zmizol (poškodený) — ostal v depe
    expect(world.cargo.get(unitId)).toBeDefined();
  });

  it('giveUpTick poverenia je null, kým kamión nedorazí do stojiska; od príchodu je to tick príchodu + emptyPickupMaxWaitHours', () => {
    const { world, contractId } = pickupWorld({ maxWaitHours: 2 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    runUntil(world, (w) => w.emptyFlow.errands.length === 1, 100, 'vznik kamióna collect');
    world.cargo.setStatus(unitId, 'damaged', null); // prázdny po vjazde zmizol — kamión čaká v stojisku
    expect(world.emptyFlow.errands[0].giveUpTick).toBeNull();
    const events = runUntil(world, (w) => w.emptyFlow.errands[0]?.giveUpTick !== null, 1_000, 'príchod do stojiska');
    const waitingTick = events.find((entry) => entry.event.type === 'TruckStateChanged' && entry.event.to === 'waiting')?.tick ?? -1;
    expect(waitingTick).toBe(world.clock.tick);
    expect(world.emptyFlow.errands[0].giveUpTick).toBe(waitingTick + 2 * TICKS_PER_HOUR);
  });

  it('prázdny inej linky sa nevydá (kamión sa po čakaní vzdá, cudzí prázdny ostane v depe)', () => {
    const { world, contractId } = pickupWorld({ maxWaitHours: 1 });
    const foreign = putEmpty(world, depotOf(world), 'golden_wave');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    const events = runUntil(world, (w) => w.emptyFlow.pickupPlan.length === 0 && w.emptyFlow.errands.length === 0 && w.trucks.size === 0, 6_000, 'vzdanie sa');
    expect(eventsOf(events, 'EmptyPickupMissed')).toHaveLength(1);
    expect(world.cargo.get(foreign)).toMatchObject({ location: { kind: 'in_storage', moduleId: depotOf(world).id } });
  });

  itR1Interim('poškodený prázdny sa nevydá, kým ho neopravia: po opravě (6 h) ho kamión dostane (EmptyRepaired pred EmptyPickedUp)', () => {
    const { world, contractId } = pickupWorld({ maxWaitHours: 12 });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor', 'damaged');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    const events = runUntil(world, (w) => w.emptyFlow.errands.length === 0 && w.emptyFlow.pickupPlan.length === 0 && w.trucks.size === 0, 8_000, 'výdaj po oprave');
    const types = events.map((entry) => entry.event.type);
    expect(types.indexOf('EmptyRepairStarted')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('EmptyRepaired')).toBeLessThan(types.indexOf('EmptyPickedUp'));
    expect(eventsOf(events, 'EmptyPickedUp')).toMatchObject([{ unitId }]);
    expect(eventsOf(events, 'EmptyPickupMissed')).toEqual([]);
  });

  itR1Interim('záložný prázdny z bežného dvora (fallback) sa vydá, keď depo nemá dostupný; depo má prednosť', () => {
    const { world, contractId } = pickupWorld();
    const yardUnit = putEmpty(world, yardOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    const events = runUntil(world, (w) => w.emptyFlow.errands.length === 0 && w.emptyFlow.pickupPlan.length === 0 && w.trucks.size === 0, 6_000, 'výdaj zo dvora');
    expect(eventsOf(events, 'EmptyPickedUp')).toMatchObject([{ unitId: yardUnit }]);
    const { world: second, contractId: secondContract } = pickupWorld();
    const older = putEmpty(second, yardOf(second), 'blue_anchor');
    const preferred = putEmpty(second, depotOf(second), 'blue_anchor');
    expect(older).toBeLessThan(preferred);
    second.emptyFlow.schedulePickup(second.clock.tick + 10, 'blue_anchor', secondContract);
    const secondEvents = runUntil(second, (w) => w.emptyFlow.errands.length === 0 && w.emptyFlow.pickupPlan.length === 0 && w.trucks.size === 0, 6_000, 'výdaj z depa');
    expect(eventsOf(secondEvents, 'EmptyPickedUp')).toMatchObject([{ unitId: preferred }]);
  });

  itR1Interim('dva výdaje, jeden dostupný prázdny: prvý kamión ho odvezie, druhý sa po čakaní vo vnútrozemí vzdá (metrika miss), nič sa nestratí', () => {
    const { world, contractId } = pickupWorld({ maxWaitHours: 1 });
    putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 10, 'blue_anchor', contractId);
    world.emptyFlow.schedulePickup(world.clock.tick + 20, 'blue_anchor', contractId);
    const events = runUntil(world, (w) => w.emptyFlow.pickupPlan.length === 0 && w.emptyFlow.errands.length === 0 && w.trucks.size === 0, 8_000, 'oba kamióny preč');
    expect(eventsOf(events, 'EmptyPickedUp')).toHaveLength(1);
    // druhý výdaj nemá dostupný prázdny: kamión nevošiel do prístavu a po emptyPickupMaxWaitHours od dueTick sa vzdal vo vnútrozemí (truckId null)
    expect(eventsOf(events, 'EmptyPickupMissed')).toMatchObject([{ lineId: 'blue_anchor', contractId, truckId: null }]);
    expect(eventsOf(events, 'TruckSpawned')).toHaveLength(1);
    expect(eventsOf(events, 'TruckExited').map((event) => event.units)).toEqual([1]);
    assertCargoConservation(world);
  });

  it('položka výdaja bookingu, ktorý neexistuje, sa zahodí bez kamióna', () => {
    const { world } = pickupWorld();
    world.emptyFlow.schedulePickup(world.clock.tick + 2, 'blue_anchor', 9_999);
    const events = run(world, 20);
    expect(world.emptyFlow.pickupPlan).toEqual([]);
    expect(eventsOf(events, 'TruckSpawned')).toEqual([]);
    expect(world.trucks.size).toBe(0);
  });

  it('prázdny pridelený kamiónu nie je „náklad na odvoz“: kamión misie pickup naň nevznikne (dock ho počíta len do kapacity)', () => {
    const { world, contractId } = pickupWorld({ vehicles: [] });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 5, 'blue_anchor', contractId);
    runUntil(world, (w) => w.emptyFlow.errands.length === 1 && w.emptyFlow.errands[0].unitId === unitId, 300, 'pridelenie');
    const ramp = rampOf(world);
    expect([...world.jobs.values()].map((job) => [job.from.kind, job.to.kind])).toEqual([['in_storage', 'at_ramp']]);
    run(world, 300);
    expect([...world.trucks.values()].map((truck) => truck.mission)).toEqual(['collect']);
    expect(ramp.stagedCount + ramp.reservedCount).toBe(1);
  });
});

describe('zrušený job výdaja', () => {
  it('rampa stratí prevádzkovosť, kým job čaká na vozidlo: job sa zruší, poverenie sa vráti do stavu bez prideleného a po oprave cesty sa pridelí znova', () => {
    const { world, contractId } = pickupWorld({ vehicles: [] });
    const unitId = putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 5, 'blue_anchor', contractId);
    runUntil(world, (w) => w.emptyFlow.errands[0]?.unitId === unitId, 300, 'pridelenie');
    const road = { type: 'RemoveRoad', cells: [{ x: 53, y: 31 }] } as const;
    expect(send(world, road).filter((event) => event.type === 'CommandRejected')).toEqual([]);
    const cancelled = run(world, 3);
    expect(eventsOf(cancelled, 'JobCancelled')).toMatchObject([{ reason: 'ramp_inoperative' }]);
    expect(world.emptyFlow.errands[0]?.unitId).toBeNull();
    expect(world.jobs.size).toBe(0);
    expect(world.cargo.get(unitId)?.location.kind).toBe('in_storage');
    send(world, { type: 'PlaceRoad', cells: [{ x: 53, y: 31 }] });
    runUntil(world, (w) => w.emptyFlow.errands[0]?.unitId === unitId, 100, 'nové pridelenie');
    expect(world.jobs.size).toBe(1);
  });
});

describe('obnova — plán výdajov voči knihe kontraktov a linke (T6C-07b, m5)', () => {
  it('pickupPlan musí ukazovať na kontrakt druhu export v knihe a jeho linku: neznámy kontrakt, iná linka a iný druh kontraktu → WorldStateError s pointerom', () => {
    const { world, contractId } = pickupWorld();
    world.emptyFlow.schedulePickup(world.clock.tick + 5_000, 'blue_anchor', contractId);
    const imported = acceptedImport(world, 'blue_anchor', 2);
    const defs = f6cDefs({ emptyFlow: { emptyPickupRate: 0 } });
    type Plan = { dueTick: number; lineId: string; contractId: number };
    const state = JSON.parse(JSON.stringify(world.serialize())) as { emptyFlow: { pickupPlan: Plan[] } };
    const load = (mutate: (plan: Plan[]) => void): World => {
      const copy = JSON.parse(JSON.stringify(state)) as typeof state;
      mutate(copy.emptyFlow.pickupPlan);
      return World.deserialize(defs, MAP, copy as never);
    };
    expect(() => load(() => undefined)).not.toThrow();
    const failing: [string, (plan: Plan[]) => void, string][] = [
      ['kontrakt mimo knihy', (plan) => void (plan[0].contractId = 4_242), '/emptyFlow/pickupPlan/0/contractId'],
      ['linka výdaja ≠ linka kontraktu', (plan) => void (plan[0].lineId = 'golden_wave'), '/emptyFlow/pickupPlan/0/lineId'],
      ['kontrakt iného druhu než export (import)', (plan) => void (plan[0].contractId = imported.contractId), '/emptyFlow/pickupPlan/0/contractId'],
    ];
    for (const [name, mutate, path] of failing) {
      try {
        load(mutate);
        throw new Error(`${name}: mal zlyhať`);
      } catch (error) {
        expect(error, name).toBeInstanceOf(WorldStateError);
        expect((error as WorldStateError).path, name).toBe(path);
      }
    }
  });
});

describe('obnova a invarianty', () => {
  itR1Interim('save uprostred výdaja (prázdny vo vozidle, kamión čaká) + pokračovanie dá rovnaké udalosti a hash ako nepretržitý beh', () => {
    const { world: continuous, contractId } = pickupWorld();
    putEmpty(continuous, depotOf(continuous), 'blue_anchor');
    continuous.emptyFlow.schedulePickup(continuous.clock.tick + 10, 'blue_anchor', contractId);
    runUntil(continuous, (w) => [...w.cargo.liveUnits()].some((unit) => unit.direction === 'empty' && unit.location.kind === 'in_vehicle'), 3_000, 'prázdny vo vozidle');
    const restored = World.deserialize(f6cDefs({ emptyFlow: { emptyPickupRate: 0, emptyPickupMaxWaitHours: WAIT_HOURS } }), MAP, JSON.parse(JSON.stringify(continuous.serialize())) as never);
    expect(restored.emptyFlow.errands).toEqual(continuous.emptyFlow.errands);
    const expected = run(continuous, 4_000);
    const actual = run(restored, 4_000);
    expect(actual.map((entry) => JSON.stringify(entry))).toEqual(expected.map((entry) => JSON.stringify(entry)));
    expect(stateHash(restored)).toBe(stateHash(continuous));
    expect(eventsOf(expected, 'EmptyPickedUp')).toHaveLength(1);
  });

  it('save s poškodeným poverením → WorldStateError (poverenie bez kamióna, neexistujúci kamión, neznáma jednotka, cudzia linka, kontrakt mimo knihy)', () => {
    const { world, contractId } = pickupWorld();
    putEmpty(world, depotOf(world), 'blue_anchor');
    world.emptyFlow.schedulePickup(world.clock.tick + 5, 'blue_anchor', contractId);
    runUntil(world, (w) => w.emptyFlow.errands[0]?.unitId !== null && w.emptyFlow.errands.length === 1, 400, 'poverenie s jednotkou');
    const defs = f6cDefs({ emptyFlow: { emptyPickupRate: 0 } });
    type Errand = { truckId: number; lineId: string; contractId: number; unitId: number | null; giveUpTick: number | null };
    const state = JSON.parse(JSON.stringify(world.serialize())) as { emptyFlow: { errands: Errand[] } };
    const load = (mutate: (errands: Errand[]) => void): World => {
      const copy = JSON.parse(JSON.stringify(state)) as typeof state;
      mutate(copy.emptyFlow.errands);
      return World.deserialize(defs, MAP, copy as never);
    };
    expect(() => load(() => undefined)).not.toThrow();
    const failing: [string, (errands: Errand[]) => void][] = [
      ['poverenie bez kamióna (kamión collect nemá poverenie)', (errands) => void errands.splice(0, 1)],
      ['kamión neexistuje', (errands) => void (errands[0].truckId += 50)],
      ['neznáma jednotka', (errands) => void (errands[0].unitId = 987_654)],
      ['linka poverenia ≠ linka kontraktu', (errands) => void (errands[0].lineId = 'golden_wave')],
      ['kontrakt mimo knihy', (errands) => void (errands[0].contractId = 4_242)],
    ];
    for (const [name, mutate] of failing) expect(() => load(mutate), name).toThrow(WorldStateError);
  });
});
