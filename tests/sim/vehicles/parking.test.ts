// Parkovanie vozidiel (TR1-04; ADR-037 bod 7, rozhodnutie orchestrátora R1 č. 11): nečinné vozidlo po `idleParkDelayTicks` ide do depa
// (`idle → to_depot → parked`), zaparkované vozidlo je mimo cesty a nedrží slot, priradenie z `parked` ide cez `depot_exit` (voľný slot
// prístupovej bunky depa), z `idle` a `to_depot` priamo `to_pickup`; kúpené vozidlo vzniká `parked`. Rozloženie: dispatch-fixtures.
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { Vehicle } from '@sim/vehicles';
import { carrierOverlapProblem, slotKey } from '@sim/traffic';
import type { World } from '@sim/world';
import { DEPOT_ACCESS, YARD_W, YARD_W_ACCESS, cellIndex, buyVehicle, dispatchWorld, execute, placeYard, unitsOnApron } from '../logistics/dispatch-fixtures';
import { DEFS } from '../world/world-fixtures';

interface Timed {
  readonly tick: number;
  readonly event: SimEvent;
}

const PARK_DELAY = DEFS.logistics.traffic.idleParkDelayTicks;

function run(world: World, ticks: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < ticks; i++) for (const event of world.tick()) log.push({ tick: world.clock.tick, event });
  return log;
}

function runUntil(world: World, done: (log: readonly Timed[]) => boolean, limit: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < limit && !done(log); i++) run(world, 1, log);
  if (!done(log)) throw new Error(`podmienka nenastala do ${String(limit)} tickov`);
  return log;
}

const stateChange = (vehicleId: EntityId, from: string, to: string) => (entry: Timed): boolean =>
  entry.event.type === 'VehicleStateChanged' && entry.event.vehicleId === vehicleId && entry.event.from === from && entry.event.to === to;

const seen = (log: readonly Timed[], predicate: (entry: Timed) => boolean): boolean => log.some(predicate);
const tickOf = (log: readonly Timed[], predicate: (entry: Timed) => boolean): number => {
  const found = log.find(predicate);
  if (found === undefined) throw new Error('udalosť nenastala');
  return found.tick;
};

/** Svet: dvor W, jedno vozidlo v depe, jedna jednotka na aprone. */
function oneVehicleWorld(): { world: World; vehicleId: EntityId; depotCell: number } {
  const { world, depot } = dispatchWorld();
  placeYard(world, YARD_W);
  const vehicleId = buyVehicle(world, depot);
  unitsOnApron(world, [0]);
  return { world, vehicleId, depotCell: world.grid.index(DEPOT_ACCESS.x, DEPOT_ACCESS.y) };
}

