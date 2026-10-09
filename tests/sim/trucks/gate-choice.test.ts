// Výber vstupu pre kamión (R4, ADR-041 bod 2 a 3): pickInPortal (voľné portály, Rng len pri ≥ 2 voľných), pickGate (ETA, plná plocha, nedosiahnuteľný blok), preGateRoom.
import { describe, expect, it } from 'vitest';
import { NO_ACCESS } from '@sim/logistics';
import { isPortalBlocked, pickGate, pickInPortal, preGateInbound, preGateRoom } from '@sim/trucks/gate-choice';
import { GATES_DEFS, PORTAL_IN_1, PORTAL_IN_2, gatesWorld, stageUnit } from '../helpers/r4-gates-layout';

const cellOf = (layout: ReturnType<typeof gatesWorld>, portal: { x: number; y: number }): number => layout.world.grid.index(portal.x, portal.y);
const truckDef = GATES_DEFS.trucks.get('truck_container');

describe('pickInPortal', () => {
  it('dva voľné portály: vyberie jeden z nich podľa trafficShare cez Rng (stav Rng sa posunie); výber je deterministický podľa seedu', () => {
    const a = gatesWorld(11);
    const b = gatesWorld(11);
    const before = JSON.stringify(a.world.rng.getState());
    const picks = Array.from({ length: 400 }, () => pickInPortal(a.world));
    expect(JSON.stringify(a.world.rng.getState())).not.toBe(before);
    const first = cellOf(a, PORTAL_IN_1);
    const second = cellOf(a, PORTAL_IN_2);
    expect(new Set(picks)).toEqual(new Set([first, second]));
    const share = picks.filter((cell) => cell === first).length / picks.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
    expect(Array.from({ length: 400 }, () => pickInPortal(b.world))).toEqual(picks);
  });

  it('jediný voľný portál: vráti ho bez spotreby Rng; obsadený portál (kamión na bunke) sa preskočí; oba obsadené → NO_ACCESS', () => {
    const layout = gatesWorld(12);
    const { world, ramp } = layout;
    stageUnit(world, ramp, 0);
    world.tick();
    expect(world.trucks.size).toBe(1);
    const [spawned] = [...world.trucks.values()];
    const blocked = spawned.cell;
    expect([cellOf(layout, PORTAL_IN_1), cellOf(layout, PORTAL_IN_2)]).toContain(blocked);
    expect(isPortalBlocked(world, blocked)).toBe(true);
    const rngBefore = JSON.stringify(world.rng.getState());
    const other = cellOf(layout, PORTAL_IN_1) === blocked ? cellOf(layout, PORTAL_IN_2) : cellOf(layout, PORTAL_IN_1);
    expect(isPortalBlocked(world, other)).toBe(false);
    expect(pickInPortal(world)).toBe(other);
    expect(JSON.stringify(world.rng.getState())).toBe(rngBefore);
    stageUnit(world, ramp, 1);
    world.tick();
    expect(world.trucks.size).toBe(2);
    expect([cellOf(layout, PORTAL_IN_1), cellOf(layout, PORTAL_IN_2)].every((cell) => isPortalBlocked(world, cell))).toBe(true);
    expect(pickInPortal(world)).toBe(NO_ACCESS);
    expect(JSON.stringify(world.rng.getState())).toBe(rngBefore);
  });
});

describe('pickGate', () => {
  it('portál vedie k svojej ploche: z portálu 1 vyhrá plocha A, z portálu 2 plocha B (nedosiahnuteľný blok sa preskočí)', () => {
    const { world, ramp, buffers } = gatesWorld(13);
    const fromFirst = pickGate(world, ramp, 'pickup', cellOf({ world } as never, PORTAL_IN_1), truckDef);
    const fromSecond = pickGate(world, ramp, 'pickup', cellOf({ world } as never, PORTAL_IN_2), truckDef);
    expect(fromFirst?.buffer).toBe(buffers[0]);
    expect(fromSecond?.buffer).toBe(buffers[1]);
    expect(world.landside.preGateLanes(buffers[0]).map((lane) => lane.id)).toContain(fromFirst?.route.gateId);
    expect(world.landside.preGateLanes(buffers[1]).map((lane) => lane.id)).toContain(fromSecond?.route.gateId);
  });

  it('bez portálu (NO_ACCESS) vyhrá prvá trasa s miestom; plná plocha trasu vyradí: z portálu 1 potom žiadny vstup (blok B je odtiaľ nedosiahnuteľný)', () => {
    const { world, ramp, buffers } = gatesWorld(14);
    const [first] = buffers;
    expect(pickGate(world, ramp, 'pickup', NO_ACCESS, truckDef)?.buffer).toBe(first);
    let fake = 9_000;
    for (let row = 0; row < first.rowCount; row++) for (let slot = 0; slot < first.rowCapacity; slot++) first.admit((fake += 1) as never, row);
    expect(first.freeSlots).toBe(0);
    expect(preGateRoom(world, first)).toBe(0);
    expect(pickGate(world, ramp, 'pickup', cellOf({ world } as never, PORTAL_IN_1), truckDef)).toBeUndefined();
    expect(pickGate(world, ramp, 'pickup', NO_ACCESS, truckDef)?.buffer).toBe(buffers[1]);
    expect(pickGate(world, ramp, 'pickup', cellOf({ world } as never, PORTAL_IN_2), truckDef)?.buffer).toBe(buffers[1]);
  });

  it('miesto plochy zmenšujú kamióny na ceste k nej (to_pre_gate): preGateInbound a preGateRoom', () => {
    const layout = gatesWorld(15);
    const { world, ramp, buffers } = layout;
    for (let i = 0; i < 4; i++) stageUnit(world, ramp, i);
    for (let i = 0; i < 4; i++) world.tick();
    const inbound = buffers.map((buffer) => preGateInbound(world, buffer));
    expect(inbound[0] + inbound[1]).toBe([...world.trucks.values()].filter((truck) => truck.state === 'to_pre_gate').length);
    expect(inbound[0] + inbound[1]).toBeGreaterThan(0);
    buffers.forEach((buffer, i) => expect(preGateRoom(world, buffer)).toBe(buffer.freeSlots - inbound[i]));
  });
});
