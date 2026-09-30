// ShipSystem — krok 3 (T02-05, ARCHITECTURE §6, §7.4, ADR-016): celý životný cyklus feedera s prechodmi, polohami
// a udalosťami, anchorage (prvá voľná, koniec seaLane pri plnej), FIFO alokácia podľa spawnu, loď bez kompatibilného
// žeriavu čaká, World.addShip/removeShip a krok 12 (checkInvariants).
import { describe, expect, it } from 'vitest';
import { PlaceModuleCommand, RemoveModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { Ship } from '@sim/ships';
import { WorldInvariantError } from '@sim/world';
import {
  BULKER,
  EAST_BERTH,
  GRAIN,
  ROOT_BERTH_ID,
  applyNow,
  berth,
  newWorld,
  ofType,
  spawn,
  tickN,
  tickUntil,
} from '../ships/ship-fixtures';

/** Dĺžka seaLane harbor_01 (7 + 4 bunky) pri 0,15 bunky/tick: 7 / 0,15 → tick 47 (zvyšok 0,05), 3,95 / 0,15 → +27. */
const LANE_TICKS = 74;

describe('ShipSystem — feeder: spawn → berthing → docked → undocking → outbound → despawned', () => {
  it('prejde FSM s polohami, kotviskami a udalosťami podľa ADR-016', () => {
    const world = newWorld();
    const ship = spawn(world, 'feeder', 2);
    expect(ship).toMatchObject({ state: 'inbound', x: 48.5, y: 0.5, heading: 180, berthIds: [] });
    expect(world.cargo.unitsOnShip(ship.id)).toHaveLength(2);

    // inbound po seaLane; na jej konci pridelenie Root berthu → berthing (rezervácia dockedShipId).
    tickUntil(world, () => ship.state !== 'inbound', 200);
    expect(world.clock.tick).toBe(LANE_TICKS);
    expect(ship).toMatchObject({ state: 'berthing', x: 44.5, y: 7.5, berthIds: [ROOT_BERTH_ID], anchorageIndex: null });
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBe(ship.id);

    // berthing: priama úsečka k (43, 13), kurz na juh; po príchode docked, kurz 90 a ShipDocked.
    world.tick();
    expect(ship.heading).toBe(180);
    const dockEvents = tickUntil(world, () => ship.state === 'docked', 200);
    expect(ship).toMatchObject({ x: 43, y: 13, heading: 90 });
    expect(ofType(dockEvents, 'ShipDocked')).toEqual([{ type: 'ShipDocked', shipId: ship.id, berthIds: [ROOT_BERTH_ID] }]);

    // docked, kým je náklad na palube; tick po poslednom zdvihu žeriavom → undocking, kotvisko voľné, ShipUndocked.
    const undockEvents = tickUntil(world, () => ship.state !== 'docked', 200);
    expect(world.cargo.unitsOnShip(ship.id)).toEqual([]);
    expect(ship).toMatchObject({ state: 'undocking', berthIds: [] });
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBeNull();
    expect(ofType(undockEvents, 'ShipUndocked')).toEqual([{ type: 'ShipUndocked', shipId: ship.id }]);

    // undocking → koniec seaLane → outbound → seaLane[0] → despawned (odstránená, ShipDeparted).
    tickUntil(world, () => ship.state === 'outbound', 200);
    expect(ship).toMatchObject({ x: 44.5, y: 7.5 });
    const departEvents = tickUntil(world, () => !world.ships.has(ship.id), 200);
    expect(ship).toMatchObject({ state: 'despawned', x: 48.5, y: 0.5, heading: 0 });
    expect(ofType(departEvents, 'ShipDeparted')).toEqual([{ type: 'ShipDeparted', shipId: ship.id }]);
    expect(world.ships.size).toBe(0);
    expect(world.cargo.unitsOnApron(ROOT_BERTH_ID)).toHaveLength(2);
  });
});

describe('ShipSystem — anchorage', () => {
  it('lode bez kotviska obsadia anchorage v poradí mapy; keď sú všetky obsadené, piata čaká na konci seaLane', () => {
    const world = newWorld();
    const ships: Ship[] = [0, 1, 2, 3, 4].map(() => spawn(world, 'handy', 1));
    tickN(world, 400);
    expect(ships.map((s) => s.state)).toEqual(Array(5).fill('waiting_anchorage'));
    expect(ships.map((s) => s.anchorageIndex)).toEqual([0, 1, 2, 3, null]);
    expect(ships.map((s) => [s.x, s.y])).toEqual([
      [44.5, 7.5],
      [52.5, 7.5],
      [36.5, 7.5],
      [60.5, 7.5],
      [44.5, 7.5], // koniec seaLane
    ]);
    expect(ships.every((s) => s.berthIds.length === 0)).toBe(true);
  });

  it('druhý berth: prvá čakajúca (najmenšie id) ide kotviť, uvoľnenú anchorage obsadí loď z konca seaLane', () => {
    const world = newWorld();
    const ships: Ship[] = [0, 1, 2, 3, 4].map(() => spawn(world, 'handy', 1));
    tickN(world, 400);
    applyNow(world, new PlaceModuleCommand({ defId: 'berth_standard', x: EAST_BERTH.x, y: EAST_BERTH.y, rotation: 0 }));
    world.tick();
    expect(ships.map((s) => s.state)).toEqual(['berthing', 'waiting_anchorage', 'waiting_anchorage', 'waiting_anchorage', 'waiting_anchorage']);
    expect(ships.map((s) => s.anchorageIndex)).toEqual([null, 1, 2, 3, 0]);
    expect(ships[0].berthIds).toHaveLength(2);
  });
});

describe('ShipSystem — FIFO a kompatibilita', () => {
  it('dva feedre spawnuté naraz: Root dostane menšie id, druhá čaká a kotví v ticku, keď prvá začne odchádzať', () => {
    const world = newWorld();
    const first = spawn(world, 'feeder', 1);
    const second = spawn(world, 'feeder', 1);
    expect(second.id).toBeGreaterThan(first.id);
    tickUntil(world, () => first.state === 'berthing', 200);
    expect(first.berthIds).toEqual([ROOT_BERTH_ID]);
    expect(second.state).toBe('waiting_anchorage');
    expect(second.anchorageIndex).toBe(0);

    tickUntil(world, () => first.state === 'undocking', 400);
    expect(second.state).toBe('berthing');
    expect(second.berthIds).toEqual([ROOT_BERTH_ID]);
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBe(second.id);
  });

  it('loď so sypkým nákladom nekotví pri kontajnerovom žeriave — čaká na anchorage', () => {
    const world = newWorld();
    const bulker = spawn(world, BULKER, 3, GRAIN);
    tickN(world, 300);
    expect(bulker.state).toBe('waiting_anchorage');
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBeNull();
  });

  it('berth rezervovaný loďou v berthing nejde odstrániť (ship_docked)', () => {
    const world = newWorld();
    const east = applyNow(world, new PlaceModuleCommand({ defId: 'berth_standard', x: EAST_BERTH.x, y: EAST_BERTH.y, rotation: 0 }));
    const eastId = ofType(east, 'ModulePlaced')[0].moduleId;
    const handy = spawn(world, 'handy', 1);
    tickUntil(world, () => handy.state === 'berthing', 200);
    expect(new RemoveModuleCommand(eastId).validate(world).reasons).toEqual(['ship_docked']);
  });
});

describe('World.addShip / removeShip', () => {
  function shipWithId(world: ReturnType<typeof newWorld>, id: EntityId, state: Ship['state'] = 'inbound', berthIds: readonly EntityId[] = []): Ship {
    return new Ship({
      id,
      def: world.defs.ships.get('feeder'),
      cargoType: world.defs.cargoTypes.get('container_teu'),
      state,
      x: 44.5,
      y: 7.5,
      heading: 0,
      berthIds,
    });
  }

  it('addShip odmietne duplicitné id, id mimo alokátora a id menšie ako posledná loď (poradie spawnu)', () => {
    const world = newWorld();
    const a = spawn(world, 'feeder', 1); // loď 3, jednotka 4
    spawn(world, 'feeder', 1); // loď 5, jednotka 6
    expect(() => world.addShip(a)).toThrow(/už vo svete je/);
    expect(() => world.addShip(shipWithId(world, 9999 as EntityId))).toThrow(/nepridelil alokátor/);
    expect(() => world.addShip(shipWithId(world, 4 as EntityId))).toThrow(/menšie id ako posledná loď/);
    expect(world.ships.size).toBe(2);
  });

  it('removeShip odmietne neznáme id, loď s nákladom aj loď s kotviskami; prázdnu loď bez kotvísk odstráni', () => {
    const world = newWorld();
    const loaded = spawn(world, 'feeder', 1);
    expect(() => world.removeShip(12345 as EntityId)).toThrow(/neexistuje/);
    expect(() => world.removeShip(loaded.id)).toThrow(/na palube 1 jednotiek/);
    const holding = shipWithId(world, world.ids.next(), 'berthing', [ROOT_BERTH_ID]);
    world.addShip(holding);
    expect(() => world.removeShip(holding.id)).toThrow(/drží kotviská/);
    const empty = shipWithId(world, world.ids.next(), 'outbound');
    world.addShip(empty);
    expect(world.removeShip(empty.id)).toBe(empty);
    expect(world.ships.has(empty.id)).toBe(false);
  });
});

describe('krok 12 — World.checkInvariants', () => {
  it('predvolene zapnutý: nekonzistentný svet vyhodí z tick() WorldInvariantError', () => {
    const world = newWorld();
    expect(world.checkInvariants).toBe(true);
    berth(world, ROOT_BERTH_ID).dockedShipId = 777 as EntityId;
    expect(() => world.tick()).toThrow(WorldInvariantError);
  });

  it('checkInvariants: false (app v produkcii) krok 12 vynechá', () => {
    const world = newWorld({ checkInvariants: false });
    expect(world.checkInvariants).toBe(false);
    berth(world, ROOT_BERTH_ID).dockedShipId = 777 as EntityId;
    expect(() => world.tick()).not.toThrow();
  });
});
