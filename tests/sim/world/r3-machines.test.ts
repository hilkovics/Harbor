// Stroje blokov vo svete (TR3-01, ADR-040): RTG vzniká s blokom, zaniká s ním, ukladá sa v save v10 (aj uprostred cyklu), fronta sa radí podľa priorít z defu
// a RTG robí rehandling sám.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef } from '@sim/grid';
import { yardMetrics } from '@sim/logistics';
import { TransportJob } from '@sim/logistics/transport-job';
import { RtgCrane } from '@sim/machines';
import { ModuleError, RtgBlock } from '@sim/modules';
import { priorityKindOf, sortedQueue } from '@sim/systems/yard-machine-system';
import { stateHash, World, WorldStateError } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { offerTranship, runUntil } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const id = (value: number): EntityId => value as EntityId;
const ECONOMY = { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };
const map = () => loadMap(parseMapDef(readRepoJson(loadScenarioFile('tt_rtg').map)));

function scenarioWorld(defs = hookDefs(0, { economy: ECONOMY })): World {
  const scenario = loadScenarioFile('tt_rtg');
  const world = World.create(defs, map(), scenario.seed);
  runScenario(world, scenario, 1);
  return world;
}

const blockOf = (world: World): RtgBlock => [...world.modules.values()].find((module): module is RtgBlock => module instanceof RtgBlock) as RtgBlock;

describe('RTG blok a jeho stroj', () => {
  it('PlaceModule(rtg_block) vytvorí blok aj stroj (id hneď za blokom), stroj stojí v bayi 0 nad pruhom a je v idle', () => {
    const world = scenarioWorld();
    const block = blockOf(world);
    expect(block.def.id).toBe('rtg_block');
    expect(block.geometry).toEqual({ bays: 12, rows: 6, maxTier: 5 });
    expect(block.laneCol).toBe(4);
    const machine = world.machineOfBlock(block.id) as RtgCrane;
    expect(machine).toBeInstanceOf(RtgCrane);
    expect(machine.id).toBe(block.id + 1);
    expect(machine.state).toBe('idle');
    expect(machine.restPose).toEqual({ gantry: 0, trolley: -1, hoist: 5 });
    expect(machine.def).toBe(world.defs.equipment.rtg);
    expect(world.assertInvariants()).toBeUndefined();
  });

  it('TP: bay vjazdu 0, bay výjazdu 11 (rozstup 1 bay = TP pri každom bayi)', () => {
    const block = blockOf(scenarioWorld());
    expect(block.tpBayOfConnector(0)).toBe(0);
    expect(block.tpBayOfConnector(1)).toBe(11);
    expect([0, 3.4, 11, 20].map((bay) => block.tpBayNear(bay))).toEqual([0, 3, 11, 11]);
  });

  it('RemoveModule odstráni blok aj stroj; stroj s frontou ho nenechá odstrániť (busy)', () => {
    const world = scenarioWorld();
    const block = blockOf(world);
    const machine = world.machineOfBlock(block.id) as RtgCrane;
    machine.enqueue(id(99), 0);
    expect(() => world.removeModule(block.id)).toThrow(ModuleError);
    expect(world.modules.has(block.id)).toBe(true);
    machine.dequeue(id(99));
    world.removeModule(block.id);
    expect(world.machines.size).toBe(0);
    expect(world.modules.has(block.id)).toBe(false);
  });

  it('addMachine odmietne druhý stroj na bloku aj blok, ktorý nie je RTG blok', () => {
    const world = scenarioWorld();
    const block = blockOf(world);
    expect(() => world.addMachine(RtgCrane.create(world.ids.next(), block.id, world.defs.equipment.rtg, 5))).toThrow(/RTG blok bez stroja/);
    expect(() => world.addMachine(RtgCrane.create(world.ids.next(), id(1), world.defs.equipment.rtg, 5))).toThrow(/RTG blok bez stroja/);
  });
});

