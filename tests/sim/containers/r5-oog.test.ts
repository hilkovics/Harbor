// OOG (TR5-02, ADR-042): `drawOogUnits` (Rng len keď je OOG plocha), reach stacker (pose, boom), OOG v kontrakte (save) a save v14 sveta s reach stackerom.
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/core';
import { ExportContract, drawOogUnits } from '@sim/contracts';
import { loadMap, parseMapDef } from '@sim/grid';
import { LANE_ROW, REACH_STACKER_DEF_ID, ReachStacker } from '@sim/machines';
import { stateHash, World } from '@sim/world';
import { DefRegistry } from '@sim/defs';
import { DEFS } from '../helpers/f5';
import { RAW_DEFS } from '../world/world-fixtures';
import { hookDefs } from '../helpers/f6a';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const TYPES = DEFS.containerTypes;

describe('drawOogUnits', () => {
  it('bez OOG plochy: prázdne pole a Rng sa nespotrebuje', () => {
    const rng = new Rng(3);
    const before = rng.getState();
    expect(drawOogUnits(rng, ['open_top', 'flat_rack'], TYPES, false)).toEqual([]);
    expect(rng.getState()).toEqual(before);
  });

  it('s OOG plochou: jedno číslo Rng len na jednotku typu s oogChance > 0 (dry, reefer a tank nie), indexy vzostupne', () => {
    const rng = new Rng(11);
    const ref = new Rng(11);
    const types = ['dry', 'open_top', 'reefer', 'flat_rack', 'tank', 'flat_rack'];
    const result = drawOogUnits(rng, types, TYPES, true);
    for (let i = 0; i < 3; i++) ref.next();
    expect(rng.getState()).toEqual(ref.getState());
    expect(result.every((index) => ['open_top', 'flat_rack'].includes(types[index]))).toBe(true);
    expect([...result].sort((a, b) => a - b)).toEqual([...result]);
  });

  it('rovnaký seed dá rovnaký výsledok; zo 400 flat rackov (oogChance 0,8) je OOG približne 80 %', () => {
    const types = Array<string>(400).fill('flat_rack');
    const a = drawOogUnits(new Rng(5), types, TYPES, true);
    expect(drawOogUnits(new Rng(5), types, TYPES, true)).toEqual(a);
    expect(a.length).toBeGreaterThan(280);
    expect(a.length).toBeLessThan(360);
  });
});

describe('Contract.oogUnits', () => {
  it('unitIsOog podľa indexov; zlý index sa odmietne', () => {
    const terms = { id: 1, voyageId: 1, templateId: 't', cargoTypeId: 'container_teu', volumeUnits: 4, slaDays: 3, rewardCents: 1, xpReward: 1, offeredTick: 0, offerExpiresTick: 10, shipClassId: 'feeder', lineId: 'blue_anchor', destinationPort: 'Hamburg' } as never;
    const contract = new ExportContract({ ...(terms as object), unitTypes: ['dry', 'open_top', 'flat_rack', 'dry'], oogUnits: [1, 2] } as never);
    expect([0, 1, 2, 3].map((index) => contract.unitIsOog(index))).toEqual([false, true, true, false]);
    expect(contract.toState().oogUnits).toEqual([1, 2]);
    expect(() => new ExportContract({ ...(terms as object), oogUnits: [4] } as never)).toThrow();
  });
});

describe('ReachStacker', () => {
  const def = DEFS.equipment.reachStacker;

  it('defId, časy z equipment.reachStacker, výložník 0…1 podľa polohy vozíka', () => {
    const rs = ReachStacker.create(7 as never, 3 as never, def, 1);
    expect(rs.defId).toBe(REACH_STACKER_DEF_ID);
    expect(rs.gantryTicks(3)).toBe(Math.ceil(3 / def.gantryCellsPerTick));
    expect(rs.trolleyTicks(2)).toBe(2 * def.trolleyTicksPerRow);
    expect(rs.boom(3)).toBe(0);
    expect(rs.aislePos()).toBe(0);
    rs.transition('travel');
    rs.enterPhase('shift', 4, { gantry: 2, trolley: 2, hoist: 1 });
    expect(rs.boom(3)).toBe(0);
    for (let i = 0; i < 4; i++) rs.advancePhase();
    expect(rs.aislePos()).toBe(2);
    expect(rs.boom(3)).toBeCloseTo((2 - LANE_ROW) / 3);
    expect(rs.toState().defId).toBe('reach_stacker');
  });
});

describe('save v14 so strojom reach stacker', () => {
  it('uprostred prekládky OOG: stroj sa obnoví ako ReachStacker a beh pokračuje rovnako', () => {
    const scenario = loadScenarioFile('oog_flow');
    const map = loadMap(parseMapDef(readRepoJson(scenario.map)));
    const world = World.create(hookDefs(0), map, scenario.seed);
    runScenario(world, scenario, 1);
    const state = JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>;
    const restored = World.deserialize(world.defs, map, state);
    expect(stateHash(restored)).toBe(stateHash(world));
    expect([...restored.machines.values()].filter((machine) => machine instanceof ReachStacker)).toHaveLength(1);
  });
});

describe('ponuky kontraktov a OOG plocha', () => {
  const MIX = [{ type: 'flat_rack', share: 0.9 }];
  const defs = DefRegistry.fromRaw({
    ...RAW_DEFS,
    contract_templates: { ...RAW_DEFS.contract_templates, items: RAW_DEFS.contract_templates.items.map((item) => (item.kind === 'import' && item.cargoTypeId === 'container_teu' ? { ...item, typeMix: MIX } : item)) },
  });

  function offers(scenarioId: string): { readonly types: number; readonly oog: number } {
    const scenario = loadScenarioFile(scenarioId);
    const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    runScenario(world, scenario, 1);
    for (let i = 0; i < 2 * 86_400 / world.defs.time.tickGameSeconds; i++) world.tick();
    const contracts = [...world.contractBook.contracts.values()];
    return { types: contracts.filter((contract) => contract.unitTypes.includes('flat_rack')).length, oog: contracts.filter((contract) => contract.oogUnits.length > 0).length };
  }

  it('s OOG plochou ponuky nesú OOG jednotky; bez nej sa OOG nelosuje (typy ostávajú)', () => {
    const withArea = offers('oog_flow');
    expect(withArea.types).toBeGreaterThan(0);
    expect(withArea.oog).toBeGreaterThan(0);
    const without = offers('reefer_flow');
    expect(without.types).toBeGreaterThan(0);
    expect(without.oog).toBe(0);
  });
});
