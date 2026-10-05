// Vnútrozemie a vjazd kamiónov (T6D-01, ADR-035): kamióny s dovozom (návrat prázdneho, export) a výdajom prázdneho čakajú mimo mapy a vojdú len s rezerváciou —
// stojisko nad kvótou `pickupReservedBays`, dock so zaručeným miestom na vyloženie (`DockIntake`), zaručené miesto v depe / sklade; výdaj (`collect`) vojde,
// až keď je dostupný prázdny linky, inak sa po `emptyPickupMaxWaitHours` vzdá vo vnútrozemí. Čakanie sa počíta (`Hinterland`), poradie je FIFO podľa `dueTick`.
import { describe, expect, it } from 'vitest';
import { WaitingArea } from '@sim/modules';
import { World, hinterlandMetrics, hinterlandQueue, stateHash } from '@sim/world';
import { acceptedBooking } from '../helpers/f6a';
import { TICKS_PER_HOUR, depotOf, emptyWorld, eventsOf, f6cDefs, putEmpty, rampOf, run, runUntil } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { routeWithFreeBay } from '../../../src/sim/trucks/truck-spawner';
import { MAP } from '../world/world-fixtures';
import { itR1Interim } from '../helpers/r1-interim';

const TWO_STRADDLES = ['straddle_carrier', 'straddle_carrier'];

/** Stojisko sveta (jediné). */
function areaOf(world: World): WaitingArea {
  for (const module of world.modules.values()) if (module instanceof WaitingArea) return module;
  throw new Error('svet nemá stojisko');
}

/** Defy s malým stojiskom: `bays` stojísk, z toho `reserved` pre odvoz. */
const smallArea = (bays: number, reserved: number) => f6cDefs({ moduleParams: { truck_waiting_area: { bays, pickupReservedBays: reserved } } });

describe('kvóta stojísk pre odvoz (WaitingArea.pickupReservedBays)', () => {
  it('bundled def: 6 stojísk, 2 rezervované; freeBaysForDelivery = voľné nad rezervou, kamión na odvoz vidí všetky voľné', () => {
    const world = emptyWorld();
    const area = areaOf(world);
    expect([area.bays, area.pickupReservedBays, area.freeBays, area.freeBaysForDelivery]).toEqual([6, 2, 6, 4]);
    const ramp = rampOf(world);
    area.reserveBay(1 as never);
    area.reserveBay(2 as never);
    area.reserveBay(3 as never);
    area.reserveBay(4 as never);
    expect([area.freeBays, area.freeBaysForDelivery]).toEqual([2, 0]);
    expect(routeWithFreeBay(world, ramp, 'delivery')).toBeUndefined();
    expect(routeWithFreeBay(world, ramp, 'pickup')).toBeDefined();
    expect(routeWithFreeBay(world, ramp, 'collect')).toBeDefined();
  });

  it('kvóta 0 (chýba v defe): kamióny s dovozom smú obsadiť všetky stojiská; kvóta ≥ bays sa orezá na bays − 1 (dovoz má vždy aspoň jedno stojisko)', () => {
    const none = emptyWorld({ defs: smallArea(2, 0) });
    expect([areaOf(none).pickupReservedBays, areaOf(none).freeBaysForDelivery]).toEqual([0, 2]);
    const clamped = emptyWorld({ defs: smallArea(3, 9) });
    expect([areaOf(clamped).pickupReservedBays, areaOf(clamped).freeBaysForDelivery]).toEqual([2, 1]);
  });
});

