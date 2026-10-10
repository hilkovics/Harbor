// Empty handler v dispatcheri (T6C-02, ADR-034 bod 4): job prázdneho kontajnera dostane prednostne vozidlo s `cargoDirections` obsahujúcim
// `empty` (aj keď je bežné vozidlo bližšie alebo má nižšie id), inak bežné vozidlo; empty handler nikdy nedostane job iného smeru.
import { describe, expect, it } from 'vitest';
import type { World } from '@sim/world';
import { acceptedImport, emptyWorld, eventsOf, f6cDefs, run, runUntil } from '../helpers/f6c';

const STRADDLE = 'straddle_carrier';
const HANDLER = 'empty_handler';

/** Id vozidla podľa defu (prvé v poradí nákupu). */
function vehicleOfDef(world: World, defId: string): number {
  for (const vehicle of world.vehicles.values()) if (vehicle.def.id === defId) return vehicle.id;
  throw new Error(`svet nemá vozidlo ${defId}`);
}

describe('empty handler — prednosť pri jobe prázdneho', () => {
  it('prázdny z vnútrozemia odvezie do depa empty handler, hoci straddle carrier má nižšie id aj rovnakú vzdialenosť', () => {
    const world = emptyWorld({ vehicles: [STRADDLE, HANDLER] });
    expect(vehicleOfDef(world, STRADDLE)).toBeLessThan(vehicleOfDef(world, HANDLER));
    world.emptyFlow.scheduleReturn(world.clock.tick + 5, 'blue_anchor');
    const events = runUntil(world, (w) => w.emptyFlow.returnPlan.length === 0 && [...w.cargo.liveUnits()].some((unit) => unit.location.kind === 'in_storage'), 3_000, 'prázdny v depe');
    const assigned = eventsOf(events, 'JobAssigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0].vehicleId).toBe(vehicleOfDef(world, HANDLER));
  });

  it('bez empty handlera ho prevezme bežné vozidlo', () => {
    const plain = emptyWorld({ vehicles: [STRADDLE, STRADDLE] });
    plain.emptyFlow.scheduleReturn(plain.clock.tick + 5, 'blue_anchor');
    const events = runUntil(plain, (w) => [...w.cargo.liveUnits()].some((unit) => unit.location.kind === 'in_storage'), 3_000, 'prázdny uložený bežným vozidlom');
    expect(eventsOf(events, 'JobAssigned')).toHaveLength(1);

    // R4: depo má jediný TP na hrane, takže naraz obsluhuje jeden kamión — súbežné joby prázdnych (a teda obsadený empty handler) nevznikajú.
  });

  it('job importu empty handler nikdy nedostane: počas importu bez prázdnych ostane nečinný (všetky joby vezme straddle carrier)', () => {
    const defs = f6cDefs({ emptyFlow: { emptyReturnRate: 0 }, economy: { arrivalDaysRange: [0.5, 0.5] } });
    const world = emptyWorld({ defs, vehicles: [HANDLER, STRADDLE] });
    acceptedImport(world, 'blue_anchor', 4);
    const events = runUntil(world, (w) => w.cargo.exportedCount === 4, 40_000, 'import odvezený');
    events.push(...run(world, 5));
    const handler = vehicleOfDef(world, HANDLER);
    const assigned = eventsOf(events, 'JobAssigned');
    expect(assigned.length).toBeGreaterThanOrEqual(8);
    expect(assigned.some((event) => event.vehicleId === handler)).toBe(false);
  }, 120_000);
});
