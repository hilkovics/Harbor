// Rehandling bez cieľa (TR2-06b; ADR-039 dodatok TR2-06b): vozidlo, ktoré pri zdroji nenájde cieľ pre kontajnery nad jednotkou, čaká trpezlivosť
// (`rehandleGiveUpTicks` zaokrúhlené na cykly `rehandleTicks`), potom job zruší (`picking → cancelled`, `rehandle_stalled`) a uvoľní sa (`rehandling → idle`).
// Nič sa neteleportuje: jednotky ostávajú v sklade na svojich slotoch; metrika `rehandleStalls`.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { yardMetrics } from '@sim/logistics';
import type { YardBlock } from '@sim/modules';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { DefRegistry } from '@sim/defs';
import { RAW_DEFS } from '../world/world-fixtures';
import { assertCargoConservation } from '../helpers/invariants';
import { YARD_W, buyVehicle } from './dispatch-fixtures';
import { newUnit, openLoadJob, yardTestWorld } from './yard-fixtures';

// Bez rezervy buniek pri zakladaní jobu (`rehandleSpareCells` 0): testy potrebujú job pre jednotku, pre ktorú je miesto na rehandling práve na hrane.
const DEFS = DefRegistry.fromRaw({ ...RAW_DEFS, logistics: { ...RAW_DEFS.logistics, rehandleSpareCells: 0 } });
const { rehandleTicks, rehandleGiveUpTicks } = DEFS.logistics;
const PATIENCE = Math.ceil(rehandleGiveUpTicks / rehandleTicks) * rehandleTicks;
const FULL_ROW = [3, 3, 3, 3] as const;

function place(world: World, block: YardBlock, bay: number, row: number, tier: number): EntityId {
  const unit = newUnit(world);
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, tier) });
  return unit.id;
}

/** Zaplní stohy po výšku `heights[row][bay]` (stoh s výškou 0 preskočí). */
function fill(world: World, block: YardBlock, heights: readonly (readonly number[])[]): void {
  heights.forEach((rowHeights, row) => rowHeights.forEach((height, bay) => {
    for (let tier = 0; tier < height; tier++) place(world, block, bay, row, tier);
  }));
}

interface Stall {
  readonly world: World;
  readonly block: YardBlock;
  readonly vehicleId: EntityId;
  readonly target: EntityId;
  readonly blocker: EntityId;
  readonly berthApronReserved: () => number;
  readonly jobId: EntityId;
}

/**
 * Dvor W so stohom (1, 0): cieľ + 1 blokátor; voľná je len jedna vrstva v stohu (3, 0) — pre blokátor práve jedno miesto. Rad 1–3 plný.
 * Vozidlo si cieľ vezme jobom na apron Root berthu.
 */
function stallWorld(): Stall {
  const { world, berth, yards, depotId } = yardTestWorld(DEFS, 3050, [YARD_W]);
  const block = yards[0];
  const target = place(world, block, 1, 0, 0);
  const blocker = place(world, block, 1, 0, 1);
  fill(world, block, [[3, 0, 3, 2], FULL_ROW, FULL_ROW, FULL_ROW]);
  const vehicleId = buyVehicle(world, world.modules.get(depotId) as never);
  const job = openLoadJob(world, berth, target);
  return { world, block, vehicleId, target, blocker, berthApronReserved: () => berth.apron.reservedCount, jobId: job.id };
}

/** Tickuje, kým `until` nevráti pravdu (najviac `limit` tickov); vráti udalosti ticku, v ktorom skončil, a jeho číslo. */
function tickUntil(world: World, until: (events: readonly SimEvent[]) => boolean, limit = 6000): { events: readonly SimEvent[]; tick: number } {
  for (let i = 0; i < limit; i++) {
    const tick = world.clock.tick;
    const events = world.tick();
    if (until(events)) return { events, tick };
  }
  throw new Error('podmienka sa do limitu nesplnila');
}

const isRehandlingEntry = (events: readonly SimEvent[]): boolean => events.some((event) => event.type === 'VehicleStateChanged' && event.to === 'rehandling');
const cancelled = (events: readonly SimEvent[]): readonly SimEvent[] => events.filter((event) => event.type === 'JobCancelled');

