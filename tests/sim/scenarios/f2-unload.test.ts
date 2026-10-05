/**
 * Scenár `f2_unload` (T02-06, TDD): feeder s 4 TEU pripláva, zakotví na Root berthe, Root žeriav vyloží 4 kontajnery
 * na apron, loď odpláva. Testy idú výlučne cez verejné API a JSON príkazy (`SpawnShipDebug`), proti rozhraniu
 * z `docs/tasks/phase-02.md` („Spoločné rozhrania"). Časové hranice sú horné (nie presné ticky dokovania) a
 * kontrolujú sa stavy FSM lode, nie konkrétne ticky.
 *
 * Mapa harbor_01: Root berth x 40–47, y 14–16 (rot 0), Root žeriav (43, 14), voda y ≤ 13.
 * Po každom ticku beží `assertCargoConservation(world)` + nezávislý audit ledgera (`recordRun`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { berthParams, craneParams } from '@sim/defs';
import { isWater } from '@sim/grid';
import { World, type WorldState } from '@sim/world';
import {
  PHASE_SLACK_TICKS,
  ROOT_BERTH_CELL,
  berthAt,
  craneById,
  firstSampleInState,
  must,
  recordRun,
  runUntil,
  samplesOf,
  shipStateSequenceViolation,
  spawnedShipIds,
  stateSequence,
  timedOfType,
  type RunLog,
} from '../helpers/harbor';
import { loadScenarioFile, readRepoJson, stateHash } from '../helpers/scenario';
import { DEFS, MAP, MAP_GRID } from '../world/world-fixtures';

/** Karta T02-06: do 2 000 tickov je loď preč z `world.ships`. */
const RUN_TICKS = 2000;
/** Horná hranica dokovania (plavba ~11 buniek po sea lane + prístup k berthu pri 0,15 buniek/tick je rádovo 150 tickov). */
const DOCK_DEADLINE_TICKS = 1000;
/** Tolerancia float porovnaní rýchlosti lode. */
const EPSILON = 1e-6;

const scenario = loadScenarioFile('f2_unload');
const FEEDER = DEFS.ships.get('feeder');
const BERTH_FOOTPRINT_W = DEFS.modules.get('berth_standard').footprint.w;
const CRANE_CYCLE_TICKS = craneParams(DEFS.modules.get('crane_container_gantry')).cycleTicks;
const UNITS = 4;

// ---------------------------------------------------------------------------------------------------------
// Scenár ako dáta
// ---------------------------------------------------------------------------------------------------------

