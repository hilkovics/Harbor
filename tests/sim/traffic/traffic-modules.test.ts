/**
 * Moduly a portál v doprave bez prekrývania (R1, TR1-03; ADR-037, rozhodnutia orchestrátora R1 č. 8, 9 a 10): stojaci nosič na ceste
 * (vo fronte brány, bez cesty, pri module, pod hákom) drží sloty; kamión v stojisku, v docku a v prechode bránou je mimo cesty
 * a nedrží nič; výjazd z modulu (bay, dock, brána) potrebuje voľný slot výjazdovej bunky; pred bránou stojí na vonkajšej bunke jediný
 * kamión a ďalšie za ním; kamión na portáli vznikne len na voľnej bunke; `RemoveRoad` chráni aj telo.
 * Svet = rozloženie F4 (`outboundWorld`: brána 6, stojisko 7, rampa 8); náklad sa na dock kladie priamo cez ledger.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { CraneModule, VehicleDepot, type LoadingRamp } from '@sim/modules';
import { carrierOverlapProblem, slotKey } from '@sim/traffic';
import { RemoveRoadCommand } from '@sim/commands';
import { Truck } from '@sim/trucks';
import { Vehicle } from '@sim/vehicles';
import { hookCellOfCrane } from '@sim/vehicles/vehicle-trip';
import { World, fnv1a32Hex, stateHash, type WorldState } from '@sim/world';
import { gateOf, outboundWorld, rampOf } from '../logistics/outbound-fixtures';
import { emptyWorld, f6cDefs } from '../helpers/f6c';
import { hookDefs, startLoading } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { DEFS, MAP } from '../world/world-fixtures';
import { lay, line, spawn, tickTraffic, trafficBed } from './traffic-fixtures';

interface Timed {
  readonly tick: number;
  readonly event: SimEvent;
}

const PORTAL = { x: 44, y: 63 };
const GATE_ENTRY = { x: 44, y: 33 };

const cellOf = (world: World, xy: { x: number; y: number }): number => world.grid.index(xy.x, xy.y);

/** Jeden tick sveta; zapíše udalosti a overí `carrierOverlapProblem` (krok 12 ho overuje tiež). */
function step(world: World, log: Timed[]): void {
  for (const event of world.tick()) log.push({ tick: world.clock.tick, event });
  expect(carrierOverlapProblem(world)).toBeNull();
}

function runUntil(world: World, done: (world: World) => boolean, limit: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < limit && !done(world); i++) step(world, log);
  if (!done(world)) throw new Error(`podmienka nenastala do ${String(limit)} tickov (tick ${String(world.clock.tick)})`);
  return log;
}

/** `count` jednotiek priamo na dock rampy cez ledger (fiktívna loď 900, žeriav 901, vozidlo 902 — len prechody §7.1). */
function stage(world: World, ramp: LoadingRamp, dock: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
  }
}

/** Stojaci prekážkový nosič: vozidlo `idle` (odpočet parkovania je neprekonateľne dlhý), ktoré drží oba pruhy bunky `cell` (nič iné cez ňu neprejde ani na nej nevznikne). */
function obstacle(world: World, cell: number): Vehicle {
  const depot = [...world.modules.values()].find((module): module is VehicleDepot => module instanceof VehicleDepot);
  if (depot === undefined) throw new Error('svet nemá depo vozidiel');
  const { width } = world.grid;
  const vehicle = new Vehicle({
    id: world.ids.next(),
    def: world.defs.vehicles.get('straddle_carrier'),
    depotId: depot.id,
    state: 'idle',
    x: (cell % width) + 0.5,
    y: Math.floor(cell / width) + 0.5,
    heading: 0,
    purchaseCostCents: 0,
    route: [cell],
    waitTicks: 1_000_000,
    body: [slotKey(cell, 0), slotKey(cell, 1)],
  });
  world.addVehicle(vehicle);
  return vehicle;
}

