/**
 * Blokovanie žeriavu pri plnom aprone (T02-06, TDD; ARCHITECTURE §7.2, §7.8 bod 4, karta T02-05):
 * po `f2_unload` je apron Root berthu plný (4/4; testy majú pripnutý pôvodný balans `LEGACY_CAPACITY_DEFS`, Fáza 5b zväčšila apron na 8). Ďalší feeder so 4 TEU zakotví, ale žeriav nemá kam odložiť →
 * `blocked`, `CraneBlocked { reason: 'apron_full' }` najviac raz za hernú hodinu na žeriav, náklad ostáva na lodi.
 * Zámerný herný tlak (§7.8): loď stojí, kým sa apron neuvoľní — vo F2 to nikto neurobí, takže stojí až do konca behu.
 *
 * Hodina udalosti = `world.clock.gameHour` po ticku, v ktorom udalosť vznikla (`TimedEvent.hour`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { World } from '@sim/world';
import {
  SECOND_CRANE_CELL,
  ROOT_BERTH_CELL,
  at,
  berthAt,
  cranesOf,
  craneById,
  firstSampleInState,
  must,
  placeModuleCommand,
  recordRun,
  removeModuleCommand,
  samplesOf,
  spawnShipCommand,
  spawnedShipIds,
  timedOfType,
  withCommands,
  type RunLog,
  type TimedEvent,
} from '../helpers/harbor';
import { loadScenarioFile } from '../helpers/scenario';
import { LEGACY_CAPACITY_DEFS as DEFS, MAP } from '../world/world-fixtures';

const RUN_TICKS = 5000;
const SECOND_SHIP_TICK = 1500;
const UNITS = 4;
/** Horná hranica dokovania druhej lode po spawne. */
const DOCK_DEADLINE_TICKS = 1000;
/** Minimum blokovaných tickov: loď zakotví do ~1 700 a žeriav sa blokuje až do 5 000. */
const MIN_BLOCKED_TICKS = 1000;

const base = loadScenarioFile('f2_unload');

