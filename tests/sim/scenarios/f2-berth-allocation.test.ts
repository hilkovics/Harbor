/**
 * BerthGroup a alokácia kotvísk (T02-06, TDD; ARCHITECTURE §5.4, karta T02-05 „BerthAllocator").
 *
 *  - Skupina = berthy s dotýkajúcimi sa krátkymi hranami na tom istom pobreží; `totalLength` = súčet dĺžok.
 *  - `handy` (10 buniek) potrebuje skupinu s `totalLength ≥ 10` → Root (8) samotný nestačí, s druhým berthom (16) áno.
 *  - `feeder` (6 buniek) stačí jeden berth.
 *  - Loď bez vhodnej skupiny čaká na anchorage (`waiting_anchorage`), nie na kotvisku.
 *
 * Mapa harbor_01: Root berth x 40–47, y 14–16; voľné miesta na starter parcele (x 30–57): (48,14) tesne vedľa Rootu,
 * (32,14) tesne pred Rootom, (30,14) s medzerou x 38–39 od Rootu. Testy idú cez JSON príkazy a verejné API.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import { World } from '@sim/world';
import {
  EAST_BERTH_CELL,
  GAP_BERTH_CELL,
  ROOT_BERTH_CELL,
  WEST_ADJACENT_BERTH_CELL,
  at,
  berthAt,
  craneById,
  emptyScenario,
  firstSampleInState,
  must,
  placeModuleCommand,
  recordRun,
  removeModuleCommand,
  samplesOf,
  shipStateSequenceViolation,
  spawnShipCommand,
  spawnedShipIds,
  stateSequence,
  timedOfType,
  withCommands,
  type RunLog,
  type ShipSample,
} from '../helpers/harbor';
import { eventsOfType, type ScenarioEntry } from '../helpers/scenario';
import { DEFS, MAP } from '../world/world-fixtures';

const SEED = 2003;
const UNITS = 4;
const BERTH_COST = DEFS.modules.get('berth_standard').costCents;
const BERTH_LENGTH = DEFS.modules.get('berth_standard').footprint.w;
const HANDY_LENGTH = DEFS.ships.get('handy').lengthCells;
const FEEDER_LENGTH = DEFS.ships.get('feeder').lengthCells;
/** Karta T02-06: po 1 500 tickoch je handy bez druhého berthu stále v `waiting_anchorage`. */
const WAIT_TICKS = 1500;
/** Horná hranica dokovania po tom, čo je berth k dispozícii (rádovo 150 tickov plavby). */
const DOCK_DEADLINE_TICKS = 1500;
const DEPART_DEADLINE_TICKS = 3000;

const newWorld = (): World => World.create(DEFS, MAP, SEED);

/** Aplikuje príkazy hneď (bez posunu času) a vráti udalosti. */
function applyNow(world: World, ...commands: SerializedCommand[]): readonly SimEvent[] {
  for (const command of commands) world.enqueue(commandFromJSON(command));
  return world.applyPending();
}

/** Postaví berth na `cell`; odmietnutie = chyba testu. Vráti id nového modulu z mriežky. */
function placeBerth(world: World, cell: CellCoord): EntityId {
  const events = applyNow(world, placeModuleCommand('berth_standard', cell));
  expect(eventsOfType(events, 'CommandRejected'), `PlaceModule berth_standard (${String(cell.x)},${String(cell.y)})`).toEqual([]);
  return must(world.grid.at(cell.x, cell.y).moduleId, `berth na (${String(cell.x)}, ${String(cell.y)})`);
}

const scenarioOf = (id: string, ...entries: readonly ScenarioEntry[]) => withCommands(emptyScenario(id, SEED), ...entries);

// ---------------------------------------------------------------------------------------------------------
// BerthGroup
// ---------------------------------------------------------------------------------------------------------