const trucksOf = (world: World): Truck[] => [...world.trucks.values()];
const heldBy = (world: World, truck: Truck): number => {
  let held = 0;
  for (let cell = 0; cell < world.grid.cellCount; cell++) for (const lane of [0, 1]) if (world.laneSlots.holderOf(cell, lane) === truck.id) held += 1;
  return held;
};

describe('kolóna pred bránou (rozhodnutie R1 č. 9)', () => {
  /** Štyri kamióny na dock 0 → vznikajú postupne na portáli a idú k bráne. */
  function queueWorld(): World {
    const { world } = outboundWorld({ defs: DEFS });
    stage(world, rampOf(world), 0, 4);
    return world;
  }

  it('na vonkajšej bunke stojí jediný kamión (gate_queue), ďalšie za ním v to_gate; FIFO, bez prekryvu, prechody po passTicks', () => {
    const world = queueWorld();
    const gate = gateOf(world);
    const entry = cellOf(world, GATE_ENTRY);
    const log: Timed[] = [];
    let maxBehind = 0;
    runUntil(
      world,
      (w) => {
        const queued = trucksOf(w).filter((truck) => truck.state === 'gate_queue');
        expect(queued.length).toBeLessThanOrEqual(1);
        for (const truck of queued) {
          expect(truck.cell).toBe(entry);
          expect(truck.body.length).toBeGreaterThan(0);
        }
        // čakajúci kamión stojí fyzicky za frontom: hlava mimo vonkajšej bunky, iná bunka než čelo fronty
        const behind = trucksOf(w).filter((truck) => truck.state === 'to_gate' && truck.blockedTicks > 0);
        for (const truck of behind) expect(truck.cell).not.toBe(entry);
        if (queued.length === 1) maxBehind = Math.max(maxBehind, behind.length);
        return gate.trucksProcessed >= 4;
      },
      3000,
      log,
    );
    expect(maxBehind).toBeGreaterThanOrEqual(2);
    const changes = log.flatMap(({ tick, event }) => (event.type === 'TruckStateChanged' ? [{ tick, id: event.truckId, from: event.from, to: event.to }] : []));
    const starts = changes.filter((change) => change.to === 'gate_pass');
    const exits = changes.filter((change) => change.from === 'gate_pass');
    expect(starts).toHaveLength(4);
    // FIFO: kamióny vzniku 1…4 prechádzajú bránou v tom istom poradí, v akom dorazili
    expect(starts.map((change) => change.id)).toEqual([...starts.map((change) => change.id)].sort((a, b) => a - b));
    expect(exits.map((change) => change.id)).toEqual(starts.map((change) => change.id));
    // priepustnosť brány sa nezmenila: medzi dvoma začiatkami prechodu práve passTicks
    for (let i = 1; i < starts.length; i++) expect(starts[i].tick - starts[i - 1].tick).toBe(gate.passTicks);
    // prechod trvá passTicks a kamión vyjde na druhej strane v stave to_bay
    for (let i = 0; i < starts.length; i++) {
      expect(exits[i].tick - starts[i].tick).toBe(gate.passTicks);
      expect(exits[i].to).toBe('to_bay');
    }
  });

  it('kamión v gate_pass je mimo cesty (nedrží nič), kým čaká druhý v gate_queue na vonkajšej bunke a tretí za ním', () => {
    const world = queueWorld();
    const log: Timed[] = [];
    runUntil(world, (w) => trucksOf(w).some((truck) => truck.state === 'gate_pass') && trucksOf(w).some((truck) => truck.state === 'gate_queue'), 2000, log);
    const passing = trucksOf(world).find((truck) => truck.state === 'gate_pass') as Truck;
    const queued = trucksOf(world).find((truck) => truck.state === 'gate_queue') as Truck;
    expect([passing.body.length, passing.ahead.length, heldBy(world, passing)]).toEqual([0, 0, 0]);
    expect(heldBy(world, queued)).toBeGreaterThanOrEqual(1);
    expect(gateOf(world).queuedTruckIds[0]).toBe(passing.id);
    expect(passing.id).toBeLessThan(queued.id);
  });

  it('roundtrip savu uprostred kolóny (gate_pass + gate_queue + čakajúci to_gate) dá rovnaké udalosti po tickoch aj rovnaký hash', () => {
    const world = queueWorld();
    const log: Timed[] = [];
    runUntil(
      world,
      (w) => {
        const states = trucksOf(w).map((truck) => truck.state);
        return states.includes('gate_pass') && states.includes('gate_queue') && trucksOf(w).some((truck) => truck.state === 'to_gate' && truck.blockedTicks > 0);
      },
      3000,
      log,
    );
    const save = JSON.stringify(world.serialize());
    const rest = new Map<number, string>();
    for (let i = 0; i < 400; i++) {
      const events = world.tick();
      rest.set(world.clock.tick, fnv1a32Hex(JSON.stringify(events)));
    }
    const restored = World.deserialize(DEFS, MAP, JSON.parse(save) as WorldState);
    expect(carrierOverlapProblem(restored)).toBeNull();
    expect(trucksOf(restored).map((truck) => truck.state)).toContain('gate_pass');
    let mismatch: number | null = null;
    for (let i = 0; i < 400; i++) {
      const events = restored.tick();
      if (mismatch === null && fnv1a32Hex(JSON.stringify(events)) !== rest.get(restored.clock.tick)) mismatch = restored.clock.tick;
    }
    expect(mismatch).toBeNull();
    expect(stateHash(restored)).toBe(stateHash(world));
    assertCargoConservation(restored);
  });
});

