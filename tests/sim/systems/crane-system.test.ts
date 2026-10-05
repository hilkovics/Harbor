// CraneSystem — krok 4 (T02-05, ARCHITECTURE §6, §7.2, §7.8, ADR-016): fázy cyklu z cycleTicks (StatResolver),
// presné načasovanie cyklu s rezerváciou slotu, blokovanie pri plnom aprone s throttlom CraneBlocked ≤ 1× za hernú
// hodinu na žeriav, počítadlá, kategória nákladu, dva žeriavy nad jednou jednotkou a save/load roundtrip uprostred
// vykládky. Tabuľku prechodov FSM žeriavu testuje tests/sim/modules/crane-module.test.ts.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { ModuleError } from '@sim/modules';
import { MIN_CRANE_PHASE_TICKS, cranePhaseTicks } from '@sim/systems';
import { StatResolver } from '@sim/tech';
import { World, type WorldState } from '@sim/world';
import { MAP } from '../world/world-fixtures';
import { driveCrane } from '../helpers/crane-state';
import {
  BULKER,
  BULK_CRANE,
  CRANE,
  GRAIN,
  ROOT_BERTH_ID,
  ROOT_CRANE_ID,
  SHIP_DEFS,
  berth,
  crane,
  newLegacyCapacityWorld,
  newWorld,
  ofType,
  placeModule,
  spawn,
  tickN,
  tickUntil,
} from '../ships/ship-fixtures';

describe('cranePhaseTicks — ⌊c/2⌋ a c − ⌊c/2⌋ z StatResolver, zaokrúhlenie a minimum', () => {
  const craneModule = crane(newWorld(), ROOT_CRANE_ID);
  const withMul = (value: number): StatResolver =>
    new StatResolver(SHIP_DEFS, [{ target: 'module', id: CRANE, stat: 'cycleTicks', op: 'mul', value }]);

  it.each<[string, StatResolver, number, number]>([
    ['def cycleTicks 12', new StatResolver(SHIP_DEFS), 6, 6],
    ['×0,85 → 10,2 → 10', withMul(0.85), 5, 5],
    ['×0,75 → 9', withMul(0.75), 4, 5],
    ['×0,05 → 0,6 → 1 → minimum 1 + 1', withMul(0.05), MIN_CRANE_PHASE_TICKS, MIN_CRANE_PHASE_TICKS],
  ])('%s → grabbing %d, placing %d', (_name, stats, grabbing, placing) => {
    expect(cranePhaseTicks(stats, craneModule)).toEqual({ grabbing, placing });
  });
});

describe('cyklus žeriavu — presné načasovanie (c = 12: grabbing 6, placing 6)', () => {
  it('štart v ticku dokovania s rezerváciou slotu, swing po 6, položenie po 12 a v tom istom ticku ďalší štart', () => {
    const world = newWorld();
    const ship = spawn(world, 'feeder', 3);
    const [u1, u2] = world.cargo.unitsOnShip(ship.id);
    const c = crane(world, ROOT_CRANE_ID);
    const apron = berth(world, ROOT_BERTH_ID).apron;

    tickUntil(world, () => ship.state === 'docked', 300);
    const docked = world.clock.tick;
    expect(c).toMatchObject({ state: 'grabbing', reservedSlot: 0, phaseTicksTotal: 6, phaseTicksLeft: 6, heldUnitId: null });
    expect(apron.reservedSlots()).toEqual([0]);

    tickN(world, 5);
    expect(c).toMatchObject({ state: 'grabbing', phaseTicksLeft: 1 });
    expect(c.phaseProgress).toBeCloseTo(5 / 6, 12);

    const swingEvents = world.tick();
    expect(world.clock.tick).toBe(docked + 6);
    expect(ofType(swingEvents, 'CargoMoved')).toEqual([
      { type: 'CargoMoved', unitId: u1, from: { kind: 'on_ship', shipId: ship.id }, to: { kind: 'in_crane', craneId: c.id }, tick: docked + 6 },
    ]);
    expect(c).toMatchObject({ state: 'placing', heldUnitId: u1, reservedSlot: 0, phaseTicksTotal: 6, phaseTicksLeft: 6 });

    const placeEvents = tickN(world, 6);
    expect(world.clock.tick).toBe(docked + 12);
    expect(ofType(placeEvents, 'CargoMoved')).toEqual([
      { type: 'CargoMoved', unitId: u1, from: { kind: 'in_crane', craneId: c.id }, to: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 0 }, tick: docked + 12 },
    ]);
    expect(ofType(placeEvents, 'CraneCycleDone')).toEqual([{ type: 'CraneCycleDone', craneId: c.id, unitId: u1 }]);
    // Hneď ďalší cyklus (cyklus = presne 12 tickov): nový slot, jednotka u2 ostáva na lodi až do swingu.
    expect(c).toMatchObject({ state: 'grabbing', reservedSlot: 1, heldUnitId: null, phaseTicksLeft: 6 });
    expect(world.cargo.unitsOnShip(ship.id)).toEqual([u2, world.cargo.unitsOnShip(ship.id)[1]]);
    expect(apron.units()).toEqual([u1]);
    expect(c.busyTicks).toBe(13); // ticky docked … docked + 12 (vrátane tiku štartu)
    expect(c.idleTicks).toBe(docked - 1); // ticky 1 … docked − 1 pred dokovaním
    expect(c.busyTicks + c.idleTicks + c.blockedTicks).toBe(world.clock.tick);
  });

  it('žeriav nezačne, kým loď len pláva ku kotvisku (berthing) — kotvisko je rezervované, ale loď nie je docked', () => {
    const world = newWorld();
    const ship = spawn(world, 'feeder', 1);
    tickUntil(world, () => ship.state === 'berthing', 300);
    world.tick();
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBe(ship.id);
    expect(crane(world, ROOT_CRANE_ID).state).toBe('idle');
  });
});

