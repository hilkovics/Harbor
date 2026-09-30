// Geometria a pohyb lode (T02-05, ARCHITECTURE §7.4, ADR-016): stred bunky, kardinálny kurz bez trigonometrie,
// poloha pri kotvisku pre všetky strany vody, bunky obdĺžnika lode, pohyb po úsečkách so zvyškom kroku a trasy stavov.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { Rotation } from '@sim/grid';
import {
  DOCKED_HEADING,
  Ship,
  ShipError,
  advanceAlongRoute,
  cardinalHeading,
  cellCenter,
  dockPoint,
  shipCells,
  shipRoute,
  type ShipPoint,
  type ShipState,
} from '@sim/ships';
import { berthOn, quayGrid } from '../modules/module-fixtures';
import { MAP } from '../world/world-fixtures';
import { EAST_BERTH, ROOT_BERTH_ID, SHIP_DEFS, TEU, berth, newWorld, placeModule } from './ship-fixtures';

const FEEDER = SHIP_DEFS.ships.get('feeder');
const HANDY = SHIP_DEFS.ships.get('handy');

function freshShip(state: ShipState = 'inbound', x = 0, y = 0, heading: Rotation = 0): Ship {
  return new Ship({ id: 99 as EntityId, def: FEEDER, cargoType: SHIP_DEFS.cargoTypes.get(TEU), state, x, y, heading });
}

describe('cellCenter a cardinalHeading', () => {
  it('stred bunky = (x + 0,5, y + 0,5)', () => {
    expect(cellCenter({ x: 44, y: 7 })).toEqual({ x: 44.5, y: 7.5 });
  });

  it.each<[number, number, Rotation | null]>([
    [1, 0, 90],
    [-1, 0, 270],
    [0, 1, 180],
    [0, -1, 0],
    [3, -2, 90],
    [-1.5, 5.5, 180],
    [1, 1, 90], // remíza → os x
    [-2, 2, 270],
    [0, 0, null],
  ])('(%d, %d) → %s', (dx, dy, heading) => {
    expect(cardinalHeading(dx, dy)).toBe(heading);
  });

  it('kurz pri kotvisku je rovnobežný s hranou pri vode (nábrežie po pravoboku)', () => {
    expect(DOCKED_HEADING).toEqual({ n: 90, e: 180, s: 270, w: 0 });
  });
});

describe('dockPoint — stred obdĺžnika lengthCells × widthCells pred hranou pri vode', () => {
  it('harbor_01 Root berth (40,14) rot 0: feeder (6×2) → (43, 13), handy (10×2) → (45, 13)', () => {
    const world = newWorld();
    const root = berth(world, ROOT_BERTH_ID);
    expect(dockPoint(root, FEEDER)).toEqual({ x: 43, y: 13 });
    expect(dockPoint(root, HANDY)).toEqual({ x: 45, y: 13 });
  });

  // Syntetické nábrežie 30×30, berth 8×3 na (10, 10) po rotácii: rot 0 = n, 90 = e, 180 = s, 270 = w.
  it.each<[Rotation, ShipPoint]>([
    [0, { x: 13, y: 9 }], // hrana y 10, x 10–17; loď x 10–15, y 8–9
    [90, { x: 14, y: 13 }], // hrana x 12 (berth 3×8), y 10–17; loď x 13–14, y 10–15
    [180, { x: 13, y: 14 }], // hrana y 12; loď x 10–15, y 13–14
    [270, { x: 9, y: 13 }], // hrana x 10; loď x 8–9, y 10–15
  ])('rot %d → %o', (rotation, expected) => {
    const b = berthOn(quayGrid(30, 30), 5, { x: 10, y: 10 }, rotation);
    expect(dockPoint(b, FEEDER)).toEqual(expected);
  });
});

describe('shipCells — bunky obdĺžnika lode', () => {
  it('pri kotvisku Root (43, 13), kurz 90: x 40–45, y 12–13 (row-major)', () => {
    const cells = shipCells({ x: 43, y: 13, heading: 90, def: FEEDER });
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ x: 40, y: 12 });
    expect(cells.at(-1)).toEqual({ x: 45, y: 13 });
  });

  it('kurz 0/180 otočí obdĺžnik (dĺžka pozdĺž y); necelá poloha zaberie aj načaté bunky', () => {
    expect(shipCells({ x: 43, y: 13, heading: 180, def: FEEDER })).toHaveLength(12);
    const cells = shipCells({ x: 43.25, y: 10.5, heading: 0, def: FEEDER });
    const xs = [...new Set(cells.map((c) => c.x))];
    const ys = [...new Set(cells.map((c) => c.y))];
    expect(xs).toEqual([42, 43, 44]);
    expect(ys).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });
});

