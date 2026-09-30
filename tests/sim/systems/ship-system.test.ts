// ShipSystem — krok 3 (T02-05, ARCHITECTURE §6, §7.4, ADR-016, ADR-029): celý životný cyklus feedera s prechodmi,
// polohami a udalosťami (kotvisko rezervované pri vstupe, príplava cez bod priblíženia, kotvisko uvoľnené na konci
// dráhy), anchorage (pridelená pred vstupom, bez nej čakanie pred mapou), FIFO alokácia podľa spawnu, loď bez
// kompatibilného žeriavu čaká, World.addShip/removeShip a krok 12 (checkInvariants). Podrobné správanie dopravy na
// mape s kanálom je v tests/sim/ships/ship-traffic.test.ts.
import { describe, expect, it } from 'vitest';
import { PlaceModuleCommand, RemoveModuleCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { Ship, ShipError, type ShipErrorCode } from '@sim/ships';
import { WorldInvariantError } from '@sim/world';
import {
  BULKER,
  CRANE,
  DEEP_BERTH,
  DEEP_SHIP,
  DEEP_ZONE_BERTH,
  EAST_BERTH,
  GAP_BERTH,
  GRAIN,
  ROOT_BERTH_ID,
  applyNow,
  berth,
  newWorld,
  ofType,
  placeModule,
  spawn,
  tickN,
  tickUntil,
} from '../ships/ship-fixtures';

/** Dĺžka seaLane harbor_01 (7 + 4 bunky) pri 0,15 bunky/tick: 7 / 0,15 → tick 47 (zvyšok 0,05), 3,95 / 0,15 → +27. */
const LANE_TICKS = 74;

describe('ShipSystem — feeder: spawn → inbound → berthing → docked → undocking → outbound → despawned', () => {
  it('prejde FSM s polohami, kotviskami a udalosťami podľa ADR-016 a ADR-029', () => {
    const world = newWorld();
    const ship = spawn(world, 'feeder', 2);
    // Voľný Root: loď vpláva hneď pri spawne a kotvisko má rezervované od vstupu (trasa = sea lane + úsek ku kotvisku).
    expect(ship).toMatchObject({ state: 'inbound', x: 48.5, y: 0.5, heading: 180, berthIds: [ROOT_BERTH_ID], anchorageIndex: null });
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBe(ship.id);
    expect(ship.route.slice(0, 3)).toEqual([
      { x: 48.5, y: 0.5 },
      { x: 48.5, y: 7.5 },
      { x: 44.5, y: 7.5 },
    ]);
    // Úsek ku kotvisku končí bodom priblíženia (43, 10) a posunom bokom do (43, 13) s kurzom 90.
    expect(ship.route.slice(-2)).toEqual([
      { x: 43, y: 10, heading: 90 },
      { x: 43, y: 13, heading: 90 },
    ]);
    expect(world.cargo.unitsOnShip(ship.id)).toHaveLength(2);

    // inbound po seaLane; na jej konci → berthing s úsekom z rezervácie.
    tickUntil(world, () => ship.state !== 'inbound', 200);
    expect(world.clock.tick).toBe(LANE_TICKS);
    expect(ship).toMatchObject({ state: 'berthing', x: 44.5, y: 7.5, berthIds: [ROOT_BERTH_ID], anchorageIndex: null, waypointIndex: 0 });

    // berthing: po príchode docked presne v (43, 13), kurz 90 a ShipDocked.
    const dockEvents = tickUntil(world, () => ship.state === 'docked', 200);
    expect(ship).toMatchObject({ x: 43, y: 13, heading: 90 });
    expect(ofType(dockEvents, 'ShipDocked')).toEqual([{ type: 'ShipDocked', shipId: ship.id, berthIds: [ROOT_BERTH_ID] }]);

    // docked, kým je náklad na palube; potom undocking (trasa von je voľná) a ShipUndocked — kotvisko drží ďalej.
    const undockEvents = tickUntil(world, () => ship.state !== 'docked', 200);
    expect(world.cargo.unitsOnShip(ship.id)).toEqual([]);
    expect(ship).toMatchObject({ state: 'undocking', berthIds: [ROOT_BERTH_ID] });
    expect(ship.route[0]).toEqual({ x: 43, y: 10, heading: 90 });
    expect(ofType(undockEvents, 'ShipUndocked')).toEqual([{ type: 'ShipUndocked', shipId: ship.id }]);

    // undocking → koniec seaLane (kotvisko sa uvoľní) → outbound → seaLane[0] → despawned (ShipDeparted).
    tickUntil(world, () => ship.state === 'outbound', 200);
    expect(ship).toMatchObject({ x: 44.5, y: 7.5, berthIds: [] });
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBeNull();
    const departEvents = tickUntil(world, () => !world.ships.has(ship.id), 200);
    expect(ship).toMatchObject({ state: 'despawned', x: 48.5, y: 0.5, heading: 0 });
    expect(ofType(departEvents, 'ShipDeparted')).toEqual([{ type: 'ShipDeparted', shipId: ship.id }]);
    expect(world.ships.size).toBe(0);
    expect(world.cargo.unitsOnApron(ROOT_BERTH_ID)).toHaveLength(2);
  });
});

/** Stred bunky anchorage `index` mapy sveta. */
function anchorageCenter(world: ReturnType<typeof newWorld>, index: number): [number, number] {
  const cell = world.map.anchorage[index];
  return [cell.x + 0.5, cell.y + 0.5];
}

describe('ShipSystem — anchorage (ADR-029: pridelená pred vstupom, bez nej čakanie pred mapou)', () => {
  const WAIT_TICKS = 1500;

  it('handy bez kotviska: čakajúce stoja každá na inej anchorage (v jej strede), ostatné čakajú pred vstupom mimo mapy', () => {
    const world = newWorld();
    const count = world.map.anchorage.length + 1;
    const ships: Ship[] = Array.from({ length: count }, () => spawn(world, 'handy', 1));
    tickN(world, WAIT_TICKS);
    const waiting = ships.filter((s) => s.state === 'waiting_anchorage');
    expect(waiting.length).toBeGreaterThan(0);
    expect(ships.every((s) => s.state === 'waiting_anchorage' || s.state === 'arriving')).toBe(true);
    // FIFO vstupu: čakajúce na anchorage majú menšie id než lode pred vstupom.
    expect(ships.slice(0, waiting.length)).toEqual(waiting);
    const indices = waiting.map((s) => s.anchorageIndex);
    expect(new Set(indices).size).toBe(waiting.length);
    for (const s of waiting) expect([s.x, s.y]).toEqual(anchorageCenter(world, s.anchorageIndex ?? -1));
    for (const s of ships.slice(waiting.length)) expect(s).toMatchObject({ state: 'arriving', anchorageIndex: null, x: 48.5, y: 0.5 });
    expect(ships.every((s) => s.berthIds.length === 0)).toBe(true);
  });

  it('druhý berth: prvá čakajúca (najmenšie id) ide kotviť, ostatné sa nepohnú; po jej odchode kotví ďalšia v poradí id', () => {
    const world = newWorld();
    const count = world.map.anchorage.length + 1;
    const ships: Ship[] = Array.from({ length: count }, () => spawn(world, 'handy', 1));
    tickN(world, WAIT_TICKS);
    const [first, second] = ships;
    expect(first.state).toBe('waiting_anchorage');
    const before = ships.map((s) => [s.state, s.anchorageIndex]);
    const placed = applyNow(world, new PlaceModuleCommand({ defId: 'berth_standard', x: EAST_BERTH.x, y: EAST_BERTH.y, rotation: 0 }));
    const eastId = ofType(placed, 'ModulePlaced')[0].moduleId;
    world.tick();
    expect(first).toMatchObject({ state: 'berthing', anchorageIndex: null, berthIds: [ROOT_BERTH_ID, eastId] });
    expect(ships.slice(1).map((s) => [s.state, s.anchorageIndex])).toEqual(before.slice(1));

    tickUntil(world, () => !world.ships.has(first.id), 2000);
    tickUntil(world, () => second.berthIds.length > 0, 1500);
    expect(second.berthIds).toEqual([ROOT_BERTH_ID, eastId]);
    expect(ships.slice(2).every((s) => s.berthIds.length === 0)).toBe(true);
  });
});

describe('ShipSystem — FIFO a kompatibilita', () => {
  it('dva feedre spawnuté naraz: Root dostane menšie id; druhá čaká pred vstupom, kým prvá drží dráhu, a Root dostane až po jeho uvoľnení', () => {
    const world = newWorld();
    const first = spawn(world, 'feeder', 1);
    const second = spawn(world, 'feeder', 1);
    expect(second.id).toBeGreaterThan(first.id);
    expect(first.berthIds).toEqual([ROOT_BERTH_ID]);
    tickUntil(world, () => first.state === 'berthing', 200);
    expect(second.state).toBe('arriving');

    tickUntil(world, () => second.berthIds.length > 0, 1500);
    expect(second.berthIds).toEqual([ROOT_BERTH_ID]);
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBe(second.id);
    // Kotvisko sa uvoľní až na konci dráhy (koniec undocking) → prvá je už na ceste von alebo preč.
    expect(world.ships.has(first.id) ? first.state : 'despawned').toMatch(/^(outbound|despawned)$/);
    tickUntil(world, () => second.state === 'docked', 800);
  });

  it('loď so sypkým nákladom nekotví pri kontajnerovom žeriave — čaká na anchorage alebo pred vstupom', () => {
    const world = newWorld();
    const bulker = spawn(world, BULKER, 3, GRAIN);
    tickN(world, 300);
    expect(['waiting_anchorage', 'arriving']).toContain(bulker.state);
    expect(bulker.berthIds).toEqual([]);
    expect(berth(world, ROOT_BERTH_ID).dockedShipId).toBeNull();
  });

  it('hlboká loď (draftClass 2) zakotví na hlbokom kotvisku skupiny s plytkým susedom a vyloží sa (T02-14)', () => {
    const world = newWorld();
    const deep = placeModule(world, DEEP_BERTH, DEEP_ZONE_BERTH);
    placeModule(world, 'berth_standard', GAP_BERTH);
    const deepCrane = placeModule(world, CRANE, { x: 25, y: 14 });
    const ship = spawn(world, DEEP_SHIP, 2);
    tickUntil(world, () => ship.state === 'docked', 400);
    expect(ship.berthIds).toEqual([deep]);
    expect([ship.x, ship.y, ship.heading]).toEqual([25, 13, 90]);
    const events = tickUntil(world, () => !world.ships.has(ship.id), 1000);
    expect(ofType(events, 'CraneCycleDone').map((event) => event.craneId)).toEqual([deepCrane, deepCrane]);
    expect(world.cargo.unitsOnApron(deep)).toHaveLength(2);
    expect(berth(world, ROOT_BERTH_ID).apron.usedCount).toBe(0);
  });

  it('berth rezervovaný loďou (od vstupu do prístavu) nejde odstrániť (ship_docked)', () => {
    const world = newWorld();
    const east = applyNow(world, new PlaceModuleCommand({ defId: 'berth_standard', x: EAST_BERTH.x, y: EAST_BERTH.y, rotation: 0 }));
    const eastId = ofType(east, 'ModulePlaced')[0].moduleId;
    const handy = spawn(world, 'handy', 1);
    expect(handy).toMatchObject({ state: 'inbound', berthIds: [ROOT_BERTH_ID, eastId] });
    expect(new RemoveModuleCommand(eastId).validate(world).reasons).toEqual(['ship_docked']);
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

  /** Kód `ShipError`, ktorú akcia vyhodí (T02-14: `addShip`/`removeShip` hádžu `ShipError`, nie holý `Error`). */
  function shipErrorCode(action: () => unknown): ShipErrorCode | undefined {
    try {
      action();
    } catch (error) {
      if (error instanceof ShipError) return error.code;
      throw error;
    }
    return undefined;
  }

  it('addShip odmietne duplicitné id, id mimo alokátora a id menšie ako posledná loď (poradie spawnu)', () => {
    const world = newWorld();
    const a = spawn(world, 'feeder', 1); // loď 3, jednotka 4
    spawn(world, 'feeder', 1); // loď 5, jednotka 6
    expect(() => world.addShip(a)).toThrow(/už vo svete je/);
    expect(() => world.addShip(shipWithId(world, 9999 as EntityId))).toThrow(/nepridelil alokátor/);
    expect(() => world.addShip(shipWithId(world, 4 as EntityId))).toThrow(/menšie id ako posledná loď/);
    expect(shipErrorCode(() => world.addShip(a))).toBe('duplicate_id');
    expect(shipErrorCode(() => world.addShip(shipWithId(world, ROOT_BERTH_ID)))).toBe('duplicate_id');
    expect(shipErrorCode(() => world.addShip(shipWithId(world, 9999 as EntityId)))).toBe('invalid_input');
    expect(shipErrorCode(() => world.addShip(shipWithId(world, 4 as EntityId)))).toBe('invalid_input');
    expect(world.ships.size).toBe(2);
  });

  it('removeShip odmietne neznáme id, loď s nákladom aj loď s kotviskami; prázdnu loď bez kotvísk odstráni', () => {
    const world = newWorld();
    const loaded = spawn(world, 'feeder', 1);
    expect(() => world.removeShip(12345 as EntityId)).toThrow(/neexistuje/);
    expect(() => world.removeShip(loaded.id)).toThrow(/na palube 1 jednotiek/);
    expect(shipErrorCode(() => world.removeShip(12345 as EntityId))).toBe('unknown_ship');
    expect(shipErrorCode(() => world.removeShip(loaded.id))).toBe('has_cargo');
    const holding = shipWithId(world, world.ids.next(), 'berthing', [ROOT_BERTH_ID]);
    world.addShip(holding);
    expect(() => world.removeShip(holding.id)).toThrow(/drží kotviská/);
    expect(shipErrorCode(() => world.removeShip(holding.id))).toBe('holds_berths');
    expect(world.ships.has(holding.id)).toBe(true);
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