describe('fronta stroja: priorita (loď > kamión > housekeeping), potom čas vzniku a id', () => {
  const job = (from: 'in_crane' | 'at_ramp' | 'in_storage' | 'on_apron', to: 'in_storage' | 'at_ramp' | 'in_crane', jobId: number): TransportJob =>
    new TransportJob({
      id: id(jobId),
      unitIds: [id(1000 + jobId)],
      from: from === 'in_crane' ? { kind: 'in_crane', craneId: id(2) } : from === 'on_apron' ? { kind: 'on_apron', berthId: id(1), slot: 0 } : from === 'at_ramp' ? { kind: 'at_ramp', rampId: id(8), dock: 0 } : { kind: 'in_storage', moduleId: id(4), slot: 0 },
      to: to === 'in_crane' ? { kind: 'in_crane', craneId: id(2) } : to === 'at_ramp' ? { kind: 'at_ramp', rampId: id(8), dock: 0 } : { kind: 'in_storage', moduleId: id(4), slot: 1 },
      fromModuleId: from === 'in_crane' ? id(1) : undefined,
      toModuleId: to === 'in_crane' ? id(1) : undefined,
      createdTick: 0,
    });

  it('priorityKindOf: hák → ship, rampa → truck, ostatné housekeeping', () => {
    expect(priorityKindOf(job('in_crane', 'in_storage', 1))).toBe('ship');
    expect(priorityKindOf(job('in_storage', 'in_crane', 2))).toBe('ship');
    expect(priorityKindOf(job('at_ramp', 'in_storage', 3))).toBe('truck');
    expect(priorityKindOf(job('in_storage', 'at_ramp', 4))).toBe('truck');
    expect(priorityKindOf(job('on_apron', 'in_storage', 5))).toBe('housekeeping');
  });

  it('poradie obsluhy: priorita z defu, v rámci nej starší vznik, pri zhode menšie id vozidla', () => {
    const machine = RtgCrane.create(id(5), id(4), BUNDLED_DEFS.equipment.rtg, 5);
    const jobs = new Map<EntityId, TransportJob>([
      [id(1), job('on_apron', 'in_storage', 1)],
      [id(2), job('at_ramp', 'in_storage', 2)],
      [id(3), job('in_crane', 'in_storage', 3)],
      [id(4), job('in_crane', 'in_storage', 4)],
      [id(5), job('in_storage', 'in_crane', 5)],
    ]);
    const vehicles = new Map([[10, 1], [11, 2], [12, 3], [13, 4], [14, 5]].map(([vehicleId, jobId]) => [id(vehicleId), { jobId: id(jobId) }] as const));
    machine.enqueue(id(10), 5); // housekeeping
    machine.enqueue(id(11), 6); // kamión
    machine.enqueue(id(13), 9); // loď, neskôr
    machine.enqueue(id(14), 9); // loď, rovnaký tick, väčšie id
    machine.enqueue(id(12), 9); // loď, rovnaký tick, menšie id než 13
    const order = sortedQueue({ jobs, vehicles } as unknown as Pick<World, 'jobs' | 'vehicles'>, machine).map((entry) => entry.vehicleId);
    expect(order).toEqual([12, 13, 14, 11, 10]);
  });
});