describe('advanceAlongRoute — úsečky, zvyšok kroku do ďalšieho úseku', () => {
  const route: readonly ShipPoint[] = [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 2, y: 1 },
  ];

  it('nulový prvý úsek preskočí, kurz podľa úseku, na konci presne v poslednom bode', () => {
    const s = freshShip('inbound', 0, 0, 90);
    expect(advanceAlongRoute(s, route, 0.4)).toBe(false);
    expect(s).toMatchObject({ x: 0, y: 0.4, heading: 180, waypointIndex: 1 });
    // 0,6 dokončí úsek dole, zvyšok 0,4 ide doprava — loď zahne v tom istom ticku.
    expect(advanceAlongRoute(s, route, 1)).toBe(false);
    expect(s.x).toBeCloseTo(0.4, 12);
    expect(s.y).toBe(1);
    expect(s.heading).toBe(90);
    expect(s.waypointIndex).toBe(2);
    expect(advanceAlongRoute(s, route, 5)).toBe(true);
    expect(s).toMatchObject({ x: 2, y: 1, waypointIndex: 3 });
    // Zvyšok na konci trasy prepadne, ďalšie volanie nič nezmení.
    expect(advanceAlongRoute(s, route, 5)).toBe(true);
    expect(s).toMatchObject({ x: 2, y: 1 });
  });

  it('krok nikdy nepresiahne rozpočet (tetiva ≤ dráha) a súčet krokov = dĺžka trasy', () => {
    const t = freshShip('inbound', 0, 0);
    const speed = 0.15;
    let travelled = 0;
    let arrived = false;
    for (let tick = 0; !arrived; tick++) {
      if (tick > 100) throw new Error('loď sa nedostala do cieľa');
      const [px, py] = [t.x, t.y];
      arrived = advanceAlongRoute(t, route, speed);
      const step = Math.hypot(t.x - px, t.y - py);
      expect(step).toBeLessThanOrEqual(speed + 1e-12);
      travelled += step;
    }
    expect(travelled).toBeLessThanOrEqual(3 + 1e-9);
    expect(travelled).toBeGreaterThan(2.8);
    expect([t.x, t.y]).toEqual([2, 1]);
  });

  it('prázdna trasa = dorazila, loď sa nepohne ani neotočí', () => {
    const s = freshShip('docked', 43, 13, 90);
    expect(advanceAlongRoute(s, [], 1)).toBe(true);
    expect(s).toMatchObject({ x: 43, y: 13, heading: 90 });
  });
});

describe('shipRoute — trasa podľa stavu (harbor_01)', () => {
  const lane = MAP.seaLane.map(cellCenter);

  it('inbound = seaLane, undocking = koniec seaLane, outbound = seaLane odzadu, docked = prázdna', () => {
    const world = newWorld();
    expect(shipRoute(freshShip('inbound'), world)).toEqual(lane);
    expect(shipRoute(freshShip('undocking'), world)).toEqual([lane.at(-1)]);
    expect(shipRoute(freshShip('outbound'), world)).toEqual([...lane].reverse());
    expect(shipRoute(freshShip('docked'), world)).toEqual([]);
    expect(lane).toEqual([
      { x: 48.5, y: 0.5 },
      { x: 48.5, y: 7.5 },
      { x: 44.5, y: 7.5 },
    ]);
  });

  it('waiting_anchorage = pridelená bunka anchorage, bez nej prázdna', () => {
    const world = newWorld();
    const waiting = freshShip('waiting_anchorage');
    expect(shipRoute(waiting, world)).toEqual([]);
    waiting.anchorageIndex = 1;
    expect(shipRoute(waiting, world)).toEqual([{ x: 52.5, y: 7.5 }]);
  });

  it('berthing = dockPoint od prvého obsadeného kotviska; chýbajúce kotvisko → ShipError(inconsistent)', () => {
    const world = newWorld();
    const east = placeModule(world, 'berth_standard', EAST_BERTH);
    const berthing = new Ship({
      id: 99 as EntityId,
      def: HANDY,
      cargoType: SHIP_DEFS.cargoTypes.get(TEU),
      state: 'berthing',
      x: 44.5,
      y: 7.5,
      heading: 180,
      berthIds: [ROOT_BERTH_ID, east],
    });
    expect(shipRoute(berthing, world)).toEqual([{ x: 45, y: 13 }]);
    berthing.berthIds = [777 as EntityId];
    expect(() => shipRoute(berthing, world)).toThrow(ShipError);
  });
});
