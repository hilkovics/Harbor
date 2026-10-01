/**
 * Obnova pozemného reťazca zo save v4+ (T06-07, BACKLOG P2 „WorldState v4 restore: validácia gates, waiting areas,
 * ramps, trucks"): väzby kamióna na moduly a odpočty stavov s čakaním → `WorldStateError` s presnou cestou poľa.
 *
 * - `rampId` / `gateId` / `waitingAreaId` musia byť moduly toho druhu vo svete — chyba patrí poľu, ktoré odkazuje zle
 *   (pred T06-07 všetko hlásilo `/rampId`);
 * - `dock` v rozsahu `docks` rampy a `bay` v rozsahu `bays` stojiska (`/dock`, `/bay`);
 * - `waitTicks` najviac toľko, koľko stav môže nastaviť: `waiting` max(pobyt stojiska, `repathIntervalTicks`),
 *   `loading` `loadTicksPerUnit` rampy, `no_path` `repathIntervalTicks` (`/waitTicks`) — inak by kamión „zaspal".
 * Platný save sa obnoví a serializuje rovnako (aj s odpočtom presne na hranici).
 */
import { describe, expect, it } from 'vitest';
import type { SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { LoadingRamp } from '@sim/modules';
import type { TruckState } from '@sim/trucks';
import { World, WorldStateError, type WorldState } from '@sim/world';
import { areaOf, execute, gateOf, outboundWorld, rampOf } from '../logistics/outbound-fixtures';
import { DEFS, MAP } from './world-fixtures';

type Json = Record<string, unknown>;

const REPATH = DEFS.logistics.repathIntervalTicks;
/** Cesta medzi rampou a stojiskom (rozloženie outbound-fixtures); bez nej kamión po nakládke ostane v `no_path`. */
const RAMP_LINK: SerializedCommand = { type: 'RemoveRoad', cells: [{ x: 53, y: 32 }] };

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `count` jednotiek priamo na dock rampy cez ledger (len povolené prechody §7.1). */
function stage(world: World, ramp: LoadingRamp, dock: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
  }
}

interface Saved {
  readonly state: WorldState;
  /** Index kamióna v `/trucks`, ktorý je v hľadanom stave. */
  readonly index: number;
}

/** Svet s bránou (6), stojiskom (7) a rampou (8), dvomi jednotkami na docku 0 a jednou na docku 1. */
function landside(): World {
  const { world } = outboundWorld({ defs: DEFS });
  const ramp = rampOf(world);
  stage(world, ramp, 0, 2);
  stage(world, ramp, 1, 1);
  return world;
}

/** Save v prvom ticku, keď je niektorý kamión v stave `state` (voliteľne po príkaze pri prvom výskyte `after`). */
function savedIn(state: TruckState, after?: { readonly state: TruckState; readonly command: SerializedCommand }): Saved {
  const world = landside();
  let issued = false;
  for (let tick = 0; tick < 3000; tick++) {
    world.tick();
    const trucks = [...world.trucks.values()];
    if (after !== undefined && !issued && trucks.some((truck) => truck.state === after.state)) {
      execute(world, after.command);
      issued = true;
    }
    const index = trucks.findIndex((truck) => truck.state === state);
    if (index >= 0) return { state: viaJson(world.serialize()), index };
  }
  throw new Error(`kamión v stave '${state}' do 3000 tickov nebol`);
}

function trucksOf(state: WorldState): Json[] {
  return (state as unknown as { trucks: Json[] }).trucks;
}

function stateError(state: WorldState): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, state);
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw error;
  }
  throw new Error('očakávaná WorldStateError');
}

/** Upraví kópiu save a vráti cestu chyby obnovy. */
function errorPath(saved: Saved, mutate: (truck: Json, state: WorldState) => void): string {
  const state = viaJson(saved.state);
  mutate(trucksOf(state)[saved.index], state);
  return stateError(state).path;
}

function idOf(world: World, pick: (world: World) => { readonly id: EntityId }): number {
  return pick(world).id;
}

describe('obnova kamiónov: väzby na moduly s presnou cestou (T06-07)', () => {
  const ids = (() => {
    const world = landside();
    return { gate: idOf(world, gateOf), area: idOf(world, areaOf), ramp: idOf(world, rampOf), yard: 5 };
  })();

  it.each<[string, string, (truck: Json) => void]>([
    ['brána je sklad', 'gateId', (truck) => (truck['gateId'] = ids.yard)],
    ['brána neexistuje', 'gateId', (truck) => (truck['gateId'] = 999)],
    ['stojisko je rampa', 'waitingAreaId', (truck) => (truck['waitingAreaId'] = ids.ramp)],
    ['stojisko neexistuje', 'waitingAreaId', (truck) => (truck['waitingAreaId'] = 999)],
    ['rampa je brána', 'rampId', (truck) => (truck['rampId'] = ids.gate)],
    ['dock mimo rozsahu rampy', 'dock', (truck) => (truck['dock'] = 7)],
    ['bay mimo rozsahu stojiska', 'bay', (truck) => (truck['bay'] = 99)],
  ])('%s → /trucks/<i>/%s', (_name, field, mutate) => {
    const saved = savedIn('waiting');
    expect(errorPath(saved, mutate)).toBe(`/trucks/${String(saved.index)}/${field}`);
  });
});

describe('obnova kamiónov: odpočet stavu s čakaním najviac toľko, koľko stav nastaví (T06-07)', () => {
  it('waiting: hranica max(pobyt stojiska, repathIntervalTicks) prejde, o 1 viac → /waitTicks', () => {
    const saved = savedIn('waiting');
    const world = landside();
    const area = areaOf(world);
    const limit = Math.max(1, area.internalTicks ?? DEFS.logistics.defaultInternalTicks, REPATH);
    const valid = viaJson(saved.state);
    trucksOf(valid)[saved.index]['waitTicks'] = limit;
    expect(JSON.stringify(World.deserialize(DEFS, MAP, viaJson(valid)).serialize())).toBe(JSON.stringify(valid));
    expect(errorPath(saved, (truck) => (truck['waitTicks'] = limit + 1))).toBe(`/trucks/${String(saved.index)}/waitTicks`);
  });

  it('loading: najviac loadTicksPerUnit rampy → inak /waitTicks', () => {
    const saved = savedIn('loading');
    const load = rampOf(landside()).params.loadTicksPerUnit;
    const valid = viaJson(saved.state);
    trucksOf(valid)[saved.index]['waitTicks'] = load;
    expect(() => World.deserialize(DEFS, MAP, viaJson(valid))).not.toThrow();
    expect(errorPath(saved, (truck) => (truck['waitTicks'] = load + 1))).toBe(`/trucks/${String(saved.index)}/waitTicks`);
  });

  it('no_path: najviac repathIntervalTicks → inak /waitTicks', () => {
    const saved = savedIn('no_path', { state: 'loading', command: RAMP_LINK });
    expect(() => World.deserialize(DEFS, MAP, viaJson(saved.state))).not.toThrow();
    expect(errorPath(saved, (truck) => (truck['waitTicks'] = REPATH + 1))).toBe(`/trucks/${String(saved.index)}/waitTicks`);
  });
});
