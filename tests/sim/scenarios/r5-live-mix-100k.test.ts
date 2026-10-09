// Dlhý beh so zmesou typov (TR5-02, ADR-042): 100 000 tickov bez zápchy (`TrafficJam`), bez uviaznutého nosiča na konci a bez straty nákladu.
// - `live_terminal` (straddle dvory, brány, kamióny) so zmesou typov v šablónach (reefer, open top, flat rack, tank): prístav nemá reefer blok ani OOG plochu, takže sa losujú len typy bez napájania
//   a bez nadrozmeru (flat rack len navrch, tank 20′); OOG a reefery bez príslušných blokov sa nelosujú (Rng sa nespotrebuje).
// - `oog_flow` (STS, RTG blok, OOG plocha s reach stackerom, 10 ťahačov) s trvalým prúdom prekládok so zmesou typov vrátane OOG: reach stacker pracuje celý beh.
import { describe, expect, it } from 'vitest';
import { loadMap, parseMapDef } from '@sim/grid';
import { DefRegistry } from '@sim/defs';
import { ReachStacker } from '@sim/machines';
import { trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, lostUnits, send } from '../helpers/f6a';
import { lost, offerTranship } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario, runScenarioAutoAccept } from '../helpers/scenario';
import { RAW_DEFS } from '../world/world-fixtures';

const TICKS = 100_000;
const CHECK_EVERY = 5_000;
const ACCEPT_EVERY = 500;
/** Zmes prekládky oog_flow: 0–3 open top (OOG), 4–5 flat rack (OOG), 6 flat rack, 7–8 tank, 9–11 dry. */
const TYPES = ['open_top', 'open_top', 'open_top', 'open_top', 'flat_rack', 'flat_rack', 'flat_rack', 'tank', 'tank', 'dry', 'dry', 'dry'];
const OOG_UNITS = [0, 1, 2, 3, 4, 5];
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

describe('100 000 tickov so zmesou typov a OOG', () => {
  it('live_terminal: žiadna udalosť TrafficJam, stuckAtEnd 0, lostUnits 0 a typy zmesi sa naozaj vyskytli', () => {
    const scenario = loadScenarioFile('live_terminal');
    const world = World.create(mixedDefs(), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    let jams = 0;
    runScenarioAutoAccept(world, scenario, TICKS, {
      afterTick: (w, events) => {
        if (w.clock.tick % CHECK_EVERY === 0) expect(findWorldViolation(w), `tick ${String(w.clock.tick)}`).toBeUndefined();
        for (const event of events) if (event.type === 'TrafficJam') jams += 1;
      },
    });
    expect(jams, 'udalosti TrafficJam').toBe(0);
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    expect(lostUnits(world)).toBe(0);
    assertCargoConservation(world);
    const types = new Set([...world.contractBook.contracts.values()].flatMap((contract) => contract.unitTypes));
    expect(types.has('flat_rack') || types.has('open_top') || types.has('tank')).toBe(true);
    expect(types.has('reefer')).toBe(false);
    expect([...world.contractBook.contracts.values()].every((contract) => contract.oogUnits.length === 0)).toBe(true);
  }, 900_000);

  it('oog_flow: prúd prekládok so zmesou typov a OOG — reach stacker pracuje, bez zápchy, uviaznutia a straty', () => {
    const scenario = loadScenarioFile('oog_flow');
    const world = World.create(hookDefs(0, { economy: { startingCashCents: 100_000_000_000, transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] } }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    runScenario(world, scenario, 1);
    let jams = 0;
    let accepted = 0;
    for (let i = 0; i < TICKS; i++) {
      // Nová prekládka (zmes typov a OOG podľa počítadla, bez Rng), keď žiadna neprebieha.
      if (world.clock.tick % ACCEPT_EVERY === 0 && [...world.contractBook.contracts.values()].every((contract) => contract.state === 'completed' || contract.state === 'failed')) {
        const offer = offerTranship(world, { units: TYPES.length, unitTypes: TYPES, oogUnits: OOG_UNITS });
        if (send(world, acceptCommand(offer.id)).some((event) => event.type === 'ContractAccepted')) accepted += 1;
      }
      for (const event of world.tick()) if (event.type === 'TrafficJam') jams += 1;
      if (world.clock.tick % CHECK_EVERY === 0) {
        expect(findWorldViolation(world), `tick ${String(world.clock.tick)}`).toBeUndefined();
        assertCargoConservation(world);
      }
    }
    expect(jams, 'udalosti TrafficJam').toBe(0);
    expect(trafficMetrics(world).jammed, 'zaseknuté nosiče na konci').toBe(0);
    expect(lost(world)).toBe(0);
    expect(accepted).toBeGreaterThan(2);
    const stacker = [...world.machines.values()].find((machine) => machine instanceof ReachStacker);
    expect(stacker?.moves ?? 0).toBeGreaterThanOrEqual(2 * OOG_UNITS.length * (accepted - 1));
  }, 900_000);
});
