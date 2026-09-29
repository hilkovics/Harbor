// Príkazy T01-04 cez frontu World (enqueue → applyPending/tick): počty udalostí, atomické odmietnutie,
// tok peňazí a replay ekvivalencia. Plný scenár `f1_roads` je v T01-05 (tests/sim/scenarios).
import { describe, expect, it } from 'vitest';
import {
  PlaceRoadCommand,
  RemoveRoadCommand,
  SetGameSpeedCommand,
  commandFromJSON,
  type Command,
  type SerializedCommand,
} from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { World } from '@sim/world';
import { CELLS, DEFS, MAP, REFUND_RATE, ROAD_COST, START_CASH, hashState, newWorld, ofType, roadCount, starterRow } from './command-fixtures';

function applyNow(world: World, ...commands: Command[]): readonly SimEvent[] {
  for (const command of commands) world.enqueue(command);
  return world.applyPending();
}

const countByType = (events: readonly SimEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { type } of events) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
};

describe('platné príkazy: presne jedna udalosť každého druhu', () => {
  it('PlaceRoad → 1× RoadChanged + 1× MoneyChanged(road_capex)', () => {
    const world = newWorld();
    const events = applyNow(world, new PlaceRoadCommand([...starterRow(3), CELLS.publicLand, CELLS.publicQuay]));
    expect(countByType(events)).toEqual({ RoadChanged: 1, MoneyChanged: 1 });
    expect(ofType(events, 'MoneyChanged')[0]).toEqual({
      type: 'MoneyChanged',
      cashCents: START_CASH - 5 * ROAD_COST,
      deltaCents: -5 * ROAD_COST,
      reason: 'road_capex',
    });
    expect(world.cashCents).toBe(START_CASH - 5 * ROAD_COST);
  });

  it('RemoveRoad → 1× RoadChanged + 1× MoneyChanged(road_sale)', () => {
    const world = newWorld();
    applyNow(world, new PlaceRoadCommand(starterRow(2)));
    const events = applyNow(world, new RemoveRoadCommand(starterRow(2)));
    expect(countByType(events)).toEqual({ RoadChanged: 1, MoneyChanged: 1 });
    expect(ofType(events, 'MoneyChanged')[0]?.reason).toBe('road_sale');
  });

  it('SetGameSpeed → 1× GameSpeedChanged, cez tick() pred TickAdvanced', () => {
    const world = newWorld();
    world.enqueue(new SetGameSpeedCommand(4));
    expect(world.tick()).toEqual([
      { type: 'GameSpeedChanged', speed: 4 },
      { type: 'TickAdvanced', tick: 1 },
    ]);
    expect(world.clock.speed).toBe(4);
  });

  it('stavba počas pauzy: SetGameSpeed(0) + PlaceRoad cez applyPending bez posunu času', () => {
    const world = newWorld();
    const events = applyNow(world, new SetGameSpeedCommand(0), new PlaceRoadCommand([CELLS.starterQuay]));
    expect(countByType(events)).toEqual({ GameSpeedChanged: 1, RoadChanged: 1, MoneyChanged: 1 });
    expect(world.clock.tick).toBe(0);
    expect(world.grid.at(CELLS.starterQuay.x, CELLS.starterQuay.y).road).toBe('road');
  });
});

