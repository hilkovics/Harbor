// Joby vo svete (T03-05; ARCHITECTURE §6 krok 12, §7.3, §14; ADR-018): World.addJob/removeJob (JobError, svet sa pri
// chybe nemení), index jobOfUnit, invarianty kroku 12 (job ↔ vozidlo ↔ náklad ↔ rezervácie skladu) a obnova zo save
// (vozidlo a stav jobu odvodené, rezervácie z `to`, chyby s JSON pointermi).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { JobError, TransportJob } from '@sim/logistics';
import type { BerthModule, StorageModule } from '@sim/modules';
import { World, WorldStateError, findWorldViolation, type WorldState } from '@sim/world';
import { DEFS, MAP } from './world-fixtures';
import { ROOT_BERTH_ID, YARD_W, buyVehicle, dispatchWorld, placeYard, unitsOnApron } from '../logistics/dispatch-fixtures';

const id = (value: number): EntityId => value as EntityId;

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jobError(action: () => unknown): JobError {
  try {
    action();
  } catch (error) {
    if (error instanceof JobError) return error;
    throw error;
  }
  throw new Error('očakávaná JobError');
}

function stateError(action: () => unknown): WorldStateError {
  try {
    action();
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw error;
  }
  throw new Error('očakávaná WorldStateError');
}

interface JobWorld {
  readonly world: World;
  readonly yard: StorageModule;
  readonly units: EntityId[];
}

/** Svet s dvorom W a jednotkami na aprone (bez jobov — tie vytvára test). */
function jobWorld(slots: readonly number[] = [0, 1]): JobWorld {
  const { world } = dispatchWorld();
  const yard = placeYard(world, YARD_W);
  return { world, yard, units: unitsOnApron(world, slots) };
}

/** Job open pre jednotku (ako dispatcher: nové id, rezervácia slotu). */
function openJob(world: World, yard: StorageModule, unit: EntityId): TransportJob {
  const location = world.cargo.get(unit)?.location;
  if (location === undefined) throw new Error('jednotka neexistuje');
  const job = new TransportJob({ id: world.ids.next(), unitIds: [unit], from: location, to: { kind: 'in_storage', moduleId: yard.id, slot: yard.reserve() }, createdTick: 0 });
  world.addJob(job);
  return job;
}

