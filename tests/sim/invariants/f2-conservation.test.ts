/**
 * Konzervácia nákladu vo fáze 2 (T02-06, TDD; CLAUDE.md pravidlo 2, ARCHITECTURE §6 krok 12, §7.1, §16):
 * po **každom** ticku beží `assertCargoConservation(world)` (+ nezávislý audit ledgera z `recordRun`) a k tomu:
 *  - `createdCount === živé + exported`, žiadna jednotka nie je naraz v dvoch lokáciách,
 *  - žeriav drží práve tú jednotku, ktorú ledger vedie ako `in_crane` na ňom (`heldUnitId` ↔ `location`),
 *  - reťaz pohybov každej jednotky nadväzuje (`from` ďalšieho pohybu = `to` predošlého) a smie ísť len
 *    `on_ship → in_crane → on_apron` (nič sa neteleportuje),
 *  - `CargoLedger.move` cez verejné API odmietne nepovolený prechod bez zmeny stavu a bez udalosti.
 *
 * Testy idú len cez verejné API a JSON príkazy; časové hranice sú horné, nie presné ticky.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { CargoTransitionError, type CargoLocation, type CargoLocationKind } from '@sim/cargo';
import type { SimEvent } from '@sim/events';
import modulesJson from '@data/defs/modules.json';
import { DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';
import {
  EAST_BERTH_CELL,
  ROOT_BERTH_CELL,
  at,
  berthAt,
  craneById,
  cranesOf,
  emptyScenario,
  must,
  placeModuleCommand,
  recordRun,
  samplesOf,
  spawnShipCommand,
  spawnedShipIds,
  timedOfType,
  withCommands,
  type RunLog,
  type TimedEvent,
} from '../helpers/harbor';
import { assertCargoConservation } from '../helpers/invariants';
import { eventsOfType, loadScenarioFile } from '../helpers/scenario';

/** Karta T02-06: 5 000 tickov so spawnutou loďou (tick 0 feeder 4 TEU, tick 1 500 druhý feeder 6 TEU). */
const RUN_TICKS = 5000;
const SECOND_SHIP_TICK = 1500;
const FIRST_UNITS = 4;
const SECOND_UNITS = 6;

/** Všetky druhy lokácií z ARCHITECTURE §7.1 okrem konečného `exported`. */
const LIVE_KINDS: readonly CargoLocationKind[] = [
  'on_ship',
  'in_crane',
  'on_apron',
  'in_vehicle',
  'in_storage',
  'in_pipeline',
  'at_ramp',
  'in_truck',
  'in_train',
];

/** Prechody, ktoré sa vo F2 môžu reálne stať (vozidlá, sklady a export prídu neskôr). */
const F2_TRANSITIONS: readonly (readonly [CargoLocationKind, CargoLocationKind])[] = [
  ['on_ship', 'in_crane'],
  ['in_crane', 'on_apron'],
];

const byId = (a: number, b: number): number => a - b;

type CargoMovedEvent = Extract<SimEvent, { type: 'CargoMoved' }>;

/** Záznam ledgera po jednom ticku: počty podľa lokácie a počítadlá. */
interface LedgerSample {
  readonly tick: number;
  readonly created: number;
  readonly live: number;
  readonly exported: number;
  readonly inCrane: number;
}

/** Vzorka ledgera + vnútorné kontroly, ktoré sa musia držať po každom ticku. */
function sampleLedger(world: World): LedgerSample {
  const { cargo } = world;
  const live = LIVE_KINDS.reduce((sum, kind) => sum + cargo.countByKind(kind), 0);
  const sample: LedgerSample = {
    tick: world.clock.tick,
    created: cargo.createdCount,
    live,
    exported: cargo.exportedCount,
    inCrane: cargo.countByKind('in_crane'),
  };

  // Žeriav drží práve jednu jednotku a ledger ju vedie na ňom; nič v žeriave bez držiteľa.
  let held = 0;
  for (const crane of cranesOf(world)) {
    if (crane.heldUnitId === null) continue;
    held += 1;
    const location = cargo.get(crane.heldUnitId)?.location;
    if (location?.kind !== 'in_crane' || location.craneId !== crane.id) {
      throw new Error(
        `tick ${String(sample.tick)}: žeriav ${String(crane.id)} drží jednotku ${String(crane.heldUnitId)}, ale ledger ju vedie ako ${JSON.stringify(location)}`,
      );
    }
  }
  if (held !== sample.inCrane) {
    throw new Error(`tick ${String(sample.tick)}: žeriavy držia ${String(held)} jednotiek, ledger má in_crane = ${String(sample.inCrane)}`);
  }
  return sample;
}

