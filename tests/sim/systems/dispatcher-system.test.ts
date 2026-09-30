// DispatcherSystem — krok 5 (T03-05; ARCHITECTURE §6, §7.3 body 1 a 3; ADR-018): inbound joby pre jednotky na aprone
// vo FIFO s rezerváciou slotu v najbližšom sklade, NoStorageAvailable najviac 1× za hernú hodinu na berth (throttle v save),
// priradenie jobov open v poradí vzniku najbližšiemu voľnému kompatibilnému vozidlu (remíza → menšie id), poradie udalostí.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import type { BerthModule, StorageModule } from '@sim/modules';
import { Vehicle } from '@sim/vehicles';
import { World } from '@sim/world';
import { DEFS, MAP } from '../world/world-fixtures';
import {
  BULK_VEHICLE,
  ROOT_BERTH_ID,
  YARD_E,
  YARD_F,
  YARD_W,
  buyVehicle,
  dispatchDefs,
  dispatchWorld,
  execute,
  placeYard,
  tickEvents,
  unitsOnApron,
} from '../logistics/dispatch-fixtures';

const berthOf = (world: World): BerthModule => world.modules.get(ROOT_BERTH_ID) as BerthModule;
/** Typy udalostí okrem `TickAdvanced` a `CargoMoved` (jednotky na apron presúva fixtúra mimo ticku). */
const types = (events: readonly SimEvent[]): string[] =>
  events.filter((event) => event.type !== 'TickAdvanced' && event.type !== 'CargoMoved').map((event) => event.type);

describe('inbound: joby pre jednotky na aprone', () => {
  it('jednotky vo FIFO (poradie príchodu, nie slotov) dostanú joby open s rezerváciou v najbližšom sklade (remíza W/E → menšie id)', () => {
    const { world } = dispatchWorld();
    const far = placeYard(world, YARD_F);
    const west = placeYard(world, YARD_W);
    placeYard(world, YARD_E);
    const units = unitsOnApron(world, [2, 0, 3]);
    const created = tickEvents(world, 'JobCreated');
    expect(created.map((event) => event.unitIds)).toEqual(units.map((unit) => [unit]));
    expect(created.every((event) => event.fromModuleId === ROOT_BERTH_ID && event.toModuleId === west.id)).toBe(true);
    const jobs = [...world.jobs.values()];
    expect(jobs.map((job) => [job.state, job.vehicleId, job.createdTick])).toEqual([
      ['open', null, 1],
      ['open', null, 1],
      ['open', null, 1],
    ]);
    expect(jobs.map((job) => job.from)).toEqual(units.map((unit) => world.cargo.get(unit)?.location));
    expect(jobs.map((job) => job.to)).toEqual([0, 1, 2].map((slot) => ({ kind: 'in_storage', moduleId: west.id, slot })));
    expect([west.reservedCount, west.storedCount, far.reservedCount]).toEqual([3, 0, 0]);
    for (const unit of units) expect(world.jobOfUnit(unit)?.unitIds).toEqual([unit]);
    expect(created.map((event) => event.jobId)).toEqual(jobs.map((job) => job.id));
  });

  it('jednotka s jobom nedostane druhý; ďalší tick nevytvorí nič, nová jednotka dostane nový job', () => {
    const { world } = dispatchWorld();
    placeYard(world, YARD_W);
    unitsOnApron(world, [0, 1]);
    expect(tickEvents(world, 'JobCreated')).toHaveLength(2);
    expect(tickEvents(world, 'JobCreated')).toHaveLength(0);
    const [late] = unitsOnApron(world, [2]);
    expect(tickEvents(world, 'JobCreated').map((event) => event.unitIds)).toEqual([[late]]);
    expect(world.jobs.size).toBe(3);
  });

  it('plne rezervovaný sklad sa preskočí: kapacita 2 → W, W, E, E; posledná jednotka bez skladu ostane bez jobu', () => {
    const { world } = dispatchWorld(dispatchDefs({ yardCapacity: 2 }));
    const west = placeYard(world, YARD_W);
    const east = placeYard(world, YARD_E);
    const units = unitsOnApron(world, [0, 1, 2, 3]);
    const events = world.tick();
    const created = events.filter((event) => event.type === 'JobCreated');
    expect(created.map((event) => (event.type === 'JobCreated' ? event.toModuleId : 0))).toEqual([west.id, west.id, east.id, east.id]);
    expect(events.filter((event) => event.type === 'NoStorageAvailable')).toEqual([]);
    placeYard(world, YARD_F);
    expect(world.jobs.size).toBe(4);
    expect(units.every((unit) => world.jobOfUnit(unit) !== undefined)).toBe(true);
  });
});

