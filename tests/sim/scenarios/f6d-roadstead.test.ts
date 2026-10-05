/**
 * Scenáre F6d — rejda a priamy vstup lode bez voľného kotviska (T6D-03, ADR-029 dodatok; spätná väzba z hrania 2) na skutočných
 * scenároch harbor_01:
 *  - `multi_ship_queue` (jedno kotvisko, päť lodí, seed 6006): štyri lode čakajú na rejde; po **každom** ticku sa lode neprekrývajú
 *    (nezávislá kontrola cez `shipCells`), konzervácia nákladu a invarianty sveta držia, loď na rejde stojí s kurzom mapy;
 *    každá loď mierená na rejdu plávala priamo (dĺžka trasy zo vstupu ≤ Manhattan + obchádzka okolo lode na rejde) a nezašla na koniec
 *    sea lane pri prístave ani do pásu pred Root kotviskom; kotvisko dostávajú lode FIFO podľa id; všetky lode odplávajú (bez uviaznutia);
 *  - `live_terminal` (60 000 tickov, päť lodí, štyri toky): lode sa nikdy neprekrývajú, všetky odplávajú, stratených jednotiek 0.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { SHIP_STATE_TRAITS, shipCells, type Ship } from '@sim/ships';
import { World, findWorldViolation } from '@sim/world';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS, MAP } from '../world/world-fixtures';
import { itR1Interim } from '../helpers/r1-interim';

const RUN_TIMEOUT_MS = 300_000;

/** Prvá bunka zdieľaná dvoma loďami na mape (nezávisle od implementácie invariantu). */
function sharedCell(world: World): string | undefined {
  const owner = new Map<string, EntityId>();
  for (const ship of world.ships.values()) {
    if (!SHIP_STATE_TRAITS[ship.state].onMap) continue;
    for (const cell of shipCells(ship)) {
      const key = `${String(cell.x)},${String(cell.y)}`;
      const other = owner.get(key);
      if (other !== undefined) return `${key}: #${String(other)} a #${String(ship.id)}`;
      owner.set(key, ship.id);
    }
  }
  return undefined;
}

const resting = (ship: Ship): boolean => ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length;