describe('BerthGroup: skupiny kotvísk', () => {
  it('štart: Root berth tvorí jedinú skupinu s id 1, dĺžkou 8 a minDepth 1', () => {
    const world = newWorld();
    const root = berthAt(world, ROOT_BERTH_CELL);
    expect(world.berthGroups).toHaveLength(1);
    const [group] = world.berthGroups;
    expect(group.id).toBe(1);
    expect(group.berthIds).toEqual([root.id]);
    expect(group.totalLength).toBe(BERTH_LENGTH);
    expect(group.minDepth).toBe(1);
    expect(root.groupId).toBe(group.id);
  });

  it('PlaceModule berth_standard (48,14,0) vedľa Rootu: jedna skupina totalLength 16 s oboma berthmi', () => {
    const world = newWorld();
    const root = berthAt(world, ROOT_BERTH_CELL);
    const events = applyNow(world, placeModuleCommand('berth_standard', EAST_BERTH_CELL));

    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
    expect(eventsOfType(events, 'ModulePlaced')).toHaveLength(1);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents - BERTH_COST);

    const east = berthAt(world, EAST_BERTH_CELL);
    expect(world.berthGroups).toHaveLength(1);
    const [group] = world.berthGroups;
    expect(group.totalLength).toBe(2 * BERTH_LENGTH);
    expect(group.totalLength).toBe(16);
    expect(group.minDepth).toBe(1);
    expect(new Set(group.berthIds)).toEqual(new Set([root.id, east.id]));
    expect(group.berthIds).toHaveLength(2);
    expect(root.groupId).toBe(group.id);
    expect(east.groupId).toBe(group.id);
  });

  it('berth na (30,14) je od Rootu oddelený medzerou → samostatná skupina 8, Root ostáva 8', () => {
    const world = newWorld();
    const root = berthAt(world, ROOT_BERTH_CELL);
    const gapId = placeBerth(world, GAP_BERTH_CELL);

    expect(world.berthGroups).toHaveLength(2);
    expect(world.berthGroups.map((group) => group.totalLength)).toEqual([8, 8]);
    const rootGroup = must(world.berthGroups.find((group) => group.berthIds.includes(root.id)), 'skupina s Rootom');
    const gapGroup = must(world.berthGroups.find((group) => group.berthIds.includes(gapId)), 'skupina s berthom (30,14)');
    expect(rootGroup.id).not.toBe(gapGroup.id);
    expect(rootGroup.berthIds).toEqual([root.id]);
    expect(gapGroup.berthIds).toEqual([gapId]);
    expect(new Set(world.berthGroups.map((group) => group.id)).size).toBe(2);
  });

  it('(30,14) aj (48,14) naraz: skupiny 16 a 8, každý berth je v práve jednej skupine a groupId zodpovedá', () => {
    const world = newWorld();
    const root = berthAt(world, ROOT_BERTH_CELL);
    const gapId = placeBerth(world, GAP_BERTH_CELL);
    const eastId = placeBerth(world, EAST_BERTH_CELL);

    expect(world.berthGroups.map((group) => group.totalLength).sort((a, b) => a - b)).toEqual([8, 16]);
    const allIds = world.berthGroups.flatMap((group) => group.berthIds);
    expect(allIds.slice().sort((a, b) => a - b)).toEqual([root.id, gapId, eastId].sort((a, b) => a - b));
    for (const group of world.berthGroups) {
      for (const berthId of group.berthIds) {
        const module = must(world.modules.get(berthId), `modul ${String(berthId)}`);
        expect(berthAt(world, module.origin).groupId).toBe(group.id);
      }
    }
  });

  it('tri susedné berthy (32, 40, 48): skupina 24, poradie po pobreží je monotónne v x nezávisle od poradia stavby', () => {
    const world = newWorld();
    const eastId = placeBerth(world, EAST_BERTH_CELL); // najprv východný,
    const westId = placeBerth(world, WEST_ADJACENT_BERTH_CELL); // potom západný — poradie stavby ≠ poradie po pobreží

    expect(world.berthGroups).toHaveLength(1);
    const [group] = world.berthGroups;
    expect(group.totalLength).toBe(3 * BERTH_LENGTH);
    expect(group.berthIds).toHaveLength(3);
    expect(new Set(group.berthIds)).toEqual(new Set([berthAt(world, ROOT_BERTH_CELL).id, eastId, westId]));

    const xs = group.berthIds.map((id) => must(world.modules.get(id), `modul ${String(id)}`).origin.x);
    const ascending = [...xs].sort((a, b) => a - b);
    const descending = [...ascending].reverse();
    expect([ascending, descending], `berthIds po pobreží mali x = ${xs.join(', ')}`).toContainEqual(xs);
  });

  it('poradie berthIds v skupine je deterministické (dva svety s rovnakými príkazmi dajú rovnaké polia)', () => {
    const build = (): readonly (readonly EntityId[])[] => {
      const world = newWorld();
      placeBerth(world, EAST_BERTH_CELL);
      placeBerth(world, WEST_ADJACENT_BERTH_CELL);
      return world.berthGroups.map((group) => group.berthIds);
    };
    expect(build()).toEqual(build());
  });

  it('RemoveModule susedného berthu vráti skupinu na 8 a vráti polovicu zaplatenej ceny', () => {
    const world = newWorld();
    const root = berthAt(world, ROOT_BERTH_CELL);
    const eastId = placeBerth(world, EAST_BERTH_CELL);
    expect(world.berthGroups[0].totalLength).toBe(16);

    const events = applyNow(world, removeModuleCommand(eastId));
    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
    expect(eventsOfType(events, 'ModuleRemoved')).toHaveLength(1);
    expect(world.modules.has(eastId)).toBe(false);
    expect(world.grid.at(EAST_BERTH_CELL.x, EAST_BERTH_CELL.y).moduleId).toBeNull();

    expect(world.berthGroups).toHaveLength(1);
    expect(world.berthGroups[0].berthIds).toEqual([root.id]);
    expect(world.berthGroups[0].totalLength).toBe(BERTH_LENGTH);
    expect(world.cashCents).toBe(
      DEFS.economy.startingCashCents - BERTH_COST + Math.floor(BERTH_COST * DEFS.economy.removalRefundRate),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------
// Alokácia: handy (10) bez druhého berthu čaká
// ---------------------------------------------------------------------------------------------------------

describe('alokácia: handy bez skupiny dĺžky ≥ 10 čaká na anchorage', () => {
  const runs = [
    { name: 'samotný Root (skupina 8)', commands: [] as ScenarioEntry[] },
    { name: 'Root a oddelený berth (30,14) — dve skupiny po 8, žiadna nie je súvislých 10', commands: [at(0, placeModuleCommand('berth_standard', GAP_BERTH_CELL))] },
  ];

  describe.each(runs)('$name', ({ commands }) => {
    let world: World;
    let log: RunLog;
    let shipId: EntityId;

    beforeAll(() => {
      world = newWorld();
      log = recordRun(world, scenarioOf('f2_handy_waits', ...commands, at(0, spawnShipCommand('handy', UNITS))), WAIT_TICKS);
      shipId = spawnedShipIds(log)[0];
    });

    it(`po ${String(WAIT_TICKS)} tickoch je handy v stave waiting_anchorage, bez berthu`, () => {
      expect(HANDY_LENGTH).toBeGreaterThan(BERTH_LENGTH); // predpoklad testu: handy je dlhšia než jeden berth
      expect(world.ships.get(shipId)?.state).toBe('waiting_anchorage');
      expect(world.ships.get(shipId)?.berthIds).toEqual([]);
      const sequence = stateSequence(samplesOf(log, shipId));
      expect(shipStateSequenceViolation(sequence)).toBeNull();
      expect(sequence).toContain('waiting_anchorage');
      expect(sequence).not.toContain('berthing');
      expect(sequence).not.toContain('docked');
      expect(timedOfType(log, 'ShipDocked')).toEqual([]);
    });

    it('čaká na prvej voľnej bunke anchorage', () => {
      const anchor = MAP.anchorage[0];
      const ship = must(world.ships.get(shipId), 'handy vo world.ships');
      // Stred lode leží v bunke kotviska (alebo na jej okraji, ak sa poloha zapisuje ako roh bunky).
      expect(ship.x).toBeGreaterThanOrEqual(anchor.x);
      expect(ship.x).toBeLessThanOrEqual(anchor.x + 1);
      expect(ship.y).toBeGreaterThanOrEqual(anchor.y);
      expect(ship.y).toBeLessThanOrEqual(anchor.y + 1);
    });

    it('nič sa nevyložilo: berthy sú voľné, náklad je na lodi, žeriav nečinný', () => {
      const root = berthAt(world, ROOT_BERTH_CELL);
      expect(root.dockedShipId).toBeNull();
      expect(world.cargo.unitsOnShip(shipId)).toHaveLength(UNITS);
      expect(world.cargo.countByKind('on_apron')).toBe(0);
      expect(world.cargo.countByKind('in_crane')).toBe(0);
      expect(timedOfType(log, 'CargoMoved')).toEqual([]);
      const crane = craneById(world, root.craneIds[0]);
      expect(crane.state).toBe('idle');
      expect(crane.busyTicks).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Alokácia: handy s druhým berthom zaberie oba berthy skupiny 16
// ---------------------------------------------------------------------------------------------------------

describe('alokácia: handy so skupinou 16 zakotví na dvoch berthoch', () => {
  let world: World;
  let log: RunLog;
  let shipId: EntityId;
  let rootId: EntityId;
  let eastId: EntityId;

  beforeAll(() => {
    world = newWorld();
    rootId = berthAt(world, ROOT_BERTH_CELL).id;
    log = recordRun(
      world,
      scenarioOf(
        'f2_handy_two_berths',
        at(0, placeModuleCommand('berth_standard', EAST_BERTH_CELL)),
        at(0, spawnShipCommand('handy', UNITS)),
      ),
      DEPART_DEADLINE_TICKS,
    );
    eastId = must(world.grid.at(EAST_BERTH_CELL.x, EAST_BERTH_CELL.y).moduleId, 'berth (48,14)');
    shipId = spawnedShipIds(log)[0];
  });

  it(`handy zakotví do ${String(DOCK_DEADLINE_TICKS)} tickov a berthIds.length === 2 (Root aj (48,14))`, () => {
    const docked = must(firstSampleInState(samplesOf(log, shipId), 'docked'), 'handy v stave docked');
    expect(docked.tick).toBeLessThanOrEqual(DOCK_DEADLINE_TICKS);
    expect(docked.berthIds).toHaveLength(2);
    expect(new Set(docked.berthIds)).toEqual(new Set([rootId, eastId]));
    expect(docked.berthDockedShipIds).toEqual([shipId, shipId]);

    const events = timedOfType(log, 'ShipDocked');
    expect(events).toHaveLength(1);
    expect(events[0].event.berthIds).toHaveLength(2);
    expect(new Set(events[0].event.berthIds)).toEqual(new Set([rootId, eastId]));
  });

  it('handy stojí rovnobežne s nábrežím pred oboma berthmi (x od 40 do 56, y < 14)', () => {
    const docked = must(firstSampleInState(samplesOf(log, shipId), 'docked'), 'handy v stave docked');
    expect([90, 270]).toContain(docked.heading);
    expect(docked.x).toBeGreaterThanOrEqual(ROOT_BERTH_CELL.x);
    expect(docked.x).toBeLessThanOrEqual(EAST_BERTH_CELL.x + BERTH_LENGTH);
    expect(docked.y).toBeLessThan(ROOT_BERTH_CELL.y);
  });

  it('Root žeriav vyloží náklad na Root apron, handy odpláva a oba berthy sa uvoľnia', () => {
    expect(world.cargo.unitsOnApron(rootId)).toHaveLength(UNITS);
    expect(world.cargo.unitsOnApron(eastId)).toEqual([]);
    expect(world.cargo.countByKind('on_ship')).toBe(0);

    const departed = timedOfType(log, 'ShipDeparted');
    expect(departed.map((entry) => entry.event.shipId)).toEqual([shipId]);
    expect(departed[0].tick).toBeLessThanOrEqual(DEPART_DEADLINE_TICKS);
    expect(world.ships.size).toBe(0);
    expect(berthAt(world, ROOT_BERTH_CELL).dockedShipId).toBeNull();
    expect(berthAt(world, EAST_BERTH_CELL).dockedShipId).toBeNull();
  });

  it('stavy handy idú v poradí FSM cez docked a outbound', () => {
    const sequence = stateSequence(samplesOf(log, shipId));
    expect(shipStateSequenceViolation(sequence)).toBeNull();
    expect(sequence).toContain('docked');
    expect(sequence).toContain('outbound');
  });
});

describe('alokácia: druhý berth pribudne, kým handy už čaká na anchorage', () => {
  const PLACE_AT = 800;
  let log: RunLog;
  let world: World;
  let shipId: EntityId;

  beforeAll(() => {
    world = newWorld();
    log = recordRun(
      world,
      scenarioOf(
        'f2_handy_waits_then_docks',
        at(0, spawnShipCommand('handy', UNITS)),
        at(PLACE_AT, placeModuleCommand('berth_standard', EAST_BERTH_CELL)),
      ),
      PLACE_AT + DOCK_DEADLINE_TICKS,
    );
    shipId = spawnedShipIds(log)[0];
  });

  it('do postavenia berthu čaká (waiting_anchorage), potom prejde berthing → docked na dvoch berthoch', () => {
    const samples = samplesOf(log, shipId);
    const before = samples.filter((sample) => sample.tick <= PLACE_AT);
    expect(before.length).toBeGreaterThan(0);
    for (const sample of before) expect(['inbound', 'waiting_anchorage'], `tick ${String(sample.tick)}`).toContain(sample.state);
    expect(before.at(-1)?.state).toBe('waiting_anchorage');

    const sequence = stateSequence(samples);
    expect(shipStateSequenceViolation(sequence)).toBeNull();
    expect(sequence).toContain('waiting_anchorage');
    const docked = must(firstSampleInState(samples, 'docked'), 'handy v stave docked');
    expect(docked.tick).toBeGreaterThan(PLACE_AT);
    expect(docked.berthIds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Alokácia: feeder (6) stačí jeden berth
// ---------------------------------------------------------------------------------------------------------

describe('alokácia: feeder pri skupine 16 obsadí jeden berth', () => {
  let world: World;
  let log: RunLog;
  let shipId: EntityId;
  let rootId: EntityId;
  let eastId: EntityId;
  /** `dockedShipId` oboch berthov po každom ticku. */
  const occupancy: { tick: number; root: EntityId | null; east: EntityId | null }[] = [];

  beforeAll(() => {
    world = newWorld();
    rootId = berthAt(world, ROOT_BERTH_CELL).id;
    log = recordRun(
      world,
      scenarioOf(
        'f2_feeder_one_berth',
        at(0, placeModuleCommand('berth_standard', EAST_BERTH_CELL)),
        at(0, spawnShipCommand('feeder', UNITS)),
      ),
      DEPART_DEADLINE_TICKS,
      {
        onTick: (w) => {
          occupancy.push({
            tick: w.clock.tick,
            root: berthAt(w, ROOT_BERTH_CELL).dockedShipId,
            east: berthAt(w, EAST_BERTH_CELL).dockedShipId,
          });
        },
      },
    );
    eastId = must(world.grid.at(EAST_BERTH_CELL.x, EAST_BERTH_CELL.y).moduleId, 'berth (48,14)');
    shipId = spawnedShipIds(log)[0];
  });

  it('feeder (6) zakotví na jednom berthe skupiny (berthIds.length === 1), druhý berth ostane voľný', () => {
    expect(FEEDER_LENGTH).toBeLessThanOrEqual(BERTH_LENGTH); // predpoklad testu: feeder sa zmestí na jeden berth
    const docked = must(firstSampleInState(samplesOf(log, shipId), 'docked'), 'feeder v stave docked');
    expect(docked.tick).toBeLessThanOrEqual(DOCK_DEADLINE_TICKS);
    expect(docked.berthIds).toHaveLength(1);
    expect([rootId, eastId]).toContain(docked.berthIds[0]);

    const events = timedOfType(log, 'ShipDocked');
    expect(events).toHaveLength(1);
    expect(events[0].event.berthIds).toHaveLength(1);

    const held = occupancy.filter((entry) => entry.tick === docked.tick);
    expect(held).toHaveLength(1);
    const occupied = [held[0].root, held[0].east].filter((id) => id !== null);
    expect(occupied).toEqual([shipId]);
  });

  it('feeder sa v skupine s Root žeriavom vyloží a odpláva (4 jednotky na Root aprone)', () => {
    // Žeriav stojí na Root berthe; feeder musí zakotviť tam (alebo byť obsluhovaný žeriavom skupiny), inak sa nevyloží.
    expect(world.cargo.unitsOnApron(rootId)).toHaveLength(UNITS);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(timedOfType(log, 'ShipDeparted').map((entry) => entry.event.shipId)).toEqual([shipId]);
    expect(world.ships.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Alokácia: skupina bez žeriava sa nepoužije, FIFO
// ---------------------------------------------------------------------------------------------------------

describe('alokácia: loď nezaberie skupinu bez žeriava, čakajúce lode idú FIFO', () => {
  let world: World;
  let log: RunLog;
  let first: EntityId;
  let second: EntityId;
  let rootId: EntityId;
  let gapId: EntityId;

  beforeAll(() => {
    world = newWorld();
    rootId = berthAt(world, ROOT_BERTH_CELL).id;
    log = recordRun(
      world,
      scenarioOf(
        'f2_fifo_no_crane_group',
        at(0, placeModuleCommand('berth_standard', GAP_BERTH_CELL)), // samostatná skupina 8 bez žeriava
        at(0, spawnShipCommand('feeder', UNITS)),
        at(0, spawnShipCommand('feeder', UNITS)),
      ),
      DEPART_DEADLINE_TICKS,
    );
    gapId = must(world.grid.at(GAP_BERTH_CELL.x, GAP_BERTH_CELL.y).moduleId, 'berth (30,14)');
    [first, second] = spawnedShipIds(log);
  });

  it('žiadna loď nikdy nedostane berth (30,14) bez žeriava', () => {
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    for (const shipId of [first, second]) {
      for (const sample of samplesOf(log, shipId)) {
        expect(sample.berthIds, `loď ${String(shipId)}, tick ${String(sample.tick)}`).not.toContain(gapId);
      }
    }
    expect(berthAt(world, GAP_BERTH_CELL).dockedShipId).toBeNull();
  });

  it('prvá loď (FIFO podľa spawnu) zakotví na Roote; druhá čaká, kým prvá berth nepustí', () => {
    const a = samplesOf(log, first);
    const b = samplesOf(log, second);
    const firstDocked = must(firstSampleInState(a, 'docked'), 'prvá loď v stave docked');
    expect(firstDocked.berthIds).toEqual([rootId]);

    const holdingRoot = new Set(['berthing', 'docked']);
    for (const sample of a.filter((s) => holdingRoot.has(s.state))) {
      const other = must(b.find((s) => s.tick === sample.tick), `vzorka druhej lode v ticku ${String(sample.tick)}`);
      expect(['inbound', 'waiting_anchorage'], `druhá loď, tick ${String(sample.tick)}`).toContain(other.state);
    }
    expect(stateSequence(b)).toContain('waiting_anchorage');
  });

  it('druhá loď zakotví na Roote až po tom, čo prvá začala odchádzať', () => {
    const a = samplesOf(log, first);
    const b = samplesOf(log, second);
    const released: ShipSample = must(firstSampleInState(a, 'undocking') ?? firstSampleInState(a, 'outbound'), 'prvá loď undocking/outbound');
    const secondDocked = must(firstSampleInState(b, 'docked'), 'druhá loď v stave docked');
    expect(secondDocked.berthIds).toEqual([rootId]);
    expect(secondDocked.tick).toBeGreaterThanOrEqual(released.tick);
    expect(secondDocked.tick).toBeLessThanOrEqual(DEPART_DEADLINE_TICKS);
  });
});
