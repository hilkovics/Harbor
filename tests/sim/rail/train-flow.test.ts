// Vlak (TR6-01, ADR-043): cestovný poriadok, jazda po koľaji (jeden pohyblivý vlak, bez prekrytia), pobyt, odchod plný / v pláne, determinizmus a save uprostred jazdy.
import { describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { WorldStateError, World, stateHash } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import type { SimEvent } from '@sim/events';
import { EXPORT_CONTRACT, EXPORT_LABELS, TEU } from '../cargo/cargo-fixtures';
import { assertCargoConservation } from '../helpers/invariants';
import { RAIL_MAP, railDefs, railWorld } from '../helpers/r6-rail';

const TICKS_PER_HOUR = 360;

function runUntil(world: World, done: (world: World) => boolean, maxTicks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < maxTicks && !done(world); i++) events.push(...world.tick());
  expect(done(world), 'podmienka sa nesplnila v limite').toBe(true);
  return events;
}

describe('cestovný poriadok a príchod', () => {
  it('prvý vlak vznikne v `firstArrivalHour` na portáli a ide k termináli; oneskorenie 0', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 1 } });
    const events: SimEvent[] = [];
    for (let i = 0; i < TICKS_PER_HOUR - 1; i++) world.tick();
    expect(world.trains.size).toBe(0);
    events.push(...world.tick());
    expect(world.trains.size).toBe(1);
    const arrived = events.find((event) => event.type === 'TrainArrived');
    expect(arrived).toMatchObject({ type: 'TrainArrived', delayTicks: 0, exportUnits: 0 });
    const train = [...world.trains.values()][0];
    expect(train.state).toBe('arriving');
    expect(train.wagons).toBe(world.defs.rail.timetable.wagonsPerTrain);
    expect(train.scheduledTick).toBe(TICKS_PER_HOUR);
  });

  it('bez napojenej koľaje vlak nevznikne a plán sa preskočí (Rng sa nespotrebuje)', () => {
    const { world } = railWorld({ rails: false, timetable: { firstArrivalHour: 0, intervalHours: 1 } });
    for (let i = 0; i < 3 * TICKS_PER_HOUR; i++) world.tick();
    expect(world.trains.size).toBe(0);
    expect(world.rail.counters.skippedArrivals).toBeGreaterThanOrEqual(3);
    expect(world.hasRailService).toBe(false);
    // `railShare` sa bez napojeného terminálu nelosuje: ponuky ho nemajú.
    expect(world.contracts.size).toBeGreaterThan(0);
    expect([...world.contracts.values()].every((contract) => contract.railShareBp === 0)).toBe(true);
  });

  it('plán je pravidelný: príchody po `intervalHours`', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 1, intervalHours: 2, dwellMinutes: 1 } });
    const ticks: number[] = [];
    for (let i = 0; i < 8 * TICKS_PER_HOUR; i++) {
      for (const event of world.tick()) if (event.type === 'TrainArrived') ticks.push(world.clock.tick);
    }
    expect(ticks).toEqual([TICKS_PER_HOUR, 3 * TICKS_PER_HOUR, 5 * TICKS_PER_HOUR, 7 * TICKS_PER_HOUR]);
  });
});

