// Dlhý beh so železničným terminálom (TR6-02, ADR-043): `live_terminal_rail` = `live_terminal_mix` (STS, straddle, brány, reefer blok, OOG plocha, zmes typov) + `rmg_rail_block` v parcele
// `rail_yard`, koľaj od portálu (95, 24) a cestný prístup k terminálu. 100 000 tickov: 0 TrafficJam, stuckAtEnd 0, lostUnits 0; vlaky naozaj jazdia, nakladajú import a vykladajú export.
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { DefRegistry } from '@sim/defs';
import { railMetrics } from '@sim/logistics';
import { RmgCrane } from '@sim/machines';
import { trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenarioAutoAccept } from '../helpers/scenario';
import { RAW_DEFS } from '../world/world-fixtures';

const TICKS = 100_000;
const CHECK_EVERY = 5_000;
const MIX = [
  { type: 'reefer', share: 0.2 },
  { type: 'open_top', share: 0.15 },
  { type: 'flat_rack', share: 0.15 },
  { type: 'tank', share: 0.1 },
];

function mixedDefs(): DefRegistry {
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    economy: { ...RAW_DEFS.economy, startingCashCents: 100_000_000_000 },
    contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.map((item) => (item.cargoTypeId === 'container_teu' && ['import', 'tranship', 'export'].includes(item.kind) ? { ...item, typeMix: MIX } : item)) },
  });
}

describe('100 000 tickov so železničným terminálom', () => {
  it('live_terminal_rail: žiadna udalosť TrafficJam, stuckAtEnd 0, lostUnits 0; vlaky naložili import a vyložili export', () => {
    const scenario = loadScenarioFile('live_terminal_rail');
    const world = World.create(mixedDefs(), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    let jams = 0;
    let loadedOnTrain = 0;
    let unloadedFromTrain = 0;
    runScenarioAutoAccept(world, scenario, TICKS, {
      afterTick: (w, events) => {
        if (w.clock.tick % CHECK_EVERY === 0) expect(findWorldViolation(w), `tick ${String(w.clock.tick)}`).toBeUndefined();
        for (const event of events) {
          if (event.type === 'TrafficJam') jams += 1;
          else if (event.type === 'CargoMoved' && event.to.kind === 'in_train') loadedOnTrain += 1;
          else if (event.type === 'CargoMoved' && event.from.kind === 'in_train') unloadedFromTrain += 1;
        }
      },
    });
    const metrics = railMetrics(world);
    console.log(`live_terminal_rail: vlaky ${String(metrics.trainsDeparted)}, import vlakom ${String(metrics.importUnitsByTrain)}/${String(metrics.importUnitsExported)}, obrat ${String(metrics.trainTurnaroundMin)} min`);
    expect(jams, 'udalosti TrafficJam').toBe(0);
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    expect(lostUnits(world)).toBe(0);
    assertCargoConservation(world);
    expect([...world.machines.values()].some((machine) => machine instanceof RmgCrane && machine.moves > 0)).toBe(true);
    expect(metrics.trainsDeparted).toBeGreaterThan(10);
    expect(loadedOnTrain, 'jednotky naložené na vlak').toBeGreaterThan(0);
    expect(unloadedFromTrain, 'jednotky vyložené z vlaka').toBeGreaterThan(0);
  }, 900_000);
});
