// Bundled scenáre dobehnú bez trvalej zápchy (TR1-04, akceptácia fázy R1 č. 2; ADR-037 dodatok TR1-04): po 30 000 tickoch nie je
// žiadny nosič zaseknutý (`blockedTicks < stuckTicks`), nikde sa nehlásila zápcha, ktorá by trvala do konca behu, nič sa neprekrýva
// a nič sa nestratilo. Scenáre bežia na vlastnej mape (`scenario.map`), s bundled defmi (predvolený režim odovzdávania pod hákom).
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { carrierOverlapProblem, trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const TICKS = 30_000;
const CHECK_EVERY = 100;
const SCENARIOS = [
  'vertical_slice',
  'live_terminal',
  'landside_pressure',
  'multi_ship_queue',
  'full_import_chain',
  'empty_cycle',
  'export_roundtrip',
  'export_inbound',
  'stress_f6',
] as const;

describe('bundled scenáre bez trvalej zápchy', () => {
  it.each(SCENARIOS)('%s: po 30 000 tickoch žiadny zaseknutý nosič, bez prekryvu', (id) => {
    const scenario = loadScenarioFile(id);
    const world = World.create(BUNDLED_DEFS, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    let maxBlocked = 0;
    runScenario(world, scenario, TICKS, {
      afterTick: (w) => {
        maxBlocked = Math.max(maxBlocked, trafficMetrics(w).maxBlockedTicks);
        if (w.clock.tick % CHECK_EVERY === 0) expect(carrierOverlapProblem(w), `tick ${String(w.clock.tick)}`).toBeNull();
      },
    });
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    // aj prechodná zápcha musí byť výrazne kratšia než polovica behu (nikdy nie „skoro do konca“)
    expect(maxBlocked).toBeLessThan(TICKS / 4);
    assertCargoConservation(world);
    expect(world.assertInvariants()).toBeUndefined();
  }, 120_000);
});
