// Zápchy a ich prevencia (TR1-04; ADR-037 bod 8 a dodatok TR1-04, rozhodnutie orchestrátora R1 č. 12):
// - `TrafficJam` raz, keď nosič čaká `stuckTicks` v kuse (bunka, blokujúci nosiči), `TrafficJamCleared` po prvom pohybe;
// - neriešiteľná situácia (vzájomné blokovanie bez obchádzky) sa nahlási pre všetkých, ktorí čakajú, a nezmizne;
// - prevencia: pobyt pri module drží len hlavu (chvost sa uvoľní), takže stojaci nosič neblokuje križovatku ani protismerný pruh.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { slotKey, trafficMetrics } from '@sim/traffic';
import type { World } from '@sim/world';
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