describe('save v10: stroj uprostred cyklu sa obnoví a beh pokračuje bit po bite rovnako', () => {
  it('serialize → JSON → deserialize dá rovnaký stav, stroj aj jednotka v in_handler; ďalší beh je zhodný', () => {
    const defs = hookDefs(0, { economy: ECONOMY });
    const world = scenarioWorld(defs);
    const contract = offerTranship(world, { units: 40 });
    send(world, acceptCommand(contract.id));
    const machine = (): RtgCrane => [...world.machines.values()][0] as RtgCrane;
    runUntil(world, () => machine().state === 'trolley' && machine().cycle?.kind === 'put', 60_000, 'RTG v trolley s kontajnerom');
    const held = world.cargo.unitsAt('in_handler', machine().id);
    expect(held).toHaveLength(1);
    const state = JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>;
    expect(state.machines).toHaveLength(1);
    expect(state.machines[0]).toMatchObject({ state: 'trolley', cycle: { kind: 'put' } });
    const copy = World.deserialize(defs, map(), state);
    expect(stateHash(copy)).toBe(stateHash(world));
    expect(copy.cargo.unitsAt('in_handler', machine().id)).toEqual(held);
    expect(findWorldViolation(copy)).toBeUndefined();
    for (let i = 0; i < 4000; i++) {
      world.tick();
      copy.tick();
    }
    expect(stateHash(copy)).toBe(stateHash(world));
    assertCargoConservation(copy);
  });

  it('poškodený stav sa odmietne s cestou: chýbajúci kľúč machines, neznámy blok, stav mimo FSM, cyklus bez vozidla', () => {
    const defs = hookDefs(0, { economy: ECONOMY });
    const world = scenarioWorld(defs);
    world.tick();
    const base = JSON.parse(JSON.stringify(world.serialize())) as Record<string, unknown> & { machines: Record<string, unknown>[] };
    const load = (patch: (state: typeof base) => void): (() => World) => () => {
      const copy = structuredClone(base);
      patch(copy);
      return World.deserialize(defs, map(), copy as never);
    };
    expect(load((s) => delete (s as Record<string, unknown>)['machines'])).toThrow(WorldStateError);
    expect(load((s) => (s.machines[0]['blockId'] = 1))).toThrow(/blockId|RTG blok/);
    expect(load((s) => (s.machines[0]['state'] = 'flying'))).toThrow(/stav musí byť/);
    expect(load((s) => (s.machines[0]['state'] = 'lift'))).toThrow();
    expect(load((s) => (s.machines[0]['defId'] = 'rmg'))).toThrow(/neznámy stroj/);
    expect(load((s) => (s.machines[0]['cycle'] = { kind: 'put', unitId: 1, vehicleId: null, jobId: null, fromSlot: null, toSlot: 1, tpBay: 0 }))).toThrow(/vozidlo aj job/);
    expect(load(() => undefined)()).toBeInstanceOf(World);
  });
});

describe('RTG robí rehandling sám (zavalený kontajner pri nakládke)', () => {
  it('ťahač príde po jednotku pod dvoma kontajnermi: RTG ich najprv preloží (in_storage → in_handler → in_storage), potom ju dá na ťahač; rehandleStalls 0', () => {
    const world = scenarioWorld();
    const block = blockOf(world);
    const berth = world.modules.get(id(1)) as unknown as { id: EntityId };
    const crane = [...world.modules.values()].find((module) => module.kind === 'crane') as unknown as { id: EntityId };
    // Tri kontajnery 20′ v stohu (bay 2, rad 0): vrstvy 0, 1, 2 — jednotka vrstvy 0 je zavalená dvoma.
    const stack = [0, 1, 2].map((tier) => {
      const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: id(900) });
      for (const to of [{ kind: 'in_crane', craneId: crane.id }, { kind: 'in_vehicle', vehicleId: id(901) }, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(2, 0, tier) }] as const) world.cargo.move(unit.id, to);
      return unit.id;
    });
    expect(block.burialDepth(stack[0])).toBe(2);
    world.addJob(
      new TransportJob({
        id: world.ids.next(),
        unitIds: [stack[0]],
        from: { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(2, 0, 0) },
        to: { kind: 'in_crane', craneId: crane.id },
        fromModuleId: block.id,
        toModuleId: berth.id,
        createdTick: world.clock.tick,
      }),
    );
    world.events.flush(); // udalosti prípravy stohu
    const chain: string[] = [];
    for (let i = 0; i < 4000 && world.cargo.get(stack[0])?.location.kind !== 'in_vehicle'; i++) {
      for (const event of world.tick()) if (event.type === 'CargoMoved') chain.push(`${String(event.unitId)}:${event.from.kind}→${event.to.kind}`);
    }
    expect(world.cargo.get(stack[0])?.location.kind).toBe('in_vehicle');
    expect(block.rehandles).toBe(2);
    expect(yardMetrics(world).rehandleStalls).toBe(0);
    // Preložený kontajner z vrchu (vrstva 2) ide ako prvý, každý cez in_handler; potom jednotka jobu stoh → in_handler → ťahač.
    expect(chain.slice(0, 4)).toEqual([`${String(stack[2])}:in_storage→in_handler`, `${String(stack[2])}:in_handler→in_storage`, `${String(stack[1])}:in_storage→in_handler`, `${String(stack[1])}:in_handler→in_storage`]);
    expect(chain.slice(4)).toEqual([`${String(stack[0])}:in_storage→in_handler`, `${String(stack[0])}:in_handler→in_vehicle`]);
    expect(block.burialDepth(stack[1])).toBe(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });
});
