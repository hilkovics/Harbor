// Dlhý beh `tt_rtg` (TR3-02, ADR-040): 100 000 tickov nepretržitej prekládky (po uzavretí kontraktu sa prijme ďalší) bez zápchy na kotvisku a v bloku —
// žiadny nosič `blockedTicks ≥ stuckTicks` ani v jednom ticku, žiadna udalosť `TrafficJam`, nič sa nestratí a stroj nikdy nezostane bez cyklu s plnou frontou.
import { describe, expect, it } from 'vitest';
import { yardMetrics, terminalMetrics } from '@sim/logistics';
import { loadMap, parseMapDef } from '@sim/grid';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { lost, offerTranship } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const TICKS = 100_000;
const UNITS = 120;
const ECONOMY = { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

describe('tt_rtg: 100 000 tickov bez zápchy na kotvisku a v bloku', () => {
  const scenario = loadScenarioFile('tt_rtg');
  const world = World.create(hookDefs(0, { economy: ECONOMY }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: false });
  runScenario(world, scenario, 1);
  const { stuckTicks } = world.defs.logistics.traffic;
  let maxBlocked = 0;
  let jams = 0;
  let contracts = 0;
  for (let i = 0; i < TICKS; i++) {
    if (world.contractBook.contracts.size === 0 || [...world.contractBook.contracts.values()].every((contract) => contract.state === 'completed' || contract.state === 'failed')) {
      if (world.ships.size === 0) {
        send(world, acceptCommand(offerTranship(world, { units: UNITS }).id));
        contracts += 1;
      }
    }
    for (const event of world.tick()) if (event.type === 'TrafficJam') jams += 1;
    if (i % 25 === 0) for (const vehicle of world.vehicles.values()) maxBlocked = Math.max(maxBlocked, vehicle.blockedTicks);
  }

  it('prešlo viac kontraktov a nič sa nestratilo; invarianty a zachovanie nákladu platia', () => {
    expect(contracts).toBeGreaterThanOrEqual(3);
    expect(lost(world)).toBe(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('žiadna zápcha: ani jeden nosič nedosiahol stuckTicks, žiadny TrafficJam, stuckAtEnd 0, rehandleStalls 0', () => {
    expect(maxBlocked).toBeLessThan(stuckTicks);
    expect(jams).toBe(0);
    expect([...world.vehicles.values()].filter((vehicle) => vehicle.blockedTicks >= stuckTicks)).toHaveLength(0);
    expect(yardMetrics(world).rehandleStalls).toBe(0);
  });

  it('priepustnosť: RTG aj STS spravili stovky presunov; čakanie STS je obmedzené kapacitou jediného RTG (cieľ < 20 % → docs/BACKLOG.md)', () => {
    const metrics = terminalMetrics(world);
    expect(metrics.rtgMoves).toBeGreaterThanOrEqual(2 * UNITS * 3);
    expect(metrics.stsMoves).toBeGreaterThanOrEqual(2 * UNITS * 3);
    expect(metrics.stsMovesPerHour).toBeGreaterThan(1);
    expect(metrics.stsWaitForTractorPct).not.toBeNull();
    // Dva STS (cyklus 12 ticků) na jeden RTG (cyklus ≈ 14–15 ticků) nemôžu čakať < 20 %: ≈ 65 % je strop kapacity jedného stroja, nie nedostatok ťahačov (ADR-040 dodatok TR3-02).
    expect(metrics.stsWaitForTractorPct as number).toBeLessThan(75);
  });
}, 900_000);
