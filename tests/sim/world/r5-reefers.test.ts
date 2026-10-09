// Reefery vo svete (TR5-01, ADR-042): pravidlá stohu (reefer len na zásuvku, flat rack len navrch, OOG nikde bez OOG plochy), plánovač (zásuvka, žiadna voľná = null),
// systém reeferov (zapojenie, hodiny bez prúdu, reklamácie, alarmy a technici, elektrina) a save v14 s reeferom uprostred behu.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { loadMap, parseMapDef } from '@sim/grid';
import { chooseYardSlot, liftBlockedByPower } from '@sim/logistics';
import { BerthModule, CraneModule, ModuleError, YardBlock } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { HANDOVERS } from '../../../src/sim/systems/crane-handover';
import { stateHash, World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { hookDefs } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const id = (value: number): EntityId => value as EntityId;
const ECONOMY = { startingCashCents: 400_000_000 };

function worldOf(scenarioId: string, reefer: Record<string, unknown> = { alarmChancePerDay: 0 }): World {
  const scenario = loadScenarioFile(scenarioId);
  const world = World.create(hookDefs(0, { economy: ECONOMY, reefer }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: false });
  runScenario(world, scenario, 1);
  return world;
}

const yardOf = (world: World): YardBlock => [...world.modules.values()].find((module): module is YardBlock => module instanceof YardBlock) as YardBlock;

/** Jednotka typu `containerType` na lodi 900 (fiktívna; len prechody §7.1). */
function onShip(world: World, containerType: string, extra: { readonly oog?: boolean; readonly sizeFt?: 20 | 40 } = {}): EntityId {
  return world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) }, null, { ...extra, containerType, direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium' }).id;
}

/** Uloží jednotku do bunky `(bay, row, tier)` bloku; medzi zdvihom z lode a uložením prebehne tick (reefer je v pohybe, nie napájaný z lode). */
function store(world: World, unitId: EntityId, block: YardBlock, bay: number, row: number, tier: number): void {
  world.cargo.move(unitId, { kind: 'in_crane', craneId: id(901) });
  world.tick();
  world.cargo.move(unitId, { kind: 'on_apron', berthId: id(1), slot: 0 });
  world.cargo.move(unitId, { kind: 'in_vehicle', vehicleId: id(902) });
  world.cargo.move(unitId, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, tier) });
}

function stockReefer(world: World, block: YardBlock, bay: number, row = 0): EntityId {
  const unit = onShip(world, 'reefer');
  store(world, unit, block, bay, row, 0);
  return unit;
}

const eventsOfType = (events: readonly SimEvent[], type: SimEvent['type']): SimEvent[] => events.filter((event) => event.type === type);

function tickFor(world: World, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...world.tick());
  return events;
}

