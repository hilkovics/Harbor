import { describe, expect, it } from 'vitest';
import type { CraneVM, ModuleVM } from '@render/view-models';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { CraneModule } from '@sim/modules';
import type { World } from '@sim/world';
import { EntitiesVMBuilder, craneVMs, entitiesVM, moduleVMs, shipVMs, type ShipPositions } from '@app/entities-vm';
import { DEPOT_ID, buildFullChain, buildLogistics, buyVehicles, createApp, createLegacyCapacityWorld, createPortApp, createWorld, frameUntil } from './app-fixtures';

const ROOT_BERTH_ID = 1;
const ROOT_CRANE_ID = 2;

/** Číslo z view-modelu ako `EntityId` simu (id sú v simu branded). */
const eid = (value: number): EntityId => value as EntityId;

function spawnFeeder(world: World, units = 4): void {
  world.enqueue(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units }));
  world.applyPending();
}

function rootCrane(world: World): CraneModule {
  const crane = world.modules.get(eid(ROOT_CRANE_ID));
  if (!(crane instanceof CraneModule)) throw new Error('Root žeriav (id 2) chýba');
  return crane;
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

/** Ticky, kým neplatí `predicate` (najviac `maxTicks`); vráti počet vykonaných tickov. */
function tickUntil(world: World, predicate: () => boolean, maxTicks = 2000): number {
  for (let ticks = 0; ticks < maxTicks; ticks++) {
    if (predicate()) return ticks;
    world.tick();
  }
  throw new Error(`podmienka neplatí ani po ${String(maxTicks)} tickoch`);
}

describe('entitiesVM: nový svet (Root modul)', () => {
  it('moduly obsahujú Root berth s prázdnym apronom, žeriav v nich nie je', () => {
    const world = createWorld();
    const modules = moduleVMs(world);
    expect(modules).toEqual<ModuleVM[]>([
      {
        id: ROOT_BERTH_ID,
        defId: 'berth_standard',
        kind: 'berth',
        x: 40,
        y: 14,
        rotation: 0,
        w: 8,
        h: 4,
        apron: { capacity: 8, units: [] },
        lanes: expect.any(Array) as ModuleVM['lanes'], // pruhy kotviska (TR3-05)
        connected: false, // kotvisko má cestné konektory, ale žiadna cesta ešte nevedie
      },
    ]);
  });

  it('žeriav: origin, berth, nečinný stav, progress 0, nič nedrží', () => {
    const world = createWorld();
    expect(craneVMs(world)).toEqual<CraneVM[]>([
      {
        id: ROOT_CRANE_ID,
        defId: 'crane_container_gantry',
        berthId: ROOT_BERTH_ID,
        x: 43,
        y: 14,
        rotation: 0,
        state: 'idle',
        progress: 0,
        holding: null,
        cycle: 'unload',
        trolleyY: 1,
        cargo: null,
      },
    ]);
  });

  it('bez lodí je zoznam lodí prázdny; entitiesVM skladá všetky štyri polia (aj prázdne vozidlá)', () => {
    const world = createWorld();
    expect(shipVMs(world)).toEqual([]);
    const entities = entitiesVM(world);
    expect(entities.modules).toHaveLength(1);
    expect(entities.cranes).toHaveLength(1);
    expect(entities.ships).toHaveLength(0);
    expect(entities.vehicles).toEqual([]);
  });

  it('kapacita apronu aj rozmery footprintu idú z defov (nie natvrdo)', () => {
    const world = createWorld();
    const berthDef = world.defs.modules.get('berth_standard');
    const vm = only(moduleVMs(world));
    expect(vm.w).toBe(berthDef.footprint.w);
    expect(vm.h).toBe(berthDef.footprint.h);
    expect(vm.apron?.capacity).toBe(world.defs.modules.get('berth_standard').params['apronSlots']);
  });
});

describe('entitiesVM: loď', () => {
  it('loď čakajúca pred vstupom (arriving, mimo mapy — ADR-029) sa nekreslí; do zoznamu prejde až po vstupe na seaLane[0]', () => {
    const world = createWorld();
    spawnFeeder(world, 2);
    spawnFeeder(world, 2); // na sea lane je naraz jedna loď → druhá čaká pred vstupom
    const [first, second] = [...world.ships.values()];
    expect([first?.state, second?.state]).toEqual(['inbound', 'arriving']);
    expect(shipVMs(world).map((vm) => vm.id)).toEqual([first?.id]);
    expect(entitiesVM(world).ships.map((vm) => vm.id)).toEqual([first?.id]);

    let entered = false;
    for (let tick = 0; tick < 2000 && !entered; tick++) {
      world.tick();
      const drawn = shipVMs(world);
      expect(drawn.every((vm) => vm.state !== 'arriving'), `tick ${String(world.clock.tick)}`).toBe(true);
      expect(drawn.map((vm) => vm.id)).toEqual([...world.ships.values()].filter((ship) => ship.state !== 'arriving').map((ship) => ship.id));
      entered = second !== undefined && second.state !== 'arriving';
    }
    expect(entered).toBe(true);
    expect(shipVMs(world).map((vm) => vm.id)).toContain(second?.id);
  });

  it('čerstvo spawnutá loď: trieda, kategória nákladu, náklad na palube, poloha v strede seaLane[0], prev = curr', () => {
    const world = createWorld();
    spawnFeeder(world, 4);
    const ship = only(shipVMs(world));
    const feeder = world.defs.ships.get('feeder');
    const start = world.map.seaLane[0];
    expect(ship).toMatchObject({
      classId: 'feeder',
      cargoCategory: 'container',
      state: 'inbound',
      lengthCells: feeder.lengthCells,
      widthCells: feeder.widthCells,
      capacityUnits: feeder.capacityUnits,
      unitsOnBoard: 4,
      cargoSplit: { import: 4, export: 0 },
    });
    expect(ship).not.toHaveProperty('lashing');
    expect(start).toBeDefined();
    expect(ship.x).toBe((start?.x ?? NaN) + 0.5);
    expect(ship.y).toBe((start?.y ?? NaN) + 0.5);
    expect(ship.prevX).toBe(ship.x);
    expect(ship.prevY).toBe(ship.y);
    expect([0, 90, 180, 270]).toContain(ship.heading);
  });

  it('prevX/prevY berie z dodaných predchádzajúcich polôh; loď bez záznamu má prev = curr', () => {
    const world = createWorld();
    spawnFeeder(world);
    const shipId = only(shipVMs(world)).id;
    const prev: ShipPositions = new Map([[shipId, { x: 10.5, y: 3.25 }]]);
    expect(only(shipVMs(world, prev))).toMatchObject({ prevX: 10.5, prevY: 3.25 });
    const other: ShipPositions = new Map([[shipId + 100, { x: 1, y: 1 }]]);
    const vm = only(shipVMs(world, other));
    expect(vm.prevX).toBe(vm.x);
    expect(vm.prevY).toBe(vm.y);
  });

  it('id lode je id zo simu; poradie je vzostupne podľa id', () => {
    const world = createWorld();
    spawnFeeder(world, 2);
    spawnFeeder(world, 3);
    // druhá loď najprv čaká pred vstupom (arriving, nekreslí sa) — počká sa, kým vpláva na mapu
    tickUntil(world, () => [...world.ships.values()].every((ship) => ship.state !== 'arriving'));
    const ids = shipVMs(world).map((ship) => ship.id);
    expect(ids).toEqual([...world.ships.keys()]);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(shipVMs(world).map((ship) => ship.unitsOnBoard)).toEqual([2, 3]);
  });
});

describe('entitiesVM: vykládka lode žeriavom (celý cyklus)', () => {
  it('v každom ticku platí zachovanie nákladu vo view-modeloch a hodnoty sú v rozsahu', () => {
    const world = createWorld();
    spawnFeeder(world, 4);
    let sawGrabbing = false;
    let sawPlacingWithCargo = false;
    let ticks = 0;
    while (world.ships.size > 0 && ticks < 1000) {
      world.tick();
      ticks += 1;
      const { modules, cranes, ships } = entitiesVM(world);
      const crane = only(cranes);
      const berth = only(modules);
      const onShips = ships.reduce((sum, ship) => sum + ship.unitsOnBoard, 0);
      const onApron = berth.apron?.units.length ?? 0;
      const inCrane = crane.holding === null ? 0 : 1;
      expect(onShips + onApron + inCrane, `tick ${String(ticks)}`).toBe(4);
      expect(crane.progress).toBeGreaterThanOrEqual(0);
      expect(crane.progress).toBeLessThanOrEqual(1);
      if (crane.state === 'idle' || crane.state === 'blocked') expect(crane.progress).toBe(0);
      if (crane.state === 'grabbing') {
        sawGrabbing = true;
        expect(crane.holding).toBeNull();
      }
      if (crane.state === 'placing') {
        sawPlacingWithCargo = true;
        expect(crane.holding?.typeId).toBe('container_teu');
      }
      for (const ship of ships) {
        expect(ship.unitsOnBoard).toBeLessThanOrEqual(ship.capacityUnits);
        expect([0, 90, 180, 270]).toContain(ship.heading);
      }
    }
    expect(ticks).toBeLessThan(1000);
    expect(sawGrabbing).toBe(true);
    expect(sawPlacingWithCargo).toBe(true);
  });

  it('progress žeriavu kopíruje phaseProgress fázy (grabbing: 0 < p < 1, rastie)', () => {
    const world = createWorld();
    spawnFeeder(world, 4);
    tickUntil(world, () => rootCrane(world).state === 'grabbing');
    const crane = rootCrane(world);
    const first = only(craneVMs(world));
    expect(first.state).toBe('grabbing');
    expect(first.progress).toBe(crane.phaseProgress);
    world.tick();
    world.tick();
    const later = only(craneVMs(world));
    expect(later.state).toBe('grabbing');
    expect(later.progress).toBeGreaterThan(first.progress);
    expect(later.progress).toBeLessThan(1);
    expect(later.progress).toBe(crane.phaseProgress);
  });

  it('žeriav pri placing drží jednotku, ktorá je v ledgeri in_crane; unitId sedí', () => {
    const world = createWorld();
    spawnFeeder(world, 4);
    tickUntil(world, () => rootCrane(world).state === 'placing');
    const vm = only(craneVMs(world));
    expect(vm.holding).not.toBeNull();
    const unit = world.cargo.get(eid(vm.holding?.unitId ?? 0));
    expect(unit?.location.kind).toBe('in_crane');
    expect(unit?.typeId).toBe(vm.holding?.typeId);
  });

  it('po vyložení: 4 jednotky na aprone v poradí FIFO so slotmi 0–3, loď preč', () => {
    const world = createWorld();
    spawnFeeder(world, 4);
    tickUntil(world, () => world.ships.size === 0 && world.clock.tick > 10);
    const berth = only(moduleVMs(world));
    const units = berth.apron?.units ?? [];
    expect(units).toHaveLength(4);
    expect(units.map((unit) => unit.slot)).toEqual([0, 1, 2, 3]);
    expect(units.map((unit) => unit.typeId)).toEqual(Array<string>(4).fill('container_teu'));
    const ids = units.map((unit) => unit.unitId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b)); // žeriav berie z lode jednotky od najmenšieho id
    expect(new Set(ids).size).toBe(4);
    expect(world.cargo.unitsOnApron(eid(ROOT_BERTH_ID))).toEqual(ids); // FIFO ako v ledgeri
    expect(shipVMs(world)).toEqual([]);
  });

  it('plný apron a ďalšia loď: žeriav blocked, progress 0, nič nedrží, loď docked s nákladom', () => {
    const world = createLegacyCapacityWorld(); // apron 4/4 po prvej lodi (Fáza 5b: bundled apron 8)
    spawnFeeder(world, 4);
    tickUntil(world, () => world.ships.size === 0 && world.clock.tick > 10);
    spawnFeeder(world, 4);
    tickUntil(world, () => rootCrane(world).state === 'blocked');
    const crane = only(craneVMs(world));
    expect(crane).toMatchObject({ state: 'blocked', progress: 0, holding: null });
    const ship = only(shipVMs(world));
    expect(ship.state).toBe('docked');
    expect(ship.unitsOnBoard).toBe(4);
    expect(only(moduleVMs(world)).apron?.units).toHaveLength(4);
  });
});

