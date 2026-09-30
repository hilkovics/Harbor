// Lode vo WorldState v2 a invarianty lodí (T02-05, ARCHITECTURE §14, §16, ADR-016): roundtrip lodí v rôznych stavoch
// (berthing, waiting_anchorage) s obnovou dockedShipId z berthIds, validácia záznamu lode s JSON pointerom, chyby
// obnovy (kotvisko, anchorage, index trasy) a porušenia invariantov (súlad dockedShipId ↔ berthIds, anchorage,
// súvislý úsek kotvísk, náklad na palube, žeriav v grabbing bez lode).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { Ship } from '@sim/ships';
import { World, WorldStateError, findWorldViolation, type WorldState } from '@sim/world';
import { MAP } from '../world/world-fixtures';
import {
  BULKER,
  CRANE,
  EAST_BERTH,
  GRAIN,
  ROOT_BERTH_ID,
  ROOT_CRANE_ID,
  SHIP_DEFS,
  TEU,
  WEST_BERTH,
  berth,
  crane,
  newWorld,
  placeModule,
  spawn,
  tickN,
  tickUntil,
} from './ship-fixtures';

type MutableState = { -readonly [K in keyof WorldState]: unknown } & {
  ships: Record<string, unknown>[];
  cargo: { units: Record<string, unknown>[] };
  ids: { nextId: number };
};

/** Root + feeder A (berthing na Roote), feeder B (anchorage 0), handy C (anchorage 1). Id: A 3, B 6, C 8. */
function fleet(): { world: World; a: Ship; b: Ship; c: Ship } {
  const world = newWorld();
  const a = spawn(world, 'feeder', 2);
  const b = spawn(world, 'feeder', 1);
  const c = spawn(world, 'handy', 1);
  tickUntil(world, () => a.state === 'berthing', 200);
  world.tick();
  return { world, a, b, c };
}

function mutable(world: World): MutableState {
  return JSON.parse(JSON.stringify(world.serialize())) as MutableState;
}

describe('WorldState v2 — lode', () => {
  it('ships: vzostupne podľa id, presný tvar; roundtrip obnoví lode, dockedShipId a identický ďalší priebeh', () => {
    const { world, a, b, c } = fleet();
    expect([a.state, b.state, c.state]).toEqual(['berthing', 'waiting_anchorage', 'waiting_anchorage']);
    const state = world.serialize();
    expect(state.ships.map((s) => [s.id, s.state, s.berthIds, s.anchorageIndex])).toEqual([
      [a.id, 'berthing', [ROOT_BERTH_ID], null],
      [b.id, 'waiting_anchorage', [], 0],
      [c.id, 'waiting_anchorage', [], 1],
    ]);

    const restored = World.deserialize(SHIP_DEFS, MAP, JSON.parse(JSON.stringify(state)) as WorldState);
    expect([...restored.ships.keys()]).toEqual([a.id, b.id, c.id]);
    expect(berth(restored, ROOT_BERTH_ID).dockedShipId).toBe(a.id);
    expect(restored.ships.get(b.id)).toMatchObject({ x: b.x, y: b.y, heading: b.heading, waypointIndex: b.waypointIndex });
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(state));

    expect(tickN(restored, 600)).toEqual(tickN(world, 600));
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
  });

  it.each<[string, (s: MutableState) => void, string]>([
    ['lode nie sú vzostupne podľa id', (s) => s.ships.reverse(), '/ships/1/id'],
    ['id lode ≥ nextId', (s) => (s.ships[2]['id'] = s.ids.nextId), '/ships/2/id'],
    ['neznáma trieda', (s) => (s.ships[0]['classId'] = 'panamax_x'), '/ships/0/classId'],
    ['neznámy náklad', (s) => (s.ships[0]['cargoTypeId'] = 'bananas'), '/ships/0/cargoTypeId'],
    ['náklad mimo kategórií triedy', (s) => (s.ships[0]['classId'] = BULKER), '/ships/0/cargoTypeId'],
    ['stav despawned', (s) => (s.ships[1]['state'] = 'despawned'), '/ships/1/state'],
    ['neznámy stav', (s) => (s.ships[1]['state'] = 'sinking'), '/ships/1/state'],
    ['x mimo mapy', (s) => (s.ships[0]['x'] = -1), '/ships/0/x'],
    ['y mimo mapy', (s) => (s.ships[0]['y'] = 1000), '/ships/0/y'],
    ['kurz 45', (s) => (s.ships[0]['heading'] = 45), '/ships/0/heading'],
    ['berthing bez kotvísk', (s) => (s.ships[0]['berthIds'] = []), '/ships/0/berthIds'],
    ['čakajúca loď s kotviskom', (s) => (s.ships[1]['berthIds'] = [ROOT_BERTH_ID]), '/ships/1/berthIds'],
    ['duplicitné kotvisko', (s) => (s.ships[0]['berthIds'] = [ROOT_BERTH_ID, ROOT_BERTH_ID]), '/ships/0/berthIds/1'],
    ['anchorage pri berthing', (s) => (s.ships[0]['anchorageIndex'] = 2), '/ships/0/anchorageIndex'],
    ['anchorage mimo mapy', (s) => (s.ships[1]['anchorageIndex'] = MAP.anchorage.length), '/ships/1/anchorageIndex'],
    ['necelý waypointIndex', (s) => (s.ships[1]['waypointIndex'] = 0.5), '/ships/1/waypointIndex'],
    ['id lode = id modulu', (s) => (s.ships[0]['id'] = ROOT_BERTH_ID), '/ships/0/id'],
    ['id jednotky = id lode', (s) => (s.cargo.units[0]['id'] = s.ships[2]['id']), '/cargo/units/0/id'],
    // Obnova (restoreEntities): vzťahy k svetu.
    ['kotvisko je žeriav', (s) => (s.ships[0]['berthIds'] = [ROOT_CRANE_ID]), '/ships/0/berthIds/0'],
    [
      'dve lode na jednom kotvisku',
      (s) => Object.assign(s.ships[1], { state: 'berthing', berthIds: [ROOT_BERTH_ID], anchorageIndex: null }),
      '/ships/1/berthIds/0',
    ],
    ['dve lode na jednej anchorage', (s) => (s.ships[2]['anchorageIndex'] = 0), '/ships/2/anchorageIndex'],
    ['waypointIndex za koncom trasy', (s) => (s.ships[0]['waypointIndex'] = 2), '/ships/0/waypointIndex'],
  ])('%s → WorldStateError na %s', (_name, mutate, path) => {
    const state = mutable(fleet().world);
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(SHIP_DEFS, MAP, state as unknown as WorldState);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
  });
});

