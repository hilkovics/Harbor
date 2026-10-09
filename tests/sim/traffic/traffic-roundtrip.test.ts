/**
 * Save počas dopravy (R1, TR1-02; ADR-037, ADR-036 v10): `WorldState` nesie `body`, `ahead`, `blockedTicks` a `rerouteCooldown` nosičov,
 * `LaneSlots` a úseky sa pri obnove prepočítajú z nosičov. Save uprostred dopravy, v ktorej nosiče čakajú na voľný slot, musí
 * dať rovnaké udalosti po tickoch aj rovnaký hash ako nepretržitý beh. Konflikt slotov v save je `WorldStateError`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { loadBundledMap } from '@sim/grid';
import { carrierOverlapProblem } from '@sim/traffic';
import { World, WorldStateError, fnv1a32Hex, stateHash, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario } from '../helpers/scenario';

const DEFS = loadBundledDefs();
const PORT_MAP = loadBundledMap();
const scenario = loadScenarioFile('full_import_chain');
const FOLLOW_TICKS = 600;
const END_TICK = 12_000;

interface Baseline {
  readonly splitTick: number;
  readonly save: string;
  readonly eventPrints: Map<number, string>;
  readonly hashAfter: string;
}

/** Nosiče, ktoré držia sloty, a nosiče, ktoré čakajú na slot. */
function trafficOf(world: World): { holding: number; waiting: number } {
  const carriers = [...world.vehicles.values(), ...world.trucks.values()];
  return { holding: carriers.filter((carrier) => carrier.body.length >= 2).length, waiting: carriers.filter((carrier) => carrier.blockedTicks > 0).length };
}

describe('roundtrip savu uprostred dopravy (full_import_chain)', () => {
  let baseline: Baseline;

  beforeAll(() => {
    const world = World.create(DEFS, PORT_MAP, scenario.seed);
    const eventPrints = new Map<number, string>();
    let splitTick = -1;
    let save = '';
    let hashAfter = '';
    runScenario(world, scenario, END_TICK, {
      afterTick: (w, events) => {
        assertCargoConservation(w);
        expect(carrierOverlapProblem(w)).toBeNull();
        if (splitTick < 0) {
          const { holding, waiting } = trafficOf(w);
          if (holding >= 3 && waiting >= 2) {
            splitTick = w.clock.tick;
            save = JSON.stringify(w.serialize());
          }
          return;
        }
        eventPrints.set(w.clock.tick, fnv1a32Hex(JSON.stringify(events)));
        if (w.clock.tick === splitTick + FOLLOW_TICKS) hashAfter = stateHash(w);
      },
    });
    baseline = { splitTick, save, eventPrints, hashAfter };
  }, 180_000);

  it('stráž pokrytia: save vznikol v ticku, keď aspoň 3 nosiče držia telo a aspoň 2 čakajú na slot', () => {
    expect(baseline.splitTick).toBeGreaterThan(0);
    const state = JSON.parse(baseline.save) as WorldState;
    const carriers = [...state.vehicles, ...state.trucks];
    expect(carriers.filter((carrier) => carrier.body.length >= 2).length).toBeGreaterThanOrEqual(3);
    expect(carriers.filter((carrier) => carrier.blockedTicks > 0).length).toBeGreaterThanOrEqual(2);
    expect(baseline.hashAfter).not.toBe('');
  });

  it('obnovený svet má prepočítané sloty a pokračuje s rovnakými udalosťami po tickoch aj rovnakým hashom', () => {
    const world = World.deserialize(DEFS, PORT_MAP, JSON.parse(baseline.save) as WorldState);
    expect(carrierOverlapProblem(world)).toBeNull();
    let firstMismatch: number | null = null;
    runScenario(world, scenario, baseline.splitTick + FOLLOW_TICKS, {
      afterTick: (w, events) => {
        assertCargoConservation(w);
        if (firstMismatch === null && fnv1a32Hex(JSON.stringify(events)) !== baseline.eventPrints.get(w.clock.tick)) firstMismatch = w.clock.tick;
      },
    });
    expect(firstMismatch).toBeNull();
    expect(stateHash(world)).toBe(baseline.hashAfter);
  });

  it('save, v ktorom dva nosiče držia ten istý slot, sa nenačíta (WorldStateError)', () => {
    const state = JSON.parse(baseline.save) as { vehicles: { body: [number, number][] }[] } & WorldState;
    const holders = state.vehicles.filter((vehicle) => vehicle.body.length > 0);
    expect(holders.length).toBeGreaterThanOrEqual(2);
    (holders[1].body as [number, number][])[0] = [...holders[0].body[0]] as [number, number];
    let error: unknown;
    try {
      World.deserialize(DEFS, PORT_MAP, state);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).message).toMatch(/body/);
  });
});
