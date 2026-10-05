/**
 * Kontrakty vo `WorldState` v5 (T05-03, ADR-026): kľúče `contracts`, `xp`, `completedContracts`, `nextContractId`,
 * fail-fast parsovanie s JSON pointerom, väzba nákladu na kontrakty pri obnove, krok 12 a roundtrip uprostred kontraktu
 * (pred príchodom lode, na ceste, pri vykládke, pri exporte) s rovnakým ďalším priebehom aj udalosťami.
 */
import { describe, expect, it } from 'vitest';
import type { SerializedContract } from '@sim/contracts';
import type { ContractId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { World, WorldInvariantError, WorldStateError, type WorldState } from '@sim/world';
import { must } from '../helpers/harbor';
import { runScenario } from '../helpers/scenario';
import { MAP, TICKS_PER_DAY, contractById, fixedContractDefs, offeredContracts, portScenario, startContract, worldWithPool } from '../helpers/f5';

const DEFS = fixedContractDefs();
const RUN_TIMEOUT_MS = 300_000;

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Svet s poolom a jedným prijatým kontraktom (pred príchodom lode). */
function acceptedWorld(): { readonly world: World; readonly state: WorldState } {
  const { world } = startContract({ id: 'f5_state', seed: 5501, defs: DEFS });
  return { world, state: viaJson(world.serialize()) };
}

/** Kópia stavu s upraveným prvým kontraktom. */
function withContract(state: WorldState, index: number, patch: Record<string, unknown>): WorldState {
  const contracts = state.contracts.map((contract, i) => (i === index ? { ...contract, ...patch } : contract)) as SerializedContract[];
  return { ...state, contracts };
}

function expectStateError(defs: typeof DEFS, state: WorldState, path: string): void {
  let error: unknown;
  try {
    World.deserialize(defs, MAP, state);
  } catch (caught) {
    error = caught;
  }
  expect(error, path).toBeInstanceOf(WorldStateError);
  expect((error as WorldStateError).path).toBe(path);
}

describe('WorldState v5: kontrakty v save', () => {
  it('serialize: contracts (bez expirovaných, vzostupne podľa id), xp, completedContracts, nextContractId; id kontraktov od 1 nezávisle od world.ids', () => {
    const world = worldWithPool(DEFS, 5502);
    const state = world.serialize();
    expect(state.contracts.map((contract) => [contract.id, contract.state])).toEqual(offeredContracts(world).map((offer) => [offer.id, 'offered']));
    expect(state.contracts.map((contract) => contract.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([state.xp, state.completedContracts, state.nextContractId]).toEqual([0, 0, 7]);
    // pool nespotrebúva id entít: po prvom ticku bez príkazov má svet len starter moduly
    expect(state.ids.nextId).toBe(MAP.starter.modules.length + 1);
  });

  it('roundtrip čerstvého poolu cez JSON: rovnaké kontrakty a rovnaký ďalší priebeh (expirácia + doplnenie pri DayClosed)', () => {
    const world = worldWithPool(DEFS, 5503);
    const clone = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
    expect(JSON.stringify([...clone.contracts.values()])).toBe(JSON.stringify([...world.contracts.values()]));
    const a: SimEvent[] = [];
    const b: SimEvent[] = [];
    for (let i = 0; i < 3 * TICKS_PER_DAY; i++) {
      a.push(...world.tick());
      b.push(...clone.tick());
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(clone.serialize())).toBe(JSON.stringify(world.serialize()));
  }, RUN_TIMEOUT_MS);

  it.each<[string, (state: WorldState) => WorldState, string]>([
    ['neznámy kľúč kontraktu', (s) => withContract(s, 0, { extra: 1 }), '/contracts/0/extra'],
    ['id ≥ nextContractId', (s) => ({ ...s, nextContractId: 2 }), '/contracts/1/id'],
    ['id nie vzostupne', (s) => withContract(s, 1, { id: 1 }), '/contracts/1/id'],
    ['neznáma šablóna', (s) => withContract(s, 0, { templateId: 'nope' }), '/contracts/0/templateId'],
    ['neznáma trieda lode', (s) => withContract(s, 0, { shipClassId: 'nope' }), '/contracts/0/shipClassId'],
    ['neznámy stav', (s) => withContract(s, 0, { state: 'declined' }), '/contracts/0/state'],
    ['záporné XP odmeny', (s) => withContract(s, 0, { xpReward: -1 }), '/contracts/0/xpReward'],
    ['objem nie celé číslo', (s) => withContract(s, 0, { volumeUnits: 1.5 }), '/contracts/0/volumeUnits'],
    ['ponuka v budúcnosti', (s) => withContract(s, 1, { offeredTick: 10_000 }), '/contracts/1/offeredTick'],
    ['ponuka po uzávierke, v ktorej mala zaniknúť', (s) => withContract(s, 1, { offerExpiresTick: 0 }), '/contracts/1/offerExpiresTick'],
    ['prijatý kontrakt, ktorého loď už mala priplávať', (s) => withContract(s, 0, { shipArrivalTick: 2 }), '/contracts/0/shipArrivalTick'],
    ['prijatý kontrakt s loďou (nesúlad so stavom)', (s) => withContract(s, 0, { shipId: 3 }), '/contracts/0'],
    ['záporné xp', (s) => ({ ...s, xp: -1 }), '/xp'],
    ['nextContractId 0', (s) => ({ ...s, nextContractId: 0 }), '/nextContractId'],
    ['completedContracts nie celé', (s) => ({ ...s, completedContracts: 0.5 }), '/completedContracts'],
  ])('neplatný stav: %s → WorldStateError na %s', (_label, mutate, path) => {
    const { state } = acceptedWorld();
    expect(state.contracts[0].state).toBe('accepted');
    expectStateError(DEFS, mutate(state), path);
  });
});

describe('WorldState v5: väzba nákladu na kontrakty a krok 12', () => {
  /** Svet s loďou kontraktu na ceste (náklad `on_ship` s `contractId`). */
  function enRouteWorld(): World {
    const { world, run, contractId } = startContract({ id: 'f5_state_ship', seed: 5504, defs: DEFS });
    run.runUntil((w) => contractById(w, contractId).state === 'ship_en_route', 2 * TICKS_PER_DAY);
    return world;
  }

  it('jednotka s kontraktom, ktorý v knihe nie je, alebo s kontraktom bez lode → WorldStateError na /cargo/units/<j>/contractId', () => {
    const state = viaJson(enRouteWorld().serialize());
    const unknown = { ...state, cargo: { ...state.cargo, units: state.cargo.units.map((unit, i) => (i === 0 ? { ...unit, contractId: 99 as ContractId } : unit)) } };
    expectStateError(DEFS, unknown, '/cargo/units/0/contractId');
    const offerId = must(state.contracts.find((contract) => contract.state === 'offered'), 'ponuka').id;
    const offer = { ...state, cargo: { ...state.cargo, units: state.cargo.units.map((unit, i) => (i === 0 ? { ...unit, contractId: offerId as ContractId } : unit)) } };
    expectStateError(DEFS, offer, '/cargo/units/0/contractId');
    const orphan = { ...state, cargo: { ...state.cargo, units: state.cargo.units.map((unit, i) => (i === 0 ? { ...unit, contractId: null } : unit)) } };
    expectStateError(DEFS, orphan, '/cargo/units/0/contractId');
  }, RUN_TIMEOUT_MS);

  it('počítadlo vyložených nesedí s nákladom na lodi → obnova odmietne; v živom svete krok 12 → WorldInvariantError', () => {
    const world = enRouteWorld();
    const state = viaJson(world.serialize());
    const index = state.contracts.findIndex((contract) => contract.state === 'ship_en_route');
    expectStateError(DEFS, withContract(state, index, { unitsUnloaded: 1 }), '');
    const live = [...world.contracts.values()].find((contract) => contract.state === 'ship_en_route');
    must(live, 'kontrakt na ceste').unitsUnloaded = 2;
    expect(() => world.assertInvariants()).toThrow(WorldInvariantError);
  }, RUN_TIMEOUT_MS);
});

describe('WorldState v5: roundtrip uprostred kontraktu', () => {
  it.each(['accepted', 'ship_en_route', 'unloading', 'exporting'] as const)(
    'uložené v stave %s: obnovený svet dobehne kontrakt rovnako (stav, hotovosť, XP aj udalosti)',
    (target) => {
      const { world, run, contractId } = startContract({ id: `f5_roundtrip_${target}`, seed: 5505, defs: DEFS });
      run.runUntil((w) => contractById(w, contractId).state === target, 40_000);
      const clone = World.deserialize(DEFS, MAP, viaJson(world.serialize()));
      const scenario = portScenario(`f5_roundtrip_${target}`, 5505);
      const events: SimEvent[][] = [[], []];
      const until = world.clock.tick + 12_000;
      runScenario(world, scenario, until, { afterTick: (_w, tickEvents) => events[0].push(...tickEvents) });
      runScenario(clone, scenario, until, { afterTick: (_w, tickEvents) => events[1].push(...tickEvents) });
      expect(contractById(world, contractId).state).toBe('completed');
      expect(JSON.stringify(events[1])).toBe(JSON.stringify(events[0]));
      expect(JSON.stringify(clone.serialize())).toBe(JSON.stringify(world.serialize()));
    },
    RUN_TIMEOUT_MS,
  );
});