describe('neplatné príkazy: atomické odmietnutie cez World', () => {
  it.each<[string, Command, string, readonly string[]]>([
    ['PlaceRoad voda', new PlaceRoadCommand([CELLS.deepWater]), 'PlaceRoad', ['terrain']],
    ['PlaceRoad parcela na predaj + platná bunka', new PlaceRoadCommand([CELLS.starterLand, CELLS.forSaleLand]), 'PlaceRoad', ['parcel_not_owned']],
    ['PlaceRoad prázdny', new PlaceRoadCommand([]), 'PlaceRoad', ['empty']],
    ['RemoveRoad bez cesty + so starter cestou', new RemoveRoadCommand([CELLS.starterRoad, CELLS.publicLand]), 'RemoveRoad', ['no_road']],
    ['SetGameSpeed(3)', new SetGameSpeedCommand(3), 'SetGameSpeed', ['invalid_speed']],
  ])('%s → len CommandRejected { commandType, reasons }, stav nezmenený', (_name, command, commandType, reasons) => {
    const world = newWorld();
    const before = hashState(world.serialize());
    expect(applyNow(world, command)).toEqual([{ type: 'CommandRejected', commandType, reasons }]);
    expect(hashState(world.serialize())).toBe(before);
  });

  it('nedostatok peňazí → insufficient_funds, žiadna cesta nevznikne', () => {
    const world = newWorld();
    world.cashCents = ROAD_COST;
    const events = applyNow(world, new PlaceRoadCommand(starterRow(2)));
    expect(events).toEqual([{ type: 'CommandRejected', commandType: 'PlaceRoad', reasons: ['insufficient_funds'] }]);
    expect(roadCount(world)).toBe(MAP.starter.roads.length);
    expect(world.cashCents).toBe(ROAD_COST);
  });

  it('validácia pri aplikácii vidí predchádzajúci príkaz: druhá rovnaká stavba je empty', () => {
    const world = newWorld();
    const events = applyNow(world, new PlaceRoadCommand([CELLS.publicLand]), new PlaceRoadCommand([CELLS.publicLand]));
    expect(ofType(events, 'CommandRejected')).toEqual([{ type: 'CommandRejected', commandType: 'PlaceRoad', reasons: ['empty'] }]);
    expect(world.cashCents).toBe(START_CASH - ROAD_COST);
  });

  it('peniaze minuté prvým príkazom chýbajú druhému', () => {
    const world = newWorld();
    world.cashCents = 3 * ROAD_COST;
    const [a, b, c, d] = starterRow(4);
    const events = applyNow(world, new PlaceRoadCommand([a, b]), new PlaceRoadCommand([c, d]));
    expect(ofType(events, 'CommandRejected').map((e) => e.reasons)).toEqual([['insufficient_funds']]);
    expect(world.cashCents).toBe(ROAD_COST);
  });
});

describe('tok peňazí a replay', () => {
  it('postav → odstráň → znovu postav: hotovosť = štart − 2 × cena + refundácia', () => {
    const world = newWorld();
    const row = starterRow(5);
    applyNow(world, new PlaceRoadCommand(row), new RemoveRoadCommand(row), new PlaceRoadCommand(row));
    expect(world.cashCents).toBe(START_CASH - 2 * 5 * ROAD_COST + Math.floor(5 * ROAD_COST * REFUND_RATE));
    expect(roadCount(world)).toBe(MAP.starter.roads.length + 5);
  });

  it('replay cez toJSON → commandFromJSON dá identický stav a udalosti', () => {
    const script: Command[] = [
      new PlaceRoadCommand([...starterRow(6), CELLS.publicQuay]),
      new SetGameSpeedCommand(8),
      new RemoveRoadCommand(starterRow(2)),
      new PlaceRoadCommand([CELLS.forSaleLand]),
    ];
    const run = (commands: readonly Command[]): { hash: string; events: SimEvent[] } => {
      const world = World.create(DEFS, MAP, 7);
      const events: SimEvent[] = [];
      commands.forEach((command, i) => {
        world.enqueue(command);
        for (let t = 0; t <= i * 10; t++) events.push(...world.tick());
      });
      return { hash: hashState(world.serialize()), events };
    };
    const direct = run(script);
    const replayed = run(script.map((c) => commandFromJSON(JSON.parse(JSON.stringify(c.toJSON())) as SerializedCommand)));
    expect(replayed).toEqual(direct);
  });

  it('serialize/deserialize po príkazoch zachová cesty, hotovosť aj rýchlosť', () => {
    const world = newWorld();
    applyNow(world, new PlaceRoadCommand(starterRow(3)), new RemoveRoadCommand([CELLS.starterRoad]), new SetGameSpeedCommand(2));
    const state = world.serialize();
    const loaded = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(state)) as typeof state);
    expect(hashState(loaded.serialize())).toBe(hashState(state));
    expect(loaded.grid.at(CELLS.starterRoad.x, CELLS.starterRoad.y).road).toBe('none');
    expect(loaded.clock.speed).toBe(2);
  });
});