describe('pravidlá stohu typov (StorageGuard, ADR-042)', () => {
  it('reefer smie stáť na pozícii so zásuvkou; v bloku bez zásuviek (rtg_block) ho stráž odmietne a stav sa nezmení', () => {
    const plain = yardOf(worldOf('tt_rtg'));
    expect(plain.hasSockets).toBe(false);
    const world = worldOf('tt_rtg');
    const unit = onShip(world, 'reefer');
    world.cargo.move(unit, { kind: 'in_crane', craneId: id(901) });
    world.cargo.move(unit, { kind: 'on_apron', berthId: id(1), slot: 0 });
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: id(902) });
    const block = yardOf(world);
    expect(() => world.cargo.move(unit, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(0, 0, 0) })).toThrowError(ModuleError);
    expect(world.cargo.get(unit)?.location.kind).toBe('in_vehicle');
    const dry = onShip(world, 'dry');
    store(world, dry, block, 0, 0, 0);
    expect(world.cargo.get(dry)?.location.kind).toBe('in_storage');
  });

  it('reefer v bloku so zásuvkami je v poriadku a blok drží len jednotky so zásuvkou (invariant)', () => {
    const world = worldOf('reefer_flow');
    const block = yardOf(world);
    const unit = stockReefer(world, block, 0);
    expect(world.cargo.get(unit)?.location.kind).toBe('in_storage');
    expect(findWorldViolation(world)).toBeUndefined();
    const dry = onShip(world, 'dry');
    store(world, dry, block, 2, 0, 0);
    expect(findWorldViolation(world)).toMatch(/nepotrebuje/);
  });

  it('na flat rack nesmie ležať nič, flat rack smie ísť na zem aj navrch', () => {
    const world = worldOf('tt_rtg');
    const block = yardOf(world);
    const rack = onShip(world, 'flat_rack');
    store(world, rack, block, 0, 0, 0);
    const above = onShip(world, 'dry');
    world.cargo.move(above, { kind: 'in_crane', craneId: id(901) });
    world.cargo.move(above, { kind: 'on_apron', berthId: id(1), slot: 0 });
    world.cargo.move(above, { kind: 'in_vehicle', vehicleId: id(902) });
    expect(() => world.cargo.move(above, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(0, 0, 1) })).toThrowError(/flat rack/);
    const dry = onShip(world, 'dry');
    store(world, dry, block, 2, 0, 0);
    const topRack = onShip(world, 'flat_rack');
    world.cargo.move(topRack, { kind: 'in_crane', craneId: id(901) });
    world.cargo.move(topRack, { kind: 'on_apron', berthId: id(1), slot: 0 });
    world.cargo.move(topRack, { kind: 'in_vehicle', vehicleId: id(902) });
    world.cargo.move(topRack, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(2, 0, 1) });
    expect(world.cargo.get(topRack)?.location.kind).toBe('in_storage');
    expect(block.findStackProblem()).toBeUndefined();
  });

  it('OOG sa bez OOG plochy nedá uložiť nikam (blok ho neprijíma)', () => {
    const world = worldOf('tt_rtg');
    const block = yardOf(world);
    expect(block.acceptsOog).toBe(false);
    const oog = onShip(world, 'flat_rack', { oog: true });
    world.cargo.move(oog, { kind: 'in_crane', craneId: id(901) });
    world.cargo.move(oog, { kind: 'on_apron', berthId: id(1), slot: 0 });
    world.cargo.move(oog, { kind: 'in_vehicle', vehicleId: id(902) });
    expect(() => world.cargo.move(oog, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(0, 0, 0) })).toThrowError(/OOG/);
  });
});

describe('YardPlanner a zásuvky', () => {
  it('reefer dostane pozíciu v bloku so zásuvkami; dry tam nejde (blok so zásuvkami reefery rezervuje); bez voľnej zásuvky je výsledok null', () => {
    const world = worldOf('reefer_flow');
    const block = yardOf(world);
    const berth = [...world.modules.values()].find((module): module is BerthModule => module instanceof BerthModule) as BerthModule;
    const reefer = world.cargo.get(onShip(world, 'reefer')) as NonNullable<ReturnType<typeof world.cargo.get>>;
    const choice = chooseYardSlot(world, reefer, berth);
    expect(choice?.moduleId).toBe(block.id);
    expect(block.isPowered(block.positionOfSlot(choice?.slot as number).bay, block.positionOfSlot(choice?.slot as number).row)).toBe(true);
    const dry = world.cargo.get(onShip(world, 'dry')) as NonNullable<ReturnType<typeof world.cargo.get>>;
    expect(chooseYardSlot(world, dry, berth)).toBeNull();
    // Zaplníme zásuvky všetkými reefermi, ktoré sa zmestia (kapacita bloku v TEU).
    let stocked = 0;
    for (let tier = 0; tier < block.geometry.maxTier; tier++) {
      for (let row = 0; row < block.geometry.rows; row++) {
        for (let bay = 0; bay < block.geometry.bays; bay++) {
          if (stocked >= block.capacityTeu) continue;
          store(world, onShip(world, 'reefer'), block, bay, row, tier);
          stocked += 1;
        }
      }
    }
    expect(block.freeCount).toBe(0);
    expect(chooseYardSlot(world, reefer, berth)).toBeNull();
    assertCargoConservation(world);
  });

  it('plug cells: bunky so zásuvkou v poradí (row, bay); prázdny reefer zásuvku nepotrebuje', () => {
    const world = worldOf('reefer_flow');
    const block = yardOf(world);
    const cells = block.plugCells();
    expect(cells[0]).toEqual({ bay: 0, row: 0 });
    expect(cells[cells.length - 1]).toEqual({ bay: block.geometry.bays - 1, row: block.geometry.rows - 1 });
    expect(world.cargo.get(onShip(world, 'reefer'))?.reefer).not.toBeNull();
  });
});