/** Najväčší počet udalostí jedného žeriava v jednej hernej hodine. */
function maxPerCraneHour(events: readonly TimedEvent[]): number {
  const counts = new Map<string, number>();
  for (const entry of events) {
    const event = entry.event;
    if (event.type !== 'CraneBlocked') continue;
    const key = `${String(event.craneId)}:${String(entry.hour)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

// ---------------------------------------------------------------------------------------------------------
// Jeden žeriav (Root)
// ---------------------------------------------------------------------------------------------------------

describe('žeriav sa pri plnom aprone zablokuje (jeden Root žeriav)', () => {
  const scenario = withCommands(base, at(SECOND_SHIP_TICK, spawnShipCommand('feeder', UNITS)));
  let world: World;
  let log: RunLog;
  let rootBerthId: EntityId;
  let rootCraneId: EntityId;
  let firstShip: EntityId;
  let secondShip: EntityId;

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    const berth = berthAt(world, ROOT_BERTH_CELL);
    rootBerthId = berth.id;
    rootCraneId = berth.craneIds[0];
    log = recordRun(world, scenario, RUN_TICKS);
    [firstShip, secondShip] = spawnedShipIds(log);
  });

  it('prvá loď naplní apron (4/4) pred príchodom druhej a odpláva; druhá loď zakotví na Root berthe', () => {
    expect(firstShip).toBeDefined();
    expect(secondShip).toBeDefined();
    const filled = timedOfType(log, 'CargoMoved').filter((m) => m.event.to.kind === 'on_apron' && m.tick <= SECOND_SHIP_TICK);
    expect(filled).toHaveLength(UNITS);
    expect(timedOfType(log, 'ShipDeparted').map((e) => e.event.shipId)).toContain(firstShip);

    const docked = must(firstSampleInState(samplesOf(log, secondShip), 'docked'), 'druhá loď v stave docked');
    expect(docked.tick).toBeGreaterThan(SECOND_SHIP_TICK);
    expect(docked.tick).toBeLessThanOrEqual(SECOND_SHIP_TICK + DOCK_DEADLINE_TICKS);
    expect(docked.berthIds).toEqual([rootBerthId]);
  });

  it('žeriav skončí v stave blocked, nič nedrží a jeho počítadlá odrážajú prácu, nečinnosť aj blokovanie', () => {
    const crane = craneById(world, rootCraneId);
    expect(crane.state).toBe('blocked');
    expect(crane.heldUnitId).toBeNull();
    expect(world.cargo.countByKind('in_crane')).toBe(0);
    expect(crane.busyTicks).toBeGreaterThan(0); // vykládka prvej lode
    expect(crane.idleTicks).toBeGreaterThan(0); // čakanie na prvú loď
    expect(crane.blockedTicks).toBeGreaterThanOrEqual(MIN_BLOCKED_TICKS);
    expect(crane.busyTicks + crane.idleTicks + crane.blockedTicks).toBeLessThanOrEqual(RUN_TICKS);
  });

  it('CraneBlocked { craneId, berthId, reason: apron_full } sa za 5 000 tickov objaví aspoň raz, nie pred dokovaním druhej lode', () => {
    const blocked = timedOfType(log, 'CraneBlocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    for (const entry of blocked) {
      expect(entry.event).toMatchObject({ craneId: rootCraneId, berthId: rootBerthId, reason: 'apron_full' });
    }
    const dockedTick = must(firstSampleInState(samplesOf(log, secondShip), 'docked'), 'druhá loď v stave docked').tick;
    expect(blocked[0].tick).toBeGreaterThanOrEqual(dockedTick);
  });

  it('CraneBlocked sa v žiadnej hernej hodine neemituje viac ako raz na žeriav', () => {
    const blocked = timedOfType(log, 'CraneBlocked');
    // Beh zasahuje viac hodín, takže throttle má čo obmedzovať.
    const ticksPerHour = world.clock.ticksPerHour;
    expect(RUN_TICKS - blocked[0].tick).toBeGreaterThan(3 * ticksPerHour);
    expect(maxPerCraneHour(log.events)).toBeLessThanOrEqual(1);
    expect(blocked.length).toBeLessThanOrEqual(Math.ceil(RUN_TICKS / ticksPerHour));
  });

  it('náklad druhej lode ostáva 4 jednotky celý čas po dokovaní a jej jednotky sa nepohli', () => {
    const samples = samplesOf(log, secondShip);
    const dockedTick = must(firstSampleInState(samples, 'docked'), 'druhá loď v stave docked').tick;
    for (const sample of samples.filter((s) => s.tick >= dockedTick)) {
      expect(sample.unitsOnBoard, `tick ${String(sample.tick)}`).toBe(UNITS);
    }
    expect(world.cargo.unitsOnShip(secondShip)).toHaveLength(UNITS);
    const laterMoves = timedOfType(log, 'CargoMoved').filter((m) => m.tick > SECOND_SHIP_TICK + 1);
    expect(laterMoves).toEqual([]);
  });

  it('apron ostáva plný s pôvodnými 4 jednotkami a žeriav po zablokovaní nespraví žiadny ďalší cyklus', () => {
    expect(world.cargo.countByKind('on_apron')).toBe(UNITS);
    expect(world.cargo.unitsOnApron(rootBerthId)).toHaveLength(UNITS);
    expect(world.cargo.createdCount).toBe(2 * UNITS);
    expect(timedOfType(log, 'CraneCycleDone')).toHaveLength(UNITS);
  });

  it('druhá loď zostane docked na Root berthe (nikdy neodíde s nákladom) a berth ju drží', () => {
    const ship = must(world.ships.get(secondShip), 'druhá loď vo world.ships');
    expect(ship.state).toBe('docked');
    expect(ship.berthIds).toEqual([rootBerthId]);
    expect(berthAt(world, ROOT_BERTH_CELL).dockedShipId).toBe(secondShip);
    expect(timedOfType(log, 'ShipUndocked').map((e) => e.event.shipId)).toEqual([firstShip]);
    expect(timedOfType(log, 'ShipDeparted').map((e) => e.event.shipId)).toEqual([firstShip]);
  });

  it('nič nie je odmietnuté a hotovosť sa nezmenila', () => {
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
  });

  // T02-14 (review T02-13 MAJOR): blokovaný žeriav pod dokovanou loďou nejde odstrániť — loď by bez žeriavu ostala
  // pri kotvisku naveky s nákladom. Posledný test bloku: pridá príkaz až po všetkých kontrolách behu.
  it('RemoveModule(Root žeriav) pri dokovanej lodi → CommandRejected { ship_docked }, žeriav ostane blocked', () => {
    world.enqueue(commandFromJSON(removeModuleCommand(rootCraneId)));
    const events = world.applyPending();
    expect(events.filter((event) => event.type === 'CommandRejected')).toEqual([
      { type: 'CommandRejected', commandType: 'RemoveModule', reasons: ['ship_docked'] },
    ]);
    expect(craneById(world, rootCraneId).state).toBe('blocked');
    expect(berthAt(world, ROOT_BERTH_CELL).craneIds).toEqual([rootCraneId]);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Dva žeriavy na jednom berthe: throttle je per žeriav
// ---------------------------------------------------------------------------------------------------------

describe('žeriav sa pri plnom aprone zablokuje (dva žeriavy na Root berthe)', () => {
  const scenario = withCommands(
    base,
    at(0, placeModuleCommand('crane_container_gantry', SECOND_CRANE_CELL)),
    at(SECOND_SHIP_TICK, spawnShipCommand('feeder', UNITS)),
  );
  let world: World;
  let log: RunLog;
  let rootBerthId: EntityId;
  let craneIds: EntityId[];

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    rootBerthId = berthAt(world, ROOT_BERTH_CELL).id;
    log = recordRun(world, scenario, RUN_TICKS);
    craneIds = cranesOf(world).map((crane) => crane.id);
  });

  it('druhý žeriav sa postaví na bunky Root berthu (maxCranes 2) a stojí 600 000 USD', () => {
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
    expect(craneIds).toHaveLength(2);
    expect(berthAt(world, ROOT_BERTH_CELL).craneIds).toEqual(craneIds);
    expect(world.grid.at(SECOND_CRANE_CELL.x, SECOND_CRANE_CELL.y).moduleId).toBe(rootBerthId);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents - DEFS.modules.get('crane_container_gantry').costCents);
  });

  it('oba žeriavy sa podieľajú na vykládke prvej lode (spolu 4 cykly, každý aspoň jeden)', () => {
    const done = timedOfType(log, 'CraneCycleDone');
    expect(done).toHaveLength(UNITS);
    expect(new Set(done.map((entry) => entry.event.unitId)).size).toBe(UNITS);
    for (const craneId of craneIds) {
      expect(done.filter((entry) => entry.event.craneId === craneId).length, `žeriav ${String(craneId)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('po zaplnení apronu sa zablokujú oba žeriavy, každý emituje CraneBlocked aspoň raz', () => {
    for (const craneId of craneIds) {
      const crane = craneById(world, craneId);
      expect(crane.state, `žeriav ${String(craneId)}`).toBe('blocked');
      expect(crane.heldUnitId).toBeNull();
      expect(crane.blockedTicks).toBeGreaterThanOrEqual(MIN_BLOCKED_TICKS);

      const own = timedOfType(log, 'CraneBlocked').filter((entry) => entry.event.craneId === craneId);
      expect(own.length, `CraneBlocked žeriava ${String(craneId)}`).toBeGreaterThanOrEqual(1);
      for (const entry of own) expect(entry.event).toMatchObject({ berthId: rootBerthId, reason: 'apron_full' });
    }
  });

  it('CraneBlocked sa v žiadnej hernej hodine neemituje viac ako raz na žeriav (throttle je per žeriav, nie globálny)', () => {
    // Globálny throttle by druhému žeriavu v tej istej hodine udalosť zhltol (pozri predošlý test: každý má >= 1).
    expect(maxPerCraneHour(log.events)).toBeLessThanOrEqual(1);
  });

  it('náklad druhej lode ostáva 4, apron je plný a druhá loď stojí docked', () => {
    const [, second] = spawnedShipIds(log);
    expect(world.ships.get(second)?.state).toBe('docked');
    expect(world.cargo.unitsOnShip(second)).toHaveLength(UNITS);
    expect(world.cargo.countByKind('on_apron')).toBe(UNITS);
    expect(world.cargo.countByKind('in_crane')).toBe(0);
    expect(timedOfType(log, 'CraneCycleDone')).toHaveLength(UNITS);
  });
});