describe('World.addJob / removeJob / jobOfUnit', () => {
  it('addJob: world.jobs vzostupne podľa id, jobOfUnit, serialize.jobs; removeJob len hotového jobu', () => {
    const { world, yard, units } = jobWorld();
    const a = openJob(world, yard, units[0]);
    const b = openJob(world, yard, units[1]);
    expect([...world.jobs.keys()]).toEqual([a.id, b.id]);
    expect([world.jobOfUnit(units[0]), world.jobOfUnit(units[1]), world.jobUnitCount]).toEqual([a, b, 2]);
    expect(world.serialize().jobs).toEqual([a.toState(), b.toState()]);
    expect(findWorldViolation(world)).toBeUndefined();
    expect(jobError(() => world.removeJob(a.id)).code).toBe('not_done');
    expect(jobError(() => world.removeJob(id(9999))).code).toBe('unknown_job');
  });

  it('chyby addJob: duplicitné id (job, modul, jednotka), id mimo alokátora alebo menšie ako posledný job, done, neznáma jednotka, jednotka mimo zdroja, jednotka s jobom', () => {
    const { world, yard, units } = jobWorld([0, 1, 2]);
    const first = openJob(world, yard, units[0]);
    const make = (overrides: Partial<ConstructorParameters<typeof TransportJob>[0]> = {}): TransportJob =>
      new TransportJob({ id: world.ids.next(), unitIds: [units[1]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 1 }, to: { kind: 'in_storage', moduleId: yard.id, slot: 9 }, createdTick: 0, ...overrides });
    expect(jobError(() => world.addJob(make({ id: first.id }))).code).toBe('duplicate_id');
    expect(jobError(() => world.addJob(make({ id: yard.id }))).code).toBe('duplicate_id');
    expect(jobError(() => world.addJob(make({ id: units[2] }))).code).toBe('duplicate_id');
    expect(jobError(() => world.addJob(make({ id: id(world.ids.getState().nextId + 3) }))).code).toBe('invalid_input');
    const older = world.ids.next();
    world.addJob(make());
    expect(jobError(() => world.addJob(make({ id: older, unitIds: [units[2]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 2 } }))).code).toBe('invalid_input');
    const done = make({ unitIds: [units[2]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 2 }, state: 'done', vehicleId: id(77) });
    expect(jobError(() => world.addJob(done)).code).toBe('invalid_input');
    expect(jobError(() => world.addJob(make({ unitIds: [id(8888)] }))).code).toBe('unknown_unit');
    expect(jobError(() => world.addJob(make({ unitIds: [units[2]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 3 } }))).code).toBe('unknown_unit');
    expect(jobError(() => world.addJob(make({ unitIds: [units[0]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 0 } }))).code).toBe('unit_busy');
    expect(world.jobs.size).toBe(2);
    expect(world.jobOfUnit(units[2])).toBeUndefined();
  });

  it('poradie addJob porovnáva s najväčším prítomným id: po odstránení posledného jobu prejde staršie id nad ostatnými (T03-14)', () => {
    const { world, yard, units } = jobWorld([0, 1, 2]);
    const finish = (job: TransportJob): void => {
      job.assign(id(50));
      for (const state of ['picking', 'moving', 'dropping', 'done'] as const) job.transition(state);
    };
    const first = openJob(world, yard, units[0]);
    const middleId = world.ids.next();
    const newest = openJob(world, yard, units[1]);
    finish(newest);
    world.removeJob(newest.id);
    const from = world.cargo.get(units[2])?.location;
    if (from === undefined) throw new Error('jednotka');
    const middle = new TransportJob({ id: middleId, unitIds: [units[2]], from, to: { kind: 'in_storage', moduleId: yard.id, slot: yard.reserve() }, createdTick: 0 });
    world.addJob(middle);
    expect([...world.jobs.keys()]).toEqual([first.id, middleId]);
    finish(middle);
    world.removeJob(middle.id);
    finish(first);
    world.removeJob(first.id);
    expect(world.jobs.size).toBe(0);
    const older = new TransportJob({ id: first.id, unitIds: [units[0]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 0 }, to: { kind: 'in_storage', moduleId: yard.id, slot: yard.reserve() }, createdTick: 0 });
    world.addJob(older); // prázdna mapa → bez porovnania
    expect([...world.jobs.keys()]).toEqual([first.id]);
  });

  it('removeJob hotového jobu: zmizne z world.jobs aj z indexu', () => {
    const { world, yard, units } = jobWorld([0]);
    const job = new TransportJob({ id: world.ids.next(), unitIds: [units[0]], from: { kind: 'on_apron', berthId: ROOT_BERTH_ID, slot: 0 }, to: { kind: 'in_storage', moduleId: yard.id, slot: 0 }, createdTick: 0 });
    world.addJob(job);
    job.assign(id(50));
    for (const state of ['picking', 'moving', 'dropping', 'done'] as const) job.transition(state);
    expect(world.removeJob(job.id)).toBe(job);
    expect([world.jobs.size, world.jobOfUnit(units[0]), world.jobUnitCount]).toEqual([0, undefined, 0]);
  });
});

