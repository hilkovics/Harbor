/**
 * Cesta späť a kamióny za bránou (T04-12; review T04-11 major 1 a 2; dodatok ADR-024). Scenáre na rozložení F4
 * (`helpers/f4-layout.ts`: brána 6 so vstupom (44, 33) a výstupom (47, 33), stojisko 7, rampa 8), 12 TEU, tri straddle
 * carriery. Po každom ticku beží `assertCargoConservation` + audit ledgera a jobov (`Recorder4`).
 *
 * 1. Jednosmerka, ktorá preruší cestu späť (od rampy k bráne, resp. od brány k portálu): rampa je neprevádzková
 *    s dôvodom `no_return_path`, nevznikne outbound job ani kamión (predtým 120 kamiónov v `no_path` a spawner bez
 *    stropu). Po oprave cesty rampa ožije a export dobehne.
 * 2. Prerušený vstup brány (44, 33), keď sú kamióny za bránou: dokončia okruh (nakládka uvoľní dock), čakajú vo fronte
 *    brány von a po obnove cesty odídu (predtým kamión vo `waiting` navždy držal bay aj dock).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SerializedCommand } from '@sim/commands';
import { World } from '@sim/world';
import { GATE_ENTRY_OUTSIDE, GATE_EXIT_OUTSIDE, f4Scenario } from '../helpers/f4-layout';
import { Recorder4, STRADDLES, landsideEvents, rampOf, timed4, trucksById, type Rule4 } from '../helpers/f4';
import { DEFS, MAP } from '../world/world-fixtures';

const UNITS = 12;
const RUN_TIMEOUT_MS = 300_000;
const ALL_RULES: readonly Rule4[] = ['truck_position', 'truck_queue_position', 'truck_cargo', 'truck_refs', 'bay_accounting', 'dock_conflict', 'gate_queue'];
/** Koľko tickov po naplnení skladu nechať jednosmerku stáť (outbound joby by vznikli hneď v kroku 5). */
const HOLD_TICKS = 600;
/** Koľko tickov nechať prerušený vstup brány (kamióny za bránou dokončia okruh za pár stoviek tickov). */
const CUT_TICKS = 1500;

type Dir = 'N' | 'E';

describe.each<[string, { x: number; y: number }, Dir]>([
  ['výstupe brány (47, 33) smerom E — od rampy sa k bráne nedá vrátiť', GATE_EXIT_OUTSIDE, 'E'],
  ['vstupe brány (44, 33) smerom N — od brány sa k portálu nedá vrátiť', GATE_ENTRY_OUTSIDE, 'N'],
])('jednosmerka na %s', (_name, cell, dir) => {
  let world: World;
  let recorder: Recorder4;
  let fixSentAt: number;

  beforeAll(() => {
    const oneWay: SerializedCommand = { type: 'PlaceRoad', cells: [cell], kind: 'one_way', dirs: [dir] };
    const scenario = f4Scenario(`f4_one_way_${dir}`, 4212, { vehicles: STRADDLES, units: UNITS, extra: [{ atTick: 0, command: oneWay }] });
    world = World.create(DEFS, MAP, scenario.seed);
    recorder = new Recorder4(world, scenario);
    recorder.runUntil((w) => w.cargo.countByKind('in_storage') === UNITS, 20_000);
    recorder.runTo(world.clock.tick + HOLD_TICKS);
    fixSentAt = world.clock.tick;
    recorder.send({ type: 'PlaceRoad', cells: [cell], kind: 'two_lane' });
    recorder.runUntil((w) => w.cargo.exportedCount === UNITS, 30_000);
  }, RUN_TIMEOUT_MS);

  it('kým jednosmerka stojí: rampa no_return_path, žiadny outbound job, kamión ani NoWaitingBay; náklad čaká v sklade', () => {
    const ramp = rampOf(world);
    const changes = landsideEvents(recorder.events, 'RampOperationalChanged').filter((entry) => entry.tick <= fixSentAt);
    expect(changes.at(-1)?.event).toEqual({ type: 'RampOperationalChanged', rampId: ramp.id, operational: false, reason: 'no_return_path' });
    expect(timed4(recorder.events, 'JobCreated').filter((entry) => entry.tick <= fixSentAt && entry.event.toModuleId === ramp.id)).toEqual([]);
    expect(landsideEvents(recorder.events, 'TruckSpawned').filter((entry) => entry.tick <= fixSentAt)).toEqual([]);
    expect(landsideEvents(recorder.events, 'NoWaitingBay').filter((entry) => entry.tick <= fixSentAt)).toEqual([]);
    for (const sample of recorder.ramps.filter((entry) => entry.tick > 1 && entry.tick <= fixSentAt)) expect(sample.operational, `tick ${String(sample.tick)}`).toBe(false);
    expect(timed4(recorder.events, 'CommandRejected')).toEqual([]);
  });

  it('po oprave cesty rampa ožije, všetkých 12 jednotiek je exported a svet je prázdny; pravidlá kamiónov držali po každom ticku', () => {
    const turnedOn = landsideEvents(recorder.events, 'RampOperationalChanged').filter((entry) => entry.tick > fixSentAt && entry.event.operational);
    expect(turnedOn).toHaveLength(1);
    expect(world.cargo.exportedCount).toBe(UNITS);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.trucks.size).toBe(0);
    expect(recorder.ticksChecked).toBe(world.clock.tick);
    for (const rule of ALL_RULES) expect(recorder.violationsOf(rule), rule).toEqual([]);
  });
});

