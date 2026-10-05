// Kontrola a M&R prázdnych kontajnerov v depe (T6C-02, ADR-034 bod 7): `damageChance` pri uložení → `damaged` → oprava `repairHours`
// obmedzená `repairBays` → `available`, poplatok `repairCostCents` v ledgeri (`maintenance_repair`), udalosti, výber dostupného prázdneho
// (`findAvailableEmpty`: len `available`, depo pred dvorom) a obnova uprostred opravy.
import { describe, expect, it } from 'vitest';
import { findAvailableEmpty } from '@sim/logistics/empty-stock';
import { StorageModule } from '@sim/modules';
import { World, stateHash } from '@sim/world';
import { DEFS, MAP } from '../world/world-fixtures';
import { TICKS_PER_HOUR, depotOf, emptiesByLocation, emptyWorld, eventsOf, f6cDefs, putEmpty, run, runUntil } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { itR1Interim } from '../helpers/r1-interim';

const TWO_STRADDLES = ['straddle_carrier', 'straddle_carrier'];
const REPAIR_COST = DEFS.economy.repairCostCents;
const REPAIR_TICKS = Math.round(DEFS.logistics.emptyFlow.repairHours * TICKS_PER_HOUR);

const yardOf = (world: World): StorageModule => {
  const depot = depotOf(world);
  const yard = [...world.modules.values()].find((module): module is StorageModule => module instanceof StorageModule && module.id !== depot.id && module.category === 'container');
  if (yard === undefined) throw new Error('svet nemá dvor');
  return yard;
};

describe('kontrola pri uložení do depa', () => {
  itR1Interim('damageChance 1: jednotka je damaged hneď po uložení (EmptyStored → EmptyDamaged), vydať sa nedá', () => {
    const world = emptyWorld({ defs: f6cDefs({ emptyFlow: { damageChance: 1 } }), vehicles: TWO_STRADDLES });
    world.emptyFlow.scheduleReturn(world.clock.tick + 5, 'blue_anchor');
    const events = runUntil(world, (w) => [...w.cargo.liveUnits()].some((unit) => unit.status === 'damaged'), 3_000, 'poškodenie');
    const stored = eventsOf(events, 'EmptyStored');
    const damaged = eventsOf(events, 'EmptyDamaged');
    expect(stored).toHaveLength(1);
    expect(damaged).toEqual([{ type: 'EmptyDamaged', unitId: stored[0].unitId, lineId: 'blue_anchor', moduleId: depotOf(world).id }]);
    const types = events.map((entry) => entry.event.type);
    expect(types.indexOf('EmptyStored')).toBeLessThan(types.indexOf('EmptyDamaged'));
    expect(world.cargo.get(stored[0].unitId)).toMatchObject({ status: 'damaged', repairUntilTick: null });
    expect(findAvailableEmpty(world, 'blue_anchor')).toBeUndefined();
  });

  it('uloženie do bežného dvora (fallback, svet bez depa) kontrolu nerobí: jednotka ostane available a Rng sa nespotrebuje (kontrola je len v depe)', () => {
    const defs = f6cDefs({ emptyFlow: { damageChance: 1 } });
    const world = emptyWorld({ defs, depot: false, vehicles: TWO_STRADDLES });
    const rngBefore = world.rng.getState();
    world.emptyFlow.scheduleReturn(world.clock.tick + 5, 'blue_anchor');
    const events = runUntil(world, (w) => emptiesByLocation(w)['in_storage'] === 1, 3_000, 'prázdny vo dvore');
    expect(eventsOf(events, 'EmptyStored').map((event) => event.fallback)).toEqual([true]);
    expect(eventsOf(events, 'EmptyDamaged')).toEqual([]);
    expect(world.rng.getState()).toEqual(rngBefore);
    const yard = [...world.modules.values()].find((module): module is StorageModule => module instanceof StorageModule && module.category === 'container');
    const yardUnit = world.cargo.unitsAt('in_storage', (yard as StorageModule).id)[0];
    expect(world.cargo.get(yardUnit)?.status).toBe('available');
  });
});

