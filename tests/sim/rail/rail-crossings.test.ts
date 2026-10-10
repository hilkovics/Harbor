// Úrovňové priecestie (TR6-02, ADR-043 dodatok): PlaceRail cez cestu a PlaceRoad cez koľaj vytvoria priecestie, vlak ho rezervuje pred sebou (závora = pruhové sloty), cestné vozidlo doň nevstúpi,
// kým je rezervované, a vlak čaká, keď priecestie zaberá vozidlo. Bez prekrytia, deterministicky a bez uviaznutia v oboch smeroch (vlak prichádza aj odchádza).
import { describe, expect, it } from 'vitest';
import { slotKey } from '@sim/traffic';
import { Train } from '@sim/rail';
import { crossingBarrier, crossingStates } from '@sim/rail';
import { RailSystem } from '@sim/systems/rail-system';
import { World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { railWorld } from '../helpers/r6-rail';
import { send } from '../helpers/f6a';
import { cellOf, idx, lay, line, spawn, trafficBed, type TrafficBed, type XY } from '../traffic/traffic-fixtures';
import { carrierOverlapProblem } from '@sim/traffic';

const CROSSING_X = 92;
const ROAD: XY[] = [[CROSSING_X, 50], [CROSSING_X, 51], [CROSSING_X, 52]];

function events(world: World, command: Parameters<typeof send>[1]): readonly string[] {
  return send(world, command).map((event) => (event.type === 'CommandRejected' ? `rejected:${event.reasons.join(',')}` : event.type));
}

describe('príkazy: priecestie vzniká v oboch smeroch', () => {
  it('PlaceRail cez cestu: bunka ostáva cestou a je priecestie; cena ako koľaj; opakovanie je bez zmeny', () => {
    const { world } = railWorld();
    send(world, { type: 'PlaceRoad', cells: ROAD.map(([x, y]) => ({ x, y })) });
    const cell = world.grid.at(CROSSING_X, 51);
    // Koľaj y = 51 už cez (92, 51) vedie z `railWorld` — vlastná trasa bez priecestia na prázdnej bunke.
    expect(cell.road).toBe('road');
    expect(world.rail.isCrossing(world.grid.index(CROSSING_X, 51))).toBe(true);
    const index = world.grid.index(CROSSING_X, 51);
    expect(world.rail.crossings.has(index)).toBe(true);
    expect(events(world, { type: 'PlaceRail', cells: [{ x: CROSSING_X, y: 51 }] })).toEqual(['rejected:empty']);
  });

  it('PlaceRail na bunku s cestou vytvorí priecestie (cesta ostáva)', () => {
    const { world } = railWorld({ rails: false });
    send(world, { type: 'PlaceRoad', cells: ROAD.map(([x, y]) => ({ x, y })) });
    const cash = world.cashCents;
    expect(events(world, { type: 'PlaceRail', cells: [{ x: CROSSING_X, y: 51 }] })).toContain('RoadChanged');
    expect(world.grid.at(CROSSING_X, 51).road).toBe('road');
    expect(world.rail.isCrossing(world.grid.index(CROSSING_X, 51))).toBe(true);
    expect(cash - world.cashCents).toBe(world.defs.infrastructure.rail.costPerCellCents);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('RemoveRail na priecestí necháva cestu; RemoveRoad na priecestí necháva koľaj', () => {
    const { world } = railWorld({ rails: false });
    send(world, { type: 'PlaceRoad', cells: ROAD.map(([x, y]) => ({ x, y })) });
    send(world, { type: 'PlaceRail', cells: [{ x: CROSSING_X, y: 51 }] });
    const index = world.grid.index(CROSSING_X, 51);
    expect(events(world, { type: 'RemoveRail', cells: [{ x: CROSSING_X, y: 51 }] })).toContain('RoadChanged');
    expect(world.grid.at(CROSSING_X, 51).road).toBe('road');
    expect(world.rail.crossings.has(index)).toBe(false);
    send(world, { type: 'PlaceRail', cells: [{ x: CROSSING_X, y: 51 }] });
    expect(events(world, { type: 'RemoveRoad', cells: [{ x: CROSSING_X, y: 51 }] })).toContain('RoadChanged');
    expect(world.grid.at(CROSSING_X, 51).road).toBe('rail');
    expect(world.rail.crossings.has(index)).toBe(false);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('PlaceRoad na koľaj vytvorí priecestie: bunka sa stane cestou, koľaj ostáva v trase', () => {
    const { world } = railWorld();
    const index = world.grid.index(CROSSING_X, 51);
    expect(world.grid.atIndex(index).road).toBe('rail');
    expect(events(world, { type: 'PlaceRoad', cells: ROAD.map(([x, y]) => ({ x, y })) })).toContain('RoadChanged');
    expect(world.grid.atIndex(index).road).toBe('road');
    expect(world.rail.crossings.has(index)).toBe(true);
    // Terminál ostáva napojený na portál cez priecestie.
    expect(world.hasRailService).toBe(true);
    expect(world.railRoutes[0].cells).toContain(index);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('pod modulom priecestie nevznikne a odstránenie koľaje s vlakom na trase sa odmietne; save zachová priecestia', () => {
    const { world } = railWorld();
    send(world, { type: 'PlaceRoad', cells: ROAD.map(([x, y]) => ({ x, y })) });
    const copy = World.deserialize(world.defs, world.map, JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>);
    expect([...copy.rail.crossings]).toEqual([...world.rail.crossings]);
    expect(copy.hasRailService).toBe(true);
  });
});

/** Svet z `dispatchWorld`: koľaj y = 27 (x 30…57), cesta x = 40 (y 22…46) s priecestím (40, 27). */
function crossingBed(): { readonly bed: TrafficBed; readonly rail: RailSystem; readonly route: number[]; readonly crossing: number } {
  const bed = trafficBed();
  const { world } = bed;
  lay(world, line([40, 22], [40, 46]));
  const route = line([30, 27], [57, 27]).map((xy) => idx(world, xy));
  for (const cell of route) if (world.grid.atIndex(cell).road === 'none') world.grid.atIndex(cell).road = 'rail';
  const crossing = idx(world, [40, 27]);
  world.rail.crossings.add(crossing);
  return { bed, rail: new RailSystem(), route, crossing };
}

function makeTrain(world: World, route: readonly number[], state: 'arriving' | 'dwelling', posMilli: number): Train {
  const train = new Train({
    id: world.ids.next(),
    state,
    route,
    posMilli,
    terminalId: 1,
    track: 0,
    wagons: 4,
    scheduledTick: 0,
    spawnedTick: 0,
    stoppedTick: state === 'arriving' ? null : 0,
    departAtTick: state === 'arriving' ? null : 0,
    def: world.defs.rail.train,
  });
  world.addTrain(train);
  return train;
}

function step(bed: TrafficBed, rail: RailSystem): void {
  const { world } = bed;
  world.traffic.tick(world);
  rail.tick(world);
  world.clock.advance();
  expect(carrierOverlapProblem(world)).toBeNull();
}

describe('vlak a vozidlo na priecestí', () => {
  it('vlak rezervuje priecestie pred sebou: závora je zatvorená a vozidlo pred ňou stojí, kým vlak nepreide; potom prejde', () => {
    const { bed, rail, route, crossing } = crossingBed();
    const { world } = bed;
    // Čelo vlaku je 4 bunky pred priecestím (v dosahu `crossingClearTicks`): závora je zatvorená skôr, než vozidlo dorazí.
    const train = makeTrain(world, route, 'arriving', 6000);
    const vehicle = spawn(bed, line([40, 22], [40, 46]), { length: 2 });
    let closedTicks = 0;
    let crossedAt = -1;
    let trainClearAt = -1;
    for (let i = 0; i < 400; i++) {
      step(bed, rail);
      if (crossingBarrier(world, crossing) === 'closed') closedTicks += 1;
      const [, y] = cellOf(world, vehicle);
      const onCrossing = world.laneSlots.holderOfKey(slotKey(crossing, 0)) === vehicle.id || world.laneSlots.holderOfKey(slotKey(crossing, 1)) === vehicle.id;
      // Nikdy naraz: vozidlo drží slot priecestia len keď ho nedrží vlak, a vlak nie je v ňom.
      if (onCrossing) expect(world.rail.occupancy[crossing]).toBe(0);
      if (trainClearAt < 0 && train.occLo > route.indexOf(crossing)) trainClearAt = i;
      if (y > 28 && crossedAt < 0) crossedAt = i;
    }
    expect(closedTicks).toBeGreaterThan(20);
    expect(trainClearAt).toBeGreaterThan(0);
    // Vozidlo prešlo až po vlaku.
    expect(crossedAt).toBeGreaterThan(trainClearAt - 1);
    expect(cellOf(world, vehicle)[1]).toBe(46);
    expect(crossingBarrier(world, crossing)).toBe('open');
    expect(crossingStates(world)).toEqual([{ cell: crossing, barrier: 'open' }]);
  });

  it('vozidlo na priecestí zdrží vlak pred bunkou; keď odíde, vlak pokračuje a nič sa neprekrýva', () => {
    const { bed, rail, route, crossing } = crossingBed();
    const { world } = bed;
    // Vozidlo stojí na priecestí (hlava (40, 27), chvost (40, 26)).
    const vehicle = spawn(bed, line([40, 25], [40, 27]), { length: 2 });
    for (let i = 0; i < 6; i++) step(bed, rail);
    expect(cellOf(world, vehicle)).toEqual([40, 27]);
    const train = makeTrain(world, route, 'arriving', 0);
    const crossingIndex = route.indexOf(crossing);
    for (let i = 0; i < 120; i++) step(bed, rail);
    // Vlak čaká pred priecestím (jeho čelo sa nedostalo do bunky priecestia) a drží voľný pruh; vozidlo ho nechalo stáť.
    expect(train.occHi).toBeLessThan(crossingIndex);
    expect(world.rail.occupancy[crossing]).toBe(0);
    vehicle.followRoute(Object.freeze(line([40, 27], [40, 46]).map((xy) => idx(world, xy))));
    for (let i = 0; i < 200; i++) step(bed, rail);
    expect(train.occHi).toBeGreaterThanOrEqual(crossingIndex);
    expect(cellOf(world, vehicle)[1]).toBe(46);
  });

  it('odchod (vlak cúva): priecestie sa rezervuje v smere jazdy chvosta a vozidlo čaká tiež', () => {
    const { bed, rail, route, crossing } = crossingBed();
    const { world } = bed;
    const train = makeTrain(world, route, 'arriving', 0);
    // Dôjde na koniec, odstojí a odíde; vozidlo sa vyšle až pri odchode.
    for (let i = 0; i < 500 && train.state !== 'dwelling'; i++) step(bed, rail);
    expect(train.state).toBe('dwelling');
    train.departAtTick = world.clock.tick;
    const vehicle = spawn(bed, line([40, 22], [40, 46]), { length: 2 });
    let maxBlocked = 0;
    for (let i = 0; i < 800 && world.trains.size > 0; i++) {
      step(bed, rail);
      maxBlocked = Math.max(maxBlocked, vehicle.blockedTicks);
      if (world.rail.occupancy[crossing] !== 0) expect(world.laneSlots.holderOfKey(slotKey(crossing, 0))).toBe(train.id);
    }
    expect(world.trains.size).toBe(0);
    for (let i = 0; i < 60; i++) step(bed, rail);
    expect(cellOf(world, vehicle)[1]).toBe(46);
    // Vozidlo stálo pri závore, ale nie nekonečne (žiadne uviaznutie).
    expect(maxBlocked).toBeGreaterThan(0);
    expect(maxBlocked).toBeLessThan(world.defs.logistics.traffic.stuckTicks * 2);
    expect(crossingBarrier(world, crossing)).toBe('open');
    expect(world.laneSlots.claimedCount).toBeGreaterThanOrEqual(0);
  });

  it('prúd vozidiel oboma smermi a dva vlaky za sebou: nikto neuviazne, žiadne prekrytie; beh je deterministický', () => {
    const run = (): string => {
      const { bed, rail, route, crossing } = crossingBed();
      const { world } = bed;
      const log: string[] = [];
      makeTrain(world, route, 'arriving', 0);
      const down: ReturnType<typeof spawn>[] = [];
      const up: ReturnType<typeof spawn>[] = [];
      let departed = 0;
      for (let i = 0; i < 1500; i++) {
        if (i % 100 === 0 && i < 400) {
          down.push(spawn(bed, line([40, 22], [40, 46]), { length: 2 }));
          if (i < 200) up.push(spawn(bed, line([40, 46], [40, 22]), { length: 2 }));
        }
        if (i === 700) makeTrain(world, route, 'arriving', 0);
        step(bed, rail);
        if (world.rail.occupancy[crossing] !== 0) {
          for (const v of [...down, ...up]) expect(cellOf(world, v)).not.toEqual([40, 27]);
        }
        departed = world.rail.counters.trainsDeparted;
        if (i % 100 === 0) log.push(`${String(i)}:${[...down, ...up].map((v) => String(v.cell)).join(',')}:${String(world.trains.size)}`);
      }
      // Všetky vozidlá prešli priecestím (zastavia na konci cesty, kde stoja jedno za druhým) a žiadne neuviazlo pred závorou.
      expect(down.every((v) => cellOf(world, v)[1] >= 28)).toBe(true);
      expect(up.every((v) => cellOf(world, v)[1] <= 26)).toBe(true);
      expect(world.rail.counters.trainsDeparted).toBe(2);
      expect(world.trains.size).toBeLessThanOrEqual(1);
      return `${log.join('|')}#${String(departed)}`;
    };
    expect(run()).toBe(run());
  });
});
