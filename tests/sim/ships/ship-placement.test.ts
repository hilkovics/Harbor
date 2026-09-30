// Loď v páse vody blokuje stavbu kotviska (T02-05, ADR-016; docs/tasks/phase-02.md rozhodnutie 4): obdĺžnik lode
// v stave berthing/docked/undocking, ktorý zasahuje do pásu frontWaterCells nového kotviska → `water_blocked`.
// Lode na plavbe (inbound, waiting_anchorage, outbound) stavbu neblokujú.
import { describe, expect, it } from 'vitest';
import { PlaceModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { Rotation } from '@sim/grid';
import { Ship, type ShipState } from '@sim/ships';
import { findPlacementViolations } from '@sim/world';
import { GAP_BERTH, ROOT_BERTH_ID, SHIP_DEFS, TEU, newWorld } from './ship-fixtures';

/** Berth na (30,14) rot 0 má pás vody x 30–37, y 11–13. */
const place = new PlaceModuleCommand({ defId: 'berth_standard', x: GAP_BERTH.x, y: GAP_BERTH.y, rotation: 0 });

function worldWithShip(state: ShipState, x: number, y: number, heading: Rotation = 90): ReturnType<typeof newWorld> {
  const world = newWorld();
  const berthIds: readonly EntityId[] = state === 'berthing' || state === 'docked' ? [ROOT_BERTH_ID] : [];
  const anchorageIndex = state === 'waiting_anchorage' ? 2 : null;
  world.addShip(
    new Ship({ id: world.ids.next(), def: SHIP_DEFS.ships.get('feeder'), cargoType: SHIP_DEFS.cargoTypes.get(TEU), state, x, y, heading, berthIds, anchorageIndex }),
  );
  return world;
}

describe('water_blocked — loď v páse vody nového kotviska', () => {
  it('bez lode sa berth (30,14) dá postaviť', () => {
    expect(place.validate(newWorld()).reasons).toEqual([]);
  });

  it.each<ShipState>(['berthing', 'docked', 'undocking'])('loď v stave %s s obdĺžnikom x 32–37, y 11–13 → water_blocked', (state) => {
    const world = worldWithShip(state, 35, 12.5);
    expect(place.validate(world).reasons).toEqual(['water_blocked']);
    const violation = findPlacementViolations(world, SHIP_DEFS.modules.get('berth_standard'), { x: 30, y: 14, rotation: 0 }).find((v) => v.rule === 'water_blocked');
    expect(violation?.detail).toMatch(/zaberá loď feeder #\d+ \(/);
  });

  it.each<ShipState>(['inbound', 'waiting_anchorage', 'outbound'])('loď v stave %s na tom istom mieste stavbu neblokuje', (state) => {
    expect(place.validate(worldWithShip(state, 35, 12.5)).reasons).toEqual([]);
  });

  it('loď mimo pásu (y ≤ 10) ani loď tesne vedľa pásu (x ≥ 38) neblokuje', () => {
    expect(place.validate(worldWithShip('undocking', 35, 9)).reasons).toEqual([]); // y 8–9
    expect(place.validate(worldWithShip('undocking', 41, 12.5)).reasons).toEqual([]); // x 38–43
  });

  it('kurz 0/180 otočí obdĺžnik: loď pozdĺž y s x 37–38 zasiahne pás na x 37', () => {
    expect(place.validate(worldWithShip('undocking', 38, 10, 0)).reasons).toEqual(['water_blocked']); // x 37–38, y 7–12
  });
});