describe('opravy — repairBays, trvanie, poplatok', () => {
  it('damaged → in_repair (krok 2) do tick + repairHours → available; EmptyRepaired s poplatkom a záznam maintenance_repair v ledgeri', () => {
    const world = emptyWorld();
    const unitId = putEmpty(world, depotOf(world), 'northern_star', 'damaged');
    const cash = world.cashCents;
    const started = run(world, 1);
    const tick = world.clock.tick;
    expect(eventsOf(started, 'EmptyRepairStarted')).toEqual([{ type: 'EmptyRepairStarted', unitId, lineId: 'northern_star', moduleId: depotOf(world).id, untilTick: tick + REPAIR_TICKS }]);
    expect(world.cargo.get(unitId)).toMatchObject({ status: 'in_repair', repairUntilTick: tick + REPAIR_TICKS });
    expect(world.cashCents).toBe(cash);
    const done = runUntil(world, (w) => w.cargo.get(unitId)?.status === 'available', REPAIR_TICKS + 5, 'koniec opravy');
    expect(world.clock.tick).toBe(tick + REPAIR_TICKS);
    expect(eventsOf(done, 'EmptyRepaired')).toEqual([{ type: 'EmptyRepaired', unitId, lineId: 'northern_star', moduleId: depotOf(world).id, costCents: REPAIR_COST }]);
    expect(world.cargo.get(unitId)).toMatchObject({ status: 'available', repairUntilTick: null });
    expect(world.cashCents).toBe(cash - REPAIR_COST);
    const entry = world.economy.entries.find((candidate) => candidate.category === 'maintenance_repair');
    expect(entry).toMatchObject({ amountCents: -REPAIR_COST, category: 'maintenance_repair', refId: `unit:${String(unitId)}` });
    const money = eventsOf(done, 'MoneyChanged').filter((event) => event.reason === 'maintenance_repair');
    expect(money.map((event) => event.deltaCents)).toEqual([-REPAIR_COST]);
    expect(findAvailableEmpty(world, 'northern_star')?.id).toBe(unitId);
    assertCargoConservation(world);
  });

  it('repairBays: dve opravy naraz (2 miesta), tretia poškodená čaká a začne v tom istom ticku, keď sa miesto uvoľní', () => {
    const world = emptyWorld();
    const depot = depotOf(world);
    expect(depot.repairBays).toBe(2);
    const ids = [putEmpty(world, depot, 'blue_anchor', 'damaged'), putEmpty(world, depot, 'blue_anchor', 'damaged'), putEmpty(world, depot, 'blue_anchor', 'damaged')];
    const first = run(world, 1);
    const startTick = world.clock.tick;
    // miesta dostanú poškodené v poradí id
    expect(eventsOf(first, 'EmptyRepairStarted').map((event) => event.unitId)).toEqual([ids[0], ids[1]]);
    expect(ids.map((id) => world.cargo.get(id)?.status)).toEqual(['in_repair', 'in_repair', 'damaged']);
    const rest = run(world, REPAIR_TICKS);
    const types = rest.filter((entry) => entry.tick === startTick + REPAIR_TICKS).map((entry) => `${entry.event.type}:${String((entry.event as { unitId?: number }).unitId)}`);
    expect(types.filter((type) => type.startsWith('Empty'))).toEqual([`EmptyRepaired:${String(ids[0])}`, `EmptyRepaired:${String(ids[1])}`, `EmptyRepairStarted:${String(ids[2])}`]);
    expect(world.cargo.get(ids[2])).toMatchObject({ status: 'in_repair', repairUntilTick: startTick + 2 * REPAIR_TICKS });
    expect(world.economy.entries.filter((entry) => entry.category === 'maintenance_repair')).toHaveLength(2);
    run(world, REPAIR_TICKS);
    expect(ids.map((id) => world.cargo.get(id)?.status)).toEqual(['available', 'available', 'available']);
    expect(world.economy.entries.filter((entry) => entry.category === 'maintenance_repair')).toHaveLength(3);
  });

  it('opravuje sa len v depe: poškodená jednotka v bežnom dvore (nie je v depe) sa neopravuje', () => {
    const world = emptyWorld();
    const unitId = putEmpty(world, yardOf(world), 'blue_anchor', 'damaged');
    const events = run(world, REPAIR_TICKS + 10);
    expect(world.cargo.get(unitId)?.status).toBe('damaged');
    expect(eventsOf(events, 'EmptyRepairStarted')).toEqual([]);
  });
});

describe('findAvailableEmpty — výber dostupného prázdneho', () => {
  it('berie len available kontajner danej linky: poškodený, v oprave a iná linka sa preskočia; najmenšie id', () => {
    const world = emptyWorld();
    const depot = depotOf(world);
    putEmpty(world, depot, 'blue_anchor', 'damaged');
    putEmpty(world, depot, 'blue_anchor', 'in_repair');
    putEmpty(world, depot, 'golden_wave');
    const good = putEmpty(world, depot, 'blue_anchor');
    const better = putEmpty(world, depot, 'blue_anchor');
    expect(findAvailableEmpty(world, 'blue_anchor')?.id).toBe(good);
    expect(good).toBeLessThan(better);
    expect(findAvailableEmpty(world, 'northern_star')).toBeUndefined();
  });

  it('depo má prednosť pred bežným dvorom (aj keď je prázdny z dvora starší); kontajner s aktívnym jobom sa nevydáva', () => {
    const world = emptyWorld();
    const yardUnit = putEmpty(world, yardOf(world), 'blue_anchor');
    const depotUnit = putEmpty(world, depotOf(world), 'blue_anchor');
    expect(yardUnit).toBeLessThan(depotUnit);
    expect(findAvailableEmpty(world, 'blue_anchor')?.id).toBe(depotUnit);
    world.cargo.move(depotUnit, { kind: 'in_vehicle', vehicleId: 802 as never });
    expect(findAvailableEmpty(world, 'blue_anchor')?.id).toBe(yardUnit);
  });
});

describe('obnova uprostred opravy', () => {
  it('save uprostred opravy + pokračovanie dá rovnaké udalosti a hash ako nepretržitý beh', () => {
    const make = (): World => {
      const world = emptyWorld({ defs: f6cDefs({ emptyFlow: { damageChance: 1 } }), vehicles: TWO_STRADDLES });
      world.emptyFlow.scheduleReturn(world.clock.tick + 5, 'blue_anchor');
      world.emptyFlow.scheduleReturn(world.clock.tick + 40, 'northern_star');
      return world;
    };
    const continuous = make();
    run(continuous, 1_500);
    expect([...continuous.cargo.liveUnits()].some((unit) => unit.status === 'in_repair')).toBe(true);
    const restored = World.deserialize(f6cDefs({ emptyFlow: { damageChance: 1 } }), MAP, JSON.parse(JSON.stringify(continuous.serialize())) as never);
    const expected = run(continuous, 3_500);
    const actual = run(restored, 3_500);
    expect(actual.map((entry) => JSON.stringify(entry))).toEqual(expected.map((entry) => JSON.stringify(entry)));
    expect(stateHash(restored)).toBe(stateHash(continuous));
    expect(eventsOf(expected, 'EmptyRepaired').length).toBeGreaterThanOrEqual(1);
    assertCargoConservation(restored);
  });
});