describe('NoStorageAvailable', () => {
  it('bez skladu: udalosť s berthom a typom prvej jednotky, najviac raz za hernú hodinu; hodina v berth.lastNoStorageHour', () => {
    const { world } = dispatchWorld();
    unitsOnApron(world, [0, 1]);
    const perHour = new Map<number, number>();
    const all: SimEvent[] = [];
    for (let i = 0; i < 3 * world.clock.ticksPerHour; i++) {
      for (const event of world.tick()) {
        if (event.type !== 'NoStorageAvailable') continue;
        all.push(event);
        perHour.set(world.clock.gameHour, (perHour.get(world.clock.gameHour) ?? 0) + 1);
      }
    }
    expect(all[0]).toEqual({ type: 'NoStorageAvailable', berthId: ROOT_BERTH_ID, cargoTypeId: 'container_teu' });
    expect([...perHour.values()].every((count) => count === 1)).toBe(true);
    expect([...perHour.keys()]).toEqual([0, 1, 2, 3]);
    expect(berthOf(world).lastNoStorageHour).toBe(world.clock.gameHour);
    expect(world.jobs.size).toBe(0);
    expect(world.cargo.countByKind('on_apron')).toBe(2);
  });

  it('prvý tick bez skladu hlási hneď; nepripojený aj pripojený-nedosiahnuteľný sklad sa ignoruje, po spojení cestou vznikne job a hlásenie ustane', () => {
    const { world } = dispatchWorld();
    const yard = placeYard(world, { x: 42, y: 24 }, 0); // konektor → vonkajšia bunka (43, 28) bez cesty
    unitsOnApron(world, [0]);
    expect(tickEvents(world, 'NoStorageAvailable')).toHaveLength(1);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 43, y: 28 }] });
    expect(world.isConnected(yard)).toBe(true);
    expect(tickEvents(world, 'JobCreated')).toEqual([]); // pripojený, ale k berthu nevedie cesta
    const link = [...Array.from({ length: 11 }, (_, i) => ({ x: 41, y: 18 + i })), { x: 42, y: 28 }];
    execute(world, { type: 'PlaceRoad', cells: link });
    expect(tickEvents(world, 'JobCreated').map((event) => event.toModuleId)).toEqual([yard.id]);
    const later: SimEvent[] = [];
    for (let i = 0; i < 2 * world.clock.ticksPerHour; i++) later.push(...world.tick());
    expect(later.filter((event) => event.type === 'NoStorageAvailable')).toEqual([]);
  });

  it('throttle prežije save/load: obnovený svet v tej istej hodine nehlási znova, v ďalšej áno (rovnako ako originál)', () => {
    const { world } = dispatchWorld();
    unitsOnApron(world, [0]);
    world.tick();
    expect(berthOf(world).lastNoStorageHour).toBe(0);
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())));
    expect(berthOf(restored).lastNoStorageHour).toBe(0);
    const run = (w: World): number[] => {
      const ticks: number[] = [];
      for (let i = 0; i < world.clock.ticksPerHour; i++) if (w.tick().some((event) => event.type === 'NoStorageAvailable')) ticks.push(w.clock.tick);
      return ticks;
    };
    const original = run(world);
    expect(run(restored)).toEqual(original);
    expect(original).toEqual([world.clock.ticksPerHour]);
  });
});

