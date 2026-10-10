// T03-10: snapshot v3 — vozidlá (prevX/prevY/prevHeading), sklady (`storage`) a pripojenie modulov (`connected`) vo VM.
import { describe, expect, it } from 'vitest';
import type { VehicleVM } from '@render/view-models';
import { commandFromJSON } from '@sim/commands';
import { StorageModule } from '@sim/modules';
import {
  DEPOT_ID,
  LOGISTICS_ROADS,
  YARD_2_ID,
  YARD_ID,
  buildLogistics,
  buyVehicles,
  createApp,
  frameUntil,
  runCommands,
  type App,
} from './app-fixtures';

function spawnShip(app: App, units: number): void {
  runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units }]);
}

/** Stav pripravený na jazdu: cesty, dvory, depo, dve vozidlá a loď s `units` jednotkami. */
function readyApp(units = 4): App {
  const app = createApp();
  buildLogistics(app);
  buyVehicles(app, 2);
  spawnShip(app, units);
  return app;
}

describe('WorldSnapshot v3: vozidlá', () => {
  it('nový svet nemá vozidlá; snapshot aj entities() ich nesú ako prázdne pole', () => {
    const { bridge } = createApp();
    expect(bridge.snapshot().vehicles).toEqual([]);
    expect(bridge.entities().vehicles).toBe(bridge.snapshot().vehicles);
  });

  it('čerstvo kúpené vozidlá: vzostupne podľa id, parked, prázdne, kurz z depa, prev = curr (aj prevHeading)', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 2);
    const vehicles = app.bridge.snapshot().vehicles;
    expect(vehicles.map((vehicle) => vehicle.id)).toEqual([...app.world.vehicles.keys()]);
    expect(vehicles).toHaveLength(2);
    for (const vehicle of vehicles) {
      const source = app.world.vehicles.get(vehicle.id as never);
      expect(vehicle).toEqual<VehicleVM>({
        id: vehicle.id,
        defId: 'straddle_carrier',
        x: source?.x ?? NaN,
        y: source?.y ?? NaN,
        prevX: source?.x ?? NaN,
        prevY: source?.y ?? NaN,
        heading: source?.heading ?? 0,
        prevHeading: source?.heading ?? 0,
        loaded: false,
        state: 'parked',
        lengthCells: 2,
        offRoad: true,
        blocked: false,
        jammed: false,
        ...(source !== undefined && source.body.length > 0 ? { body: vehicle.body } : {}),
      });
    }
  });

  it('VehicleBought a VehicleSold zvyšujú revision; predané vozidlo zmizne zo snapshotu', () => {
    const app = createApp();
    buildLogistics(app);
    const before = app.bridge.snapshot().revision;
    buyVehicles(app, 1);
    expect(app.bridge.snapshot().revision).toBe(before + 1); // VehicleBought (MoneyChanged revision nemení)
    const boughtId = app.bridge.snapshot().vehicles[0]?.id ?? 0;
    runCommands(app, [{ type: 'SellVehicle', vehicleId: boughtId }]);
    expect(app.bridge.snapshot().revision).toBe(before + 2); // VehicleSold
    expect(app.bridge.snapshot().vehicles).toEqual([]);
  });

  it('predaj vozidla: záznam predchádzajúcej polohy sa zabudne a nové vozidlo začína s prev = curr', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 1);
    app.loop.frame(app.loop.tickMs); // beforeTick zapamätá vozidlo
    const soldId = app.bridge.snapshot().vehicles[0]?.id;
    expect(soldId).toBeDefined();
    runCommands(app, [{ type: 'SellVehicle', vehicleId: soldId ?? 0 }]);
    expect(app.bridge.snapshot().vehicles).toEqual([]);
    buyVehicles(app, 1);
    const fresh = app.bridge.snapshot().vehicles[0];
    expect(fresh?.id).not.toBe(soldId);
    expect(fresh?.prevX).toBe(fresh?.x);
    expect(fresh?.prevY).toBe(fresh?.y);
  });
});

