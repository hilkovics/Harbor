/**
 * Scenár `f1_roads` (T01-05, TDD): replay príkazov `PlaceRoad` / `RemoveRoad` / `SetGameSpeed` nad skutočným
 * `World` na mape `harbor_01`. Očakávané hodnoty (počet ciest, hotovosť, rýchlosť) počíta nezávislý referenčný
 * model v tomto súbore z defov (`infrastructure`, `economy`, `time`) a zo samotného scenára — nie sú natvrdo.
 *
 * Trasa scenára (mapa harbor_01, ADR-008):
 *  - tick 0:     zvislá cesta x=44, y=14..33 po starter parcele od nábrežia k štartovej ceste (44,34)
 *  - tick 100:   vodorovná cesta y=25, x=28..59 cez starter parcelu a verejné bunky x=28..29 a x=58..59
 *                (bunka (44,25) už cestu má → preskočí sa bez ceny)
 *  - tick 200:   SetGameSpeed(4)
 *  - tick 6000:  zvislá cesta x=29, y=14..24 po verejných bunkách vrátane nábrežia
 *  - tick 12000: RemoveRoad 6 buniek (2 verejné + 4 starter); tick 15000: RemoveRoad 1 bunky nábrežia
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import { loadBundledDefs } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { loadBundledMap, type CellCoord } from '@sim/grid';
import { World } from '@sim/world';
import { assertCargoConservation, assertRoadInvariants, countRoadCells } from '../helpers/invariants';
import {
  eventsOfType,
  loadScenarioFile,
  readRepoJson,
  runScenario,
  stateHash,
  type ScenarioEntry,
} from '../helpers/scenario';

const RUN_TICKS = 20_000;
/** Štandardná rýchlosť „1×" (ARCHITECTURE §3); počiatočná rýchlosť nového sveta. */
const STANDARD_SPEED = 1;
// Kalendár (ARCHITECTURE §3): hodina = 3600 s, deň = 24 h, mesiac = 30 dní.
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30;

const defs = loadBundledDefs();
const map = loadBundledMap();
const scenario = loadScenarioFile('f1_roads');

const ROAD_COST = defs.infrastructure.road.costPerCellCents;
const REFUND_RATE = defs.economy.removalRefundRate;

// ---------------------------------------------------------------------------------------------------------
// Referenčný model (nezávislý od implementácie: množina buniek + hotovosť + rýchlosť)
// ---------------------------------------------------------------------------------------------------------

const cellKey = (cell: CellCoord): string => `${String(cell.x)},${String(cell.y)}`;

function cellsOf(command: SerializedCommand): CellCoord[] {
  if (!Array.isArray(command.cells)) throw new Error(`príkaz ${command.type} nemá pole 'cells'`);
  return command.cells as CellCoord[];
}

interface ModelStep {
  readonly atTick: number;
  readonly type: string;
  /** Zmena hotovosti príkazom (0 pre SetGameSpeed). */
  readonly deltaCents: number;
  /** Bunky, ktorým sa zmenila vrstva cesty. */
  readonly changed: readonly string[];
}

interface Model {
  readonly roads: Set<string>;
  cashCents: number;
  speed: number;
  readonly steps: ModelStep[];
}

/** Model po aplikovaní všetkých príkazov s `atTick < tick` (svet s `clock.tick === tick` ich už aplikoval). */
function modelAt(commands: readonly ScenarioEntry[], tick: number): Model {
  const model: Model = {
    roads: new Set(map.starter.roads.map(cellKey)),
    cashCents: defs.economy.startingCashCents,
    speed: STANDARD_SPEED,
    steps: [],
  };
  for (const { atTick, command } of [...commands].sort((a, b) => a.atTick - b.atTick)) {
    if (atTick >= tick) break;
    if (command.type === 'PlaceRoad') {
      const fresh = [...new Set(cellsOf(command).map(cellKey))].filter((key) => !model.roads.has(key));
      const deltaCents = -fresh.length * ROAD_COST;
      fresh.forEach((key) => model.roads.add(key));
      model.cashCents += deltaCents;
      model.steps.push({ atTick, type: command.type, deltaCents, changed: fresh });
    } else if (command.type === 'RemoveRoad') {
      const existing = [...new Set(cellsOf(command).map(cellKey))].filter((key) => model.roads.has(key));
      const deltaCents = Math.floor(existing.length * ROAD_COST * REFUND_RATE);
      existing.forEach((key) => model.roads.delete(key));
      model.cashCents += deltaCents;
      model.steps.push({ atTick, type: command.type, deltaCents, changed: existing });
    } else if (command.type === 'SetGameSpeed') {
      model.speed = command.speed as number;
      model.steps.push({ atTick, type: command.type, deltaCents: 0, changed: [] });
    } else {
      throw new Error(`referenčný model nepozná príkaz ${command.type}`);
    }
  }
  return model;
}