/** `CargoMoved` udalosti zoskupené podľa jednotky v poradí vzniku. */
function moveChains(log: RunLog): Map<number, TimedEvent<CargoMovedEvent>[]> {
  const chains = new Map<number, TimedEvent<CargoMovedEvent>[]>();
  for (const entry of timedOfType(log, 'CargoMoved')) {
    chains.set(entry.event.unitId, [...(chains.get(entry.event.unitId) ?? []), entry]);
  }
  return chains;
}

/** Reťaz pohybov každej jednotky nadväzuje, začína `on_ship` a používa len povolené F2 prechody. */
function expectContiguousChains(log: RunLog): void {
  for (const [unitId, chain] of moveChains(log)) {
    let expectedFrom: CargoLocation | null = null;
    for (const { event, tick } of chain) {
      const where = `jednotka ${String(unitId)}, tick ${String(tick)}`;
      if (expectedFrom === null) expect(event.from.kind, `${where}: prvý pohyb`).toBe('on_ship');
      else expect(event.from, `${where}: nadväznosť na predošlý pohyb`).toEqual(expectedFrom);
      expect(
        F2_TRANSITIONS.some(([from, to]) => from === event.from.kind && to === event.to.kind),
        `${where}: ${event.from.kind} → ${event.to.kind}`,
      ).toBe(true);
      expectedFrom = event.to;
    }
  }
}