describe('návrat prázdneho — vjazd s rezerváciou', () => {
  it('stojisko 3 / kvóta 2: naraz je v prístave najviac jeden kamión s dovozom, ostatné čakajú vo vnútrozemí a vchádzajú FIFO podľa dueTick', () => {
    const world = emptyWorld({ defs: smallArea(3, 2), vehicles: TWO_STRADDLES });
    const tick = world.clock.tick;
    world.emptyFlow.scheduleReturn(tick + 5, 'golden_wave');
    world.emptyFlow.scheduleReturn(tick + 3, 'blue_anchor');
    world.emptyFlow.scheduleReturn(tick + 4, 'northern_star');
    const events = run(world, 6);
    // jediný kamión naraz: ten s najskorším dueTick (blue_anchor), ostatní čakajú vo vnútrozemí (plán sa nespotrebuje)
    expect(world.trucks.size).toBe(1);
    expect(world.emptyFlow.returnPlan.map((entry) => entry.lineId)).toEqual(['northern_star', 'golden_wave']);
    expect(hinterlandQueue(world)).toMatchObject({ delivery: 2, collect: 0 });
    let maxHeld = 0;
    const more = runUntil(
      world,
      (w) => {
        maxHeld = Math.max(maxHeld, areaOf(w).bays - areaOf(w).freeBays);
        return w.emptyFlow.returnPlan.length === 0 && w.trucks.size === 0;
      },
      12_000,
      'vybavenie troch návratov',
    );
    expect(maxHeld).toBe(1);
    expect(eventsOf([...events, ...more], 'EmptyReturned').map((event) => event.lineId)).toEqual(['blue_anchor', 'northern_star', 'golden_wave']);
    const metrics = hinterlandMetrics(world);
    expect(metrics.delivery).toMatchObject({ admitted: 3, turnedAway: 0 });
    expect(metrics.delivery.waitTicksMax).toBeGreaterThan(50);
    expect(metrics.waiting.total).toBe(0);
    assertCargoConservation(world);
  });

  itR1Interim('čakajúci návrat zostane vo vnútrozemí, kým je miesto v depe zaslúbené kamiónom na ceste; keď je depo plné, položka sa zahodí (EmptyReturnDeclined)', () => {
    const defs = f6cDefs({ moduleParams: { empty_depot: { capacityUnits: 2 } } });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    const tick = world.clock.tick;
    for (let i = 0; i < 3; i++) world.emptyFlow.scheduleReturn(tick + 3, 'blue_anchor');
    const first = run(world, 24);
    // dve miesta v depe = dva kamióny; tretí čaká (miesto nie je trvalo plné, len zaslúbené), nezahodil sa
    expect(world.trucks.size).toBe(2);
    expect(world.emptyFlow.returnPlan).toHaveLength(1);
    expect(eventsOf(first, 'EmptyReturnDeclined')).toEqual([]);
    const rest = runUntil(world, (w) => w.emptyFlow.returnPlan.length === 0 && w.trucks.size === 0 && depotOf(w).storedCount === 2, 12_000, 'koniec troch návratov');
    expect(eventsOf(rest, 'EmptyReturnDeclined')).toEqual([{ type: 'EmptyReturnDeclined', lineId: 'blue_anchor' }]);
    expect(depotOf(world).storedCount).toBe(2);
    expect(world.cargo.createdCount).toBe(2);
    expect(world.hinterland.admitted('delivery')).toBe(2);
    expect(world.hinterland.turnedAway('delivery')).toBe(1);
    assertCargoConservation(world);
  });

  it('bez prevádzkovej rampy položky čakajú vo vnútrozemí (pohľad pre UI ich ráta, najdlhšie čakanie rastie) a nič nezanikne', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES, landside: ['gate', 'waiting_area'] });
    world.emptyFlow.scheduleReturn(world.clock.tick + 2, 'blue_anchor');
    world.emptyFlow.scheduleReturn(world.clock.tick + 2, 'golden_wave');
    run(world, 100);
    expect(world.trucks.size).toBe(0);
    const queue = hinterlandQueue(world);
    expect(queue).toMatchObject({ delivery: 2, collect: 0, total: 2 + queue.pickup });
    expect(queue.oldestWaitTicks).toBe(98);
    expect(world.emptyFlow.returnPlan).toHaveLength(2);
    expect(hinterlandMetrics(world).delivery.admitted).toBe(0);
  });

  it('dock intake: miesto prisľúbené kamiónu s dovozom odpočíta voľné staging miesta rampy, kým si ho kamión nerezervuje', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    world.emptyFlow.scheduleReturn(world.clock.tick + 2, 'blue_anchor');
    const ramp = rampOf(world);
    run(world, 4);
    const [truck] = [...world.trucks.values()];
    expect(truck.mission).toBe('delivery');
    world.dockIntake.refresh(world);
    expect(world.dockIntake.pendingAt(ramp, truck.dock)).toBe(1);
    expect(world.dockIntake.roomAt(ramp, truck.dock)).toBe(ramp.freeAt(truck.dock) - 1);
    expect(world.dockIntake.roomCount(ramp)).toBe(ramp.freeCount - 1);
    expect(world.dockIntake.firstRoomDock(ramp)).toBeGreaterThanOrEqual(0);
  });
});

