// Zápchy a ich prevencia (TR1-04; ADR-037 bod 8 a dodatok TR1-04, rozhodnutie orchestrátora R1 č. 12):
// - `TrafficJam` raz, keď nosič čaká `stuckTicks` v kuse (bunka, blokujúci nosiči), `TrafficJamCleared` po prvom pohybe;
// - neriešiteľná situácia (vzájomné blokovanie bez obchádzky) sa nahlási pre všetkých, ktorí čakajú, a nezmizne;
// - prevencia: fronta pred bránou nesiaha do križovatky (kamión, ktorý by tam zastal telom v križovatke, do nej nevstúpi);
// - prevencia: pobyt pri module drží len hlavu (chvost sa uvoľní), takže stojaci nosič neblokuje križovatku ani protismerný pruh.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { slotKey, trafficMetrics } from '@sim/traffic';
import type { World } from '@sim/world';
import { gateOf, outboundWorld, rampOf } from '../logistics/outbound-fixtures';
import { DEFS } from '../world/world-fixtures';
import { idx, lay, line, spawn, tickTraffic, trafficBed } from './traffic-fixtures';

const STUCK = DEFS.logistics.traffic.stuckTicks;

function jamEvents(world: World): { jams: SimEvent[]; cleared: SimEvent[] } {
  const events = world.events.flush();
  return { jams: events.filter((event) => event.type === 'TrafficJam'), cleared: events.filter((event) => event.type === 'TrafficJamCleared') };
}

describe('TrafficJam a TrafficJamCleared', () => {
  it('nosič čakajúci za stojacim nosičom: TrafficJam presne raz v ticku stuckTicks (bunka, blokujúci), po uvoľnení TrafficJamCleared', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const blocker = spawn(bed, [[40, 26]], { body: [slotKey(idx(world, [40, 26]), 0), slotKey(idx(world, [40, 26]), 1)] });
    const mover = spawn(bed, line([40, 22], [40, 30]));
    let jams = 0;
    let first = -1;
    for (let tick = 1; tick <= STUCK + 30; tick++) {
      tickTraffic(world);
      const events = jamEvents(world);
      jams += events.jams.length;
      if (events.jams.length > 0 && first < 0) {
        first = tick;
        expect(events.jams[0]).toEqual({
          type: 'TrafficJam',
          carrierId: mover.id,
          carrierKind: 'vehicle',
          cell: { x: 40, y: 25 },
          blockerIds: [blocker.id],
        });
      }
    }
    expect(jams).toBe(1);
    expect(mover.blockedTicks).toBeGreaterThanOrEqual(STUCK);
    expect(trafficMetrics(world)).toMatchObject({ vehiclesBlocked: 1, jammed: 1 });
    expect(trafficMetrics(world).maxBlockedTicks).toBe(mover.blockedTicks);
    // pred stuckTicks sa nič nehlásilo: prvé hlásenie je v ticku, keď blockedTicks dosiahne stuckTicks (po 3 tickoch jazdy k prekážke)
    expect(first).toBeGreaterThanOrEqual(STUCK);

    blocker.releaseSlots();
    tickTraffic(world, 4);
    const after = jamEvents(world);
    expect(after.jams).toEqual([]);
    expect(after.cleared).toEqual([{ type: 'TrafficJamCleared', carrierId: mover.id, carrierKind: 'vehicle' }]);
    expect(mover.blockedTicks).toBe(0);
    expect(trafficMetrics(world).jammed).toBe(0);
  });

  it('krátke čakanie (pod stuckTicks) nehlási zápchu', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const blocker = spawn(bed, [[40, 26]], { body: [slotKey(idx(world, [40, 26]), 0), slotKey(idx(world, [40, 26]), 1)] });
    spawn(bed, line([40, 22], [40, 30]));
    tickTraffic(world, STUCK - 10);
    blocker.releaseSlots();
    tickTraffic(world, 10);
    const events = jamEvents(world);
    expect(events.jams).toEqual([]);
    expect(events.cleared).toEqual([]);
  });

  it('neriešiteľná situácia (vzájomné blokovanie na jednopruhovom úseku bez obchádzky): zápchu hlásia obaja, nezmizne', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 23]), 'one_lane');
    const a = spawn(bed, line([40, 22], [40, 23]), { body: [slotKey(idx(world, [40, 22]), 0)] });
    const b = spawn(bed, line([40, 23], [40, 22]), { body: [slotKey(idx(world, [40, 23]), 0)] });
    let jams = 0;
    for (let tick = 1; tick <= 3 * STUCK; tick++) {
      tickTraffic(world);
      jams += jamEvents(world).jams.length;
    }
    expect(jams).toBe(2);
    expect([a.blockedTicks, b.blockedTicks].every((ticks) => ticks >= STUCK)).toBe(true);
    expect(trafficMetrics(world).jammed).toBe(2);
    expect(jamEvents(world).cleared).toEqual([]);
  });
});

describe('prevencia: fronta pred bránou nesiaha do križovatky', () => {
  /** Svet s bránou: kamión sa spawne z docku s nákladom a ide k bráne (44, 33); križovatka na (44, `junctionY`) cez bočnú cestu (43, `junctionY`). */
  function gateWorld(junctionY: number): World {
    const { world } = outboundWorld({ defs: DEFS, before: [{ type: 'PlaceRoad', cells: [{ x: 43, y: junctionY }] }] });
    const ramp = rampOf(world);
    for (let i = 0; i < 1; i++) {
      const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as never }).id;
      world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as never });
      world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as never, slot: 0 });
      world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as never });
      world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    }
    return world;
  }

  it('brána 1 bunku za križovatkou: kamión čaká pred križovatkou v to_gate (nezastane v nej telom), zápcha sa nahlási', () => {
    const world = gateWorld(34);
    const junction = world.grid.index(44, 34);
    expect(world.cellLanes.isJunction(junction)).toBe(true);
    let jams = 0;
    for (let tick = 0; tick < 600; tick++) {
      for (const event of world.tick()) if (event.type === 'TrafficJam') jams += 1;
      for (const truck of world.trucks.values()) {
        for (const key of [...truck.body, ...truck.ahead]) expect(key >> 1).not.toBe(junction);
        expect(truck.state).toBe('to_gate');
      }
    }
    expect([...world.trucks.values()].map((truck) => truck.blockedTicks >= STUCK)).toEqual([true]);
    expect(jams).toBe(1);
    expect(gateOf(world).queueLength).toBe(0);
  });

  it('brána 3 bunky za križovatkou: telo kamióna vo fronte križovatku neobsadzuje, kamión sa do fronty dostane', () => {
    const world = gateWorld(36);
    const junction = world.grid.index(44, 36);
    expect(world.cellLanes.isJunction(junction)).toBe(true);
    let reachedGate = false;
    let jams = 0;
    for (let tick = 0; tick < 600; tick++) {
      for (const event of world.tick()) if (event.type === 'TrafficJam') jams += 1;
      for (const truck of world.trucks.values()) {
        if (truck.state === 'gate_queue' || truck.state === 'gate_pass') reachedGate = true;
        // telo kamióna čakajúceho pred bránou (tri bunky) zasahuje najviac po bunku pred križovatkou
        if (truck.state === 'gate_queue') for (const key of truck.body) expect(key >> 1).not.toBe(junction);
      }
    }
    expect(reachedGate).toBe(true);
    expect(jams).toBe(0);
  });
});