// ---------------------------------------------------------------------------------------------------------
// Scenár ako dáta
// ---------------------------------------------------------------------------------------------------------

describe('scenár f1_roads: súbor', () => {
  it('má očakávaný tvar { id, seed, map, commands }', () => {
    expect(Object.keys(scenario).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect(scenario.id).toBe('f1_roads');
    expect(Number.isInteger(scenario.seed) && scenario.seed >= 0 && scenario.seed <= 0xffffffff).toBe(true);
    expect(scenario.map).toBe('data/maps/harbor_01.json');
    expect((readRepoJson(scenario.map) as { id: string }).id).toBe(map.id);
  });

  it('príkazy sú zoradené podľa atTick a všetky sa vojdú do behu', () => {
    const ticks = scenario.commands.map((e) => e.atTick);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(ticks.every((t) => Number.isInteger(t) && t >= 0 && t < RUN_TICKS)).toBe(true);
    expect(new Set(ticks).size).toBeGreaterThanOrEqual(3); // aspoň 3 rôzne ticky
  });

  it('obsahuje PlaceRoad, RemoveRoad a SetGameSpeed(4)', () => {
    const types = scenario.commands.map((e) => e.command.type);
    expect(types.filter((t) => t === 'PlaceRoad').length).toBeGreaterThanOrEqual(2);
    expect(types).toContain('RemoveRoad');
    const speeds = scenario.commands.filter((e) => e.command.type === 'SetGameSpeed').map((e) => e.command.speed);
    expect(speeds).toEqual([4]);
  });

  it('stavia aspoň 20 nových buniek ciest naprieč starter parcelou a verejnými bunkami', () => {
    const model = modelAt(scenario.commands, RUN_TICKS);
    const placed = model.steps.filter((s) => s.type === 'PlaceRoad').reduce((sum, s) => sum + s.changed.length, 0);
    expect(placed).toBeGreaterThanOrEqual(20);

    const cells = scenario.commands.filter((e) => e.command.type === 'PlaceRoad').flatMap((e) => cellsOf(e.command));
    const parcelIds = new Set(cells.map((c) => map.grid.at(c.x, c.y).parcelId));
    expect(parcelIds).toContain('starter');
    expect(parcelIds).toContain(null); // aj verejné bunky
  });

  it('každý príkaz prežije commandFromJSON → toJSON bez zmeny', () => {
    for (const { command } of scenario.commands) {
      expect(commandFromJSON(command).toJSON()).toEqual(command);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Beh scenára
// ---------------------------------------------------------------------------------------------------------

const CHECKPOINTS = [1, 100, 101, 200, 201, 5999, 6000, 6001, 11_999, 12_000, 12_001, 15_000, 15_001, RUN_TICKS];

interface Observation {
  readonly cashCents: number;
  readonly roads: number;
  readonly speed: number;
}

describe('scenár f1_roads: beh 20 000 tickov', () => {
  let world: World;
  let events: SimEvent[];
  const observed = new Map<number, Observation>();

  beforeAll(() => {
    world = World.create(defs, map, scenario.seed);
    events = runScenario(world, scenario, RUN_TICKS, {
      afterTick: (w) => {
        if (CHECKPOINTS.includes(w.clock.tick)) {
          observed.set(w.clock.tick, { cashCents: w.cashCents, roads: countRoadCells(w), speed: w.clock.speed });
        }
      },
    });
  });

  it('hodiny stoja na 20 000 a rýchlosť je 4', () => {
    expect(world.clock.tick).toBe(RUN_TICKS);
    expect(world.clock.speed).toBe(4);
    expect(defs.time.speeds).toContain(4);
  });

  it('počet ciest = štartové + nové − odstránené', () => {
    const model = modelAt(scenario.commands, RUN_TICKS + 1);
    expect(model.roads.size).toBeGreaterThan(map.starter.roads.length);
    expect(countRoadCells(world)).toBe(model.roads.size);
  });

  it('mriežka sa zhoduje s modelom bunku po bunke (aj odstránené a preskočené bunky)', () => {
    const model = modelAt(scenario.commands, RUN_TICKS + 1);
    const wrong: string[] = [];
    for (let y = 0; y < world.grid.height; y++) {
      for (let x = 0; x < world.grid.width; x++) {
        const expected = model.roads.has(cellKey({ x, y })) ? 'road' : 'none';
        if (world.grid.at(x, y).road !== expected) wrong.push(`(${String(x)},${String(y)}) očakávané ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('hotovosť = štart − cena nových buniek + refundácia odstránených', () => {
    const model = modelAt(scenario.commands, RUN_TICKS + 1);
    const placedCells = model.steps.filter((s) => s.type === 'PlaceRoad').reduce((sum, s) => sum + s.changed.length, 0);
    const removedCells = model.steps.filter((s) => s.type === 'RemoveRoad').reduce((sum, s) => sum + s.changed.length, 0);
    const expected =
      defs.economy.startingCashCents -
      placedCells * ROAD_COST +
      Math.floor(removedCells * ROAD_COST * REFUND_RATE);
    expect(placedCells).toBeGreaterThan(0);
    expect(removedCells).toBeGreaterThan(0);
    expect(world.cashCents).toBe(expected);
    expect(world.cashCents).toBe(model.cashCents);
    expect(world.cashCents).toBeLessThan(defs.economy.startingCashCents);
  });

  it('žiadny platný príkaz nevyvolal CommandRejected', () => {
    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
  });

  it('RoadChanged pokrýva všetky zmenené bunky, jeden na každý stavebný príkaz', () => {
    const model = modelAt(scenario.commands, RUN_TICKS + 1);
    const roadSteps = model.steps.filter((s) => s.type !== 'SetGameSpeed');
    const changedEvents = eventsOfType(events, 'RoadChanged');
    expect(changedEvents).toHaveLength(roadSteps.length);

    const reported = new Set(changedEvents.flatMap((e) => e.cells.map(cellKey)));
    for (const step of roadSteps) {
      expect(step.changed.filter((key) => !reported.has(key))).toEqual([]);
    }
  });

  it('MoneyChanged nesie presné delty príkazov a konzistentný zostatok', () => {
    const model = modelAt(scenario.commands, RUN_TICKS + 1);
    const money = eventsOfType(events, 'MoneyChanged');
    const expectedDeltas = model.steps.filter((s) => s.type !== 'SetGameSpeed').map((s) => s.deltaCents);
    expect(money.map((e) => e.deltaCents)).toEqual(expectedDeltas);

    let running = defs.economy.startingCashCents;
    for (const event of money) {
      running += event.deltaCents;
      expect(event.cashCents).toBe(running);
    }
    expect(running).toBe(world.cashCents);
  });

  it('GameSpeedChanged sa vyvolá práve raz s rýchlosťou 4', () => {
    expect(eventsOfType(events, 'GameSpeedChanged').map((e) => e.speed)).toEqual([4]);
  });

  it('TickAdvanced každý tick a kalendárne udalosti podľa time defu', () => {
    const advanced = eventsOfType(events, 'TickAdvanced').map((e) => e.tick);
    expect(advanced).toHaveLength(RUN_TICKS);
    expect(advanced.every((t, i) => i === 0 || t - advanced[i - 1] === 1)).toBe(true);

    const ticksPerHour = SECONDS_PER_HOUR / defs.time.tickGameSeconds;
    expect(eventsOfType(events, 'HourClosed')).toHaveLength(Math.floor(RUN_TICKS / ticksPerHour));
    expect(eventsOfType(events, 'DayClosed')).toHaveLength(Math.floor(RUN_TICKS / (ticksPerHour * HOURS_PER_DAY)));
    expect(eventsOfType(events, 'MonthClosed')).toHaveLength(
      Math.floor(RUN_TICKS / (ticksPerHour * HOURS_PER_DAY * DAYS_PER_MONTH)),
    );
  });

  it.each(CHECKPOINTS)('kontrolný bod po ticku %i: cesty, hotovosť a rýchlosť zodpovedajú modelu', (tick) => {
    const model = modelAt(scenario.commands, tick);
    expect(observed.get(tick)).toEqual({ cashCents: model.cashCents, roads: model.roads.size, speed: model.speed });
  });
});

describe('scenár f1_roads: invarianty po každom ticku', () => {
  it('assertCargoConservation po každom ticku; invarianty ciest po zmene a každých 1000 tickov', () => {
    const world = World.create(defs, map, scenario.seed);
    let ticksSeen = 0;
    runScenario(world, scenario, RUN_TICKS, {
      afterTick: (w, tickEvents) => {
        ticksSeen += 1;
        assertCargoConservation(w);
        if (w.clock.tick % 1000 === 0 || tickEvents.some((e) => e.type === 'RoadChanged')) assertRoadInvariants(w);
      },
    });
    expect(ticksSeen).toBe(RUN_TICKS);
  });

  it('prehratie scenára nezmení šablónu LoadedMap (svet si mriežku klonuje)', () => {
    const before = map.starter.roads.length;
    const world = World.create(defs, map, scenario.seed);
    runScenario(world, scenario, 300);
    expect(countRoadCells(world)).toBeGreaterThan(before);

    let templateRoads = 0;
    for (let y = 0; y < map.grid.height; y++) {
      for (let x = 0; x < map.grid.width; x++) {
        if (map.grid.at(x, y).road === 'road') templateRoads += 1;
      }
    }
    expect(templateRoads).toBe(before);
    expect(countRoadCells(World.create(defs, map, scenario.seed))).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Odmietnutie: parcela na predaj (ADR-008)
// ---------------------------------------------------------------------------------------------------------

/** Prvá bunka pevniny v obdĺžniku parcely (údaje z mapy, nie natvrdo). */
function firstLandCell(parcelId: string): CellCoord {
  const parcel = map.parcels.find((p) => p.id === parcelId);
  if (parcel === undefined) throw new Error(`mapa nemá parcelu '${parcelId}'`);
  for (let y = parcel.rect.y; y < parcel.rect.y + parcel.rect.h; y++) {
    for (let x = parcel.rect.x; x < parcel.rect.x + parcel.rect.w; x++) {
      const cell = map.grid.at(x, y);
      if (cell.terrain === 'land' && cell.road === 'none') return { x, y };
    }
  }
  throw new Error(`parcela '${parcelId}' nemá voľnú pevninu`);
}

/** Prvá voľná verejná bunka pevniny. */
function firstPublicLandCell(): CellCoord {
  for (let y = 0; y < map.grid.height; y++) {
    for (let x = 0; x < map.grid.width; x++) {
      const cell = map.grid.at(x, y);
      if (cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none') return { x, y };
    }
  }
  throw new Error('mapa nemá voľnú verejnú pevninu');
}

const forSaleParcels = map.parcels.filter((p) => p.ownership === 'none');
const starterCell = firstLandCell('starter');
const placeRoad = (...cells: CellCoord[]): SerializedCommand => ({ type: 'PlaceRoad', cells });

describe('PlaceRoad na parcelu na predaj', () => {
  it('mapa má štartovú vlastnenú parcelu a aspoň dve parcely na predaj', () => {
    expect(map.parcels.find((p) => p.id === 'starter')?.ownership).toBe('owned');
    expect(forSaleParcels.length).toBeGreaterThanOrEqual(2);
  });

  it.each(forSaleParcels.map((p) => [p.id] as const))(
    'parcela %s: CommandRejected(parcel_not_owned), stav sa nezmení',
    (parcelId) => {
      const world = World.create(defs, map, scenario.seed);
      const cell = firstLandCell(parcelId);
      const before = stateHash(world);
      const cashBefore = world.cashCents;

      world.enqueue(commandFromJSON(placeRoad(cell)));
      const events = world.applyPending();

      const rejected = eventsOfType(events, 'CommandRejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].commandType).toBe('PlaceRoad');
      expect(rejected[0].reasons).toContain('parcel_not_owned');
      expect(events.filter((e) => e.type === 'RoadChanged' || e.type === 'MoneyChanged')).toEqual([]);

      expect(world.grid.at(cell.x, cell.y).road).toBe('none');
      expect(world.cashCents).toBe(cashBefore);
      expect(stateHash(world)).toBe(before); // nič sa nezmenilo (ani hodiny — applyPending čas neposúva)
    },
  );

  it('rovnako cez tick(): odmietnutie, cesta nevznikne, hotovosť ostane, čas sa posunie o 1', () => {
    const world = World.create(defs, map, scenario.seed);
    const cell = firstLandCell(forSaleParcels[0].id);
    world.enqueue(commandFromJSON(placeRoad(cell)));
    const events = world.tick();

    expect(eventsOfType(events, 'CommandRejected').map((e) => e.reasons)).toEqual([['parcel_not_owned']]);
    expect(events.some((e) => e.type === 'RoadChanged' || e.type === 'MoneyChanged')).toBe(false);
    expect(world.clock.tick).toBe(1);
    expect(world.cashCents).toBe(defs.economy.startingCashCents);
    expect(countRoadCells(world)).toBe(map.starter.roads.length);
  });

  it('validate() hlási parcel_not_owned a nič nezmení', () => {
    const world = World.create(defs, map, scenario.seed);
    const before = stateHash(world);
    const result = commandFromJSON(placeRoad(firstLandCell(forSaleParcels[0].id))).validate(world);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('parcel_not_owned');
    expect(stateHash(world)).toBe(before);
  });

  it('príkaz je atomický: jedna cudzia bunka odmietne celý príkaz aj s platnými bunkami', () => {
    const world = World.create(defs, map, scenario.seed);
    const foreign = firstLandCell(forSaleParcels[0].id);
    const before = stateHash(world);

    world.enqueue(commandFromJSON(placeRoad(starterCell, foreign)));
    const events = world.applyPending();

    expect(eventsOfType(events, 'CommandRejected')[0].reasons).toContain('parcel_not_owned');
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('none');
    expect(stateHash(world)).toBe(before);
  });

  it('kontrola: rovnaký príkaz na starter parcelu a verejnú bunku prejde a stojí presne cenu buniek', () => {
    const world = World.create(defs, map, scenario.seed);
    const publicCell = firstPublicLandCell();
    world.enqueue(commandFromJSON(placeRoad(starterCell, publicCell)));
    const events = world.applyPending();

    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('road');
    expect(world.grid.at(publicCell.x, publicCell.y).road).toBe('road');
    expect(world.cashCents).toBe(defs.economy.startingCashCents - 2 * ROAD_COST);
  });

  it('odmietnutý príkaz nezablokuje frontu: nasledujúci platný príkaz sa aplikuje', () => {
    const world = World.create(defs, map, scenario.seed);
    const foreign = firstLandCell(forSaleParcels[0].id);
    world.enqueue(commandFromJSON(placeRoad(foreign)));
    world.enqueue(commandFromJSON(placeRoad(starterCell)));
    const events = world.applyPending();

    expect(eventsOfType(events, 'CommandRejected')).toHaveLength(1);
    expect(eventsOfType(events, 'RoadChanged')).toHaveLength(1);
    expect(world.grid.at(foreign.x, foreign.y).road).toBe('none');
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('road');
    expect(world.cashCents).toBe(defs.economy.startingCashCents - ROAD_COST);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Fronta príkazov: enqueue / applyPending / tick
// ---------------------------------------------------------------------------------------------------------

describe('World: fronta príkazov', () => {
  it('enqueue príkaz iba zaradí — stav sa zmení až pri applyPending()/tick()', () => {
    // Fronta nie je súčasťou WorldState v1: serialize() pri čakajúcich príkazoch zámerne hodí chybu,
    // preto sa stav pri neprázdnej fronte nehashuje, ale porovnáva po zložkách.
    const world = World.create(defs, map, scenario.seed);
    const cashBefore = world.cashCents;
    const speedBefore = world.clock.speed;
    const roadsBefore = countRoadCells(world);
    expect(world.pendingCommandCount).toBe(0);

    world.enqueue(commandFromJSON(placeRoad(starterCell)));

    expect(world.pendingCommandCount).toBe(1);
    expect(world.cashCents).toBe(cashBefore);
    expect(world.clock.speed).toBe(speedBefore);
    expect(world.clock.tick).toBe(0);
    expect(countRoadCells(world)).toBe(roadsBefore);
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('none');

    world.applyPending();

    expect(world.pendingCommandCount).toBe(0);
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('road');
    expect(countRoadCells(world)).toBe(roadsBefore + 1);
    expect(world.cashCents).toBe(cashBefore - ROAD_COST);
  });

  it('applyPending() aplikuje príkazy bez posunu času a fronta sa vyprázdni', () => {
    const world = World.create(defs, map, scenario.seed);
    world.enqueue(commandFromJSON(placeRoad(starterCell)));
    const events = world.applyPending();

    expect(world.clock.tick).toBe(0);
    expect(events.some((e) => e.type === 'TickAdvanced')).toBe(false);
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('road');

    // druhé volanie nemá čo aplikovať: nič sa nezmení, cena sa neúčtuje dvakrát
    const after = stateHash(world);
    expect(world.applyPending()).toEqual([]);
    expect(stateHash(world)).toBe(after);
    expect(world.cashCents).toBe(defs.economy.startingCashCents - ROAD_COST);
  });

  it('stavba počas pauzy: SetGameSpeed(0) + PlaceRoad cez applyPending() bez posunu ticku', () => {
    const world = World.create(defs, map, scenario.seed);
    world.enqueue(commandFromJSON({ type: 'SetGameSpeed', speed: 0 }));
    world.enqueue(commandFromJSON(placeRoad(starterCell)));
    world.applyPending();

    expect(world.clock.speed).toBe(0);
    expect(world.clock.tick).toBe(0);
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('road');
  });

  it('príkazy idú v poradí vloženia: PlaceRoad a potom RemoveRoad tej istej bunky prejde', () => {
    const world = World.create(defs, map, scenario.seed);
    world.enqueue(commandFromJSON(placeRoad(starterCell)));
    world.enqueue(commandFromJSON({ type: 'RemoveRoad', cells: [starterCell] }));
    const events = world.applyPending();

    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('none');
    expect(world.cashCents).toBe(
      defs.economy.startingCashCents - ROAD_COST + Math.floor(ROAD_COST * REFUND_RATE),
    );
  });

  it('opačné poradie: RemoveRoad bez cesty je odmietnutý (no_road) a PlaceRoad potom prejde', () => {
    const world = World.create(defs, map, scenario.seed);
    world.enqueue(commandFromJSON({ type: 'RemoveRoad', cells: [starterCell] }));
    world.enqueue(commandFromJSON(placeRoad(starterCell)));
    const events = world.applyPending();

    const rejected = eventsOfType(events, 'CommandRejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].commandType).toBe('RemoveRoad');
    expect(rejected[0].reasons).toContain('no_road');
    expect(world.grid.at(starterCell.x, starterCell.y).road).toBe('road');
    expect(world.cashCents).toBe(defs.economy.startingCashCents - ROAD_COST);
  });

  it('tick() aplikuje čakajúce príkazy pred posunom času (rovnaký stav ako applyPending() + tick())', () => {
    const viaTick = World.create(defs, map, scenario.seed);
    viaTick.enqueue(commandFromJSON(placeRoad(starterCell)));
    const tickEvents = viaTick.tick();

    const viaApply = World.create(defs, map, scenario.seed);
    viaApply.enqueue(commandFromJSON(placeRoad(starterCell)));
    const applyEvents = [...viaApply.applyPending(), ...viaApply.tick()];

    expect(stateHash(viaTick)).toBe(stateHash(viaApply));
    const types = (list: readonly SimEvent[]): string[] => list.map((e) => e.type).sort();
    expect(types(tickEvents)).toEqual(types(applyEvents));
    expect(viaTick.clock.tick).toBe(1);
  });
});