describe('invarianty jobov (krok 12)', () => {
  it('konzistentný svet s jobmi open aj assigned prejde; job bez rezervácie, rezervácia bez jobu a job/vozidlo v rozpore nie', () => {
    const { world, depot } = dispatchWorld();
    const yard = placeYard(world, YARD_W);
    const vehicle = buyVehicle(world, depot);
    unitsOnApron(world, [0, 1]);
    world.tick();
    expect(findWorldViolation(world)).toBeUndefined();
    const [assigned, open] = [...world.jobs.values()];
    expect([assigned.state, open.state]).toEqual(['assigned', 'open']);

    yard.release(3);
    expect(findWorldViolation(world)).toMatch(/job #\d+: miesto 3 \('in_storage'\) nie je rezervované/);
    yard.reserveSlot(3);
    yard.reserve();
    expect(findWorldViolation(world)).toMatch(/rezervované sloty \[0, 1, 3\] ≠ sloty aktívnych jobov \[0, 3\]/);
    yard.release(1);
    expect(findWorldViolation(world)).toBeUndefined();

    assigned.transition('picking'); // vozidlo ostalo v to_pickup
    expect(findWorldViolation(world)).toMatch(/v stave 'to_pickup' má job #\d+ v stave 'picking'/);
    expect(world.vehicles.get(vehicle)?.state).toBe('to_pickup');
  });

  it('dva joby s tým istým slotom a rezervácia navyše: počty sedia, súčty slotov rozpor odhalia (T03-14)', () => {
    const { world, yard, units } = jobWorld([0, 1]);
    const first = openJob(world, yard, units[0]);
    const from = world.cargo.get(units[1])?.location;
    if (from === undefined) throw new Error('jednotka');
    world.addJob(new TransportJob({ id: world.ids.next(), unitIds: [units[1]], from, to: first.to, createdTick: 0 }));
    expect(yard.reserve()).toBe(1);
    expect(yard.reservedCount).toBe(world.jobs.size);
    expect(findWorldViolation(world)).toMatch(/rezervované sloty \[0, 1\] ≠ sloty aktívnych jobov \[0, 0\]/);
  });

  it('jednotka jobu open mimo zdroja (presun bez vozidla) → porušenie', () => {
    const { world, yard, units } = jobWorld([0]);
    openJob(world, yard, units[0]);
    world.cargo.move(units[0], { kind: 'in_vehicle', vehicleId: id(4040) });
    expect(findWorldViolation(world)).toMatch(/in_vehicle|nie je na zdroji/);
  });
});

describe('WorldState v3 — joby v save', () => {
  function savedWithJobs(): { world: World; state: WorldState } {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    buyVehicle(world, depot);
    unitsOnApron(world, [0, 1]);
    world.tick();
    return { world, state: viaJson(world.serialize()) };
  }

  it('roundtrip: joby (stav a vozidlo odvodené), index, rezervácie skladu z to; krok 12 prechádza', () => {
    const { world, state } = savedWithJobs();
    expect(state.jobs.map((job) => Object.keys(job))).toEqual([
      ['id', 'unitIds', 'from', 'to', 'createdTick'],
      ['id', 'unitIds', 'from', 'to', 'createdTick'],
    ]);
    const restored = World.deserialize(DEFS, MAP, state);
    expect(restored.serialize()).toEqual(state);
    expect([...restored.jobs.values()].map((job) => [job.id, job.state, job.vehicleId])).toEqual([...world.jobs.values()].map((job) => [job.id, job.state, job.vehicleId]));
    for (const job of restored.jobs.values()) expect(restored.jobOfUnit(job.unitIds[0])).toBe(job);
    const yard = restored.moduleAt(YARD_W.x, YARD_W.y) as StorageModule;
    expect(yard.reservedSlots()).toEqual([0, 3]);
    expect(() => restored.assertInvariants()).not.toThrow();
    expect((restored.modules.get(ROOT_BERTH_ID) as BerthModule).lastNoStorageHour).toBeNull();
  });

  type Mutation = (state: {
    ids: { nextId: number };
    clock: { tick: number };
    modules: { id: number; runtime: Record<string, unknown> }[];
    vehicles: Record<string, unknown>[];
    jobs: Record<string, unknown>[];
    cargo: { units: { id: number }[] };
  }) => void;
  const CASES: readonly [string, Mutation, string, RegExp?][] = [
    ['job s id modulu', (s) => (s.jobs[0].id = 3), '/jobs/0/id', /patrí modulu/],
    ['joby nie vzostupne', (s) => ([s.jobs[0].id, s.jobs[1].id] = [s.jobs[1].id, s.jobs[0].id]), '/jobs/1/id', /vzostupne/],
    ['id ≥ nextId', (s) => (s.jobs[1].id = s.ids.nextId), '/jobs/1/id'],
    ['prázdne unitIds', (s) => (s.jobs[0].unitIds = []), '/jobs/0/unitIds'],
    ['neznámy kľúč', (s) => (s.jobs[0].state = 'open'), '/jobs/0/state'],
    ['nepovolená dvojica lokácií', (s) => (s.jobs[0].to = { kind: 'in_vehicle', vehicleId: 9 }), '/jobs/0/to/kind', /JOB_ROUTES/],
    ['neplatná lokácia', (s) => (s.jobs[0].from = { kind: 'on_apron', berthId: 1 }), '/jobs/0/from/slot'],
    ['createdTick v budúcnosti', (s) => (s.jobs[0].createdTick = s.clock.tick + 1), '/jobs/0/createdTick'],
    ['jednotka jobu v save nie je', (s) => (s.jobs[1].unitIds = [s.ids.nextId - 1]), '/jobs/1/unitIds/0'],
    ['jednotka nie je na zdroji jobu', (s) => (s.jobs[1].from = { kind: 'on_apron', berthId: 1, slot: 3 }), '/jobs/1/unitIds/0', /zdroji/],
    ['jednotka v dvoch joboch', (s) => ((s.jobs[1].unitIds = s.jobs[0].unitIds), (s.jobs[1].from = s.jobs[0].from)), '/jobs/1/unitIds', /už má/],
    ['cieľ nie je sklad', (s) => (s.jobs[0].to = { kind: 'in_storage', moduleId: 3, slot: 0 }), '/jobs/0/to/moduleId', /neprijíma náklad jobu do 'in_storage'/],
    ['slot mimo kapacity', (s) => (s.jobs[0].to = { kind: 'in_storage', moduleId: 4, slot: 64 }), '/jobs/0/to/slot'],
    ['dva joby na jeden slot', (s) => (s.jobs[1].to = s.jobs[0].to), '/jobs/1/to/slot', /rezervovan/],
    ['vozidlo s jobom, ktorý v save nie je', (s) => (s.vehicles[0].jobId = 999), '/vehicles/0/jobId', /job #999 vo svete neexistuje/],
    ['hodina NoStorageAvailable v budúcnosti', (s) => (s.modules[0].runtime.lastNoStorageHour = 5), '/modules/0/runtime/lastNoStorageHour'],
    ['runtime kotviska bez hodiny', (s) => (s.modules[0].runtime = {}), '/modules/0/runtime/lastNoStorageHour'],
  ];

  it.each(CASES)('%s → WorldStateError na %s', (_name, mutate, path, message) => {
    const { state } = savedWithJobs();
    mutate(state as unknown as Parameters<Mutation>[0]);
    const error = stateError(() => World.deserialize(DEFS, MAP, state));
    expect(error.path).toBe(path);
    if (message !== undefined) expect(error.message).toMatch(message);
  });

  it('dve vozidlá s tým istým jobom → chyba druhého vozidla', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    buyVehicle(world, depot);
    buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    world.tick();
    const state = viaJson(world.serialize()) as unknown as { vehicles: Record<string, unknown>[] };
    state.vehicles[1].state = 'to_pickup';
    state.vehicles[1].jobId = state.vehicles[0].jobId;
    const error = stateError(() => World.deserialize(DEFS, MAP, state as unknown as WorldState));
    expect(error.path).toBe('/vehicles/1/jobId');
    expect(error.message).toMatch(/už má vozidlo/);
  });
});
