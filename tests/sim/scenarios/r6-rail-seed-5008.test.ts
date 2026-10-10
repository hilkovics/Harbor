// Regresia TR6-02c: `live_terminal_rail` so seedom 5008 padal v ticku 13 956 (`rmg: prechod trolley → trolley`) — výška nosenia závisí od živých stohov, po fáze `trolley`
// ešte zostala dráha spúšťača. FSM má teraz explicitný opätovný vstup `trolley → trolley`; beh cez pôvodný tick pád nesmie spôsobiť a invariant nákladu platí.
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenarioAutoAccept } from '../helpers/scenario';
import { RAW_DEFS } from '../world/world-fixtures';

const MIX = [
  { type: 'reefer', share: 0.2 },
  { type: 'open_top', share: 0.15 },
  { type: 'flat_rack', share: 0.15 },
  { type: 'tank', share: 0.1 },
];

describe('live_terminal_rail seed 5008', () => {
  it('prejde tick 13 956 bez MachineError', () => {
    const defs = DefRegistry.fromRaw({
      ...RAW_DEFS,
      economy: { ...RAW_DEFS.economy, startingCashCents: 100_000_000_000 },
      contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.map((item) => (item.cargoTypeId === 'container_teu' && ['import', 'tranship', 'export'].includes(item.kind) ? { ...item, typeMix: MIX } : item)) },
    });
    const scenario = loadScenarioFile('live_terminal_rail');
    const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), 5008);
    runScenarioAutoAccept(world, scenario, 14_200);
    expect(world.clock.tick).toBeGreaterThanOrEqual(14_200);
    assertCargoConservation(world);
  }, 300_000);
});
