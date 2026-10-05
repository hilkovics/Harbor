// Rejda a priamy vstup lode bez voľného kotviska (T6D-03, ADR-029 dodatok; spätná väzba z hrania 2: „priplávajúce lode
// najskôr preplávajú okolo prístavu a potom sa vzdialia a niekde stoja“):
//  1. mapa harbor_01: anchorage tvoria vyhradenú zónu na otvorenom mori pri príjazdovej dráhe (jeden rad, rozostupy podľa
//     dĺžky lodí, ďaleko od brehu a od dráhy), jednotný kurz lodí na kotve (`anchorageHeading`);
//  2. loď s voľným kotviskom ide rovno ku kotvisku (`inbound`, sea lane), loď bez voľného kotviska dostane anchorage pri
//     vstupe a pláva na ňu priamo (`waiting_anchorage` už zo vstupu) — dĺžka trasy je blízko najkratšej, nezájde k prístavu
//     a nepretína pás pred kotviskami;
//  3. loď na anchorage stojí s kurzom `anchorageHeading`, nie s kurzom posledného úseku trasy; z anchorage ide ku kotvisku;
//  4. save: načíta sa a obnoví bitovo rovnaký priebeh (save s loďou na starej rejde sa po clean breaku, ADR-036, nenačíta).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { shipBox, type Ship } from '@sim/ships';
import { WORLD_STATE_VERSION, World, WorldStateError, findWorldViolation, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { DEFS, MAP } from '../world/world-fixtures';
import { ROOT_BERTH_ID, berth, spawn, tickN } from './ship-fixtures';

const STAYS_DOCKED = 40;
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

describe('save: roundtrip a invarianty lodí na rejde', () => {
  /** Svet s Root dokovanou loďou a dvoma loďami na rejde (v pokoji). */
  function queuedWorld(): { world: World; ships: Ship[] } {
    const world = World.create(DEFS, MAP, 7);
    const ships = [spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'handy', STAYS_DOCKED)];
    for (let i = 0; i < 6000 && !ships.slice(1).every(isResting); i++) world.tick();
    expect(ships.slice(1).every(isResting)).toBe(true);
    return { world, ships };
  }

  it('roundtrip uprostred plavby na rejdu aj v pokoji obnoví rovnaký stav a ďalší priebeh', () => {
    const world = World.create(DEFS, MAP, 7);
    const ships = [spawn(world, 'feeder', STAYS_DOCKED), spawn(world, 'handy', STAYS_DOCKED)];
    for (let i = 0; i < 400 && ships[1].state === 'arriving'; i++) world.tick();
    tickN(world, 30); // druhá loď pláva na rejdu
    expect(ships[1].state).toBe('waiting_anchorage');
    expect(isResting(ships[1])).toBe(false);
    const state = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    expect(state.version).toBe(WORLD_STATE_VERSION);
    const restored = World.deserialize(DEFS, MAP, state);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(state));
    expect(tickN(restored, 1500)).toEqual(tickN(world, 1500));
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(isResting(restored.ships.get(ships[1].id) as Ship)).toBe(true);
  });

  it('čakajúca loď s iným kurzom než anchorageHeading → WorldStateError na kurze lode (jednotné natočenie je invariant)', () => {
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

  it('krok 12 odhalí loď na rejde s iným kurzom', () => {
    const { world, ships } = queuedWorld();
    ships[1].heading = 0;
    expect(findWorldViolation(world)).toMatch(/stojí na rejde, kurz má byť jednotný 90/);
  });
});
