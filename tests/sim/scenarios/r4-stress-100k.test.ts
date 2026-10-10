// Dlhý beh pozemnej časti (TR4-02, ADR-041 dodatok): `stress_f6`, `traffic_stress` (pôvodný seed 6014, bez pripnutého seedu) a `live_terminal` bežia 100 000 tickov bez zápchy (`TrafficJam`),
// bez zaseknutého nosiča na konci, bez straty nákladu a s TTT (`World.hinterland`) pre všetky kamióny, ktoré prešli výstupnou bránou. Obsluha na TP, jednosmerné okruhy a odstavné plochy
// sa tak overujú aj proti zvyškovým zápcham z R1 (BACKLOG TR4-01).
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const TICKS = 100_000;
const CHECK_EVERY = 5_000;
const SCENARIOS = ['stress_f6', 'traffic_stress', 'live_terminal'] as const;

describe('100 000 tickov bez zápchy a bez uviaznutia', () => {
  it.each(SCENARIOS)('%s: žiadna udalosť TrafficJam, stuckAtEnd 0, lostUnits 0, TTT zmeraný', (id) => {
    const scenario = loadScenarioFile(id);
    const world = World.create(BUNDLED_DEFS, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    let jams = 0;
    let exitedViaEvent = 0;
    runScenario(world, scenario, TICKS, {
      afterTick: (w, events) => {
        if (w.clock.tick % CHECK_EVERY === 0) expect(findWorldViolation(w), `tick ${String(w.clock.tick)}`).toBeUndefined();
        for (const event of events) {
          if (event.type === 'TrafficJam') jams += 1;
          if (event.type === 'TruckExited') exitedViaEvent += 1;
        }
      },
    });
    expect(jams, 'udalosti TrafficJam').toBe(0);
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    assertCargoConservation(world);
    const { turnTrucks, turnTicksTotal } = world.hinterland;
    expect(turnTrucks).toBeGreaterThan(50);
    // TTT sa uzatvára výstupnou bránou, odchod z mapy (`TruckExited`) nasleduje: rozdiel sú kamióny na ceste k portálu
    expect(turnTrucks).toBeGreaterThanOrEqual(exitedViaEvent);
    expect(turnTrucks - exitedViaEvent).toBeLessThanOrEqual(world.trucks.size);
    expect(turnTicksTotal / turnTrucks).toBeGreaterThan(0);
  }, 300_000);
});