describe('blokovanie pri plnom aprone a throttle CraneBlocked', () => {
  // Blok stojí na plnom aprone 4/4 → pripnutý pôvodný balans (`newLegacyCapacityWorld`; Fáza 5b zväčšila apron na 8).
  /** Root apron plný (4 jednotky z prvého feedera) a druhý feeder s 3 jednotkami dokovaný. */
  function blockedHarbor(checkInvariants = true): { world: World; second: ReturnType<typeof spawn> } {
    const world = newLegacyCapacityWorld({ checkInvariants });
    const first = spawn(world, 'feeder', 4);
    tickUntil(world, () => !world.ships.has(first.id), 1000);
    const second = spawn(world, 'feeder', 3);
    tickUntil(world, () => second.state === 'docked', 1000);
    return { world, second };
  }

  it('dokovaná loď s nákladom + apron bez voľného slotu → blocked hneď v ticku dokovania, CraneBlocked { apron_full } raz', () => {
    const world = newLegacyCapacityWorld();
    const first = spawn(world, 'feeder', 4);
    tickUntil(world, () => !world.ships.has(first.id), 1000);
    const second = spawn(world, 'feeder', 2);
    const events = tickUntil(world, () => second.state === 'docked', 1000);
    const c = crane(world, ROOT_CRANE_ID);
    expect(c).toMatchObject({ state: 'blocked', heldUnitId: null, reservedSlot: null, phaseTicksTotal: 0 });
    expect(ofType(events, 'CraneBlocked')).toEqual([{ type: 'CraneBlocked', craneId: c.id, berthId: ROOT_BERTH_ID, reason: 'apron_full' }]);
    expect(c.lastBlockedHour).toBe(world.clock.gameHour);

    const blockedBefore = c.blockedTicks;
    const later = tickN(world, 3 * world.clock.ticksPerHour);
    expect(ofType(later, 'CraneBlocked')).toEqual([]); // ostáva blocked — nový prechod nenastal
    expect(c.blockedTicks - blockedBefore).toBe(3 * world.clock.ticksPerHour);
    expect(world.cargo.unitsOnShip(second.id)).toHaveLength(2);
  });

  it('opätovné zablokovanie v tej istej hodine neemituje, v ďalšej hodine áno (≤ 1× za hodinu na žeriav)', () => {
    // Vyzdvihnutie z apronu vozidlom (F3) sa emuluje presunom do in_vehicle — vozidlá vo F2 neexistujú, preto bez kroku 12.
    const { world } = blockedHarbor(false);
    const c = crane(world, ROOT_CRANE_ID);
    const apron = berth(world, ROOT_BERTH_ID).apron;
    const pickUp = (): void => {
      const unit = apron.oldest();
      if (unit === undefined) throw new Error('apron je prázdny');
      world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 9000 as EntityId }); // slot sa uvoľní v ledgeri (ADR-017)
    };
    const hourOfBlock = c.lastBlockedHour;

    pickUp(); // voľný slot → grabbing … placing → apron znova plný → blocked v tej istej hodine
    const sameHour = tickUntil(world, () => c.state === 'blocked', 100);
    expect(world.clock.gameHour).toBe(hourOfBlock);
    expect(ofType(sameHour, 'CraneCycleDone')).toHaveLength(1);
    expect(ofType(sameHour, 'CraneBlocked')).toEqual([]);

    tickUntil(world, () => world.clock.gameHour > (hourOfBlock ?? 0), 400);
    pickUp();
    const nextHour = tickUntil(world, () => c.state === 'blocked', 100);
    expect(ofType(nextHour, 'CraneBlocked')).toHaveLength(1);
    expect(c.lastBlockedHour).toBe(world.clock.gameHour);
  });

  it('keď loď odíde alebo nemá čo vyložiť, blocked → idle', () => {
    const { world, second } = blockedHarbor(false);
    const c = crane(world, ROOT_CRANE_ID);
    // Loď „vyloží" iný žeriav mimo mapy — emulácia: jednotky na in_crane cudzieho id (bez kroku 12).
    for (const unit of world.cargo.unitsOnShip(second.id)) world.cargo.move(unit, { kind: 'in_crane', craneId: 8000 as EntityId });
    world.tick();
    expect(c.state).toBe('idle');
  });
});