/** Žeriav odloží jednotku, ktorú zdvihol, na apron **svojho** berthu (nič sa neprenesie inam). */
function expectCranePlacesOnOwnApron(world: World, log: RunLog): void {
  for (const [unitId, chain] of moveChains(log)) {
    const [pick, place] = chain;
    if (place === undefined) continue; // jednotka ešte nebola odložená
    const where = `jednotka ${String(unitId)}`;
    if (pick.event.to.kind !== 'in_crane' || place.event.to.kind !== 'on_apron') throw new Error(`${where}: neočakávaná reťaz`);
    expect(place.event.from, where).toEqual(pick.event.to);
    expect(place.event.to.berthId, `${where}: apron žeriava`).toBe(craneById(world, pick.event.to.craneId).berthId);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Karta: 5 000 tickov so spawnutou loďou (f2_unload + druhý feeder v ticku 1 500)
// ---------------------------------------------------------------------------------------------------------

describe('konzervácia nákladu: 5 000 tickov (f2_unload + druhý feeder so 6 TEU v ticku 1 500)', () => {
  const scenario = withCommands(loadScenarioFile('f2_unload'), at(SECOND_SHIP_TICK, spawnShipCommand('feeder', SECOND_UNITS)));
  const samples: LedgerSample[] = [];
  let world: World;
  let log: RunLog;
  let rootBerthId: EntityId;
  let firstShip: EntityId;
  let secondShip: EntityId;

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    rootBerthId = berthAt(world, ROOT_BERTH_CELL).id;
    // `recordRun` po každom ticku volá `assertCargoConservation(world)` aj nezávislý `auditLedger(world)`.
    log = recordRun(world, scenario, RUN_TICKS, { onTick: (w) => samples.push(sampleLedger(w)) });
    [firstShip, secondShip] = spawnedShipIds(log);
  });

  it('assertCargoConservation(world) prešla po každom z 5 000 tickov (svet má ledger)', () => {
    expect(world.cargo).toBeDefined();
    expect(world.clock.tick).toBe(RUN_TICKS);
    expect(log.ticksChecked).toBe(RUN_TICKS);
    expect(samples).toHaveLength(RUN_TICKS);
    expect(() => assertCargoConservation(world)).not.toThrow();
    expect(() => world.cargo.assertConservation()).not.toThrow();
  });

  it('createdCount = živé + exported po každom ticku a exported ostáva 0 (vo F2 nič neopúšťa mapu)', () => {
    for (const sample of samples) {
      expect(sample.created, `tick ${String(sample.tick)}`).toBe(sample.live + sample.exported);
      expect(sample.exported, `tick ${String(sample.tick)}`).toBe(0);
    }
  });

  it('createdCount rastie iba spawnom lodí: 0 → 4 (tick 0) → 10 (tick 1 500), nikdy neklesne', () => {
    let previous = 0;
    for (const sample of samples) {
      expect(sample.created, `tick ${String(sample.tick)}`).toBeGreaterThanOrEqual(previous);
      previous = sample.created;
    }
    // Hranice: príkaz s atTick T sa aplikuje tesne pred tickom T, takže po ňom (clock.tick = T + 1) už jednotky existujú.
    for (const sample of samples.filter((s) => s.tick >= 2 && s.tick <= SECOND_SHIP_TICK)) {
      expect(sample.created, `tick ${String(sample.tick)}`).toBe(FIRST_UNITS);
    }
    for (const sample of samples.filter((s) => s.tick >= SECOND_SHIP_TICK + 2)) {
      expect(sample.created, `tick ${String(sample.tick)}`).toBe(FIRST_UNITS + SECOND_UNITS);
    }
    expect(world.cargo.createdCount).toBe(FIRST_UNITS + SECOND_UNITS);
  });

  it('dve lode = dva ShipSpawned (4 a 6 jednotiek) a žiadny odmietnutý príkaz', () => {
    const spawned = timedOfType(log, 'ShipSpawned');
    expect(spawned.map((entry) => entry.event.units)).toEqual([FIRST_UNITS, SECOND_UNITS]);
    expect(spawned[1].tick).toBeGreaterThanOrEqual(SECOND_SHIP_TICK);
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
  });

  it('žeriav drží najviac jednu jednotku a heldUnitId sedí s ledgerom po každom ticku (sampleLedger)', () => {
    // Samotná kontrola beží v `sampleLedger`; tu overíme, že sa vôbec niekedy niečo držalo.
    expect(samples.some((sample) => sample.inCrane > 0)).toBe(true);
    expect(Math.max(...samples.map((sample) => sample.inCrane))).toBeLessThanOrEqual(cranesOf(world).length);
  });

  it('pohyby: presne 4 × (on_ship → in_crane → on_apron); druhá loď (apron plný) sa nepohla', () => {
    const chains = moveChains(log);
    expect(chains.size).toBe(FIRST_UNITS);
    for (const [unitId, chain] of chains) {
      expect(chain, `jednotka ${String(unitId)}`).toHaveLength(2);
    }
    expectContiguousChains(log);
    expectCranePlacesOnOwnApron(world, log);

    const secondShipUnits = world.cargo.unitsOnShip(secondShip);
    expect(secondShipUnits).toHaveLength(SECOND_UNITS);
    for (const unitId of secondShipUnits) expect(chains.has(unitId)).toBe(false);
  });

  it('konečný stav: 4 na aprone, 6 na druhej lodi, nič v žeriave; súčet 10 = createdCount', () => {
    expect(world.cargo.unitsOnApron(rootBerthId)).toHaveLength(FIRST_UNITS);
    expect(world.cargo.countByKind('on_apron')).toBe(FIRST_UNITS);
    expect(world.cargo.countByKind('on_ship')).toBe(SECOND_UNITS);
    expect(world.cargo.countByKind('in_crane')).toBe(0);
    expect(world.cargo.countByKind('on_apron') + world.cargo.countByKind('on_ship')).toBe(world.cargo.createdCount);
    expect(world.ships.has(firstShip)).toBe(false); // prvá loď (vyložená) odplávala,
    expect(world.ships.get(secondShip)?.state).toBe('docked'); // druhá stojí na berthe a čaká na miesto na aprone
  });

  it('jednotka sa nikdy nevyskytne v dvoch lokáciách: id na lodi a aprone sú disjunktné a jedinečné', () => {
    const onApron = [...world.cargo.unitsOnApron(rootBerthId)];
    const onShip = [...world.cargo.unitsOnShip(secondShip)];
    const all = [...onApron, ...onShip];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(FIRST_UNITS + SECOND_UNITS);
    for (const unitId of onApron) expect(world.cargo.get(unitId)?.location.kind).toBe('on_apron');
    for (const unitId of onShip) expect(world.cargo.get(unitId)?.location).toEqual({ kind: 'on_ship', shipId: secondShip });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Bohatší tok: dve lode a dva žeriavy naraz (dva aprony)
// ---------------------------------------------------------------------------------------------------------

/**
 * Defy s 5× pomalším kontajnerovým žeriavom: prvá loď sa vykladá dlhšie, než druhá dopláva — po ADR-029 je na sea lane
 * naraz jedna loď, takže druhá vpláva až za prvou a s bežným žeriavom by sa pri kotviskách nestretli.
 */
const CRANE_SLOWDOWN = 5;
const [, craneJson] = modulesJson.items;
const CRANE_CYCLE_TICKS = must(craneJson.params.cycleTicks, 'cycleTicks kontajnerového žeriavu');
const SLOW_CRANE_DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: modulesJson.items.map((item) => (item.id === craneJson.id ? { ...craneJson, params: { ...craneJson.params, cycleTicks: CRANE_CYCLE_TICKS * CRANE_SLOWDOWN } } : item)),
  },
});

describe('konzervácia nákladu: dve lode súčasne na dvoch berthoch s vlastnými žeriavmi', () => {
  /** Žeriav na východnom berthe: footprint 2×3 na x 51–52 leží celý na berthe x 48–55. */
  const EAST_CRANE_CELL = { x: EAST_BERTH_CELL.x + 3, y: EAST_BERTH_CELL.y };
  const RUN = 4000;
  const scenario = withCommands(
    emptyScenario('f2_conservation_two_ships', 2004),
    at(0, placeModuleCommand('berth_standard', EAST_BERTH_CELL)),
    at(0, placeModuleCommand('crane_container_gantry', EAST_CRANE_CELL)),
    at(0, spawnShipCommand('feeder', 4)),
    at(0, spawnShipCommand('feeder', 4)),
  );
  const samples: LedgerSample[] = [];
  let world: World;
  let log: RunLog;
  let rootId: EntityId;
  let eastId: EntityId;
  let ships: EntityId[];

  beforeAll(() => {
    world = World.create(SLOW_CRANE_DEFS, MAP, scenario.seed);
    rootId = berthAt(world, ROOT_BERTH_CELL).id;
    log = recordRun(world, scenario, RUN, { onTick: (w) => samples.push(sampleLedger(w)) });
    eastId = berthAt(world, EAST_BERTH_CELL).id;
    ships = spawnedShipIds(log);
  });

  it('príkazy prešli (berth aj žeriav postavené), invarianty bežali po každom ticku', () => {
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
    expect(timedOfType(log, 'ModulePlaced')).toHaveLength(2);
    expect(cranesOf(world)).toHaveLength(2);
    expect(DEFS.modules.get(craneJson.id)).toMatchObject({ params: { cycleTicks: CRANE_CYCLE_TICKS } });
    expect(berthAt(world, ROOT_BERTH_CELL).craneIds).toHaveLength(1);
    expect(berthAt(world, EAST_BERTH_CELL).craneIds).toHaveLength(1);
    expect(log.ticksChecked).toBe(RUN);
    for (const sample of samples) expect(sample.created, `tick ${String(sample.tick)}`).toBe(sample.live + sample.exported);
  });

  it('obe lode sú v jednom okamihu docked, každá na inom berthe', () => {
    expect(ships).toHaveLength(2);
    const [a, b] = ships.map((id) => samplesOf(log, id));
    const overlap = a.filter((left) => {
      const right = b.find((s) => s.tick === left.tick);
      return left.state === 'docked' && right?.state === 'docked';
    });
    expect(overlap.length).toBeGreaterThan(0);
    const tick = overlap[0].tick;
    const berthsA = must(a.find((s) => s.tick === tick), 'vzorka lode A').berthIds;
    const berthsB = must(b.find((s) => s.tick === tick), 'vzorka lode B').berthIds;
    expect(berthsA).toHaveLength(1);
    expect(berthsB).toHaveLength(1);
    expect(berthsA[0]).not.toBe(berthsB[0]);
    expect(new Set([...berthsA, ...berthsB])).toEqual(new Set([rootId, eastId]));
  });

  it('všetkých 8 jednotiek skončí na aprónoch (po 4), lode odplávali a nič nie je v žeriavoch', () => {
    expect(world.cargo.createdCount).toBe(8);
    expect(world.cargo.unitsOnApron(rootId)).toHaveLength(4);
    expect(world.cargo.unitsOnApron(eastId)).toHaveLength(4);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(world.cargo.countByKind('in_crane')).toBe(0);
    expect(timedOfType(log, 'ShipDeparted').map((entry) => entry.event.shipId).sort(byId)).toEqual([...ships].sort(byId));
    expect(world.ships.size).toBe(0);
  });

  it('reťaz pohybov: 8 jednotiek × (on_ship → in_crane → on_apron), každý žeriav odkladá na apron svojho berthu', () => {
    const chains = moveChains(log);
    expect(chains.size).toBe(8);
    for (const [unitId, chain] of chains) expect(chain, `jednotka ${String(unitId)}`).toHaveLength(2);
    expectContiguousChains(log);
    expectCranePlacesOnOwnApron(world, log);
    expect(timedOfType(log, 'CraneCycleDone')).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Bohatší tok: jedna loď na dvoch berthoch obsluhovaná dvoma žeriavmi
// ---------------------------------------------------------------------------------------------------------

describe('konzervácia nákladu: handy na dvoch berthoch obsluhovaná dvoma žeriavmi (§5.4)', () => {
  const EAST_CRANE_CELL = { x: EAST_BERTH_CELL.x + 3, y: EAST_BERTH_CELL.y };
  const RUN = 4000;
  const UNITS = 6;
  const scenario = withCommands(
    emptyScenario('f2_conservation_handy_two_cranes', 2005),
    at(0, placeModuleCommand('berth_standard', EAST_BERTH_CELL)),
    at(0, placeModuleCommand('crane_container_gantry', EAST_CRANE_CELL)),
    at(0, spawnShipCommand('handy', UNITS)),
  );
  const samples: LedgerSample[] = [];
  let world: World;
  let log: RunLog;
  let rootId: EntityId;
  let eastId: EntityId;
  let shipId: EntityId;

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    rootId = berthAt(world, ROOT_BERTH_CELL).id;
    log = recordRun(world, scenario, RUN, { onTick: (w) => samples.push(sampleLedger(w)) });
    eastId = berthAt(world, EAST_BERTH_CELL).id;
    shipId = spawnedShipIds(log)[0];
  });

  it('handy zakotví na oboch berthoch a všetkých 6 jednotiek skončí na aprónoch', () => {
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
    const docked = must(timedOfType(log, 'ShipDocked')[0], 'ShipDocked');
    expect(docked.event.shipId).toBe(shipId);
    expect(new Set(docked.event.berthIds)).toEqual(new Set([rootId, eastId]));

    expect(world.cargo.createdCount).toBe(UNITS);
    expect(world.cargo.countByKind('on_apron')).toBe(UNITS);
    expect(world.cargo.unitsOnApron(rootId).length + world.cargo.unitsOnApron(eastId).length).toBe(UNITS);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(world.ships.size).toBe(0);
  });

  it('obsluhujú ju oba žeriavy (každý aspoň jeden cyklus) a každý odkladá na apron svojho berthu', () => {
    const done = timedOfType(log, 'CraneCycleDone');
    expect(done).toHaveLength(UNITS);
    for (const crane of cranesOf(world)) {
      expect(done.filter((entry) => entry.event.craneId === crane.id).length, `žeriav ${String(crane.id)}`).toBeGreaterThanOrEqual(1);
    }
    expectContiguousChains(log);
    expectCranePlacesOnOwnApron(world, log);
  });

  it('konzervácia platí po každom ticku a žiadny apron nikdy neprekročil kapacitu 4', () => {
    expect(log.ticksChecked).toBe(RUN);
    for (const sample of samples) expect(sample.created, `tick ${String(sample.tick)}`).toBe(sample.live + sample.exported);
    expect(world.cargo.unitsOnApron(rootId).length).toBeLessThanOrEqual(4);
    expect(world.cargo.unitsOnApron(eastId).length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------------------------------------
// CargoLedger.move cez verejné API: nepovolený prechod sa odmietne
// ---------------------------------------------------------------------------------------------------------

describe('CargoLedger.move: nepovolené prechody sa odmietnu a nič sa nezmení', () => {
  /** Svet s loďou (4 TEU on_ship), ktorá ešte nepohla ani ticku: príkaz aplikovaný bez posunu času. */
  function worldWithShip(): { world: World; shipId: EntityId; unitId: EntityId; rootBerthId: EntityId; craneId: EntityId } {
    const world = World.create(DEFS, MAP, 2006);
    world.enqueue(commandFromJSON(spawnShipCommand('feeder', 4)));
    const events = world.applyPending();
    const shipId = must(eventsOfType(events, 'ShipSpawned')[0], 'ShipSpawned').shipId as EntityId;
    const unitId = must(world.cargo.unitsOnShip(shipId)[0], 'jednotka na lodi');
    const berth = berthAt(world, ROOT_BERTH_CELL);
    return { world, shipId, unitId, rootBerthId: berth.id, craneId: berth.craneIds[0] };
  }

  it('on_ship → in_storage vyhodí CargoTransitionError; jednotka ostáva na lodi a nevznikne CargoMoved', () => {
    const { world, shipId, unitId, rootBerthId } = worldWithShip();
    const before = JSON.stringify(world.serialize());

    expect(() => world.cargo.move(unitId, { kind: 'in_storage', moduleId: rootBerthId, slot: 0 })).toThrow(CargoTransitionError);

    expect(world.cargo.get(unitId)?.location).toEqual({ kind: 'on_ship', shipId });
    expect(world.cargo.unitsOnShip(shipId)).toContain(unitId);
    expect(world.cargo.countByKind('on_ship')).toBe(4);
    expect(world.cargo.countByKind('in_storage')).toBe(0);
    expect(JSON.stringify(world.serialize())).toBe(before);
    assertCargoConservation(world);
    expect(eventsOfType(world.tick(), 'CargoMoved')).toEqual([]);
  });

  it.each<{ name: string; target: (rootBerthId: EntityId) => CargoLocation }>([
    { name: 'on_ship → on_apron (mimo žeriava)', target: (rootBerthId) => ({ kind: 'on_apron', berthId: rootBerthId, slot: 0 }) },
    { name: 'on_ship → exported (preskočenie celého reťazca)', target: () => ({ kind: 'exported' }) },
  ])('$name vyhodí CargoTransitionError', ({ target }) => {
    const { world, shipId, unitId, rootBerthId } = worldWithShip();
    expect(() => world.cargo.move(unitId, target(rootBerthId))).toThrow(CargoTransitionError);
    expect(world.cargo.get(unitId)?.location).toEqual({ kind: 'on_ship', shipId });
    assertCargoConservation(world);
  });

  it('po povolenom on_ship → in_crane je späť na loď (in_crane → on_ship) nepovolené a poloha ostáva v žeriave', () => {
    const { world, shipId, unitId, craneId } = worldWithShip();
    expect(() => world.cargo.move(unitId, { kind: 'in_crane', craneId })).not.toThrow();
    expect(world.cargo.get(unitId)?.location).toEqual({ kind: 'in_crane', craneId });
    expect(world.cargo.countByKind('in_crane')).toBe(1);
    expect(world.cargo.countByKind('on_ship')).toBe(3);
    expect(world.cargo.createdCount).toBe(4);

    expect(() => world.cargo.move(unitId, { kind: 'on_ship', shipId })).toThrow(CargoTransitionError);
    expect(world.cargo.get(unitId)?.location).toEqual({ kind: 'in_crane', craneId });
    expect(world.cargo.countByKind('in_crane')).toBe(1);
    expect(world.cargo.countByKind('on_ship')).toBe(3);
  });
});