describe('entitiesVM: nový modul', () => {
  it('PlaceModule berth vedľa Rootu pribudne do modulov s vlastným id a prázdnym apronom', () => {
    const world = createWorld();
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: 'berth_standard', x: 48, y: 14, rotation: 0 }));
    world.applyPending();
    const modules = moduleVMs(world);
    expect(modules).toHaveLength(2);
    const placed = modules[1] as ModuleVM;
    expect(placed).toMatchObject({ defId: 'berth_standard', kind: 'berth', x: 48, y: 14, w: 8, h: 4, rotation: 0 });
    expect(placed.id).toBeGreaterThan(ROOT_CRANE_ID);
    expect(placed.apron).toEqual({ capacity: 8, units: [] });
  });

  it('PlaceModule žeriav sa objaví v cranes (nie v modules)', () => {
    const world = createWorld();
    world.enqueue(commandFromJSON({ type: 'PlaceModule', defId: 'crane_container_gantry', x: 45, y: 14, rotation: 0 }));
    world.applyPending();
    expect(craneVMs(world).map((crane) => crane.x)).toEqual([43, 45]);
    expect(moduleVMs(world).map((module) => module.kind)).toEqual(['berth']);
  });
});

describe('EntitiesVMBuilder (cache modulov podľa revision)', () => {
  it('pole modulov má rovnakú referenciu pri rovnakej revízii a nové pri zmene; žeriavy a lode sa skladajú vždy', () => {
    const world = createWorld();
    const builder = new EntitiesVMBuilder();
    const first = builder.build(world, 0);
    world.tick();
    const second = builder.build(world, 0);
    expect(second.modules).toBe(first.modules);
    expect(second.cranes).not.toBe(first.cranes);
    expect(second.ships).not.toBe(first.ships);
    const third = builder.build(world, 1);
    expect(third.modules).not.toBe(first.modules);
    expect(third.modules).toEqual(first.modules);
  });

  it('prvé volanie s ľubovoľnou revíziou vždy načíta moduly zo sveta (aj revízia ≠ 0)', () => {
    const world = createWorld();
    expect(new EntitiesVMBuilder().build(world, 7).modules).toHaveLength(1);
  });

  it('výsledok je zmrazený (view-model sa nemení pod rukami rendereru)', () => {
    const world = createWorld();
    const entities = new EntitiesVMBuilder().build(world, 0);
    expect(Object.isFrozen(entities)).toBe(true);
    expect(Object.isFrozen(entities.modules)).toBe(true);
    expect(Object.isFrozen(entities.cranes)).toBe(true);
    expect(Object.isFrozen(entities.ships)).toBe(true);
  });

  it('VM je ploché JSON DTO (žiadne triedy) — serializovateľné pre window.__sim.entities()', () => {
    const world = createWorld();
    spawnFeeder(world);
    tickUntil(world, () => rootCrane(world).state === 'placing');
    const entities = entitiesVM(world);
    expect(JSON.parse(JSON.stringify(entities))).toEqual(entities);
  });
});