describe('WorldSnapshot v3: prevX/prevY/prevHeading vozidiel počas jazdy', () => {
  it('prev nasledujúceho snapshotu = curr predchádzajúceho (poloha aj kurz); vozidlá sa reálne hýbu aj otáčajú', () => {
    const app = readyApp();
    let moved = 0;
    let turned = 0;
    for (let i = 0; i < 1500; i += 1) {
      const before = new Map(app.bridge.snapshot().vehicles.map((vehicle) => [vehicle.id, vehicle] as const));
      app.loop.frame(app.loop.tickMs);
      for (const vehicle of app.bridge.snapshot().vehicles) {
        const previous = before.get(vehicle.id);
        if (previous === undefined) continue;
        expect(vehicle.prevX).toBe(previous.x);
        expect(vehicle.prevY).toBe(previous.y);
        expect(vehicle.prevHeading).toBe(previous.heading);
        if (vehicle.x !== previous.x || vehicle.y !== previous.y) moved += 1;
        if (vehicle.heading !== previous.heading) turned += 1;
      }
    }
    expect(moved).toBeGreaterThan(50);
    expect(turned).toBeGreaterThan(0);
  });

  it('krok vozidla medzi prev a curr je najviac rýchlosť z defu (žiadny skok)', () => {
    const app = readyApp();
    const speed = app.world.defs.vehicles.get('straddle_carrier').speedCellsPerTick;
    for (let i = 0; i < 1000; i += 1) {
      app.loop.frame(app.loop.tickMs);
      for (const vehicle of app.bridge.snapshot().vehicles) {
        expect(Math.hypot(vehicle.x - vehicle.prevX, vehicle.y - vehicle.prevY)).toBeLessThanOrEqual(speed + 1e-9);
      }
    }
  });

  it('pauza: vozidlá bez ticku nemajú predchodcu (prev = curr) a po obnove sa rozbehnú z tej istej polohy', () => {
    const app = readyApp();
    app.world.clock.setSpeed(0);
    app.loop.frame(1000);
    const paused = app.bridge.snapshot().vehicles;
    for (const vehicle of paused) {
      expect(vehicle.prevX).toBe(vehicle.x);
      expect(vehicle.prevY).toBe(vehicle.y);
    }
    app.world.clock.setSpeed(1);
    frameUntil(app, () => app.bridge.snapshot().vehicles.some((vehicle) => vehicle.state !== 'idle'), 200);
    const running = app.bridge.snapshot().vehicles.find((vehicle) => vehicle.state !== 'idle');
    const start = paused.find((vehicle) => vehicle.id === running?.id);
    expect(running).toBeDefined();
    // prvý pohyb začína v mieste, kde vozidlo stálo pri pauze
    expect(Math.hypot((running?.x ?? 0) - (start?.x ?? 0), (running?.y ?? 0) - (start?.y ?? 0))).toBeLessThan(2);
  });

  it('`loaded` zodpovedá ledgeru (in_vehicle) v každom snapshote a aspoň raz je true', () => {
    const app = readyApp();
    let loadedSeen = 0;
    for (let i = 0; i < 1500; i += 1) {
      app.loop.frame(app.loop.tickMs);
      for (const vehicle of app.bridge.snapshot().vehicles) {
        const carrying = app.world.cargo.countAt('in_vehicle', vehicle.id as never) > 0;
        expect(vehicle.loaded).toBe(carrying);
        if (vehicle.loaded) loadedSeen += 1;
      }
    }
    expect(loadedSeen).toBeGreaterThan(0);
  });

  it('`state` je stav FSM vozidla zo simu', () => {
    const app = readyApp();
    const seen = new Set<string>();
    for (let i = 0; i < 1500; i += 1) {
      app.loop.frame(app.loop.tickMs);
      for (const vehicle of app.bridge.snapshot().vehicles) {
        expect(vehicle.state).toBe(app.world.vehicles.get(vehicle.id as never)?.state);
        seen.add(vehicle.state);
      }
    }
    expect([...seen]).toEqual(expect.arrayContaining(['idle', 'to_pickup', 'loading', 'to_dropoff', 'unloading']));
  });

  it('entities().vehicles je serializovateľné (window.__sim.entities() z Playwrightu)', () => {
    const app = readyApp();
    for (let i = 0; i < 300; i += 1) app.loop.frame(app.loop.tickMs);
    const entities = app.bridge.entities();
    expect(entities.vehicles.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(entities))).toEqual(entities);
  });
});