describe('kúpené vozidlo a zaparkované vozidlo', () => {
  it('kúpené vozidlo vzniká parked na prístupovej bunke depa; nedrží žiadny slot a krok 12 prechádza', () => {
    const { world, depot } = dispatchWorld();
    const vehicleId = buyVehicle(world, depot);
    world.tick();
    const vehicle = world.vehicles.get(vehicleId);
    expect([vehicle?.state, vehicle?.cell, vehicle?.body.length, vehicle?.ahead.length]).toEqual(['parked', world.grid.index(DEPOT_ACCESS.x, DEPOT_ACCESS.y), 0, 0]);
    expect(world.laneSlots.claimedCount).toBe(0);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('dve zaparkované vozidlá stoja na tej istej bunke depa naraz (zaparkované vozidlo je mimo cesty)', () => {
    const { world, depot } = dispatchWorld();
    const a = buyVehicle(world, depot);
    const b = buyVehicle(world, depot);
    run(world, 50);
    expect([world.vehicles.get(a)?.cell, world.vehicles.get(b)?.cell]).toEqual([world.vehicles.get(a)?.cell, world.vehicles.get(a)?.cell]);
    expect([world.vehicles.get(a)?.state, world.vehicles.get(b)?.state]).toEqual(['parked', 'parked']);
    expect(world.laneSlots.claimedCount).toBe(0);
    expect(() => world.assertInvariants()).not.toThrow();
  });
});

describe('nečinné vozidlo ide do depa', () => {
  it('po dokončení jobu: idle → (idleParkDelayTicks) → to_depot → parked na prístupovej bunke depa; zaparkované nedrží slot', () => {
    const { world, vehicleId, depotCell } = oneVehicleWorld();
    const log = runUntil(world, (l) => seen(l, stateChange(vehicleId, 'to_depot', 'parked')), 400);
    const idleAt = tickOf(log, stateChange(vehicleId, 'unloading', 'idle'));
    const leftAt = tickOf(log, stateChange(vehicleId, 'idle', 'to_depot'));
    const parkedAt = tickOf(log, stateChange(vehicleId, 'to_depot', 'parked'));
    expect(leftAt - idleAt).toBe(PARK_DELAY);
    expect(parkedAt).toBeGreaterThan(leftAt);
    const vehicle = world.vehicles.get(vehicleId);
    expect([vehicle?.state, vehicle?.cell, vehicle?.jobId, vehicle?.body.length]).toEqual(['parked', depotCell, null, 0]);
    expect(world.laneSlots.claimedCount).toBe(0);
    // počas cesty do depa vozidlo drží sloty (je na ceste) a v tom istom ticku ich pri zaparkovaní uvoľní
    expect(world.cargo.countAt('in_vehicle', vehicleId)).toBe(0);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('v to_depot vozidlo drží sloty a je voľné pre dispatcher: nový job dostane priamo (to_depot → to_pickup, bez depot_exit)', () => {
    const { world, vehicleId } = oneVehicleWorld();
    const log = runUntil(world, (l) => seen(l, stateChange(vehicleId, 'idle', 'to_depot')), 400);
    expect(world.vehicles.get(vehicleId)?.state).toBe('to_depot');
    expect(world.vehicles.get(vehicleId)?.body.length).toBeGreaterThan(0);
    unitsOnApron(world, [1]);
    runUntil(world, (l) => seen(l, stateChange(vehicleId, 'to_depot', 'to_pickup')), 5, log);
    expect(seen(log, stateChange(vehicleId, 'to_depot', 'parked'))).toBe(false);
    expect(world.vehicles.get(vehicleId)?.state).toBe('to_pickup');
    expect(world.vehicles.get(vehicleId)?.jobId).not.toBeNull();
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('idle vozidlo dostane nový job pred odchodom do depa: idle → to_pickup (odpočet parkovania zaniká)', () => {
    const { world, vehicleId } = oneVehicleWorld();
    const log = runUntil(world, (l) => seen(l, stateChange(vehicleId, 'unloading', 'idle')), 400);
    unitsOnApron(world, [1]);
    runUntil(world, (l) => seen(l, stateChange(vehicleId, 'idle', 'to_pickup')), 3, log);
    expect(seen(log, stateChange(vehicleId, 'idle', 'to_depot'))).toBe(false);
    expect(world.vehicles.get(vehicleId)?.waitTicks).toBe(0);
  });

  it('bez cesty do depa vozidlo ostáva idle a po obnove cesty odíde', () => {
    const { world, vehicleId } = oneVehicleWorld();
    const log = runUntil(world, (l) => seen(l, stateChange(vehicleId, 'unloading', 'idle')), 400);
    // cesta medzi dvorom (37, 18) a depom (32, 18) sa preruší za vozidlom
    execute(world, { type: 'RemoveRoad', cells: [{ x: 35, y: 18 }] });
    run(world, 4 * PARK_DELAY, log);
    // vozidlo bez cesty k depu uvoľní vjazd dvora (TR5-06b) a stojí `idle` mimo vjazdov
    expect(world.vehicles.get(vehicleId)?.state).toBe('idle');
    expect(world.vehicles.get(vehicleId)?.cell).not.toBe(cellIndex(world, YARD_W_ACCESS));
    expect(seen(log, stateChange(vehicleId, 'to_depot', 'parked'))).toBe(false);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 35, y: 18 }] });
    runUntil(world, (l) => seen(l, stateChange(vehicleId, 'to_depot', 'parked')), 400, log);
    expect(world.vehicles.get(vehicleId)?.state).toBe('parked');
  });

  it('cesta do depa zanikla počas to_depot (stojí v strede bunky): vozidlo prejde do idle a skúša znova', () => {
    const { world, vehicleId } = oneVehicleWorld();
    const log = runUntil(world, (l) => seen(l, stateChange(vehicleId, 'idle', 'to_depot')), 400);
    // odstráň cestu pred vozidlom (pred depom) — vozidlo je v to_depot a preplánovanie nenájde cestu
    const vehicle = world.vehicles.get(vehicleId) as Vehicle;
    const ahead = vehicle.routeCellAt(vehicle.cellsAhead - 1);
    expect(ahead).toBeDefined();
    const cellX = (ahead as number) % world.grid.width;
    const cellY = Math.floor((ahead as number) / world.grid.width);
    const before = world.roadVersion;
    execute(world, { type: 'RemoveRoad', cells: [{ x: cellX, y: cellY }] });
    expect(world.roadVersion).toBeGreaterThan(before);
    run(world, 120, log);
    expect(['idle', 'to_depot']).toContain(world.vehicles.get(vehicleId)?.state);
    expect(world.vehicles.get(vehicleId)?.state).not.toBe('parked');
    expect(() => world.assertInvariants()).not.toThrow();
  });
});

describe('vozidlo bez cesty k depu neblokuje vjazd (TR5-06b)', () => {
  it('po odrezaní depa uvoľní vjazd dvora, 5000 ticks bez TrafficJam; po obnove cesty zaparkuje', () => {
    const { world, vehicleId } = oneVehicleWorld();
    const log = runUntil(world, (l) => seen(l, stateChange(vehicleId, 'unloading', 'idle')), 400);
    const entry = cellIndex(world, YARD_W_ACCESS);
    expect(world.vehicles.get(vehicleId)?.cell).toBe(entry);
    execute(world, { type: 'RemoveRoad', cells: [{ x: 35, y: 18 }] });
    run(world, 5000, log);
    const vehicle = world.vehicles.get(vehicleId) as Vehicle;
    expect(vehicle.state).toBe('idle');
    expect(vehicle.cell).not.toBe(entry);
    expect(log.filter((entry) => entry.event.type === 'TrafficJam')).toEqual([]);
    expect(world.laneSlots.holderOfKey(slotKey(entry, 0))).toBe(0);
    expect(world.laneSlots.holderOfKey(slotKey(entry, 1))).toBe(0);
    expect(() => world.assertInvariants()).not.toThrow();
    execute(world, { type: 'PlaceRoad', cells: [{ x: 35, y: 18 }] });
    runUntil(world, (l) => seen(l, stateChange(vehicleId, 'to_depot', 'parked')), 1000, log);
    expect(world.vehicles.get(vehicleId)?.state).toBe('parked');
  });
});

describe('priradenie zaparkovaného vozidla (depot_exit)', () => {
  it('z parked cez depot_exit: voľný slot prístupovej bunky → to_pickup a slot hlavy v tom istom ticku ako priradenie', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const vehicleId = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    const log = run(world, 1);
    expect(seen(log, stateChange(vehicleId, 'parked', 'depot_exit'))).toBe(true);
    expect(seen(log, stateChange(vehicleId, 'depot_exit', 'to_pickup'))).toBe(true);
    const vehicle = world.vehicles.get(vehicleId);
    // vozidlo sa pohlo v kroku 6 toho istého ticku (ADR-038): drží slot hlavy a slot bunky, do ktorej vchádza
    expect([vehicle?.state, vehicle?.body.length, vehicle?.ahead.length]).toEqual(['to_pickup', 1, 1]);
    expect(world.laneSlots.claimedCount).toBe(2);
  });

  it('obsadený slot prístupovej bunky depa: vozidlo čaká v depot_exit (job drží), po uvoľnení vyjde', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const vehicleId = buyVehicle(world, depot);
    const depotCell = world.grid.index(DEPOT_ACCESS.x, DEPOT_ACCESS.y);
    // cudzí nosič stojí na prístupovej bunke depa v oboch pruhoch (neprekonateľný odpočet parkovania)
    const blocker = new Vehicle({
      id: world.ids.next(),
      def: world.defs.vehicles.get('straddle_carrier'),
      depotId: depot.id,
      state: 'idle',
      x: DEPOT_ACCESS.x + 0.5,
      y: DEPOT_ACCESS.y + 0.5,
      heading: 0,
      purchaseCostCents: 0,
      route: [depotCell],
      waitTicks: 1_000_000,
      body: [slotKey(depotCell, 0), slotKey(depotCell, 1)],
    });
    world.addVehicle(blocker);
    unitsOnApron(world, [0]);
    const log = run(world, 30);
    expect(world.vehicles.get(vehicleId)?.state).toBe('depot_exit');
    expect(world.vehicles.get(vehicleId)?.jobId).not.toBeNull();
    expect(seen(log, stateChange(vehicleId, 'depot_exit', 'to_pickup'))).toBe(false);
    expect(world.vehicles.get(vehicleId)?.body.length).toBe(0);
    world.removeVehicle(blocker.id);
    runUntil(world, (l) => seen(l, stateChange(vehicleId, 'depot_exit', 'to_pickup')), 3, log);
    expect(world.vehicles.get(vehicleId)?.state).toBe('to_pickup');
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('zaparkované vozidlo je pre dispatcher voľné: job dostane najbližšie zo zaparkovaných (pri zhode menšie id)', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const first = buyVehicle(world, depot);
    const second = buyVehicle(world, depot);
    expect(world.vehicles.get(first)?.cell).toBe(world.grid.index(DEPOT_ACCESS.x, DEPOT_ACCESS.y));
    unitsOnApron(world, [0]);
    const log = run(world, 1);
    const assigned = log.filter((entry) => entry.event.type === 'JobAssigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0].event).toMatchObject({ vehicleId: first });
    expect(world.vehicles.get(second)?.state).toBe('parked');
  });

  it('predaj: zaparkované vozidlo sa predať dá, vozidlo s jobom (depot_exit, to_pickup) nie', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const worker = buyVehicle(world, depot);
    const parked = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    run(world, 1);
    expect(world.vehicles.get(worker)?.jobId).not.toBeNull();
    world.enqueue(commandFromJSON({ type: 'SellVehicle', vehicleId: worker }));
    expect(world.applyPending().map((event) => event.type)).toEqual(['CommandRejected']);
    const sold = execute(world, { type: 'SellVehicle', vehicleId: parked });
    expect(sold.some((event) => event.type === 'VehicleSold')).toBe(true);
    expect(world.vehicles.has(parked)).toBe(false);
    expect(() => world.assertInvariants()).not.toThrow();
  });
  it('predaj nečinného vozidla na ceste (idle po jobe) uvoľní všetky jeho sloty (claimedCount 0)', () => {
    const { world, vehicleId } = oneVehicleWorld();
    runUntil(world, (l) => seen(l, stateChange(vehicleId, 'unloading', 'idle')), 400);
    const vehicle = world.vehicles.get(vehicleId);
    expect(vehicle?.state).toBe('idle');
    expect(vehicle?.body.length).toBeGreaterThan(0);
    expect(world.laneSlots.claimedCount).toBeGreaterThan(0);
    const sold = execute(world, { type: 'SellVehicle', vehicleId });
    expect(sold.some((event) => event.type === 'VehicleSold')).toBe(true);
    expect(world.vehicles.has(vehicleId)).toBe(false);
    expect(world.laneSlots.claimedCount).toBe(0);
    expect(carrierOverlapProblem(world)).toBeNull();
    expect(() => world.assertInvariants()).not.toThrow();
  });
});

describe('pobyt pri module drží len hlavu (ADR-037 dodatok TR1-04)', () => {
  it('v loading aj unloading vozidlo drží jediný slot (hlavu); pri odchode sa telo rozvinie späť na dve bunky', () => {
    const { world, vehicleId } = oneVehicleWorld();
    const held: Record<string, number> = {};
    for (let tick = 0; tick < 400; tick++) {
      world.tick();
      const vehicle = world.vehicles.get(vehicleId);
      if (vehicle === undefined) throw new Error('vozidlo zmizlo');
      if (vehicle.state === 'loading' || vehicle.state === 'unloading') held[vehicle.state] = Math.max(held[vehicle.state] ?? 0, vehicle.body.length);
      if (vehicle.state === 'to_dropoff' && vehicle.body.length === 2) held['rozvinuté'] = 2;
      if (vehicle.state === 'loading' || vehicle.state === 'unloading') expect(world.laneSlots.claimedCount).toBe(1);
    }
    expect(held).toEqual({ loading: 1, unloading: 1, rozvinuté: 2 });
    expect(() => world.assertInvariants()).not.toThrow();
  });
});