describe('entitiesVM: Carrier trail R1 (vozidlá, kamióny)', () => {
  it('VehicleVM obsahuje lengthCells z defu, offRoad, blocked, jammed polia', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 1);

    const vehicles = entitiesVM(app.world).vehicles;
    expect(vehicles).toHaveLength(1);
    const vm = vehicles[0];
    expect(vm.state).toBe('parked');
    expect(vm.lengthCells).toBe(2);
    expect(vm.offRoad).toBe(true); // zaparkované v depe je mimo cesty
    expect(vm.blocked).toBe(false);
    expect(vm.jammed).toBe(false);
    expect(DEPOT_ID).toBeGreaterThan(0);
  });

  it('TruckVM má lengthCells, offRoad, blocked, jammed polia', () => {
    const app = createPortApp();
    buildFullChain(app, { units: 4 });
    frameUntil(app, () => app.world.trucks.size > 0, 5000);

    const trucks = entitiesVM(app.world).trucks;
    expect(trucks.length).toBeGreaterThan(0);
    const truck = trucks[0];
    expect(truck.lengthCells).toBe(3);
    expect(typeof truck.offRoad).toBe('boolean');
    expect(typeof truck.blocked).toBe('boolean');
    expect(typeof truck.jammed).toBe('boolean');
  });
});
