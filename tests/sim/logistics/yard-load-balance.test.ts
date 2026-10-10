// Vyvažovanie vyťaženia strojov RTG v YardPlanneri (TR3-02c, ADR-040 dodatok): skóre bloku s RTG = vzdialenosť + `logistics.yardMachineLoadWeight` × (fronta + cyklus stroja).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef } from '@sim/grid';
import { chooseYardSlot } from '@sim/logistics';
import { BerthModule, RtgBlock } from '@sim/modules';
import { World } from '@sim/world';
import { hookDefs } from '../helpers/f6a';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { newUnit } from './yard-fixtures';

const CREATED = 0;

function twoBlockWorld(): { world: World; berth: BerthModule; blocks: RtgBlock[] } {
  const scenario = loadScenarioFile('tt_rtg_2blocks');
  const world = World.create(hookDefs(0, { economy: { startingCashCents: 400_000_000 } }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
  runScenario(world, scenario, 1);
  const berth = [...world.modules.values()].find((module): module is BerthModule => module instanceof BerthModule) as BerthModule;
  const blocks = [...world.modules.values()].filter((module): module is RtgBlock => module instanceof RtgBlock);
  return { world, berth, blocks };
}

describe('YardPlanner: vyvažovanie vyťaženia RTG', () => {
  it('def: váha je kladná', () => {
    expect(twoBlockWorld().world.defs.logistics.yardMachineLoadWeight).toBeGreaterThan(0);
  });

  it('nečinné stroje: vyhráva bližší blok (správanie bez zmeny)', () => {
    const { world, berth, blocks } = twoBlockWorld();
    expect(blocks).toHaveLength(2);
    const first = chooseYardSlot(world, newUnit(world), berth)?.moduleId;
    expect(blocks.map((block) => block.id)).toContain(first);
    expect(chooseYardSlot(world, newUnit(world), berth)?.moduleId).toBe(first);
  });

  it('fronta bližšieho bloku odkloní jednotku na druhý blok; po vyprázdnení sa vráti; výber je deterministický', () => {
    const { world, berth, blocks } = twoBlockWorld();
    const near = chooseYardSlot(world, newUnit(world), berth)?.moduleId as EntityId;
    const far = blocks.find((block) => block.id !== near) as RtgBlock;
    const machine = world.machineOfBlock(near);
    if (machine === undefined) throw new Error('blok bez stroja');
    for (let i = 0; i < 6; i++) machine.enqueue((900 + i) as EntityId, CREATED);
    expect(chooseYardSlot(world, newUnit(world), berth)?.moduleId).toBe(far.id);
    expect(chooseYardSlot(world, newUnit(world), berth)?.moduleId).toBe(far.id);
    for (let i = 0; i < 6; i++) machine.dequeue((900 + i) as EntityId);
    expect(chooseYardSlot(world, newUnit(world), berth)?.moduleId).toBe(near);
  });
});