describe('scenár f2_unload: súbor', () => {
  it('má očakávaný tvar { id, seed, map, commands } a seed 2002', () => {
    expect(Object.keys(scenario).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect(scenario.id).toBe('f2_unload');
    expect(scenario.seed).toBe(2002);
    expect(scenario.map).toBe('data/maps/harbor_01.json');
    expect((readRepoJson(scenario.map) as { id: string }).id).toBe(MAP.id);
  });

  it('obsahuje jediný príkaz: tick 0 SpawnShipDebug feeder container_teu 4', () => {
    expect(scenario.commands).toEqual([
      { atTick: 0, command: { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: UNITS } },
    ]);
  });

  it('príkaz prežije commandFromJSON → toJSON bez zmeny', () => {
    for (const { command } of scenario.commands) {
      expect(commandFromJSON(command).toJSON()).toEqual(command);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Štartový stav: Root modul
// ---------------------------------------------------------------------------------------------------------

describe('scenár f2_unload: štartový stav (Root modul)', () => {
  it('Root berth a Root žeriav stoja od začiatku; žeriav je na bunkách berthu a nečinný', () => {
    const world = World.create(DEFS, MAP, scenario.seed);
    expect(world.modules.size).toBe(2);

    const berth = berthAt(world, ROOT_BERTH_CELL);
    expect(berth.def.id).toBe('berth_standard');
    expect(berth.origin).toEqual(ROOT_BERTH_CELL);
    expect(berth.dockedShipId).toBeNull();
    expect(berth.craneIds).toHaveLength(1);

    const crane = craneById(world, berth.craneIds[0]);
    expect(crane.def.id).toBe('crane_container_gantry');
    expect(crane.berthId).toBe(berth.id);
    expect(crane.state).toBe('idle');
    expect(crane.heldUnitId).toBeNull();
    // Rozhodnutie 3: žeriav stojí NA bunkách berthu, `cell.moduleId` ostáva id berthu.
    expect(world.grid.at(43, 14).moduleId).toBe(berth.id);
    expect(world.grid.at(44, 16).moduleId).toBe(berth.id);
  });

  it('svet začína bez lodí a nákladu a starter moduly nezmenili hotovosť', () => {
    const world = World.create(DEFS, MAP, scenario.seed);
    expect(world.ships.size).toBe(0);
    expect(world.cargo.createdCount).toBe(0);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Beh scenára: 2 000 tickov
// ---------------------------------------------------------------------------------------------------------

describe('scenár f2_unload: beh 2 000 tickov', () => {
  let world: World;
  let log: RunLog;
  let rootBerthId: EntityId;
  let rootCraneId: EntityId;
  let shipId: EntityId;

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    const berth = berthAt(world, ROOT_BERTH_CELL);
    rootBerthId = berth.id;
    rootCraneId = berth.craneIds[0];
    log = recordRun(world, scenario, RUN_TICKS);
    shipId = spawnedShipIds(log)[0];
  });

  it('hodiny stoja na 2 000 a invarianty ledgera bežali po každom ticku', () => {
    expect(world.clock.tick).toBe(RUN_TICKS);
    expect(log.ticksChecked).toBe(RUN_TICKS);
  });

  it('SpawnShipDebug vytvorí práve jednu loď feeder so 4 jednotkami (ShipSpawned) a príkaz nie je odmietnutý', () => {
    const spawned = timedOfType(log, 'ShipSpawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].event).toMatchObject({ classId: 'feeder', cargoTypeId: 'container_teu', units: UNITS });
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
    expect(world.cargo.createdCount).toBe(UNITS);
  });

  it('loď dosiahne docked na Root berthe (berthIds = [Root]) do 1 000 tickov', () => {
    const docked = must(firstSampleInState(samplesOf(log, shipId), 'docked'), 'loď v stave docked');
    expect(docked.tick).toBeLessThanOrEqual(DOCK_DEADLINE_TICKS);
    expect(docked.berthIds).toEqual([rootBerthId]);
    expect(docked.berthDockedShipIds).toEqual([shipId]);

    const events = timedOfType(log, 'ShipDocked');
    expect(events).toHaveLength(1);
    expect(events[0].event.shipId).toBe(shipId);
    expect(events[0].event.berthIds).toEqual([rootBerthId]);
  });

  it('stavy lode idú v poradí FSM (bez návratu) cez docked a outbound; berthIds je prázdne mimo inbound/berthing/docked/undocking', () => {
    const samples = samplesOf(log, shipId);
    const sequence = stateSequence(samples);
    expect(shipStateSequenceViolation(sequence)).toBeNull();
    expect(sequence).toContain('docked');
    expect(sequence).toContain('outbound');

    // ADR-029: kotvisko je rezervované od vstupu do prístavu (inbound) a uvoľnené na konci dráhy (koniec undocking).
    const holdsBerth = new Set(['inbound', 'berthing', 'docked', 'undocking']);
    for (const sample of samples) {
      if (!holdsBerth.has(sample.state)) {
        expect(sample.berthIds, `stav ${sample.state}, tick ${String(sample.tick)}`).toEqual([]);
      }
    }
  });

  it('v stave docked stojí loď rovnobežne s nábrežím (heading 90/270) na vode severne od Root berthu', () => {
    const docked = must(firstSampleInState(samplesOf(log, shipId), 'docked'), 'loď v stave docked');
    expect([90, 270]).toContain(docked.heading);
    expect(docked.x).toBeGreaterThanOrEqual(ROOT_BERTH_CELL.x);
    expect(docked.x).toBeLessThanOrEqual(ROOT_BERTH_CELL.x + BERTH_FOOTPRINT_W);
    expect(docked.y).toBeLessThan(ROOT_BERTH_CELL.y); // voda je y ≤ 13, nábrežie začína na y = 14
    expect(isWater(MAP_GRID.at(Math.floor(docked.x), Math.floor(docked.y)).terrain)).toBe(true);
  });

  it('nič sa neteleportuje: loď sa za tick posunie najviac o speedCellsPerTick a nikdy nestojí na súši', () => {
    const samples = samplesOf(log, shipId);
    let travelled = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      expect(MAP_GRID.inBounds(Math.floor(sample.x), Math.floor(sample.y)), `tick ${String(sample.tick)}`).toBe(true);
      expect(isWater(MAP_GRID.at(Math.floor(sample.x), Math.floor(sample.y)).terrain), `tick ${String(sample.tick)}`).toBe(true);
      if (i === 0 || samples[i - 1].tick !== sample.tick - 1) continue;
      const step = Math.hypot(sample.x - samples[i - 1].x, sample.y - samples[i - 1].y);
      expect(step, `tick ${String(sample.tick)}`).toBeLessThanOrEqual(FEEDER.speedCellsPerTick + EPSILON);
      travelled += step;
    }
    // Sea lane má 11 buniek, k tomu prístup ku kotvisku a návrat: loď skutočne pláva.
    expect(travelled).toBeGreaterThan(10);
  });

  it('žeriav vykladá po jednej jednotke: on_ship → in_crane → on_apron (Root žeriav, Root apron, rôzne sloty)', () => {
    const moves = timedOfType(log, 'CargoMoved');
    expect(moves).toHaveLength(UNITS * 2);

    const byUnit = new Map<number, typeof moves>();
    for (const move of moves) {
      byUnit.set(move.event.unitId, [...(byUnit.get(move.event.unitId) ?? []), move]);
    }
    expect(byUnit.size).toBe(UNITS);

    const capacity = berthParams(DEFS.modules.get('berth_standard')).apronSlots;
    const slots = new Set<number>();
    for (const [unitId, list] of byUnit) {
      expect(list, `jednotka ${String(unitId)}`).toHaveLength(2);
      const [pick, place] = list;
      expect(pick.event.from).toEqual({ kind: 'on_ship', shipId });
      expect(pick.event.to).toEqual({ kind: 'in_crane', craneId: rootCraneId });
      expect(place.event.from).toEqual({ kind: 'in_crane', craneId: rootCraneId });
      const target = place.event.to;
      if (target.kind !== 'on_apron') throw new Error(`jednotka ${String(unitId)} skončila v '${target.kind}', nie na aprone`);
      expect(target.berthId).toBe(rootBerthId);
      expect(target.slot).toBeGreaterThanOrEqual(0);
      expect(target.slot).toBeLessThan(capacity);
      slots.add(target.slot);
    }
    expect(slots.size).toBe(UNITS);
  });

  it('jednotky sa berú z lode len počas docked a CargoMoved.tick zodpovedá tiku behu (±1)', () => {
    const samples = samplesOf(log, shipId);
    let lastTick = 0;
    for (const move of timedOfType(log, 'CargoMoved')) {
      expect(Math.abs(move.event.tick - move.tick)).toBeLessThanOrEqual(1);
      expect(move.event.tick).toBeGreaterThanOrEqual(lastTick);
      lastTick = move.event.tick;
      if (move.event.from.kind === 'on_ship') {
        const sample = must(samples.find((s) => s.tick === move.tick), `vzorka lode v ticku ${String(move.tick)}`);
        expect(sample.state).toBe('docked');
      }
    }
  });

  it('žeriav je pri jednotke aspoň fázu placing (c − ⌊c/2⌋ tickov) a cykly nejdú rýchlejšie než cycleTicks', () => {
    const placingTicks = CRANE_CYCLE_TICKS - Math.floor(CRANE_CYCLE_TICKS / 2);
    const moves = timedOfType(log, 'CargoMoved');
    const pickTick = new Map<number, number>();
    for (const move of moves) {
      if (move.event.to.kind === 'in_crane') pickTick.set(move.event.unitId, move.tick);
      if (move.event.to.kind === 'on_apron') {
        const picked = must(pickTick.get(move.event.unitId), `zdvihnutie jednotky ${String(move.event.unitId)}`);
        expect(move.tick - picked).toBeGreaterThanOrEqual(placingTicks - PHASE_SLACK_TICKS);
      }
    }

    const done = timedOfType(log, 'CraneCycleDone');
    for (let i = 1; i < done.length; i++) {
      expect(done[i].tick - done[i - 1].tick).toBeGreaterThanOrEqual(CRANE_CYCLE_TICKS - PHASE_SLACK_TICKS);
    }
  });

  it('žeriav odvedie 4 cykly (CraneCycleDone pre 4 rôzne jednotky), nikdy sa nezablokuje a skončí nečinný', () => {
    const done = timedOfType(log, 'CraneCycleDone');
    expect(done).toHaveLength(UNITS);
    expect(new Set(done.map((entry) => entry.event.unitId)).size).toBe(UNITS);
    for (const entry of done) expect(entry.event.craneId).toBe(rootCraneId);
    expect(timedOfType(log, 'CraneBlocked')).toEqual([]);

    const crane = craneById(world, rootCraneId);
    expect(crane.state).toBe('idle');
    expect(crane.heldUnitId).toBeNull();
    expect(crane.busyTicks).toBeGreaterThan(0);
    expect(crane.idleTicks).toBeGreaterThan(0);
    expect(crane.blockedTicks).toBe(0);
    expect(crane.busyTicks + crane.idleTicks + crane.blockedTicks).toBeLessThanOrEqual(RUN_TICKS);
  });

  it('jednotky idú na apron v poradí od najmenšieho id lode (FIFO vykládky) a apron ich drží v poradí príchodu', () => {
    const arrivals = timedOfType(log, 'CargoMoved')
      .filter((move) => move.event.to.kind === 'on_apron')
      .map((move) => move.event.unitId);
    expect(arrivals).toHaveLength(UNITS);
    expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));
    expect(world.cargo.unitsOnApron(rootBerthId)).toEqual(arrivals);
  });

  it('po vyložení: 4 jednotky na aprone Root berthu, loď prázdna, nič v žeriave, createdCount = 4', () => {
    expect(world.cargo.countByKind('on_apron')).toBe(UNITS);
    expect(world.cargo.unitsOnApron(rootBerthId)).toHaveLength(UNITS);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
    expect(world.cargo.countByKind('in_crane')).toBe(0);
    expect(world.cargo.createdCount).toBe(UNITS);
    expect(world.cargo.exportedCount).toBe(0);
  });

  it('loď odíde až s prázdnym nákladným priestorom (undocking/outbound bez jednotiek na lodi)', () => {
    const samples = samplesOf(log, shipId);
    const docked = samples.filter((sample) => sample.state === 'docked');
    expect(docked.length).toBeGreaterThan(0);
    // Kým je na lodi náklad, stojí docked: prvá vzorka docked má všetky jednotky ešte na palube.
    expect(docked[0].unitsOnBoard).toBe(UNITS);
    const undocking = firstSampleInState(samples, 'undocking');
    if (undocking !== undefined) expect(undocking.unitsOnBoard).toBe(0);
    const outbound = must(firstSampleInState(samples, 'outbound'), 'loď v stave outbound');
    expect(outbound.unitsOnBoard).toBe(0);
  });

  it('loď odpláva: ShipUndocked a ShipDeparted práve raz, do 2 000 tickov je preč z world.ships a berth je voľný', () => {
    const undocked = timedOfType(log, 'ShipUndocked');
    const departed = timedOfType(log, 'ShipDeparted');
    expect(undocked.map((entry) => entry.event.shipId)).toEqual([shipId]);
    expect(departed.map((entry) => entry.event.shipId)).toEqual([shipId]);
    expect(departed[0].tick).toBeLessThanOrEqual(RUN_TICKS);

    expect(world.ships.has(shipId)).toBe(false);
    expect(world.ships.size).toBe(0);
    expect(berthAt(world, ROOT_BERTH_CELL).dockedShipId).toBeNull();

    const last = samplesOf(log, shipId).at(-1);
    expect(last?.state).toBe('outbound'); // posledná vzorka pred odstránením zo sveta
  });

  it('poradie udalostí: ShipSpawned < ShipDocked < prvý CargoMoved < ShipUndocked < ShipDeparted', () => {
    const index = (type: string): number => log.events.findIndex((entry) => entry.event.type === type);
    const order = ['ShipSpawned', 'ShipDocked', 'CargoMoved', 'ShipUndocked', 'ShipDeparted'].map(index);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // posledný CargoMoved (do apronu) je pred odchodom lode z mapy
    const lastMove = log.events.findLastIndex((entry) => entry.event.type === 'CargoMoved');
    expect(lastMove).toBeLessThan(index('ShipDeparted'));
  });

  it('vykládka je zadarmo: hotovosť sa nezmenila a nevznikla žiadna MoneyChanged', () => {
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(timedOfType(log, 'MoneyChanged')).toEqual([]);
  });

  it('Root modul po vykládke stojí (2 moduly), žeriav je stále na bunkách Root berthu', () => {
    expect(world.modules.size).toBe(2);
    expect(berthAt(world, ROOT_BERTH_CELL).craneIds).toEqual([rootCraneId]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Determinizmus a save/load
// ---------------------------------------------------------------------------------------------------------

describe('scenár f2_unload: determinizmus', () => {
  it('dva svety so seedom 2002 majú po 3 000 tickoch rovnaký hash stavu aj rovnaký prúd udalostí', () => {
    const initial = stateHash(World.create(DEFS, MAP, scenario.seed));
    const a = World.create(DEFS, MAP, scenario.seed);
    const b = World.create(DEFS, MAP, scenario.seed);
    const logA = recordRun(a, scenario, 3000);
    const logB = recordRun(b, scenario, 3000);

    expect(stateHash(a)).not.toBe(initial); // hash je citlivý: svet sa reálne zmenil
    expect(stateHash(b)).toBe(stateHash(a));
    expect(logB.events).toEqual(logA.events);
    expect(logA.events.length).toBeGreaterThan(0);
  });
});

describe('scenár f2_unload: save/load roundtrip', () => {
  const MOMENTS: readonly {
    readonly name: string;
    readonly ready: (world: World) => boolean;
    readonly check: (world: World) => void;
  }[] = [
    {
      name: 'počas plavby (tick 50)',
      ready: (world) => world.clock.tick >= 50,
      check: (world) => {
        expect(world.ships.size).toBe(1);
        expect(world.cargo.countByKind('on_ship')).toBe(UNITS);
      },
    },
    {
      name: 'uprostred vykládky (2 jednotky na aprone)',
      ready: (world) => world.cargo.countByKind('on_apron') === 2,
      check: (world) => {
        // zvyšné 2 jednotky sú ešte na lodi alebo v žeriave
        expect(world.cargo.countByKind('on_ship') + world.cargo.countByKind('in_crane')).toBe(2);
        expect(world.ships.size).toBe(1);
      },
    },
    {
      name: 'pri odplávaní (outbound)',
      ready: (world) => [...world.ships.values()].some((ship) => ship.state === 'outbound'),
      check: (world) => {
        expect(world.cargo.countByKind('on_apron')).toBe(UNITS);
      },
    },
  ];

  it.each(MOMENTS)('deserialize(serialize()) $name → rovnaký hash a rovnaký priebeh o ďalších 500 tickov', ({ ready, check }) => {
    const original = World.create(DEFS, MAP, scenario.seed);
    runUntil(original, scenario, ready, RUN_TICKS);
    check(original);

    // Cez JSON, aby sa overilo, že stav je čistý JSON (žiadne Map/Set/triedy).
    const saved = JSON.parse(JSON.stringify(original.serialize())) as WorldState;
    const restored = World.deserialize(DEFS, MAP, saved);
    expect(stateHash(restored)).toBe(stateHash(original));
    expect(restored.modules.size).toBe(original.modules.size);
    expect(restored.ships.size).toBe(original.ships.size);
    expect(restored.cargo.createdCount).toBe(original.cargo.createdCount);
    expect(restored.cargo.countByKind('on_apron')).toBe(original.cargo.countByKind('on_apron'));

    const logOriginal = recordRun(original, scenario, original.clock.tick + 500);
    const logRestored = recordRun(restored, scenario, restored.clock.tick + 500);

    expect(stateHash(restored)).toBe(stateHash(original));
    expect(logRestored.events).toEqual(logOriginal.events);
  });
});