describe('kamión v stojisku a v docku je mimo cesty (rozhodnutie R1 č. 8)', () => {
  it('v bayi (waiting) a v docku (loading) nedrží žiadny slot; ten istý slot si môže vziať iný nosič', () => {
    const { world } = outboundWorld({ defs: DEFS });
    stage(world, rampOf(world), 0, 1);
    const log: Timed[] = [];
    runUntil(world, (w) => trucksOf(w).some((truck) => truck.state === 'waiting'), 3000, log);
    const waiting = trucksOf(world)[0];
    expect([waiting.state, waiting.body.length, waiting.ahead.length, heldBy(world, waiting), waiting.blockedTicks]).toEqual(['waiting', 0, 0, 0, 0]);
    expect(world.laneSlots.claimedCount).toBe(0);
    // slot jeho bunky je voľný: nosič, ktorý cez ňu ide, ho smie obsadiť
    const blocker = obstacle(world, waiting.cell);
    expect(carrierOverlapProblem(world)).toBeNull();
    expect(blocker.body).toHaveLength(2);
    world.removeVehicle(blocker.id);
    runUntil(world, (w) => trucksOf(w).some((truck) => truck.state === 'loading'), 3000, log);
    const loading = trucksOf(world)[0];
    expect([loading.state, loading.body.length, heldBy(world, loading)]).toEqual(['loading', 0, 0]);
    expect(rampOf(world).dockTruck(loading.dock)).toBe(loading.id);
  });

  it('výjazd z docku pri obsadenej bunke čaká: kamión ostane v loading a drží dock, kým sa slot neuvoľní', () => {
    const { world } = outboundWorld({ defs: DEFS });
    const ramp = rampOf(world);
    stage(world, ramp, 0, 1);
    const log: Timed[] = [];
    runUntil(world, (w) => trucksOf(w).some((truck) => truck.state === 'loading'), 3000, log);
    const truck = trucksOf(world)[0];
    const blocker = obstacle(world, truck.cell);
    runUntil(world, (w) => w.cargo.countAt('in_truck', truck.id) === 1, 200, log);
    for (let i = 0; i < 40; i++) step(world, log);
    // naložený, ale bunka je obsadená: stojí v docku, dock ostáva jeho, nič nedrží
    expect([truck.state, ramp.dockTruck(truck.dock), truck.body.length, truck.waitTicks]).toEqual(['loading', truck.id, 0, 1]);
    expect(world.cargo.countAt('in_truck', truck.id)).toBe(1);
    world.removeVehicle(blocker.id);
    runUntil(world, () => truck.state !== 'loading', 5, log);
    expect([truck.state, ramp.dockTruck(truck.dock)]).toEqual(['to_gate_out', null]);
    expect(truck.body.length).toBeGreaterThanOrEqual(1);
    expect(world.laneSlots.holderOf(truck.cell, truck.body[0] & 1)).toBe(truck.id);
    assertCargoConservation(world);
  });

  it('výjazd z brány pri obsadenej druhej strane čaká: kamión ostane v gate_pass na čele fronty, brána ostáva obsadená', () => {
    const { world } = outboundWorld({ defs: DEFS });
    const gate = gateOf(world);
    stage(world, rampOf(world), 0, 1);
    const log: Timed[] = [];
    runUntil(world, (w) => trucksOf(w).some((truck) => truck.state === 'gate_pass'), 3000, log);
    const truck = trucksOf(world)[0];
    const far = cellOf(world, { x: 47, y: 33 });
    const blocker = obstacle(world, far);
    runUntil(world, () => gate.busyTicksLeft === 0, 100, log);
    for (let i = 0; i < 30; i++) step(world, log);
    expect([truck.state, gate.queuedTruckIds[0], gate.busyTicksLeft, gate.trucksProcessed, truck.body.length]).toEqual(['gate_pass', truck.id, 0, 0, 0]);
    world.removeVehicle(blocker.id);
    runUntil(world, () => truck.state !== 'gate_pass', 5, log);
    expect([truck.state, gate.trucksProcessed, gate.queueLength, truck.cell]).toEqual(['to_bay', 1, 0, far]);
  });
});

