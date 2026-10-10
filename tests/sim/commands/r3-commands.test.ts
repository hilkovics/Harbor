// Príkazy hráča R3 (TR3-02, ADR-040 bod 6 a 7): `SetBlockPriority` (priorita RTG bloku) a `SetCraneGang` (pool / gang ťahačov žeriavu) —
// validate / apply / serializácia / save a vplyv na poradie fronty RTG.
import { describe, expect, it } from 'vitest';
import { commandFromJSON, SetBlockPriorityCommand, SetCraneGangCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef } from '@sim/grid';
import { RtgCrane } from '@sim/machines';
import { CraneModule, RtgBlock } from '@sim/modules';
import { sortedQueue } from '@sim/systems/yard-machine-system';
import { stateHash, World } from '@sim/world';
import { hookDefs } from '../helpers/f6a';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

function scenarioWorld(): World {
  const scenario = loadScenarioFile('tt_rtg');
  const world = World.create(hookDefs(0), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
  runScenario(world, scenario, 1);
  return world;
}

const blockOf = (world: World): RtgBlock => [...world.modules.values()].find((module): module is RtgBlock => module instanceof RtgBlock) as RtgBlock;
const cranesOf = (world: World): CraneModule[] => [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule);

describe('SetBlockPriority', () => {
  it('validate: platný blok a druh úlohy → ok bez ceny; neznámy blok → unknown_module; neznámy druh → invalid_priority', () => {
    const world = scenarioWorld();
    const block = blockOf(world);
    expect(new SetBlockPriorityCommand(block.id, 'truck').validate(world)).toMatchObject({ ok: true, reasons: [], costCents: 0 });
    expect(new SetBlockPriorityCommand(9999, 'ship').validate(world).reasons).toEqual(['unknown_module']);
    expect(new SetBlockPriorityCommand(cranesOf(world)[0].id, 'ship').validate(world).reasons).toEqual(['unknown_module']);
    expect(new SetBlockPriorityCommand(block.id, 'cranes').validate(world).reasons).toEqual(['invalid_priority']);
    expect(new SetBlockPriorityCommand(9999, 'cranes').validate(world).reasons).toEqual(['unknown_module', 'invalid_priority']);
  });

  it('apply povýši druh na prvý, ostatné ostanú vo východiskovom poradí; fronta stroja ho rešpektuje', () => {
    const world = scenarioWorld();
    const block = blockOf(world);
    const machine = world.machineOfBlock(block.id) as RtgCrane;
    expect((['ship', 'truck', 'housekeeping'] as const).map((kind) => machine.priorityOf(kind))).toEqual([0, 1, 2]);
    new SetBlockPriorityCommand(block.id, 'housekeeping').apply(world);
    expect(machine.firstPriority).toBe('housekeeping');
    expect((['ship', 'truck', 'housekeeping'] as const).map((kind) => machine.priorityOf(kind))).toEqual([1, 2, 0]);
    expect(sortedQueue(world, machine)).toEqual([]);
  });

  it('apply na neplatný príkaz vyhodí chybu a nič nezmení', () => {
    const world = scenarioWorld();
    const before = stateHash(world);
    expect(() => new SetBlockPriorityCommand(9999, 'ship').apply(world)).toThrow(/validate/);
    expect(stateHash(world)).toBe(before);
  });

  it('serializácia: toJSON → commandFromJSON je ten istý príkaz; nesprávny tvar → chyba', () => {
    const command = new SetBlockPriorityCommand(5, 'truck');
    expect(command.toJSON()).toEqual({ type: 'SetBlockPriority', blockId: 5, order: 'truck' });
    expect(commandFromJSON(command.toJSON())).toEqual(command);
    expect(() => commandFromJSON({ type: 'SetBlockPriority', blockId: 5 })).toThrow();
  });

  it('priorita sa ukladá do save: roundtrip serialize → deserialize dá rovnaký stav', () => {
    const world = scenarioWorld();
    new SetBlockPriorityCommand(blockOf(world).id, 'truck').apply(world);
    const copy = World.deserialize(world.defs, loadMap(parseMapDef(readRepoJson(loadScenarioFile('tt_rtg').map))), JSON.parse(JSON.stringify(world.serialize())));
    expect(copy.machineOfBlock(blockOf(copy).id)?.firstPriority).toBe('truck');
    expect(stateHash(copy)).toBe(stateHash(world));
  });
});

describe('SetCraneGang', () => {
  it('validate: žeriav + pool/gang + počet v mezích defu → ok; iný modul → unknown_module; zlý režim alebo počet → invalid_gang', () => {
    const world = scenarioWorld();
    const crane = cranesOf(world)[0];
    const { minPerSts, maxPerSts } = world.defs.equipment.tractors;
    expect(new SetCraneGangCommand(crane.id, 'gang', 3).validate(world)).toMatchObject({ ok: true, reasons: [], costCents: 0 });
    expect(new SetCraneGangCommand(crane.id, 'pool', minPerSts).validate(world).ok).toBe(true);
    expect(new SetCraneGangCommand(crane.id, 'gang', maxPerSts).validate(world).ok).toBe(true);
    expect(new SetCraneGangCommand(blockOf(world).id, 'gang', 2).validate(world).reasons).toEqual(['unknown_module']);
    expect(new SetCraneGangCommand(crane.id, 'fleet', 2).validate(world).reasons).toEqual(['invalid_gang']);
    expect(new SetCraneGangCommand(crane.id, 'gang', minPerSts - 1).validate(world).reasons).toEqual(['invalid_gang']);
    expect(new SetCraneGangCommand(crane.id, 'gang', maxPerSts + 1).validate(world).reasons).toEqual(['invalid_gang']);
    expect(new SetCraneGangCommand(crane.id, 'gang', 1.5).validate(world).reasons).toEqual(['invalid_gang']);
  });

  it('apply nastaví režim a počet žeriavu; východisko je null (hodnota z equipment.json)', () => {
    const world = scenarioWorld();
    const [first, second] = cranesOf(world);
    expect([first.gangMode, first.tractorsPerSts]).toEqual([null, null]);
    new SetCraneGangCommand(first.id, 'gang', 3).apply(world);
    expect([first.gangMode, first.tractorsPerSts]).toEqual(['gang', 3]);
    expect([second.gangMode, second.tractorsPerSts]).toEqual([null, null]);
  });

  it('serializácia a save: žeriav si režim pamätá po roundtripe', () => {
    const world = scenarioWorld();
    const crane = cranesOf(world)[1];
    const command = new SetCraneGangCommand(crane.id, 'gang', 2);
    expect(command.toJSON()).toEqual({ type: 'SetCraneGang', craneId: crane.id, mode: 'gang', tractorsPerSts: 2 });
    expect(commandFromJSON(command.toJSON())).toEqual(command);
    command.apply(world);
    const copy = World.deserialize(world.defs, loadMap(parseMapDef(readRepoJson(loadScenarioFile('tt_rtg').map))), JSON.parse(JSON.stringify(world.serialize())));
    const restored = copy.modules.get(crane.id as EntityId) as CraneModule;
    expect([restored.gangMode, restored.tractorsPerSts]).toEqual(['gang', 2]);
    expect(stateHash(copy)).toBe(stateHash(world));
  });
});