describe('kategória a viac žeriavov na jednej lodi', () => {
  it('sypká loď pri Root berthe so sypkým žeriavom: kontajnerový žeriav ostáva idle, sypký vykladá', () => {
    const world = newWorld();
    const bulkCrane = placeModule(world, BULK_CRANE, { x: 45, y: 14 });
    const ship = spawn(world, BULKER, 2, GRAIN);
    tickUntil(world, () => !world.ships.has(ship.id), 1000);
    const events = ofType(tickN(world, 1), 'CraneCycleDone');
    expect(events).toEqual([]);
    expect(crane(world, ROOT_CRANE_ID).busyTicks).toBe(0);
    expect(crane(world, bulkCrane).busyTicks).toBe(24);
    expect(world.cargo.unitsOnApron(ROOT_BERTH_ID)).toHaveLength(2);
  });

  it('jedna jednotka a dva žeriavy: zdvíha len prvý (podľa id), druhý ostáva idle — nie blocked', () => {
    const world = newWorld();
    const second = placeModule(world, CRANE, { x: 45, y: 14 });
    const ship = spawn(world, 'feeder', 1);
    tickUntil(world, () => ship.state === 'docked', 300);
    expect(crane(world, ROOT_CRANE_ID).state).toBe('grabbing');
    expect(crane(world, second).state).toBe('idle');
    expect(berth(world, ROOT_BERTH_ID).apron.reservedSlots()).toEqual([0]);
  });
});

describe('koniec placing — ledger a apron sa nerozídu (T02-14)', () => {
  it('slot bez rezervácie: ModuleError(slot_not_reserved) pred presunom — jednotka ostane in_crane, žiadny CargoMoved na apron', () => {
    const world = newWorld({ checkInvariants: false });
    const ship = spawn(world, 'feeder', 2);
    const c = crane(world, ROOT_CRANE_ID);
    const apron = berth(world, ROOT_BERTH_ID).apron;
    tickUntil(world, () => c.state === 'placing' && c.phaseTicksLeft === 1, 400);
    const unit = c.heldUnitId as EntityId;
    const slot = c.reservedSlot as number;
    apron.release(slot); // poškodenie mimo simulácie: rezervácia zmizla, žeriav o tom nevie

    let error: unknown;
    try {
      world.tick();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModuleError);
    expect((error as ModuleError).code).toBe('slot_not_reserved');
    expect(world.cargo.get(unit)?.location).toEqual({ kind: 'in_crane', craneId: ROOT_CRANE_ID });
    expect(apron.unitAt(slot)).toBeNull();
    expect(apron.units()).toEqual([]);
    expect(world.cargo.unitsOnApron(ROOT_BERTH_ID)).toEqual([]);
    expect(ofType(world.events.flush(), 'CargoMoved').filter((event) => event.to.kind === 'on_apron')).toEqual([]);
    expect(ship.state).toBe('docked');
  });
});

describe('okamžitý stav swinging (T02-14)', () => {
  it('tick nikdy nezačne v swinging — poškodený žeriav → ModuleError(invalid_transition), nie tichý placing', () => {
    const world = newWorld({ checkInvariants: false });
    driveCrane(crane(world, ROOT_CRANE_ID), 'swinging');
    let error: unknown;
    try {
      world.tick();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModuleError);
    expect((error as ModuleError).code).toBe('invalid_transition');
    expect(crane(world, ROOT_CRANE_ID).state).toBe('swinging');
  });
});

describe('save/load roundtrip uprostred vykládky', () => {
  it('žeriav v placing s jednotkou, loď docked → identický hash aj udalosti po ďalších 500 tickoch', () => {
    const world = newWorld();
    const ship = spawn(world, 'feeder', 4);
    tickUntil(world, () => world.cargo.countByKind('on_apron') === 1 && crane(world, ROOT_CRANE_ID).state === 'grabbing', 400);
    tickUntil(world, () => crane(world, ROOT_CRANE_ID).state === 'placing', 20);
    world.tick();
    expect(ship.state).toBe('docked');
    expect(crane(world, ROOT_CRANE_ID).heldUnitId).not.toBeNull();

    const saved = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    expect(saved.ships).toHaveLength(1);
    expect(saved.ships[0]).toMatchObject({ state: 'docked', berthIds: [ROOT_BERTH_ID], x: 43, y: 13, heading: 90 });
    const restored = World.deserialize(SHIP_DEFS, MAP, saved);
    expect(berth(restored, ROOT_BERTH_ID).dockedShipId).toBe(ship.id);
    expect(crane(restored, ROOT_CRANE_ID)).toMatchObject({ state: 'placing', heldUnitId: crane(world, ROOT_CRANE_ID).heldUnitId });
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));

    const a = tickN(world, 500);
    const b = tickN(restored, 500);
    expect(b).toEqual(a);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(world.ships.size).toBe(0);
  });
});
