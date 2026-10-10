import { it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { DefRegistry } from '@sim/defs';
import { railMetrics } from '@sim/logistics';
import { trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { lostUnits } from '../helpers/f6a';
import { loadScenarioFile, readRepoJson, runScenarioAutoAccept } from '../helpers/scenario';
import { RAW_DEFS } from '../world/world-fixtures';
const MIX = [{ type: 'reefer', share: 0.2 }, { type: 'open_top', share: 0.15 }, { type: 'flat_rack', share: 0.15 }, { type: 'tank', share: 0.1 }];
function defs() {
  return DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, startingCashCents: 100_000_000_000 }, contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.map((item) => (item.cargoTypeId === 'container_teu' && ['import', 'tranship', 'export'].includes(item.kind) ? { ...item, typeMix: MIX } : item)) } });
}
it('rail seed 5015', () => {
  const scenario = loadScenarioFile('live_terminal_rail');
  const world = World.create(defs(), loadMap(parseMapDef(readRepoJson(scenario.map))), 5015);
  let jams = 0; let load = 0; let unload = 0;
  try {
    runScenarioAutoAccept(world, scenario, 100_000, { afterTick: (w, events) => { for (const e of events) { if (e.type === 'TrafficJam') jams += 1; else if (e.type === 'CargoMoved' && e.to.kind === 'in_train') load += 1; else if (e.type === 'CargoMoved' && e.from.kind === 'in_train') unload += 1; } if (w.clock.tick % 10000 === 0) { const v = findWorldViolation(w); if (v) throw new Error('INV ' + v); } } });
  } catch (e) { console.log('SEED 5015 FAIL tick', world.clock.tick, String(e).slice(0, 300)); throw e; }
  console.log('SEED 5015 OK', JSON.stringify({ jams, jammed: trafficMetrics(world).jammed, lost: lostUnits(world), load, unload, ...railMetrics(world) }));
  throw new Error('show');
}, 600_000);
