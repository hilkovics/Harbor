// Akceptácia fázy R2 (TR2-02; ADR-039): bundled scenáre s plánovačom stohov dobehnú bez porušenia stohov (krok 12 beží po každom ticku), bez straty
// nákladu, bez trvalej zápchy a s `rehandlesPerMove` pod 0,3. Opačný pól (`yardPlanner: "random"` > 1) ukazuje menší scenárový test
// `tests/sim/logistics/yard-contrast.test.ts` — `vertical_slice` drží v sklade naraz málo kontajnerov (import odchádza hneď po vyložení), stohy sú nízke
// (3 vrstvy) a náhodné ukladanie v celom scenári uviazne na rehandlingu bez cieľa, takže tam sa pomer nemeria.
import { describe, expect, it } from 'vitest';
import { yardMetrics } from '@sim/logistics';
import { loadMap, parseMapDef } from '@sim/grid';
import { trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

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
});
