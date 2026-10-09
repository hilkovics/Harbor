// Obsluha kamiónov na odovzdávacích miestach (TR4-02, ADR-041 bod 4, 6, 7 a 8): fázy pobytu na TP s časmi z defu (bezpečná zóna pred aj po zdvihu, lashing / unlashing), obsluha RTG v pruhu bloku
// a straddle carrierom na hrane bloku, odstavná plocha s volaním k TP (TOS), dual transaction (jeden kamión, dve zastávky, jeden lístok) a TTT. Kamióny vznikajú skutočným krokom 8
// z jednotiek v dvoroch (import) alebo z booking príchodov (export); nič sa neteleportuje (`CargoLedger.move`), v každom kroku platí `assertCargoConservation`.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { YardBlock } from '@sim/modules';
import type { Truck, TpPhase } from '@sim/trucks';
import { World } from '@sim/world';
import { acceptedBooking, exportWorld, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { addRtgBlock, gatesWorld, stageUnits } from '../helpers/r4-gates-layout';
import { buyVehicles, outboundWorld, stockYard } from '../logistics/outbound-fixtures';

/** Súvislý úsek fázy kamióna: názov a počet tickov, počas ktorých trvala. */
interface PhaseRun {
  readonly phase: TpPhase;
  ticks: number;
}

/** Sleduje kamión `truckId` po tickoch a zapíše postupnosť fáz na TP (stav `at_tp` / `at_edge_tp`) vrátane trvania. */
function tracePhases(world: World, truckId: EntityId, runs: PhaseRun[]): void {
  const truck = world.trucks.get(truckId);
  const phase = truck?.phase ?? null;
  if (phase === null || truck === undefined || (truck.state !== 'at_tp' && truck.state !== 'at_edge_tp')) return;
  const last = runs[runs.length - 1];
  if (last?.phase === phase) last.ticks += 1;
  else runs.push({ phase, ticks: 1 });
}

/** Odtikuje svet, kým `done`; strop ticku chráni pred nekonečnou slučkou. */
function tickWhile(world: World, done: () => boolean, limit: number, each: (events: readonly SimEvent[]) => void = () => undefined): void {
  for (let i = 0; i < limit && !done(); i++) {
    each(world.tick());
    assertCargoConservation(world);
  }
  expect(done(), 'podmienka sa do limitu tickov nesplnila').toBe(true);
}

const firstTruck = (world: World): Truck | undefined => [...world.trucks.values()][0];

describe('pickup kamión na TP na hrane bloku (straddle carrier)', () => {
  it('fázy safe_in → handling → safe_out → lash → depart s časmi z defu; jednotka in_storage → in_truck → exported', () => {
    const { world, depot, near } = outboundWorld();
    buyVehicles(world, depot, 2);
    const [unitId] = stockYard(world, near, 1);
    const def = world.defs.trucks.get('truck_container');
    const runs: PhaseRun[] = [];
    const locations: string[] = [];
    let truckId: EntityId | undefined;
    tickWhile(
      world,
      () => world.cargo.exportedCount === 1,
      4000,
      () => {
        const truck = firstTruck(world);
        if (truck !== undefined) {
          truckId = truck.id;
          expect(truck.mission).toBe('pickup');
          tracePhases(world, truck.id, runs);
        }
        const kind = world.cargo.get(unitId)?.location.kind ?? 'exported';
        if (locations[locations.length - 1] !== kind) locations.push(kind);
      },
    );
    expect(truckId).toBeDefined();
    expect(runs.map((run) => run.phase)).toEqual(['safe_in', 'handling', 'safe_out', 'lash', 'depart']);
    const byPhase = Object.fromEntries(runs.map((run) => [run.phase, run.ticks]));
    expect(byPhase['safe_in']).toBe(def.safeZoneTicks);
    expect(byPhase['safe_out']).toBe(def.safeZoneTicks);
    expect(byPhase['lash']).toBe(def.lashTicks);
    expect(byPhase['handling']).toBeGreaterThan(0);
    // `in_storage → … → in_truck → exported` (stroj bloku / straddle carrier jednotku prenesie, kamión ju odvezie z mapy)
    expect(locations[0]).toBe('in_storage');
    expect(locations).toContain('in_truck');
    expect(locations[locations.length - 1]).toBe('exported');
    expect(lostUnits(world)).toBe(0);
  });

  it('TTT: jeden kamión → turnTrucks 1, súčet ticku od vstupnej po výstupnú bránu ≥ súčet fáz na TP', () => {
    const { world, depot, near } = outboundWorld();
    buyVehicles(world, depot, 2);
    stockYard(world, near, 1);
    const def = world.defs.trucks.get('truck_container');
    tickWhile(world, () => world.trucks.size === 0 && world.cargo.exportedCount === 1, 4000);
    expect(world.hinterland.turnTrucks).toBe(1);
    expect(world.hinterland.turnTicksTotal).toBeGreaterThanOrEqual(2 * def.safeZoneTicks + def.lashTicks);
    expect(world.hinterland.turnTicksMax).toBe(world.hinterland.turnTicksTotal);
  });
});

describe('pickup kamión v pruhu RTG bloku', () => {
  it('kamión stojí v pruhu bloku (at_tp), RTG ho obslúži cez in_handler; fázy a časy z defu; blok ostane bez nákladu', () => {
    const layout = gatesWorld(31);
    const block = addRtgBlock(layout);
    const { world } = layout;
    const [unitId] = stockYard(world, block, 1);
    const def = world.defs.trucks.get('truck_container');
    const runs: PhaseRun[] = [];
    const locations: string[] = [];
    const states = new Set<string>();
    tickWhile(
      world,
      () => world.cargo.exportedCount === 1,
      3000,
      () => {
        const truck = firstTruck(world);
        if (truck !== undefined) {
          states.add(truck.state);
          tracePhases(world, truck.id, runs);
        }
        const kind = world.cargo.get(unitId)?.location.kind ?? 'exported';
        if (locations[locations.length - 1] !== kind) locations.push(kind);
      },
    );
    expect(states.has('at_tp')).toBe(true);
    expect(states.has('at_edge_tp')).toBe(false);
    expect(runs.map((run) => run.phase)).toEqual(['safe_in', 'handling', 'safe_out', 'lash', 'depart']);
    expect(runs.find((run) => run.phase === 'safe_in')?.ticks).toBe(def.safeZoneTicks);
    expect(runs.find((run) => run.phase === 'safe_out')?.ticks).toBe(def.safeZoneTicks);
    expect(locations).toEqual(['in_storage', 'in_handler', 'in_truck', 'exported']);
    expect(block).toBeInstanceOf(YardBlock);
    expect(world.cargo.countByKind('in_storage')).toBe(0);
    expect(lostUnits(world)).toBe(0);
  });
});

describe('odstavná plocha: TOS zavolá kamión k TP', () => {
  it('kamióny nad kapacitu TP idú do státí; po uvoľnení TP ich TOS volá v poradí vzniku (holding → to_tp → at_edge_tp) a všetko sa odvezie', () => {
    const layout = gatesWorld(23);
    const { world, holdings } = layout;
    expect(holdings[0].stallCells()).toHaveLength(holdings[0].stalls);
    expect(holdings[0].stalls).toBe(6);
    // všetky jednotky do jedného dvora: ten má jedno TP, ďalšie kamióny dostanú státie
    const yard = layout.yards[0];
    stockYard(world, yard, 4);
    const trace = new Map<number, string[]>();
    const calledAt: number[] = [];
    tickWhile(
      world,
      () => world.cargo.exportedCount === 4,
      6000,
      () => {
        for (const truck of world.trucks.values()) {
          const list = trace.get(truck.id) ?? [];
          if (list[list.length - 1] !== truck.state) {
            list.push(truck.state);
            if (truck.state === 'to_tp' && list[list.length - 2] === 'holding') calledAt.push(world.clock.tick);
          }
          trace.set(truck.id, list);
          // token: kamión drží TP, alebo státie — nikdy oboje, nikdy dvaja to isté TP
          expect(truck.tpCell !== null && truck.holdingId !== null).toBe(false);
        }
        const tps = [...world.trucks.values()].filter((truck) => truck.tpCell !== null).map((truck) => truck.tpCell);
        expect(new Set(tps).size).toBe(tps.length);
      },
    );
    const sequences = [...trace.values()];
    expect(sequences).toHaveLength(4);
    const held = sequences.filter((states) => states.includes('holding'));
    expect(held.length).toBeGreaterThanOrEqual(2);
    for (const states of held) {
      const at = (state: string): number => states.indexOf(state);
      expect(at('to_holding')).toBeGreaterThan(-1);
      expect(at('holding')).toBeGreaterThan(at('to_holding'));
      expect(at('to_tp')).toBeGreaterThan(at('holding'));
      expect(at('at_edge_tp')).toBeGreaterThan(at('to_tp'));
    }
    // volanie je jednotlivo (jedno TP): žiadne dve volania v rovnakom ticku
    expect(new Set(calledAt).size).toBe(calledAt.length);
    expect(lostUnits(world)).toBe(0);
  });

  it('stageUnits dá viac kamiónov než TP: najviac tokenov (12 TP + 60 státí), ostatné jednotky čakajú vo dvoroch', () => {
    const layout = gatesWorld(5);
    stageUnits(layout, 90);
    for (let i = 0; i < 400; i++) layout.world.tick();
    const tokens = [...layout.world.trucks.values()].filter((truck) => truck.bonds.holdsToken).length;
    expect(tokens).toBeLessThanOrEqual(12 + 60);
    expect(layout.world.trucks.size).toBeLessThan(90);
  });
});

describe('delivery kamión na TP (vyloženie) a dual transaction', () => {
  it('delivery: safe_in → unlash → handling → safe_out → depart; jednotka in_truck → in_storage, kamión odíde prázdny (TruckUnloaded bez dual)', () => {
    const world = exportWorld({ yards: ['near'] });
    acceptedBooking(world, { kind: 'export', booked: 1 });
    const def = world.defs.trucks.get('truck_container');
    const runs: PhaseRun[] = [];
    const events: SimEvent[] = [];
    let deliveryId: EntityId | undefined;
    tickWhile(
      world,
      () => events.some((event) => event.type === 'TruckUnloaded'),
      14_000,
      (tick) => {
        events.push(...tick);
        for (const truck of world.trucks.values()) {
          if (truck.mission !== 'delivery') continue;
          deliveryId = truck.id;
          tracePhases(world, truck.id, runs);
        }
      },
    );
    expect(deliveryId).toBeDefined();
    expect(runs.map((run) => run.phase)).toEqual(['safe_in', 'unlash', 'handling', 'safe_out', 'depart']);
    expect(runs.find((run) => run.phase === 'safe_in')?.ticks).toBe(def.safeZoneTicks);
    expect(runs.find((run) => run.phase === 'unlash')?.ticks).toBe(def.unlashTicks);
    expect(runs.find((run) => run.phase === 'safe_out')?.ticks).toBe(def.safeZoneTicks);
    const unloaded = events.find((event) => event.type === 'TruckUnloaded');
    expect(unloaded).toMatchObject({ type: 'TruckUnloaded', truckId: deliveryId, dualTransaction: false });
    expect(world.cargo.countByKind('in_storage')).toBe(1);
  });

  it('dual transaction: delivery kamión pri odchode z TP nájde nenárokovanú jednotku v bloku, stane sa pickup (jeden lístok), odvezie ju a TTT ráta jeden kamión', () => {
    const world = exportWorld({ yards: ['near'] });
    const { near } = { near: world.moduleAt(40, 19) as YardBlock };
    acceptedBooking(world, { kind: 'export', booked: 1 });
    const events: SimEvent[] = [];
    let importUnit: EntityId | undefined;
    // kým delivery kamión drží jediné TP dvora, pribudne import — pickup kamión pre ňu nevznikne (token nie je), jednotka čaká na dual transaction
    tickWhile(
      world,
      () => events.some((event) => event.type === 'TruckExited'),
      16_000,
      (tick) => {
        events.push(...tick);
        const delivery = [...world.trucks.values()].find((truck) => truck.mission === 'delivery' && truck.state === 'at_edge_tp');
        if (delivery !== undefined && importUnit === undefined) [importUnit] = stockYard(world, near, 1);
      },
    );
    expect(importUnit).toBeDefined();
    const unloaded = events.filter((event) => event.type === 'TruckUnloaded');
    expect(unloaded).toHaveLength(1);
    expect(unloaded[0]).toMatchObject({ dualTransaction: true });
    const spawned = events.filter((event) => event.type === 'TruckSpawned');
    expect(spawned).toHaveLength(1); // jeden lístok: pre importovanú jednotku nevznikol druhý kamión
    const exited = events.filter((event) => event.type === 'TruckExited');
    expect(exited).toHaveLength(1);
    expect(exited[0]).toMatchObject({ units: 1 });
    expect(world.cargo.get(importUnit as EntityId)).toBeUndefined(); // exportovaná jednotka už nie je živá
    expect(world.cargo.exportedCount).toBe(1);
    expect(world.hinterland.turnTrucks).toBe(1);
    expect(lostUnits(world)).toBe(0);
  });
});
