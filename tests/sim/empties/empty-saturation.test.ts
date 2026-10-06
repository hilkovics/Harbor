// Nasýtenie depa prázdnych (T6C-07b, review src/sim, M1; ADR-034 dodatok T6C-07b): návrat prázdneho sa povolí len keď má depo voľné miesto
// (voľné − rozbehnuté návraty); bez miesta sa položka plánu len „spotrebuje“ bez kamióna (`EmptyReturnDeclined`, nič nevznikne, konzervácia
// ostáva) a bežný dvor sa prázdnymi nezaplní. Fallback do dvora len keď depo chýba (test v `empty-return.test.ts`).
import { describe, expect, it } from 'vitest';
import { assertCargoConservation } from '../helpers/invariants';
import { exportWorld } from '../helpers/f6a';
import { TICKS_PER_DAY, acceptedImport, depotOf, emptiesByLocation, emptyWorld, eventsOf, f6cDefs, lost, rampOf, run, runUntil, stockDepot } from '../helpers/f6c';
import type { EntityId } from '@sim/core';
import { StorageModule } from '@sim/modules';
import { emptyLabelsOf } from '../logistics/yard-fixtures';
import { emptyReturnRoom } from '@sim/logistics/empty-stock';

const TWO_STRADDLES = ['straddle_carrier', 'straddle_carrier'];

/** Dvory (bežné sklady kategórie container) sveta, bez depa prázdnych. */
function yardsOf(world: ReturnType<typeof emptyWorld>): StorageModule[] {
  const depot = depotOf(world);
  return [...world.modules.values()].filter((module): module is StorageModule => module instanceof StorageModule && module.id !== depot.id);
}

/** Prázdne kontajnery uložené v bežných dvoroch (mimo depa). */
function emptiesInYards(world: ReturnType<typeof emptyWorld>): number {
  let count = 0;
  for (const yard of yardsOf(world)) {
    for (const unitId of world.cargo.unitsAt('in_storage', yard.id)) if (world.cargo.get(unitId)?.direction === 'empty') count += 1;
  }
  return count;
}

