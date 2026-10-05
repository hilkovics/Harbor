// Rejda a priamy vstup lode bez voľného kotviska (T6D-03, ADR-029 dodatok; spätná väzba z hrania 2: „priplávajúce lode
// najskôr preplávajú okolo prístavu a potom sa vzdialia a niekde stoja“):
//  1. mapa harbor_01: anchorage tvoria vyhradenú zónu na otvorenom mori pri príjazdovej dráhe (jeden rad, rozostupy podľa
//     dĺžky lodí, ďaleko od brehu a od dráhy), jednotný kurz lodí na kotve (`anchorageHeading`);
//  2. loď s voľným kotviskom ide rovno ku kotvisku (`inbound`, sea lane), loď bez voľného kotviska dostane anchorage pri
//     vstupe a pláva na ňu priamo (`waiting_anchorage` už zo vstupu) — dĺžka trasy je blízko najkratšej, nezájde k prístavu
//     a nepretína pás pred kotviskami;
//  3. loď na anchorage stojí s kurzom `anchorageHeading`, nie s kurzom posledného úseku trasy; z anchorage ide ku kotvisku;
//  4. save: v9 sa načíta a obnoví bitovo rovnaký priebeh, v8 s loďou na starej rejde sa načíta (loď sa normalizuje pred vstup).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { shipBox, type Ship } from '@sim/ships';
import { World, WorldStateError, findWorldViolation, migrateWorldState, savesDirectAnchorage, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { toV8State } from '../helpers/legacy-save';
import { BUNDLED_DEFS, DEFS, MAP } from '../world/world-fixtures';
import { ROOT_BERTH_ID, berth, spawn, tickN } from './ship-fixtures';

const STAYS_DOCKED = 40;
const FIXTURE_V8 = fileURLToPath(new URL('../__fixtures__/saves/save-v8-anchorage.json', import.meta.url));
const FEEDER = DEFS.ships.get('feeder');
const HANDY = DEFS.ships.get('handy');
const LONGEST = Math.max(...DEFS.ships.items.map((def) => def.lengthCells));
const WIDEST = Math.max(...DEFS.ships.items.map((def) => def.widthCells));
const LANE_START = { x: MAP.seaLane[0].x + 0.5, y: MAP.seaLane[0].y + 0.5 };

const centerOf = (index: number): { x: number; y: number } => ({ x: MAP.anchorage[index].x + 0.5, y: MAP.anchorage[index].y + 0.5 });

/** Bunky stojacej lode triedy `dims` na anchorage `index` (kurz `anchorageHeading`). */
const boxOn = (dims: { lengthCells: number; widthCells: number }, index: number) => {
  const { x, y } = centerOf(index);
  return shipBox(dims, x, y, MAP.anchorageHeading);
};

/** Pás vody pred Root kotviskom (`frontWaterCells` + šírka najširšej lode + rezerva), kam kotviaca loď nesmie. */
function rootBand(world: World): { x0: number; y0: number; x1: number; y1: number } {
  const root = berth(world, ROOT_BERTH_ID);
  const depth = root.params.frontWaterCells + WIDEST + world.defs.logistics.shipNavigation.approachMarginCells;
  return { x0: root.origin.x, x1: root.origin.x + root.size.w, y0: root.origin.y - depth, y1: root.origin.y };
}

const overlap = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function isResting(ship: Ship): boolean {
  return ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length;
}

describe('rejda harbor_01 — vyhradená zóna kotvísk na otvorenom mori pri príjazdovej dráhe', () => {
  it('všetky anchorage sú v jednom rade pozdĺž severného okraja mapy a majú jednotný kurz lodí (pozdĺž pobrežia)', () => {
    const rows = new Set(MAP.anchorage.map((cell) => cell.y));
    expect(rows.size).toBe(1);
    expect(MAP.anchorage.length).toBeGreaterThanOrEqual(4);
    expect(MAP.anchorageHeading).toBe(90);
    // kurz pozdĺž pobrežia: dĺžka lode leží na osi x, ako pri lodiach pri kotviskách na severe móla
    expect(boxOn(HANDY, 0).x1 - boxOn(HANDY, 0).x0).toBeGreaterThan(boxOn(HANDY, 0).y1 - boxOn(HANDY, 0).y0);
  });

  it('rozostupy podľa dĺžky lodí: obdĺžniky ani najdlhšej lode na susedných anchorage sa neprekrývajú (a majú medzeru)', () => {
    const longest = DEFS.ships.items.find((def) => def.lengthCells === LONGEST) ?? HANDY;
    for (let i = 0; i < MAP.anchorage.length; i++) {
      for (let j = i + 1; j < MAP.anchorage.length; j++) {
        expect(overlap(boxOn(longest, i), boxOn(longest, j)), `anchorage ${String(i)} a ${String(j)}`).toBe(false);
        const gap = Math.abs(centerOf(i).x - centerOf(j).x) - longest.lengthCells;
        expect(gap, `medzera anchorage ${String(i)} a ${String(j)}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('dosť ďaleko od brehu (≥ 5 buniek vody medzi obdĺžnikom lode a súšou) a od sea lane (≥ 3 bunky mimo jej obdĺžnikov)', () => {
    const grid = MAP.createGrid();
    for (let index = 0; index < MAP.anchorage.length; index++) {
      const box = boxOn(HANDY, index);
      let nearestLand = Infinity;
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          if (grid.at(x, y).terrain === 'deep_water' || grid.at(x, y).terrain === 'shallow_water') continue;
          const dx = Math.max(box.x0 - x, 0, x - (box.x1 - 1));
          const dy = Math.max(box.y0 - y, 0, y - (box.y1 - 1));
          nearestLand = Math.min(nearestLand, Math.max(dx, dy));
        }
      }
      expect(nearestLand, `anchorage ${String(index)}: vzdialenosť od súše`).toBeGreaterThanOrEqual(5);
      // sea lane: stĺpec dráhy ± polovica najširšej lode + 3 bunky (dráha vstupu je zvislá, rejda na jej boku)
      const laneX = LANE_START.x;
      const gapToLane = Math.min(Math.abs(box.x0 - laneX), Math.abs(box.x1 - laneX));
      expect(gapToLane, `anchorage ${String(index)}: vzdialenosť od dráhy`).toBeGreaterThanOrEqual(WIDEST + 3);
    }
  });

  it('žiadna anchorage nezasahuje do pásu pred Root kotviskom a rad leží severne od neho (y obdĺžnika pod pásom)', () => {
    const world = World.create(DEFS, MAP, 1);
    const band = rootBand(world);
    for (let index = 0; index < MAP.anchorage.length; index++) {
      expect(overlap(boxOn(HANDY, index), band), `anchorage ${String(index)}`).toBe(false);
      expect(boxOn(HANDY, index).y1, `anchorage ${String(index)}`).toBeLessThan(band.y0);
    }
  });
});

describe('priamy vstup lode na rejdu (harbor_01, jedno kotvisko Root)', () => {
  it('loď s voľným kotviskom ide rovno ku kotvisku (inbound po sea lane, žiadna anchorage)', () => {
    const world = World.create(DEFS, MAP, 7);
    const ship = spawn(world, 'feeder', STAYS_DOCKED);
    expect(ship.state).toBe('inbound');
    expect(ship.anchorageIndex).toBeNull();
    expect(ship.berthIds).toEqual([ROOT_BERTH_ID]);
    // trasa = celá sea lane a úsek ku kotvisku s polohou pri Root berthe (43; 13) a kurzom 90
    expect(ship.route.slice(0, MAP.seaLane.length).map((p) => [p.x - 0.5, p.y - 0.5])).toEqual(MAP.seaLane.map((c) => [c.x, c.y]));
    expect(ship.route.at(-1)).toEqual({ x: 43, y: 13, heading: 90 });
  });

  it('loď bez voľného kotviska dostane anchorage pri vstupe a pláva na ňu priamo zo vstupu (bez obchádzky prístavu)', () => {
    const world = World.create(DEFS, MAP, 7);
    const first = spawn(world, 'feeder', STAYS_DOCKED);
    const second = spawn(world, 'feeder', STAYS_DOCKED);
    expect(second.state).toBe('arriving'); // dráhu zatiaľ drží prvá loď (rezervácia trasy)
    for (let i = 0; i < 400 && second.state === 'arriving'; i++) world.tick();
    expect(first.berthIds).toEqual([ROOT_BERTH_ID]);
    // anchorage dostala hneď pri vstupe a v stave waiting_anchorage pláva k nej — nie `inbound` po celej sea lane
    expect(second.state).toBe('waiting_anchorage');
    expect(second.anchorageIndex).toBe(0);
    expect(second.berthIds).toEqual([]);

    const trail: { x: number; y: number; heading: number }[] = [];
    const band = rootBand(world);
    let length = 0;
    let previous = { x: second.x, y: second.y };
    for (let i = 0; i < 2000 && !isResting(second); i++) {
      world.tick();
      length += Math.hypot(second.x - previous.x, second.y - previous.y);
      previous = { x: second.x, y: second.y };
      trail.push({ x: second.x, y: second.y, heading: second.heading });
      expect(overlap(shipBox(FEEDER, second.x, second.y, second.heading), band), `tick ${String(world.clock.tick)}: pás pred kotviskom`).toBe(false);
    }
    expect(isResting(second)).toBe(true);
    const target = centerOf(0);
    expect([second.x, second.y]).toEqual([target.x, target.y]);
    // dĺžka trasy zo vstupu: nanajvýš o málo viac než najkratšia (Manhattan) cesta, nie obchádzka celej dráhy k prístavu
    const manhattan = Math.abs(target.x - LANE_START.x) + Math.abs(target.y - LANE_START.y);
    expect(length).toBeLessThanOrEqual(manhattan + 1);
    // loď nikdy nezašla k Root kotvisku ani ku koncu sea lane (44,5; 7,5): najjužnejšia poloha je rad rejdy
    expect(Math.max(...trail.map((p) => p.y))).toBeLessThanOrEqual(target.y);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('na rejde stoja všetky čakajúce lode jednotne natočené (kurz mapy), nezávisle od kurzu posledného úseku trasy', () => {
    const world = World.create(DEFS, MAP, 7);
    const ships = [spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'handy', STAYS_DOCKED), spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'handy', STAYS_DOCKED)];
    for (let i = 0; i < 6000 && !ships.slice(1).every(isResting); i++) world.tick();
    const waiting = ships.filter(isResting);
    expect(waiting.length).toBe(3);
    // každá loď stojí na vlastnej anchorage (jedinečný index, poloha = stred bunky) a majú rovnaký kurz mapy
    expect(new Set(waiting.map((ship) => ship.anchorageIndex)).size).toBe(3);
    for (const ship of waiting) {
      const cell = centerOf(ship.anchorageIndex ?? -1);
      expect(ship.heading, ship.label).toBe(MAP.anchorageHeading);
      expect([ship.x, ship.y], ship.label).toEqual([cell.x, cell.y]);
    }
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('z anchorage ide loď ku kotvisku, keď sa uvoľní (FIFO podľa id), a nevracia sa na začiatok sea lane', () => {
    const world = World.create(DEFS, MAP, 7);
    const docked = spawn(world, 'feeder', 1);
    const waiting = [spawn(world, 'feeder', 1), spawn(world, 'feeder', 1)];
    const dockOrder: EntityId[] = [];
    let seen = 0;
    for (let i = 0; i < 12000 && dockOrder.length < 3; i++) {
      for (const event of world.tick()) if (event.type === 'ShipDocked') dockOrder.push(event.shipId);
      for (const ship of waiting) {
        if (ship.state === 'berthing' && ship.route.length > 0) seen += 1;
        // trasa z anchorage ku kotvisku nikdy nevedie k začiatku sea lane (y 0,5)
        if (ship.state === 'berthing') expect(Math.min(...ship.route.map((p) => p.y))).toBeGreaterThan(LANE_START.y);
      }
    }
    expect(dockOrder).toEqual([docked.id, waiting[0].id, waiting[1].id]);
    expect(seen).toBeGreaterThan(0);
    assertCargoConservation(world);
  });
});

describe('save: v9 obnoví priebeh, v8 s loďou na starej rejde sa načíta', () => {
  /** Svet s Root dokovanou loďou a dvoma loďami na rejde (v pokoji). */
  function queuedWorld(): { world: World; ships: Ship[] } {
    const world = World.create(DEFS, MAP, 7);
    const ships = [spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'handy', STAYS_DOCKED)];
    for (let i = 0; i < 6000 && !ships.slice(1).every(isResting); i++) world.tick();
    expect(ships.slice(1).every(isResting)).toBe(true);
    return { world, ships };
  }

  it('v9: roundtrip uprostred plavby na rejdu aj v pokoji obnoví rovnaký stav a ďalší priebeh', () => {
    const world = World.create(DEFS, MAP, 7);
    const ships = [spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'handy', STAYS_DOCKED)];
    for (let i = 0; i < 400 && ships[1].state === 'arriving'; i++) world.tick();
    tickN(world, 30); // druhá loď pláva na rejdu
    expect(ships[1].state).toBe('waiting_anchorage');
    expect(isResting(ships[1])).toBe(false);
    const state = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    expect(state.version).toBe(9);
    const restored = World.deserialize(DEFS, MAP, state);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(state));
    expect(tickN(restored, 1500)).toEqual(tickN(world, 1500));
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(isResting(restored.ships.get(ships[1].id) as Ship)).toBe(true);
  });

  it('v9: čakajúca loď s iným kurzom než anchorageHeading → WorldStateError na kurze lode (jednotné natočenie je invariant)', () => {
    const { world, ships } = queuedWorld();
    const state = JSON.parse(JSON.stringify(world.serialize())) as { ships: { id: number; heading: number }[] };
    const entry = state.ships.find((candidate) => candidate.id === ships[1].id);
    if (entry === undefined) throw new Error('loď chýba v save');
    entry.heading = 270;
    let error: unknown;
    try {
      World.deserialize(DEFS, MAP, state as unknown as WorldState);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(`/ships/${String(state.ships.indexOf(entry))}/heading`);
    expect((error as WorldStateError).message).toMatch(/jednotný 90/);
  });

  it('v9: krok 12 odhalí loď na rejde s iným kurzom', () => {
    const { world, ships } = queuedWorld();
    ships[1].heading = 0;
    expect(findWorldViolation(world)).toMatch(/stojí na rejde, kurz má byť jednotný 90/);
  });

  it('v8 s loďami na starom rozložení rejdy (plavba po celej sea lane, čakanie): načíta sa, lode sa normalizujú pred vstup a odplávajú', () => {
    const { world, ships } = queuedWorld();
    const v8 = toV8State(world.serialize()) as unknown as { ships: Record<string, unknown>[] };
    expect(savesDirectAnchorage(v8)).toBe(false);
    // stará rejda harbor_01: anchorage 0 = (38, 2), 1 = (31, 5) — loď pláva po celej sea lane a čaká s kurzom posledného úseku
    const [, second, third] = ships.map((ship) => v8.ships.find((entry) => entry['id'] === ship.id) as Record<string, unknown>);
    const oldLane = [[48.5, 0.5], [48.5, 7.5], [44.5, 7.5]];
    Object.assign(second, { state: 'waiting_anchorage', x: 38.5, y: 2.5, heading: 0, anchorageIndex: 0, waypointIndex: 5, route: [...oldLane, [38.5, 7.5], [38.5, 2.5, 90]] });
    Object.assign(third, { state: 'inbound', x: 48.5, y: 3.5, heading: 180, anchorageIndex: 1, berthIds: [], waypointIndex: 1, route: [...oldLane, [31.5, 7.5], [31.5, 5.5]] });
    const restored = World.deserialize(DEFS, MAP, v8 as unknown as WorldState);
    for (const ship of [restored.ships.get(ships[1].id), restored.ships.get(ships[2].id)]) {
      expect(ship).toMatchObject({ state: 'arriving', anchorageIndex: null, x: LANE_START.x, y: LANE_START.y, waypointIndex: 0, route: [], berthIds: [] });
    }
    expect(restored.serialize().version).toBe(9);
    // náklad ostal na lodiach (nič sa neteleportuje) a svet sa dá plynule dohrať: lode vplávajú na rejdu v poradí id
    expect(restored.cargo.countAt('on_ship', ships[1].id)).toBe(STAYS_DOCKED);
    assertCargoConservation(restored);
    for (let i = 0; i < 6000; i++) {
      restored.tick();
      expect(findWorldViolation(restored), `tick ${String(restored.clock.tick)}`).toBeUndefined();
    }
    const [a, b] = [restored.ships.get(ships[1].id), restored.ships.get(ships[2].id)];
    expect([a, b].map((ship) => ship !== undefined && isResting(ship))).toEqual([true, true]);
    expect(a?.anchorageIndex).not.toBe(b?.anchorageIndex);
    expect([a?.heading, b?.heading]).toEqual([MAP.anchorageHeading, MAP.anchorageHeading]);
  });

  it('zmrazený natívny save v8 (kód pred T6D-03, multi_ship_queue v ticku 248: loď pri kotvisku, na starej rejde, na ceste k starej rejde po sea lane, pred vstupom) sa načíta a dohrá bez uviaznutia', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_V8, 'utf8')) as { version: number; ships: { id: number; state: string; anchorageIndex: number | null }[] };
    expect(raw.version).toBe(8);
    expect(raw.ships.map((ship) => [ship.id, ship.state, ship.anchorageIndex])).toEqual([
      [12, 'docked', null],
      [133, 'waiting_anchorage', 0],
      [154, 'inbound', 2],
      [184, 'arriving', null],
    ]);
    // Save vznikol nad bundled defmi (režim odovzdávania kotviska `under_hook`), preto sa načíta s nimi.
    const world = World.deserialize(BUNDLED_DEFS, MAP, raw as unknown as WorldState);
    expect([...world.ships.values()].map((ship) => [ship.id, ship.state, ship.anchorageIndex])).toEqual([
      [12, 'docked', null],
      [133, 'arriving', null],
      [154, 'arriving', null],
      [184, 'arriving', null],
    ]);
    expect(world.serialize().version).toBe(9);
    assertCargoConservation(world);
    const units = world.cargo.liveCount;
    let departed = 0;
    let resting = 0;
    for (let i = 0; i < 12_000 && world.ships.size > 0; i++) {
      for (const event of world.tick()) if (event.type === 'ShipDeparted') departed += 1;
      expect(findWorldViolation(world), `tick ${String(world.clock.tick)}`).toBeUndefined();
      resting = Math.max(resting, [...world.ships.values()].filter(isResting).length);
    }
    expect(world.ships.size).toBe(0); // všetky štyri lode odplávali, žiadna neuviazla
    expect(departed).toBe(4);
    expect(resting).toBeGreaterThanOrEqual(2); // lode z normalizovaných savov čakali na novej rejde
    assertCargoConservation(world);
    expect(world.cargo.liveCount + world.cargo.exportedCount).toBeGreaterThanOrEqual(units);
  });

  it('migrácia v8 → v9 mení len verziu a dopĺňa hinterland (T6D-01); lode (rejda, T6D-03) migrácia nemení, loď pri kotvisku sa pri načítaní v8 nemení', () => {
    const { world, ships } = queuedWorld();
    const v8 = toV8State(world.serialize());
    const migrated = migrateWorldState(v8, DEFS) as Record<string, unknown>;
    expect(migrated['version']).toBe(9);
    const zero = { admitted: 0, waitTicksTotal: 0, waitTicksMax: 0, turnedAway: 0 };
    expect(migrated['hinterland']).toEqual({ delivery: zero, collect: zero, pickupBayStarvationTicks: 0 });
    const withoutHinterland = Object.fromEntries(Object.entries(migrated).filter(([key]) => key !== 'hinterland'));
    expect(JSON.stringify({ ...withoutHinterland, version: 8 })).toBe(JSON.stringify(v8));
    expect(savesDirectAnchorage(migrated)).toBe(true);
    const restored = World.deserialize(DEFS, MAP, v8 as unknown as WorldState);
    const dockedShip = restored.ships.get(ships[0].id);
    expect(dockedShip).toMatchObject({ state: ships[0].state, berthIds: [ROOT_BERTH_ID], x: ships[0].x, y: ships[0].y });
    expect(berth(restored, ROOT_BERTH_ID).dockedShipId).toBe(ships[0].id);
  });
});