describe('invarianty lodí (findWorldViolation)', () => {
  it('konzistentná flotila → žiadne porušenie', () => {
    expect(findWorldViolation(fleet().world)).toBeUndefined();
  });

  it.each<[string, RegExp, (h: ReturnType<typeof fleet>) => void]>([
    ['dockedShipId neexistujúcej lode', /dockedShipId 999 — loď neexistuje/, ({ world }) => {
      berth(world, placeModule(world, 'berth_standard', EAST_BERTH)).dockedShipId = 999 as EntityId;
    }],
    ['berthIds bez dockedShipId', /má dockedShipId null/, ({ world }) => (berth(world, ROOT_BERTH_ID).dockedShipId = null)],
    ['berthing bez kotvísk', /nedrží kotviská/, ({ a }) => (a.berthIds = [])],
    ['čakajúca loď s kotviskom', /drží kotviská/, ({ b }) => (b.berthIds = [ROOT_BERTH_ID])],
    ['anchorage mimo čakania', /má anchorage 3/, ({ a }) => (a.anchorageIndex = 3)],
    ['dve lode na jednej anchorage', /obsadili tú istú anchorage 0/, ({ c }) => (c.anchorageIndex = 0)],
    ['anchorage mimo mapy', /anchorage 9 mimo mapy/, ({ c }) => (c.anchorageIndex = 9)],
    ['cudzí typ nákladu na palube', /nie je typu 'container_teu'/, ({ world, b }) => void world.cargo.create(GRAIN, { kind: 'on_ship', shipId: b.id })],
    ['náklad nad kapacitu', /capacityUnits 120/, ({ world, b }) => {
      for (let i = 0; i < 120; i++) world.cargo.create(TEU, { kind: 'on_ship', shipId: b.id });
    }],
    ['žeriav v grabbing bez dokovanej lode', /'grabbing' nemá na kotvisku dokovanú loď/, ({ world }) => {
      const c = crane(world, ROOT_CRANE_ID);
      Object.assign(c, { state: 'grabbing', reservedSlot: berth(world, ROOT_BERTH_ID).apron.reserve() });
    }],
    ['despawned loď vo svete', /v stave 'despawned'/, ({ world }) => {
      const ghost = new Ship({ id: world.ids.next(), def: SHIP_DEFS.ships.get('feeder'), cargoType: SHIP_DEFS.cargoTypes.get(TEU), state: 'outbound', x: 48.5, y: 0.5, heading: 0 });
      world.addShip(ghost);
      ghost.transition('despawned');
    }],
  ])('%s', (_name, message, corrupt) => {
    const harbor = fleet();
    corrupt(harbor);
    expect(findWorldViolation(harbor.world)).toMatch(message);
  });

  it('kotviská lode musia ležať za sebou v jednej skupine (West, East bez Rootu → porušenie)', () => {
    const world = newWorld();
    const west = placeModule(world, 'berth_standard', WEST_BERTH);
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    const ship = new Ship({
      id: world.ids.next(),
      def: SHIP_DEFS.ships.get('handy'),
      cargoType: SHIP_DEFS.cargoTypes.get(TEU),
      state: 'berthing',
      x: 44.5,
      y: 7.5,
      heading: 180,
      berthIds: [west, east],
    });
    world.addShip(ship);
    berth(world, west).dockedShipId = ship.id;
    berth(world, east).dockedShipId = ship.id;
    expect(findWorldViolation(world)).toMatch(/neležia za sebou v jednej skupine/);
    ship.berthIds = [west, ROOT_BERTH_ID];
    berth(world, east).dockedShipId = null;
    berth(world, ROOT_BERTH_ID).dockedShipId = ship.id;
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('viac žeriavov v grabbing nad loďou než jednotiek na palube → porušenie', () => {
    const world = newWorld();
    const second = placeModule(world, CRANE, { x: 45, y: 14 });
    const ship = spawn(world, 'feeder', 1);
    tickUntil(world, () => ship.state === 'docked', 300);
    expect(findWorldViolation(world)).toBeUndefined();
    Object.assign(crane(world, second), { state: 'grabbing', reservedSlot: berth(world, ROOT_BERTH_ID).apron.reserve() });
    expect(findWorldViolation(world)).toMatch(/2 žeriavov zdvíha z feeder #\d+, na palube je len 1 jednotiek/);
  });
});