describe('jazda, pobyt a odchod', () => {
  it('vlak príde, zastane na konci koľaje, po pobyte odíde cez portál a zanikne', () => {
    const { world, terminal } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 30 } });
    const events: SimEvent[] = [];
    const states: string[] = [];
    for (let i = 0; i < 3000 && world.rail.counters.trainsDeparted === 0; i++) {
      events.push(...world.tick());
      assertCargoConservation(world);
      const train = [...world.trains.values()][0];
      if (train !== undefined && states.at(-1) !== train.state) states.push(train.state);
    }
    expect(states).toEqual(['arriving', 'dwelling', 'departing']);
    expect(world.trains.size).toBe(0);
    const departed = events.find((event) => event.type === 'TrainDeparted');
    expect(departed).toMatchObject({ type: 'TrainDeparted', units: 0 });
    expect(world.rail.occupancy.every((value) => value === 0)).toBe(true);
    expect(terminal.tracks).toBe(2);
    expect(world.rail.counters).toMatchObject({ trainsSpawned: 1, trainsDeparted: 1 });
  });

  it('pobyt trvá `dwellMinutes` od zastavenia', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 30 } });
    runUntil(world, (w) => [...w.trains.values()][0]?.state === 'dwelling', 2000);
    const train = [...world.trains.values()][0];
    expect(train.posMilli).toBe(train.stopMilli);
    expect(train.departAtTick).toBe((train.stoppedTick as number) + 30 * 6);
    runUntil(world, (w) => [...w.trains.values()][0]?.state === 'departing', 400);
    expect(world.clock.tick).toBeGreaterThanOrEqual(train.departAtTick as number);
  });

  it('dva vlaky sa neprekrývajú: druhý ide na druhú koľaj, tretí čaká (oneskorenie sa meria); na koľajisku jazdí najviac jeden', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0, intervalHours: 0.5, dwellMinutes: 600 } });
    let maxMoving = 0;
    let maxTrains = 0;
    for (let i = 0; i < 2500; i++) {
      world.tick();
      const moving = [...world.trains.values()].filter((train) => train.moving).length;
      maxMoving = Math.max(maxMoving, moving);
      maxTrains = Math.max(maxTrains, world.trains.size);
      expect(findWorldViolation(world)).toBeUndefined();
    }
    expect(maxMoving).toBe(1);
    expect(maxTrains).toBe(2);
    const tracks = [...world.trains.values()].map((train) => train.track).sort();
    expect(tracks).toEqual([0, 1]);
    expect(world.rail.counters.delayTicksMax).toBeGreaterThan(0);
  });

  it('prázdny vlak, ktorý nie je plný, odíde v pláne; náklad z príchodu ho drží (odchod až po vyložení)', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 10 } });
    runUntil(world, (w) => [...w.trains.values()][0]?.state === 'dwelling', 2000);
    const train = [...world.trains.values()][0];
    // Jednotka exportu na vlaku (vznik v in_train) ho podrží: vlak neodíde, kým ju RMG (TR6-02) nevyloží.
    world.cargo.create(TEU, { kind: 'in_train', trainId: train.id, slot: 0 }, EXPORT_CONTRACT, EXPORT_LABELS);
    for (let i = 0; i < 400; i++) world.tick();
    expect(train.state).toBe('dwelling');
  });
});

describe('determinizmus a save', () => {
  it('rovnaký seed → rovnaký stav; save uprostred jazdy aj pobytu sa po obnove správa rovnako', () => {
    const base = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 20 } }).world;
    const twin = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 20 } }).world;
    for (let i = 0; i < 700; i++) {
      base.tick();
      twin.tick();
    }
    expect(stateHash(base)).toBe(stateHash(twin));
    for (const stopAt of ['arriving', 'dwelling', 'departing'] as const) {
      const live = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 20 } }).world;
      runUntil(live, (w) => [...w.trains.values()][0]?.state === stopAt, 3000);
      for (let i = 0; i < 17; i++) live.tick();
      const state = JSON.parse(JSON.stringify(live.serialize())) as ReturnType<World['serialize']>;
      expect(state.trains.length).toBeLessThanOrEqual(1);
      const restored = World.deserialize(railDefs({ timetable: { firstArrivalHour: 0, dwellMinutes: 20 } }), RAIL_MAP, state, { checkInvariants: true });
      expect(stateHash(restored)).toBe(stateHash(live));
      for (let i = 0; i < 1200; i++) {
        live.tick();
        restored.tick();
      }
      expect(stateHash(restored)).toBe(stateHash(live));
      expect(restored.rail.counters.trainsDeparted).toBe(live.rail.counters.trainsDeparted);
    }
  });

  it('save v14 sa odmietne; poškodený vlak vo save → WorldStateError', () => {
    const { world } = railWorld({ timetable: { firstArrivalHour: 0 } });
    for (let i = 0; i < 60; i++) world.tick();
    const state = JSON.parse(JSON.stringify(world.serialize())) as Record<string, unknown>;
    expect(() => World.deserialize(railDefs(), RAIL_MAP, { ...state, version: 14 } as never)).toThrowError(/verzia 14/);
    const trains = state['trains'] as Record<string, unknown>[];
    expect(trains).toHaveLength(1);
    const broken = { ...state, trains: [{ ...trains[0], terminalId: 999 }] };
    expect(() => World.deserialize(railDefs(), RAIL_MAP, broken as never)).toThrowError(WorldStateError);
    const twice = { ...state, trains: [trains[0], { ...trains[0], id: (trains[0]['id'] as number) + 1 }] };
    expect(() => World.deserialize(railDefs(), RAIL_MAP, twice as never)).toThrowError(WorldStateError);
  });
});

describe('def', () => {
  it('bundled rail.json: vagón 3 TEU, 4 vagóny, interval 6 h', () => {
    const defs = loadBundledDefs();
    expect(defs.rail.train.wagonTeu).toBe(3);
    expect(defs.rail.timetable).toMatchObject({ intervalHours: 6, wagonsPerTrain: 4 });
    expect(Object.isFrozen(defs.rail.train)).toBe(true);
  });
});
