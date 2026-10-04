// World.cargo (T02-02, T02-03): ledger je súčasť sveta — id zo spoločného world.ids, CargoMoved do world.events
// s clock.tick, katalóg typov z world.defs. WorldState v2 ukladá stav ledgera (`cargo.getState()`, ADR-014) a loader
// odmietne jednotku u neexistujúceho držiteľa. Typovaný test helper assertCargoConservation deleguje na world.cargo.
import { describe, expect, it, vi } from 'vitest';
import { CargoConservationError, CargoError, CargoLedger } from '@sim/cargo';
import { World, WorldStateError } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { DEFS, MAP, SEED, TestCommand, runTicks } from '../world/world-fixtures';
import { CARGO_DEFS, CONTAINER_CHAIN, GRAIN, TEU, at, id, moveThrough } from './cargo-fixtures';

const create = (defs = DEFS): World => World.create(defs, MAP, SEED);

describe('World.cargo', () => {
  it('nový svet má prázdny CargoLedger', () => {
    const world = create();
    expect(world.cargo).toBeInstanceOf(CargoLedger);
    expect(world.cargo.createdCount).toBe(0);
    expect(world.cargo.exportedCount).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.cargo.getState()).toEqual({ createdCount: 0, exportedCount: 0, shippedCount: 0, units: [] });
  });

  it('jednotky dostávajú id zo spoločného world.ids (rovnaká postupnosť ako ostatné entity)', () => {
    const world = create();
    // Starter moduly mapy (Root modul, T02-04) dostali id 1, 2, … pri World.create.
    const first = world.ids.getState().nextId;
    expect(first).toBe(MAP.starter.modules.length + 1);
    expect(world.ids.next()).toBe(first);
    expect(world.cargo.create(TEU, at.ship(1)).id).toBe(first + 1);
    expect(world.ids.next()).toBe(first + 2);
  });

  it('typy nákladu berie z world.defs.cargoTypes', () => {
    expect(() => create().cargo.create(GRAIN, at.ship(1))).toThrow(CargoError);
    expect(create(CARGO_DEFS).cargo.create(GRAIN, at.ship(1)).quantity).toBe(CARGO_DEFS.cargoTypes.get(GRAIN).unitsPerBatch);
  });

  it('CargoMoved z príkazu pred krokom 1 má ešte predchádzajúci tick a ide pred TickAdvanced', () => {
    // Jednotka v Root žeriave bez jeho cyklu je zámerne nekonzistentný svet — krok 12 (invarianty) sa tu vypne.
    const world = World.create(DEFS, MAP, SEED, { checkInvariants: false });
    runTicks(world, 5);
    const unitId = world.cargo.create(TEU, at.ship(1)).id;
    world.enqueue(new TestCommand({ type: 'TestUnload', apply: (w) => w.cargo.move(unitId, at.crane(2)) }));
    expect(world.tick()).toEqual([
      { type: 'CargoMoved', unitId, from: at.ship(1), to: at.crane(2), tick: 5 },
      { type: 'TickAdvanced', tick: 6 },
    ]);
  });

  it('CargoMoved nesie clock.tick v okamihu presunu a vráti ho applyPending()', () => {
    const world = create();
    runTicks(world, 3);
    const unitId = world.cargo.create(TEU, at.ship(1)).id;
    world.cargo.move(unitId, at.crane(2));
    expect(world.applyPending()).toEqual([{ type: 'CargoMoved', unitId, from: at.ship(1), to: at.crane(2), tick: 3 }]);
  });

  it('odmietnutý presun v príkaze nič neemituje a ledger nezmení', () => {
    const world = create();
    const unitId = world.cargo.create(TEU, at.ship(1)).id;
    const before = world.cargo.getState();
    world.enqueue(new TestCommand({ type: 'TestTeleport', apply: (w) => w.cargo.move(unitId, at.storage(3, 0)) }));
    expect(() => world.applyPending()).toThrow(/nepovolený prechod on_ship\(shipId=1\) → in_storage\(moduleId=3, slot=0\)/);
    expect(world.cargo.getState()).toEqual(before);
    expect(world.events.pending).toBe(0);
  });
});