describe('vznik kamióna na portáli (rozhodnutie R1 č. 10)', () => {
  it('spawn na obsadenom portáli sa odloží, náklad docku ostáva bez nároku; po uvoľnení kamión vznikne a zaberie slot hlavy', () => {
    const { world } = outboundWorld({ defs: DEFS });
    const ramp = rampOf(world);
    stage(world, ramp, 0, 1);
    const portal = cellOf(world, PORTAL);
    const blocker = obstacle(world, portal);
    const log: Timed[] = [];
    for (let i = 0; i < 20; i++) step(world, log);
    expect(world.trucks.size).toBe(0);
    expect(ramp.claimedAt(0)).toBe(0);
    expect(log.filter(({ event }) => event.type === 'TruckSpawned')).toHaveLength(0);
    world.removeVehicle(blocker.id);
    step(world, log);
    const [truck] = trucksOf(world);
    expect(truck).toBeDefined();
    expect(truck.cell).toBe(portal);
    expect(truck.body).toHaveLength(1);
    expect(world.laneSlots.holderOf(portal, truck.body[0] & 1)).toBe(truck.id);
    expect(ramp.claimedAt(0)).toBe(1);
  });

  it('vjazd z vnútrozemia na obsadenom portáli sa odloží: položka plánu ostane, po uvoľnení kamión vojde', () => {
    const world = emptyWorld({ defs: f6cDefs(), vehicles: ['straddle_carrier'] });
    const portal = world.landside.portalCell;
    const blocker = obstacle(world, portal);
    world.emptyFlow.scheduleReturn(world.clock.tick + 2, 'blue_anchor');
    const log: Timed[] = [];
    for (let i = 0; i < 20; i++) step(world, log);
    expect(world.trucks.size).toBe(0);
    expect(world.emptyFlow.returnPlan).toHaveLength(1);
    expect(world.hinterland.admitted('delivery')).toBe(0);
    world.removeVehicle(blocker.id);
    for (let i = 0; i < 3; i++) step(world, log);
    expect(world.trucks.size).toBe(1);
    expect(world.emptyFlow.returnPlan).toHaveLength(0);
    expect(world.hinterland.admitted('delivery')).toBe(1);
  });

  it('dva kamióny na ten istý portál nevzniknú v tom istom ticku: druhý vznikne, až keď prvý uvoľní bunku', () => {
    const { world } = outboundWorld({ defs: DEFS });
    stage(world, rampOf(world), 0, 2);
    const spawnTicks: number[] = [];
    const log: Timed[] = [];
    runUntil(world, (w) => w.trucks.size >= 2, 50, log);
    for (const { tick, event } of log) if (event.type === 'TruckSpawned') spawnTicks.push(tick);
    expect(spawnTicks).toHaveLength(2);
    expect(spawnTicks[1] - spawnTicks[0]).toBeGreaterThan(1);
  });
});