describe('výdaj prázdneho (collect) — vnútrozemie', () => {
  /** Svet s depom a prijatým export bookingom linky `blue_anchor`; výdaje sa plánujú ručne. */
  function pickupWorld(maxWaitHours: number): { world: World; contractId: number } {
    const defs = f6cDefs({ emptyFlow: { emptyPickupRate: 0, emptyPickupMaxWaitHours: maxWaitHours } });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 2 });
    return { world, contractId: exportContract.id };
  }

  it('bez dostupného prázdneho kamión nevojde: čaká vo vnútrozemí a po emptyPickupMaxWaitHours sa vzdá tam (EmptyPickupMissed s truckId null, žiadny kamión)', () => {
    const { world, contractId } = pickupWorld(2);
    const due = world.clock.tick + 10;
    world.emptyFlow.schedulePickup(due, 'blue_anchor', contractId);
    const waiting = run(world, 100);
    expect(world.trucks.size).toBe(0);
    expect(hinterlandQueue(world).collect).toBe(1);
    expect(eventsOf(waiting, 'EmptyPickupMissed')).toEqual([]);
    const events = runUntil(world, (w) => w.emptyFlow.pickupPlan.length === 0, 1_000, 'vzdanie sa vo vnútrozemí');
    const missed = events.find((entry) => entry.event.type === 'EmptyPickupMissed');
    expect(missed?.event).toEqual({ type: 'EmptyPickupMissed', lineId: 'blue_anchor', contractId, truckId: null });
    // lehota beží od `dueTick` (2 h), nie od príchodu do stojiska
    expect(missed?.tick).toBe(due + 2 * TICKS_PER_HOUR);
    expect(eventsOf(events, 'TruckSpawned')).toEqual([]);
    expect(world.trucks.size).toBe(0);
    expect(world.hinterland.turnedAway('collect')).toBe(1);
    expect(world.hinterland.admitted('collect')).toBe(0);
    expect(world.cargo.createdCount).toBe(0);
  });

  it('prázdny linky v depe: kamión vojde hneď v splatnom ticku (čakanie 0); prázdny cudzej linky ho nevpustí', () => {
    const { world, contractId } = pickupWorld(6);
    putEmpty(world, depotOf(world), 'golden_wave');
    world.emptyFlow.schedulePickup(world.clock.tick + 5, 'blue_anchor', contractId);
    run(world, 20);
    expect(world.trucks.size).toBe(0);
    expect(hinterlandQueue(world).collect).toBe(1);
    putEmpty(world, depotOf(world), 'blue_anchor');
    run(world, 2);
    expect(world.trucks.size).toBe(1);
    expect([...world.trucks.values()][0].mission).toBe('collect');
    expect(world.emptyFlow.pickupPlan).toEqual([]);
    expect(world.hinterland.admitted('collect')).toBe(1);
    expect(world.hinterland.waitTicksMax('collect')).toBeGreaterThanOrEqual(15);
  });

  it('výdaj linky bez prázdneho nezdržuje výdaj inej linky (preskočí sa); položka zaniknutého bookingu sa zahodí bez kamióna', () => {
    const { world, contractId } = pickupWorld(6);
    const { exportContract: other } = acceptedBooking(world, { kind: 'export', booked: 2 });
    putEmpty(world, depotOf(world), 'blue_anchor');
    const tick = world.clock.tick;
    world.emptyFlow.schedulePickup(tick + 3, 'golden_wave', other.id); // linka bez prázdneho — čaká vo vnútrozemí
    world.emptyFlow.schedulePickup(tick + 4, 'blue_anchor', contractId); // skoršiu položku nezdržuje
    world.emptyFlow.schedulePickup(tick + 5, 'blue_anchor', 999_999); // booking neexistuje
    run(world, 12);
    expect(world.trucks.size).toBe(1);
    expect(world.emptyFlow.errands).toMatchObject([{ lineId: 'blue_anchor', contractId }]);
    expect(world.emptyFlow.pickupPlan.map((entry) => entry.lineId)).toEqual(['golden_wave']);
  });
});

describe('uloženie počas čakania vo vnútrozemí', () => {
  it('save uprostred čakania a obnova dajú rovnaký stav aj pokračovanie (počítadlá aj čakajúce položky sú v save)', () => {
    const world = emptyWorld({ defs: smallArea(3, 2), vehicles: TWO_STRADDLES });
    const tick = world.clock.tick;
    for (let i = 0; i < 4; i++) world.emptyFlow.scheduleReturn(tick + 3 + i, i % 2 === 0 ? 'blue_anchor' : 'golden_wave');
    run(world, 40);
    expect(hinterlandQueue(world).delivery).toBeGreaterThan(0);
    expect(world.hinterland.admitted('delivery')).toBeGreaterThan(0);
    const restored = World.deserialize(world.defs, MAP, JSON.parse(JSON.stringify(world.serialize())));
    expect(stateHash(restored)).toBe(stateHash(world));
    for (let i = 0; i < 6_000; i++) {
      world.tick();
      restored.tick();
    }
    expect(stateHash(restored)).toBe(stateHash(world));
    expect(world.hinterland.admitted('delivery')).toBe(4);
    expect(world.emptyFlow.returnPlan).toEqual([]);
    assertCargoConservation(restored);
  });
});
