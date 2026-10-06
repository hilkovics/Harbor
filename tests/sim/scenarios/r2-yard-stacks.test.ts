// Akceptácia fázy R2 (TR2-02; ADR-039): bundled scenáre s plánovačom stohov dobehnú bez porušenia stohov (krok 12 beží po každom ticku), bez straty
// nákladu, bez trvalej zápchy a s `rehandlesPerMove` pod 0,3. Opačný pól (`yardPlanner: "random"` > 1) ukazuje menší scenárový test
// `tests/sim/logistics/yard-contrast.test.ts` na vysokom bloku. Na `vertical_slice` sa pomer „random > 1“ nedosiahne (ADR-039 dodatok TR2-06b): import odchádza hneď po
// vyložení, stohy sú nízke (3 vrstvy) a dispatcher radšej počká, kým kontajnery nad cieľom odídu samy (`blockedByLeavingUnit`), než by ich prekladal. Po oprave
// uviaznutia rehandlingu (TR2-06b) však náhodné ukladanie na `vertical_slice` dobehne (predtým uviazlo) a rehandluje, kým plánovač nikdy.
import { describe, expect, it } from 'vitest';
import { yardMetrics } from '@sim/logistics';
import { loadMap, parseMapDef } from '@sim/grid';
import { trafficMetrics } from '@sim/traffic';
import { DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario, runScenarioAutoAccept } from '../helpers/scenario';
import { BUNDLED_DEFS, RAW_DEFS } from '../world/world-fixtures';

const TICKS = 30_000;
const MAX_REHANDLES_PER_MOVE = 0.3;
const SCENARIOS = ['vertical_slice', 'live_terminal', 'empty_cycle', 'export_inbound', 'landside_pressure', 'stress_f6'] as const;

describe('scenáre so stohmi (R2)', () => {
  it('predvolený plánovač je "planned"', () => {
    expect(BUNDLED_DEFS.logistics.yardPlanner).toBe('planned');
  });

  it.each(SCENARIOS)('%s: stohy bez porušenia, nič sa nestratilo, bez zápchy, rehandlesPerMove < 0,3', (id) => {
    const scenario = loadScenarioFile(id);
    const world = World.create(BUNDLED_DEFS, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    runScenario(world, scenario, TICKS);
    const metrics = yardMetrics(world);
    expect(metrics.rehandlesPerMove ?? 0).toBeLessThan(MAX_REHANDLES_PER_MOVE);
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    assertCargoConservation(world);
    expect(world.assertInvariants()).toBeUndefined();
  }, 120_000);

  it('yardPlanner "random": vertical_slice dobehne (po oprave uviaznutia TR2-06b) so stratou 0, bez zápchy a stallu; rehandluje (plánovač 0), no pomer ostáva pod 1', () => {
    const run = (yardPlanner: 'planned' | 'random'): World => {
      const defs = DefRegistry.fromRaw({ ...RAW_DEFS, logistics: { ...RAW_DEFS.logistics, yardPlanner } } as never);
      const scenario = loadScenarioFile('vertical_slice');
      const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
      runScenarioAutoAccept(world, scenario, TICKS);
      return world;
    };
    const [planned, random] = [run('planned'), run('random')];
    expect(random.cargo.exportedCount).toBe(planned.cargo.exportedCount);
    for (const world of [planned, random]) {
      expect(yardMetrics(world).rehandleStalls).toBe(0);
      expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
      assertCargoConservation(world);
      expect(world.assertInvariants()).toBeUndefined();
    }
    expect(yardMetrics(planned).rehandlesPerMove ?? 0).toBe(0);
    const ratio = yardMetrics(random).rehandlesPerMove ?? 0;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  }, 120_000);
});