describe('priradenie vozidiel', () => {
  it('pri zhode ceny (obe vozidlá v depe) dostane prvý job menšie id, druhý druhé; poradie udalostí JobCreated → JobAssigned → VehicleStateChanged', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const [a, b] = [buyVehicle(world, depot), buyVehicle(world, depot)];
    unitsOnApron(world, [0, 1, 2]);
    const events = world.tick();
    expect(types(events)).toEqual([
      'JobCreated',
      'JobCreated',
      'JobCreated',
      'JobAssigned',
      'VehicleStateChanged',
      'JobAssigned',
      'VehicleStateChanged',
    ]);
    const jobs = [...world.jobs.values()];
    expect(jobs.map((job) => [job.state, job.vehicleId])).toEqual([
      ['assigned', a],
      ['assigned', b],
      ['open', null],
    ]);
    expect(events.filter((event) => event.type === 'VehicleStateChanged')).toEqual([
      { type: 'VehicleStateChanged', vehicleId: a, from: 'idle', to: 'to_pickup' },
      { type: 'VehicleStateChanged', vehicleId: b, from: 'idle', to: 'to_pickup' },
    ]);
    expect([world.vehicles.get(a)?.jobId, world.vehicles.get(b)?.jobId]).toEqual([jobs[0].id, jobs[1].id]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('najbližšie voľné vozidlo vyhrá nad menším id (vozidlo pri berthe pred vozidlom v depe)', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const inDepot = buyVehicle(world, depot);
    const near = new Vehicle({
      id: world.ids.next(),
      def: DEFS.vehicles.get('straddle_carrier'),
      depotId: depot.id,
      state: 'idle',
      x: 45.5,
      y: 17.5,
      heading: 90,
      purchaseCostCents: 0,
      route: [world.grid.index(45, 17)],
    });
    world.addVehicle(near);
    unitsOnApron(world, [0]);
    const assigned = tickEvents(world, 'JobAssigned');
    expect(assigned.map((event) => event.vehicleId)).toEqual([near.id]);
    expect(near.id).toBeGreaterThan(inDepot);
    expect(world.vehicles.get(inDepot)?.state).toBe('idle');
  });

  it('vozidlo bez kompatibilnej kategórie job nedostane (ostáva idle, job open); kompatibilné s väčším id áno', () => {
    const { world, depot } = dispatchWorld(dispatchDefs());
    placeYard(world, YARD_W);
    const bulk = buyVehicle(world, depot, BULK_VEHICLE);
    unitsOnApron(world, [0, 1]);
    const events = world.tick();
    expect(events.filter((event) => event.type === 'JobAssigned')).toEqual([]);
    expect([...world.jobs.values()].map((job) => job.state)).toEqual(['open', 'open']);
    expect(world.vehicles.get(bulk)?.state).toBe('idle');
    const straddle = buyVehicle(world, depot);
    const assigned = tickEvents(world, 'JobAssigned');
    expect(assigned.map((event) => event.vehicleId)).toEqual([straddle]);
    expect(world.vehicles.get(bulk)?.state).toBe('idle');
  });

  it('vozidlo, z ktorého k zdroju nevedie cesta, job nedostane; job ostáva open', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_E);
    const cutOff = buyVehicle(world, depot);
    execute(world, { type: 'RemoveRoad', cells: [{ x: 36, y: 17 }] }); // depo (32, 17) odrezané od berthu
    unitsOnApron(world, [0]);
    const events = world.tick();
    expect(events.filter((event) => event.type === 'JobCreated')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'JobAssigned')).toEqual([]);
    expect(world.vehicles.get(cutOff)?.state).toBe('idle');
    expect([...world.jobs.values()][0].state).toBe('open');
  });

  it('bez voľného vozidla ostávajú joby open; v ďalšom ticku sa nič nemení (deterministicky)', () => {
    const { world } = dispatchWorld();
    placeYard(world, YARD_W);
    unitsOnApron(world, [0, 1]);
    world.tick();
    const before = JSON.stringify(world.serialize().jobs);
    expect(types(world.tick())).toEqual([]);
    expect(JSON.stringify(world.serialize().jobs)).toBe(before);
    expect([...world.jobs.values()].every((job) => job.state === 'open')).toBe(true);
  });
});

describe('determinizmus a save', () => {
  function scenario(world: World, depotId: EntityId): void {
    placeYard(world, YARD_W);
    placeYard(world, YARD_E);
    execute(world, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId });
    unitsOnApron(world, [1, 0, 3]);
  }

  it('dva rovnaké svety majú rovnaký stav aj udalosti; joby open aj assigned prežijú save/load a pokračujú rovnako', () => {
    const run = (): { world: World; events: SimEvent[] } => {
      const { world, depot } = dispatchWorld();
      scenario(world, depot.id);
      const events: SimEvent[] = [];
      for (let i = 0; i < 5; i++) events.push(...world.tick());
      return { world, events };
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(b.world.serialize())).toBe(JSON.stringify(a.world.serialize()));
    expect(b.events).toEqual(a.events);

    const saved = a.world.serialize();
    expect(saved.jobs.map((job) => job.unitIds.length)).toEqual([1, 1, 1]);
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(saved)));
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(saved));
    expect([...restored.jobs.values()].map((job) => [job.state, job.vehicleId])).toEqual([...a.world.jobs.values()].map((job) => [job.state, job.vehicleId]));
    const west = restored.moduleAt(YARD_W.x, YARD_W.y) as StorageModule;
    expect(west.reservedSlots()).toEqual([0, 1, 2]);
    for (const world of [a.world, restored]) unitsOnApron(world, [2]);
    const nextA: SimEvent[] = [];
    const nextB: SimEvent[] = [];
    for (let i = 0; i < 20; i++) {
      nextA.push(...a.world.tick());
      nextB.push(...restored.tick());
    }
    expect(nextB).toEqual(nextA);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(a.world.serialize()));
  });
});
