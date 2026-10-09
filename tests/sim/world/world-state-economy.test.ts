/**
 * WorldState: kontrakty, pool, `economy` (DaySummary/MonthSummary, posledných `ledgerEntriesKept` záznamov ledgera), `xp`, `completedContracts`,
 * bankrotové počítadlo a `gameOver` (T05-05, ARCHITECTURE §14). Priority dispatchera sa neukladajú (odvodzujú sa).
 *
 *  W1 `WORLD_STATE_VERSION === 13` (ADR-036); `serialize()` vracia `version: 13` a čistý JSON;
 *  W2 roundtrip čerstvého sveta s poolom: rovnaké kontrakty, ekonomika a ďalší beh.
 */
import { describe, expect, it } from 'vitest';
import { World, WORLD_STATE_VERSION, type WorldState } from '@sim/world';
import {
  DEFS,
  MAP,
  TICKS_PER_DAY,
  cashOf,
  contractList,
  offeredContracts,
} from '../helpers/f5';

const RUN_TIMEOUT_MS = 300_000;

describe('WorldState: ekonomika a kontrakty', () => {
  it('WORLD_STATE_VERSION je 13 (clean break savov, ADR-036) a serialize() vracia verziu 13 ako čistý JSON', () => {
    expect(WORLD_STATE_VERSION).toBe(13);
    const world = World.create(DEFS, MAP, 5901);
    world.tick();
    const state = world.serialize();
    expect(state.version).toBe(13);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('roundtrip čerstvého sveta s poolom: rovnaké kontrakty, ekonomika a ďalší beh', () => {
    const world = World.create(DEFS, MAP, 5902);
    world.tick();
    const clone = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
    expect(JSON.stringify(contractList(clone))).toBe(JSON.stringify(contractList(world)));
    expect(cashOf(clone)).toBe(cashOf(world));
    for (let i = 0; i < 2 * TICKS_PER_DAY; i++) {
      world.tick();
      clone.tick();
    }
    expect(JSON.stringify(clone.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(offeredContracts(clone)).toHaveLength(DEFS.economy.offersPerDay);
  }, RUN_TIMEOUT_MS);

  it('save uložený pred prvým tickom nestratí pool (T06-07): obnova nespotrebuje Rng a pool sa doplní v prvom ticku ako pri štarte hry', () => {
    const world = World.create(DEFS, MAP, 5903);
    const resaved = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
    expect(resaved.rng.getState()).toEqual(world.rng.getState());
    expect(offeredContracts(resaved)).toEqual([]);
    const first = world.tick();
    const second = resaved.tick();
    expect(first.filter((event) => event.type === 'ContractOffered')).toHaveLength(DEFS.economy.offersPerDay);
    expect(second.filter((event) => event.type === 'ContractOffered')).toHaveLength(DEFS.economy.offersPerDay);
    expect(JSON.stringify(resaved.serialize())).toBe(JSON.stringify(world.serialize()));
    // Ďalší tick pool nedopĺňa (kniha už id pridelila); ďalšie doplnenie až pri DayClosed.
    expect(world.tick().filter((event) => event.type === 'ContractOffered')).toEqual([]);
  });
});