describe('prerušený vstup brány (44, 33) s kamiónmi za bránou: dokončia okruh, uvoľnia docky, čakajú pri bráne a po obnove odídu', () => {
  let world: World;
  let recorder: Recorder4;
  let cutSentAt: number;
  let behindAtCut: number[];
  let afterCut: { readonly id: number; readonly state: string; readonly resume: string | null; readonly dockHeld: boolean }[];

  beforeAll(() => {
    const scenario = f4Scenario('f4_gate_entry_cut', 4213, { vehicles: STRADDLES, units: UNITS });
    world = World.create(DEFS, MAP, scenario.seed);
    recorder = new Recorder4(world, scenario);
    const entry = world.grid.index(GATE_ENTRY_OUTSIDE.x, GATE_ENTRY_OUTSIDE.y);
    recorder.runUntil((w) => [...w.trucks.values()].some((truck) => truck.state === 'waiting') && w.carrierOnCell(entry) === undefined, 20_000);
    behindAtCut = [...world.trucks.values()].filter((truck) => ['to_bay', 'waiting', 'to_dock', 'loading'].includes(truck.state)).map((truck) => truck.id);
    cutSentAt = world.clock.tick;
    recorder.send({ type: 'RemoveRoad', cells: [GATE_ENTRY_OUTSIDE] });
    recorder.runTo(cutSentAt + CUT_TICKS);
    const [ramp] = world.landsideModules.ramps;
    afterCut = [...world.trucks.values()].map((truck) => ({
      id: truck.id,
      state: truck.state,
      resume: truck.resume,
      dockHeld: ramp.dockTruck(truck.dock) === truck.id,
    }));
    recorder.send({ type: 'PlaceRoad', cells: [GATE_ENTRY_OUTSIDE] });
    recorder.runUntil((w) => w.cargo.exportedCount === UNITS, 30_000);
  }, RUN_TIMEOUT_MS);

  it('kamióny za bránou v čase prerušenia naložili, dock nedržia a čakajú v no_path s návratom do to_gate_out (výstupný pruh je od R4 mimo prerušeného vstupu, ale cesta k nemu vedie cez prerušenú bunku)', () => {
    expect(behindAtCut.length).toBeGreaterThan(0);
    for (const id of behindAtCut) {
      const truck = afterCut.find((entry) => entry.id === id);
      expect(truck, `kamión ${String(id)}`).toMatchObject({ state: 'no_path', resume: 'to_gate_out', dockHeld: false });
    }
    expect(timed4(recorder.events, 'CommandRejected')).toEqual([]);
  });

  it('počas prerušenia nevznikol nový kamión a žiadny nenakladá ani nečaká v stojisku (nič nedrží dock za bránou)', () => {
    const cutEnd = cutSentAt + CUT_TICKS;
    expect(landsideEvents(recorder.events, 'TruckSpawned').filter((entry) => entry.tick > cutSentAt + 1 && entry.tick <= cutEnd)).toEqual([]);
    expect(afterCut.filter((truck) => ['to_bay', 'waiting', 'to_dock', 'loading'].includes(truck.state))).toEqual([]);
    // Kamióny pred bránou (bez cesty k vstupu) čakajú v no_path s bay a dockom — návrat ani preradenie nie je (BACKLOG).
    for (const truck of afterCut) expect(truck).toMatchObject({ state: 'no_path', resume: expect.stringMatching(/^to_gate/) });
  });

  it('po obnove cesty je všetkých 12 jednotiek exported, svet je prázdny a pravidlá kamiónov držali po každom ticku', () => {
    expect(world.cargo.exportedCount).toBe(UNITS);
    expect(world.cargo.liveCount).toBe(0);
    expect(trucksById(world)).toEqual([]);
    expect(recorder.ticksChecked).toBe(world.clock.tick);
    for (const rule of ALL_RULES) expect(recorder.violationsOf(rule), rule).toEqual([]);
  });
});
