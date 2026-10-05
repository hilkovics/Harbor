// Rehandling (TR2-02; ADR-039 bod 6): vozidlo, ktoré prišlo po zavalený kontajner, najprv preloží kontajnery nad ním v tom istom bloku —
// každý presun `in_storage → in_vehicle → in_storage` cez CargoLedger.move za `logistics.rehandleTicks`. Metriky `rehandles`, `rehandlesPerMove`.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { yardMetrics } from '@sim/logistics';
import { YardBlock } from '@sim/modules';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { DEFS } from '../world/world-fixtures';
import { assertCargoConservation } from '../helpers/invariants';
import { buyVehicle, newUnit, openLoadJob, yardTestWorld } from './yard-fixtures';

const REHANDLE_TICKS = DEFS.logistics.rehandleTicks;

/** Uloží jednotku na bunku `(bay, row, tier)` bloku priamo cez ledger (ako pri obnove save). */
function place(world: World, block: YardBlock, bay: number, row: number, tier: number): EntityId {
  const unit = newUnit(world);
  world.cargo.move(unit.id, { kind: 'in_storage', moduleId: block.id, slot: block.slotOf(bay, row, tier) });
  return unit.id;
}

interface Run {
  readonly world: World;
  readonly block: YardBlock;
  readonly target: EntityId;
  readonly blockers: readonly EntityId[];
  /** Tick, v ktorom cieľová jednotka opustila sklad (`in_storage → in_vehicle`). */
  readonly takenAt: number;
  readonly moves: readonly { readonly tick: number; readonly unitId: EntityId; readonly from: string; readonly to: string }[];
}

/** Dvor W, cieľ v stohu (1, 0) s `blockers` kontajnermi nad ním; jedno vozidlo si ho vezme jobom na apron Root berthu. */
function takeWithBlockers(blockers: number): Run {
  const { world, berth, yards, depotId } = yardTestWorld();
  const block = yards[0];
  const target = place(world, block, 1, 0, 0);
  const above = Array.from({ length: blockers }, (_, i) => place(world, block, 1, 0, i + 1));
  void depotId;
  const depot = [...world.modules.values()].find((module) => module.kind === 'depot');
  if (depot === undefined) throw new Error('chýba depo');
  buyVehicle(world, depot as never);
  openLoadJob(world, berth, target);
  const moves: Run['moves'][number][] = [];
  let takenAt = -1;
  for (let i = 0; i < 4000 && takenAt < 0; i++) {
    const tick = world.clock.tick;
    for (const event of world.tick()) {
      if (event.type !== 'CargoMoved' || (event.from.kind !== 'in_storage' && event.to.kind !== 'in_storage')) continue;
      moves.push({ tick, unitId: event.unitId, from: event.from.kind, to: event.to.kind });
      if (event.unitId === target && event.to.kind === 'in_vehicle') takenAt = tick;
    }
  }
  return { world, block, target, blockers: above, takenAt, moves };
}

describe('rehandling pri výbere zo skladu', () => {
  const free = takeWithBlockers(0);
  const buried = takeWithBlockers(2);

  it('cieľ navrchu: žiadny rehandling, metriky 0', () => {
    expect(free.takenAt).toBeGreaterThan(0);
    expect(yardMetrics(free.world)).toMatchObject({ rehandles: 0, moves: 1, rehandlesPerMove: 0 });
  });

  it('dva kontajnery nad cieľom: dva presuny in_storage → in_vehicle → in_storage, potom cieľ; metriky rehandles 2, rehandlesPerMove 2', () => {
    expect(buried.takenAt).toBeGreaterThan(0);
    const [top, second] = [buried.blockers[1], buried.blockers[0]]; // zhora nadol
    const sequence = buried.moves.filter((move) => move.unitId === top || move.unitId === second).map((move) => `${String(move.unitId)}:${move.from}>${move.to}`);
    expect(sequence).toEqual([
      `${String(top)}:in_storage>in_vehicle`,
      `${String(top)}:in_vehicle>in_storage`,
      `${String(second)}:in_storage>in_vehicle`,
      `${String(second)}:in_vehicle>in_storage`,
    ]);
    expect(yardMetrics(buried.world)).toMatchObject({ rehandles: 2, moves: 1, rehandlesPerMove: 2 });
    expect(buried.block.rehandles).toBe(2);
    // Preložené kontajnery ostali v tom istom bloku, mimo pôvodného stohu; cieľ odišiel s vozidlom.
    for (const unitId of buried.blockers) {
      const location = buried.world.cargo.get(unitId)?.location;
      expect(location?.kind).toBe('in_storage');
      if (location?.kind === 'in_storage') {
        expect(location.moduleId).toBe(buried.block.id);
        expect(buried.block.positionOfSlot(location.slot)).not.toMatchObject({ bay: 1, row: 0 });
      }
    }
    expect(buried.block.stackHeight(1, 0)).toBe(0);
  });

  it('čas: každý presun trvá rehandleTicks — cieľ s dvoma kontajnermi nad sebou sa vyberie o 2 × rehandleTicks neskôr než navrchu ležiaci', () => {
    expect(REHANDLE_TICKS).toBeGreaterThan(0);
    expect(buried.takenAt - free.takenAt).toBe(2 * REHANDLE_TICKS);
  });

  it('po rehandlingu drží krok 12 aj zachovanie nákladu: stohy súvislé, StackGrid = ledger, nič sa nestratilo', () => {
    for (const run of [free, buried]) {
      expect(run.block.findStackProblem()).toBeUndefined();
      expect(findWorldViolation(run.world)).toBeUndefined();
      assertCargoConservation(run.world);
    }
  });

  it('save uprostred rehandlingu: obnovený svet má rovnaký stav a dobehne rovnako', () => {
    const { world, berth, yards } = yardTestWorld();
    const block = yards[0];
    const target = place(world, block, 1, 0, 0);
    place(world, block, 1, 0, 1);
    place(world, block, 1, 0, 2);
    const depot = [...world.modules.values()].find((module) => module.kind === 'depot');
    buyVehicle(world, depot as never);
    openLoadJob(world, berth, target);
    // Beh, kým vozidlo nepreloží prvý kontajner (rehandles 1) — vozidlo je v `loading` a čaká.
    for (let i = 0; i < 4000 && block.rehandles < 1; i++) world.tick();
    expect(block.rehandles).toBe(1);
    const state = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    const restored = World.deserialize(DEFS, world.map, state);
    for (let i = 0; i < 600; i++) {
      world.tick();
      restored.tick();
    }
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(yardMetrics(restored)).toEqual(yardMetrics(world));
    expect(yardMetrics(world).rehandles).toBe(2);
  });
});
