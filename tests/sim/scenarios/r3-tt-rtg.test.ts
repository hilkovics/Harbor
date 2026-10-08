// Ťahač + RTG (TR3-01, ADR-040): scenár `tt_rtg` (2 STS, 1 RTG blok, 6 ťahačov) vyloží a naloží 120 TEU prekládky loď A → RTG blok → loď B. Kontajner nikdy neteleportuje:
// vykládka `on_ship → in_crane → in_vehicle → in_handler → in_storage`, nakládka `in_storage → in_handler → in_vehicle → in_crane → on_ship → shipped`.
import { describe, expect, it } from 'vitest';
import { yardMetrics } from '@sim/logistics';
import { loadMap, parseMapDef } from '@sim/grid';
import { RtgBlock } from '@sim/modules';
import { stateHash, World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { lost, offerTranship, runUntil } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const UNITS = 120;
const MAX_TICKS = 120_000;
const ECONOMY = { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

interface Run {
  readonly world: World;
  readonly chains: Map<number, string[]>;
  readonly states: Map<string, number>;
  readonly finishedTick: number;
}

/** Svet zo scenára `tt_rtg` (rozloženie, ťahače) + prijatá prekládka `UNITS` TEU; beh po uzavretie kontraktu. */
function run(seed?: number): Run {
  const scenario = loadScenarioFile('tt_rtg');
  const world = World.create(hookDefs(0, { economy: ECONOMY }), loadMap(parseMapDef(readRepoJson(scenario.map))), seed ?? scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  const contract = offerTranship(world, { units: UNITS });
  expect(send(world, acceptCommand(contract.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
  const chains = new Map<number, string[]>();
  const states = new Map<string, number>();
  const events = runUntil(world, (w) => w.contractBook.contracts.size > 0 && w.ships.size === 0 && [...w.contractBook.contracts.values()].every((c) => c.state === 'completed' || c.state === 'failed'), MAX_TICKS, 'uzavretie prekládky');
  for (const { event } of events) {
    if (event.type !== 'CargoMoved') continue;
    const chain = chains.get(event.unitId) ?? [event.from.kind];
    chain.push(event.to.kind);
    chains.set(event.unitId, chain);
  }
  for (const machine of world.machines.values()) states.set(machine.label, machine.moves);
  return { world, chains, states, finishedTick: world.clock.tick };
}

describe('scenár tt_rtg: STS → ťahač → RTG blok → ťahač → STS', () => {
  const first = run();

  it('rozloženie: 2 STS na kotvisku, 1 RTG blok s jedným strojom, 6 ťahačov bez zdvihu', () => {
    const { world } = first;
    expect([...world.modules.values()].filter((module) => module.kind === 'crane')).toHaveLength(2);
    const blocks = [...world.modules.values()].filter((module): module is RtgBlock => module instanceof RtgBlock);
    expect(blocks).toHaveLength(1);
    expect(world.machines.size).toBe(1);
    expect([...world.machines.values()][0].blockId).toBe(blocks[0].id);
    expect([...world.vehicles.values()].map((vehicle) => vehicle.defId)).toEqual(Array<string>(6).fill('terminal_tractor'));
  });

  it(`vyloží a naloží ${String(UNITS)} TEU: nič sa nestratilo, nič nezostalo, rehandleStalls 0, stuckAtEnd 0`, () => {
    const { world } = first;
    expect(world.cargo.shippedCount).toBe(UNITS);
    expect(world.cargo.exportedCount).toBe(0);
    expect(lost(world)).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    expect(yardMetrics(world).rehandleStalls).toBe(0);
    const { stuckTicks } = world.defs.logistics.traffic;
    expect([...world.vehicles.values()].filter((vehicle) => vehicle.blockedTicks >= stuckTicks)).toHaveLength(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('každá jednotka prejde reťazou cez in_handler: vykládka aj nakládka robí RTG', () => {
    expect(first.chains.size).toBe(UNITS);
    for (const [unitId, chain] of first.chains) {
      const text = chain.join(' → ');
      expect(text, `jednotka ${String(unitId)}`).toBe(
        'on_ship → in_crane → in_vehicle → in_handler → in_storage → in_handler → in_vehicle → in_crane → on_ship → shipped',
      );
    }
  });

  it('RTG spravil aspoň 2 × 120 presunov a je v `idle` bez cyklu a fronty', () => {
    const machine = [...first.world.machines.values()][0];
    expect(machine.moves).toBeGreaterThanOrEqual(2 * UNITS);
    expect(machine.state).toBe('idle');
    expect(machine.cycle).toBeNull();
    expect(machine.queue).toHaveLength(0);
  });

  it('deterministické: rovnaký seed dá rovnaký stav sveta a rovnaký tick dokončenia', () => {
    const again = run();
    expect(again.finishedTick).toBe(first.finishedTick);
    expect(stateHash(again.world)).toBe(stateHash(first.world));
  });
}, 600_000);