describe('scenár multi_ship_queue: päť lodí, jedno kotvisko, rejda (T6D-03)', () => {
  const scenario = loadScenarioFile('multi_ship_queue');
  const world = World.create(BUNDLED_DEFS, MAP, scenario.seed);
  const overlaps: string[] = [];
  const unevenHeading: string[] = [];
  const dockOrder: EntityId[] = [];
  const spawnOrder: EntityId[] = [];
  const departed: EntityId[] = [];
  /** Dĺžka a najjužnejšia poloha plavby každej lode na jej rejdu (od vstupu po príchod). */
  const sail = new Map<EntityId, { length: number; maxY: number; anchorageIndex: number; entry: { x: number; y: number }; last: { x: number; y: number }; done: boolean; inBand: boolean }>();
  let maxResting = 0;
  let maxOnLane = 0;
  let allDeparted = 0;

  const root = [...world.modules.values()].find((module) => module.kind === 'berth');
  const band = (() => {
    if (root === undefined || root.kind !== 'berth') throw new Error('Root kotvisko chýba');
    const depth = 3 + 2 + 1; // frontWaterCells + šírka najširšej lode + rezerva (rovnako ako ShipTraffic.berthFronts)
    return { x0: root.origin.x, x1: root.origin.x + root.size.w, y0: root.origin.y - depth, y1: root.origin.y };
  })();

  runScenario(world, scenario, 14_000, {
    afterTick: (w, events: readonly SimEvent[]) => {
      assertCargoConservation(w);
      for (const event of events) {
        if (event.type === 'ShipSpawned') spawnOrder.push(event.shipId);
        if (event.type === 'ShipDocked') dockOrder.push(event.shipId);
        if (event.type === 'ShipDeparted') departed.push(event.shipId);
      }
      const shared = sharedCell(w);
      if (shared !== undefined) overlaps.push(`tick ${String(w.clock.tick)}: ${shared}`);
      if (w.clock.tick % 100 === 0) expect(findWorldViolation(w)).toBeUndefined();
      let onLane = 0;
      let restingCount = 0;
      for (const ship of w.ships.values()) {
        if (ship.state === 'inbound' || ship.state === 'outbound') onLane += 1;
        if (resting(ship)) {
          restingCount += 1;
          if (ship.heading !== MAP.anchorageHeading) unevenHeading.push(`tick ${String(w.clock.tick)}: ${ship.label} kurz ${String(ship.heading)}`);
        }
        if (ship.state === 'waiting_anchorage' && ship.anchorageIndex !== null) {
          let record = sail.get(ship.id);
          if (record === undefined) {
            record = { length: 0, maxY: ship.y, anchorageIndex: ship.anchorageIndex, entry: { x: ship.x, y: ship.y }, last: { x: ship.x, y: ship.y }, done: false, inBand: false };
            sail.set(ship.id, record);
          }
          if (!record.done) {
            record.length += Math.hypot(ship.x - record.last.x, ship.y - record.last.y);
            record.maxY = Math.max(record.maxY, ship.y);
            record.last = { x: ship.x, y: ship.y };
            // stred lode v páse pred Root kotviskom (plavba po sea lane popri páse okrajom obdĺžnika lode je v poriadku)
            if (ship.x >= band.x0 && ship.x < band.x1 && ship.y >= band.y0 && ship.y < band.y1) record.inBand = true;
            if (resting(ship)) record.done = true;
          }
        }
      }
      maxResting = Math.max(maxResting, restingCount);
      maxOnLane = Math.max(maxOnLane, onLane);
      if (allDeparted === 0 && w.ships.size === 0 && departed.length === spawnOrder.length && spawnOrder.length === 5) allDeparted = w.clock.tick;
    },
  });

  it('lode sa po každom ticku neprekrývajú; na sea lane je naraz najviac jedna loď; invarianty a konzervácia držia', () => {
    expect(overlaps).toEqual([]);
    expect(maxOnLane).toBeLessThanOrEqual(1);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(lostUnits(world)).toBe(0);
  });

  it('na rejde čakajú naraz aspoň tri lode a všetky stoja s jednotným kurzom mapy (anchorageHeading)', () => {
    expect(maxResting).toBeGreaterThanOrEqual(3);
    expect(unevenHeading).toEqual([]);
  });

  it('každá loď mierená na rejdu plávala priamo: dĺžka trasy zo vstupu ≤ Manhattan + obchádzka, nikdy nezašla na koniec sea lane ani stredom do pásu pred Root kotviskom', () => {
    expect(sail.size).toBe(4); // štyri lode z piatich nemali pri vstupe voľné kotvisko
    const laneEnd = MAP.seaLane[MAP.seaLane.length - 1].y + 0.5;
    for (const [id, record] of sail) {
      const cell = MAP.anchorage[record.anchorageIndex];
      const manhattan = Math.abs(cell.x + 0.5 - record.entry.x) + Math.abs(cell.y + 0.5 - record.entry.y);
      // obchádzka lode na rejde: dolu a hore o šírku radu (≤ 2 × 3 bunky) — priama trasa má presne Manhattan
      expect(record.length, `loď #${String(id)}: dĺžka trasy`).toBeLessThanOrEqual(manhattan + 2 * 3 + 1);
      expect(record.maxY, `loď #${String(id)}: najjužnejšia poloha`).toBeLessThan(laneEnd);
      expect(record.inBand, `loď #${String(id)}: pás pred kotviskom`).toBe(false);
      expect(record.done, `loď #${String(id)} dopĺňala na rejdu`).toBe(true);
    }
  });

  it('kotvisko dostávajú lode FIFO podľa id (rovnaké lode, žiadne predbiehanie) a všetky odplávajú bez uviaznutia', () => {
    expect(spawnOrder).toHaveLength(5);
    expect(dockOrder).toEqual(spawnOrder);
    expect(departed).toEqual(spawnOrder);
    expect(allDeparted).toBeGreaterThan(0);
    expect(world.ships.size).toBe(0);
  });
});

describe('scenár live_terminal: päť lodí, štyri toky v jednom prístave, 60 000 tickov (T6D-03)', () => {
  itR1Interim(
    'lode sa po každom ticku neprekrývajú, jednotný kurz na rejde, všetky odplávajú, stratených jednotiek 0',
    () => {
      const scenario = loadScenarioFile('live_terminal');
      const world = World.create(BUNDLED_DEFS, MAP, scenario.seed);
      const overlaps: string[] = [];
      const uneven: string[] = [];
      let spawned = 0;
      let departed = 0;
      runScenario(world, scenario, 60_000, {
        afterTick: (w, events: readonly SimEvent[]) => {
          for (const event of events) {
            if (event.type === 'ShipSpawned') spawned += 1;
            if (event.type === 'ShipDeparted') departed += 1;
          }
          const shared = sharedCell(w);
          if (shared !== undefined) overlaps.push(`tick ${String(w.clock.tick)}: ${shared}`);
          for (const ship of w.ships.values()) {
            if (!resting(ship)) continue;
            if (ship.heading !== MAP.anchorageHeading) uneven.push(`tick ${String(w.clock.tick)}: ${ship.label}`);
          }
          if (w.clock.tick % 500 === 0) assertCargoConservation(w);
        },
      });
      expect(overlaps).toEqual([]);
      expect(uneven).toEqual([]);
      expect([spawned, departed]).toEqual([5, 5]);
      expect(world.ships.size).toBe(0);
      // Po druhom dvore (T6D-04) sa v live_terminal žiadna loď na rejde nezdrží (objemy kontraktov a príchody lodí sú iné); čakanie na rejde s kurzom
      // a FIFO pokrýva scenár multi_ship_queue vyššie, tu ide o neprekrývanie, odchod všetkých lodí a nulové straty.
      expect(lostUnits(world)).toBe(0);
      expect(findWorldViolation(world)).toBeUndefined();
    },
    RUN_TIMEOUT_MS,
  );
});