describe('World.serialize/deserialize a náklad (WorldState v2)', () => {
  it('svet bez nákladu: cargo = prázdny stav ledgera', () => {
    expect(create().serialize().cargo).toEqual({ createdCount: 0, exportedCount: 0, shippedCount: 0, units: [] });
  });

  it('serialize uloží stav ledgera (cargo.getState()) — aj pri náklade u neexistujúceho držiteľa, bez chyby', () => {
    const world = create();
    world.cargo.create(TEU, at.ship(1));
    const state = world.serialize();
    expect(state.cargo).toEqual(world.cargo.getState());
    expect(state.cargo.createdCount).toBe(1);
  });

  it('deserialize odmietne jednotku u neexistujúceho držiteľa (loď #1 vo svete nie je)', () => {
    const world = create();
    world.cargo.create(TEU, at.ship(1));
    let error: unknown;
    try {
      World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe('/cargo/units/0/location/shipId');
  });

  it('všetok náklad odišiel z mapy: createdCount/exportedCount prežijú roundtrip, jednotky sa neukladajú', () => {
    const world = create();
    const unitId = world.cargo.create(TEU, at.ship(1)).id;
    moveThrough(world.cargo, unitId, CONTAINER_CHAIN);
    world.applyPending();
    expect(world.cargo.liveCount).toBe(0);
    const state = world.serialize();
    expect(state.cargo).toEqual({ createdCount: 1, exportedCount: 1, shippedCount: 0, units: [] });
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(state)) as typeof state);
    expect(restored.cargo.createdCount).toBe(1);
    expect(restored.cargo.exportedCount).toBe(1);
    expect(restored.cargo.countByKind('exported')).toBe(1);
    expect(restored.cargo.get(unitId)).toBeUndefined();
    expect(restored.serialize()).toEqual(state);
  });

  it('deserialize dá prázdny ledger napojený na obnovené ids, events a clock', () => {
    const original = create();
    runTicks(original, 7);
    original.ids.next();
    const restored = World.deserialize(DEFS, MAP, original.serialize());
    expect(restored.cargo).not.toBe(original.cargo);
    expect(restored.cargo.createdCount).toBe(0);
    const unitId = restored.cargo.create(TEU, at.ship(1)).id;
    expect(unitId).toBe(original.ids.next());
    restored.cargo.move(unitId, at.crane(2));
    expect(restored.applyPending()).toEqual([{ type: 'CargoMoved', unitId, from: at.ship(1), to: at.crane(2), tick: 7 }]);
    expect(original.events.pending).toBe(0);
  });
});

describe('assertCargoConservation (tests/sim/helpers/invariants.ts)', () => {
  it('deleguje typovane na world.cargo.assertConservation()', () => {
    const world = create();
    const spy = vi.spyOn(world.cargo, 'assertConservation');
    assertCargoConservation(world);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('prejde na svete s nákladom v rôznych lokáciách', () => {
    const world = create();
    const [a, b] = [world.cargo.create(TEU, at.ship(1)).id, world.cargo.create(TEU, at.ship(1)).id];
    moveThrough(world.cargo, a, CONTAINER_CHAIN.slice(0, 3));
    world.cargo.move(b, at.crane(20));
    expect(() => assertCargoConservation(world)).not.toThrow();
    expect(world.cargo.unitsAt('in_crane', id(20))).toEqual([b]);
  });

  it('porušenie z ledgera prepadne ako CargoConservationError', () => {
    const world = create();
    vi.spyOn(world.cargo, 'assertConservation').mockImplementation(() => {
      throw new CargoConservationError('jednotka #1 nie je v žiadnom indexe');
    });
    expect(() => assertCargoConservation(world)).toThrow(CargoConservationError);
  });
});
