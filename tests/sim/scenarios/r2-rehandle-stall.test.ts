// Rehandling bez trvalého uviaznutia (TR2-06b; ADR-039 dodatok TR2-06b): záťažový scenár `traffic_stress` (16 vozidiel, mapa `stress_f6`) dobehne 45 000 tickov s bundled defmi
// aj s `DEFS` (režim odovzdávania `apron`) bez zaseknutého nosiča, bez zrušeného jobu pre rehandling bez cieľa a bez straty nákladu. Pôvodný nález review: od ticku ~37 900
// stálo vozidlo v `loading` s jobom na import 40′ pod exportom 40′ v plnom bloku (2 voľné bunky len v 20′ stĺpcoch) až do konca behu.
import { describe, expect, it } from 'vitest';
import { yardMetrics } from '@sim/logistics';
import { loadMap, parseMapDef } from '@sim/grid';
import { trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import type { DefRegistry } from '@sim/defs';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenarioAutoAccept } from '../helpers/scenario';
import { BUNDLED_DEFS, DEFS } from '../world/world-fixtures';

const TICKS = 45_000;

/** Nosiče, ktoré stoja `blockedTicks ≥ stuckTicks` na konci behu (rovnako ako `stuckAtEnd` v simrune). */
function stuckAtEnd(world: World): number {
  const { stuckTicks } = world.defs.logistics.traffic;
  let stuck = 0;
  for (const vehicle of world.vehicles.values()) if (vehicle.blockedTicks >= stuckTicks) stuck += 1;
  for (const truck of world.trucks.values()) if (truck.blockedTicks >= stuckTicks) stuck += 1;
  return stuck;
}

/** Najdlhší súvislý pobyt vozidla v `loading` / `rehandling` pri zdroji nesmie presiahnuť pár trpezlivostí (inak uviazlo). */
function runTrafficStress(defs: DefRegistry): { world: World; longestHandling: number } {
  const scenario = loadScenarioFile('traffic_stress');
  const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
  const since = new Map<number, number>();
  let longestHandling = 0;
  runScenarioAutoAccept(world, scenario, TICKS, {
    afterTick: (w) => {
      for (const vehicle of w.vehicles.values()) {
        const handling = vehicle.state === 'loading' || vehicle.state === 'rehandling';
        if (!handling) {
          since.delete(vehicle.id);
          continue;
        }
        const start = since.get(vehicle.id) ?? w.clock.tick;
        since.set(vehicle.id, start);
        longestHandling = Math.max(longestHandling, w.clock.tick - start);
      }
    },
  });
  return { world, longestHandling };
}

describe('traffic_stress: žiadne trvalé uviaznutie rehandlingu', () => {
  it.each([
    ['bundled defy', BUNDLED_DEFS],
    ['DEFS (odovzdávanie apron)', DEFS],
  ])('%s: po 45 000 tickoch stuckAtEnd 0, rehandleStalls 0, nič sa nestratilo, stohy bez porušenia', (_name, defs) => {
    const { world, longestHandling } = runTrafficStress(defs);
    const { rehandleTicks, rehandleGiveUpTicks } = world.defs.logistics;
    expect(stuckAtEnd(world)).toBe(0);
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    expect(yardMetrics(world).rehandleStalls).toBe(0);
    expect(yardMetrics(world).moves).toBeGreaterThan(100); // beh bol skutočne záťažový (výbery zo skladu)
    // Pobyt pri zdroji (loading + rehandling) trvá najviac pár cyklov rehandlingu — nie tisíce tickov ako pri uviaznutí vozidla #24 (jobu 3577).
    expect(longestHandling).toBeLessThan(2 * (rehandleGiveUpTicks + rehandleTicks) + 100);
    assertCargoConservation(world);
    expect(world.assertInvariants()).toBeUndefined();
  }, 240_000);
});