describe('rehandling bez cieľa: trpezlivosť a uvoľnenie vozidla', () => {
  it('trpezlivosť je rehandleGiveUpTicks zaokrúhlené na celé cykly rehandleTicks; defy to dovoľujú', () => {
    expect(PATIENCE).toBeGreaterThanOrEqual(rehandleGiveUpTicks);
    expect(PATIENCE % rehandleTicks).toBe(0);
    expect(rehandleGiveUpTicks).toBeLessThan(DEFS.logistics.traffic.stuckTicks);
  });

  it('miesto zmizne počas čakania: po vyčerpaní trpezlivosti sa job zruší, vozidlo je idle, jednotky ostanú na svojich slotoch, rehandleStalls 1', () => {
    const { world, block, vehicleId, target, blocker, berthApronReserved, jobId } = stallWorld();
    const slots = [target, blocker].map((unitId) => (world.cargo.get(unitId)?.location as { slot: number }).slot);
    const entered = tickUntil(world, isRehandlingEntry);
    expect(world.vehicles.get(vehicleId)?.state).toBe('rehandling');
    expect(world.vehicles.get(vehicleId)?.waitTicks).toBe(PATIENCE);
    expect(world.jobs.get(jobId)?.state).toBe('picking');
    expect(berthApronReserved()).toBe(1);
    // Iný príchod zaplní jedinú voľnú vrstvu: pre blokátor nie je kam a trpezlivosť sa míňa.
    place(world, block, 3, 0, 2);
    const moved: SimEvent[] = [];
    const end = tickUntil(world, (events) => {
      moved.push(...events.filter((event) => event.type === 'CargoMoved' && (event.unitId === target || event.unitId === blocker)));
      return cancelled(events).length > 0;
    });
    expect(end.tick - entered.tick).toBe(PATIENCE);
    expect(cancelled(end.events)).toEqual([{ type: 'JobCancelled', jobId, reason: 'rehandle_stalled' }]);
    expect(end.events).toContainEqual({ type: 'VehicleStateChanged', vehicleId, from: 'rehandling', to: 'idle' });
    const vehicle = world.vehicles.get(vehicleId);
    expect([vehicle?.state, vehicle?.jobId]).toEqual(['idle', null]);
    expect(world.jobs.size).toBe(0);
    expect(berthApronReserved()).toBe(0); // rezervácia apronu sa uvoľnila
    // Nič sa neteleportovalo ani nepreložilo: ani jeden presun cieľa či blokátora a jednotky stoja na pôvodných slotoch.
    expect(moved).toEqual([]);
    expect([target, blocker].map((unitId) => (world.cargo.get(unitId)?.location as { slot: number }).slot)).toEqual(slots);
    expect([block.rehandles, block.rehandleStalls]).toEqual([0, 1]);
    expect(yardMetrics(world)).toMatchObject({ rehandles: 0, rehandleStalls: 1 });
    expect(findWorldViolation(world)).toBeUndefined();
    assertCargoConservation(world);
  });

  it('pri príchode bez miesta: kontrola unitPickable job zruší hneď (loading → rehandling → idle v jednom ticku), bez čakania', () => {
    const { world, block, vehicleId, jobId } = stallWorld();
    tickUntil(world, (events) => events.some((event) => event.type === 'JobAssigned'));
    place(world, block, 3, 0, 2); // miesto zaniklo po pridelení jobu, ešte pred príchodom vozidla
    const { events } = tickUntil(world, (tickEvents) => cancelled(tickEvents).length > 0);
    expect(cancelled(events)).toEqual([{ type: 'JobCancelled', jobId, reason: 'rehandle_stalled' }]);
    const states = events.filter((event) => event.type === 'VehicleStateChanged').map((event) => (event.type === 'VehicleStateChanged' ? `${event.from}>${event.to}` : ''));
    expect(states).toEqual(['loading>rehandling', 'rehandling>idle']);
    expect(world.vehicles.get(vehicleId)?.state).toBe('idle');
    expect(block.rehandleStalls).toBe(1);
    expect(findWorldViolation(world)).toBeUndefined();
    assertCargoConservation(world);
  });

  it('bez miesta od začiatku dispatcher vozidlo vôbec nepridelí (gating unitPickable): job ostáva open, nič sa nezruší', () => {
    const { world, block, jobId } = stallWorld();
    place(world, block, 3, 0, 2);
    for (let i = 0; i < 300; i++) world.tick();
    expect(world.jobs.get(jobId)?.state).toBe('open');
    expect(block.rehandleStalls).toBe(0);
  });

  it('save uprostred čakania v rehandling: obnovený svet zruší job v tom istom ticku a skončí v rovnakom stave', () => {
    const { world, block } = stallWorld();
    tickUntil(world, isRehandlingEntry);
    place(world, block, 3, 0, 2);
    for (let i = 0; i < PATIENCE / 2 + 5; i++) world.tick(); // trpezlivosť je napoly vyčerpaná, v strede cyklu
    const state = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    const restored = World.deserialize(DEFS, world.map, state);
    expect(findWorldViolation(restored)).toBeUndefined();
    const both: [string[], string[]] = [[], []];
    for (let i = 0; i < PATIENCE; i++) {
      both[0].push(...cancelled(world.tick()).map(() => String(world.clock.tick)));
      both[1].push(...cancelled(restored.tick()).map(() => String(restored.clock.tick)));
    }
    expect(both[0]).toHaveLength(1);
    expect(both[1]).toEqual(both[0]);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(yardMetrics(restored)).toEqual(yardMetrics(world));
  });
});