describe('ModuleVM: storage a connected', () => {
  it('dvor: storage = { capacity, stored, reserved } z modulu; depo a dvor bez cesty sú connected: false', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const modules = new Map(app.bridge.snapshot().modules.map((module) => [module.id, module] as const));
    expect(modules.get(YARD_ID)).toMatchObject({ defId: 'container_yard_small', kind: 'storage', storage: { capacity: 48, stored: 0, reserved: 0 }, connected: false });
    expect(modules.get(DEPOT_ID)).toMatchObject({ defId: 'vehicle_depot', kind: 'depot', connected: false });
    expect(modules.get(DEPOT_ID)).not.toHaveProperty('storage');
  });

  it('kapacita skladu ide z defu (nie natvrdo): min(capacityUnits, geometria)', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const yard = app.bridge.snapshot().modules.find((module) => module.id === YARD_ID);
    // Fyzická kapacita bloku so stohmi v TEU (R2, ADR-039): min(capacityUnits, bays × rows × maxTier) z defu.
    const { capacityUnits, bays, rows, maxTier } = app.world.defs.modules.get('container_yard_small').params as Record<string, number>;
    expect(yard?.storage?.capacity).toBe(Math.min(capacityUnits, bays * rows * maxTier));
  });

  it('žeriav nemá `connected` ani `storage` (nemá cestné konektory); kotvisko áno (connected)', () => {
    const app = createApp();
    const berth = app.bridge.snapshot().modules[0];
    expect(berth).toMatchObject({ kind: 'berth', connected: false });
    expect(berth).not.toHaveProperty('storage');
    expect(app.bridge.snapshot().cranes[0]).not.toHaveProperty('connected');
  });

  it('položenie ciest (RoadChanged) prepočíta connected: moduly sa pripoja bez ďalšej udalosti o module', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const first = app.bridge.snapshot().modules;
    expect(first.every((module) => module.connected === false)).toBe(true);
    runCommands(app, LOGISTICS_ROADS.map((cells) => ({ type: 'PlaceRoad', cells })));
    const second = app.bridge.snapshot().modules;
    expect(second).not.toBe(first);
    expect(second.every((module) => module.connected === true)).toBe(true);
  });

  it('odstránenie cesty pred konektorom (RemoveRoad) modul odpojí', () => {
    const app = createApp();
    buildLogistics(app);
    expect(app.bridge.snapshot().modules.find((module) => module.id === YARD_ID)?.connected).toBe(true);
    // vonkajšia bunka konektora dvora (43, 22) je jediná, kadiaľ dvor vidí cestu
    runCommands(app, [{ type: 'RemoveRoad', cells: [{ x: 43, y: 22 }] }]);
    expect(app.bridge.snapshot().modules.find((module) => module.id === YARD_ID)?.connected).toBe(false);
  });

  it('počas vykládky do dvorov: stored/reserved vo VM sedí s modulmi v každom snapshote; nakoniec je všetko uložené', () => {
    const app = readyApp(12);
    let reservedSeen = 0;
    frameUntil(
      app,
      () => {
        const snapshot = app.bridge.snapshot();
        for (const vm of snapshot.modules) {
          if (vm.storage === undefined) continue;
          const module = app.world.modules.get(vm.id as never);
          if (!(module instanceof StorageModule)) throw new Error('VM skladu bez modulu skladu');
          expect(vm.storage).toEqual({ capacity: module.capacity, stored: module.storedCount, reserved: module.reservedCount });
          reservedSeen += vm.storage.reserved;
        }
        return app.world.cargo.countByKind('in_storage') === 12;
      },
      12000,
    );
    expect(reservedSeen).toBeGreaterThan(0);
    const stored = app.bridge
      .snapshot()
      .modules.filter((module) => module.id === YARD_ID || module.id === YARD_2_ID)
      .reduce((sum, module) => sum + (module.storage?.stored ?? 0), 0);
    expect(stored).toBe(12);
  });

  it('DevHook-podobný príkaz cez commandFromJSON: BuyVehicle do nepripojeného depa sa odmietne (bez vozidla)', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    const command = commandFromJSON({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID });
    expect(app.bridge.validate(command)).toMatchObject({ ok: false, reasons: ['not_connected'] });
  });
});