describe('systém reeferov (krok 6d)', () => {
  it('uložený reefer sa po plugTicks zapojí, hodiny bez napájania sa zastavia a elektrina ide do `energy`', () => {
    const world = worldOf('reefer_flow');
    const block = yardOf(world);
    const { plugTicks } = world.defs.logistics.reefer;
    const unit = stockReefer(world, block, 0);
    expect(world.cargo.get(unit)?.reefer?.plugged).toBe(false);
    tickFor(world, plugTicks + 2);
    const state = world.cargo.get(unit)?.reefer;
    expect(state?.plugged).toBe(true);
    expect(state?.unpluggedSinceTick).toBeNull();
    tickFor(world, world.clock.ticksPerHour);
    const energy = world.economy.entries.filter((entry) => entry.category === 'energy');
    expect(energy.length).toBeGreaterThan(0);
    expect(energy[0].amountCents).toBe(-world.defs.economy.reeferPowerCentsPerHour);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('reefer bez napájania dlhšie než maxUnpluggedHours: reklamácia (penalty + ReeferClaim), hodiny sa spustia znova', () => {
    const world = worldOf('reefer_flow', { alarmChancePerDay: 0, plugTicks: 100_000 });
    const block = yardOf(world);
    const unit = stockReefer(world, block, 1);
    const limit = Math.round(world.defs.logistics.reefer.maxUnpluggedHours * world.clock.ticksPerHour);
    const events = tickFor(world, limit + 5);
    const claims = eventsOfType(events, 'ReeferClaim');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ unitId: unit, reason: 'unpowered', cents: world.defs.economy.reeferClaimCents });
    expect(world.economy.entries.some((entry) => entry.category === 'penalty' && entry.amountCents === -world.defs.economy.reeferClaimCents)).toBe(true);
    expect(tickFor(world, limit + 5).filter((event) => event.type === 'ReeferClaim')).toHaveLength(1);
  });

  it('alarm vznikne z `Rng` raz za hernú hodinu (šanca za deň / 24) len pri zapojenom reeferi v sklade', () => {
    const world = worldOf('reefer_flow', { alarmChancePerDay: 1, plugTicks: 5, alarmFixTicks: 5, alarmResponseHours: 5, maxUnpluggedHours: 100 });
    const block = yardOf(world);
    const unit = stockReefer(world, block, 0);
    const events = tickFor(world, 24 * 10 * world.clock.ticksPerHour);
    const alarms = eventsOfType(events, 'ReeferAlarm');
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.every((event) => (event as { unitId: EntityId }).unitId === unit)).toBe(true);
    expect(eventsOfType(events, 'ReeferClaim')).toHaveLength(0);
    expect(world.cargo.get(unit)?.reefer?.plugged).toBe(true);
  });

  it('technici: prvý alarm rieši technik, druhý čaká a bez zásahu do termínu je reklamácia (alarm)', () => {
    const world = worldOf('reefer_flow', { alarmChancePerDay: 0, technicians: 1, alarmFixTicks: 500, alarmResponseHours: 0.5, plugTicks: 5 });
    const block = yardOf(world);
    const first = stockReefer(world, block, 0);
    const second = stockReefer(world, block, 1);
    tickFor(world, 20);
    const deadline = world.clock.tick + Math.round(0.5 * world.clock.ticksPerHour);
    for (const unit of [first, second]) world.cargo.setReefer(unit, { ...(world.cargo.get(unit)?.reefer as NonNullable<ReturnType<typeof world.cargo.get>>['reefer'] & object), alarmUntilTick: deadline, fixUntilTick: null });
    tickFor(world, 1);
    expect(world.cargo.get(first)?.reefer?.fixUntilTick).not.toBeNull();
    expect(world.cargo.get(second)?.reefer?.fixUntilTick).toBeNull();
    const later = tickFor(world, Math.round(0.5 * world.clock.ticksPerHour) + 5);
    const claims = eventsOfType(later, 'ReeferClaim');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ unitId: second, reason: 'alarm' });
    expect(world.cargo.get(second)?.reefer?.alarmUntilTick).toBeNull();
    expect(world.cargo.get(first)?.reefer?.fixUntilTick).not.toBeNull();
    tickFor(world, 500);
    expect(world.cargo.get(first)?.reefer?.alarmUntilTick).toBeNull();
  });

  it('alarm po termíne je reklamácia aj pri voľnom technikovi (termín má prednosť pred zásahom, TR5-06b)', () => {
    const world = worldOf('reefer_flow', { alarmChancePerDay: 0, technicians: 2, alarmFixTicks: 500, alarmResponseHours: 0.5, plugTicks: 5 });
    const unit = stockReefer(world, yardOf(world), 0);
    tickFor(world, 20);
    world.cargo.setReefer(unit, { ...(world.cargo.get(unit)?.reefer as NonNullable<ReturnType<typeof world.cargo.get>>['reefer'] & object), alarmUntilTick: world.clock.tick, fixUntilTick: null });
    const events = tickFor(world, 1);
    expect(eventsOfType(events, 'ReeferClaim')).toMatchObject([{ unitId: unit, reason: 'alarm' }]);
    expect(world.cargo.get(unit)?.reefer?.alarmUntilTick).toBeNull();
    expect(world.cargo.get(unit)?.reefer?.fixUntilTick).toBeNull();
  });

  it('STS nezdvihne reefer bez zásuvky ani náhradným výberom: bez inej jednotky `undefined`, s dry jednotkou vezme dry (TR5-06b)', () => {
    const world = worldOf('tt_rtg');
    const berth = [...world.modules.values()].find((module): module is BerthModule => module instanceof BerthModule) as BerthModule;
    const crane = [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
    const env = { world, ship: { id: id(900) } as Ship, berth, crane };
    const reefer = onShip(world, 'reefer');
    expect(HANDOVERS.apron.unloadUnit(env)).toBeUndefined();
    expect(world.cargo.get(reefer)?.location.kind).toBe('on_ship');
    const dry = onShip(world, 'dry');
    expect(HANDOVERS.apron.unloadUnit(env)).toBe(dry);
  });

  it('zdvih zo skladu: job zo skladu spustí odpojenie (unplugTicks), kým je zapojený, `liftBlockedByPower` platí', () => {
    const world = worldOf('reefer_flow');
    const block = yardOf(world);
    const unit = stockReefer(world, block, 0);
    tickFor(world, world.defs.logistics.reefer.plugTicks + 2);
    const location = world.cargo.get(unit)?.location as { kind: 'in_storage'; moduleId: EntityId; slot: number };
    expect(liftBlockedByPower(world, { from: location })).toBe(true);
    expect(liftBlockedByPower(world, { from: { kind: 'on_apron', berthId: id(1), slot: 0 } })).toBe(false);
  });

  it('save v14 uprostred behu: reefer so stavom a index sa obnovia, beh pokračuje rovnako', () => {
    const world = worldOf('reefer_flow');
    const block = yardOf(world);
    stockReefer(world, block, 3);
    tickFor(world, 10);
    const state = JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>;
    expect(state.version).toBe(14);
    const restored = World.deserialize(world.defs, loadMap(parseMapDef(readRepoJson(loadScenarioFile('reefer_flow').map))), state);
    expect(stateHash(restored)).toBe(stateHash(world));
    expect(restored.reeferIndex.ids()).toEqual(world.reeferIndex.ids());
    tickFor(world, world.defs.logistics.reefer.plugTicks + 5);
    tickFor(restored, restored.defs.logistics.reefer.plugTicks + 5);
    expect(stateHash(restored)).toBe(stateHash(world));
  });
});