describe('RemoveRoad chráni aj telo nosiča (rozhodnutie R1 č. 5 karty)', () => {
  it('bunka pod chvostom stojaceho vozidla (nie hlava ani cieľ úseku) sa odstrániť nedá; po jeho odchode áno', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 30]));
    const car = spawn(bed, line([40, 22], [40, 26]), { length: 2 });
    tickTraffic(world, 12);
    expect([car.cell, car.cellsAhead]).toEqual([cellOf(world, { x: 40, y: 26 }), 0]);
    const tail = cellOf(world, { x: 40, y: 25 });
    expect(car.body.map((key) => key >> 1)).toEqual([car.cell, tail]);
    expect(world.carrierOnCell(tail)).toBe(car);
    const removal = new RemoveRoadCommand([{ x: 40, y: 25 }]).validate(world);
    expect(removal.reasons).toEqual(['occupied']);
    const free = new RemoveRoadCommand([{ x: 40, y: 22 }]).validate(world);
    expect(free.reasons).toEqual([]);
    // slot vpredu (reťaz križovatky, cieľ rozbehnutého úseku) tiež chráni bunku
    const ahead = cellOf(world, { x: 40, y: 27 });
    expect(world.carrierOnCell(ahead)).toBeUndefined();
    car.reserveAhead(slotKey(ahead, 0));
    expect(world.carrierOnCell(ahead)).toBe(car);
    expect(new RemoveRoadCommand([{ x: 40, y: 27 }]).validate(world).reasons).toEqual(['occupied']);
  });
});

describe('pod hákom (rozhodnutie R1 č. 8, bunka nábrežia)', () => {
  it('dve vozidlá na ten istý hák: prvé stojí v bunke pod hákom a drží ju, druhé čaká fyzicky za ním a bunku nezaberie', () => {
    const run = startLoading({
      defs: hookDefs(0),
      vehicles: ['straddle_carrier', 'straddle_carrier'],
      kind: 'roundtrip',
      booked: 12,
      importUnits: 24,
      arrivals: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
    });
    const { world } = run;
    const crane = [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
    const hook = hookCellOfCrane(world, crane.id) as number;
    const under = (): Vehicle | undefined =>
      [...world.vehicles.values()].find((vehicle) => vehicle.cell === hook && vehicle.cellsAhead === 0 && (vehicle.state === 'loading' || vehicle.state === 'unloading'));
    const behind = (): Vehicle | undefined =>
      [...world.vehicles.values()].find((vehicle) => vehicle.cell !== hook && vehicle.cellsAhead <= 12 && vehicle.routeCellAt(vehicle.cellsAhead) === hook);
    let first: Vehicle | undefined;
    let second: Vehicle | undefined;
    for (let i = 0; i < 20_000 && (first === undefined || second === undefined); i++) {
      world.tick();
      expect(carrierOverlapProblem(world)).toBeNull();
      first = under();
      second = first === undefined ? undefined : behind();
    }
    if (first === undefined || second === undefined) throw new Error('dve vozidlá na tom istom háku sa nestretli');
    // Druhé vozidlo je na ceste k háku (najviac 12 buniek): kým prvé drží bunku pod hákom, druhé ju nezaberie a vozidlá sa neprekrývajú (pruhy kotviska 8 × 4, ADR-040).
    expect(first.id).not.toBe(second.id);
    expect(first.body.map((key) => key >> 1)[0]).toBe(hook);
    expect(world.laneSlots.holderOf(hook, 0)).toBe(first.id);
    let checked = 0;
    for (let i = 0; i < 200 && first.cell === hook && first.cellsAhead === 0; i++) {
      world.tick();
      expect(carrierOverlapProblem(world)).toBeNull();
      if (first.cell !== hook) break;
      expect(second.occupiesCell(hook)).toBe(false);
      expect(world.carrierOnCell(hook)).toBe(first);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
