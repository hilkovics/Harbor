// World.cargo (T02-02): ledger je súčasť sveta — id zo spoločného world.ids, CargoMoved do world.events s clock.tick,
// katalóg typov z world.defs. WorldState v1 náklad neukladá, preto serialize() pri existujúcom náklade radšej zlyhá
// (v2 = T02-03). Typovaný test helper assertCargoConservation deleguje na world.cargo.
import { describe, expect, it, vi } from 'vitest';
import { CargoConservationError, CargoError, CargoLedger } from '@sim/cargo';
import { World } from '@sim/world';
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
    expect(world.cargo.getState()).toEqual({ createdCount: 0, exportedCount: 0, units: [] });
  });

  it('jednotky dostávajú id zo spoločného world.ids (rovnaká postupnosť ako ostatné entity)', () => {
    const world = create();
    expect(world.ids.next()).toBe(1);
    expect(world.cargo.create(TEU, at.ship(1)).id).toBe(2);
    expect(world.ids.next()).toBe(3);
  });

  it('typy nákladu berie z world.defs.cargoTypes', () => {
    expect(() => create().cargo.create(GRAIN, at.ship(1))).toThrow(CargoError);
    expect(create(CARGO_DEFS).cargo.create(GRAIN, at.ship(1)).quantity).toBe(CARGO_DEFS.cargoTypes.get(GRAIN).unitsPerBatch);
  });

  it('CargoMoved z príkazu pred krokom 1 má ešte predchádzajúci tick a ide pred TickAdvanced', () => {
    const world = create();
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

describe('World.serialize/deserialize a náklad (WorldState v1)', () => {
  it('svet bez nákladu sa serializuje ako doteraz', () => {
    expect(() => create().serialize()).not.toThrow();
  });

  it('svet s nákladom → Error namiesto tichej straty nákladu (uloží ho až v2)', () => {
    const world = create();
    world.cargo.create(TEU, at.ship(1));
    expect(() => world.serialize()).toThrow('World.serialize: WorldState v1 neukladá náklad a ledger eviduje 1 vytvorených jednotiek');
  });

  it('aj keď všetok náklad odišiel z mapy (createdCount/exportedCount by sa stratili)', () => {
    const world = create();
    const unitId = world.cargo.create(TEU, at.ship(1)).id;
    moveThrough(world.cargo, unitId, CONTAINER_CHAIN);
    expect(world.cargo.liveCount).toBe(0);
    expect(() => world.serialize()).toThrow(/neukladá náklad/);
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