describe('návrat prázdneho — len s voľným miestom v depe (M1)', () => {
  it('depo kapacity 2, päť návratov naraz: dva kamióny, tri zahodené bez kamióna (EmptyReturnDeclined), dvor ostane bez prázdnych', () => {
    const defs = f6cDefs({ moduleParams: { empty_depot: { capacityUnits: 2 } } });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    const tick = world.clock.tick;
    for (let i = 0; i < 5; i++) world.emptyFlow.scheduleReturn(tick + 5, 'blue_anchor');
    const events = run(world, 4_000);
    expect(world.emptyFlow.returnPlan).toEqual([]);
    expect(eventsOf(events, 'EmptyReturnDeclined')).toEqual([
      { type: 'EmptyReturnDeclined', lineId: 'blue_anchor' },
      { type: 'EmptyReturnDeclined', lineId: 'blue_anchor' },
      { type: 'EmptyReturnDeclined', lineId: 'blue_anchor' },
    ]);
    expect(eventsOf(events, 'EmptyReturned')).toHaveLength(2);
    expect(eventsOf(events, 'TruckSpawned')).toHaveLength(2);
    expect(eventsOf(events, 'EmptyStored').map((event) => event.fallback)).toEqual([false, false]);
    expect(world.cargo.createdCount).toBe(2);
    expect(depotOf(world).storedCount).toBe(2);
    expect(emptiesInYards(world)).toBe(0);
    expect(emptiesByLocation(world)).toEqual({ in_storage: 2 });
    expect(world.trucks.size).toBe(0);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
  });

  it('rozbehnuté návraty sa odpočítavajú: depo kapacity 3 s jedným uloženým má miesto pre dva ďalšie, tretí a štvrtý návrat sa zahodia', () => {
    const defs = f6cDefs({ moduleParams: { empty_depot: { capacityUnits: 3 } } });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    stockDepot(world, 'golden_wave', 1);
    expect(emptyReturnRoom(world, rampOf(world), 'container')).toBe(2);
    const tick = world.clock.tick;
    for (let i = 0; i < 4; i++) world.emptyFlow.scheduleReturn(tick + 5, 'blue_anchor');
    const events = run(world, 4_000);
    expect(eventsOf(events, 'EmptyReturnDeclined')).toHaveLength(2);
    expect(eventsOf(events, 'EmptyReturned')).toHaveLength(2);
    expect(depotOf(world).storedCount).toBe(3);
    expect(emptiesInYards(world)).toBe(0);
    expect(emptyReturnRoom(world, rampOf(world), 'container')).toBe(0);
    assertCargoConservation(world);
  });

  it('rozbehnuté návraty sa počítajú v TEU (TR2-06b): prázdny 40′ čakajúci na docku zaberie 2 miesta depa, 20′ jedno', () => {
    const world = emptyWorld({ vehicles: TWO_STRADDLES });
    const ramp = rampOf(world);
    const before = emptyReturnRoom(world, ramp, 'container');
    const arrive = (sizeFt: 20 | 40): void => {
      const { id } = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 950 as EntityId }, null, emptyLabelsOf('blue_anchor', sizeFt));
      world.cargo.move(id, { kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    };
    arrive(40);
    expect(emptyReturnRoom(world, ramp, 'container')).toBe(before - 2);
    arrive(20);
    expect(emptyReturnRoom(world, ramp, 'container')).toBe(before - 3);
  });

  it('depo plné + import s návratmi: import sa vyloží a odíde, všetky návraty sa zahodia, na docku ani vo dvore žiadny prázdny', () => {
    const defs = f6cDefs({
      moduleParams: { empty_depot: { capacityUnits: 2 } },
      emptyFlow: { emptyReturnRate: 1, hinterlandDaysRange: [1, 1] },
      economy: { arrivalDaysRange: [0.5, 0.5] },
    });
    const world = emptyWorld({ defs, vehicles: TWO_STRADDLES });
    stockDepot(world, 'golden_wave', 2);
    const { contractId } = acceptedImport(world, 'golden_wave', 4);
    const events = runUntil(world, (w) => w.cargo.exportedCount === 4, 40_000, 'import odvezený kamiónmi');
    events.push(...run(world, 2 * TICKS_PER_DAY));
    expect(eventsOf(events, 'ContractCompleted').map((event) => event.contractId)).toEqual([contractId]);
    expect(eventsOf(events, 'EmptyReturnDeclined')).toHaveLength(4);
    expect(eventsOf(events, 'EmptyReturned')).toEqual([]);
    expect(eventsOf(events, 'EmptyStored')).toEqual([]);
    expect(world.emptyFlow.returnPlan).toEqual([]);
    expect(world.cargo.createdCount).toBe(6);
    expect(emptiesByLocation(world)).toEqual({ in_storage: 2 });
    expect(emptiesInYards(world)).toBe(0);
    expect(world.cargo.countByKind('at_ramp')).toBe(0);
    expect(world.cargo.countByKind('on_apron')).toBe(0);
    expect(world.trucks.size).toBe(0);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
  }, 120_000);

  it('depo existuje, ale z rampy sa k nemu nedá dôjsť: návrat sa zahodí (do dvora sa nikdy nelieva), kým depo nechýba', () => {
    const world = exportWorld({
      defs: f6cDefs(),
      vehicles: TWO_STRADDLES,
      yards: ['far'],
      extra: [
        { atTick: 0, command: { type: 'PlaceRoad', cells: [{ x: 32, y: 22 }] } },
        { atTick: 0, command: { type: 'PlaceModule', defId: 'empty_depot', x: 31, y: 18, rotation: 0 } },
      ],
    });
    const ramp = rampOf(world);
    expect(emptyReturnRoom(world, ramp, 'container')).toBe(0);
    const tick = world.clock.tick;
    for (let i = 0; i < 3; i++) world.emptyFlow.scheduleReturn(tick + 5, 'blue_anchor');
    const events = run(world, 2_000);
    expect(eventsOf(events, 'EmptyReturnDeclined')).toHaveLength(3);
    expect(eventsOf(events, 'EmptyReturned')).toEqual([]);
    expect(world.cargo.createdCount).toBe(0);
    expect(world.trucks.size).toBe(0);
  });

  it('svet bez depa: miesto je neohraničené (Infinity) — fallback do dvora ostáva (depo zbúrané po naplánovaní)', () => {
    const world = emptyWorld({ depot: false, vehicles: TWO_STRADDLES });
    expect(emptyReturnRoom(world, rampOf(world), 'container')).toBe(Infinity);
  });
});
