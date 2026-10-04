// T03-10: nákup a predaj vozidiel z UI — výber depa (pripojené, voľné státie, najmenšie id), validácia pred dispatch.
import { describe, expect, it, vi } from 'vitest';
import { BuyVehicleCommand, SellVehicleCommand } from '@sim/commands';
import {
  DEPOTS_FULL_REASON,
  NO_DEPOT_REASON,
  buyVehicleFromBuildBar,
  buyVehicleInDepot,
  sameBuyTarget,
  sellVehicle,
  vehicleBuyTarget,
} from '@app/vehicle-purchase';
import { DEPOT_ID, buildLogistics, buyVehicles, createApp, runCommands } from './app-fixtures';
import { setCash } from '../sim/helpers/economy';

/** Depo číslo 2 mimo scenára: (39, 27), konektor dole → vonkajšia bunka (40, 30) je na ceste pod depom. */
const SECOND_DEPOT = { type: 'PlaceModule', defId: 'vehicle_depot', x: 39, y: 27, rotation: 0 } as const;

describe('vehicleBuyTarget', () => {
  it('bez depa: nie je kam kúpiť → „Postav a pripoj depo vozidiel“', () => {
    const app = createApp();
    expect(vehicleBuyTarget(app.world)).toEqual({ depotId: null, reason: NO_DEPOT_REASON });
    expect(NO_DEPOT_REASON).toBe('Postav a pripoj depo vozidiel');
  });

  it('depo bez cesty (nepripojené) sa nepočíta: rovnaký dôvod', () => {
    const app = createApp();
    buildLogistics(app, { roads: false });
    expect(vehicleBuyTarget(app.world)).toEqual({ depotId: null, reason: NO_DEPOT_REASON });
  });

  it('pripojené depo s voľným státím → jeho id', () => {
    const app = createApp();
    buildLogistics(app);
    expect(vehicleBuyTarget(app.world)).toEqual({ depotId: DEPOT_ID, reason: null });
  });

  it('plné depo (6 / 6) → „Depá sú plné“; po predaji vozidla je zase dostupné', () => {
    const app = createApp();
    buildLogistics(app);
    const capacity = app.world.defs.modules.get('vehicle_depot').params['capacity'] as number;
    buyVehicles(app, capacity);
    expect(vehicleBuyTarget(app.world)).toEqual({ depotId: null, reason: DEPOTS_FULL_REASON });
    expect(DEPOTS_FULL_REASON).toBe('Depá sú plné');
    const soldId = [...app.world.vehicles.keys()][0] as number;
    expect(sellVehicle(app.bridge, soldId)).toBe(true);
    app.loop.frame(0);
    expect(vehicleBuyTarget(app.world).depotId).toBe(DEPOT_ID);
  });

  it('plné pripojené depo a druhé nepripojené → „Depá sú plné“ (nepripojené sa nepočíta ako miesto)', () => {
    const app = createApp();
    buildLogistics(app);
    runCommands(app, [SECOND_DEPOT]);
    // druhé depo (id 6) nemá pri konektore cestu → nepripojené; prvé zaplníme
    buyVehicles(app, app.world.defs.modules.get('vehicle_depot').params['capacity'] as number);
    expect(vehicleBuyTarget(app.world)).toEqual({ depotId: null, reason: DEPOTS_FULL_REASON });
  });

  it('viac pripojených depí s voľným miestom: vyhrá najmenšie id', () => {
    const app = createApp();
    buildLogistics(app);
    runCommands(app, [{ type: 'PlaceRoad', cells: [{ x: 40, y: 30 }, { x: 41, y: 30 }, { x: 42, y: 30 }, { x: 43, y: 30 }] }, SECOND_DEPOT]);
    const depots = [...app.world.modules.values()].filter((module) => module.def.id === 'vehicle_depot');
    expect(depots.map((depot) => depot.id).length).toBe(2);
    expect(vehicleBuyTarget(app.world).depotId).toBe(Math.min(...depots.map((depot) => depot.id)));
  });

  it('sameBuyTarget porovnáva podľa hodnoty', () => {
    expect(sameBuyTarget({ depotId: null, reason: 'a' }, { depotId: null, reason: 'a' })).toBe(true);
    expect(sameBuyTarget({ depotId: null, reason: 'a' }, { depotId: null, reason: 'b' })).toBe(false);
    expect(sameBuyTarget({ depotId: DEPOT_ID, reason: null }, { depotId: null, reason: null })).toBe(false);
  });
});

describe('buyVehicleFromBuildBar / buyVehicleInDepot / sellVehicle', () => {
  it('nákup z BuildBar: BuyVehicle do cieľového depa; vozidlo pribudne a hotovosť klesne o cenu', () => {
    const app = createApp();
    buildLogistics(app);
    const cash = app.world.cashCents;
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    expect(buyVehicleFromBuildBar(app.bridge, 'straddle_carrier')).toBe(true);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(BuyVehicleCommand);
    expect(dispatch.mock.calls[0]?.[0].toJSON()).toEqual({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID });
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(1);
    expect(app.world.cashCents).toBe(cash - app.world.defs.vehicles.get('straddle_carrier').purchaseCents);
  });

  it('nákup bez depa sa neodošle (nič sa nedispatchne)', () => {
    const app = createApp();
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    expect(buyVehicleFromBuildBar(app.bridge, 'straddle_carrier')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('nákup bez peňazí sa neodošle (validácia insufficient_funds)', () => {
    const app = createApp();
    buildLogistics(app);
    setCash(app.world, 1_000);
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    expect(buyVehicleFromBuildBar(app.bridge, 'straddle_carrier')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('neznámy def vozidla sa neodošle', () => {
    const app = createApp();
    buildLogistics(app);
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    expect(buyVehicleFromBuildBar(app.bridge, 'hovercraft')).toBe(false);
    expect(buyVehicleInDepot(app.bridge, 'straddle_carrier', 9999)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('predaj: nečinné vozidlo sa predá s refundom; neznáme id sa neodošle', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 1);
    const id = [...app.world.vehicles.keys()][0] as number;
    const cash = app.world.cashCents;
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    expect(sellVehicle(app.bridge, 9999)).toBe(false);
    expect(sellVehicle(app.bridge, id)).toBe(true);
    expect(dispatch.mock.calls[0]?.[0]).toBeInstanceOf(SellVehicleCommand);
    app.loop.frame(0);
    expect(app.world.vehicles.size).toBe(0);
    expect(app.world.cashCents).toBeGreaterThan(cash);
  });

  it('predaj pracujúceho vozidla sa neodošle (vehicle_busy)', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 1);
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    for (let i = 0; i < 2000 && [...app.world.vehicles.values()].every((vehicle) => vehicle.state === 'idle'); i += 1) app.loop.frame(app.loop.tickMs);
    const busy = [...app.world.vehicles.values()].find((vehicle) => vehicle.state !== 'idle');
    expect(busy).toBeDefined();
    const dispatch = vi.spyOn(app.bridge, 'dispatch');
    expect(sellVehicle(app.bridge, busy?.id ?? 0)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
