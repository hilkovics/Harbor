// Lode vo WorldState v2 a invarianty lodí (T02-05, ARCHITECTURE §14, §16, ADR-016, ADR-029): roundtrip lodí v rôznych
// stavoch (berthing, waiting_anchorage) s obnovou dockedShipId z berthIds a uloženou trasou, validácia záznamu lode
// s JSON pointerom, chyby obnovy (kotvisko, anchorage, index trasy) a porušenia invariantov (súlad dockedShipId ↔
// berthIds, anchorage, súvislý úsek kotvísk, náklad na palube, žeriav v grabbing bez lode, prekryv lodí).
// Flotila stojí na mape s kanálom (`CHANNEL_MAP_W1`, kotvisko W1 = id 1 so žeriavom id 2 ako Root) — anchorage
// harbor_01 sú po ADR-029 použiteľné podľa geometrie mapy, flotila má byť od nej nezávislá.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { Ship } from '@sim/ships';
import { World, WorldStateError, findWorldViolation, type WorldState } from '@sim/world';
import { MAP } from '../world/world-fixtures';
import { ANCHORAGE_AT_MOUTH, ANCHORAGE_OPEN, ANCHORAGE_OPEN_SOUTH, CHANNEL_BERTHS, CHANNEL_MAP_W1 } from './channel-map';
import { restoreCrane } from '../helpers/crane-state';
import {
  BULKER,
  BULK_CRANE,
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

/** Mapa flotily (kanál so štartovým kotviskom W1 = `ROOT_BERTH_ID`, žeriav `ROOT_CRANE_ID`). */
const FLEET_MAP = CHANNEL_MAP_W1;

/** Stred bunky anchorage `index` mapy flotily. */
function center(index: number): { x: number; y: number } {
  const cell = FLEET_MAP.anchorage[index];
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

/** Loď čakajúca na anchorage `index` (v jej strede, trasa dokončená) s `units` jednotkami na palube. */
function waitingAt(world: World, classId: string, index: number, units: number): Ship {
  const cell = FLEET_MAP.anchorage[index];
  const ship = new Ship({
    id: world.ids.next(),
    def: SHIP_DEFS.ships.get(classId),
    cargoType: SHIP_DEFS.cargoTypes.get(TEU),
    state: 'waiting_anchorage',
    x: cell.x + 0.5,
    y: cell.y + 0.5,
    // T6D-03: loď na rejde stojí s jednotným kurzom mapy (`anchorageHeading`), nie s kurzom posledného úseku trasy.
    heading: FLEET_MAP.anchorageHeading,
    anchorageIndex: index,
  });
  world.addShip(ship);
  for (let i = 0; i < units; i++) world.cargo.create(TEU, { kind: 'on_ship', shipId: ship.id });
  return ship;
}

/**
 * W1 + feeder A (berthing na W1, trasa z rezervácie), feeder B (anchorage 2), handy C (anchorage 3) — B a C stoja
 * mimo trasy A do kanála. Id: A 3, B 6, C 8.
 */
function fleet(): { world: World; a: Ship; b: Ship; c: Ship } {
  const world = World.create(SHIP_DEFS, FLEET_MAP, 5005);
  const a = spawn(world, 'feeder', 2);
  tickUntil(world, () => a.state === 'berthing', 200);
  world.tick();
  const b = waitingAt(world, 'feeder', ANCHORAGE_OPEN, 1);
  const c = waitingAt(world, 'handy', ANCHORAGE_OPEN_SOUTH, 1);
  return { world, a, b, c };
}

/** Druhé kotvisko flotily (W3, samostatná skupina) — pre porušenia s cudzím `dockedShipId`. */
function otherBerth(world: World): EntityId {
  const { x, y, rotation } = CHANNEL_BERTHS.W3;
  return world.placeModule({ defId: 'berth_standard', x, y, rotation }, 0).id;
}

function mutable(world: World): MutableState {
  return JSON.parse(JSON.stringify(world.serialize())) as MutableState;
}

describe('WorldState v2 — lode', () => {
  it('ships: vzostupne podľa id, presný tvar; roundtrip obnoví lode, dockedShipId a identický ďalší priebeh', () => {
    const { world, a, b, c } = fleet();
    expect([a.id, b.id, c.id]).toEqual([3, 6, 8]);
    expect([a.state, b.state, c.state]).toEqual(['berthing', 'waiting_anchorage', 'waiting_anchorage']);
    const state = world.serialize();
    expect(state.ships.map((s) => [s.id, s.state, s.berthIds, s.anchorageIndex])).toEqual([
      [a.id, 'berthing', [ROOT_BERTH_ID], null],
      [b.id, 'waiting_anchorage', [], ANCHORAGE_OPEN],
      [c.id, 'waiting_anchorage', [], ANCHORAGE_OPEN_SOUTH],
    ]);
    // Trasa stavu je v save (ADR-029): berthing končí posunom bokom k polohe pri W1 s pevným kurzom.
    expect(state.ships[0].route.at(-1)).toEqual([14, 15, 180]);
    expect(state.ships[1].route).toEqual([]);

    const restored = World.deserialize(SHIP_DEFS, FLEET_MAP, JSON.parse(JSON.stringify(state)) as WorldState);
    expect([...restored.ships.keys()]).toEqual([a.id, b.id, c.id]);
    expect(berth(restored, ROOT_BERTH_ID).dockedShipId).toBe(a.id);
    expect(restored.ships.get(b.id)).toMatchObject({ x: b.x, y: b.y, heading: b.heading, waypointIndex: b.waypointIndex });
    expect(restored.ships.get(a.id)?.route).toEqual(a.route);
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
    ['anchorage mimo mapy', (s) => (s.ships[1]['anchorageIndex'] = FLEET_MAP.anchorage.length), '/ships/1/anchorageIndex'],
    ['kotviská aj anchorage naraz', (s) => Object.assign(s.ships[0], { state: 'inbound', anchorageIndex: ANCHORAGE_OPEN_SOUTH }), '/ships/0/anchorageIndex'],
    ['bod trasy mimo mapy', (s) => ((s.ships[0]['route'] as unknown[][])[0][0] = -1), '/ships/0/route/0/0'],
    ['bod trasy s kurzom 45', (s) => ((s.ships[0]['route'] as unknown[][])[0] = [1, 1, 45]), '/ships/0/route/0/2'],
    ['bod trasy so 4 prvkami', (s) => ((s.ships[0]['route'] as unknown[][])[0] = [1, 1, 90, 0]), '/ships/0/route/0'],
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
    ['dve lode na jednej anchorage', (s) => (s.ships[2]['anchorageIndex'] = ANCHORAGE_OPEN), '/ships/2/anchorageIndex'],
    ['waypointIndex za koncom trasy', (s) => (s.ships[0]['waypointIndex'] = (s.ships[0]['route'] as unknown[]).length + 1), '/ships/0/waypointIndex'],
    // ADR-029 addendum (T5B-04b): trasa a poloha podľa stavu, rezervácie lodí na mape bez spoločnej bunky.
    ['čakajúca loď bez trasy mimo svojej anchorage (na mieste inej lode)', (s) => Object.assign(s.ships[2], { x: s.ships[1]['x'], y: s.ships[1]['y'] }), '/ships/2/y'],
    ['berthing s trasou, ktorá nekončí pri kotvisku', (s) => (s.ships[0]['route'] as unknown[]).pop(), '/ships/0/route'],
    ['dokovaná loď s trasou', (s) => Object.assign(s.ships[0], { state: 'docked', x: 14, y: 15, heading: 180, waypointIndex: 0 }), '/ships/0/route'],
    // A stojí na začiatku úseku (30,5; 5,65) → (30,5; 6,5); s indexom 1 by mala ležať na úseku y = 6,5.
    ['loď mimo aktuálneho úseku trasy', (s) => (s.ships[0]['waypointIndex'] = 1), '/ships/0/y'],
    ['čakajúca loď na anchorage v trase lode na ceste ku kotvisku', (s) => Object.assign(s.ships[1], { anchorageIndex: ANCHORAGE_AT_MOUTH, ...center(ANCHORAGE_AT_MOUTH) }), '/ships/1/route'],
    ['natívny v6 s route: null', (s) => (s.ships[1]['route'] = null), '/ships/1/route'],
    ['čakajúca loď bez anchorage v natívnom v6', (s) => (s.ships[1]['anchorageIndex'] = null), '/ships/1/anchorageIndex'],
    // T02-14: loď s nákladom na kotvisku bez žeriavu svojej kategórie by pri kotvisku ostala naveky.
    ['loď s nákladom na kotvisku bez žeriavu (Root žeriav chýba v save)', (s) => void (s.modules as unknown[]).splice(1, 1), ''],
  ])('%s → WorldStateError na %s', (_name, mutate, path) => {
    const state = mutable(fleet().world);
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(SHIP_DEFS, FLEET_MAP, state as unknown as WorldState);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
  });
});

/** Root + feeder so 4 TEU v stave docked pri Root berthe (poloha (43, 13), kurz 90). */
function dockedWorld(): { world: World; ship: Ship } {
  const world = newWorld();
  const ship = spawn(world, 'feeder', 4);
  tickUntil(world, () => ship.state === 'docked', 300);
  return { world, ship };
}

describe('WorldState v2 — poloha a kurz dokovanej lode (T02-14)', () => {
  it('dokovaná loď v save: presne dockPoint (43, 13) a DOCKED_HEADING 90; roundtrip prejde', () => {
    const { world, ship } = dockedWorld();
    expect([ship.x, ship.y, ship.heading]).toEqual([43, 13, 90]);
    expect(() => World.deserialize(SHIP_DEFS, MAP, mutable(world) as unknown as WorldState)).not.toThrow();
  });

  it.each<[string, (s: MutableState) => void, string, RegExp]>([
    ['x mimo polohy pri kotvisku', (s) => (s.ships[0]['x'] = 43.5), '/ships/0/x', /má stáť pri kotvisku v \(43, 13\), x je 43\.5/],
    ['y mimo polohy pri kotvisku', (s) => (s.ships[0]['y'] = 12), '/ships/0/y', /má stáť pri kotvisku v \(43, 13\), y je 12/],
    ['kurz nie je rovnobežne s hranou', (s) => (s.ships[0]['heading'] = 270), '/ships/0/heading', /má pri kotvisku kurz 90, má 270/],
  ])('%s → WorldStateError na %s', (_name, mutate, path, message) => {
    const state = mutable(dockedWorld().world);
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(SHIP_DEFS, MAP, state as unknown as WorldState);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
    expect((error as Error).message).toMatch(message);
  });

  it('invariant: dokovaná loď posunutá mimo polohy pri kotvisku → porušenie (krok 12)', () => {
    const { world, ship } = dockedWorld();
    expect(findWorldViolation(world)).toBeUndefined();
    ship.heading = 0;
    expect(findWorldViolation(world)).toMatch(/má pri kotvisku kurz 90, má 0/);
    ship.heading = 90;
    ship.x = 44;
    expect(findWorldViolation(world)).toMatch(/má stáť pri kotvisku v \(43, 13\), x je 44/);
  });
});

describe('WorldState v2 — loď s nákladom bez žeriavu (T02-14)', () => {
  it('save, v ktorom kotviská lode nemajú žeriav kategórie jej nákladu → WorldStateError pri deserialize, nie soft-lock', () => {
    const { world, a } = fleet();
    const state = mutable(world);
    (state.modules as unknown[]).splice(1, 1);
    expect(() => World.deserialize(SHIP_DEFS, FLEET_MAP, state as unknown as WorldState)).toThrow(
      new RegExp(`WorldState: .*feeder #${String(a.id)} s nákladom drží kotviská \\[${String(ROOT_BERTH_ID)}\\], na ktorých nie je žeriav kategórie 'container'`),
    );
  });
});

describe('WorldState v2 — žeriav v grabbing nad loďou inej kategórie (T02-14)', () => {
  it('save → WorldStateError pri deserialize (koniec grabbing by v tick() nenašiel jednotku svojej kategórie)', () => {
    const world = newWorld();
    placeModule(world, BULK_CRANE, { x: 45, y: 14 });
    const ship = spawn(world, BULKER, 3, GRAIN);
    tickUntil(world, () => ship.state === 'docked', 300);
    expect(crane(world, ROOT_CRANE_ID).state).toBe('idle');
    const state = mutable(world);
    const modules = state.modules as { runtime: Record<string, unknown> }[];
    Object.assign(modules[1].runtime, { state: 'grabbing', reservedSlot: 1, phaseTicksTotal: 6, phaseTicksLeft: 6 });
    let error: unknown;
    try {
      World.deserialize(SHIP_DEFS, MAP, state as unknown as WorldState);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe('');
    expect((error as Error).message).toMatch(
      new RegExp(`crane_container_gantry #2 \\(kategória 'container'\\) v stave 'grabbing' nad bulker_test #${String(ship.id)} s nákladom kategórie 'bulk'`),
    );
  });
});

describe('invarianty lodí (findWorldViolation)', () => {
  it('konzistentná flotila → žiadne porušenie', () => {
    expect(findWorldViolation(fleet().world)).toBeUndefined();
  });

  it.each<[string, RegExp, (h: ReturnType<typeof fleet>) => void]>([
    ['dockedShipId neexistujúcej lode', /dockedShipId 999 — loď neexistuje/, ({ world }) => {
      berth(world, otherBerth(world)).dockedShipId = 999 as EntityId;
    }],
    ['berthIds bez dockedShipId', /má dockedShipId null/, ({ world }) => (berth(world, ROOT_BERTH_ID).dockedShipId = null)],
    // T02-14 (review T02-13): vetva „dockedShipId existujúcej lode, ktorá kotvisko nemá v berthIds“.
    [
      'dockedShipId existujúcej čakajúcej lode, ktorá kotvisko nemá v berthIds',
      /berth_standard #\d+: dockedShipId \d+, ale feeder #\d+ ho nemá v berthIds/,
      ({ world, b }) => {
        berth(world, otherBerth(world)).dockedShipId = b.id;
      },
    ],
    [
      'dockedShipId lode, ktorá drží iné kotvisko',
      /dockedShipId \d+, ale feeder #\d+ ho nemá v berthIds/,
      ({ world, a }) => {
        berth(world, otherBerth(world)).dockedShipId = a.id;
      },
    ],
    ['berthing bez kotvísk', /nedrží kotviská/, ({ a }) => (a.berthIds = [])],
    ['čakajúca loď s kotviskom', /drží kotviská/, ({ b }) => (b.berthIds = [ROOT_BERTH_ID])],
    ['anchorage mimo čakania', /má anchorage 3/, ({ a }) => (a.anchorageIndex = 3)],
    ['dve lode na jednej anchorage', /obsadili tú istú anchorage 2/, ({ c }) => (c.anchorageIndex = ANCHORAGE_OPEN)],
    ['dve lode zdieľajú bunky (ADR-029)', /feeder #6 \(waiting_anchorage\) a handy #8 \(waiting_anchorage\) zdieľajú bunky/, ({ b, c }) => {
      c.x = b.x + 1;
      c.y = b.y;
    }],
    ['anchorage mimo mapy', /anchorage 9 mimo mapy/, ({ c }) => (c.anchorageIndex = 9)],
    ['cudzí typ nákladu na palube', /nie je typu 'container_teu'/, ({ world, b }) => void world.cargo.create(GRAIN, { kind: 'on_ship', shipId: b.id })],
    ['náklad nad kapacitu', /capacityUnits 120/, ({ world, b }) => {
      for (let i = 0; i < 120; i++) world.cargo.create(TEU, { kind: 'on_ship', shipId: b.id });
    }],
    ['žeriav v grabbing bez dokovanej lode', /'grabbing' nemá na kotvisku dokovanú loď/, ({ world }) => {
      const c = crane(world, ROOT_CRANE_ID);
      restoreCrane(c, { state: 'grabbing', reservedSlot: berth(world, ROOT_BERTH_ID).apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 6 });
    }],
    ['despawned loď vo svete', /v stave 'despawned'/, ({ world }) => {
      const ghost = new Ship({ id: world.ids.next(), def: SHIP_DEFS.ships.get('feeder'), cargoType: SHIP_DEFS.cargoTypes.get(TEU), state: 'outbound', x: 36.5, y: 3.5, heading: 0 });
      world.addShip(ghost);
      ghost.transition('despawned');
    }],
  ])('%s', (_name, message, corrupt) => {
    const harbor = fleet();
    corrupt(harbor);
    expect(findWorldViolation(harbor.world)).toMatch(message);
  });

  it('loď s nákladom drží kotvisko bez žeriavu svojej kategórie → porušenie; bez nákladu nie (T02-14)', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    const ship = new Ship({
      id: world.ids.next(),
      def: SHIP_DEFS.ships.get('feeder'),
      cargoType: SHIP_DEFS.cargoTypes.get(TEU),
      state: 'berthing',
      x: 51,
      y: 13,
      heading: 90,
      berthIds: [east],
    });
    world.addShip(ship);
    berth(world, east).dockedShipId = ship.id;
    expect(findWorldViolation(world)).toBeUndefined();
    world.cargo.create(TEU, { kind: 'on_ship', shipId: ship.id });
    expect(findWorldViolation(world)).toBe(
      `feeder #${String(ship.id)} s nákladom drží kotviská [${String(east)}], na ktorých nie je žeriav kategórie 'container'`,
    );
    placeModule(world, CRANE, { x: 51, y: 14 });
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('sypká loď s nákladom pri kontajnerovom žeriave → porušenie (kategória žeriavu musí sedieť)', () => {
    const world = newWorld();
    const ship = new Ship({
      id: world.ids.next(),
      def: SHIP_DEFS.ships.get(BULKER),
      cargoType: SHIP_DEFS.cargoTypes.get(GRAIN),
      state: 'docked',
      x: 43,
      y: 13,
      heading: 90,
      berthIds: [ROOT_BERTH_ID],
    });
    world.addShip(ship);
    berth(world, ROOT_BERTH_ID).dockedShipId = ship.id;
    world.cargo.create(GRAIN, { kind: 'on_ship', shipId: ship.id });
    expect(findWorldViolation(world)).toMatch(/na ktorých nie je žeriav kategórie 'bulk'/);
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
    restoreCrane(crane(world, second), { state: 'grabbing', reservedSlot: berth(world, ROOT_BERTH_ID).apron.reserve(), phaseTicksTotal: 6, phaseTicksLeft: 6 });
    expect(findWorldViolation(world)).toMatch(/2 žeriavov zdvíha z feeder #\d+, na palube je len 1 jednotiek/);
  });
});
