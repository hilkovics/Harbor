// Register pozemných modulov (review T04-11 minor e, pravidlo 7): `LandExportModule.enlist` zaradí bránu, stojisko
// a rampu podľa roly (double dispatch), `World.landsideModules` ich vedie vzostupne podľa id, obnoví sa pri zmene
// `moduleVersion` (znovupoužiteľné polia) a `rampOrdinal` dá poradie rampy bez alokácie.
// Rozloženie: harbor_01, brána (45, 32) rot 270, stojisko (49, 31), rampa (53, 28) — ako tests/sim/world/landside.test.ts.
import { describe, expect, it } from 'vitest';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { LandExportModule, LoadingRamp, TruckGate, WaitingArea, type LandsideRoster } from '@sim/modules';
import { World } from '@sim/world';
import { DEFS, MAP, SEED } from './world-fixtures';

const GATE: SerializedCommand = { type: 'PlaceModule', defId: 'truck_gate', x: 45, y: 32, rotation: 270 };
const AREA: SerializedCommand = { type: 'PlaceModule', defId: 'truck_waiting_area', x: 49, y: 31, rotation: 0 };
const RAMP: SerializedCommand = { type: 'PlaceModule', defId: 'loading_ramp_container', x: 53, y: 28, rotation: 0 };
const SECOND_RAMP: SerializedCommand = { type: 'PlaceModule', defId: 'loading_ramp_container', x: 38, y: 28, rotation: 0 };

function apply(world: World, ...commands: readonly SerializedCommand[]): void {
  for (const command of commands) world.enqueue(commandFromJSON(command));
  const rejected = world.applyPending().filter((event) => event.type === 'CommandRejected');
  expect(rejected).toEqual([]);
}

describe('LandExportModule.enlist / landsideRole', () => {
  it('každá trieda sa zaradí do svojho poľa registra a hlási svoju rolu', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, RAMP, GATE, AREA);
    const roster: LandsideRoster = { gates: [], waitingAreas: [], ramps: [] };
    const landside = [...world.modules.values()].filter((module): module is LandExportModule => module instanceof LandExportModule);
    for (const module of landside) module.enlist(roster);
    expect(landside.map((module) => module.landsideRole)).toEqual(['ramp', 'gate', 'waiting_area']);
    expect(roster.gates.map((gate) => gate instanceof TruckGate)).toEqual([true]);
    expect(roster.waitingAreas.map((area) => area instanceof WaitingArea)).toEqual([true]);
    expect(roster.ramps.map((ramp) => ramp instanceof LoadingRamp)).toEqual([true]);
  });
});

describe('World.landsideModules', () => {
  it('bez pozemných modulov prázdny; rampOrdinal neznámeho id alebo nerampy = −1', () => {
    const world = World.create(DEFS, MAP, SEED);
    const roster = world.landsideModules;
    expect([roster.gates, roster.waitingAreas, roster.ramps]).toEqual([[], [], []]);
    expect(roster.rampOrdinal(1 as EntityId)).toBe(-1);
  });

  it('vzostupne podľa id, rampOrdinal podľa poradia; pri zmene modulov sa obnoví do tých istých polí', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, RAMP, GATE, AREA, SECOND_RAMP);
    const roster = world.landsideModules;
    const ramps = roster.ramps;
    const [first, second] = ramps;
    expect(ramps.map((ramp) => ramp.id)).toEqual([...ramps.map((ramp) => ramp.id)].sort((a, b) => a - b));
    expect([roster.rampOrdinal(first.id), roster.rampOrdinal(second.id), roster.rampOrdinal(roster.gates[0].id)]).toEqual([0, 1, -1]);
    expect(world.landsideModules.ramps).toBe(ramps);

    world.removeModule(first.id);
    expect(world.landsideModules.ramps).toBe(ramps);
    expect(ramps).toEqual([second]);
    expect([world.landsideModules.rampOrdinal(second.id), world.landsideModules.rampOrdinal(first.id)]).toEqual([0, -1]);
  });

  it('obnovený svet má ten istý register', () => {
    const world = World.create(DEFS, MAP, SEED);
    apply(world, GATE, AREA, RAMP);
    const clone = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>);
    const ids = (w: World): number[][] => [w.landsideModules.gates, w.landsideModules.waitingAreas, w.landsideModules.ramps].map((list) => list.map((m) => m.id));
    expect(ids(clone)).toEqual(ids(world));
  });
});
